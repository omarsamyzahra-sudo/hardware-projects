// kernels.cuh — int8 GEMM kernels, slowest to fastest
//
// All compute  C[M][N] (int32) = A[M][K] (int8) x B[K][N] (int8)
// with A row-major and B stored transposed, Bt[N][K] (each output column's
// weights contiguous in K, i.e. B column-major). That is the layout dp4a
// and the tensor cores want, and the same "weight rows" layout as the
// systolic accelerator's WBUF strips.
//
//   1. naive        one thread per output, byte loads, uncoalesced A and C
//   2. warp_dp4a    one warp per output, lanes split K, 4 bytes per dp4a,
//                   coalesced 128-byte loads, shuffle reduction
//   3. tiled_dp4a   64x64 block tile staged in shared memory, 4x4 outputs
//                   per thread in registers
//   4. wmma         tensor cores (16x16x16 int8 fragments), 64x64 block tile
//   5. fused_cb     tiled_dp4a, but B arrives as 4-bit codebook indices
//                   (16 int8 levels per output column) decoded in shared
//                   memory: half the weight bytes from DRAM
#pragma once
#include <cstdint>
#include <mma.h>

// ---------------------------------------------------------------- 1. naive
__global__ void k_naive(const int8_t *A, const int8_t *Bt, int32_t *C, int M, int N, int K) {
    int m = blockIdx.x * blockDim.x + threadIdx.x;      // consecutive threads: consecutive rows
    int n = blockIdx.y * blockDim.y + threadIdx.y;
    if (m >= M || n >= N) return;
    int32_t acc = 0;
    for (int k = 0; k < K; k++) acc += int32_t(A[(size_t)m * K + k]) * int32_t(Bt[(size_t)n * K + k]);
    C[(size_t)m * N + n] = acc;
}

// ------------------------------------------------------------ 2. warp_dp4a
// blockDim = (32, 8): 8 warps, each one output. K % 4 == 0.
__global__ void k_warp_dp4a(const int8_t *A, const int8_t *Bt, int32_t *C, int M, int N, int K) {
    int n = blockIdx.x * blockDim.y + threadIdx.y;
    int m = blockIdx.y;
    if (n >= N) return;
    const int *a = reinterpret_cast<const int *>(A + (size_t)m * K);
    const int *b = reinterpret_cast<const int *>(Bt + (size_t)n * K);
    int acc = 0;
    for (int w = threadIdx.x; w < K / 4; w += 32) acc = __dp4a(a[w], b[w], acc);
    for (int o = 16; o > 0; o >>= 1) acc += __shfl_down_sync(0xffffffffu, acc, o);
    if (threadIdx.x == 0) C[(size_t)m * N + n] = acc;
}

// ----------------------------------------------------------- 3. tiled_dp4a
// 64x64 output tile per block of 16x16 threads; thread (ty, tx) owns rows
// ty + 16i and columns tx + 16j (i, j < 4). K is staged 64 bytes (16 words)
// at a time; rows are padded to 17 words so the B reads (16 different
// rows, same word) hit 16 different banks. N % 64 == 0, K % 64 == 0; M is
// bounds-checked (rows past M read as 0 and are not written).
constexpr int TB = 64, TKW = 16, TPAD = TKW + 1;

template <bool CODEBOOK>
__device__ __forceinline__ void tiled_body(const int8_t *A, const int8_t *Bt, const uint8_t *Bq,
                                           const int8_t *cb, int32_t *C, int M, int N, int K) {
    __shared__ int As[TB][TPAD];
    __shared__ int Bs[TB][TPAD];
    __shared__ int8_t cbS[CODEBOOK ? TB : 1][16];
    const int tx = threadIdx.x, ty = threadIdx.y, tid = ty * 16 + tx;
    const int m0 = blockIdx.y * TB, n0 = blockIdx.x * TB;

    if (CODEBOOK) {                       // this block's 64 codebooks, 16 levels each
        reinterpret_cast<int *>(&cbS[0][0])[tid] = reinterpret_cast<const int *>(cb + n0 * 16)[tid];
    }

    int acc[4][4] = {};
    for (int k0 = 0; k0 < K; k0 += TKW * 4) {
        // A tile: 64 rows x 16 words, 4 words per thread (consecutive threads, consecutive words)
        for (int r = 0; r < 4; r++) {
            int w = tid + 256 * r, row = w / TKW, kw = w % TKW;
            As[row][kw] = (m0 + row < M)
                ? reinterpret_cast<const int *>(A + (size_t)(m0 + row) * K + k0)[kw] : 0;
        }
        if (!CODEBOOK) {
            for (int r = 0; r < 4; r++) {
                int w = tid + 256 * r, row = w / TKW, kw = w % TKW;
                Bs[row][kw] = reinterpret_cast<const int *>(Bt + (size_t)(n0 + row) * K + k0)[kw];
            }
        } else {
            __syncthreads();              // cbS ready (first pass); Bs free (later passes)
            // packed tile: 64 rows x 32 bytes = 8 words per row; each thread
            // decodes 2 packed words = 16 indices = 4 int8 words
            for (int r = 0; r < 2; r++) {
                int w = tid + 256 * r, row = w / 8, pw = w % 8;
                uint32_t p = reinterpret_cast<const uint32_t *>(Bq + (size_t)(n0 + row) * (K / 2) + k0 / 2)[pw];
                const int8_t *c = cbS[row];
                for (int h = 0; h < 2; h++) {
                    uint32_t q = p >> (16 * h);
                    Bs[row][2 * pw + h] = (uint8_t)c[q & 15] | (uint8_t)c[(q >> 4) & 15] << 8 |
                                          (uint8_t)c[(q >> 8) & 15] << 16 | (uint32_t)(uint8_t)c[(q >> 12) & 15] << 24;
                }
            }
        }
        __syncthreads();
#pragma unroll
        for (int kw = 0; kw < TKW; kw++) {
            int a[4], b[4];
#pragma unroll
            for (int i = 0; i < 4; i++) a[i] = As[ty + 16 * i][kw];
#pragma unroll
            for (int j = 0; j < 4; j++) b[j] = Bs[tx + 16 * j][kw];
#pragma unroll
            for (int i = 0; i < 4; i++)
#pragma unroll
                for (int j = 0; j < 4; j++) acc[i][j] = __dp4a(a[i], b[j], acc[i][j]);
        }
        __syncthreads();
    }
    for (int i = 0; i < 4; i++) {
        int m = m0 + ty + 16 * i;
        if (m < M)
            for (int j = 0; j < 4; j++) C[(size_t)m * N + n0 + tx + 16 * j] = acc[i][j];
    }
}

__global__ void k_tiled_dp4a(const int8_t *A, const int8_t *Bt, int32_t *C, int M, int N, int K) {
    tiled_body<false>(A, Bt, nullptr, nullptr, C, M, N, K);
}

// ------------------------------------------------------------- 5. fused_cb
// Bq[N][K/2]: index of B[k][n] in the low nibble (k even) or high nibble
// (k odd) of byte k/2 of row n; cb[N][16]: column n's 16 int8 levels.
__global__ void k_fused_cb(const int8_t *A, const uint8_t *Bq, const int8_t *cb, int32_t *C,
                           int M, int N, int K) {
    tiled_body<true>(A, nullptr, Bq, cb, C, M, N, K);
}

// The unfused alternative: decode the whole of B to int8 first.
__global__ void k_dequant(const uint8_t *Bq, const int8_t *cb, int8_t *Bt, int N, int K) {
    size_t i = (size_t)blockIdx.x * blockDim.x + threadIdx.x;   // one packed byte
    if (i >= (size_t)N * K / 2) return;
    int n = int(i / (K / 2));
    uint8_t p = Bq[i];
    Bt[2 * i]     = cb[n * 16 + (p & 15)];
    Bt[2 * i + 1] = cb[n * 16 + (p >> 4)];
}

// ----------------------------------------------------------------- 4. wmma
// 64x64 block tile, 4 warps in 2x2, each warp 32x32 = 2x2 fragments.
// Shared memory holds K in 16-byte chunks, [chunk][row][16], so every
// fragment pointer is 32-byte aligned as load_matrix_sync requires.
// M, N % 64 == 0, K % 64 == 0.
__global__ void k_wmma(const int8_t *A, const int8_t *Bt, int32_t *C, int M, int N, int K) {
    using namespace nvcuda;
    constexpr int KC = 4;                                 // 4 chunks of 16 = 64 bytes of K
    __shared__ __align__(32) int8_t As[KC][TB][16];
    __shared__ __align__(32) int8_t Bs[KC][TB][16];
    const int tid = threadIdx.x, warp = tid / 32;
    const int wm = warp / 2, wn = warp % 2;
    const int m0 = blockIdx.y * TB, n0 = blockIdx.x * TB;

    wmma::fragment<wmma::accumulator, 16, 16, 16, int> acc[2][2];
    for (int i = 0; i < 2; i++)
        for (int j = 0; j < 2; j++) wmma::fill_fragment(acc[i][j], 0);

    for (int k0 = 0; k0 < K; k0 += 16 * KC) {
        // 64 rows x 4 chunks of 16 bytes, for A and B: 256 int4 each, 2 per thread
        for (int r = 0; r < 2; r++) {
            int v = tid + 128 * r, row = v / KC, c = v % KC;
            *reinterpret_cast<int4 *>(As[c][row]) =
                *reinterpret_cast<const int4 *>(A + (size_t)(m0 + row) * K + k0 + 16 * c);
            *reinterpret_cast<int4 *>(Bs[c][row]) =
                *reinterpret_cast<const int4 *>(Bt + (size_t)(n0 + row) * K + k0 + 16 * c);
        }
        __syncthreads();
        for (int c = 0; c < KC; c++) {
            wmma::fragment<wmma::matrix_a, 16, 16, 16, signed char, wmma::row_major> fa[2];
            wmma::fragment<wmma::matrix_b, 16, 16, 16, signed char, wmma::col_major> fb[2];
            for (int i = 0; i < 2; i++)
                wmma::load_matrix_sync(fa[i], reinterpret_cast<const signed char *>(As[c][wm * 32 + 16 * i]), 16);
            for (int j = 0; j < 2; j++)
                wmma::load_matrix_sync(fb[j], reinterpret_cast<const signed char *>(Bs[c][wn * 32 + 16 * j]), 16);
            for (int i = 0; i < 2; i++)
                for (int j = 0; j < 2; j++) wmma::mma_sync(acc[i][j], fa[i], fb[j], acc[i][j]);
        }
        __syncthreads();
    }
    for (int i = 0; i < 2; i++)
        for (int j = 0; j < 2; j++)
            wmma::store_matrix_sync(C + (size_t)(m0 + wm * 32 + 16 * i) * N + n0 + wn * 32 + 16 * j,
                                    acc[i][j], N, wmma::mem_row_major);
}

// ------------------------------------------------------------- 4b. wmma_big
// What k_wmma lacks at 4096: each 64x64 tile re-reads A and B from L2 too
// often (low reuse), and the warps sit idle while their tile loads. Here:
// a 128x128 block tile (8 warps in 2x4, each 64x32 = 4x2 fragments: twice
// the reuse per byte loaded), and cp.async double buffering: the next
// 64-byte K slice is copied into shared memory while the tensor cores work
// on the current one. M, N % 128 == 0, K % 64 == 0.
#include <cuda_pipeline.h>

__global__ void __launch_bounds__(256) k_wmma_big(const int8_t *A, const int8_t *Bt, int32_t *C,
                                                  int M, int N, int K) {
    using namespace nvcuda;
    constexpr int BT = 128, KC = 4;
    __shared__ __align__(32) int8_t As[2][KC][BT][16];     // 2 stages x 8 KB
    __shared__ __align__(32) int8_t Bs[2][KC][BT][16];
    const int tid = threadIdx.x, warp = tid / 32;
    const int wm = warp / 4, wn = warp % 4;
    const int m0 = blockIdx.y * BT, n0 = blockIdx.x * BT;

    auto load = [&](int s, int k0) {
        for (int r = 0; r < 4; r++) {                       // 512 16-byte pieces each, 2 per thread
            int v = tid + 256 * r, row = (v / KC) % BT, c = v % KC;
            if (v < BT * KC)
                __pipeline_memcpy_async(As[s][c][row], A + (size_t)(m0 + row) * K + k0 + 16 * c, 16);
            else
                __pipeline_memcpy_async(Bs[s][c][row], Bt + (size_t)(n0 + row) * K + k0 + 16 * c, 16);
        }
        __pipeline_commit();
    };

    wmma::fragment<wmma::accumulator, 16, 16, 16, int> acc[4][2];
    for (int i = 0; i < 4; i++)
        for (int j = 0; j < 2; j++) wmma::fill_fragment(acc[i][j], 0);

    const int steps = K / (16 * KC);
    load(0, 0);
    for (int t = 0; t < steps; t++) {
        if (t + 1 < steps) {
            load((t + 1) & 1, (t + 1) * 16 * KC);
            __pipeline_wait_prior(1);                       // stage t has landed
        } else {
            __pipeline_wait_prior(0);
        }
        __syncthreads();
        const int s = t & 1;
        for (int c = 0; c < KC; c++) {
            wmma::fragment<wmma::matrix_a, 16, 16, 16, signed char, wmma::row_major> fa[4];
            wmma::fragment<wmma::matrix_b, 16, 16, 16, signed char, wmma::col_major> fb[2];
            for (int i = 0; i < 4; i++)
                wmma::load_matrix_sync(fa[i], reinterpret_cast<const signed char *>(As[s][c][wm * 64 + 16 * i]), 16);
            for (int j = 0; j < 2; j++)
                wmma::load_matrix_sync(fb[j], reinterpret_cast<const signed char *>(Bs[s][c][wn * 32 + 16 * j]), 16);
            for (int i = 0; i < 4; i++)
                for (int j = 0; j < 2; j++) wmma::mma_sync(acc[i][j], fa[i], fb[j], acc[i][j]);
        }
        __syncthreads();                                    // stage s may be overwritten next
    }
    for (int i = 0; i < 4; i++)
        for (int j = 0; j < 2; j++)
            wmma::store_matrix_sync(C + (size_t)(m0 + wm * 64 + 16 * i) * N + n0 + wn * 32 + 16 * j,
                                    acc[i][j], N, wmma::mem_row_major);
}

// ---------------------------------------------------- 6. skinny (M <= 16)
// For decode-like shapes (a few rows of activations, a big weight matrix)
// the 64-row tiles above waste most of their work on padding rows, and the
// real limit is streaming B from DRAM. Here one warp owns 4 output columns
// for all M rows: lanes walk K in 4-byte words (coalesced 128-byte reads
// of each weight row), keep 16 x 4 accumulators in registers, and reduce
// with shuffles at the end. A (at most 16 x 1024 bytes at a time) is
// staged in shared memory and shared by the block's 8 warps.
// With CB, the weights arrive as 4-bit codebook indices: each lane reads 2
// bytes per row per word instead of 4. Each column's 16 levels sit in 4
// registers, and lut16() decodes 4 indices with two byte-permutes and a
// select (no memory access at all).
// M <= 16, N % 32 == 0, K % 128 == 0.
constexpr int SK_MAXM = 16, SK_KCH = 1024, SK_COLS = 4;

// 4 nibble indices (q, 16 bits) -> 4 int8 levels from the table t[0..3]
// (16 bytes). __byte_perm picks bytes by the low 3 bits of each selector
// nibble: one call covers levels 0-7, another 8-15, bit 3 chooses.
__device__ __forceinline__ int lut16(uint32_t q, const uint32_t t[4]) {
    uint32_t sel = q & 0x7777u;
    uint32_t lo = __byte_perm(t[0], t[1], sel), hi = __byte_perm(t[2], t[3], sel);
    uint32_t x = (q >> 3) & 0x1111u;                       // bit 3 of each nibble
    uint32_t mask = ((x & 1u) | (x & 0x10u) << 4 | (x & 0x100u) << 8 | (x & 0x1000u) << 12) * 0xFFu;
    return int((hi & mask) | (lo & ~mask));
}

template <bool CB>
__global__ void __launch_bounds__(256) k_skinny(const int8_t *A, const int8_t *Bt, const uint8_t *Bq,
                                                const int8_t *cb, int32_t *C, int M, int N, int K) {
    __shared__ int As[SK_MAXM][SK_KCH / 4];
    const int lane = threadIdx.x % 32, warp = threadIdx.x / 32;
    const int n0 = (blockIdx.x * 8 + warp) * SK_COLS;
    uint32_t tab[SK_COLS][4];                               // this warp's codebooks
    if (CB)
        for (int c = 0; c < SK_COLS; c++)
            for (int r = 0; r < 4; r++) tab[c][r] = reinterpret_cast<const uint32_t *>(cb + (size_t)(n0 + c) * 16)[r];

    int acc[SK_MAXM][SK_COLS] = {};
    for (int k0 = 0; k0 < K; k0 += SK_KCH) {
        const int kw_n = min(SK_KCH, K - k0) / 4;          // words in this chunk
        __syncthreads();
        for (int i = threadIdx.x; i < M * kw_n; i += 256) {
            int m = i / kw_n, w = i % kw_n;
            As[m][w] = reinterpret_cast<const int *>(A + (size_t)m * K + k0)[w];
        }
        __syncthreads();
        for (int w = lane; w < kw_n; w += 32) {
            int b[SK_COLS];
#pragma unroll
            for (int c = 0; c < SK_COLS; c++) {
                if (!CB) {
                    b[c] = reinterpret_cast<const int *>(Bt + (size_t)(n0 + c) * K + k0)[w];
                } else {
                    uint32_t q = reinterpret_cast<const uint16_t *>(Bq + (size_t)(n0 + c) * (K / 2) + k0 / 2)[w];
                    b[c] = lut16(q, tab[c]);
                }
            }
#pragma unroll
            for (int m = 0; m < SK_MAXM; m++)
                if (m < M) {
                    int a = As[m][w];
#pragma unroll
                    for (int c = 0; c < SK_COLS; c++) acc[m][c] = __dp4a(a, b[c], acc[m][c]);
                }
        }
    }
#pragma unroll
    for (int m = 0; m < SK_MAXM; m++)
#pragma unroll
        for (int c = 0; c < SK_COLS; c++) {
            int v = acc[m][c];
            for (int o = 16; o > 0; o >>= 1) v += __shfl_down_sync(0xffffffffu, v, o);
            if (lane == 0 && m < M) C[(size_t)m * N + n0 + c] = v;
        }
}
