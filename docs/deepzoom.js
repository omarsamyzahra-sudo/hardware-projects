// Deep-zoom tile pyramids for the die tabs, keyed by the tab's src. Built from each GDS with
// tools/deepzoom (render_chunks.py in KLayout, then build_pyramid.py); w/h are the deepest level
// in pixels, um the rendered bbox (origin 0,0). A tab without an entry keeps its flat render and loupe.
//
// Detail is tiered to keep the site under Vercel's 100 MB deploy cap: the smaller dies go to
// transistor gates, the big flat array to cell rows.

// The tiled array's 64 PEs are one macro (cell "pe", 180 µm, all placed R0 on a 220 µm grid), so
// one deep render of it is drawn at every position over a coarser render of the top level alone.
const PE = { dir: "assets/tiles/pe", w: 8192, h: 8192, um: [180, 180] };
const GRID = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => 120 + 220 * k);

export const DEEP = {
  "assets/ew_decoder_die.jpg": { dir: "assets/tiles/decoder", w: 16384, h: 16859, um: [370.155, 380.875],
    reach: "single transistor gates (23 nm per pixel)" },
  "assets/cpu_die.jpg": { dir: "assets/tiles/cpu", w: 12288, h: 12520, um: [569.38, 580.1],
    reach: "transistor gates (46 nm per pixel)" },
  "assets/tpu_die_tiled.jpg": { dir: "assets/tiles/tputop", w: 16384, h: 16384, um: [1960, 1960],
    items: GRID.flatMap((x) => GRID.map((y) => ({ ...PE, x, y }))),
    reach: "transistor gates inside the PEs (22 nm per pixel; the channels between them stop at 120 nm)" },
  "assets/tpu_die_flat.jpg": { dir: "assets/tiles/flat", w: 4096, h: 4129, um: [1370.655, 1381.375],
    reach: "rows of standard cells (335 nm per pixel)" },
};
