"""build_pyramid.py: slice render_chunks.py output into a DZI tile pyramid for the site's die viewer.

    python -I build_pyramid.py <chunks dir> <out dir>

Writes <out>/<level>/<col>_<row>.webp: 1024 px tiles, no overlap, DZI level numbering. Each tile is
kept as whichever is smaller, a lossless 32-color WebP (the flat layout colors up close; 32 look
the same as 256) or a lossy q60 WebP (the noise-like far-out levels). Big tiles keep the file count low: Vercel's free
plan caps a deploy at 15,000 files and 5,000 uploads a day.

The two deepest levels come from each 2048 px chunk; the rest from the stitched second level.
Chunk edges sit on 2048 px boundaries, so ceil-halving stays consistent between chunks."""
import io, json, math, os, shutil, sys, time
from concurrent.futures import ProcessPoolExecutor
from PIL import Image

T, C = 1024, 2048
half = lambda im: im.resize((math.ceil(im.width / 2), math.ceil(im.height / 2)), Image.BOX)


def encode(args):
    path, raw, size = args
    im = Image.frombytes("RGB", size, raw)
    a, b = io.BytesIO(), io.BytesIO()
    im.quantize(32, dither=Image.Dither.NONE).save(a, "WEBP", lossless=True, method=4)
    im.save(b, "WEBP", quality=60, method=4)
    data = min(a.getvalue(), b.getvalue(), key=len)
    with open(path, "wb") as f: f.write(data)
    return len(data)


def tiles(im, level, ox, oy, out, jobs):
    d = os.path.join(out, str(level)); os.makedirs(d, exist_ok=True)
    for y in range(0, im.height, T):
        for x in range(0, im.width, T):
            t = im.crop((x, y, min(x + T, im.width), min(y + T, im.height)))
            jobs.append((os.path.join(d, f"{(ox + x) // T}_{(oy + y) // T}.webp"), t.tobytes(), t.size))


def main(src, out):
    W, H, um_px, w_um, h_um = open(os.path.join(src, "meta.txt")).read().split()
    W, H, um_px = int(W), int(H), float(um_px)
    top = math.ceil(math.log2(max(W, H)))
    if os.path.isdir(out):                            # drop the levels of an earlier, bigger build
        for d in os.listdir(out):
            if d.isdigit(): shutil.rmtree(os.path.join(out, d))
    nx, ny = math.ceil(W / C), math.ceil(H / C)
    t0, jobs, sizes = time.time(), [], []
    with ProcessPoolExecutor() as pool:
        second = Image.new("RGB", (math.ceil(W / 2), math.ceil(H / 2)))
        for j in range(ny):
            for i in range(nx):
                im = Image.open(os.path.join(src, f"c_{i}_{j}.png")).convert("RGB")
                im = im.crop((0, 0, min(C, W - i * C), min(C, H - j * C)))
                tiles(im, top, i * C, j * C, out, jobs)
                second.paste(half(im), (i * C // 2, j * C // 2))
            sizes += pool.map(encode, jobs, chunksize=4); jobs = []
        im, level = second, top - 1
        while level >= 0:
            tiles(im, level, 0, 0, out, jobs)
            im, level = half(im), level - 1
        sizes += pool.map(encode, jobs, chunksize=2)
    info = {"width": W, "height": H, "um": [float(w_um), float(h_um)], "nm_px": round(um_px * 1000, 2),
            "tiles": len(sizes), "mb": round(sum(sizes) / 1e6, 2)}
    print(json.dumps(info), f"{time.time() - t0:.0f} s")
    with open(os.path.join(out, "info.json"), "w") as f: json.dump(info, f)


if __name__ == "__main__":
    main(*sys.argv[1:3])
