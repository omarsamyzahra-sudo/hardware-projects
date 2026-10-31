# render.py — die shot of the hardened array from its GDS (run with klayout -zz)
#
#   klayout -zz -rd gds=<gds> -rd lyp=<sky130A.lyp> -rd out=<dir> -r render.py
#
# die.png:      whole block, metal stack only in a "die photo" palette
#               (the PDK colors turn into a solid wash at this zoom)
# mid.png:      a 250 um window at the center, same palette
# closeup.png:  a 60 um window at the center with the full SKY130 layer colors
import pya

# (name, gds layer/datatype, color, dither: 0 solid, 2 half-dotted) — first
# entry is drawn on top; the met4/met5 power grid is dotted to see through it
STACK = [
    ("met5", 72, 20, 0xd9822b, 2),
    ("met4", 71, 20, 0xe8c547, 2),
    ("met3", 70, 20, 0x4fbf6a, 0),
    ("met2", 69, 20, 0x9b59d0, 0),
    ("met1", 68, 20, 0x3d7fe0, 0),
    ("li1", 67, 20, 0x2bb3b3, 0),
    ("poly", 66, 20, 0xb03030, 0),
    ("diff", 65, 20, 0x2e5d2e, 0),
]


def view():
    lv = pya.LayoutView()
    for k, v in (("background-color", "#000000"), ("grid-visible", "false"),
                 ("text-visible", "false"), ("cell-box-visible", "false"),
                 ("bitmap-oversampling", "3")):
        lv.set_config(k, v)
    lv.load_layout(gds, 0)
    lv.max_hier()
    return lv


lv = view()
lv.clear_layers()
for name, l, d, col, dith in STACK:
    p = pya.LayerPropertiesNode()
    p.source = f"{l}/{d}@1"
    p.name = name
    p.fill_color = p.frame_color = col
    p.dither_pattern = dith
    p.width = 0
    lv.insert_layer(lv.end_layers(), p)
lv.zoom_fit()
lv.save_image(out + "/die.png", 4000, 4000)
b = lv.active_cellview().cell.dbbox()
m, h = b.center(), 125.0
lv.zoom_box(pya.DBox(m.x - h, m.y - h, m.x + h, m.y + h))
lv.save_image(out + "/mid.png", 3000, 3000)

lv = view()
lv.load_layer_props(lyp)
box = lv.active_cellview().cell.dbbox()
c, h = box.center(), 30.0
lv.zoom_box(pya.DBox(c.x - h, c.y - h, c.x + h, c.y + h))
lv.save_image(out + "/closeup.png", 2400, 2400)
print("die", box.width(), "x", box.height(), "um")
