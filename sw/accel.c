// accel.c — see accel.h
#include "accel.h"
#include "soc.h"

#define REG(off)  (*(volatile uint32_t *)(ACCEL_BASE + (off)))
#define CTRL      REG(0x000)
#define STATUS    REG(0x004)
#define MROWS     REG(0x008)
#define KTILES    REG(0x00C)
#define QUANT     REG(0x010)
#define BIAS(n)   REG(0x020 + 4 * (n))
#define OUT8(m, h) REG(0x100 + 8 * (m) + 4 * (h))
#define ACC(m, n) REG(0x200 + 32 * (m) + 4 * (n))
#define WBUF      ((volatile uint32_t *)(ACCEL_BASE + 0x2000))
#define ABUF      ((volatile uint32_t *)(ACCEL_BASE + 0x4000))

// word copy into an accelerator buffer, unrolled by 4
static void copy_words(volatile uint32_t *dst, const uint32_t *src, int words) {
    int i = 0;
    for (; i + 4 <= words; i += 4) {
        uint32_t a = src[i], b = src[i + 1], c = src[i + 2], d = src[i + 3];
        dst[i] = a; dst[i + 1] = b; dst[i + 2] = c; dst[i + 3] = d;
    }
    for (; i < words; i++) dst[i] = src[i];
}

uint32_t accel_layer(const layer_t *L) {
    const int strips = L->N / 8;
    SYS_BUSERR = 0;
    KTILES = L->K / 8;
    QUANT  = (L->mult & 0xFFFF) | (L->shift & 0x3F) << 16 | (L->relu ? 1u << 24 : 0);
    for (int m0 = 0; m0 < L->M; m0 += 16) {
        int rows = L->M - m0 < 16 ? L->M - m0 : 16;
        MROWS = rows;
        copy_words(ABUF, (const uint32_t *)(L->X + m0 * L->K), rows * L->K / 4);
        for (int s = 0; s < strips; s++) {
            copy_words(WBUF, (const uint32_t *)(L->Wp + s * L->K * 8), L->K * 2);
            for (int j = 0; j < 8; j++) BIAS(j) = (uint32_t)L->bias[8 * s + j];
            CTRL = 1;
            while (!(STATUS & 2)) ;
            for (int m = 0; m < rows; m++) {
                if (L->Y) {
                    uint32_t *y = (uint32_t *)(L->Y + (m0 + m) * L->N + 8 * s);
                    y[0] = OUT8(m, 0);
                    y[1] = OUT8(m, 1);
                }
                if (L->acc)
                    for (int j = 0; j < 8; j++)
                        L->acc[(m0 + m) * L->N + 8 * s + j] = (int32_t)ACC(m, j);
            }
        }
    }
    return SYS_BUSERR;
}

int8_t requant(int32_t acc, uint32_t mult, uint32_t shift, int relu) {
    int64_t p = (int64_t)acc * (int64_t)mult;
    if (shift) p += (int64_t)1 << (shift - 1);
    p >>= shift;                      // arithmetic shift (gcc, signed)
    if (relu && p < 0) p = 0;
    if (p > 127) p = 127;
    if (p < -128) p = -128;
    return (int8_t)p;
}

// RV32I has no multiply instruction; gcc would call libgcc's __mulsi3
// (a shift-and-add loop, ~150 cycles for a negative int8). Quarter squares
// are exact for integers:  a*b = floor((a+b)^2/4) - floor((a-b)^2/4),
// and for int8 operands |a+b| <= 256, |a-b| <= 255: one 257-entry table.
static uint16_t QSQ[257];

static inline int32_t mul8(int32_t a, int32_t b) {
    int32_t s = a + b, d = a - b;
    return (int32_t)QSQ[s < 0 ? -s : s] - (int32_t)QSQ[d < 0 ? -d : d];
}

void cpu_layer(const layer_t *L) {
    if (QSQ[2] == 0)                      // floor(i^2/4) by differences: no multiply
        for (uint32_t i = 1, sq = 0; i < 257; i++) { sq += 2 * i - 1; QSQ[i] = sq >> 2; }
    for (int m = 0; m < L->M; m++)
        for (int n = 0; n < L->N; n++) {
            const int8_t *x = L->X + m * L->K;
            const int8_t *w = L->Wp + (n / 8) * L->K * 8 + (n % 8);
            int32_t a = L->bias[n];
            for (int k = 0; k < L->K; k++) a += mul8(x[k], w[8 * k]);
            if (L->Y)   L->Y[m * L->N + n] = requant(a, L->mult, L->shift, L->relu);
            if (L->acc) L->acc[m * L->N + n] = a;
        }
}
