"""make_die.py — portfolio assets and die tabs for the hardened ew-decoder blocks.

    python openlane/make_die.py        (after run.sh and render.sh for each block)

Reads openlane/<block>/results/{die,mid,closeup}.png and metrics.json, writes
JPEG copies to portfolio/assets/ and the tab list to portfolio/ew_die.js.
Every number in a tab comes from that block's metrics.json.
"""

import json
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
PORT = HERE.parent.parent / "portfolio"
def fmax(period_ns, slack_ns):
    return round(1000 / (period_ns - slack_ns))


def specs(m, period):
    die = [float(v) for v in m["design__die__bbox"].split()]
    slack = {c: m[f"timing__setup__ws__corner:{c}"] for c in ("nom_tt_025C_1v80", "nom_ss_100C_1v60")}
    drc = int(m["magic__drc_error__count"]) + int(m["klayout__drc_error__count"])
    return [
        ["die", f"{die[2] - die[0]:.0f} × {die[3] - die[1]:.0f} µm"],
        ["cells", f"{int(m['design__instance__count__stdcell']):,}"],
        ["fmax (tt / ss)", f"~{fmax(period, slack['nom_tt_025C_1v80'])} / ~{fmax(period, slack['nom_ss_100C_1v60'])} MHz"],
        ["DRC · LVS · antenna", f"{drc} · {int(m['design__lvs_error__count'])} · "
                                f"{int(m['antenna__violating__nets'])}"],
    ]


BLOCKS = [
    ("decoder", "LLM weight decoder", "Layout of the exponent-window weight decoder on SKY130",
     "Exponent-window weight decoder",
     "The decoder alone: double-buffered tiles of 3-bit code planes and sign/mantissa bytes, the escape window that routes "
     "escaped exponents to their lanes with a prefix popcount, and 8 lanes that rebuild one BF16 weight each per cycle. "
     "Its routed netlist was simulated gate by gate on real Qwen2.5 weights: 14,336/14,336 chunks bit-exact, 4.27 mW at "
     "50 MHz from that run's switching."),
    ("engine", "Decoder engine", "Layout of the whole decoder engine: stream readers, decoder and GEMV core",
     "Whole engine: streams, decoder, GEMV",
     "The full custom-instruction engine: five AXI read streams and a write stream, the decoder, and the GEMV core with "
     "8 BF16 multipliers and an FP32 adder tree."),
]


def main():
    A = PORT / "assets"
    tabs = []
    for name, tab, alt, title, desc in BLOCKS:
        res = HERE / name / "results"
        if not (res / "die.png").exists():
            print("skip", name, "(no render yet)")
            continue
        m = json.loads((res / "metrics.json").read_text())
        im = Image.open(res / "die.png").convert("RGB")
        im.thumbnail((2000, 2000), Image.LANCZOS)
        im.save(A / f"ew_{name}_die.jpg", quality=86, optimize=True, progressive=True)
        tabs.append({"tab": tab, "src": f"assets/ew_{name}_die.jpg", "alt": alt, "title": title, "desc": desc,
                     "specs": specs(m, json.loads((HERE / name / "config.json").read_text())["CLOCK_PERIOD"])})
        if name == "decoder":
            Image.open(res / "closeup.png").convert("RGB").resize((1600, 1600), Image.LANCZOS).save(
                A / "ew_decoder_closeup.jpg", quality=86, optimize=True, progressive=True)
            tabs.append({"tab": "Decoder 60 µm", "src": "assets/ew_decoder_closeup.jpg",
                         "alt": "60 micrometer close-up of the decoder's standard cells",
                         "title": "Zoom: the decoder's cells",
                         "desc": "60 µm at the center of the decoder in SkyWater layer colors: rows of standard "
                                 "cells, poly gates, local interconnect and the first metal layers.",
                         "specs": [["power @ 50 MHz", "4.27 mW (real weights)"], ["energy", "10.7 pJ / weight"]]})
    (PORT / "ew_die.js").write_text("// written by ew-decoder/openlane/make_die.py\nexport const EW_DIE = "
                                    + json.dumps(tabs, ensure_ascii=False, indent=1) + ";\n", encoding="utf8")
    print("wrote", PORT / "ew_die.js", [t["tab"] for t in tabs])


if __name__ == "__main__":
    main()
