"""energy.py — weight-streaming energy per token, raw BF16 vs. exponent window.

    python analysis/energy.py      -> analysis/energy.txt

Batch-1 decode reads every weight matrix once per token: the 168 linear
layers plus the tied LM head (the embedding lookup reads one row, ~0).
That's all 493,961,216 weights of Qwen2.5-0.5B (Phase 1).

Energy counted: DRAM reads of the weight stream + the decoder's own logic.
Everything else (multipliers, adders, x/y traffic, control) is identical in
both modes and left out, so this is the weight-path difference, not a
whole-chip number.

Inputs, with their tags:
  bits/weight      11.225               [measured] Phase 1, analysis/results.csv
  decoder power    3.53 mW @ 50 MHz     [estimate] SKY130 tt, routed netlist, switching
                                         from the real-weight gate-level run (gl/power_report.txt)
  decoder rate     0.9997 chunks/cycle  [sim] same run, 8 weights per chunk
  DRAM energy      HBM2 3.97 pJ/bit, GDDR5 14.0 pJ/bit  [cited] O'Connor et al.,
                   "Fine-Grained DRAM", MICRO-50 2017, §1 and Fig. 1a

The decoder figure is a 130 nm, 1.8 V library: a modern node would spend
far less per weight, so the net saving below is conservative.
"""

from pathlib import Path

WEIGHTS_PER_TOKEN = 493_961_216
BITS_RAW, BITS_EW = 16.0, 11.225
DEC_POWER_W, F_HZ, LANES, RATE = 3.53e-3, 50e6, 8, 0.9997
DRAM = {"HBM2 (3.97 pJ/bit)": 3.97, "GDDR5 (14.0 pJ/bit)": 14.0}

dec_pj = DEC_POWER_W / (F_HZ * LANES * RATE) * 1e12          # pJ per decoded weight
out = [__doc__.split("Inputs")[0].strip(), "",
       f"decoder energy: {dec_pj:.2f} pJ/weight [estimate, SKY130 tt]", ""]
out.append(f"{'memory':22s}{'raw pJ/w':>10s}{'ew pJ/w':>10s}{'saving':>9s}"
           f"{'raw mJ/tok':>12s}{'ew mJ/tok':>11s}")
for name, e in DRAM.items():
    raw = BITS_RAW * e
    ew = BITS_EW * e + dec_pj
    out.append(f"{name:22s}{raw:10.2f}{ew:10.2f}{1 - ew / raw:9.1%}"
               f"{raw * WEIGHTS_PER_TOKEN * 1e-9:12.2f}{ew * WEIGHTS_PER_TOKEN * 1e-9:11.2f}")
out.append("")
out.append("Break-even: the decoder pays for itself when DRAM costs more than "
           f"{dec_pj / (BITS_RAW - BITS_EW):.2f} pJ/bit (decoder pJ / bits saved).")
txt = "\n".join(out) + "\n"
(Path(__file__).resolve().parent / "energy.txt").write_text(txt, encoding="utf-8")
print(txt)
