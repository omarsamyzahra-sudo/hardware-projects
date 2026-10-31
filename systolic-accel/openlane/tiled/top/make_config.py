"""make_config.py — top-level LibreLane config: 64 PE macros on an 8x8 grid.

PE[k][n] sits in column n, row k from the top (partial sums flow down,
activations flow right, as in systolic_array.sv). Tiles are 180 um with
40 um routing channels between them; the skew/deskew/valid registers are
placed by the tool in the channels and the margin.
"""
import json
from pathlib import Path

N, TILE, PITCH, MARGIN = 8, 180, 220, 120
CORNERS = [f"{m}_{c}" for m in ("min", "nom", "max")
           for c in ("tt_025C_1v80", "ss_100C_1v60", "ff_n40C_1v95")]
DIE = 2 * MARGIN + (N - 1) * PITCH + TILE          # 1960 um

instances = {
    f"g_row[{k}].g_col[{n}].u_pe": {
        "location": [MARGIN + n * PITCH, MARGIN + (N - 1 - k) * PITCH],
        "orientation": "N",
    }
    for k in range(N) for n in range(N)
}
cfg = {
    "DESIGN_NAME": "systolic_array",
    "VERILOG_FILES": ["dir::../../../rtl/systolic_array.sv"],
    "USE_SLANG": True,
    "CLOCK_PORT": "clk",
    "CLOCK_PERIOD": 20,
    "SYNTH_STRATEGY": "DELAY 4",
    "FP_SIZING": "absolute",
    "DIE_AREA": [0, 0, DIE, DIE],
    "IO_PIN_ORDER_CFG": "dir::pin_order.cfg",
    "VERILOG_POWER_DEFINE": "USE_POWER_PINS",
    "PDN_MACRO_CONNECTIONS": [r"g_row.*u_pe VPWR VGND VPWR VGND"],
    "MACROS": {
        "pe": {
            "instances": instances,
            "vh": ["dir::pe.vh"],
            "gds": ["dir::macro/pe.gds"],
            "lef": ["dir::macro/pe.lef"],
            "nl": ["dir::macro/pe.nl.v"],
            # per-corner views, so STA times through each PE at the same
            # corner as the top level (a tt-only lib caused false ss hold fails)
            "spef": {f"{c}_*": [f"dir::macro/pe.{c}.spef"] for c in ("min", "nom", "max")},
            "lib": {c: [f"dir::macro/pe__{c}.lib"] for c in CORNERS},
        }
    },
    "PDK": "sky130A",
    "STD_CELL_LIBRARY": "sky130_fd_sc_hd",
}
Path(__file__).with_name("config.json").write_text(json.dumps(cfg, indent=4) + "\n")
print("die", DIE, "um,", len(instances), "PE instances")
