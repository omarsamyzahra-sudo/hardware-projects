// ewlib.cu — the GEMV kernels as a DLL for gpu/e2e_demo.py (ctypes, device pointers)
//
//   build_lib.bat  ->  gpu\build\ewlib.dll
//
// y[rows] (FP32) = W x for one input vector, on the legacy default stream
// (the one PyTorch uses), G = 16 weights per lane per step: the best ew
// configuration in the layer benchmark. Both functions accumulate in the same
// order, so the decoded result is bit-identical to the raw one. The decoded
// path runs gemv_ew2 (the rewrite after Nsight; gemv_ew is kept in ewgemv.cu
// for the before/after).
#include "ewgemv_kernels.cuh"

#define EXPORT extern "C" __declspec(dllexport)

static int launch_err() { return (int)cudaGetLastError(); }

EXPORT int gemv_bf16_g16(const uint16_t *W, const uint16_t *x, float *y, int rows, int cols) {
    gemv_bf16<16><<<(rows + WARPS - 1) / WARPS, WARPS * 32>>>(W, x, y, rows, cols);
    return launch_err();
}

EXPORT int gemv_ew_g16(const uint8_t *code, const uint8_t *sm, const uint8_t *esc, const uint32_t *rowesc,
                       const uint16_t *x, float *y, int rows, int cols, uint32_t base) {
    gemv_ew2<16><<<(rows + WARPS - 1) / WARPS, WARPS * 32>>>(code, sm, esc, rowesc, x, y, rows, cols, base);
    return launch_err();
}
