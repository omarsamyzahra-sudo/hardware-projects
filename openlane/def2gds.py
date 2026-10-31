# def2gds.py — the placed DEF (no routing yet) as a GDS, for render.py (run with klayout -zz)
#
#   klayout -zz -rd def=<def> -rd pdk=<sky130A dir> -rd out=<gds> -r def2gds.py
#
# Standard cells come from the PDK's GDS, the power grid from the DEF's
# special nets; layer numbers from the PDK's KLayout map. Used when the
# flow stops before routing finishes, so the die can still be shown as
# placed (and labeled that way).
import pya

ref = pdk + "/libs.ref/sky130_fd_sc_hd"
opt = pya.LoadLayoutOptions()
lc = opt.lefdef_config
lc.read_lef_with_def = False
lc.lef_files = [ref + "/techlef/sky130_fd_sc_hd__nom.tlef", ref + "/lef/sky130_fd_sc_hd.lef",
                ref + "/lef/sky130_ef_sc_hd.lef"]
lc.macro_layout_files = [ref + "/gds/sky130_fd_sc_hd.gds"]
lc.map_file = pdk + "/libs.tech/klayout/tech/sky130A.map"
ly = pya.Layout()
ly.read(globals()["def"], opt)                  # "def" is a Python keyword
ly.write(out)
print("wrote", out, "top", ly.top_cell().name)
