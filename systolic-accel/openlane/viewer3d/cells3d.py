"""cells3d.py — give every placed cell a footprint and a role, for the 3D viewer.

    python3 cells3d.py <cell.lef> <pe.def> <systolic_array.def> <out_dir>

Reads the placed DEFs and the standard-cell LEF (for cell sizes and pin
directions), traces the netlist and writes cells_pe.json / cells_top.json:

  PE: each flip-flop is named by the register bit it holds (weight bit i,
      a_out[i], sel_out, ps_out[i]); each logic gate is classed by what
      reaches it: activations and weights only -> multiplier, anything
      that also sees ps_in -> adder, sel + weights -> bank select, w_in /
      w_we / w_bank -> weight load.
  top: registers are named by the delay line they belong to (input skew
      lane k stage s, output deskew column n stage s, valid/tag stage s),
      plus reset gates, tie cells, hold buffers, clock tree and I/O.

Filler, decap and tap cells are listed for the PE (they show how much of
the tile is empty) but left out at the top level, where there are ~300k.
"""
import json
import re
import sys
from collections import defaultdict, deque

OUTPUT_PINS = {"X", "Y", "Q", "Q_N", "HI", "LO", "COUT", "SUM"}
BUFFERS = ("buf", "clkbuf", "dlygate", "clkdlybuf", "dlymetal", "bufinv")


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


def parse_def(path):
    text = open(path).read()
    units = int(re.search(r"UNITS DISTANCE MICRONS (\d+)", text).group(1))
    comps = {}
    sect = text[text.index("\nCOMPONENTS"):text.index("END COMPONENTS")]
    for m in re.finditer(r"-\s+(\S+)\s+(\S+)\s+.*?\+\s+(?:PLACED|FIXED)\s+\(\s*(-?\d+)\s+(-?\d+)\s*\)\s+(\S+)", sect):
        comps[m.group(1).replace("\\", "")] = (m.group(2), int(m.group(3)) / units, int(m.group(4)) / units)
    ports = {}
    sect = text[text.index("\nPINS"):text.index("END PINS")]
    for m in re.finditer(r"-\s+(\S+)\s+\+\s+NET\s+\S+.*?DIRECTION\s+(\w+)", sect, re.S):
        ports[m.group(1).replace("\\", "")] = m.group(2)
    nets = {}
    sect = text[text.index("\nNETS"):text.index("END NETS")]
    for stmt in sect.split(";"):
        m = re.match(r"\s*-\s+(\S+)(.*)", stmt, re.S)
        if not m:
            continue
        conn = m.group(2).split("+")[0]
        nets[m.group(1).replace("\\", "")] = [(a.replace("\\", ""), b.replace("\\", "")) for a, b in
                                             re.findall(r"\(\s*(\S+)\s+(\S+)\s*\)", conn)]
    return comps, ports, nets


def base(cell):                       # sky130_fd_sc_hd__a21oi_2 -> a21oi
    return re.sub(r"_\d+$", "", cell.split("__")[-1])


class Netlist:
    def __init__(self, comps, ports, nets, lef_pins):
        self.comps, self.ports = comps, ports
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
                cell = comps[inst][0] if inst in comps else ""
                d = lef_pins.get(cell, {}).get(pin)
                if cell == "pe":                  # the PE macro's outputs
                    out = pin.startswith(("a_out", "sel_out", "ps_out"))
                else:
                    out = d == "OUTPUT" if d else pin in OUTPUT_PINS
                if out:
                    self.driver[net] = (inst, pin)
                else:
                    self.loads[net].append((inst, pin))

    def kind(self, inst):
        return base(self.comps[inst][0]) if inst in self.comps else ""

    def inputs(self, inst):
        return [n for p, n in self.pin_net[inst].items()
                if p not in OUTPUT_PINS and p != "CLK" and not p.startswith("VP") and not p.startswith("VG")]

    def outputs(self, inst):
        return [n for p, n in self.pin_net[inst].items() if p in OUTPUT_PINS]

    def is_buffer(self, inst):
        return self.kind(inst).startswith(BUFFERS) and not inst.startswith("clk")

    def forward_port(self, net, depth=4):
        """Follow buffers from net to an output port name, if any."""
        for _ in range(depth):
            for inst, pin in self.loads[net]:
                if inst == "PIN":
                    return pin
            nxt = [i for i, _ in self.loads[net] if i != "PIN" and self.is_buffer(i)]
            if not nxt:
                return None
            net = self.outputs(nxt[0])[0]
        return None

    def backward_port(self, net, depth=4):
        """Follow drivers back from net through buffers to an input port name."""
        for _ in range(depth):
            inst, pin = self.driver.get(net, (None, None))
            if inst == "PIN":
                return pin
            if inst is None or not self.is_buffer(inst):
                return None
            net = self.inputs(inst)[0]
        return None


def bit(name):
    m = re.search(r"\[(\d+)\]$", name)
    return int(m.group(1)) if m else None


def footprint(nl, inst, size):
    cell, x, y = nl.comps[inst]
    w, h = size.get(cell, (0, 0))
    return [round(x, 3), round(y, 3), round(w, 3), round(h, 3)]


def common_role(nl, inst):
    """Roles that don't depend on what the design computes."""
    k = nl.kind(inst)
    if k.startswith("fill"):
        return "filler", ""
    if k.startswith("decap"):
        return "decap", ""
    if k.startswith("tap"):
        return "tap", ""
    if k == "diode":
        return "antenna", ""
    if inst.startswith(("clkbuf", "clkload", "delaybuf")) or k in ("clkbuf", "clkinv"):
        return "clock", ""
    if inst.startswith("input"):
        return "io", "input buffer for " + (nl.backward_port(nl.inputs(inst)[0]) or "?")
    if inst.startswith("output"):
        return "io", "output buffer for " + (nl.forward_port(nl.outputs(inst)[0]) or "?")
    if inst.startswith(("max_cap", "wire", "fanout", "rebuffer", "split", "max_length")):
        return "repair", ""
    if k.startswith(("dlygate", "clkdlybuf", "dlymetal")) or inst.startswith("hold"):
        return "hold", ""
    return None


def classify_pe(nl, size):
    flops = [i for i in nl.comps if nl.kind(i).startswith("df")]
    roles = {}
    weight_flops = set()
    for f in flops:
        q = nl.pin_net[f].get("Q")
        port = nl.forward_port(q) if q else None
        if port and port.startswith("ps_out"):
            roles[f] = ("reg_ps", f"ps_out[{bit(port)}]")
        elif port and port.startswith("a_out"):
            roles[f] = ("reg_act", f"a_out[{bit(port)}]")
        elif port == "sel_out":
            roles[f] = ("reg_act", "sel_out")
        else:
            weight_flops.add(f)

    # forward-propagate which inputs reach each net through the logic
    A, S, W, P, L, R = 1, 2, 4, 8, 16, 32
    src = {"a_in": A, "sel_in": S, "ps_in": P, "w_in": L, "w_we": L, "w_bank": L, "rst": R}
    mask = defaultdict(int)
    work = deque()
    for net, (inst, pin) in nl.driver.items():
        if inst == "PIN":
            m = src.get(re.sub(r"\[\d+\]$", "", pin), 0)
            if m:
                mask[net] = m
                work.append(net)
        elif inst in weight_flops:
            mask[net] = W
            work.append(net)
    while work:
        net = work.popleft()
        for inst, pin in nl.loads[net]:
            if inst == "PIN" or nl.kind(inst).startswith("df") or pin == "CLK":
                continue
            m = 0
            for n in nl.inputs(inst):
                m |= mask[n]
            for o in nl.outputs(inst):
                if mask[o] | m != mask[o]:
                    mask[o] |= m
                    work.append(o)

    # weight flops: which w_in bit do they load?
    for f in weight_flops:
        d = nl.pin_net[f].get("D")
        seen, q, b = {d}, deque([(d, 0)]), None
        while q and b is None:
            net, depth = q.popleft()
            inst, pin = nl.driver.get(net, (None, None))
            if inst == "PIN":
                if pin.startswith("w_in"):
                    b = bit(pin)
                continue
            if inst is None or depth > 4 or nl.kind(inst).startswith("df"):
                continue
            for n in nl.inputs(inst):
                if n not in seen:
                    seen.add(n)
                    q.append((n, depth + 1))
        roles[f] = ("reg_w", f"weight bit {b}" if b is not None else "weight bit")

    for inst in nl.comps:
        if inst in roles or nl.kind(inst) == "":
            continue
        c = common_role(nl, inst)
        if c:
            roles[inst] = c
            continue
        m = 0
        for o in nl.outputs(inst):
            m |= mask[o]
        feeds = ", ".join(n for n, v in (("a_in", A), ("sel_in", S), ("weights", W), ("ps_in", P),
                                            ("w_in/w_we/w_bank", L), ("rst", R)) if m & v)
        if m & P:
            roles[inst] = ("adder", feeds)
        elif m & A:
            roles[inst] = ("mult", feeds)
        elif m & S and m & W:
            roles[inst] = ("select", feeds)
        elif m & (L | W):
            roles[inst] = ("wload", feeds)
        else:
            roles[inst] = ("misc", feeds)
    return roles


def top_register(nl, f):
    """Name a top-level flop by the RTL register its Q net still carries."""
    q = nl.pin_net[f].get("Q", "")
    if m := re.fullmatch(r"g_deskew\[(\d+)\]\.g_delay\.y_d\[(\d+)\]", q):
        n, i = int(m.group(1)), int(m.group(2))
        return "reg_deskew", f"column {n}, stage {i // 32 + 1} of {7 - n}, bit {i % 32}"
    if m := re.fullmatch(r"g_skew\[(\d+)\]\.g_delay\.a_d\[(\d+)\]", q):
        k, i = int(m.group(1)), int(m.group(2))
        return "reg_skew", f"lane {k}, stage {i // 8 + 1} of {k}, bit {i % 8}"
    if m := re.fullmatch(r"g_skew\[(\d+)\]\.g_delay\.s_d\[(\d+)\]", q):
        k, i = int(m.group(1)), int(m.group(2))
        return "reg_skew", f"lane {k} bank select, stage {i + 1} of {k}"
    if m := re.fullmatch(r"a_h\[(\d+)\]", q):                 # last skew stage, into PE[k][0]
        k, i = int(m.group(1)) // 72, int(m.group(1))
        return "reg_skew", f"lane {k}, stage {k} of {k} (into PE[{k}][0]), bit {i % 8}"
    if m := re.fullmatch(r"t_d\[(\d+)\]", q):
        i = int(m.group(1))
        return "reg_valid", f"tag, stage {i // 8 + 1} of 15, bit {i % 8}"
    if m := re.fullmatch(r"v_d\[(\d+)\]", q):
        return "reg_valid", f"valid, stage {int(m.group(1)) + 1} of 15"
    port = nl.forward_port(q) or ""
    if port.startswith("out_y"):
        n, b = bit(port) // 32, bit(port) % 32
        return "reg_deskew", f"column {n}, stage {7 - n} of {7 - n} (drives out_y), bit {b}"
    if port.startswith("out_tag"):
        return "reg_valid", f"tag, stage 15 of 15 (drives out_tag), bit {bit(port)}"
    if port == "out_valid":
        return "reg_valid", "valid, stage 15 of 15 (drives out_valid)"
    for inst, pin in nl.loads.get(q, []):                      # final skew stage of sel
        if inst in nl.comps and nl.comps[inst][0] == "pe":
            k = re.search(r"g_row\[(\d+)\]", inst)
            return "reg_skew", f"lane {k.group(1) if k else '?'}, last stage, into {pin} of PE"
    return "reg_misc", q


def classify_top(nl, size):
    roles = {f: top_register(nl, f) for f in nl.comps if nl.kind(f).startswith("df")}

    # the reset net and the buffer tree that fans it out to ~1,300 gates
    rst_nets, work = set(), deque(n for n, (i, p) in nl.driver.items() if i == "PIN" and p == "rst")
    while work:
        net = work.popleft()
        rst_nets.add(net)
        for inst, _ in nl.loads[net]:
            if inst != "PIN" and nl.kind(inst).startswith(BUFFERS):
                work.extend(o for o in nl.outputs(inst) if o not in rst_nets)

    for inst in nl.comps:
        if inst in roles or nl.comps[inst][0] == "pe":
            continue
        k = nl.kind(inst)
        if k.startswith(("fill", "decap", "tap")):
            continue
        ins = nl.inputs(inst)
        if k.startswith(BUFFERS) and ins and ins[0] in rst_nets and not inst.startswith("input"):
            roles[inst] = ("rsttree", "")
            continue
        c = common_role(nl, inst)
        if c:
            roles[inst] = c
        elif k == "conb":
            roles[inst] = ("tie", "constant 0 into a top-row PE's ps_in")
        elif any(n in rst_nets for n in ins):
            roles[inst] = ("reset", "")
        elif k.startswith(BUFFERS):
            outs = nl.outputs(inst)
            to_reg = outs and any(nl.kind(i).startswith("df") for i, _ in nl.loads[outs[0]] if i != "PIN")
            roles[inst] = ("regbuf" if to_reg else "repair", "")
        else:
            roles[inst] = ("decode", "")
    return roles


def write(path, nl, roles, size, keep_names):
    types, rlist, details, cells = [], [], [], []
    idx = lambda lst, v: lst.index(v) if v in lst else (lst.append(v) or len(lst) - 1)
    for inst, (role, detail) in sorted(roles.items(), key=lambda kv: nl.comps[kv[0]][1:]):
        name = inst if keep_names and role not in ("filler", "decap", "tap") else ""
        cells.append(footprint(nl, inst, size) +
                     [idx(types, nl.comps[inst][0].split("__")[-1]), idx(rlist, role), idx(details, detail), name])
    json.dump({"types": types, "roles": rlist, "details": details, "cells": cells},
              open(path, "w"), separators=(",", ":"))
    counts = defaultdict(int)
    for r, _ in roles.values():
        counts[r] += 1
    print(path, len(cells), dict(sorted(counts.items(), key=lambda kv: -kv[1])))


def main():
    lef, pe_def, top_def, out = sys.argv[1:5]
    size, lef_pins = parse_lef(lef)
    comps, ports, nets = parse_def(pe_def)
    nl = Netlist(comps, ports, nets, lef_pins)
    write(f"{out}/cells_pe.json", nl, classify_pe(nl, size), size, True)
    comps, ports, nets = parse_def(top_def)
    nl = Netlist(comps, ports, nets, lef_pins)
    write(f"{out}/cells_top.json", nl, classify_top(nl, size), size, True)


if __name__ == "__main__":
    main()
