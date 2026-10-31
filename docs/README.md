# portfolio

Rayan Benaoussar's project site: a static page, no build step. React 18 and
three.js load from CDNs through an import map (`index.html`), and JSX is
written with `htm` tagged templates.

- `index.html`: shell, fonts, import map
- `app.js`: the hero, one tab per project (title and headline results; clicking opens the full write-up, diagrams and layout renders, and `#ew`, `#cpu`, `#tpu`, `#gpu`, `#cuda` open a tab directly); copy (every number comes from a project folder: ew-decoder, riscv-core, systolic-accel, simt-gpu, int8-gemm-cuda)
- `layouts.js`: the SKY130 layout table, one row per run
- `viz.js`: the interactive explainers (pipeline hazards, systolic wavefront, SIMT divergence with min-PC scheduling, coalescing, roofline, die loupe)
- `hero3d.js`: the hero, the LLM weight decoder's routed SKY130 layout: every cell where the placer put it and every met1–met5 wire, coloured by function, with a shader that runs the decode cycle one 8-weight chunk per beat (tile registers → lanes → output registers; escaping lanes pull their byte from the window, at the measured 2.81% escape rate). Its data, `assets/hero_decoder.json` and `.bin`, comes from `ew-decoder/openlane/build_hero.py`
- `ew_die.js`, `cpu_die.js`, `gpu_die.js`: die-shot tabs, written by `ew-decoder/openlane/make_die.py`, `riscv-core/openlane/make_die.py` and `simt-gpu/openlane/make_gpu_die.py`
- `assets/`: JPEG copies of the KLayout renders (full-resolution renders stay in each project's `openlane/` results)
- `notes/`: the CPU and GPU write-ups

Preview locally with any static server, for example from `internship/`:

```bash
python -m http.server 8378
```

then open http://localhost:8378/portfolio/.
