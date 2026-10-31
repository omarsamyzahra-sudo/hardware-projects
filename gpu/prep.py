"""Export one Qwen2.5-0.5B decoder layer for the GPU benchmark (ewgemv.cu).

For each of the 7 projections it writes, into gpu/data/:
  NAME.w.bin      raw BF16 weights, row-major (rows x cols uint16)  - baseline
  NAME.code.bin   3 code bit-planes per 64-weight tile               - EW format
  NAME.sm.bin     sign/mantissa byte per weight                      - EW format
  NAME.esc.bin    escaped exponent bytes, in order                   - EW format
  NAME.rowesc.bin uint32 per row: escapes before that row (GPU-only index)
  NAME.x.bin      a BF16 activation vector (synthetic; values don't change timing)
and manifest.txt: name rows cols base n_esc.

The row-escape index is metadata a GPU needs to find its escapes in
parallel; the hardware decoder reads the stream in order and doesn't.
It costs 32/cols bits per weight and is counted in the bits report.

    python gpu/prep.py [--layer 12] [--dir analysis/weights]
"""
import argparse
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "sw"))
sys.path.insert(0, str(HERE.parent / "analysis"))
from ewformat import encode, synthetic_bf16  # noqa: E402
from measure import bf16_tensors  # noqa: E402

PROJ = [("q", "self_attn.q_proj"), ("k", "self_attn.k_proj"), ("v", "self_attn.v_proj"),
        ("o", "self_attn.o_proj"), ("gate", "mlp.gate_proj"), ("up", "mlp.up_proj"),
        ("down", "mlp.down_proj")]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--layer", type=int, default=12)
    ap.add_argument("--dir", default=str(HERE.parent / "analysis" / "weights"))
    ap.add_argument("--out", default=str(HERE / "data"))
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(exist_ok=True)
    want = {f"model.layers.{a.layer}.{p}.weight": n for n, p in PROJ}
    found = {}
    for f in sorted(Path(a.dir).glob("*.safetensors")):
        for name, w in bf16_tensors(f):
            if name in want:
                found[want[name]] = np.array(w)
    assert len(found) == 7, f"missing {set(want.values()) - set(found)}"

    rng = np.random.default_rng(0)
    lines, tot_w, tot_bits = [], 0, 0
    for n, _ in PROJ:
        w = found[n]
        rows, cols = w.shape
        e = encode(w, 3)
        code = e.code[: rows * cols // 64 * 24]
        planes = code.reshape(-1, 3, 8)
        bits = np.stack([np.unpackbits(planes[:, p], axis=1, bitorder="little") for p in range(3)])
        c = bits[0] | (bits[1] << 1) | (bits[2] << 2)
        per_row = (c.reshape(rows, cols) == 0).sum(axis=1)
        rowesc = np.concatenate([[0], np.cumsum(per_row)[:-1]]).astype(np.uint32)
        w.astype("<u2").tofile(out / f"{n}.w.bin")
        code.tofile(out / f"{n}.code.bin")
        e.sm[: rows * cols].tofile(out / f"{n}.sm.bin")
        np.concatenate([e.esc[: e.n_esc], np.zeros(8, np.uint8)]).tofile(out / f"{n}.esc.bin")
        rowesc.tofile(out / f"{n}.rowesc.bin")
        synthetic_bf16(1, cols, rng, std=1.0)[0].astype("<u2").tofile(out / f"{n}.x.bin")
        lines.append(f"{n} {rows} {cols} {e.base} {e.n_esc}")
        b = e.bits_per_weight() + 32 / cols
        tot_w += rows * cols
        tot_bits += b * rows * cols
        print(f"{n:5} {rows:5}x{cols:<5} base {e.base:3}  escapes {e.n_esc / (rows * cols):6.2%}  "
              f"bits {e.bits_per_weight():.3f} (+row index {32 / cols:.3f})")
    (out / "manifest.txt").write_text("\n".join(lines) + "\n")
    print(f"layer {a.layer}: {tot_w} weights, {tot_bits / tot_w:.3f} bits/weight incl. GPU row index")


if __name__ == "__main__":
    main()
