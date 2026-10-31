# ew-decoder — exponent-window lossless BF16 weight decoder

A GEMV engine whose weight path decodes a ~11-bit lossless format back to
exact BF16 on the fly, so a memory-bound LLM decode step reads ~30% fewer
bytes per token, with the model bit-identical. Controlled by our own RISC-V
core through custom-0 instructions. The format is ZipServ's (TCA-TBE); the
contribution is the hardware decoder, the ISA interface, and hardware-only
variants (per-tile bases, other window widths). Full spec: `BRIEF.md`.
Design: `docs/ARCH.md`. Every decision and number: `LEDGER.md`.

**Results** (full table with tags: `docs/RESULTS.md`; each number's command: `LEDGER.md`):

- Format on Qwen2.5-0.5B: 11.225 bits/weight, 170/170 matrices bit-exact [measured]
- Real layer 21 at 8 B/cycle: 1.4246× faster than raw BF16, 99.9% of the
  1.4261× ceiling, bit-exact; sweep of 4/8/16 lanes and 2/3/4-bit codes all
  within 0.15% of their ceilings [sim]
- 541/541 coverage bins, 10,000 random seeds; routed netlist on real
  weights: 14,336/14,336 chunks bit-exact [sim]
- Decoder on SKY130: ~84 MHz typical, 50 MHz at all corners, 7,208 cells,
  DRC/LVS clean; 4.27 mW from real switching; 13–25% less weight-path
  energy per token [estimate]
- RTX 3060 Laptop: whole model from compressed weights, logits
  bit-identical; Nsight showed software decode makes the kernel ALU-bound;
  the rewrite reaches 1.03–1.05× raw BF16 wall clock [measured]

Prior art: the format is ZipServ's TCA-TBE (base + 3-bit offset + escapes).
Related hardware decoders are listed in `BRIEF.md`. No FPGA or silicon
results: everything hardware-side is simulation or layout estimates.

## Layout

```
BRIEF.md            the project brief (verbatim)
LEDGER.md           decisions, assumptions, numbers, dead ends
docs/ARCH.md        architecture, timing, ISA encodings
analysis/measure.py Phase 1: format statistics on a real model
sw/ewformat.py      encoder / decoder / synthetic weights
sw/golden.py        bit-accurate model of the hardware arithmetic
sw/image.py         DRAM layout + per-job stream config
sw/driver/          C driver (custom instructions in ew.h), build.py
rtl/                engine: ew_top, ew_ctrl, weight_decoder, ew_lane,
                    gemv_core, bf16_mul, fp32_add, AXI readers/writer, FIFO
rtl/cpu/            riscv-core @ 48a8279 + coprocessor port (VENDORED.md)
tb/                 cocotb tests: arithmetic, engine, full SoC
gpu/                CUDA kernels (gemv_ew, gemv_ew2), whole-model demo, Nsight reports
openlane/           SKY130 layouts: decoder, design sweep, whole engine
gl/                 routed netlist, SPEF, gate-level power (power.tcl)
analysis/           Phase 1 measurement, energy model
docs/RESULTS.md     every result in one table
```

## Setup

- Python 3.12, `pip install cocotb==2.1.0 numpy pytest huggingface_hub`
  (`torch` for the PyTorch comparison and the GPU kernels)
- oss-cad-suite (Icarus Verilog 14; Verilator) and xPack
  riscv-none-elf-gcc 15.2. Edit the paths in `env.sh`, then in Git Bash:

```
source env.sh
```

## Reproduce

```
python sw/ewformat.py                      # format self-test (roundtrip, b = 2/3/4)
python sw/golden.py                        # golden vs. PyTorch FP32 on synthetic weights
pytest tb/test_arith.py                    # bf16_mul / fp32_add vs. golden, bitwise
pytest tb/test_top.py                      # engine: 6 builds, 21 tests (~3 min)
pytest tb/test_cpu.py                      # riscv-core + C driver + engine (~30 s)
RAND_SEEDS=10000 pytest tb/test_top.py -k default   # the brief's 10k seeds (hours)
python analysis/measure.py                 # Phase 1 on Qwen2.5-0.5B (downloads ~1 GB)
python analysis/golden_vs_torch.py         # golden.py vs. PyTorch on real layers
pytest tb/test_real.py -s                  # a real layer through the RTL (EW_LAYER=21)
python gpu/prep.py && gpu/build.bat && gpu/build/ewgemv.exe gpu/data   # GPU baseline
yosys -m slang -s fpga/yosys/synth.ys      # resource estimate
bash openlane/run.sh decoder               # SKY130 layout (WSL, LibreLane)
bash openlane/sweep.sh                     # layouts of the sweep points
pytest tb/test_dec.py                      # routed netlist, gate level
python analysis/energy.py                  # energy per token
PERL5LIB=tools/perl5 verilator --lint-only --top-module ew_top rtl/*.sv
```

`sim_build/top_l8_b3*/perf.txt` hold the simulated decoded-vs-raw cycle
counts (labeled [sim, synthetic] in LEDGER.md).

## Not done

- FPGA: no board yet, so no achieved DRAM bandwidth, board power or clock.
- Batch > 1 and the KV cache: both read activations this format does not
  compress.

## How this was built

The code was written with Claude Code (Anthropic's AI coding agent) under
Rayan Benaoussar's direction: Rayan chose what to build, what to measure and
which trade-offs to take; Claude wrote the code and ran the tools. Every
number here comes from a script or log in this folder.
