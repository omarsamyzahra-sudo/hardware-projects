# hero_base.py — the portfolio hero's base texture: the decoder's layers below metal 1, top down
#
#   klayout -zz -rd gds=<weight_decoder.gds> -rd out=<hero_decoder_base.jpg> -r openlane/hero_base.py
#
# n-well, diffusion, taps, poly and li1, each painted in the 3D viewer's false colour
# (systolic-accel/openlane/viewer3d) and stacked with partial opacity, the way layout tools show
# them. At the hero's scale these shapes are below a pixel, so they go in as one image under the
# met1-met5 wires (build_hero.py) instead of as geometry. 3 px per micron.
import pya

PX = 3
LAYERS = [  # name, (gds layer, datatype), colour, opacity; bottom to top
    ("nwell", (64, 20), "#39407a", 0.45), ("diff", (65, 20), "#3f9142", 0.8), ("tap", (65, 44), "#2c6b30", 0.8),
    ("poly", (66, 20), "#d4483e", 0.9), ("li1", (67, 20), "#3fb8c4", 0.32),
]

ly = pya.Layout()
ly.read(gds)
top = ly.top_cell()
box = top.dbbox()
w, h = int(box.width() * PX + 0.5), int(box.height() * PX + 0.5)

img = pya.QImage(w, h, pya.QImage.Format_RGB32)
img.fill(pya.QColor("#0b0f16"))
out_p = pya.QPainter(img)
for name, (l, d), colour, alpha in LAYERS:
    li = ly.find_layer(l, d)
    if li is None:
        continue
    layer = pya.QImage(w, h, pya.QImage.Format_ARGB32_Premultiplied)
    layer.fill(pya.QColor(0, 0, 0, 0))
    p = pya.QPainter(layer)
    p.setRenderHint(pya.QPainter.Antialiasing, True)
    p.setPen(pya.QPen(pya.Qt.NoPen))
    p.setBrush(pya.QBrush(pya.QColor(colour)))
    region = pya.Region(top.begin_shapes_rec(li)).merged().decompose_trapezoids_to_region(pya.Polygon.TD_htrapezoids)
    for poly in region.each():
        if poly.is_box():
            b = poly.bbox().to_dtype(ly.dbu)
            p.drawRect(pya.QRectF((b.left - box.left) * PX, (box.top - b.top) * PX, b.width() * PX, b.height() * PX))
        else:
            p.drawPolygon(pya.QPolygonF([pya.QPointF((pt.x * ly.dbu - box.left) * PX, (box.top - pt.y * ly.dbu) * PX)
                                         for pt in poly.each_point_hull()]))
    p.end()
    out_p.setOpacity(alpha)
    out_p.drawImage(0, 0, layer)
    print(name, region.count())
out_p.end()
img.save(out, "JPG", 82)
print("wrote", out, w, "x", h)
