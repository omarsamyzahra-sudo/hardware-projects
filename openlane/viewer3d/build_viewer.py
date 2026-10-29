"""build_viewer.py — bundle the 3D viewer into one self-contained HTML page.

    python build_viewer.py      (after export3d.sh has written data/*.json)

Gzips and base64-encodes data/pe_tile.json, pe_array.json, cells_pe.json and
cells_top.json into viewer_template.html (the page unpacks them with
DecompressionStream) and writes internship/Systolic-Array-3D.html.
three.js still loads from jsDelivr, so the page needs internet.
"""
import base64
import gzip
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parents[2] / "Systolic-Array-3D.html"
DATA = {"tile": "pe_tile", "array": "pe_array", "cpe": "cells_pe", "ctop": "cells_top"}


def block(key, name):
    raw = (HERE / "data" / f"{name}.json").read_bytes()
    packed = base64.b64encode(gzip.compress(raw, 9, mtime=0)).decode()
    print(f"  {name}.json  {len(raw) / 1e6:5.1f} MB -> {len(packed) / 1e6:4.1f} MB")
    return f'<script type="application/octet-stream" id="d-{key}">{packed}</script>'


blocks = "\n".join(block(k, n) for k, n in DATA.items())
html = (HERE / "viewer_template.html").read_text(encoding="utf-8").replace("/*DATA*/", blocks)
OUT.write_text(html, encoding="utf-8", newline="\n")
print(f"wrote {OUT} ({len(html) / 1e6:.1f} MB)")
