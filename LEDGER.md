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

## Open — home PC

1. ~~Phase 1~~ done. ~~golden vs. PyTorch~~ done. ~~GPU kernels~~ written
   and measured on the 3060 Laptop.
2. Real-weight layer through the RTL: `tb/test_real.py` (results below
   when the run finishes).
3. 10,000 random seeds (running on the laptop; rerun at home if the reset
   interrupts it); Verilator build; coverage report.
4. RTX 3080: `gpu/build.bat`, `python gpu/prep.py`, `gpu/build/ewgemv.exe gpu/data`;
   Nsight Compute on `gemv_ew` to see what it's bound by.
5. Vivado synth/impl/power, datasheet numbers for ARCH §2.1.
