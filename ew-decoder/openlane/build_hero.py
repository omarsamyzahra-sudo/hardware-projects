"""build_hero.py — the portfolio hero's data: the decoder's routed layout, every cell and wire tagged with its job.

    python3 openlane/build_hero.py <sky130_fd_sc_hd.lef> [out_dir]     (from ew-decoder/, after run.sh decoder)

Reads openlane/decoder/results/weight_decoder.def.gz and writes hero_decoder.json (roles, colours, counts) and
hero_decoder.bin (the geometry) to out_dir, by default ../docs/assets (hardware-projects/docs/assets when run
from the monorepo copy). Every value in the .bin is a little-endian uint16, coordinates in units of 10 nm:

  cells  x, y, w, h, role, lane, sub     one per placed cell; abutting filler/decap/tap cells merged per row
  wires  x0, y0, x1, y1, layer, ref      one per routed segment (li1 left out); ref = the driving cell's index,
                                         65534 for nets driven by an input port, 65535 for the power grid

Roles come from the netlist. Flip-flops are named by the RTL register their Q net still carries (stg / cur: the
next and current tile's code bits, win: the escape window, out_w: the decoded chunk; the rest is control).
Logic gates are classed by the registers they feed, traced back from every flop's D pin: gates that feed one
lane's 16 output bits are that lane's logic, split into escape routing (the win register reaches them) and the
lane itself (base + code -> exponent, sign and mantissa); gates that feed several lanes are the prefix popcount
that hands each escaping lane its window slot; then window shift and refill, tile loading, and control.
lane is 0..7 (8 = none); sub is the bit index for tile registers (plane * 64 + weight), the byte for the window.
"""
import array
import gzip
import json
import re
import sys
from collections import defaultdict, deque
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEF = HERE / "decoder" / "results" / "weight_decoder.def.gz"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else HERE.parents[1] / "docs" / "assets"
OUTPUT_PINS = {"X", "Y", "Q", "Q_N", "HI", "LO", "COUT", "SUM"}
BUFFERS = ("buf", "clkbuf", "dlygate", "clkdlybuf", "dlymetal", "bufinv")
LAYERS = ["met1", "met2", "met3", "met4", "met5"]
WIDTH = {"met1": 0.14, "met2": 0.14, "met3": 0.30, "met4": 0.30, "met5": 1.60}
# role -> colour; the registers are the bright ones, as in the systolic array's viewer palette
COLORS = {
    "reg_cur": "#c77dff", "reg_stg": "#7b5cd6", "reg_win": "#ef476f", "reg_out": "#ff9f1c", "reg_ctrl": "#8d99ae",
    "lane": "#ffd166", "escmux": "#f15bb5", "prefix": "#4cc9f0", "window": "#e5577a", "tile": "#9b5de5",
    "ctrl": "#7f8a9c", "clock": "#06d6a0", "io": "#90e0ef", "hold": "#f4a261", "repair": "#adb5bd",
    "filler": "#1a2130", "decap": "#1e2636", "tap": "#232c3d",
}
ROLES = list(COLORS)
NONE = 8


def parse_lef(path):
    size, pins, cur, pin = {}, defaultdict(dict), None, None
    for line in open(path):
        t = line.split()
        if not t:
            continue
        if t[0] == "MACRO":
            cur = t[1]
        elif t[0] == "SIZE" and cur:
            size[cur] = (float(t[1]), float(t[3]))
        elif t[0] == "PIN" and cur:
            pin = t[1]
        elif t[0] == "DIRECTION" and cur and pin:
            pins[cur][pin] = t[1]
    return size, pins


def section(text, name):
    return text[text.index("\n" + name):text.index("END " + name)]


def parse_def(text, wires=True):
    units = int(re.search(r"UNITS DISTANCE MICRONS (\d+)", text).group(1))
    die = [int(v) / units for v in re.search(r"DIEAREA \( 0 0 \) \( (\d+) (\d+) \)", text).groups()]
    comps = {}
    for m in re.finditer(r"-\s+(\S+)\s+(\S+)\s+.*?\+\s+(?:PLACED|FIXED)\s+\(\s*(-?\d+)\s+(-?\d+)\s*\)\s+(\S+)",
                         section(text, "COMPONENTS")):
        comps[m.group(1).replace("\\", "")] = (m.group(2), int(m.group(3)) / units, int(m.group(4)) / units)
    ports = {}
    for m in re.finditer(r"-\s+(\S+)\s+\+\s+NET\s+\S+.*?DIRECTION\s+(\w+)", section(text, "PINS"), re.S):
        ports[m.group(1).replace("\\", "")] = m.group(2)
    nets, routes = {}, {}
    for stmt in section(text, "NETS").split(";"):
        m = re.match(r"\s*-\s+(\S+)(.*)", stmt, re.S)
        if not m:
            continue
        name = m.group(1).replace("\\", "")
        conn, _, wiring = m.group(2).partition("+ ROUTED")
        nets[name] = [(a.replace("\\", ""), b.replace("\\", "")) for a, b in re.findall(r"\(\s*(\S+)\s+(\S+)\s*\)", conn)]
        if wires:
            routes[name] = segments("ROUTED" + wiring, units, None)
    power = []
    for stmt in section(text, "SPECIALNETS").split(";"):
        power += segments(stmt, units, True)
    return die, comps, ports, nets, routes, power


def segments(wiring, units, special):
    """Wire rectangles of one net's routing: (layer, x0, y0, x1, y1) in microns."""
    out = []
    pat = (r"(?:ROUTED|NEW)\s+(met[1-5])\s+(\d+).*?\(\s*(-?\d+)\s+(-?\d+)[^)]*\)\s*\(\s*(\S+)\s+(\S+)[^)]*\)" if special else
           r"(?:ROUTED|NEW)\s+(met[1-5])()\s+\(\s*(-?\d+)\s+(-?\d+)[^)]*\)\s*\(\s*(\S+)\s+(\S+)[^)]*\)")
    for layer, w, x0, y0, x1, y1 in re.findall(pat, wiring):
        x0, y0 = int(x0), int(y0)
        x1 = x0 if x1 == "*" else int(x1)
        y1 = y0 if y1 == "*" else int(y1)
        hw = (int(w) / units if w else WIDTH[layer]) / 2
        a, b = sorted((x0 / units, x1 / units)), sorted((y0 / units, y1 / units))
        out.append((layer, a[0] - hw, b[0] - hw, a[1] + hw, b[1] + hw))
    return out


def base(cell):                       # sky130_fd_sc_hd__a21oi_2 -> a21oi
    return re.sub(r"_\d+$", "", cell.split("__")[-1])


class Netlist:
    def __init__(self, comps, ports, nets, lef_pins):
        self.comps = comps
        self.pin_net = defaultdict(dict)          # inst -> pin -> net
        self.driver, self.loads = {}, defaultdict(list)
        for net, conns in nets.items():
            for inst, pin in conns:
                if inst == "PIN":
                    if ports.get(pin) == "INPUT":
                        self.driver[net] = ("PIN", pin)
                    else:
                        self.loads[net].append(("PIN", pin))
                    continue
                self.pin_net[inst][pin] = net
                d = lef_pins.get(comps[inst][0] if inst in comps else "", {}).get(pin)
                if (d == "OUTPUT") if d else pin in OUTPUT_PINS:
                    self.driver[net] = (inst, pin)
                else:
                    self.loads[net].append((inst, pin))

    def kind(self, inst):
        return base(self.comps[inst][0]) if inst in self.comps else ""

    def is_flop(self, inst):
        return self.kind(inst).startswith("df")

    def inputs(self, inst):
        return [n for p, n in self.pin_net[inst].items()
                if p not in OUTPUT_PINS and p != "CLK" and not p.startswith(("VP", "VG", "VN"))]

    def outputs(self, inst):
        return [n for p, n in self.pin_net[inst].items() if p in OUTPUT_PINS]

    def forward_port(self, net, depth=4):
        """Follow buffers (output and hold buffers alike) from net to an output port name, if any."""
        front = [net]
        for _ in range(depth + 1):
            nxt = []
            for n in front:
                for inst, pin in self.loads[n]:
                    if inst == "PIN":
                        return pin
                    if self.kind(inst).startswith(BUFFERS):
                        nxt += self.outputs(inst)
            front = nxt
        return None


def common_role(nl, inst):
    """Roles that don't depend on what the design computes."""
    k = nl.kind(inst)
    for pre, role in (("fill", "filler"), ("decap", "decap"), ("tap", "tap")):
        if k.startswith(pre):
            return role
    if inst.startswith(("clkbuf", "clkload", "delaybuf")) or k in ("clkbuf", "clkinv"):
        return "clock"
    if inst.startswith(("input", "output")):
        return "io"
    if inst.startswith(("max_cap", "wire", "fanout", "rebuffer", "split", "max_length")) or k == "diode":
        return "repair"
    if k.startswith(("dlygate", "clkdlybuf", "dlymetal")) or inst.startswith("hold"):
        return "hold"
    return None


def register(nl, f):
    """(role, lane, sub) of a flop, from the register name its Q net carries."""
    q = nl.pin_net[f].get("Q", "")
    if m := re.fullmatch(r"(stg|cur)\[(\d+)\]\[(\d+)\]", q):
        p, b = int(m.group(2)), int(m.group(3))
        return "reg_" + m.group(1), b % 8, p * 64 + b
    if m := re.fullmatch(r"win\[(\d+)\]", q):
        return "reg_win", NONE, int(m.group(1)) // 8
    if q.startswith("g_lane[0].u_lane.esc_byte["):            # window byte 0 keeps lane 0's name for it
        return "reg_win", NONE, 0
    name = q if q.startswith("out_w[") else nl.forward_port(q) or ""
    if m := re.fullmatch(r"out_w\[(\d+)\]", name):
        b = int(m.group(1))
        return "reg_out", b // 16, b % 16
    return "reg_ctrl", NONE, 0


def classify(nl):
    meta = {f: register(nl, f) for f in nl.comps if nl.is_flop(f)}

    # which registers each gate feeds: walk back from every flop's D input through the logic
    LANE, WIN, TILE, CTRL = 0, 8, 9, 10
    sinks = defaultdict(int)
    work = deque()
    for f, (role, lane, _) in meta.items():
        bitv = 1 << {"reg_out": lane, "reg_win": WIN, "reg_stg": TILE, "reg_cur": TILE}.get(role, CTRL)
        for p, n in nl.pin_net[f].items():
            if p not in OUTPUT_PINS and p != "CLK" and not p.startswith(("VP", "VG", "VN")):
                sinks[n] |= bitv
                work.append(n)
    while work:
        net = work.popleft()
        inst, _ = nl.driver.get(net, (None, None))
        if inst in (None, "PIN") or nl.is_flop(inst):
            continue
        for n in nl.inputs(inst):
            if sinks[n] | sinks[net] != sinks[n]:
                sinks[n] |= sinks[net]
                work.append(n)

    # which gates the escape window's bytes reach
    from_win, work = set(), deque()
    for f, (role, _, _) in meta.items():
        if role == "reg_win":
            work.append(nl.pin_net[f].get("Q"))
    while work:
        net = work.popleft()
        for inst, pin in nl.loads[net]:
            if inst == "PIN" or nl.is_flop(inst) or inst in from_win:
                continue
            from_win.add(inst)
            work.extend(nl.outputs(inst))

    for inst in nl.comps:
        if inst in meta:
            continue
        role = common_role(nl, inst)
        if role:
            meta[inst] = (role, NONE, 0)
            continue
        s = 0
        for o in nl.outputs(inst):
            s |= sinks[o]
        lanes = [i for i in range(8) if s >> i & 1]
        if len(lanes) == 1:
            meta[inst] = ("escmux" if inst in from_win else "lane", lanes[0], 0)
        elif lanes:
            meta[inst] = ("prefix", NONE, 0)
        elif s >> WIN & 1:
            meta[inst] = ("window", NONE, 0)
        elif s >> TILE & 1:
            meta[inst] = ("tile", NONE, 0)
        else:
            meta[inst] = ("ctrl", NONE, 0)
    return meta


def main():
    size, lef_pins = parse_lef(sys.argv[1])
    die, comps, ports, nets, routes, power = parse_def(gzip.open(DEF, "rt").read())
    nl = Netlist(comps, ports, nets, lef_pins)
    meta = classify(nl)
    q = lambda v: max(0, min(65535, round(v * 100)))           # microns -> 10 nm units

    # cells, in placement order; abutting filler / decap / tap merged into one box per run
    order = sorted(meta, key=lambda i: (comps[i][2], comps[i][1]))
    cells, index, run = [], {}, None
    for inst in order:
        role, lane, sub = meta[inst]
        cell, x, y = comps[inst]
        w, h = size.get(cell, (0, 0))
        r = ROLES.index(role)
        if role in ("filler", "decap", "tap") and run and run[4] == r and run[1] == y and abs(run[0] + run[2] - x) < 1e-6:
            run[2] += w
            continue
        run = [x, y, w, h, r, lane, sub]
        cells.append(run)
        index[inst] = len(cells) - 1

    wires = []
    for net, segs in routes.items():
        drv, _ = nl.driver.get(net, (None, None))
        ref = 65534 if drv == "PIN" else index.get(drv, 65535)
        wires += [(x0, y0, x1, y1, LAYERS.index(layer), ref) for layer, x0, y0, x1, y1 in segs]
    wires += [(x0, y0, x1, y1, LAYERS.index(layer), 65535) for layer, x0, y0, x1, y1 in power]

    flat = []
    for x, y, w, h, r, lane, sub in cells:
        flat += [q(x), q(y), q(w), q(h), r, lane, sub]
    for x0, y0, x1, y1, layer, ref in wires:
        flat += [q(x0), q(y0), q(x1), q(y1), layer, ref]
    OUT.mkdir(parents=True, exist_ok=True)
    a = array.array("H", flat)
    if sys.byteorder != "little":
        a.byteswap()
    (OUT / "hero_decoder.bin").write_bytes(a.tobytes())
    counts = defaultdict(int)
    for role, _, _ in meta.values():
        counts[role] += 1
    head = {"size": [round(v, 3) for v in die], "unit": 0.01, "roles": ROLES, "colors": [COLORS[r] for r in ROLES],
            "layers": LAYERS, "cells": len(cells), "wires": len(wires), "counts": dict(counts)}
    (OUT / "hero_decoder.json").write_text(json.dumps(head, separators=(",", ":")), encoding="utf8")
    print(f"wrote {OUT}/hero_decoder.bin ({len(a) * 2 / 1e3:.0f} kB): {len(cells)} cell boxes, {len(wires)} wires")
    print(dict(sorted(counts.items(), key=lambda kv: -kv[1])))


if __name__ == "__main__":
    main()
