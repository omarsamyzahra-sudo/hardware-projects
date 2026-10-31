# Phase 1 report — exponent-window format on Qwen2.5-0.5B

**Measured** on the real model (Hugging Face `Qwen/Qwen2.5-0.5B`, BF16
safetensors, 2026-10-30): all 170 two-dimensional BF16 matrices, 493,961,216
weights, including the tied embedding (136.1M weights, 27.6% of the model).
`analysis/measure.py` → `analysis/results.csv` (one row per matrix),
`analysis/exp_hist.npy` (exponent histograms), log in `analysis/measure.log`.

## Model-wide (weighted by weights)

| quantity | value |
|---|---|
| exponent entropy | **2.616 bits** (of 8 stored) |
| full 16-bit entropy (empirical, per matrix) | 10.527 bits |
| best contiguous window coverage, k = 3 / **7** / 15 | 72.11% / **97.19%** / 99.97% |
| bits/weight, 2-bit code (k = 3) | 12.232 |
| **bits/weight, 3-bit code (k = 7), exponent-byte escape** | **11.225** |
| bits/weight, 3-bit code, ZipServ full-BF16 fallback | 11.225 |
| bits/weight, 4-bit code (k = 15) | 12.002 |
| per-tile base, tiles of 64 / 256 / 1024 (8 bits/tile included) | 11.316 / 11.236 / 11.219 |
| matrices with k = 7 coverage < 90% | none (lowest: 93.18%, layer 16 q_proj) |
| roundtrip `decode(encode(W)) == W` | 170 / 170 matrices, bit-exact |
| worst escape burst in 16 / 64 / 256 consecutive weights | 16 / 64 / 210 |

Against the brief: 11.225 bits is 0.70 bits above the empirical entropy
floor (10.53; the brief cites ≈ 10.6) and gives a ceiling speedup of
16 / 11.225 = **1.425×**. Coverage 97.19% matches ZipServ's reported 97.1%
average for contiguous windows.

The two escape encodings come out identical, and that's exact, not a
coincidence: b + 8c + 16(1−c) = b + 8 + 8(1−c). They store the same number
of bytes, only arranged differently.

Window position: e* = 116 in 146 matrices, 117 in 18, 115 in 3, 118 in 2,
so the window is [116, 122] (magnitudes from 2^−11 up to 2^−4) almost everywhere.

## By matrix type

| type | matrices | weights (M) | cov k=7 | bits k=7 | bits k=3 | bits k=15 | per-tile 1024 | exp entropy | max burst 16/64/256 |
|---|---|---|---|---|---|---|---|---|---|
| embed_tokens | 1 | 136.1 | 0.9734 | 11.213 | 12.033 | 12.002 | 11.218 | 2.579 | 7/13/27 |
| down_proj | 24 | 104.6 | 0.9731 | 11.215 | 12.253 | 12.002 | 11.213 | 2.629 | 11/30/98 |
| gate_proj | 24 | 104.6 | 0.9706 | 11.235 | 12.334 | 12.002 | 11.222 | 2.617 | 14/48/175 |
| up_proj | 24 | 104.6 | 0.9749 | 11.201 | 12.211 | 12.002 | 11.207 | 2.595 | 16/56/210 |
| o_proj | 24 | 19.3 | 0.9653 | 11.277 | 12.473 | 12.003 | 11.265 | 2.712 | 16/64/143 |
| q_proj | 24 | 19.3 | 0.9547 | 11.362 | 12.753 | 12.003 | 11.254 | 2.784 | 15/49/171 |
| k_proj | 24 | 2.8 | 0.9594 | 11.324 | 12.601 | 12.003 | 11.257 | 2.737 | 12/37/123 |
| v_proj | 24 | 2.8 | 0.9646 | 11.284 | 12.429 | 12.002 | 11.284 | 2.682 | 7/15/37 |

Attention projections (q, k especially) have the widest exponent spread and
benefit most from per-tile bases (q_proj: 11.362 → 11.254, −0.108 bits),
but they're 9% of the weights, so the model-wide gain is 0.006 bits.

## Escape bursts

Average escape rate is 2.8%, but escapes cluster. The worst is layer 21's
up_proj: 210 escapes inside 256 consecutive weights, and runs of 16 escapes
in a row occur in up/o/q/gate projections. For the hardware (ARCH §1.4):
- At L = 8 the escape port supplies 8 bytes per cycle, which is one chunk
  of 8 escapes, so even an all-escape run doesn't stall the lanes. Beyond
  L = 8 an all-escape run slows to 8/L of full speed while it lasts.
- The escape FIFO (64 × 8 B = 512 B) holds more than the worst 256-weight
  burst (210 B), so its depth is fine at the measured burstiness.
- Real-weight check: layer 21, the burstiest layer, ran through the RTL
  (`tb/test_real.py`) bit-exact in both modes; decoded runs within 0.08% of
  one chunk per cycle, so escape stalls are negligible (LEDGER.md).

## Gate 1 decisions (also in LEDGER.md)

1. **3-bit code, per-matrix base.** Per-tile bases gain at most 0.006
   bits/weight model-wide (tiles of 1024), below the brief's 0.1 threshold.
   Tiles of 64 and 256 are worse, because the 8-bit base per tile costs more
   than it saves. Per-tile stays a build option for the Phase 7 sweep.
2. **Exponent-byte escape.** The two encodings tie exactly, and the brief
   says to pick exponent-byte on a tie: it keeps the sign/mantissa stream
   fixed at one byte per weight.
3. **No raw bypass needed for coverage.** Every matrix is ≥ 93.2% covered,
   including the embedding. (The embedding is a lookup, not a GEMV, in
   decode, so it isn't on the weight-streaming path anyway. The tied LM head
   is, and gets the same 11.213 bits.)
4. **The escape path stands as designed:** measured burstiness fits the FIFO
   and the L = 8 escape port. No redesign; the brief's "stop and ask"
   condition is not triggered.
