# LEDGER

Chronological decisions, assumptions, numbers and dead ends (brief: "record
every decision, number and assumption"). Every number is tagged:
**[sim]** cycle-accurate simulation, **[synthetic]** on generated weights,
**[measured]** on real hardware or real model weights, **[assumption]**.
Nothing here is [measured] yet; Phase 1 on the real model is the first.

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

## Open — home PC

1. Phase 1 on Qwen2.5-0.5B (`analysis/measure.py`), then the Gate 1
   decisions above in this file.
2. Real-weight layer through the engine, both modes (brief §5.4).
3. 10,000 random seeds; Verilator build; coverage report.
4. golden.py vs. PyTorch BF16 on real layers (max abs / ULP).
5. RTX 3080 baseline kernels.
6. Vivado synth/impl/power, datasheet numbers for ARCH §2.1.
