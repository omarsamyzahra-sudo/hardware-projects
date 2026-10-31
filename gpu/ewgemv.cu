// ewgemv.cu — GPU baseline: batch-1 GEMV on raw BF16 vs. the exponent-window
// format decoded in software, on one real Qwen2.5-0.5B layer (gpu/prep.py)
//
//   ewgemv.exe [data_dir]
//
// Three ways to compute y = W x for each of the layer's 7 projections:
//   bf16    raw BF16 weights; one warp per row, each lane 8 weights (16 B) a step
//   ew      the same kernel shape, but each lane reads 3 code bytes + 8 sign/
//           mantissa bytes and rebuilds the BF16 weight; escapes come from the
//           in-order escape stream, found with a warp prefix sum of escape
//           counts plus a per-row start index
//   cublas  cublasGemmEx (BF16 in, FP32 compute), for reference
// bf16 and ew multiply-add in exactly the same order, so their y must be
// bit-identical: that is the lossless-decode check on the GPU. Both are also
// checked against a CPU double-precision reference.
//
// Timing: the whole layer (7 GEMVs, ~30 MB of BF16 weights, 10x the L2) back
// to back, median of 7 trials of 100 layers each. Weights come from DRAM.
#include <cublas_v2.h>
#include <cuda_runtime.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#define CK(x) do { cudaError_t e = (x); if (e != cudaSuccess) { \
    fprintf(stderr, "%s:%d %s\n", __FILE__, __LINE__, cudaGetErrorString(e)); exit(1); } } while (0)
#define CB(x) do { cublasStatus_t s = (x); if (s != CUBLAS_STATUS_SUCCESS) { \
    fprintf(stderr, "%s:%d cublas %d\n", __FILE__, __LINE__, (int)s); exit(1); } } while (0)

#include "ewgemv_kernels.cuh"

template <class T> static std::vector<T> load(const std::string &p) {
    std::ifstream f(p, std::ios::binary | std::ios::ate);
    if (!f) { fprintf(stderr, "can't open %s\n", p.c_str()); exit(1); }
    size_t n = f.tellg();
    std::vector<T> v(n / sizeof(T));
    f.seekg(0);
    f.read(reinterpret_cast<char *>(v.data()), n);
    return v;
}

template <class T> static T *up(const std::vector<T> &v) {
    T *d;
    CK(cudaMalloc(&d, std::max<size_t>(v.size() * sizeof(T), 16)));
    CK(cudaMemcpy(d, v.data(), v.size() * sizeof(T), cudaMemcpyHostToDevice));
    return d;
}

struct Mat {
    std::string name;
    int rows, cols, base, n_esc;
    std::vector<uint16_t> w, x;
    size_t code_b, sm_b, esc_b;
    uint16_t *dw, *dx;
    uint8_t *dcode, *dsm, *desc;
    uint32_t *drow;
    float *dy;
};

static float bf_h(uint16_t b) { uint32_t u = (uint32_t)b << 16; float f; memcpy(&f, &u, 4); return f; }

int main(int argc, char **argv) {
    std::string dir = argc > 1 ? argv[1] : "gpu/data";
    cudaDeviceProp prop;
    CK(cudaGetDeviceProperties(&prop, 0));
    int mem_clk_khz = 0, bus_bits = 0;
    cudaDeviceGetAttribute(&mem_clk_khz, cudaDevAttrMemoryClockRate, 0);
    cudaDeviceGetAttribute(&bus_bits, cudaDevAttrGlobalMemoryBusWidth, 0);
    printf("gpu: %s, %d SMs, L2 %d KB, bus %d bit\n", prop.name, prop.multiProcessorCount,
           prop.l2CacheSize / 1024, bus_bits);

    std::vector<Mat> ms;
    std::ifstream man(dir + "/manifest.txt");
    Mat m;
    while (man >> m.name >> m.rows >> m.cols >> m.base >> m.n_esc) {
        std::string p = dir + "/" + m.name;
        m.w = load<uint16_t>(p + ".w.bin");
        m.x = load<uint16_t>(p + ".x.bin");
        auto code = load<uint8_t>(p + ".code.bin"), sm = load<uint8_t>(p + ".sm.bin"),
             esc = load<uint8_t>(p + ".esc.bin");
        auto row = load<uint32_t>(p + ".rowesc.bin");
        m.code_b = code.size(); m.sm_b = sm.size(); m.esc_b = m.n_esc;
        m.dw = up(m.w); m.dx = up(m.x); m.dcode = up(code); m.dsm = up(sm); m.desc = up(esc);
        m.drow = up(row);
        CK(cudaMalloc(&m.dy, m.rows * sizeof(float)));
        ms.push_back(m);
    }
    if (ms.empty()) { fprintf(stderr, "no matrices in %s/manifest.txt (run gpu/prep.py)\n", dir.c_str()); return 1; }

    cublasHandle_t h;
    CB(cublasCreate(&h));
    const float one = 1.f, zero = 0.f;
    // modes: 0..2 = bf16 G=8/16/32, 3..5 = ew G=8/16/32, 6 = cuBLAS
    const int NM = 7;
    const char *names[NM] = {"bf16 G8", "bf16 G16", "bf16 G32", "ew G8", "ew G16", "ew G32", "cublas"};
    auto run = [&](int mode) {
        for (auto &m : ms) {
            dim3 grid((m.rows + WARPS - 1) / WARPS), block(32 * WARPS);
            switch (mode) {
            case 0: gemv_bf16<8><<<grid, block>>>(m.dw, m.dx, m.dy, m.rows, m.cols); break;
            case 1: gemv_bf16<16><<<grid, block>>>(m.dw, m.dx, m.dy, m.rows, m.cols); break;
            case 2: gemv_bf16<32><<<grid, block>>>(m.dw, m.dx, m.dy, m.rows, m.cols); break;
            case 3: gemv_ew<8><<<grid, block>>>(m.dcode, m.dsm, m.desc, m.drow, m.dx, m.dy, m.rows, m.cols, m.base); break;
            case 4: gemv_ew<16><<<grid, block>>>(m.dcode, m.dsm, m.desc, m.drow, m.dx, m.dy, m.rows, m.cols, m.base); break;
            case 5: gemv_ew<32><<<grid, block>>>(m.dcode, m.dsm, m.desc, m.drow, m.dx, m.dy, m.rows, m.cols, m.base); break;
            default:
                CB(cublasGemmEx(h, CUBLAS_OP_T, CUBLAS_OP_N, m.rows, 1, m.cols, &one, m.dw, CUDA_R_16BF, m.cols,
                                m.dx, CUDA_R_16BF, m.cols, &zero, m.dy, CUDA_R_32F, m.rows,
                                CUBLAS_COMPUTE_32F, CUBLAS_GEMM_DEFAULT));
            }
        }
        CK(cudaGetLastError());
    };
    auto fetch = [&](int mode) {
        run(mode);
        CK(cudaDeviceSynchronize());
        std::vector<std::vector<float>> out;
        for (auto &m : ms) {
            std::vector<float> v(m.rows);
            CK(cudaMemcpy(v.data(), m.dy, m.rows * 4, cudaMemcpyDeviceToHost));
            out.push_back(v);
        }
        return out;
    };

    // ---- correctness: ew G == bf16 G bitwise (same order), all vs. a double reference
    std::vector<std::vector<std::vector<float>>> ys;
    for (int mode = 0; mode < NM; mode++) ys.push_back(fetch(mode));
    bool ok = true;
    for (size_t i = 0; i < ms.size(); i++) {
        auto &m = ms[i];
        size_t diff = 0;
        double worst[NM] = {};
        for (int r = 0; r < m.rows; r++) {
            double ref = 0, mag = 0;
            for (int k = 0; k < m.cols; k++) {
                double p = (double)bf_h(m.w[(size_t)r * m.cols + k]) * bf_h(m.x[k]);
                ref += p; mag += fabs(p);
            }
            for (int g = 0; g < 3; g++) {
                uint32_t a, b;
                memcpy(&a, &ys[g][i][r], 4); memcpy(&b, &ys[3 + g][i][r], 4);
                diff += a != b;
            }
            for (int t = 0; t < NM; t++) worst[t] = std::max(worst[t], fabs(ys[t][i][r] - ref) / (mag + 1e-30));
        }
        double wk = *std::max_element(worst, worst + 6);
        printf("check %-5s %5dx%-5d  ew==bf16 bitwise (G=8,16,32): %s (%zu rows differ)  max |err|/sum|wx|: ours %.1e cublas %.1e\n",
               m.name.c_str(), m.rows, m.cols, diff ? "NO" : "yes", diff, wk, worst[6]);
        ok = ok && diff == 0 && wk < 1e-5 && worst[6] < 1e-3;
    }
    if (!ok) { printf("CHECK FAILED\n"); return 1; }

    // ---- timing
    size_t raw_bytes = 0, ew_bytes = 0, weights = 0;
    for (auto &m : ms) {
        weights += (size_t)m.rows * m.cols;
        raw_bytes += (size_t)m.rows * m.cols * 2;
        ew_bytes += m.code_b + m.sm_b + m.esc_b + m.rows * 4;
    }
    double med[NM];
    cudaEvent_t e0, e1;
    CK(cudaEventCreate(&e0)); CK(cudaEventCreate(&e1));
    const int REPS = 100, TRIALS = 7;
    for (int mode = 0; mode < NM; mode++) {
        for (int i = 0; i < 20; i++) run(mode);
        std::vector<double> t;
        for (int tr = 0; tr < TRIALS; tr++) {
            CK(cudaEventRecord(e0));
            for (int i = 0; i < REPS; i++) run(mode);
            CK(cudaEventRecord(e1));
            CK(cudaEventSynchronize(e1));
            float ms_ = 0;
            CK(cudaEventElapsedTime(&ms_, e0, e1));
            t.push_back(ms_ * 1e3 / REPS);
        }
        std::sort(t.begin(), t.end());
        med[mode] = t[TRIALS / 2];
    }
    double bits = 8.0 * ew_bytes / weights;
    int bb = (int)(std::min_element(med, med + 3) - med), be = 3 + (int)(std::min_element(med + 3, med + 6) - (med + 3));
    printf("\nlayer: %zu weights; bytes read: raw %.2f MB, ew %.2f MB (%.3f bits/weight incl. row index)\n",
           weights, raw_bytes / 1e6, ew_bytes / 1e6, bits);
    printf("%-9s %10s %12s %16s\n", "kernel", "us/layer", "weight GB/s", "vs best bf16");
    for (int mode = 0; mode < NM; mode++) {
        size_t b = (mode >= 3 && mode < 6) ? ew_bytes : raw_bytes;
        printf("%-9s %10.1f %12.1f %15.3fx\n", names[mode], med[mode], b / (med[mode] * 1e3), med[bb] / med[mode]);
    }
    printf("best ew vs best bf16: %.3fx   ceiling 16/bits = %.3fx\n", med[bb] / med[be], 16.0 / bits);
    printf("csv,%s,%s,%.2f,%s,%.2f,%.2f,%.4f\n", prop.name, names[bb], med[bb], names[be], med[be], med[6], bits);
    return 0;
}
