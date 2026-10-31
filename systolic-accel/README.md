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

## Physical design (SKY130)

The 8x8 array (`pe.sv` + `systolic_array.sv`, without the buffers, which
would need SRAM macros) was taken from RTL to GDS with LibreLane (the
OpenLane 2 successor), classic flow, on SkyWater's open 130 nm PDK
(`sky130_fd_sc_hd`), 20 ns clock target, 40% core utilization.
Config, scripts and reports are in `openlane/`.

| | |
|---|---|
| die / core area | 1.89 mm² / 1.84 mm² (1371 x 1381 µm) |
| standard cells | 108,707 (45% utilization) |
| fmax, typical (tt, 25 °C, 1.8 V) | ~84 MHz (8.09 ns setup slack at 20 ns) |
| fmax, worst corner (ss, 100 °C, 1.6 V) | ~43 MHz (-3.10 ns slack at 20 ns) |
| peak compute at 84 MHz | 64 MAC/cycle = 5.4 GMAC/s |
| power at 50 MHz (default switching activity) | 25.3 mW |
| DRC / LVS | 0 / 0 errors |

So the block signs off at the typical corner but misses 50 MHz at the
slow corner. Remaining warnings: 118 max-fanout violations (mostly clock
leaf buffers driving 12-15 flops against a limit of 10) and max-slew/cap
violations concentrated in the slow corner. The critical path is the
PE's 8x8 multiply feeding a 32-bit add in one cycle. A pipeline register
between the multiply and the add would roughly halve it, at the cost of
one more cycle of latency.

`openlane/results/closeup.png` is a 60 µm window of the routed layout
(SKY130 layer colors), and `die.png` is the whole block. The full view is
a uniform texture because placement is flat: the 64 PEs are spread
together rather than laid out as an 8x8 grid of tiles.

### Tiled (hierarchical) version

`openlane/tiled/` hardens the same RTL hierarchically. First one PE
becomes a 180 x 180 µm macro (met1-met4 only, pins placed so neighbours
connect straight across: activations west to east, partial sums north to
south). Then 64 copies go on a fixed 8x8 grid (220 µm pitch), and the
top level adds the skew/deskew registers, clock tree and met5 power grid
around them. The top-level STA uses the macro's own per-corner timing
views and parasitics.

| | PE macro | tiled array |
|---|---|---|
| size | 180 x 180 µm, 1,865 cells | 1.96 x 1.96 mm, 64 macros + 22,832 cells |
| setup slack, slow corner (20 ns) | +1.96 ns | +3.29 ns (~60 MHz) |
| setup slack, typical corner | +8.87 ns | +10.20 ns (~102 MHz) |
| flop-to-flop hold, all corners | passes | passes (worst +0.63 ns) |
| DRC / LVS / antenna | 0 / 0 / 0 | 0 / 0 / 0 |

It is bigger than the flat run, because the channels and margin are
mostly empty, but faster at both corners: each PE's wiring is short and
identical, and the slow-corner failure from the flat run is gone.

Open item: 39 hold violations (worst -0.34 ns) at the slow corners,
all from top-level input ports (`in_a`, `rst`, `in_tag`, `w_data`,
`in_valid`; see `openlane/tiled/results/hold_worst_max_ss.rpt`).
LibreLane's default constraint puts inputs 4 ns after an ideal clock
edge, while CTS delays the internal clock by about 4.6 ns at that corner
to match the macros' insertion delay. In a chip, the logic driving these
pins sits on the same clock tree, so the fix is a real I/O constraint
(or hold buffers on the input paths), not a change to the array.

`openlane/tiled/results/die.png` shows the 8x8 grid. `bash
openlane/tiled/run_tiled.sh` reruns both stages (`pe` or `top` for one).

### 3D viewer

`openlane/viewer3d/` turns the final GDS and DEF into a three.js page
(`../Systolic-Array-3D.html`, one file, three.js from jsDelivr). Every
mask layer from diffusion to met5 is extruded to its SKY130 height, with
the PE drawn once and instanced 64 times. A "cell functions" view colours
each placed cell by what it does in the RTL (weight/activation/partial-sum
register, multiplier or adder logic, skew/deskew, reset, hold fix…).
`cells3d.py` works that out by tracing the placed netlist from the ports.
Hovering shows the layer, cell, owning PE and register bit. There's also
ambient occlusion, shadows and 4K/8K PNG export.

```bash
bash openlane/viewer3d/export3d.sh          # in WSL, after run_tiled.sh
python openlane/viewer3d/build_viewer.py    # gzip + inline the data
```

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

The code was written with Claude Code (Anthropic's AI coding agent) under
Rayan Benaoussar's direction: Rayan chose what to build, what to measure and
which trade-offs to take; Claude wrote the code and ran the tools. Every
number here comes from a script or log in this folder.
