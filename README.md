# ew-decoder — exponent-window lossless BF16 weight decoder

A GEMV engine whose weight path decodes a ~11-bit lossless format back to
exact BF16 on the fly, so a memory-bound LLM decode step reads ~30% fewer
bytes per token, with the model bit-identical. Controlled by our own RISC-V
core through custom-0 instructions. The format is ZipServ's (TCA-TBE); the
contribution is the hardware decoder, the ISA interface, and hardware-only
variants (per-tile bases, other window widths). Full spec: `BRIEF.md`.
Design: `docs/ARCH.md`. Every decision and number: `LEDGER.md`.

**Status (2026-10-30):** engine RTL + CPU integration built and verified in
simulation on synthetic weights. Nothing measured on real weights or
hardware yet; that's the home-PC list below.

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
```

`sim_build/top_l8_b3*/perf.txt` hold the simulated decoded-vs-raw cycle
counts (labeled [sim, synthetic] in LEDGER.md).

## Home PC — what's left

1. **Phase 1** — `python analysis/measure.py`; write
   `analysis/REPORT_PHASE1.md`; make the Gate 1 calls in LEDGER.md
   (code width, per-tile vs. per-matrix, escape encoding, bypass list).
   If coverage is < 90% anywhere or escape bursts exceed the FIFO, stop
   and rethink before going on (brief rule).
2. **Real weights through the RTL** — one Qwen2.5-0.5B layer, all 7
   projections, decoded and bypass (`Image.add_job` takes any uint16 array).
3. **10,000 seeds**, a **Verilator** build, functional coverage.
4. **golden.py vs. PyTorch BF16** matmul on real layers (max abs / ULP).
5. **RTX 3080 baseline** — raw-BF16 GEMV vs. exponent-window decode GEMV
   kernels, same matrices; report GB/s and tokens/s per GB/s.
6. **Vivado** synth/impl/power (decoder alone + full pipeline, Fmax),
   board datasheet numbers into ARCH §2.1 (with document + revision).
