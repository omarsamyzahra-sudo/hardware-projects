# systolic-accel

An int8 **8x8 weight-stationary systolic array** accelerator with an
AXI4-Lite interface, verified with cocotb and UVM, and integrated into a
RISC-V SoC with [riscv-core](https://github.com/withered24/riscv-core) (a
5-stage RV32I pipeline, included as a submodule). Bare-metal C drives it to
run a quantized MNIST network. Everything runs in simulation (Icarus Verilog,
Vivado xsim).

```
 riscv-core ──dmem──► bridge ──AXI4-Lite──► accel_axil ─┬─ registers
 (RV32I, 5-stage)  (dmem_wait stalls                    ├─ WBUF 8 KiB ─┐
      │             the pipeline)                       ├─ ABUF 16 KiB ┼─► accel_core ─► 8x8 array
      └── RAM 256 KiB (code, data)                      └─ OUT8 / ACC ◄┘    (load, stream, accumulate,
                                                                              requantize)
```

## What it computes

One job: `OUT[m][n] = requant(bias[n] + Σk A[m][k]·W[k][n])` for up to 16
rows (M), 8 output columns, and K = 8·KT up to 1024. Here
`requant(x) = sat8((x·mult + 2^(shift-1)) >> shift)`, optionally followed
by ReLU. The driver runs one job per strip of 8 output columns. The
register map is in [`rtl/accel_pkg.sv`](rtl/accel_pkg.sv), and the
bit-exact reference model is [`model/golden.py`](model/golden.py).

* **The array** ([`rtl/systolic_array.sv`](rtl/systolic_array.sv),
  [`rtl/pe.sv`](rtl/pe.sv)). Each PE holds one weight, in two banks.
  Activations move right and partial sums move down. Skewing the inputs
  and deskewing the outputs means one row goes in per cycle and one row
  of 8 int32 sums comes out 2N-1 = 15 cycles later.
* **The controller** ([`rtl/accel_core.sv`](rtl/accel_core.sv)).
  * The loader writes k-tile t's weights into bank t%2 while the
    streamer feeds tile t-1 through the other bank (double buffering).
  * A bank may be overwritten N-3 cycles after its last activation
    went in. The header derives this bound, and a mutation test shows
    it is exact.
  * With M = 16 the array is busy every cycle: 16 cycles per k-tile.
* **The bus** ([`rtl/accel_axil.sv`](rtl/accel_axil.sv)).
  * AXI4-Lite with OKAY, SLVERR (a write while busy, a write to a
    read-only register, an invalid job) and DECERR (unmapped address).
  * The operand buffers are dual-port block-RAM style memories.
* **The SoC** ([`soc/soc_top.sv`](soc/soc_top.sv)).
  * The core's data port reaches RAM, the SYS registers (exit code,
    console, cycle counter, bus-error latch) and the accelerator.
  * An accelerator access becomes one AXI4-Lite transaction. The core
    freezes on `dmem_wait` until the response is back.
  * That stall logic was added to riscv-core for this, and is proven
    there with formal (k-induction) and lockstep cosimulation.

## Verification

| layer | what | where |
|---|---|---|
| array | random streams with bubbles vs numpy at exact latency, int8 extremes, a bank rewritten while the other bank's rows are in flight | `tb/test_array.py` |
| accelerator | random jobs over AXI with bus jitter, corner shapes (M=1/16, odd KT, K=256), requant edges (saturation, ReLU, int32 wrap, exact halves), throughput, bus errors and byte strobes | `tb/test_accel.py` |
| UVM (xsim) | AXI4-Lite agent (random gaps, B/R back-pressure), scoreboard with its own model of every register, buffer and job, functional coverage (job M x KT cross, shifts, ReLU at 100%; bus region x direction x response at 94%), SVA protocol checks | `uvm/` |
| SoC | C programs on riscv-core: accelerator vs CPU bit-for-bit, and MNIST vs the Python int8 model | `tb/test_soc.py`, `sw/` |

Bugs the testbenches found, including two weaknesses in the testbenches
themselves that mutation testing exposed, are in
[`docs/bugs.md`](docs/bugs.md).

## Results (simulation, cycle counts)

MNIST, 784-64-10 MLP, int8 (`model/mnist.py`): **97.0%** test accuracy
on all 10,000 test images, against 96.99% in float. On the SoC, 32 test
images give 31/32 correct, with predictions identical to the Python int8
model.

| | cycles per image |
|---|---|
| RV32I alone (int8 products from a quarter-square table) | 1,272,163 |
| RV32I + accelerator (batches of 16) | **6,748** |
| speedup | **188×** |

The accelerated time is mostly the CPU feeding the bus. Each 32-bit store
to the accelerator is one AXI4-Lite write, and the weights for each strip
of 8 columns are rewritten for every batch. Compute is about 1,600
cycles per strip per batch. The obvious next steps are wider transfers
(a DMA engine or AXI4 bursts) and keeping weights resident across batches.

## Run it

Source `env.sh` in Git Bash first (OSS CAD Suite, RISC-V GCC, Vivado bin).

```bash
pytest tb/test_array.py tb/test_accel.py     # cocotb, ~20 s
./uvm/run.sh cover_test 3                    # UVM on xsim, ~90 s
python model/mnist.py                        # train + quantize + export sw/mnist_data.h
pytest tb/test_soc.py                        # C programs on the SoC (slow: Icarus, ~2k cycles/s)
```

`git clone --recursive` for the riscv-core submodule.

## How this was built

The code was written by Claude (Anthropic's AI model) during Rayan's
hardware sprint, under Rayan's direction. Rayan's own work in this
repository will be listed here as it happens. The sprint's gates (study
questions Rayan answers before each step) are tracked outside this repo.
