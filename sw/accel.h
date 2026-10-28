// accel.h — driver for the systolic accelerator, and the same layer on the CPU
//
// A layer computes  Y[m][n] = requant(bias[n] + sum_k X[m][k] * W[k][n])
// with requant(a) = sat8((a * mult + 2^(shift-1)) >> shift), then ReLU.
// The accelerator does 8 output columns ("a strip") and up to 16 rows per
// job, so the driver loops over row chunks and strips. Weights are stored
// strip by strip, which is exactly the accelerator's WBUF layout:
//   Wp[s][k][j] = W[k][8s + j]      (K x 8 bytes per strip)
#pragma once
#include <stdint.h>

#define ACCEL_BASE 0x40000000u

typedef struct {
    int             M, K, N;     // K and N multiples of 8, K <= 1024
    const int8_t   *X;           // [M][K], 4-byte aligned
    const int8_t   *Wp;          // [N/8][K][8], 4-byte aligned
    const int32_t  *bias;        // [N]
    uint32_t        mult, shift; // scale = mult / 2^shift
    int             relu;
    int8_t         *Y;           // [M][N] int8 results, 4-byte aligned (or 0)
    int32_t        *acc;         // [M][N] int32 accumulators (or 0)
} layer_t;

// Run the layer on the accelerator. Returns 0, or SYS BUSERR if a bus
// access was refused.
uint32_t accel_layer(const layer_t *L);

// The same layer on the CPU (RV32I has no multiply: int8 products come from
// a quarter-square table, a lot faster than libgcc's __mulsi3).
void cpu_layer(const layer_t *L);

int8_t requant(int32_t acc, uint32_t mult, uint32_t shift, int relu);
