"""build_viewer.py — bundle the 3D viewer into one self-contained HTML page.

    python build_viewer.py      (after export3d.sh has written data/*.json)

Inlines data/pe_array.json, pe_tile.json and pe_closeup.json into
viewer_template.html and writes internship/Systolic-Array-3D.html.
three.js still loads from jsDelivr, so the page needs internet.
"""
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parents[2] / "Systolic-Array-3D.html"

blocks = "\n".join(
    f'<script type="application/json" id="d-{key}">{(HERE / "data" / f"pe_{key}.json").read_text()}</script>'
    for key in ("array", "tile", "closeup"))
html = (HERE / "viewer_template.html").read_text(encoding="utf-8").replace("/*DATA*/", blocks)
OUT.write_text(html, encoding="utf-8", newline="\n")
print(f"wrote {OUT} ({len(html) / 1e6:.1f} MB)")
