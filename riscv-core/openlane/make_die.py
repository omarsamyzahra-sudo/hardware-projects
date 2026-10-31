"""make_die.py — portfolio die tab for the hardened core (after run.sh and render.sh).

Writes portfolio/assets/cpu_die.jpg and portfolio/cpu_die.js; every number
comes from results/metrics.json and the clock in config.json.
"""

import json
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
PORT = HERE.parent.parent / "portfolio"


def main():
    m = json.loads((HERE / "results" / "metrics.json").read_text())
    period = json.loads((HERE / "config.json").read_text())["CLOCK_PERIOD"]
    fmax = lambda c: round(1000 / (period - m[f"timing__setup__ws__corner:{c}"]))
    die = [float(v) for v in m["design__die__bbox"].split()]
    drc = int(m["magic__drc_error__count"]) + int(m["klayout__drc_error__count"])
    im = Image.open(HERE / "results" / "die.png").convert("RGB")
    im.thumbnail((2000, 2000), Image.LANCZOS)
    im.save(PORT / "assets" / "cpu_die.jpg", quality=86, optimize=True, progressive=True)
    tab = {"tab": "RISC-V CPU", "src": "assets/cpu_die.jpg", "alt": "Layout of the 5-stage RV32I pipeline on SKY130",
           "title": "5-stage RV32I pipeline",
           "desc": "The CPU from the first section, hardened on its own: register file, forwarding network, CSRs and "
                   "the pipeline registers, placed and routed. The same core drives the systolic array in its SoC, "
                   "and a copy extended with a custom-0 coprocessor port drives the weight decoder.",
           "specs": [["die", f"{die[2] - die[0]:.0f} × {die[3] - die[1]:.0f} µm"],
                     ["cells", f"{int(m['design__instance__count__stdcell']):,}"],
                     ["fmax (tt / ss)", f"~{fmax('nom_tt_025C_1v80')} / ~{fmax('nom_ss_100C_1v60')} MHz"],
                     ["DRC · LVS · antenna", f"{drc} · {int(m['design__lvs_error__count'])} · "
                                             f"{int(m['antenna__violating__nets'])}"]]}
    (PORT / "cpu_die.js").write_text("// written by riscv-core/openlane/make_die.py\nexport const CPU_DIE = "
                                     + json.dumps([tab], ensure_ascii=False, indent=1) + ";\n", encoding="utf8")
    print("wrote", PORT / "cpu_die.js", tab["specs"])


if __name__ == "__main__":
    main()
