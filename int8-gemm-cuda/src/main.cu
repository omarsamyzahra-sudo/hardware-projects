// main.cu — correctness checks and benchmarks for the int8 GEMM kernels
//
//   gemm.exe                 check every kernel, then benchmark; CSV to stdout
//   gemm.exe --kernel NAME M N K    run one kernel a few times (for Nsight Compute)
//
// Every result is compared with a CPU reference: in full for small shapes,
// and at 4096 random output positions for large ones.
#include <cublas_v2.h>
#include <cuda_runtime.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <random>
#include <string>
#include <vector>

#include "kernels.cuh"

#define CK(x) do { cudaError_t e = (x); if (e != cudaSuccess) { \
    fprintf(stderr, "%s:%d %s\n", __FILE__, __LINE__, cudaGetErrorString(e)); exit(1); } } while (0)
#define CB(x) do { cublasStatus_t s = (x); if (s != CUBLAS_STATUS_SUCCESS) { \
    fprintf(stderr, "%s:%d cublas %d\n", __FILE__, __LINE__, (int)s); exit(1); } } while (0)

struct Problem {
    int M, N, K;
    std::vector<int8_t> A, Bt;            // A[M][K], Bt[N][K] (the decoded weights)
    std::vector<uint8_t> Bq;              // Bq[N][K/2] codebook indices
    std::vector<int8_t> cb;               // cb[N][16]
    int8_t *dA, *dBt, *dcb, *dBtmp;       // dBtmp: target of the unfused dequant
    uint8_t *dBq;
    int32_t *dC;
};

static void make(Problem &p, int M, int N, int K, uint32_t seed) {
    p.M = M; p.N = N; p.K = K;
    std::mt19937 g(seed);
    std::uniform_int_distribution<int> d8(-128, 127), d4(0, 15);
    p.A.resize((size_t)M * K);
    for (auto &x : p.A) x = (int8_t)d8(g);
    // B is generated through the codebook, so every kernel multiplies the same B
    p.cb.resize((size_t)N * 16);
    for (auto &x : p.cb) x = (int8_t)d8(g);
    p.Bq.resize((size_t)N * K / 2);
    p.Bt.resize((size_t)N * K);
    for (int n = 0; n < N; n++)
        for (int k = 0; k < K; k += 2) {
            int lo = d4(g), hi = d4(g);
            p.Bq[(size_t)n * K / 2 + k / 2] = (uint8_t)(lo | hi << 4);
            p.Bt[(size_t)n * K + k] = p.cb[n * 16 + lo];
            p.Bt[(size_t)n * K + k + 1] = p.cb[n * 16 + hi];
        }
    CK(cudaMalloc(&p.dA, p.A.size()));
    CK(cudaMalloc(&p.dBt, p.Bt.size()));
    CK(cudaMalloc(&p.dBtmp, p.Bt.size()));
    CK(cudaMalloc(&p.dBq, p.Bq.size()));
    CK(cudaMalloc(&p.dcb, p.cb.size()));
    CK(cudaMalloc(&p.dC, (size_t)M * N * 4));
    CK(cudaMemcpy(p.dA, p.A.data(), p.A.size(), cudaMemcpyHostToDevice));
    CK(cudaMemcpy(p.dBt, p.Bt.data(), p.Bt.size(), cudaMemcpyHostToDevice));
    CK(cudaMemcpy(p.dBq, p.Bq.data(), p.Bq.size(), cudaMemcpyHostToDevice));
    CK(cudaMemcpy(p.dcb, p.cb.data(), p.cb.size(), cudaMemcpyHostToDevice));
}

static void release(Problem &p) {
    cudaFree(p.dA); cudaFree(p.dBt); cudaFree(p.dBtmp); cudaFree(p.dBq); cudaFree(p.dcb); cudaFree(p.dC);
}

static int32_t ref(const Problem &p, int m, int n) {
    int32_t s = 0;
    for (int k = 0; k < p.K; k++) s += int32_t(p.A[(size_t)m * p.K + k]) * int32_t(p.Bt[(size_t)n * p.K + k]);
    return s;
}

static cublasHandle_t blas;

struct Kernel {
    const char *name;
    int align;                             // M and N must be multiples of this (1: any)
    double bytes_b;                        // weight bytes per element of B read from DRAM
    void (*launch)(Problem &);
};

static Kernel KERNELS[] = {
    {"naive", 1, 1, [](Problem &p) {
        dim3 b(32, 8), g((p.M + 31) / 32, (p.N + 7) / 8);
        k_naive<<<g, b>>>(p.dA, p.dBt, p.dC, p.M, p.N, p.K); }},
    {"warp_dp4a", 1, 1, [](Problem &p) {
        dim3 b(32, 8), g((p.N + 7) / 8, p.M);
        k_warp_dp4a<<<g, b>>>(p.dA, p.dBt, p.dC, p.M, p.N, p.K); }},
    {"tiled_dp4a", 1, 1, [](Problem &p) {
        dim3 b(16, 16), g(p.N / TB, (p.M + TB - 1) / TB);
        k_tiled_dp4a<<<g, b>>>(p.dA, p.dBt, p.dC, p.M, p.N, p.K); }},
    {"wmma", 64, 1, [](Problem &p) {
        dim3 g(p.N / TB, p.M / TB);
        k_wmma<<<g, 128>>>(p.dA, p.dBt, p.dC, p.M, p.N, p.K); }},
    {"wmma_big", 128, 1, [](Problem &p) {
        dim3 g(p.N / 128, p.M / 128);
        k_wmma_big<<<g, 256>>>(p.dA, p.dBt, p.dC, p.M, p.N, p.K); }},
    {"cublas", 1, 1, [](Problem &p) {
        // row-major C[M][N] is column-major C^T[N][M] = Bt^T (N x K) * A^T (K x M)
        const int32_t one = 1, zero = 0;
        CB(cublasGemmEx(blas, CUBLAS_OP_T, CUBLAS_OP_N, p.N, p.M, p.K, &one,
                        p.dBt, CUDA_R_8I, p.K, p.dA, CUDA_R_8I, p.K, &zero,
                        p.dC, CUDA_R_32I, p.N, CUBLAS_COMPUTE_32I, CUBLAS_GEMM_DEFAULT)); }},
    {"dequant+tiled", 1, 1.5, [](Problem &p) {
        size_t bytes = (size_t)p.N * p.K / 2;
        k_dequant<<<unsigned((bytes + 255) / 256), 256>>>(p.dBq, p.dcb, p.dBtmp, p.N, p.K);
        dim3 b(16, 16), g(p.N / TB, (p.M + TB - 1) / TB);
        k_tiled_dp4a<<<g, b>>>(p.dA, p.dBtmp, p.dC, p.M, p.N, p.K); }},
    {"skinny_dp4a", 1, 1, [](Problem &p) {
        k_skinny<false><<<p.N / (8 * SK_COLS), 256>>>(p.dA, p.dBt, nullptr, nullptr, p.dC, p.M, p.N, p.K); }},
    {"skinny_cb", 1, 0.5, [](Problem &p) {
        k_skinny<true><<<p.N / (8 * SK_COLS), 256>>>(p.dA, nullptr, p.dBq, p.dcb, p.dC, p.M, p.N, p.K); }},
    {"fused_cb", 1, 0.5, [](Problem &p) {
        dim3 b(16, 16), g(p.N / TB, (p.M + TB - 1) / TB);
        k_fused_cb<<<g, b>>>(p.dA, p.dBq, p.dcb, p.dC, p.M, p.N, p.K); }},
};

static bool usable(const Kernel &k, const Problem &p) {
    if (p.M % k.align || p.N % k.align) return false;
    if (!strncmp(k.name, "skinny", 6)) return p.M <= SK_MAXM && p.N % 32 == 0 && p.K % 128 == 0;
    return true;
}

static Kernel *find(const char *name) {
    for (auto &k : KERNELS) if (!strcmp(k.name, name)) return &k;
    return nullptr;
}

// returns the number of wrong outputs (checks all, or 4096 random positions)
static long check(Problem &p) {
    std::vector<int32_t> C((size_t)p.M * p.N);
    CK(cudaMemcpy(C.data(), p.dC, C.size() * 4, cudaMemcpyDeviceToHost));
    long bad = 0;
    if ((size_t)p.M * p.N * p.K <= (size_t)1 << 28) {
        for (int m = 0; m < p.M; m++)
            for (int n = 0; n < p.N; n++) bad += C[(size_t)m * p.N + n] != ref(p, m, n);
    } else {
        std::mt19937 g(1);
        for (int i = 0; i < 4096; i++) {
            int m = g() % p.M, n = g() % p.N;
            bad += C[(size_t)m * p.N + n] != ref(p, m, n);
        }
    }
    return bad;
}

static double time_ms(Kernel &k, Problem &p) {
    cudaEvent_t a, b;
    CK(cudaEventCreate(&a)); CK(cudaEventCreate(&b));
    k.launch(p);                                         // warm-up
    CK(cudaDeviceSynchronize());
    int iters = 0;
    float total = 0;
    while (iters < 3 || (total < 300 && iters < 200)) {  // at least 3 runs, ~0.3 s
        CK(cudaEventRecord(a));
        k.launch(p);
        CK(cudaEventRecord(b));
        CK(cudaEventSynchronize(b));
        float ms;
        CK(cudaEventElapsedTime(&ms, a, b));
        total += ms;
        iters++;
    }
    CK(cudaGetLastError());
    cudaEventDestroy(a); cudaEventDestroy(b);
    return total / iters;
}

int main(int argc, char **argv) {
    CB(cublasCreate(&blas));
    cudaDeviceProp prop;
    CK(cudaGetDeviceProperties(&prop, 0));

    if (argc == 6 && !strcmp(argv[1], "--kernel")) {          // for ncu
        Kernel *k = find(argv[2]);
        if (!k) { fprintf(stderr, "no kernel %s\n", argv[2]); return 1; }
        Problem p;
        make(p, atoi(argv[3]), atoi(argv[4]), atoi(argv[5]), 7);
        for (int i = 0; i < 3; i++) k->launch(p);
        CK(cudaDeviceSynchronize());
        printf("%s: %ld wrong\n", k->name, check(p));
        release(p);
        return 0;
    }

    fprintf(stderr, "%s, %d SMs, sm_%d%d\n", prop.name, prop.multiProcessorCount, prop.major, prop.minor);

    // ---- correctness: every kernel on shapes that stress the edges ----
    int fails = 0;
    const int shapes[][3] = {{64, 64, 64}, {128, 192, 256}, {512, 512, 512}, {16, 256, 1024},
                             {256, 384, 576},
                             {1, 64, 64}, {100, 128, 320}};
    for (auto &s : shapes) {
        Problem p;
        make(p, s[0], s[1], s[2], 42 + s[0]);
        for (auto &k : KERNELS) {
            if (!usable(k, p)) continue;
            CK(cudaMemset(p.dC, 0xAB, (size_t)p.M * p.N * 4));
            k.launch(p);
            CK(cudaDeviceSynchronize());
            long bad = check(p);
            if (bad) { fprintf(stderr, "FAIL %s %dx%dx%d: %ld wrong\n", k.name, p.M, p.N, p.K, bad); fails++; }
        }
        release(p);
    }
    if (fails) fprintf(stderr, "correctness: %d FAILURES\n", fails);
    else fprintf(stderr, "correctness: all kernels match the CPU\n");
    if (fails) return 1;

    // ---- benchmarks ----
    printf("kernel,M,N,K,ms,tops,gbs_min,wrong\n");
    const int bench[][3] = {{1024, 1024, 1024}, {2048, 2048, 2048}, {4096, 4096, 4096},
                            {16, 4096, 4096}, {64, 4096, 4096}, {16, 11008, 4096}};
    for (auto &s : bench) {
        Problem p;
        make(p, s[0], s[1], s[2], 7);
        for (auto &k : KERNELS) {
            if (!usable(k, p)) continue;
            if (!strcmp(k.name, "naive") && (double)p.M * p.N * p.K > 9e9) continue;  // minutes
            double ms = time_ms(k, p);
            long bad = check(p);
            double ops = 2.0 * p.M * p.N * p.K;
            // the least DRAM traffic possible: A, B (in its stored form), C once each
            double bytes = (double)p.M * p.K + k.bytes_b * (double)p.N * p.K + 4.0 * p.M * p.N;
            if (!strcmp(k.name, "dequant+tiled")) bytes += (double)p.N * p.K;  // decoded B read back
            printf("%s,%d,%d,%d,%.4f,%.3f,%.1f,%ld\n", k.name, p.M, p.N, p.K, ms, ops / ms / 1e9,
                   bytes / ms / 1e6, bad);
            fflush(stdout);
            if (bad) fails++;
        }
        release(p);
    }
    cublasDestroy(blas);
    return fails ? 1 : 0;
}
