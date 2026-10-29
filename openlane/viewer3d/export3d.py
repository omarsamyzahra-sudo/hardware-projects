# export3d.py — dump layout polygons per layer to JSON for the 3D viewer
# (run with klayout -zz)
#
#   klayout -zz -rd gds=<gds> -rd out=<json> -rd box=x0,y0,x1,y1 -rd layers=a,b,... -r export3d.py
#
# box is in microns (omit for the whole cell). Shapes are flattened, clipped
# to the box and merged per layer, so overlapping cell rails and wires become
# single polygons. Coordinates are microns, relative to the box corner.
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
if "box" in globals() and box:
    x0, y0, x1, y1 = (float(v) for v in box.split(","))
else:
    b = top.dbbox()
    x0, y0, x1, y1 = b.left, b.bottom, b.right, b.top
clip = pya.Region(pya.Box(int(x0 / dbu), int(y0 / dbu), int(x1 / dbu), int(y1 / dbu)))

result = {"size": [round(x1 - x0, 3), round(y1 - y0, 3)], "layers": {}}
for name in layers.split(","):
    l, d = GDS_LAYERS[name]
    li = ly.find_layer(l, d)
    if li is None:
        continue
    reg = (pya.Region(top.begin_shapes_rec(li)) & clip).merged()
    polys = []
    for p in reg.each():
        pts = []
        for pt in p.each_point_hull():
            pts += [round(pt.x * dbu - x0, 3), round(pt.y * dbu - y0, 3)]
        polys.append(pts)
    result["layers"][name] = polys
    print(name, len(polys))
with open(out, "w") as f:
    json.dump(result, f, separators=(",", ":"))
