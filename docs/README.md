# portfolio

Rayan Benaoussar's project site: a static page, no build step. React 18 and
three.js load from CDNs through an import map (`index.html`), and JSX is
written with `htm` tagged templates.

- `index.html`: shell, fonts, import map
- `app.js`: the hero, one tab per project (title and headline results; clicking opens the full write-up, diagrams and layout renders, and `#ew`, `#cpu`, `#tpu`, `#gpu`, `#cuda` open a tab directly) and the contact footer; copy (every number comes from a project folder: ew-decoder, riscv-core, systolic-accel, simt-gpu, int8-gemm-cuda)
- `layouts.js`: the SKY130 layout table, one row per run
- `viz.js`: the interactive explainers (pipeline hazards, systolic wavefront, SIMT divergence with min-PC scheduling, coalescing, roofline, die loupe)
- `hero3d.js`: the hero, the tiled 8x8 systolic array from the 3D layout model at full-die scale (every logic cell placed and coloured by function, under the met4/met5 grid), with a shader that runs the array's dataflow: activations right, partial sums down, each PE firing on the skewed diagonal wavefront. Its data, `assets/hero_array.json`, comes from `systolic-accel/openlane/viewer3d/build_hero.py`
- `ew_die.js`, `cpu_die.js`, `gpu_die.js`: die-shot tabs, written by `ew-decoder/openlane/make_die.py`, `riscv-core/openlane/make_die.py` and `simt-gpu/openlane/make_gpu_die.py`
- `assets/`: JPEG copies of the KLayout renders (full-resolution renders stay in each project's `openlane/` results)
- `notes/`: the CPU and GPU write-ups

Preview locally with any static server, for example from `internship/`:

```bash
python -m http.server 8378
```

then open http://localhost:8378/portfolio/.
