"""build_hero_engine.py — the portfolio hero's data for the whole engine (ew_top): where each block sits on the die.

    python3 openlane/build_hero_engine.py <sky130_fd_sc_hd.lef> <ew_top.def> [out_dir]     (from ew-decoder/)

The engine has ~1.75M placed cells and ~213k routed nets, far too many to draw one by one in a page hero, so this
bins the die into a GRID x GRID map. Each bin records how much logic sits in it (cell area, filler / decap / tap
left out) and which engine block owns most of that area. Writes hero_engine.json (blocks, colours, centroids,
counts) and hero_engine.bin: per bin (row-major from the bottom left) a uint8 block index (255 = empty) and a
uint8 logic density (255 = the bin's area fully covered), then the met4/met5 power stripes as little-endian
uint16 x0, y0, x1, y1, layer (3 = met4, 4 = met5), coordinates in units of STRIPE_UNIT microns.

Blocks come from the netlist, as in build_hero.py. Flip-flops are named by the RTL register their Q net carries
(u_dec.*: the weight decoder, u_gemv.g_mul: multiplier inputs, u_gemv.g_lvl / lv: adder tree, u_gemv.acc: the
accumulator, xmem / xs / c: the activation buffer, u_rd_*.u_fifo / u_yfifo / u_wr_y.u_fifo: stream FIFOs,
the rest of u_rd_* / u_wr_y: the AXI read and write engines, anything else: control). Logic gates whose inputs
all trace back to one storage block (FIFO and x-buffer read muxes) belong to it, gates from the multiplier input
registers to the first adder level are the multipliers, and the rest belong to the most downstream block they
feed, in SINK_ORDER.
"""
import array
import json
import re
import sys
from collections import defaultdict, deque
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_hero import OUTPUT_PINS, base, parse_lef  # noqa: E402

OUT = Path(sys.argv[3]) if len(sys.argv) > 3 else Path(__file__).resolve().parents[1] / "docs" / "assets"
GRID = 256
STRIPE_UNIT = 1 / 16
# block -> colour, in dataflow order
BLOCKS = {
    "axi_in": "#4cc9f0", "fifo_in": "#3a86ff", "xbuf": "#06d6a0", "dec": "#ffd166", "mul": "#ff9f1c",
    "add": "#ef476f", "acc": "#c77dff", "out": "#9b5de5", "ctrl": "#8d99ae",
}
NAMES = list(BLOCKS)
SINK_ORDER = ["acc", "add", "mul", "dec", "out", "xbuf", "fifo_in", "axi_in", "ctrl"]
STORAGE = {"fifo_in", "xbuf"}
SKIP = ("fill", "decap", "tap", "diode", "PHY")


def flop_block(q):
    if q.startswith("u_dec."):
        return "dec"
    if q.startswith("u_gemv."):
        r = q[7:]
        if r.startswith("g_mul"):
            return "mul"
        if r.startswith(("g_lvl", "lv")):
            return "add"
        if r.startswith("acc"):
            return "acc"
        if r.startswith(("u_yfifo", "y_")):
            return "out"
        if r.startswith(("xmem", "xs", "x_", "c[", "c ", "cpr")) or r == "c":
            return "xbuf"
        return "ctrl"
    if q.startswith("u_wr_y."):
        return "out"
    if q.startswith("u_rd_"):
        return "fifo_in" if ".u_fifo." in q else "axi_in"
    return None


def stream_def(path):
    """comps {inst: (cell, x, y)} for logic cells, nets {net: [(inst, pin)]}, power stripes, die size."""
    comps, nets, stripes, ports = {}, {}, [], {}
    units, die, sec, cur, skipped = 1000, (0, 0), None, None, defaultdict(int)
    with open(path) as f:
        for line in f:
            s = line.lstrip()
            if s.startswith("UNITS DISTANCE"):
                units = int(s.split()[3])
            elif s.startswith("DIEAREA"):
                t = s.split()
                die = (int(t[6]) / units, int(t[7]) / units)
            elif s.startswith(("COMPONENTS", "PINS", "NETS", "SPECIALNETS")) and s.split()[0] in (
                    "COMPONENTS", "PINS", "NETS", "SPECIALNETS"):
                sec = s.split()[0]
            elif s.startswith("END "):
                sec = None
            elif sec == "COMPONENTS" and s.startswith("- "):
                t = s.split()
                cell = t[2]
                k = base(cell)
                if k.startswith(SKIP):
                    skipped[k.split("_")[0] if "_" in k else k] += 1
                    continue
                m = re.search(r"(?:PLACED|FIXED) \( (-?\d+) (-?\d+) \)", s)
                if m:
                    comps[t[1].replace("\\", "")] = (cell, int(m.group(1)) / units, int(m.group(2)) / units)
            elif sec == "PINS" and s.startswith("- "):
                m = re.search(r"DIRECTION (\w+)", s)
                if m:
                    ports[s.split()[1].replace("\\", "")] = m.group(1)
            elif sec == "NETS":
                if s.startswith("- "):
                    name, rest = s[2:].split(" ", 1)
                    cur = nets[name.replace("\\", "")] = []
                    s = rest
                if cur is not None:
                    head = s.split("+ ROUTED")[0] if "+" not in s else s.split("+")[0]
                    cur += [(a.replace("\\", ""), b) for a, b in re.findall(r"\(\s*(\S+)\s+(\S+)\s*\)", head)]
                    if "+" in s or s.rstrip().endswith(";"):
                        cur = None
            elif sec == "SPECIALNETS":
                m = re.search(r"(met[45]) (\d+) \+ SHAPE STRIPE \( (\d+) (\d+) \) \( (\S+) (\S+) \)", s)
                if m:
                    layer, w = m.group(1), int(m.group(2)) / units
                    x0, y0 = int(m.group(3)) / units, int(m.group(4)) / units
                    x1 = x0 if m.group(5) == "*" else int(m.group(5)) / units
                    y1 = y0 if m.group(6) == "*" else int(m.group(6)) / units
                    stripes.append((layer, min(x0, x1) - w / 2, min(y0, y1) - w / 2, max(x0, x1) + w / 2, max(y0, y1) + w / 2))
    return die, comps, ports, nets, stripes, dict(skipped)


def main():
    size, lef_pins = parse_lef(sys.argv[1])
    die, comps, ports, nets, stripes, skipped = stream_def(sys.argv[2])
    print(f"die {die}, {len(comps)} logic cells, skipped {skipped}, {len(nets)} nets, {len(stripes)} stripes", flush=True)

    drv, loads, pin_net = {}, defaultdict(list), defaultdict(dict)
    for net, conns in nets.items():
        for inst, pin in conns:
            if inst == "PIN" or inst not in comps:
                continue
            pin_net[inst][pin] = net
            d = lef_pins.get(comps[inst][0], {}).get(pin)
            if (d == "OUTPUT") if d else pin in OUTPUT_PINS:
                drv[net] = inst
            else:
                loads[net].append(inst)
    del nets
    is_flop = lambda i: base(comps[i][0]).startswith("df")
    ins = lambda i: [n for p, n in pin_net[i].items() if p not in OUTPUT_PINS and p != "CLK" and not p.startswith(("VP", "VG", "VN"))]
    outs = lambda i: [n for p, n in pin_net[i].items() if p in OUTPUT_PINS]
    bit = {b: 1 << k for k, b in enumerate(NAMES)}

    # flops: by register name; Q nets renamed by buffering are followed forward to the first named net
    block, unnamed = {}, 0
    for i in comps:
        if not is_flop(i):
            continue
        q, b = pin_net[i].get("Q", ""), None
        front, seen = [q], 0
        while front and b is None and seen < 6:
            nxt = []
            for n in front:
                b = b or flop_block(n)
                for l in loads[n]:
                    if not is_flop(l) and base(comps[l][0]).startswith(("buf", "dlygate", "clkbuf", "dlymetal", "clkdlybuf")):
                        nxt += outs(l)
            front, seen = nxt, seen + 1
        if b is None:
            unnamed += 1
        block[i] = b or "ctrl"
    print(f"{len(block)} flops, {unnamed} with no register name (-> ctrl)", flush=True)

    # backward: which blocks each net feeds; forward: which blocks each net comes from
    sinks, srcs = defaultdict(int), defaultdict(int)
    work = deque()
    for f, b in block.items():
        for n in ins(f):
            sinks[n] |= bit[b]
            work.append(n)
    while work:
        net = work.popleft()
        i = drv.get(net)
        if i is None or i in block:
            continue
        for n in ins(i):
            if sinks[n] | sinks[net] != sinks[n]:
                sinks[n] |= sinks[net]
                work.append(n)
    for f, b in block.items():
        for n in outs(f):
            srcs[n] |= bit[b]
            work.append(n)
    while work:
        net = work.popleft()
        for i in loads[net]:
            if i in block:
                continue
            for n in outs(i):
                if srcs[n] | srcs[net] != srcs[n]:
                    srcs[n] |= srcs[net]
                    work.append(n)

    for i in comps:
        if i in block:
            continue
        s = sr = 0
        for o in outs(i):
            s |= sinks[o]
        for n in ins(i):
            sr |= srcs[n]
        one = [b for b in STORAGE if sr == bit[b]]
        if one:
            block[i] = one[0]
        elif s & bit["add"] and sr & bit["mul"] and not sr & bit["add"]:
            block[i] = "mul"                  # the multiplier array: between its input registers and adder level 0
        elif s:
            block[i] = next(b for b in SINK_ORDER if s & bit[b])
        else:
            block[i] = "ctrl"

    # bin by cell area
    gx, gy = die[0] / GRID, die[1] / GRID
    area = [[0.0] * len(NAMES) for _ in range(GRID * GRID)]
    cx, cy, ca = defaultdict(float), defaultdict(float), defaultdict(float)
    counts = defaultdict(int)
    for i, (cell, x, y) in comps.items():
        w, h = size.get(cell, (0.46, 2.72))
        b = block[i]
        counts[b] += 1
        k = NAMES.index(b)
        mx, my = x + w / 2, y + h / 2
        area[min(GRID - 1, int(my / gy)) * GRID + min(GRID - 1, int(mx / gx))][k] += w * h
        cx[b] += mx * w * h
        cy[b] += my * w * h
        ca[b] += w * h
    bin_area = gx * gy
    flat = bytearray()
    for a in area:
        tot = sum(a)
        flat.append(max(range(len(NAMES)), key=lambda k: a[k]) if tot else 255)
        flat.append(min(255, round(255 * tot / bin_area)))
    st = array.array("H")
    q = lambda v: max(0, min(65535, round(v / STRIPE_UNIT)))
    for layer, x0, y0, x1, y1 in stripes:
        st.extend([q(x0), q(y0), q(x1), q(y1), 4 if layer == "met5" else 3])
    if sys.byteorder != "little":
        st.byteswap()
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "hero_engine.bin").write_bytes(bytes(flat) + st.tobytes())
    head = {
        "size": [round(v, 3) for v in die], "grid": GRID, "stripeUnit": STRIPE_UNIT, "stripes": len(stripes),
        "blocks": NAMES, "colors": [BLOCKS[b] for b in NAMES], "counts": dict(counts),
        "centroids": {b: [round(cx[b] / ca[b], 1), round(cy[b] / ca[b], 1)] for b in NAMES if ca[b]},
        "area": {b: round(ca[b]) for b in NAMES}, "skipped": skipped,
    }
    (OUT / "hero_engine.json").write_text(json.dumps(head, separators=(",", ":")), encoding="utf8")
    print(json.dumps(head, indent=1))


if __name__ == "__main__":
    main()
