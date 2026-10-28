// test_gemm.c — random int8 layers on the accelerator vs the CPU, bit for bit
//
// Shapes cover one and two row chunks, one and several strips, K = 8 and a
// long K. Prints the cycle counts of both. Exit code = number of mismatches.
#include "accel.h"
#include "soc.h"

static uint32_t seed = 12345;
static uint32_t rnd(void) { seed = seed * 1664525u + 1013904223u; return seed >> 8; }

#define MAXM 20
#define MAXK 256
#define MAXN 24
static int8_t  X[MAXM * MAXK] __attribute__((aligned(4)));
static int8_t  Wp[MAXK * MAXN] __attribute__((aligned(4)));
static int32_t bias[MAXN];
static int8_t  Ya[MAXM * MAXN] __attribute__((aligned(4))), Yc[MAXM * MAXN] __attribute__((aligned(4)));
static int32_t Aa[MAXM * MAXN], Ac[MAXM * MAXN];

static int run(int M, int K, int N, uint32_t mult, uint32_t shift, int relu) {
    for (int i = 0; i < M * K; i++) X[i] = (int8_t)rnd();
    for (int i = 0; i < K * N; i++) Wp[i] = (int8_t)rnd();
    for (int i = 0; i < N; i++) bias[i] = (int32_t)(rnd() & 0x1FFF) - 0x1000;
    layer_t L = { M, K, N, X, Wp, bias, mult, shift, relu, Ya, Aa };
    uint32_t t0 = cycles();
    uint32_t err = accel_layer(&L);
    uint32_t t1 = cycles();
    L.Y = Yc; L.acc = Ac;
    cpu_layer(&L);
    uint32_t t2 = cycles();
    int bad = 0;
    for (int i = 0; i < M * N; i++) bad += (Ya[i] != Yc[i]) + (Aa[i] != Ac[i]);
    puts_("M="); put_int(M); puts_(" K="); put_int(K); puts_(" N="); put_int(N);
    puts_("  accel "); put_int(t1 - t0); puts_(" cycles, cpu "); put_int(t2 - t1);
    puts_(" cycles, mismatches "); put_int(bad);
    if (err) { puts_(", BUSERR "); put_hex(err); bad++; }
    putch('\n');
    return bad;
}

int main(void) {
    int bad = 0;
    puts_("test_gemm: accelerator vs CPU\n");
    bad += run(1, 8, 8, 30000, 22, 0);
    bad += run(5, 64, 16, 24000, 24, 1);
    bad += run(16, 64, 24, 24000, 24, 0);
    bad += run(20, 32, 8, 30000, 24, 1);       // two row chunks
    bad += run(16, 256, 8, 12000, 24, 0);      // long K
    puts_(bad ? "FAIL\n" : "PASS\n");
    return bad;
}
