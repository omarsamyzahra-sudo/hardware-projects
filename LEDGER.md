# LEDGER

Chronological decisions, assumptions, numbers and dead ends (brief: "record
every decision, number and assumption"). Every number is tagged:
**[sim]** cycle-accurate simulation, **[synthetic]** on generated weights,
**[measured]** on real hardware or real model weights, **[assumption]**.
First [measured] numbers: Phase 1 and the GPU baseline, 2026-10-30 (below).

---

## 2026-10-30 — setup and scope

- **Hardware plan (Rayan's call):** simulate only, no boards. The home PC's
  RTX 3080 is the measured GPU baseline (raw BF16 GEMV kernel vs. an
  exponent-window decode kernel), standing in for the brief's "ZipServ
  numbers as external reference" with a number we measure ourselves.
- **Control CPU:** our own `riscv-core` (5-stage RV32I, formally checked,
  passes riscv-tests) instead of VexRiscv/PicoRV32 or the Zynq PS. Reason:
  it's verified and ours, and the Arty has no PS. Vendored at commit
  `48a8279` into `rtl/cpu/` (see `rtl/cpu/VENDORED.md`). Doesn't change what
  the comparison measures: the CPU only issues commands.
- **Deviation from the brief's gate order (Rayan's direction):** RTL was
  built before Gate 1, so the home PC can pick up from a working, verified
  engine. Every Gate 1 decision is a build parameter (`CODE_BITS`,
  `PER_TILE_BASE`, FIFO depths) or a per-job register (`EXP.BASE`,
  `DEC.BYPASS`), so Gate 1 *selects* a configuration rather than forcing a
  redesign. **If Phase 1 shows coverage or burstiness that the escape path
  can't take** (brief: stop and ask), that still applies.
- **File names:** the brief's `sw/encode.py` is `sw/ewformat.py` (encoder +
  decoder + synthetic weights in one module); `sw/image.py` lays matrices
  out in DRAM. Same content, different split.

## Phase 2 — encoder and golden model

- Format as in `docs/ARCH.md §1.1`: 64-weight tiles, CODE_BITS bit-planes
  per tile (one 64-bit word each), sign/mantissa byte stream, in-order escape
  byte stream, optional per-tile base stream; each stream 4 KB-aligned.
- Window choice: best contiguous window of width 2^b − 1; ties go to the
  lowest e*. `base = e* − 1` as an 8-bit wrapping value (window at exponent
  0 → base 255; tested).
- Roundtrip `decode(encode(W)) == W` for b = 2/3/4 and per-tile bases on
  synthetic matrices: 100% **[synthetic]**. On the real model: Phase 1
  (`measure.py` checks it per matrix).
- Synthetic weights (Gaussian, std 0.02, 1% outliers): **11.185 bits/weight**
  at b = 3 **[synthetic]**. Only a smoke number: real weights decide.
- **Lossless storage vs. identical outputs** (brief §2): (a) storage is
  lossless by construction and checked bit-for-bit on every decoded chunk in
  every test; (b) outputs are identical to `sw/golden.py`, which models the
  hardware's arithmetic: BF16×BF16 → FP32 exact, FP32 add RNE with
  DAZ/FTZ, pairwise tree over L lanes, then a sequential accumulator from +0.
- golden.py vs. PyTorch FP32 matmul: max **240 ULP / 9.5e-7 abs**
  **[synthetic]**. The difference is accumulation order, not a bug. The
  brief asks for this on real layers vs. PyTorch BF16 matmul: home-PC step.

## Phase 3 — architecture (docs/ARCH.md)

- Separate 4 KB-aligned regions per stream (not interleaved per tile):
  simpler readers, long bursts on the big streams; the escape stream is
  small either way.
- L lanes, one chunk of L weights per cycle; escape slots by prefix
  popcount; escape byte window WB = L + 8 refilled 8 bytes at a time; a
  chunk issues whole or waits.
- Bypass = raw BF16 on the same sm port, lanes skipped by a mux; everything
  else shared (brief rule: differ only in the decoder).
- Bandwidth-matching table (ARCH §2.1) is **TBD**: needs datasheet numbers
  (KV260 DDR4, Arty DDR3) with document + revision.

## Phase 4/5 — RTL and verification (Icarus 14 + cocotb 2.1)

Verilator's wrapper doesn't run in Git Bash on this laptop, so everything
here is Icarus; the brief names Verilator, and the home PC should run it.

- **Arithmetic units vs. golden.py, bitwise:** `bf16_mul` 25k vectors,
  `fp32_add` 15k vectors over 6 strategies (random, near-cancel, ties,
  subnormal/FTZ, inf/NaN, exponent extremes). All pass.
- **Engine (ew_top + AXI DRAM model), 21 tests across 6 builds** — L = 8 with
  b = 2/3/4, per-tile base, L = 16, bandwidth-limited — all pass
  **[sim]**. Directed: zero escapes, every weight escaped, escapes at tile
  and burst boundaries, edge exponents (0, 255, wrap), back-to-back jobs
  with different bases, decoded ↔ bypass switching. Random: 100 seeds on
  the default build, 30–40 on the others. Brief wants ≥ 10,000 seeds: run at
  home (`RAND_SEEDS=10000`).
- **Two checks per job:** a monitor compares every decoded chunk with the
  original BF16 (lossless), and y in DRAM == golden.py bit for bit.
- **Mutation check (do the tests catch real bugs?):** 5 injected engine bugs
  — escape slot = lane index, round-half-up, accumulator not reset per row,
  window pop short by one, no FIFO space reservation — all 5 caught.
- **CPU integration (tb/test_cpu.py):** riscv-core runs the C driver
  (`sw/driver/layer.c`, built with riscv-none-elf-gcc 15.2, `-march=rv32i`)
  which issues every custom instruction; the testbench never touches the
  command port. A scaled-down layer (q/k/v/o 128-wide, gate/up 384×128,
  down 128×384) plus `up` again in bypass, and 24 random jobs: all
  bit-exact, escape counts read back by `EW.STAT` == encoder's, no
  illegal/trapped instruction **[sim, synthetic]**.
- CPU-side mutations, each caught by test_cpu.py: custom instruction's rd
  not written; custom instruction left out of the load-use stall (its
  result forwarded a cycle early); rs1/rs2 swapped on the coprocessor port.
- SVA-style checks are `$fatal` on FIFO overflow, bad RRESP, and clearing a
  reader mid-burst. Functional coverage report: **not done** (home PC).

## Simulated cycle counts (synthetic weights) — NOT the result

L = 8, latency 20 cycles, one 512×512-ish synthetic job (bits 11.1825):

| memory model | decoded | raw BF16 | speedup | ceiling 16/bits |
|---|---|---|---|---|
| 16 B/cycle (compute-bound: raw needs exactly 16) | 7550 | 7515 | 0.995× | 1.431× |
| 8 B/cycle (bandwidth-bound) | 10327 | 14642 | **1.418×** | 1.431× |

**[sim, synthetic]**. Reading: when the MAC array outruns memory, the
decoded path gets 99% of the 16/bits ceiling with zero escape stalls; when
memory is not the limit, the decoder costs 0.5% (escape window fill at job
start). Real numbers need real weights (Phase 1) and board bandwidth
(datasheets).

## 2026-10-30 — Phase 1 on Qwen2.5-0.5B **[measured]**

Full report: `analysis/REPORT_PHASE1.md`. All 170 2-D BF16 matrices,
494.0M weights (incl. the tied embedding).
- Exponent entropy 2.616 bits; window k = 7 covers **97.19%**; **11.225
  bits/weight** (exponent-byte escape). k = 3: 12.232, k = 15: 12.002.
  Ceiling 16/11.225 = 1.425×.
- Escape encodings tie exactly (b + 8c + 16(1−c) = b + 8 + 8(1−c)).
- Per-tile bases: 64 → 11.316, 256 → 11.236, 1024 → 11.219 (−0.006).
- Lowest coverage 93.18% (layer 16 q_proj); none < 90%.
- Roundtrip bit-exact on 170/170 matrices.
- Worst escape burst 16/64/210 in 16/64/256 weights (layer 21 up_proj).

**Gate 1 decisions:** 3-bit code; per-matrix base (per-tile gains 0.006 <
0.1 threshold, kept as a Phase 7 option); exponent-byte escape (tie → brief's
rule); no bypass list (every matrix ≥ 93%); escape path unchanged (worst
256-weight burst 210 B < 512 B FIFO; L = 8 escape port sustains all-escape
runs). The RTL's defaults already were this configuration.

**Process note:** the download was ~1 GB from Hugging Face; one small file
(tokenizer) failed on a reset connection, the 988 MB safetensors file was
complete (`measure.py` parses its header and roundtrips every tensor).

## 2026-10-30 — golden.py vs. PyTorch on real layers **[measured]**

`analysis/golden_vs_torch.py`, layers 12 and 21, all 7 projections, x
synthetic BF16: max |golden − torch FP32| = **6.2e-6**; vs. torch BF16
matmul (y rounded to BF16) 3.0e-2. Max ULP vs. FP32 is 49,152, always at
outputs near zero where cancellation makes one ULP tiny; abs error is the
meaningful number. (a) storage is lossless; (b) outputs are identical to
golden.py, which differs from PyTorch only by summation order.

## 2026-10-30 — GPU baseline, RTX 3060 Laptop **[measured]**

The laptop turned out to have an RTX 3060 Laptop GPU (GA106, 192-bit, L2 3
MB), so the GPU baseline was written and measured here; the home 3080 reruns
the same binary. `gpu/ewgemv.cu`, data from `gpu/prep.py` (layer 12).
- bf16 and ew kernels have the same shape and multiply-add order, so y must
  match bitwise: **it does, all 7 projections, all 3 lane widths**. That's
  the lossless claim checked on a second, independent decoder.
- GPU needs a per-row escape index (32 bits/row) the hardware doesn't:
  11.262 bits/weight on the GPU vs. 11.226 in the hardware format for this
  layer.
- Whole layer (14.9M weights, 29.8 MB raw ≫ 3 MB L2), median of 7×100,
  SM 2002 MHz, mem 7001 MHz, P0:

| kernel | µs/layer | weight GB/s | vs. best raw |
|---|---|---|---|
| raw BF16, our kernel (best of G = 8/16/32) | 114.3 | 260.8 | 1.000× |
| exponent window, our kernel (best, G = 16) | 116.4 | 180.4 | **0.983×** |
| cuBLAS GemmEx BF16 | 137.9 | 216.3 | 0.829× |

Reading: the decode kernel reads 30% fewer bytes but isn't faster; it runs
at 180 GB/s, well under the 261 GB/s the raw kernel shows the card can do,
so it's bound by decode work, not DRAM. That is the brief's premise (GPU
software decode costs ALU) observed, **with a caveat**: this is a direct
implementation, not ZipServ's (they report 1.31–1.36× with a tensor-core
layout). Not tuned further on purpose: the brief says don't tune toward the
expected answer; Nsight Compute on this kernel is a home-PC item. A first
run with only G = 8 gave 0.84×, which is why lane width became a parameter
for both kernels. Laptop clocks vary with power and heat; the 3080 run
should log `nvidia-smi` clocks the same way (`gpu/results/`).

## 2026-10-30 — resource estimate (Yosys) **[synthesis estimate, not Vivado]**

Vivado 2026.1.1 is installed on the laptop but refuses to start ("installed
version is not supported with your selected license tier"), so the numbers
below are Yosys `synth_xilinx` cell counts (`fpga/yosys/`), each block
synthesized alone with the ew_top defaults. Yosys maps differently from
Vivado; treat these as estimates until Vivado runs. No Fmax yet.

| block | LUT | FF | DSP | BRAM36 |
|---|---|---|---|---|
| whole engine (UltraScale+, KV260 family) | 6,201 | 2,523 | 10 | 4 |
| **weight_decoder** (8 lanes, escape window, tile regs, bypass mux) | **979** | **524** | **0** | **0** |
| one ew_lane | 12 | 0 | 0 | 0 |
| gemv_core (8 multipliers, adder tree, accumulator, x buffer) | 4,064 | 772 | 8 | 4 |
| one AXI read port | 159 | 137 | 0 | 0 |
| whole engine (Artix-7, Arty family) | 6,361 | 2,521 | 11 | 4 |

Decoder = 15.8% of the engine's LUTs and 0 BRAM/DSP (brief target met on
BRAM). The decoded path also needs the code and escape read ports (~2 × 159
LUT) that a raw-only design wouldn't. Most of the decoder isn't the lanes
(8 × 12 = 96 LUT) but the escape byte window + prefix popcount and the
tile staging registers.

## 2026-10-30 — Verilator lint

oss-cad-suite's `verilator` wrapper failed in Git Bash only because Git's
perl lacks `Pod::Usage` (used for `--help`); `tools/perl5/Pod/Usage.pm` is a
stand-in, used with `PERL5LIB=tools/perl5`. Verilator 5.053 default lint on
the engine found 20 implicit width widenings (warnings are fatal by default),
all fixed with explicit casts, no behavior change: regression rerun after,
all pass. The vendored CPU was already clean. Left under `-Wall`: one
unconnected FIFO ready pin, `import *` in two files, the unused upper half of
an x word, and an unused opcode constant. Running the cocotb tests under
Verilator needs a C++ toolchain set up for it on Windows: home PC.

## 2026-10-30 — 10,000 random seeds **[sim]**

`test_random` with RAND_SEEDS=10000 on the default build (L = 8, 3-bit, per
matrix): **10,000 seeds, 2,517,936 decoded chunks, all bit-exact, y ==
golden.py on every job**, 40 min in Icarus. Brief's ≥ 10,000-seed bar met.
Note: compiled from the RTL just before the Verilator width-cast cleanup;
those casts don't change behavior and the full regression passed on the
cleaned RTL.

## 2026-10-30 — real layer through the RTL **[sim, measured weights]**

`tb/test_real.py`, EW_LAYER=21 (the burstiest layer in Phase 1: up_proj has
210 escapes in 256 weights), all 7 projections decoded, then all 7 on the
raw-BF16 bypass, one 64 MB image: **14/14 jobs bit-exact** (decode monitor
on every chunk, y == golden.py on every row). 40 min in Icarus.

| proj | shape | escapes | decoded cycles | raw cycles | ideal (weights/8) |
|---|---|---|---|---|---|
| q | 896×896 | 44,533 | 100,734 | 101,218 | 100,352 |
| k | 128×896 | 4,491 | 14,718 | 14,723 | 14,336 |
| v | 128×896 | 4,723 | 14,718 | 14,723 | 14,336 |
| o | 896×896 | 26,917 | 100,742 | 101,217 | 100,352 |
| gate | 4864×896 | 112,041 | 545,177 | 548,115 | 544,768 |
| up | 4864×896 | 105,742 | 545,196 | 548,113 | 544,768 |
| down | 896×4864 | 109,590 | 546,358 | 546,843 | 544,768 |

Memory model at 16 B/cycle, so this run is compute-bound (raw needs exactly
16 B/cycle at L = 8); it shows correctness and that escape bursts on real
weights cost almost nothing: decoded is within 0.08% of the ideal one chunk
per cycle on gate/up (≤ 409 cycles over 545k), even at 2.6% escapes with
the worst measured bursts. The STALL_ESC counter wasn't read by this test;
the bound comes from the cycle counts.

## 2026-10-31 — whole model end to end on the GPU, weights compressed in VRAM **[measured]**

`gpu/e2e_demo.py` on the RTX 3060 Laptop (torch 2.11.0+cu128, transformers
5.22.1, eager attention, deterministic cuBLAS workspace). Stock Hugging Face
Qwen2.5-0.5B vs. the same model with all 169 distinct weight matrices (the
tied embedding / LM head stored once) held in the exponent-window format in
VRAM and decoded on the GPU at each use. Three prompts, 64 greedy tokens
each. Full table: `gpu/results/e2e_rtx3060-laptop.txt`.

| | stock BF16 | exponent-window |
|---|---|---|
| weight matrices in VRAM | 942.2 MiB | **662.7 MiB (1.422× smaller, 11.255 bits/weight incl. the GPU's 32-bit per-row escape index)** |
| all GPU memory after load | 950.2 MiB | 665.3 MiB |
| peak GPU memory while generating | 1077.7 MiB | 1085.4 MiB |
| tokens/s | 13.2 | 0.7 |

- **Every matrix decoded on the GPU equals the original bit for bit (169/169).**
- **All 192 generated tokens identical, and the logits at every step
  bit-identical** (SHA-256 over the BF16 logits), all three prompts.
- Variant with the LM head decoded in 8192-row slices: tokens identical,
  logits *not* bit-identical (cuBLAS sums differently for the smaller
  shapes; the weights are still exact), peak 1184.0 MiB.

Reading: the format is lossless on the whole model and the weights at rest
take 1.42× less memory. Peak memory and speed are this demo's decoder, not
the format: it's unfused PyTorch tensor ops that unpack each matrix (the LM
head into a 272 MB scratch buffer) before every use, so peak ≈ stock and
it's ~19× slower. A decoder fused into the matmul (the RTL, or
`gpu/ewgemv.cu`'s kernel) has no scratch buffer. Not the chip.

## 2026-10-31 — decoder alone on SKY130 **[estimate: layout tools, sky130_fd_sc_hd]**

`openlane/run.sh decoder` (LibreLane, weight_decoder only, L = 8, 3-bit,
per-matrix base; 20 ns target, 40% utilization), 6 minutes. Results in
`openlane/decoder/results/`.

| | value |
|---|---|
| standard cells | 6,338 (53,036 µm² of cell area; die 329 × 340 µm) |
| setup slack @ 20 ns: tt / ss / ff | +7.50 / −0.54 / +9.50 ns → **~80 MHz typical**, ~49 MHz slow corner (ss, 100 °C, 1.60 V), ~95 MHz fast |
| DRC (Magic, KLayout) · LVS · antenna | 0 · 0 · 0 |
| power, default activity (flow metric) | 3.20 mW @ 50 MHz |

## 2026-10-31 — routed decoder netlist, gate-level, real weights **[sim]**

`tb/test_dec.py`: the routed netlist (`gl/weight_decoder.nl.v`) over the
SKY130 cell models (functional, unit delay), fed the first 128 rows of layer
21's q_proj (114,688 weights, 5,651 escapes): **14,336/14,336 chunks
bit-exact at 0.9997 chunks/cycle**, and again with 20% random gaps on every
input and the output. Same test passes on the RTL. Timing at the clock is
from STA above, not from this simulation.

## 2026-10-31 — decoder power from real switching **[estimate]**

`gl/power.tcl` (OpenSTA 2.7, tt 25 °C 1.80 V library, nominal SPEF, the
layout's 20 ns SDC) with the VCD of the full-speed gate-level run above
(16,314 pins annotated). `gl/power_report.txt`.

| activity | sequential | combinational | clock | **total @ 50 MHz** |
|---|---|---|---|---|
| default (OpenSTA) | 1.15 mW | 0.72 mW | 0.84 mW | 2.71 mW |
| **real weights** | 1.12 mW | 1.56 mW | 0.84 mW | **3.53 mW** |

3.53 mW / (50 MHz × 8 weights × 0.9997) = **8.83 pJ per decoded weight**
(130 nm, 1.8 V).

## 2026-10-31 — weight-streaming energy per token **[estimate + cited]**

`analysis/energy.py` → `analysis/energy.txt`. Per token at batch 1 every
weight is read once (493,961,216 weights). DRAM energy cited from O'Connor
et al., "Fine-Grained DRAM", MICRO-50 2017: HBM2 3.97 pJ/bit (§1), GDDR5
14.0 pJ/bit (Fig. 1a). Counted: weight DRAM reads + decoder logic only
(everything else is identical in both modes).

| memory | raw BF16 | exponent window | saving |
|---|---|---|---|
| HBM2 | 63.52 pJ/w, 31.38 mJ/token | 53.39 pJ/w, 26.37 mJ/token | **15.9%** |
| GDDR5 | 224.00 pJ/w, 110.65 mJ/token | 165.98 pJ/w, 81.99 mJ/token | **25.9%** |

Break-even DRAM cost: 1.85 pJ/bit. The decoder figure is 130 nm; a modern
node spends far less per weight, so these savings are conservative.

## 2026-10-31 — fused kernels in the whole model **[measured]**

`gpu/e2e_demo.py kbf16|kew|compare_kernels` with `gpu/build/ewlib.dll`
(the G = 16 kernels from `gpu/ewgemv_kernels.cuh`, now shared with
`ewgemv.cu`) running every linear layer and the LM head, batch-1 decode.
`gpu/results/e2e_kernels_rtx3060-laptop.txt`.

| | stock (cuBLAS) | ours, raw BF16 | ours, ew fused |
|---|---|---|---|
| weight matrices in VRAM | 942.2 MiB | 942.2 MiB | **662.7 MiB** |
| peak GPU memory, generating | 1077.7 MiB | 1076.7 MiB | **791.9 MiB** |
| tokens/s | 13.2 | 12.8 | 12.5 (**0.977×** ours raw) |

- ew fused vs. ours raw: **tokens identical and logits bit-identical** on all
  3 prompts (same accumulation order). Ours vs. stock: tokens identical.
- With the decode fused, no decoded copy of any matrix ever exists: peak
  memory drops 1.36× against stock. tokens/s is mostly Python/launch
  overhead at this model size (eager attention, one launch per row in
  prefill), so it says little about the kernels; the layer benchmark does.
- Layer benchmark rerun today after the refactor (`ewgemv.exe`, layout runs
  in the background): best ew 0.971× best bf16 (was 0.983× on 10-30); still
  bit-identical. Same conclusion: a GPU decoding in software breaks even.
- Nsight Compute: blocked by Windows (ERR_NVGPUCTRPERM, GPU performance
  counters are admin-only until enabled in the NVIDIA Control Panel).

## 2026-10-31 — functional coverage **[sim]**

`tb/coverage.py`, sampled by the decode monitor in every engine test (and the
CPU-driven tests): escapes per chunk 0..L, every code value on every lane,
escapes at every chunk position in a tile, escape and data stalls, bypass
chunks, the 8-bit window wrap, escaped exponents 0 and 255, back-to-back
tiles, consecutive all-escape chunks. First pass missed data stalls in the
b = 2 / b = 4 / per-tile builds and the wrap at L = 16 (those builds ran a
subset of tests); added the bandwidth-limited cycle test to the first three
and the edge-exponent test to L = 16. Regression `pytest tb/test_top.py
tb/test_cpu.py`: 6/6 pass, **480/480 bins hit across all 5 builds** (L8 b3
89, L8 b2 57, L8 b4 153, L8 b3 per-tile 24, L16 b3 157).
`tb/coverage_report.txt`. Later the same day, after the L = 4 fix (sweep
entry below), an L = 4 build joined the regression (every test, plus the
bandwidth-limited cycle test for data stalls): 7/7 pass, **541/541 bins
across 6 builds** (L4 b3 61).

## 2026-10-31 — real layer, memory-bound **[sim, measured weights]**

`tb/test_real.py::test_real_bw8`: layer 21 again, but the memory model gives
8 B/cycle, half what raw BF16 needs at L = 8, so both paths are bandwidth-bound
(the case the format is for). All 14 jobs bit-exact. 1 h 13 min in Icarus.

| proj | shape | escapes | decoded cycles | raw cycles | speedup | ceiling 16/bits |
|---|---|---|---|---|---|---|
| q | 896×896 | 44,533 | 144,274 | 201,426 | 1.3961× | 1.3981× |
| k | 128×896 | 4,491 | 20,613 | 29,010 | 1.4074× | 1.4138× |
| v | 128×896 | 4,723 | 20,642 | 29,010 | 1.4054× | 1.4121× |
| o | 896×896 | 26,917 | 142,072 | 201,426 | 1.4178× | 1.4199× |
| gate | 4864×896 | 112,041 | 765,769 | 1,092,242 | 1.4263× | 1.4278× |
| up | 4864×896 | 105,742 | 764,981 | 1,092,242 | 1.4278× | 1.4293× |
| down | 896×4864 | 109,590 | 764,641 | 1,091,436 | 1.4274× | 1.4284× |
| **layer** | | | 2,622,992 | 3,736,792 | **1.4246×** | 1.4261× |

Ceiling = raw bytes / encoded bytes for each matrix (padded, as stored). The
layer runs at 99.9% of it: on real weights, with the burstiest layer's escape
runs, the decoder loses 0.1% to its own stalls when memory is the bottleneck.

## 2026-10-31 — design-space sweep, real weights **[sim, measured weights]**

`tb/test_real.py::test_sweep`: one real matrix per run (layer 21 q_proj and
up_proj, the escape-heaviest layer), memory at L B/cycle (half of what raw
BF16 needs at every lane count, so every point is bandwidth-bound). Each
build is its own RTL elaboration (`-P` overrides). All 12 runs bit-exact.
`sim_build/sweep_*/perf.txt`.

| matrix | L | code bits | base | bits/weight | decoded cycles | raw cycles | speedup | ceiling | of ceiling |
|---|---|---|---|---|---|---|---|---|---|
| q_proj | 4 | 3 | matrix | 11.444 | 288,539 | 402,829 | 1.3961× | 1.3981× | 99.86% |
| q_proj | 8 | 2 | matrix | 13.089 | 164,916 | 201,426 | 1.2214× | 1.2224× | 99.92% |
| q_proj | 8 | **3** | matrix | 11.444 | 144,274 | 201,426 | 1.3961× | 1.3981× | 99.86% |
| q_proj | 8 | 3 | tile | 11.395 | 143,656 | 201,426 | **1.4021×** | 1.4042× | 99.85% |
| q_proj | 8 | 4 | matrix | 12.004 | 151,304 | 201,426 | 1.3313× | 1.3329× | 99.88% |
| q_proj | 16 | 3 | matrix | 11.444 | 72,198 | 100,819 | 1.3964× | 1.3981× | 99.88% |
| up_proj | 4 | 3 | matrix | 11.194 | 1,529,953 | 2,184,461 | 1.4278× | 1.4293× | 99.90% |
| up_proj | 8 | 2 | matrix | 12.315 | 841,315 | 1,092,242 | 1.2983× | 1.2992× | 99.93% |
| up_proj | 8 | **3** | matrix | 11.194 | 764,981 | 1,092,242 | **1.4278×** | 1.4293× | 99.90% |
| up_proj | 8 | 3 | tile | 11.303 | 772,373 | 1,092,242 | 1.4141× | 1.4156× | 99.89% |
| up_proj | 8 | 4 | matrix | 12.002 | 820,007 | 1,092,242 | 1.3320× | 1.3331× | 99.92% |
| up_proj | 16 | 3 | matrix | 11.194 | 382,552 | 546,226 | 1.4278× | 1.4293× | 99.90% |

Reading:
- Every point runs within 0.15% of its own ceiling, so the hardware is never
  the limit: the speedup is set by the format's bits/weight alone, at every
  lane count (4, 8, 16) and code width.
- 3-bit codes are the best width, as Phase 1 predicted from entropy: 2-bit
  (3 codes) escapes 39% of q_proj's weights against 5.5% at 3-bit, and 4-bit spends a bit on
  every weight to save a few hundred escapes.
- Per-tile bases help q_proj (+0.4%, its exponents drift across the matrix)
  and lose on up_proj (−1.0%, the 8-bit base per 64 weights costs more than it
  saves). Per-matrix stays the default.
- Escape stalls are rare even here (≤ 1,861 cycles, at 2-bit on q_proj); the
  data stalls are memory bandwidth, which is the point of the run.
- L = 4 needed one RTL fix first: `gemv_core` shifted its x register with
  `xs[16*L-1:64]`, an empty slice when one beat is the whole word. Now a
  generate branch (`g_x1` / `g_xn`); L = 8 and 16 elaborate the same logic.

## Open (to do)

Done: Phase 1, golden vs. PyTorch, GPU kernels on the 3060 Laptop, real-weight
layer through the RTL (layer 21, both modes), 10,000 seeds, whole-model GPU
demo. Dropped: RTX 3080 rerun (2026-10-31, Rayan; the 3060 Laptop is the GPU
baseline).

Done 2026-10-31 (entries above): bandwidth-bound real layer (1.4246×, 99.9%
of ceiling); decoder layout, gate-level sim of the routed netlist, power from
real switching, energy per token; fused kernels in the whole-model demo;
functional coverage (541/541 with L = 4); design-space sweep in simulation.

Running / queued (WSL, one layout at a time):
1. Engine layout (`openlane/run.sh engine`, ew_top with KMAX = 896).
2. Decoder layouts for the sweep points (`openlane/sweep.sh`): area, Fmax and
   power per (L, code bits, base), to go beside the cycle table.

Not doing, and why:
- cocotb under Verilator: the regression runs on Icarus on Windows; Verilator
  lint is clean (entry above). Revisit on Linux if sim time matters.
- SRAM macros (OpenRAM): only needed if a layout is congestion-bound; the
  decoder routed clean at 40% utilization.
- Nsight Compute on `gemv_ew`: needs GPU performance counters enabled in the
  NVIDIA Control Panel (Rayan's call; admin setting).
- Vivado synth/impl/power: license tier doesn't cover 2026.1.1; Yosys
  estimates in `fpga/yosys/` and the SKY130 numbers stand in.
- RTX 3080 rerun: dropped (the 3060 Laptop is the GPU baseline).

Later (FPGA access, not soon): on-board GEMV throughput, achieved DRAM
bandwidth and board power; the ARCH §2.1 bandwidth table from datasheets.
