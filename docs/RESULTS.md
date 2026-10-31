# Results

Every number below has an entry in `LEDGER.md` with the command that made it.
Tags: **[measured]** on real hardware, **[sim]** cycle-accurate or gate-level
simulation, **[estimate]** from layout tools or a model, **[cited]** from a
paper. Model: Qwen2.5-0.5B, BF16, 494M weights.

## The format

| | value | tag |
|---|---|---|
| bits per weight, all 170 matrices | 11.225 (raw: 16) | measured |
| memory saved | 1.425× smaller | measured |
| lossless | 170/170 matrices round-trip bit-exact | measured |
| GPU format (adds a 32-bit escape index per row) | 11.255 bits/weight, 942.2 → 662.7 MiB | measured |

## The engine (RISC-V custom-0 instructions, L = 8 lanes, 3-bit codes)

| | value | tag |
|---|---|---|
| real layer 21, memory at 8 B/cycle (bandwidth-bound) | **1.4246×** faster than raw BF16; ceiling 1.4261× (99.9%) | sim |
| same layer, memory at 16 B/cycle (compute-bound) | within 0.08% of one chunk per cycle | sim |
| design sweep: L 4/8/16, code bits 2/3/4, per-tile bases | every point within 0.15% of its ceiling; 3-bit best | sim |
| correctness | 14/14 real-layer jobs bit-exact, 10,000 random seeds, 541/541 coverage bins (6 builds) | sim |

## The decoder on SKY130 (sky130_fd_sc_hd, LibreLane / OpenROAD)

| | value | tag |
|---|---|---|
| clock, typical / slow / fast corner | ~80 / ~49 / ~95 MHz | estimate |
| area | 6,338 cells, 53,036 µm² (die 329 × 340 µm) | estimate |
| DRC · LVS · antenna | 0 · 0 · 0 | estimate |
| routed netlist on real weights | 14,336/14,336 chunks bit-exact, 0.9997 chunks/cycle | sim |
| power from that run's switching | 3.53 mW @ 50 MHz, 8.83 pJ per decoded weight | estimate |

## Energy per token (weights read once per token at batch 1)

| memory | raw BF16 | exponent window | saving | tag |
|---|---|---|---|---|
| HBM2, 3.97 pJ/bit | 31.38 mJ | 26.37 mJ | 15.9% | estimate + cited |
| GDDR5, 14.0 pJ/bit | 110.65 mJ | 81.99 mJ | 25.9% | estimate + cited |

DRAM energy: O'Connor et al., "Fine-Grained DRAM", MICRO-50, 2017. The
decoder's own energy is included (130 nm, so the savings are conservative).

## On a GPU, decoding in software (RTX 3060 Laptop)

| | value | tag |
|---|---|---|
| whole model from compressed weights, fused kernels | logits bit-identical, tokens identical to stock | measured |
| peak GPU memory while generating | 1,077.7 → 791.9 MiB | measured |
| speed vs. the same kernel on raw BF16 | 0.977× (whole model), 0.971–0.983× (one layer) | measured |
| Nsight, gate_proj: raw kernel | 89% of DRAM peak, 14% SM: memory-bound | measured |
| Nsight, gate_proj: ew kernel | 29% fewer DRAM bytes, 68% DRAM, 78% SM (ALU): compute-bound | measured |

The GPU saves memory but not time: Nsight shows the decode moves the
bottleneck from DRAM to the ALUs, so the instructions cost what the smaller
reads save. That is the case for decoding in hardware next to the MAC array.

**External reference, not our measurement:** ZipServ (whose TCA-TBE format
this one follows) reports 1.31–1.36× on GPUs with a tensor-core
layout. Our kernels are a direct implementation, not tuned toward that.

## Not measured

- On an FPGA or real silicon: no board yet, so no achieved DRAM bandwidth,
  board power or clock. Everything hardware-side is simulation or layout
  estimates.
- Batch > 1, and the KV cache: both read activations that this format does
  not compress, so the end-to-end gain at larger batch is smaller than the
  per-weight number.
