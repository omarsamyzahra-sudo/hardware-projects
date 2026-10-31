# Hardware Design Brief: Exponent-Window Lossless BF16 Weight Decoder for Memory-Bound LLM Inference

You are the hardware design agent for a research project on memory-bound LLM inference. Your job is to design, implement, verify and characterize an FPGA accelerator whose weight path stores BF16 model weights in an **exponent-window format** — a 3-bit exponent code + raw 8-bit sign/mantissa per weight, with an escape path for out-of-window exponents — and decodes them bit-exactly, on the fly, straight into a BF16 compute pipeline.

Work through the phases below in order. Do not skip a gate. Record every decision, number and assumption in `LEDGER.md` as you go.

---

## 0. Context (read first)

**Thesis.** Single-batch LLM decode is memory-bandwidth-bound: every weight is read from DRAM once per token. Fewer bits per weight → proportionally more tokens/sec at fixed bandwidth, and fewer DRAM joules per token. A lossless format guarantees the model is bit-identical — no accuracy trade-off.

**Why the exponent is the target.** BF16 = 1 sign, 8 exponent, 7 mantissa bits; value = (−1)^s × 2^(e−127) × 1.m. In trained LLMs the weights are small and roughly Gaussian, so only a handful of exponents (magnitudes) occur: the exponent field carries ~2.6 bits of entropy in 8 bits of storage, while sign and mantissa are near-uniform and near-incompressible. Lossless floor ≈ 10.6 bits/weight. (DFloat11, arXiv:2504.11651; ZipServ, arXiv:2603.17435)

**The scheme under test.**
- Per weight matrix: pick the 7 most-covering **contiguous** exponents [e*, e*+6]; set `base = e* − 1`.
- Each weight stores a **3-bit code** c and its raw **8-bit sign+mantissa**:
  - c ∈ 1..7 → exponent = base + c (decode is one 8-bit add).
  - c = 0 → **escape**: the weight's real 8-bit exponent is the next byte in an in-order **escape side stream**. The escape marks the position, so no index metadata is needed.
- Cost ≈ 3 + 8 + 8 × escape_rate ≈ 11.3 bits/weight at ~96% window coverage. This matches ZipServ's published cost model (they store fallback weights as full BF16 instead of exponent-only; both give the same average — evaluate both, see §3.1).
- Decoded weight = `{sign, base + c (or escape byte), mantissa}` — bit-identical to the original.

**Facts to cite, not re-derive:**
- Top-7 exponents cover >95% of weights in Llama-3, Mistral, Qwen2.5; in 99.6% of 3,875 matrices the top-7 are contiguous, and a contiguous window covers 97.1% on average. ZipServ proves contiguity follows from unimodality of the exponent distribution under Gaussian weights. (ZipServ, ASPLOS '26)
- ZipServ's GPU implementation achieves ~11.3 bits/weight, ~1.31–1.36× average kernel speedup over cuBLAS on consumer/inference GPUs, at the cost of ~66% ALU utilization spent on software decode.

**Prior art — do not claim novelty for the format.** The format is ZipServ's TCA-TBE idea (base + offset, fixed-length code, fallback). Related hardware: Huff-LLM (arXiv:2502.00922, Huffman decode in systolic arrays, <6% area, up to 31% latency / 26% energy savings in simulation), LEXI (arXiv:2603.15589, exponent-only hardware codec, 0.09% area in GF22), DECA (MICRO '25, near-core decompression accelerator), Liguori/Ocean Logic (~200-LUT lossless BF16 decoder on AMD FPGAs).

**This project's contribution:** (1) a fixed-function hardware implementation of the exponent-window decoder fused into the weight path of an FPGA GEMV engine, with measured efficiency per unit bandwidth and per joule vs. an otherwise identical uncompressed pipeline; (2) a custom RISC-V instruction interface for it; (3) an evaluation of format variants a dedicated decoder makes cheap but a GPU does not (per-tile base exponents, wider/narrower windows — §7); (4) a clean hook for later stacking with codebook/sparsity compression.

**Target hardware (verify every number from official datasheets; do not rely on memory):**
- Primary: AMD Kria KV260 (Zynq UltraScale+ ZU5EV). Record exact BRAM36, URAM, DSP counts and achievable DDR4 bandwidth from the PL.
- Secondary: Digilent Arty A7-100T (Artix-7). Record BRAM36, DSP counts and DDR3 bandwidth.
- Toolchain: Vivado (synthesis/implementation/power), Verilator + cocotb (simulation), Python 3 + PyTorch + safetensors (golden models, preprocessing).

**Test model:** Qwen2.5-0.5B (BF16 safetensors, Hugging Face). All 2-D linear-layer weight matrices.

### 0.4 Success metrics (report all, vs. the uncompressed baseline pipeline)
1. Effective bits/weight (measured, including escape stream and per-matrix/per-tile metadata).
2. Bit-exactness: decoded weights == original BF16 bit patterns for 100% of model weights.
3. Tokens/sec per GB/s of DRAM bandwidth (decode, batch 1) — measured on a GEMV workload representative of one decoder layer, extrapolated to the full model with the method stated.
4. Energy per token (Vivado power estimate + DRAM energy model with stated pJ/bit).
5. Decoder resource cost (LUT, FF, BRAM, DSP) alone and as % of the full pipeline.
6. Fmax after place-and-route; confirm the decoder is not on the critical path.

Absolute throughput is NOT a metric; efficiency per unit bandwidth and per joule is. Expected ceiling: speedup ≤ 16 / effective_bits ≈ 1.42× at batch 1. A result near that ceiling with negligible decoder area is the success case.

---

## Phase 1 — Software measurement (GATE 1: no RTL until done)

Write `analysis/measure.py`. For every 2-D BF16 matrix compute and save to `analysis/results.csv`:
- `n_weights`, exponent histogram, exponent entropy, full 16-bit entropy
- Best contiguous window for widths k = 3, 7, 15 (code widths 2, 3, 4 bits) and its coverage `cov_k`
- `bits_k` = code_bits + 8 + 8 × (1 − cov_k) (exponent-only escape) and the ZipServ variant code_bits + 8 × cov_k + 16 × (1 − cov_k)
- **Per-tile base variant:** for tile sizes 64, 256, 1024 weights, choose a per-tile best window; report coverage and bits including per-tile base cost (8 bits/tile)
- **Escape burstiness:** max escapes in any window of N consecutive weights in stream order (N = 16, 64, 256) — needed for FIFO sizing in §3

Write `analysis/REPORT_PHASE1.md`: per-matrix table, model-wide weighted averages, comparison vs. entropy floor (10.6) and 16, histograms, and the chosen configuration.

**Gate 1 decision (record in LEDGER.md):**
- Default: 3-bit code, per-matrix base. Switch to per-tile base only if it lowers model-wide bits by ≥0.1 bit/weight after metadata.
- Choose escape encoding (exponent-byte vs. full BF16 fallback) by lower measured bits; tie → exponent-byte (simpler, fixed 8-bit sign/mantissa stream).
- If any matrix has model-wide coverage < 90%, flag it and report why (embeddings/LM head/norm-adjacent layers are the usual suspects); decide whether those matrices go through the decoder or a raw-BF16 bypass.

---

## Phase 2 — Encoder + bit-accurate golden model

1. `sw/encode.py`: per matrix, produce the DRAM format (define tile order in §3 first, then match it here):
   - Header: dims, base exponent(s), window width, tile size, escape count, layout ID.
   - **Code stream:** 3-bit codes stored as **three bit-planes per 64-weight tile** (three aligned 64-bit words per tile, ZipServ-style) — no codes straddle word boundaries.
   - **Sign/mantissa stream:** one byte per weight, byte-aligned.
   - **Escape stream:** one exponent byte per escaped weight, in stream order.
2. `sw/golden.py`: bit-accurate model of the **hardware's own arithmetic**: decode → BF16 × BF16 → FP32 accumulate in the exact order the RTL uses. This is the bit-for-bit reference for the RTL.
3. Roundtrip: `decode(encode(W)) == W` bitwise for every matrix in the model. Must be 100%.

In LEDGER.md, separate (a) **lossless storage** (guaranteed by the format) from (b) **identical outputs** (requires matching accumulation order/precision). The project claims (a) unconditionally and (b) relative to `golden.py`. Report max abs / ULP difference between `golden.py` and PyTorch BF16 matmul on real layers.

---

## Phase 3 — Architecture specification (write `docs/ARCH.md` before any RTL)

Block diagrams and cycle-level timing for:

**3.1 Weight path**
- Three AXI read streams (code planes, sign/mantissa bytes, escape bytes) → per-stream FIFOs. Decide whether to interleave streams in one DRAM region per tile (fewer, longer bursts) or keep them separate; justify with burst efficiency.
- **Decoder lane** (replicated L times): read 3-bit code from the three plane words; if c ≠ 0, exponent = base + c; if c = 0, pop escape FIFO; concatenate {sign, exponent, mantissa}. Target: purely combinational or 1-stage, a few dozen LUTs per lane, zero BRAM.
- **Escape distribution across lanes:** within a cycle, multiple lanes may escape. Use a prefix-popcount over the lane escape mask to assign escape-FIFO slots (one cycle), so the escape FIFO must deliver up to L bytes/cycle worst case — or stall. Size FIFO depth and per-cycle read width from Phase 1 burstiness data; specify stall behavior and show average-case stalls ≈ 0.
- Base exponent register(s), loaded per matrix (or per tile, if Gate 1 chose it).

**3.2 Compute path**
- Decode-phase GEMV y = W·x with x held on-chip in BRAM.
- L parallel BF16 multipliers → FP32 accumulation (adder tree + accumulators). Decide DSP mapping and pipeline depth.
- **Bandwidth matching:** choose L so L × effective_bits × f_clk ≈ achievable DRAM bandwidth. Show the calculation for both boards. Correct design = MAC array never starved and never the bottleneck at batch 1.

**3.3 Baseline pipeline (required)**
- Identical AXI, compute, and control, with weights streamed as raw BF16 (decoder bypassed). Every speedup/energy claim is relative to this.

**3.4 Control: RISC-V core with custom instructions**
- Use an open soft core (VexRiscv or PicoRV32; or the Zynq PS ARM cores if a soft core is impractical — justify).
- Custom instructions in `custom-0`/`custom-1` opcode space, fully documented encodings. Minimum set:
  - `EXP.BASE rs1` — load base exponent (and window width) for the next matrix.
  - `WSTREAM.CFG rs1, rs2` — configure code-plane, sign/mantissa, and escape stream base addresses/lengths (may span two instructions or a descriptor in memory).
  - `GEMV.RUN rs1, rs2` — launch GEMV of given dims; `rd` returns a handle.
  - `GEMV.WAIT rd` — block until completion.
  - `DEC.BYPASS rs1` — select decoded vs. raw-BF16 weight path (enables the baseline on the same bitstream).
- Provide a C or assembly driver that runs one full decoder layer's linear projections.

**3.5 Risks to resolve in ARCH.md**
- Escape bursts stalling lanes (size from measured worst case, not average).
- Three-stream DRAM access efficiency (burst length, AXI outstanding transactions) — the escape stream is small and irregular.
- Matrices routed to raw bypass (from Gate 1) and switching cost between modes.
- Confirm the decoder adds no BRAM and is off the critical path; if not, pipeline it.

---

## Phase 4 — RTL implementation

- SystemVerilog, synthesizable, one module per ARCH.md block. Parameterize L, window width (2/3/4-bit code), tile size, FIFO depths, and per-matrix vs. per-tile base.
- Decoded path and raw path share every block except the decoder (fair comparison).
- No vendor IP in decoder blocks; AXI interconnect and DDR controller IP are fine.

---

## Phase 5 — Verification (GATE 2: no characterization until this passes)

Verilator + cocotb:
1. **Unit tests:** decoder lane (all 8 codes, all base values incl. edge exponents 0/255 handling), bit-plane reader, escape prefix-popcount assignment, FIFO stall/resume, FP multiply/accumulate vs. `golden.py`.
2. **Directed corners:** zero escapes, every weight escaped, escapes on all lanes in one cycle, escapes at tile and burst boundaries, back-to-back matrices with different bases, decoder ↔ bypass switching.
3. **Randomized:** random bases, windows, escape positions/densities, dims; ≥10,000 seeds.
4. **Real weights:** every linear matrix of at least one full Qwen2.5-0.5B decoder layer through the full pipeline; outputs match `golden.py` **bit-for-bit**, in both decoded and bypass modes.
5. Functional coverage report; SVA assertions on FIFO overflow/underflow and stream alignment.

Gate 2 = 100% pass.

---

## Phase 6 — Synthesis, implementation, characterization

For each board, decoded vs. raw-baseline:
1. Vivado synth + implementation: utilization (decoder alone, full pipeline), Fmax, power estimate using SAIF/VCD switching activity from the real-weight test (not default toggle rates).
2. On-board measurement if hardware is available: real GEMV throughput and achieved DRAM bandwidth. Otherwise cycle-accurate simulation × Fmax, labeled as simulated.
3. DRAM energy = bytes read × pJ/bit; state value and source.
4. `docs/RESULTS.md` table:

| Metric | Raw BF16 baseline | Exponent window | Ceiling (16/bits) |
|---|---|---|---|
| Effective bits/weight | 16 | | — |
| Decoder LUT / FF / BRAM / DSP | 0 | | — |
| Fmax | | | — |
| Tokens/s per GB/s (batch-1 decode) | | | |
| Energy/token (logic + DRAM) | | | — |
| Bit-exact storage | yes | | — |

Also place ZipServ's published GPU numbers alongside as an external reference (clearly labeled as different hardware), to show what a dedicated decoder buys vs. software decode (expected: similar bandwidth gain, near-zero compute overhead).

---

## Phase 7 — Sweeps (only after Phase 6)

1. Code width: 2 / 3 / 4 bits (window 3 / 7 / 15).
2. Base granularity: per-matrix vs. per-tile (64 / 256 / 1024) — this is where a dedicated decoder may beat ZipServ, since per-tile bases cost a GPU extra instructions but cost hardware one register.
3. Lane count L vs. resources vs. achieved bandwidth.
4. Escape encoding: exponent-byte vs. full-BF16 fallback.
5. **Stacking hook (design only, no full implementation):** document how the decoder would sit downstream of a codebook-index decoder or an N:M sparsity expander in the same memory path, and what interface changes that requires.

---

## Deliverables (repository layout)

```
README.md               — reproduce every number end to end
LEDGER.md               — chronological decisions, assumptions, numbers, dead ends
analysis/               — measure.py, results.csv, REPORT_PHASE1.md, figures
sw/                     — encode.py, golden.py, roundtrip tests, RISC-V driver
docs/ARCH.md            — architecture, timing, budgets, ISA encodings
docs/RESULTS.md         — comparison table, plots, conclusions
rtl/                    — SystemVerilog, one module per block
tb/                     — cocotb tests, coverage
fpga/kv260/, fpga/arty/ — Vivado scripts, utilization, timing, power reports
```

---

## Operating rules

- **Never fabricate a number.** Every figure is measured, simulated (labeled), datasheet-sourced (cited with document + revision), or an explicit assumption (labeled, in LEDGER.md).
- If a result contradicts this brief's expectations (e.g., coverage well below 95% on Qwen2.5-0.5B, or speedup far from the ceiling), report it plainly and diagnose it; do not tune the experiment to confirm the brief.
- Decoded and baseline pipelines must differ only in the decoder.
- **Stop and ask the human** if: a board spec makes the design infeasible as specified; Gate 1 shows coverage or escape burstiness that forces a redesign of the escape path; Gate 2 cannot be passed after reasonable debugging; or a decision would change what the comparison measures.
- Final summary (top of `docs/RESULTS.md`): 5–10 sentences — achieved bits/weight, speedup and energy vs. baseline and vs. the 16/bits ceiling, decoder cost, and whether per-tile bases or other hardware-only variants beat the ZipServ configuration.
