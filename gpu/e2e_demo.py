"""e2e_demo.py — the whole Qwen2.5-0.5B, weights kept compressed in GPU memory.

    python gpu/e2e_demo.py stock     unmodified Hugging Face model, BF16 weights
    python gpu/e2e_demo.py ew        every weight matrix stored in the
                                     exponent-window format in VRAM and decoded
                                     on the GPU each time it's used
    python gpu/e2e_demo.py compare   reads both result files, prints the table

(needs a CUDA build of PyTorch + transformers; the model in analysis/weights.)

This proves the FORMAT on real hardware: same tokens and bit-identical
logits from ~70% of the weight memory. It is not the custom chip: decoding
here is ordinary PyTorch tensor ops on the GPU, unfused and slow. The chip's
speed comes from the RTL simulations (LEDGER.md).

What stays BF16 in both modes: norms and the q/k/v biases (0.03% of the
parameters). Every 2-D weight matrix is compressed, the tied embedding /
LM head included (stored once, used by both).

Bit-exactness of the matmuls: each compressed linear layer decodes its whole
matrix into a scratch buffer before F.linear, so cuBLAS sees exactly the
shapes the stock model gives it. The LM head (151936 rows) is decoded the same
way by default, into a 272 MB scratch buffer. --lm-rows N instead decodes it
in N-row slices with one matmul each (no big scratch buffer); tokens still
match, but cuBLAS sums differently for the smaller shapes, so the logits
are not bit-identical (measured: e2e_ew_sliced.json).
"""

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

REPO = Path(__file__).resolve().parent.parent
WEIGHTS = REPO / "analysis" / "weights"
OUT = REPO / "gpu" / "results"
sys.path.insert(0, str(REPO / "sw"))
from ewformat import TILE, encode  # noqa: E402

PROMPTS = [
    "The capital of France is",
    "def fibonacci(n):",
    "In a lossless compression scheme, the decoder must",
]
NEW_TOKENS = 64
CODE_BITS = 3


# ------------------------------------------------------------------ encoding
def encode_matrix(w: torch.Tensor, chunk_rows: int = 4096) -> dict:
    """BF16 (rows, cols) -> exponent-window streams, encoded in row chunks
    (the embedding has 136M weights) with one per-matrix window."""
    u = w.contiguous().view(torch.int16).numpy().view(np.uint16)
    rows, cols = u.shape
    assert cols % TILE == 0 and chunk_rows % 8 == 0
    hist = np.zeros(256, np.int64)
    for r in range(0, rows, chunk_rows):
        hist += np.bincount(((u[r:r + chunk_rows] >> 7) & 0xFF).reshape(-1), minlength=256)
    width = (1 << CODE_BITS) - 1
    cs = np.concatenate([[0], np.cumsum(hist)])
    e_star = int(np.argmax(cs[width:] - cs[:-width]))          # same rule as best_window
    code, sm, esc, row_esc = [], [], [], np.zeros(rows, np.int64)
    n_esc = 0
    for r in range(0, rows, chunk_rows):
        blk = u[r:r + chunk_rows]
        e = encode(blk, CODE_BITS, force_e_star=e_star)
        code.append(e.code[: (e.n // TILE) * CODE_BITS * 8])
        sm.append(e.sm[: e.n])
        esc.append(e.esc[: e.n_esc])
        per_row = (((blk >> 7) & 0xFF).astype(np.int64) - e_star) % 256 >= width
        row_esc[r:r + len(blk)] = n_esc + np.concatenate([[0], np.cumsum(per_row.sum(1))[:-1]])
        n_esc += e.n_esc
    planes = np.concatenate(code).view("<i8").reshape(-1, CODE_BITS)
    return {"rows": rows, "cols": cols, "base": (e_star - 1) % 256,
            "planes": torch.from_numpy(planes.copy()),
            "sm": torch.from_numpy(np.concatenate(sm)),
            "esc": torch.from_numpy(np.concatenate(esc)),
            "row_esc": torch.from_numpy(row_esc.astype(np.int32))}


class EWStore(nn.Module):
    """One compressed matrix in VRAM plus a GPU decoder for any set of rows."""

    def __init__(self, enc: dict):
        super().__init__()
        self.rows, self.cols, self.base = enc["rows"], enc["cols"], enc["base"]
        for k in ("planes", "sm", "esc", "row_esc"):
            self.register_buffer(k, enc[k])

    def nbytes(self) -> int:
        return sum(b.numel() * b.element_size() for b in (self.planes, self.sm, self.esc, self.row_esc))

    def decode_rows(self, r: torch.Tensor) -> torch.Tensor:
        """r: 1-D int64 row indices on the GPU -> (len(r), cols) BF16."""
        dev, tpr = self.sm.device, self.cols // TILE
        t = (r[:, None] * tpr + torch.arange(tpr, device=dev)).reshape(-1)
        pl = self.planes[t]                                            # (n_tiles, 3)
        sh = torch.arange(TILE, device=dev)
        code = torch.zeros(pl.shape[0], TILE, dtype=torch.int64, device=dev)
        for p in range(CODE_BITS):
            code |= ((pl[:, p, None] >> sh) & 1) << p
        code = code.reshape(len(r), self.cols)
        esc_m = code == 0
        rank = torch.cumsum(esc_m, dim=1) - 1 + self.row_esc[r].long()[:, None]
        exp = (self.base + code) & 0xFF
        exp = torch.where(esc_m, self.esc[rank.clamp(min=0)].long(), exp)
        sm = self.sm[(r[:, None] * self.cols + torch.arange(self.cols, device=dev))].long()
        w = ((sm >> 7) << 15) | (exp << 7) | (sm & 0x7F)
        w = torch.where(w >= 32768, w - 65536, w).to(torch.int16)
        return w.view(torch.bfloat16)

    def decode_all(self, slice_rows: int = 1024) -> torch.Tensor:
        out = torch.empty(self.rows, self.cols, dtype=torch.bfloat16, device=self.sm.device)
        for r0 in range(0, self.rows, slice_rows):
            r = torch.arange(r0, min(r0 + slice_rows, self.rows), device=self.sm.device)
            out[r0:r0 + len(r)] = self.decode_rows(r)
        return out


class EWLinear(nn.Module):
    def __init__(self, store: EWStore, bias, slice_rows: int | None = None):
        super().__init__()
        self.store, self.slice_rows = store, slice_rows
        self.bias = bias

    def forward(self, x):
        s = self.store
        if self.slice_rows is None:                                    # same shape as stock
            return F.linear(x, s.decode_all(), self.bias)
        outs = []
        for r0 in range(0, s.rows, self.slice_rows):
            r = torch.arange(r0, min(r0 + self.slice_rows, s.rows), device=x.device)
            outs.append(F.linear(x, s.decode_rows(r)))
        return torch.cat(outs, dim=-1)


class EWEmbedding(nn.Module):
    def __init__(self, store: EWStore):
        super().__init__()
        self.store = store

    def forward(self, ids):
        u, inv = torch.unique(ids.reshape(-1), return_inverse=True)
        return self.store.decode_rows(u)[inv].reshape(*ids.shape, self.store.cols)


# ------------------------------------------------------------------ helpers
def load_model():
    from transformers import AutoModelForCausalLM
    return AutoModelForCausalLM.from_pretrained(WEIGHTS, torch_dtype=torch.bfloat16,
                                                attn_implementation="eager").eval()


def matrices(model):
    """Every distinct 2-D weight: (name, parent module, attribute, tensor)."""
    seen, out = set(), []
    for name, mod in model.named_modules():
        if isinstance(mod, (nn.Linear, nn.Embedding)) and id(mod.weight) not in seen:
            seen.add(id(mod.weight))
            out.append((name, mod))
    return out


def compress(model, lm_rows):
    """Replace every Linear/Embedding with its compressed version. Returns
    (stores, originals on the CPU for the bit-exact check)."""
    stores, originals = {}, {}
    emb = model.model.embed_tokens
    tied = model.lm_head.weight is emb.weight
    for name, mod in matrices(model):
        originals[name] = mod.weight.detach().clone()
        stores[name] = EWStore(encode_matrix(mod.weight.detach()))
        print(f"  encoded {name:40s} {tuple(mod.weight.shape)}", flush=True)
    for name, mod in list(model.named_modules()):
        for child_name, child in list(mod.named_children()):
            full = f"{name}.{child_name}" if name else child_name
            if isinstance(child, nn.Embedding):
                setattr(mod, child_name, EWEmbedding(stores[full]))
            elif isinstance(child, nn.Linear):
                key = "model.embed_tokens" if (tied and full == "lm_head") else full
                setattr(mod, child_name, EWLinear(stores[key], child.bias,
                                                  slice_rows=lm_rows if full == "lm_head" else None))
    return stores, originals


def run(mode, lm_rows):
    torch.use_deterministic_algorithms(True, warn_only=True)
    from transformers import PreTrainedTokenizerFast
    tok = PreTrainedTokenizerFast(tokenizer_file=str(WEIGHTS / "tokenizer.json"))
    model = load_model()
    bf16_bytes = sum(m.weight.numel() * 2 for _, m in matrices(model))
    lossless = None
    if mode == "ew":
        t0 = time.time()
        stores, originals = compress(model, lm_rows)
        print(f"encoded in {time.time() - t0:.0f} s", flush=True)
    torch.cuda.reset_peak_memory_stats()
    model = model.cuda()
    torch.cuda.synchronize()
    resident = torch.cuda.memory_allocated()
    weight_bytes = bf16_bytes
    if mode == "ew":
        weight_bytes = sum(s.nbytes() for s in stores.values())
        lossless = {}
        for name, s in stores.items():                                 # decoded on the GPU
            lossless[name] = bool(torch.equal(s.decode_all().cpu().view(torch.int16),
                                              originals[name].view(torch.int16)))
        del originals
        torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()

    results = []
    t_gen = 0.0
    for p in PROMPTS:
        ids = tok(p, return_tensors="pt").input_ids.cuda()
        torch.cuda.synchronize()
        t0 = time.time()
        with torch.no_grad():
            g = model.generate(ids, max_new_tokens=NEW_TOKENS, do_sample=False, min_new_tokens=NEW_TOKENS,
                               return_dict_in_generate=True, output_logits=True,
                               pad_token_id=tok.convert_tokens_to_ids("<|endoftext|>"))
        torch.cuda.synchronize()
        t_gen += time.time() - t0
        logits = torch.stack(g.logits).to(torch.bfloat16).cpu().contiguous()
        new = g.sequences[0, ids.shape[1]:].tolist()
        results.append({"prompt": p, "tokens": new, "text": tok.decode(new),
                        "logits_sha256": hashlib.sha256(logits.view(torch.int16).numpy().tobytes()).hexdigest()})
        print(f"  {p!r} -> {tok.decode(new)[:70]!r}", flush=True)

    out = {"mode": mode, "gpu": torch.cuda.get_device_name(0), "torch": torch.__version__,
           "weight_matrices": len(matrices(model)) if mode == "stock" else len(stores),
           "weight_bytes_bf16": bf16_bytes, "weight_bytes_stored": weight_bytes,
           "resident_after_load": resident, "peak_during_generation": torch.cuda.max_memory_allocated(),
           "tokens_per_s": len(PROMPTS) * NEW_TOKENS / t_gen, "lm_rows": lm_rows if mode == "ew" else None,
           "lossless_all": (all(lossless.values()) if lossless is not None else None),
           "lossless_failures": ([k for k, v in lossless.items() if not v] if lossless else []),
           "results": results}
    OUT.mkdir(exist_ok=True)
    tag = "ew_sliced" if (mode == "ew" and lm_rows) else mode
    (OUT / f"e2e_{tag}.json").write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps({k: v for k, v in out.items() if k != "results"}, indent=1))


def compare():
    s = json.loads((OUT / "e2e_stock.json").read_text())
    e = json.loads((OUT / "e2e_ew.json").read_text())
    mb = lambda b: f"{b / 2**20:8.1f} MiB"
    lines = [f"Qwen2.5-0.5B end to end on {s['gpu']} (torch {s['torch']}) [measured]", ""]
    lines.append(f"{'':34s}{'stock BF16':>16s}{'exponent-window':>18s}")
    lines.append(f"{'weight matrices in VRAM':34s}{mb(s['weight_bytes_stored']):>16s}{mb(e['weight_bytes_stored']):>18s}"
                 f"   {s['weight_bytes_stored'] / e['weight_bytes_stored']:.3f}x smaller "
                 f"({8 * e['weight_bytes_stored'] / (s['weight_bytes_bf16'] / 2):.3f} bits/weight)")
    lines.append(f"{'all GPU memory after load':34s}{mb(s['resident_after_load']):>16s}{mb(e['resident_after_load']):>18s}")
    lines.append(f"{'peak GPU memory, generating':34s}{mb(s['peak_during_generation']):>16s}{mb(e['peak_during_generation']):>18s}")
    lines.append(f"{'tokens/s (decode not fused: not the chip)':34s}{s['tokens_per_s']:16.1f}{e['tokens_per_s']:18.1f}")
    lines.append("")
    lines.append(f"decoded weights == original, all {e['weight_matrices']} matrices (bitwise, decoded on GPU): {e['lossless_all']}")
    for a, b in zip(s["results"], e["results"]):
        lines.append(f"{a['prompt']!r}: tokens identical {a['tokens'] == b['tokens']}, "
                     f"logits bit-identical {a['logits_sha256'] == b['logits_sha256']}")
    sl = OUT / "e2e_ew_sliced.json"
    if sl.exists():
        x = json.loads(sl.read_text())
        same_tok = all(a["tokens"] == b["tokens"] for a, b in zip(s["results"], x["results"]))
        same_log = all(a["logits_sha256"] == b["logits_sha256"] for a, b in zip(s["results"], x["results"]))
        lines.append("")
        lines.append(f"variant: LM head decoded in {x['lm_rows']}-row slices (no 272 MB scratch): peak "
                     f"{mb(x['peak_during_generation']).strip()}, tokens identical {same_tok}, logits bit-identical {same_log}")
    txt = "\n".join(lines) + "\n"
    (OUT / "e2e_rtx3060-laptop.txt").write_text(txt)
    print(txt)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["stock", "ew", "compare"])
    ap.add_argument("--lm-rows", type=int, default=0, help="0 = decode the LM head whole")
    a = ap.parse_args()
    compare() if a.mode == "compare" else run(a.mode, a.lm_rows or None)
