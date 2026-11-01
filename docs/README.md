# portfolio

Rayan Benaoussar's project site: a static page, no build step. React 18 and
three.js load from CDNs through an import map (`index.html`), and JSX is
written with `htm` tagged templates.

- `index.html`: shell, fonts, import map
- `app.js`: the hero, one tab per project (title and headline results; clicking opens the full write-up, diagrams and layout renders, and `#ew`, `#cpu`, `#tpu`, `#gpu`, `#cuda` open a tab directly); copy (every number comes from a project folder: ew-decoder, riscv-core, systolic-accel, simt-gpu, int8-gemm-cuda)
- `layouts.js`: the SKY130 layout table, one row per run
- `viz.js`: the interactive explainers (pipeline hazards, systolic wavefront, SIMT divergence with min-PC scheduling, coalescing, roofline, die loupe)
- `hero_engine.js`: the hero, the whole engine's SKY130 layout (2.8 mm die) as a map of 128 × 128 columns, each coloured by the engine block that owns most of its logic (memory streams, decoder, activation buffer, multipliers, adder tree, accumulator and output). Storage is drawn low and the compute blocks as towers; a wave runs through the blocks in dataflow order and arcs carry it between them. No post-processing (a bloom pass cost more than the scene on a laptop GPU), and the render resolution drops if a GPU can't hold ~40 fps. The data, `assets/hero_engine.json` and `.bin`, comes from `ew-decoder/openlane/build_hero_engine.py`; `assets/hero_engine_flat.jpg` is the same map flat, shown when WebGL is off
- `vendor/three-hero.js`: the parts of three.js 0.160 the heroes use, bundled and minified into one same-origin file (~104 kB brotli) from `vendor/three-hero.src.js` (build command in that file), so the hero doesn't wait on a chain of CDN modules. `app.js` starts loading the hero's code and data before React mounts, and `index.html` preloads them
- `hero3d.js`: the earlier hero, still at `?hero=decoder`: the LLM weight decoder's routed SKY130 layout in the 3D viewer's default layer colours: n-well, diffusion, poly and li1 as one image (`assets/hero_decoder_base.jpg`, from `ew-decoder/openlane/hero_base.py`), every met1–met5 wire where the router put it, and the met4/met5 power grid. A shader runs the decode cycle one 8-weight chunk per beat, brightening each wire when the cell driving it fires (tile registers → lanes → output registers; escaping lanes pull their byte from the window, at the measured 2.81% escape rate). Wire and cell data, `assets/hero_decoder.json` and `.bin`, come from `ew-decoder/openlane/build_hero.py`
- `ew_die.js`, `cpu_die.js`, `gpu_die.js`: die-shot tabs, written by `ew-decoder/openlane/make_die.py`, `riscv-core/openlane/make_die.py` and `simt-gpu/openlane/make_gpu_die.py`
- `assets/`: JPEG copies of the KLayout renders (full-resolution renders stay in each project's `openlane/` results)
- `notes/`: the CPU and GPU write-ups

Preview locally with any static server, for example from `internship/`:

```bash
python -m http.server 8378
```

then open http://localhost:8378/portfolio/.
