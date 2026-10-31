"""make_gpu_die.py — floorplan map of the hardened SIMT core, plus portfolio assets.

    python openlane/make_gpu_die.py        (after run.sh and render.sh)

Every flip-flop in the placed DEF is labeled by the register it holds, read
from the name of the net on its Q pin:

    rf[i][b]            lane i // 128 (rf index = (lane*WARPS + warp)*32 + reg)
    lane[l].u_br.*      lane l's operand registers for the X stage
    pc[], alive[], ...  per-thread state
    u_lsu.*             load/store unit (coalescer, request queue, tag FIFO)
    anything else       front end (scheduler, fetch, decode, X-stage control)

Labels then spread to the combinational cells over the netlist (each round,
an unlabeled cell takes the most common label among its labeled neighbors;
clock, reset and other high-fanout nets are skipped). The result is painted
over the metal render (results/die.png, which render.py frames exactly on
the die boundary), so each color is where the placer put that unit.

Writes results/floorplan.png and the portfolio's assets + gpu_die.js.
"""

import gzip
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
RES = HERE / "results"
PORT = HERE.parent.parent / "portfolio"
LANES, WARPS, NT = 8, 4, 32

CLASSES = [  # (name, rgb)
    *[(f"lane {l}", c) for l, c in enumerate([
        (61, 127, 224), (79, 209, 232), (79, 191, 106), (166, 214, 79),
        (232, 197, 71), (232, 135, 58), (224, 93, 138), (155, 89, 208)])],
    ("thread state", (235, 238, 245)),
    ("load/store unit", (255, 120, 60)),
    ("front end", (120, 140, 170)),
]
IDX = {n: i for i, (n, _) in enumerate(CLASSES)}


def register_class(q: str):
    q = q.replace("\\", "")                     # DEF escapes brackets: rf\[12\]
    if m := re.match(r"rf\[(\d+)\]", q):
        return IDX[f"lane {int(m.group(1)) // (WARPS * 32)}"]
    if m := re.match(r"lane\[(\d+)\]", q):
        return IDX[f"lane {m.group(1)}"]
    if q.startswith("u_lsu."):
        return IDX["load/store unit"]
    if re.match(r"(pc|alive|busy|d_mask)\[", q):
        return IDX["thread state"]
    return IDX["front end"]


def parse_def(text):
    units = int(re.search(r"UNITS DISTANCE MICRONS (\d+)", text).group(1))
    x0, y0, x1, y1 = map(int, re.search(r"DIEAREA \( (-?\d+) (-?\d+) \) \( (-?\d+) (-?\d+) \)", text).groups())
    comps = {}
    sect = text[text.index("\nCOMPONENTS"):text.index("END COMPONENTS")]
    for m in re.finditer(r"-\s+(\S+)\s+(\S+)\s+.*?\+\s+(?:PLACED|FIXED)\s+\(\s*(-?\d+)\s+(-?\d+)\s*\)", sect):
        comps[m.group(1)] = (m.group(2), int(m.group(3)), int(m.group(4)))
    nets = []
    sect = text[text.index("\nNETS"):text.index("END NETS")]
    for stmt in sect.split(";"):
        m = re.match(r"\s*-\s+(\S+)(.*)", stmt, re.S)
        if not m:
            continue
        conn = m.group(2).split("+ USE")[0].split("+ ROUTED")[0]
        pins = [(i, p) for i, p in re.findall(r"\(\s*(\S+)\s+(\S+)\s*\)", conn) if i != "PIN"]
        nets.append((m.group(1), pins))
    return units, (x0, y0, x1, y1), comps, nets


def main():
    text = gzip.open(RES / "simt_core.def.gz", "rt").read()
    units, (x0, y0, x1, y1), comps, nets = parse_def(text)
    names = list(comps)
    at = {n: i for i, n in enumerate(names)}
    label = np.full(len(names), -1, np.int16)
    skip = re.compile(r"(fill|decap|tap|diode|conb)")
    logic = np.array([not skip.search(comps[n][0]) for n in names])

    # flops: label from the Q net
    flops = 0
    adj = defaultdict(list)
    for net, pins in nets:
        for inst, pin in pins:
            if pin == "Q" and "__df" in comps.get(inst, ("",))[0]:
                label[at[inst]] = register_class(net)
                flops += 1
        if 2 <= len(pins) <= 40:
            ids = [at[i] for i, _ in pins if i in at]
            for a in ids:
                adj[a].extend(b for b in ids if b != a)
    print(f"{len(names)} components, {flops} flops labeled")

    for rnd in range(40):
        new = {}
        for a in np.flatnonzero((label < 0) & logic):
            votes = Counter(int(label[b]) for b in adj.get(a, ()) if label[b] >= 0)
            if votes:
                new[a] = votes.most_common(1)[0][0]
        if not new:
            break
        for a, c in new.items():
            label[a] = c
    left = int(((label < 0) & logic).sum())
    print(f"propagation done after {rnd + 1} rounds, {left} logic cells unlabeled")

    # paint
    die = Image.open(RES / "die.png").convert("RGB")
    W, H = die.size
    G = 3                                          # px per bin
    gw, gh = W // G, H // G
    counts = np.zeros((len(CLASSES), gh, gw), np.float32)
    for i, n in enumerate(names):
        c = label[i]
        if c < 0:
            continue
        _, x, y = comps[n]
        gx = int((x - x0) / (x1 - x0) * gw)
        gy = int((1 - (y - y0) / (y1 - y0)) * gh)
        if 0 <= gx < gw and 0 <= gy < gh:
            counts[c, gy, gx] += 1
    # smooth a little so the map reads as regions, not dots
    k = np.ones(9, np.float32) / 9
    for c in range(len(CLASSES)):
        for ax in (1, 2):
            counts[c] = np.apply_along_axis(lambda v: np.convolve(v, k, "same"), ax - 1, counts[c])
    total = counts.sum(0)
    win = counts.argmax(0)
    pal = np.array([c for _, c in CLASSES], np.float32)
    color = pal[win]
    alpha = np.clip(total / (np.percentile(total[total > 0], 60) + 1e-6), 0, 1)[..., None] * 0.78
    color = np.kron(color, np.ones((G, G, 1)))[:H, :W]
    alpha = np.kron(alpha, np.ones((G, G, 1)))[:H, :W]
    base = np.asarray(die, np.float32)[: alpha.shape[0], : alpha.shape[1]]
    out = base * (1 - alpha) + color * alpha
    fp = Image.fromarray(out.clip(0, 255).astype(np.uint8))
    fp.save(RES / "floorplan.png")

    # label positions: median of each class's cells
    labels = []
    for c, (name, rgb) in enumerate(CLASSES):
        pts = [(comps[names[i]][1], comps[names[i]][2]) for i in np.flatnonzero(label == c)]
        if len(pts) < 200:
            continue
        xs, ys = np.median(np.array(pts), 0)
        clamp = lambda v: round(min(max(v, 8.0), 86.0), 1)          # keep the tag inside the frame
        labels.append({"t": name, "x": clamp((xs - x0) / (x1 - x0) * 100),
                       "y": clamp((1 - (ys - y0) / (y1 - y0)) * 100), "c": "rgb(%d,%d,%d)" % rgb})

    m = json.loads((RES / "metrics.json").read_text())
    cells = m.get("design__instance__count__stdcell") or m.get("design__instance__count")
    ws = m.get("timing__setup__ws__corner:nom_tt_025C_1v80")
    ws_ss = m.get("timing__setup__ws__corner:nom_ss_100C_1v60")
    w_um, h_um = (x1 - x0) / units, (y1 - y0) / units
    fmt = lambda v: "~%d MHz" % round(1000 / (20 - v)) if v is not None else "n/a"
    drc = m.get("magic__drc_error__count", m.get("route__drc_errors"))
    lvs = m.get("design__lvs_error__count")
    routed = drc is not None or lvs is not None     # final metrics vs. a placed-only snapshot
    specs = [["die", f"{w_um / 1000:.2f} × {h_um / 1000:.2f} mm"],
             ["standard cells", f"{cells:,}" if cells else "n/a"],
             ["flip-flops", f"{flops:,} (32,768 are registers)"]]
    if routed:
        specs += [["fmax (tt / ss)", f"{fmt(ws)} / {fmt(ws_ss)}"], ["DRC · LVS", f"{drc} · {lvs}"]]
    else:
        specs += [["stage", "placed + clock tree, not routed"]]
    summary = {"die_um": [w_um, h_um], "cells": cells, "flops": flops, "ws_tt": ws, "ws_ss": ws_ss,
               "drc": drc, "lvs": lvs, "power_w": m.get("power__total"), "routed": routed, "labels": labels}
    (RES / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({k: v for k, v in summary.items() if k != "labels"}, indent=2))

    # portfolio assets
    A = PORT / "assets"
    side = 2400
    def save(img, name, q=86):
        img.convert("RGB").resize((side, round(side * img.height / img.width)), Image.LANCZOS).save(A / name, quality=q, optimize=True, progressive=True)
    save(die, "gpu_die.jpg")
    save(fp, "gpu_floorplan.jpg")
    Image.open(RES / "mid.png").convert("RGB").resize((2000, 2000), Image.LANCZOS).save(A / "gpu_mid.jpg", quality=86, optimize=True, progressive=True)
    shots = [
        {"tab": "GPU core", "src": "assets/gpu_die.jpg", "alt": "Layout of one SIMT core of the GPU on SKY130",
         "title": "One SIMT core (an “SM”), flat", "specs": specs,
         "desc": "The whole of simt_core.sv: warp scheduler, fetch and decode, 8 lane ALUs with 32-bit multipliers, "
                 "the register file for 32 threads (built from flip-flops, since the open PDK flow has no SRAM compiler) "
                 "and the coalescing load/store unit. Instruction and global memory stay off-core, as SRAM macros would be."
                 + ("" if routed else " Shown placed, with the clock tree and power grid: global routing didn’t converge "
                    "(the flip-flop register file plus timing-repair buffers left met2 99% used), so there are no signal wires yet.")},
        {"tab": "GPU floorplan", "src": "assets/gpu_floorplan.jpg", "alt": "The SIMT core layout colored by functional unit",
         "title": "Where the placer put each unit", "specs": specs[:3], "labels": labels,
         "desc": "Every flip-flop labeled by the register it holds (from its net name), labels spread through the netlist "
                 "to the logic around them, then painted over the layout. Each lane’s registers and ALU form their own region: "
                 "the 8-way SIMD structure is visible in silicon."},
        {"tab": "GPU 250 µm", "src": "assets/gpu_mid.jpg", "alt": "250 micrometer window of the SIMT core layout",
         "title": "Zoom: the register-file sea", "specs": [["window", "250 µm"], ["metal", "met1–met5" if routed else "cells + power grid"]],
         "desc": "A 250 µm window in the middle of the core: dense rows of flip-flops and the read multiplexers that pick one "
                 "of 128 registers for each lane, every cycle."},
    ]
    (PORT / "gpu_die.js").write_text("// written by simt-gpu/openlane/make_gpu_die.py\nexport const GPU_DIE = "
                                     + json.dumps(shots, indent=2, ensure_ascii=False) + ";\n", encoding="utf-8", newline="\n")
    print("wrote", PORT / "gpu_die.js")


if __name__ == "__main__":
    main()
