"""build_hero.py — the portfolio hero's data: the tiled 8x8 array at full-die scale.

    python build_hero.py      (after export3d.sh has written data/*.json)

Writes docs/assets/hero_array.json for docs/hero3d.js: the PE's logic cells
(decap, filler, taps and antenna diodes left out; the hero draws the PE
footprint as a plate instead), the top level's logic cells, and the met4/met5
power grid as boxes (polygons reduced to their bounding boxes, which at this
scale are the same thing). Coordinates are microns, rounded to 0.01.
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parents[2] / "docs" / "assets" / "hero_array.json"
SKIP = {"decap", "filler", "tap", "antenna"}
# role -> colour, the viewer's "cell functions" palette (viewer_template.html)
COLORS = {
    "reg_w": "#c77dff", "reg_act": "#4cc9f0", "reg_ps": "#ff9f1c", "mult": "#ef476f", "adder": "#ffd166",
    "select": "#f15bb5", "wload": "#9b5de5", "misc": "#8d99ae", "reg_skew": "#4cc9f0", "reg_deskew": "#ff9f1c",
    "reg_valid": "#c77dff", "reset": "#ef476f", "regbuf": "#7f8a9c", "rsttree": "#e76f51", "tie": "#80ed99",
    "decode": "#ffd166", "clock": "#06d6a0", "io": "#90e0ef", "repair": "#adb5bd", "hold": "#f4a261",
}
ROLES = list(COLORS)
r2 = lambda v: round(v, 2)


def load(name):
    return json.loads((HERE / "data" / f"{name}.json").read_text(encoding="utf8"))


def cells(name):
    d = load(name)
    out = []
    for x, y, w, h, _type, role, *_ in d["cells"]:
        r = d["roles"][role]
        if r not in SKIP:
            out += [r2(x), r2(y), r2(w), r2(h), ROLES.index(r)]
    return out


def boxes(layout, layer):
    L = layout["layers"].get(layer, {"r": [], "p": []})
    out = [r2(v) for v in L["r"]]
    for poly in L["p"]:
        xs, ys = poly[0][0::2], poly[0][1::2]
        out += [r2(min(xs)), r2(min(ys)), r2(max(xs)), r2(max(ys))]
    return out


tile, array = load("pe_tile"), load("pe_array")
data = {
    "size": array["size"][0], "grid": {"n": 8, "margin": 120, "pitch": 220, "tile": 180},
    "roles": ROLES, "colors": [COLORS[r] for r in ROLES],
    "pe_cells": cells("cells_pe"), "top_cells": cells("cells_top"),
    "pe_met4": boxes(tile, "met4"), "met4": boxes(array, "met4"), "met5": boxes(array, "met5"),
}
OUT.write_text(json.dumps(data, separators=(",", ":")), encoding="utf8")
print(f"wrote {OUT} ({OUT.stat().st_size / 1e3:.0f} kB): "
      f"{len(data['pe_cells']) // 5} cells per PE, {len(data['top_cells']) // 5} top-level cells")
