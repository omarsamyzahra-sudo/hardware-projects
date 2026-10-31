// ewgemv_kernels.cuh — the two batch-1 GEMV kernels (raw BF16 and exponent-window
// decode fused into the GEMV), shared by ewgemv.cu (layer benchmark) and ewlib.cu
// (the DLL the whole-model demo calls). See ewgemv.cu for the design notes.
#pragma once
#include <cstdint>
#include <cuda_runtime.h>

constexpr int WARPS = 8;                        // rows per block

__device__ __forceinline__ float bf(uint32_t b16) { return __uint_as_float(b16 << 16); }

__device__ __forceinline__ float warp_sum(float v) {
    for (int o = 16; o; o >>= 1) v += __shfl_xor_sync(0xffffffffu, v, o);
    return v;
}

// G = weights per lane per step (8, 16 or 32). Each lane multiply-adds its G
// weights in order, then steps by 32*G; both kernels share this order.
template <int G>
__global__ void gemv_bf16(const uint16_t *__restrict__ W, const uint16_t *__restrict__ x,
                          float *__restrict__ y, int rows, int cols) {
    int row = blockIdx.x * WARPS + threadIdx.x / 32, lane = threadIdx.x % 32;
    if (row >= rows) return;
    const uint16_t *wr = W + (size_t)row * cols;
    float acc = 0.f;
    for (int k0 = lane * G; k0 < cols; k0 += 32 * G) {
        uint4 wv[G / 8], xv[G / 8];
#pragma unroll
        for (int q = 0; q < G / 8; q++) {
            wv[q] = *reinterpret_cast<const uint4 *>(wr + k0 + 8 * q);
            xv[q] = *reinterpret_cast<const uint4 *>(x + k0 + 8 * q);
        }
#pragma unroll
        for (int q = 0; q < G / 8; q++) {
            uint32_t wa[4] = {wv[q].x, wv[q].y, wv[q].z, wv[q].w}, xa[4] = {xv[q].x, xv[q].y, xv[q].z, xv[q].w};
#pragma unroll
            for (int j = 0; j < 8; j++) {
                uint32_t wb = (wa[j / 2] >> (16 * (j & 1))) & 0xffff;
                uint32_t xb = (xa[j / 2] >> (16 * (j & 1))) & 0xffff;
                acc = fmaf(bf(wb), bf(xb), acc);
            }
        }
    }
    acc = warp_sum(acc);
    if (lane == 0) y[row] = acc;
}

template <int G>
__global__ void gemv_ew(const uint8_t *__restrict__ code, const uint8_t *__restrict__ sm,
                        const uint8_t *__restrict__ esc, const uint32_t *__restrict__ rowesc,
                        const uint16_t *__restrict__ x, float *__restrict__ y, int rows, int cols,
                        uint32_t base) {
    constexpr int NG = G / 8;                           // code bytes per plane per lane
    int row = blockIdx.x * WARPS + threadIdx.x / 32, lane = threadIdx.x % 32;
    if (row >= rows) return;
    uint32_t off = rowesc[row];
    float acc = 0.f;
    for (int s0 = 0; s0 < cols; s0 += 32 * G) {         // every lane takes part in the scan
        int k0 = s0 + lane * G;
        bool active = k0 < cols;
        size_t flat = (size_t)row * cols + k0;
        size_t cb = (flat >> 6) * 24 + ((flat >> 3) & 7);  // this lane's bytes of the tile's 3 planes
        uint32_t b[3][NG];
        int cnt = 0;
#pragma unroll
        for (int q = 0; q < NG; q++) {
#pragma unroll
            for (int p = 0; p < 3; p++) b[p][q] = active ? code[cb + 8 * p + q] : 0xff;
            cnt += __popc(~(b[0][q] | b[1][q] | b[2][q]) & 0xff);   // code 0 = escape
        }
        int inc = cnt;
        for (int o = 1; o < 32; o <<= 1) {
            int t = __shfl_up_sync(0xffffffffu, inc, o);
            if (lane >= o) inc += t;
        }
        int total = __shfl_sync(0xffffffffu, inc, 31);
        if (active) {
            uint2 sv[NG];
            uint4 xv[NG];
#pragma unroll
            for (int q = 0; q < NG; q++) {
                sv[q] = *reinterpret_cast<const uint2 *>(sm + flat + 8 * q);
                xv[q] = *reinterpret_cast<const uint4 *>(x + k0 + 8 * q);
            }
            uint32_t e = off + inc - cnt;
#pragma unroll
            for (int q = 0; q < NG; q++) {
                uint32_t sa[2] = {sv[q].x, sv[q].y}, xa[4] = {xv[q].x, xv[q].y, xv[q].z, xv[q].w};
#pragma unroll
                for (int j = 0; j < 8; j++) {
                    uint32_t c = ((b[0][q] >> j) & 1) | (((b[1][q] >> j) & 1) << 1) | (((b[2][q] >> j) & 1) << 2);
                    uint32_t ex = c ? ((base + c) & 0xff) : esc[e++];
                    uint32_t s = (sa[j / 4] >> (8 * (j & 3))) & 0xff;
                    uint32_t wb = ((s & 0x80) << 8) | (ex << 7) | (s & 0x7f);
                    uint32_t xb = (xa[j / 2] >> (16 * (j & 1))) & 0xffff;
                    acc = fmaf(bf(wb), bf(xb), acc);
                }
            }
        }
        off += total;
    }
    acc = warp_sum(acc);
    if (lane == 0) y[row] = acc;
}
