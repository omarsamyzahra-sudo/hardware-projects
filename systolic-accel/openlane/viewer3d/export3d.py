# export3d.py — dump layout polygons per layer to JSON for the 3D viewer
# (run with klayout -zz)
#
#   klayout -zz -rd gds=<gds> -rd out=<json> -rd layers=a,b,... \
#           [-rd box=x0,y0,x1,y1] [-rd grid=n,margin,pitch,tile -rd cut=a,b,...] -r export3d.py
#
# box is in microns (default: the whole cell). Shapes are flattened, clipped
# to the box and merged per layer, so overlapping cell rails and wires become
# single polygons. grid describes an n x n array of macro footprints; on the
# layers listed in cut, everything inside those footprints is removed (the
# viewer draws the macro itself instead). Coordinates are microns relative
# to the box corner. Per layer: "r" is a flat list of axis-aligned rectangles
# (x0, y0, x1, y1, ...) and "p" a list of polygons, each [hull, hole, ...]
# with every ring a flat x, y list.
import json
import pya

GDS_LAYERS = {
    "nwell": (64, 20), "diff": (65, 20), "tap": (65, 44), "poly": (66, 20),
    "licon": (66, 44), "li1": (67, 20), "mcon": (67, 44), "met1": (68, 20),
    "via": (68, 44), "met2": (69, 20), "via2": (69, 44), "met3": (70, 20),
    "via3": (70, 44), "met4": (71, 20), "via4": (71, 44), "met5": (72, 20),
}

ly = pya.Layout()
ly.read(gds)
top = ly.top_cell()
dbu = ly.dbu
um = lambda v: int(round(v / dbu))

if "box" in globals() and box:
    x0, y0, x1, y1 = (float(v) for v in box.split(","))
else:
    b = top.dbbox()
    x0, y0, x1, y1 = b.left, b.bottom, b.right, b.top
clip = pya.Region(pya.Box(um(x0), um(y0), um(x1), um(y1)))

holes_out = pya.Region()
cut_layers = set()
if "grid" in globals() and grid:
    n, margin, pitch, tile = (float(v) for v in grid.split(","))
    for i in range(int(n)):
        for j in range(int(n)):
            bx, by = margin + i * pitch, margin + j * pitch
            holes_out.insert(pya.Box(um(bx), um(by), um(bx + tile), um(by + tile)))
    cut_layers = set(cut.split(","))


def ring(points):
    flat = []
    for pt in points:
        flat += [round(pt.x * dbu - x0, 3), round(pt.y * dbu - y0, 3)]
    return flat


result = {"size": [round(x1 - x0, 3), round(y1 - y0, 3)], "layers": {}}
for name in layers.split(","):
    l, d = GDS_LAYERS[name]
    li = ly.find_layer(l, d)
    if li is None:
        continue
    reg = pya.Region(top.begin_shapes_rec(li)) & clip
    if name in cut_layers:
        reg -= holes_out
    reg.merge()
    rects, polys = [], []
    for p in reg.each():
        if p.is_box():
            bb = p.bbox()
            rects += [round(bb.left * dbu - x0, 3), round(bb.bottom * dbu - y0, 3),
                      round(bb.right * dbu - x0, 3), round(bb.top * dbu - y0, 3)]
        else:
            polys.append([ring(p.each_point_hull())] +
                         [ring(p.each_point_hole(h)) for h in range(p.holes())])
    result["layers"][name] = {"r": rects, "p": polys}
    print(name, len(rects) // 4, "rects", len(polys), "polys")
with open(out, "w") as f:
    json.dump(result, f, separators=(",", ":"))
