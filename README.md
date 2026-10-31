# hardware-projects

Rayan Benaoussar's hardware projects (EE + Math, University of North Florida, '28):
RTL design, verification, SkyWater 130 nm layout and GPU kernels. Each folder is
a self-contained project with its own README, tests and results, and keeps the
full commit history it was built with.

**Portfolio site:** https://rayan-benaoussar.vercel.app (also at https://withered24.github.io/hardware-projects/; source in [`docs/`](docs))

| project | what it is | headline | evidence |
|---|---|---|---|
| [`ew-decoder`](ew-decoder) | Hardware decoder for losslessly compressed LLM weights (ZipServ's exponent-window format), in front of a GEMV engine driven by RISC-V custom-0 instructions | 1.42× faster weight streaming on a real Qwen2.5 layer, 99.9% of the format's ceiling, bit-exact | [RESULTS.md](ew-decoder/docs/RESULTS.md), [LEDGER.md](ew-decoder/LEDGER.md) |
| [`riscv-core`](riscv-core) | RV32I CPU, single-cycle and 5-stage pipelined | 41/41 riscv-tests in lockstep with a golden model, 30 SVA properties proven by k-induction, 33/33 planted bugs caught | [README](riscv-core/README.md) |
| [`systolic-accel`](systolic-accel) | int8 8×8 weight-stationary systolic array on AXI4-Lite in a RISC-V SoC | MNIST MLP in 188× fewer cycles than the CPU alone; cocotb + UVM | [README](systolic-accel/README.md) |
| [`simt-gpu`](simt-gpu) | SIMT GPU: 2 cores × 4 warps × 8 lanes, min-PC divergence, coalescing LSU | 4.9–8.8× fewer cycles than the CPU; byte-exact against a per-thread golden model | [README](simt-gpu/README.md) |
| [`int8-gemm-cuda`](int8-gemm-cuda) | int8 GEMM CUDA kernels from naive to tensor cores | 48.7 TOPS on an RTX 3060 Laptop; 1.62× cuBLAS on a batch-16 LLM-decode shape | [README](int8-gemm-cuda/README.md) |

SKY130 layouts (LibreLane / OpenROAD; typical / slow corner):

| block | cells | fmax tt / ss | DRC / LVS / antenna |
|---|---|---|---|
| Weight decoder | 7,208 | ~84 / ~53 MHz | 0 / 0 / 0 |
| RISC-V CPU | 18,188 | ~71 / ~44 MHz | 0 / 0 / 0 |
| Systolic array, tiled (64 PE macros) | 64 macros + 22,832 | ~102 / ~60 MHz | 0 / 0 / 0 |
| Systolic array, flat | 108,707 | ~84 / ~43 MHz | 0 / 0 / 1 |
| Decoder engine (whole) | 328,076 | ~56 / ~30 MHz | 0 / 0 / 7 |
| SIMT GPU core | layout running | | |

## Shared code

`systolic-accel/riscv-core` and `simt-gpu/riscv-core` are pinned copies of
`riscv-core` at commit 48a8279, the version those projects were built against.
`ew-decoder/rtl/cpu` is a copy of the same commit with a coprocessor port added.
