# portfolio

Rayan Benaoussar's project site: a static page, no build step. React 18 and
three.js load from CDNs through an import map (`index.html`), and JSX is
written with `htm` tagged templates.

- `index.html`: shell, fonts, import map
- `app.js`: page sections and copy (every number comes from a repo: riscv-core, systolic-accel, simt-gpu, int8-gemm-cuda)
- `viz.js`: the interactive explainers (pipeline hazards, systolic wavefront, SIMT divergence with min-PC scheduling, coalescing, roofline, die loupe)
- `chip.js`: the hero, the tiled systolic-array GDS render on a 3D package, with a shader that runs the array's dataflow (activations right, partial sums down, skewed per PE) plus bloom
- `gpu_die.js`: the SIMT-core die shots, written by `simt-gpu/openlane/make_gpu_die.py`
- `assets/`: JPEG copies of the KLayout renders
- `notes/`: the CPU and GPU write-ups

Preview locally with any static server, for example from `internship/`:

```bash
python -m http.server 8378
```

then open http://localhost:8378/portfolio/. Deploying is just uploading the
folder (e.g. `vercel deploy --prod` inside it).
