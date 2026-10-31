"""Phase 1 (brief §1): measure the exponent-window format on a real model.

For every 2-D BF16 weight matrix in the safetensors files it writes one row
of analysis/results.csv:

  n_weights, exponent entropy, full 16-bit entropy,
  best contiguous window for k = 3, 7, 15 (code bits 2, 3, 4): e*, coverage,
  bits/weight with exponent-byte escapes and with ZipServ's full-BF16 fallback,
  per-tile base windows (tiles of 64 / 256 / 1024) with 8 bits/tile included,
  escape burstiness: max escapes in any N consecutive weights (N = 16/64/256),
  roundtrip check through sw/ewformat.py (3-bit, per-matrix) == original.

Plus analysis/exp_hist.npy (the per-matrix exponent histograms) so the
report's figures don't need the model again.

    pip install safetensors numpy huggingface_hub
    python analysis/measure.py --model Qwen/Qwen2.5-0.5B
    python analysis/measure.py --dir path/to/folder/with/safetensors

Runs on CPU; the whole of Qwen2.5-0.5B is ~494M weights (the tied
embedding is ~136M of them), a few minutes per pass. Numbers it prints are
measurements on the real weights: those are the ones that go in
REPORT_PHASE1.md and LEDGER.md.
"""

import argparse
import csv
import json
import struct
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "sw"))
from ewformat import decode, encode  # noqa: E402

HERE = Path(__file__).resolve().parent


def bf16_tensors(path: Path):
    """Yield (name, uint16 array) for every BF16 tensor in a .safetensors
    file. Reads the header directly, so no torch is needed."""
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        header = json.loads(f.read(n))
        base = 8 + n
        for name, meta in header.items():
            if name == "__metadata__" or meta["dtype"] != "BF16":
                continue
            a, b = meta["data_offsets"]
            f.seek(base + a)
            arr = np.frombuffer(f.read(b - a), "<u2").reshape(meta["shape"])
            yield name, arr


def entropy(counts: np.ndarray) -> float:
    p = counts[counts > 0] / counts.sum()
    return float(-(p * np.log2(p)).sum())


def window_cov(hist: np.ndarray, k: int) -> tuple[int, int]:
    cs = np.concatenate([[0], np.cumsum(hist)])
    cov = cs[k:] - cs[:-k]
    e = int(np.argmax(cov))
    return e, int(cov[e])


def per_tile(exp: np.ndarray, k: int, tile: int) -> int:
    """Weights covered when every tile of `tile` weights picks its own best
    window of width k."""
    t = exp[: exp.size // tile * tile].reshape(-1, tile)
    covered = 0
    for s in range(0, t.shape[0], 4096):
        blk = t[s:s + 4096].astype(np.int64)
        hist = np.zeros((blk.shape[0], 256), np.int32)
        np.add.at(hist, (np.repeat(np.arange(blk.shape[0]), tile), blk.reshape(-1)), 1)
        cs = np.concatenate([np.zeros((blk.shape[0], 1), np.int32), np.cumsum(hist, axis=1)], axis=1)
        covered += int((cs[:, k:] - cs[:, :-k]).max(axis=1).sum())
    return covered


def burst(esc: np.ndarray, n: int) -> int:
    """Max escapes in any n consecutive weights (stream order)."""
    if esc.size < n:
        return int(esc.sum())
    cs = np.concatenate([[0], np.cumsum(esc, dtype=np.int64)])
    return int((cs[n:] - cs[:-n]).max())


def measure(name: str, w: np.ndarray) -> tuple[dict, np.ndarray]:
    flat = w.reshape(-1)
    exp = ((flat >> 7) & 0xFF).astype(np.uint8)
    n = flat.size
    hist = np.bincount(exp, minlength=256)
    row = {"name": name, "shape": "x".join(map(str, w.shape)), "n_weights": n,
           "exp_entropy": round(entropy(hist), 4),
           "full16_entropy": round(entropy(np.bincount(flat, minlength=1 << 16)), 4)}
    for b in (2, 3, 4):
        k = (1 << b) - 1
        e_star, cov = window_cov(hist, k)
        c = cov / n
        row[f"e_star_k{k}"] = e_star
        row[f"cov_k{k}"] = round(c, 6)
        row[f"bits_k{k}"] = round(b + 8 + 8 * (1 - c), 4)                # exponent-byte escape
        row[f"bits_zs_k{k}"] = round(b + 8 * c + 16 * (1 - c), 4)        # ZipServ full-BF16 fallback
        if b == 3:
            in_win = (exp.astype(np.int64) - e_star) % 256 < k
            esc = (~in_win).astype(np.int8)
            for nb in (16, 64, 256):
                row[f"burst{nb}"] = burst(esc, nb)
    for tile in (64, 256, 1024):
        if n % tile == 0:
            cov = per_tile(exp, 7, tile) / n
            row[f"tile{tile}_cov_k7"] = round(cov, 6)
            row[f"tile{tile}_bits_k7"] = round(3 + 8 + 8 * (1 - cov) + 8 / tile, 4)
    if w.ndim == 2 and w.shape[1] % 64 == 0:
        row["roundtrip_ok"] = bool(np.array_equal(decode(encode(w, 3)), w))
    else:
        row["roundtrip_ok"] = "n/a (cols % 64 != 0)"
    return row, hist


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen2.5-0.5B")
    ap.add_argument("--dir", help="local folder with .safetensors (skips the download)")
    ap.add_argument("--out", default=str(HERE / "results.csv"))
    args = ap.parse_args()

    if args.dir:
        folder = Path(args.dir)
    else:
        from huggingface_hub import snapshot_download
        folder = Path(snapshot_download(args.model, allow_patterns=["*.safetensors", "*.json"],
                                        local_dir=str(HERE / "weights")))
    files = sorted(folder.glob("*.safetensors"))
    assert files, f"no .safetensors in {folder}"

    rows, hists = [], {}
    for fpath in files:
        for name, w in bf16_tensors(fpath):
            if w.ndim != 2:
                continue                      # norms and biases are 1-D: not GEMV weights
            row, hist = measure(name, w)
            rows.append(row)
            hists[name] = hist
            print(f"{name:55} {row['shape']:>12}  cov7 {row['cov_k7']:.4f}  bits {row['bits_k7']:.3f}"
                  f"  burst256 {row['burst256']:3d}  roundtrip {row['roundtrip_ok']}")

    keys = list(dict.fromkeys(k for r in rows for k in r))
    with open(args.out, "w", newline="") as f:
        wr = csv.DictWriter(f, fieldnames=keys)
        wr.writeheader()
        wr.writerows(rows)
    np.save(HERE / "exp_hist.npy", hists, allow_pickle=True)

    n = np.array([r["n_weights"] for r in rows], float)
    def wavg(key):
        v = np.array([r.get(key, np.nan) for r in rows], float)
        m = ~np.isnan(v)
        return float((v[m] * n[m]).sum() / n[m].sum())
    print("\nmodel-wide, weighted by weights:")
    for k in ("exp_entropy", "full16_entropy", "cov_k3", "cov_k7", "cov_k15", "bits_k3", "bits_k7",
              "bits_k15", "bits_zs_k7", "tile64_bits_k7", "tile256_bits_k7", "tile1024_bits_k7"):
        print(f"  {k:18} {wavg(k):.4f}")
    low = [r["name"] for r in rows if r["cov_k7"] < 0.90]
    print(f"  matrices with cov_k7 < 90%: {low or 'none'}")
    print(f"  worst escape burst in 16/64/256: {max(r['burst16'] for r in rows)} / "
          f"{max(r['burst64'] for r in rows)} / {max(r['burst256'] for r in rows)}")
    print(f"  roundtrip failures: {[r['name'] for r in rows if r['roundtrip_ok'] is False] or 'none'}")


if __name__ == "__main__":
    main()
