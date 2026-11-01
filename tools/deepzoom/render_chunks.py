# render_chunks.py: the deepest level of a die's deep-zoom pyramid, in 2048 px chunks (klayout -zz)
#
#   klayout -zz -rd gds=<gds> -rd out=<dir> -rd w=<px across> [-rd cell=<name>] [-rd drop=<name>] -r render_chunks.py
#
# w     width of the deepest level in pixels (height follows the bbox)
# cell  render this cell instead of the top cell (the tiled TPU's PE macro)
# drop  hide this cell (the tiled TPU's top level without its 64 PEs)
#
# Palette: the STACK of the die renders. KLayout draws the LAST layer on top, so diffusion
# covers everything and the die reads green from afar; a derived gate layer (poly AND diff)
# goes over it so transistor channels show up close. Below ~60 nm per pixel the gates are too small
# to see and their 1 px outlines would tint the whole die red, so coarse renders leave it out.
import pya, math, time
STACK = [("met5",72,0xd9822b,2),("met4",71,0xe8c547,2),("met3",70,0x4fbf6a,0),("met2",69,0x9b59d0,0),
         ("met1",68,0x3d7fe0,0),("li1",67,0x2bb3b3,0),("poly",66,0xb03030,0),("diff",65,0x2e5d2e,0)]
C = 2048
W = int(w)
lv = pya.LayoutView()
for k, v in (("background-color","#000000"),("grid-visible","false"),("text-visible","false"),
             ("cell-box-visible","false"),("bitmap-oversampling","3")):
    lv.set_config(k, v)
lv.load_layout(gds, 0)
cv = lv.active_cellview(); ly = cv.layout()
if "cell" in globals(): cv.cell_name = cell
top = cv.cell
def shapes(l):
    it = top.begin_shapes_rec(ly.layer(l, 20))
    if "drop" in globals(): it.unselect_cells(drop)
    return pya.Region(it)
if "drop" in globals(): lv.hide_cell(ly.cell_by_name(drop), cv.index())
lv.max_hier()
gate = shapes(66) & shapes(65)
top.shapes(ly.layer(300, 0)).insert(gate)
lv.clear_layers()
for name, l, col, di in STACK:
    p = pya.LayerPropertiesNode(); p.source = f"{l}/20@1"; p.name = name
    p.fill_color = p.frame_color = col; p.dither_pattern = di; p.width = 0
    lv.insert_layer(lv.end_layers(), p)
b = top.dbbox(); s = b.width() / W; H = math.ceil(b.height() / s)
if s <= 0.06:
    p = pya.LayerPropertiesNode(); p.source = "300/0@1"; p.name = "gate"
    p.fill_color = 0x3e5a2a; p.frame_color = 0xff5a5a; p.dither_pattern = 0; p.width = 1
    lv.insert_layer(lv.end_layers(), p)
nx, ny = math.ceil(W / C), math.ceil(H / C)
print(top.name, "bbox", b, "um/px", s, "size", W, H, "chunks", nx, ny, "gates", gate.count() if s <= 0.06 else "off")
t = time.time()
for j in range(ny):
    for i in range(nx):
        x0, y1 = b.left + i * C * s, b.top - j * C * s
        lv.zoom_box(pya.DBox(x0, y1 - C * s, x0 + C * s, y1))
        lv.save_image(f"{out}/c_{i}_{j}.png", C, C)
print("rendered in", round(time.time() - t), "s")
with open(f"{out}/meta.txt", "w") as f: f.write(f"{W} {H} {s} {b.width()} {b.height()}\n")
