"""Brief §2: how far the hardware's arithmetic (sw/golden.py, L = 8) is from
PyTorch on real Qwen2.5-0.5B layers. Same BF16 weights and x; reported per
matrix as max abs difference and max ULP (FP32) vs. torch FP32 matmul, and
max abs vs. torch BF16 matmul (which also rounds y to BF16).

    python analysis/golden_vs_torch.py [--layers 12 21]
"""
import argparse
import sys
from pathlib import Path

import numpy as np
import torch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "sw"))
sys.path.insert(0, str(HERE))
import golden  # noqa: E402
from ewformat import synthetic_bf16  # noqa: E402
from measure import bf16_tensors  # noqa: E402

PROJ = ["self_attn.q_proj", "self_attn.k_proj", "self_attn.v_proj", "self_attn.o_proj",
        "mlp.gate_proj", "mlp.up_proj", "mlp.down_proj"]


def t16(a):
    return torch.from_numpy(a.astype(np.int16)).view(torch.bfloat16)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--layers", type=int, nargs="+", default=[12, 21])
    ap.add_argument("--dir", default=str(HERE / "weights"))
    a = ap.parse_args()
    want = {f"model.layers.{n}.{p}.weight" for n in a.layers for p in PROJ}
    mats = {}
    for f in sorted(Path(a.dir).glob("*.safetensors")):
        for name, w in bf16_tensors(f):
            if name in want:
                mats[name] = np.array(w)
    rng = np.random.default_rng(0)
    worst = [0.0, 0, 0.0]
    print(f"{'matrix':42} {'max abs vs fp32':>16} {'max ULP':>8} {'max abs vs bf16':>16}")
    for name in sorted(mats, key=lambda s: (int(s.split('.')[2]), PROJ.index(s.split('.', 3)[3][:-7]))):
        w = mats[name]
        x = synthetic_bf16(1, w.shape[1], rng, std=1.0)[0]
        g = golden.gemv(w, x, 8)
        tw, tx = t16(w), t16(x)
        f32 = (tw.float() @ tx.float()).numpy()
        b16 = (tw @ tx).float().numpy()
        d32 = float(np.abs(g - f32).max())
        ulp = int(golden.ulp_diff(g, f32).max())
        d16 = float(np.abs(g - b16).max())
        worst = [max(worst[0], d32), max(worst[1], ulp), max(worst[2], d16)]
        print(f"{name:42} {d32:16.3e} {ulp:8d} {d16:16.3e}")
    print(f"{'worst':42} {worst[0]:16.3e} {worst[1]:8d} {worst[2]:16.3e}")


if __name__ == "__main__":
    main()
