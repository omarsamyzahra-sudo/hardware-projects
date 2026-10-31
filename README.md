# portfolio

Rayan Benaoussar's project site: a static page, no build step. React 18 and
three.js load from CDNs through an import map (`index.html`), and JSX is
written with `htm` tagged templates.

- `index.html`: shell, fonts, import map
- `app.js`: page sections and copy (every number comes from a project folder: ew-decoder, riscv-core, systolic-accel, simt-gpu, int8-gemm-cuda)
- `layouts.js`: the SKY130 layout table, one row per run
- `viz.js`: the interactive explainers (pipeline hazards, systolic wavefront, SIMT divergence with min-PC scheduling, coalescing, roofline, die loupe)
- `chip.js`: the hero, the tiled systolic-array GDS render on a 3D package, with a shader that runs the array's dataflow (activations right, partial sums down, skewed per PE) plus bloom
- `ew_die.js`, `cpu_die.js`, `gpu_die.js`: die-shot tabs, written by `ew-decoder/openlane/make_die.py`, `riscv-core/openlane/make_die.py` and `simt-gpu/openlane/make_gpu_die.py`
- `assets/`: JPEG copies of the KLayout renders (full-resolution renders stay in each project's `openlane/` results)
- `notes/`: the CPU and GPU write-ups

Preview locally with any static server, for example from `internship/`:

```bash
python -m http.server 8378
```

then open http://localhost:8378/portfolio/.
