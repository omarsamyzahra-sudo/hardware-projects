import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";
import { PipelineViz, SystolicViz, WarpViz, CoalesceViz, Bars, Roofline, DieExplorer } from "./viz.js";
import { GPU_DIE } from "./gpu_die.js";
import { EW_DIE } from "./ew_die.js";
import { CPU_DIE } from "./cpu_die.js";
import { LAYOUTS } from "./layouts.js";
const html = htm.bind(React.createElement);

const VIEWER = "https://systolic-array-3d.vercel.app";
const REPO = "https://github.com/withered24/hardware-projects";
const EMAIL = "rayanbenaoussar@gmail.com";
const src = (path) => `${REPO}/tree/main/${path}`;
const file = (path) => `${REPO}/blob/main/${path}`;

// measured on hardware, simulated, or estimated by a tool or model
const Tag = ({ k }) => html`<i class=${"tag " + k.split(" ")[0]}>${k}</i>`;

function Hero() {
  const canvas = useRef(null);
  const [ready, setReady] = useState(false);
  const [noGL, setNoGL] = useState(false);
  useEffect(() => {
    let stop = null, dead = false;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    (async () => {
      try {
        const [{ mountDecoder }, head, buf] = await Promise.all([import("./hero3d.js"),
          fetch("assets/hero_decoder.json").then((r) => r.json()), fetch("assets/hero_decoder.bin").then((r) => r.arrayBuffer())]);
        if (dead) return;
        stop = mountDecoder(canvas.current, { head, buf, baseUrl: "assets/hero_decoder_base.jpg", reducedMotion, onReady: () => setReady(true) });
        if (!stop) setNoGL(true);
      } catch (e) { console.warn(e); setNoGL(true); }
    })();
    return () => { dead = true; stop && stop(); };
  }, []);
  return html`<header class="hero" id="top">
    <canvas ref=${canvas} class=${"hero-canvas" + (ready ? " ready" : "")} aria-hidden="true"></canvas>
    ${noGL ? html`<div class="hero-fallback" aria-hidden="true"></div>` : null}
    <div class="hero-shade"></div>
    <div class="hero-inner wrap">
      <p class="over mono">Electrical Engineering + Mathematics · University of North Florida · ’28</p>
      <h1>Rayan<br/>Benaoussar</h1>
      <p class="lede">I build computers from the logic up: a <b>hardware decoder for compressed LLM weights</b>, a formally
        verified <b>RISC-V CPU</b>, an <b>int8 systolic-array accelerator</b>, a <b>SIMT GPU</b> and <b>CUDA kernels</b>, with the hardware
        taken to <b>SkyWater 130 nm layouts</b>.</p>
      <div class="cta">
        <a class="btn" href="#work">See the projects</a>
        <a class="btn-ghost" href=${REPO} target="_blank" rel="noopener">GitHub ↗</a>
        <a class="btn-ghost" href=${`mailto:${EMAIL}`}>Email</a>
      </div>
    </div>
    <div class="hero-cap small" aria-hidden="true">
      <b>My LLM weight decoder, laid out on SKY130 (0.37 mm)</b>
      <span class="cap-sub">The wires light up as it decodes, 8 weights per beat.</span>
      <div class="legend mono">
        <span><i class="l-si">●</i>transistors</span><span><i class="l-m1">●</i>met1</span><span><i class="l-m2">●</i>met2</span><span><i class="l-m3">●</i>met3</span><span><i class="l-pw">●</i>power</span>
      </div>
    </div>
  </header>`;
}

function Specs({ items }) {
  return html`<ul class="specs">${items.map(([k, v, tag]) => html`<li><b class="mono">${k}</b><span>${v}${tag ? html` <${Tag} k=${tag}/>` : null}</span></li>`)}</ul>`;
}

function Links({ items }) {
  return html`<div class="links-row">${items.map(([href, t]) => html`<a class="link" href=${href}
    target=${href.startsWith("http") ? "_blank" : null} rel="noopener">${t}</a>`)}</div>`;
}

function Viewer3D() {
  const [on, setOn] = useState(false);
  return html`<div class="viewer">
    ${on
      ? html`<iframe src=${VIEWER} title="3D layout viewer: systolic array on SKY130" loading="lazy" allow="fullscreen"></iframe>`
      : html`<button class="viewer-poster" onClick=${() => setOn(true)}>
          <img src="assets/tpu_closeup.jpg" alt="" loading="lazy"/>
          <span class="viewer-cta"><b>Launch the 3D layout viewer</b><span class="small">every metal layer, via and standard cell of a PE, in WebGL · ~6 MB</span></span>
        </button>`}
    <div class="viewer-bar small"><span class="mono">${VIEWER.replace("https://", "")}</span>
      <a href=${VIEWER} target="_blank" rel="noopener">Open full screen ↗</a></div>
  </div>`;
}

// the SKY130 runs for one project: a row each, then the KLayout renders
function Layout({ designs, shots, children }) {
  const rows = LAYOUTS.filter((l) => designs.includes(l.design));
  return html`<div class="layout-part">
    <h3 class="part-h"><i class="sw"></i>Layout on SkyWater 130 nm</h3>
    <div class="lt-wrap"><table class="lt">
      <thead><tr><th>block</th><th>cells</th><th>die</th><th>fmax tt / ss</th><th>DRC / LVS / antenna</th></tr></thead>
      <tbody>${rows.map((l) => html`<tr class=${l.pending ? "pending" : ""}>
        <td><b>${l.block}</b>${l.note ? html`<span class="small dim">${l.note}</span>` : null}</td>
        ${l.pending
          ? html`<td colspan="4"><span class="pill">Layout running</span> <span class="small dim">${l.pending}</span></td>`
          : html`<td class="mono">${l.cells}</td><td class="mono">${l.die}</td><td class="mono">${l.fmax}</td><td class="mono">${l.checks}</td>`}
      </tr>`)}</tbody>
    </table></div>
    <${DieExplorer} shots=${shots}/>
    ${children}
  </div>`;
}

const TPU_DIE = [
  { tab: "Tiled array", src: "assets/tpu_die_tiled.jpg", alt: "Layout of the 8x8 systolic array: 64 identical PE macros on a grid",
    title: "8×8 systolic array, hierarchical", desc: "One processing element hardened as a 180 µm macro, then 64 copies placed on a 220 µm grid so neighbors connect straight across: activations west→east, partial sums north→south. The top level adds the skew registers, clock tree and power grid around them. Open item: 39 slow-corner hold violations on top-level inputs, from the flow’s default I/O constraint.",
    specs: [["die", "1.96 × 1.96 mm"], ["cells", "64 macros + 22,832"], ["fmax (tt / ss)", "~102 / ~60 MHz"], ["DRC · LVS · antenna", "0 · 0 · 0"]] },
  { tab: "Flat array", src: "assets/tpu_die_flat.jpg", alt: "Flat-placed layout of the systolic array",
    title: "Same RTL, flat placement", desc: "The first run let the placer scatter all 64 PEs together. Smaller, but slower: long wires failed 50 MHz at the slow corner. Going hierarchical fixed it, which is the point of comparing both.",
    specs: [["die", "1.89 mm²"], ["cells", "108,707"], ["fmax (tt / ss)", "~84 / ~43 MHz"], ["DRC · LVS · antenna", "0 · 0 · 1"]] },
  { tab: "Array 250 µm", src: "assets/tpu_mid.jpg", alt: "250 micrometer window of the tiled array",
    title: "Zoom: PE macros and routing channels", desc: "A 250 µm window of the tiled layout: PE macros, the routing channels between them, and the met4/met5 power straps.",
    specs: [["metal", "met1–met5"], ["PE macro", "180 × 180 µm, 1,865 cells"], ["pitch", "220 µm"]] },
  { tab: "Array 60 µm", src: "assets/tpu_closeup.jpg", alt: "60 micrometer close-up of standard cells in SKY130 layer colors",
    title: "Zoom: standard cells", desc: "60 µm across, in the SkyWater layer colors: rows of standard cells, poly gates, local interconnect and the first metal layers.",
    specs: [["PDK", "SKY130A"], ["library", "sky130_fd_sc_hd"]] },
];

function EwDetail() {
  return html`<div class="proj-body">
      <div class="proj-text">
        <p>Generating one token at batch 1 reads every weight of the model once, so LLM decode is limited by memory, not math.
          BF16 exponents cluster in a narrow band, and <b>ZipServ’s exponent-window format</b> (TCA-TBE) exploits that: each exponent
          becomes a 3-bit offset from a base, with escapes for the rest, for <b>11.23 bits per weight instead of 16, losslessly</b>.
          GPUs decode it in software. I built the decoder in hardware: it rebuilds <b>8 BF16 weights per cycle</b> in front of a GEMV
          core, driven by <b>RISC-V custom-0 instructions</b>, and I swept the format variants that a hardware decoder makes cheap.</p>
        <${Bars} unit="cycles" rows=${[
          { label: "raw BF16", v: 3736792, cls: "muted" },
          { label: "compressed + decoder", v: 2622992, cls: "accent", tag: "1.42×" },
        ]} note="All 7 matrices of a real Qwen2.5-0.5B layer, cycle-accurate RTL simulation with memory limited to 8 B/cycle (half what raw BF16 needs). Ceiling 16 ÷ bits = 1.426×: the decoder reaches 99.9% of it, and every output is bit-exact."/>
        <${Specs} items=${[
          ["170/170", "weight matrices of Qwen2.5-0.5B round-trip bit-exact; 1.42× less memory", "measured"],
          ["sweep", "4, 8 and 16 lanes; 2-, 3- and 4-bit codes; per-tile bases: every point within 0.15% of its ceiling, 3-bit best, each one also laid out", "sim"],
          ["541/541", "functional-coverage bins over 6 builds, plus 10,000 random seeds", "sim"],
          ["14,336/14,336", "chunks bit-exact when the routed gate-level netlist decodes real weights", "sim"],
          ["~84 MHz", "decoder on SKY130 at the typical corner, 50 MHz at all corners after registering its output; 59,797 µm² of cells; 4.27 mW from real switching (10.7 pJ per weight)", "layout"],
          ["13–25%", "less weight-path energy per token, with HBM2 / GDDR5 energy from O’Connor et al., MICRO 2017", "estimate"],
          ["792 MiB", "peak GPU memory for the whole model running from compressed weights with my fused CUDA kernels (stock: 1,078), logits bit-identical", "measured"],
        ]}/>
        <${Links} items=${[[src("ew-decoder"), "Source ↗"], [file("ew-decoder/docs/RESULTS.md"), "All results ↗"],
          [file("ew-decoder/LEDGER.md"), "Ledger: every number with its command ↗"]]}/>
      </div>
      <div class="proj-viz"><div class="viz">
        <div class="viz-head mono"><b>Why in hardware</b><span class="dim">the same format on a GPU</span></div>
        <${Bars} rows=${[
          { label: "GPU, first decode kernel", v: 0.977, show: "0.97–0.98×", cls: "muted" },
          { label: "GPU, after Nsight rewrite", v: 1.044, show: "1.03–1.05×", cls: "muted" },
          { label: "hardware decoder", v: 1.4246, show: "1.42×", cls: "accent" },
        ]} note="Speed against the same kernel on raw BF16, one layer. GPU: RTX 3060 Laptop, wall clock (measured). Nsight Compute showed why: decoding turns a DRAM-bound kernel (89% of DRAM peak) into an ALU-bound one (78% SM busy). Cutting 26% of its instructions with byte-permute lookups made it a small win. Hardware: cycle-accurate RTL (sim), decoding beside the MACs for free."/>
      </div></div>
    </div>
    <${Layout} designs=${["decoder", "engine"]} shots=${EW_DIE}/>`;
}

function CpuDetail() {
  return html`<div class="proj-body">
      <div class="proj-text">
        <p>An RV32I processor written twice: single-cycle first, then a <b>5-stage pipeline</b> with full forwarding, a one-cycle
          load-use stall, predict-not-taken branches resolved in EX, precise machine-mode traps and memory wait states. It is the
          controller in the accelerator and decoder SoCs.</p>
        <p class="dim">The visualizer replays the hazard rules of <span class="mono">core.sv</span>: watch the
          load-use stall at cycle 5 and the two flushed instructions after the taken branch.</p>
        <${Specs} items=${[
          ["41/41", "official rv32ui riscv-tests pass on both cores, every instruction in lockstep with a Python golden model", "sim"],
          ["30 SVA", "properties proven with SymbiYosys by k-induction: no depth bound", "formal"],
          ["126/126", "functional-coverage bins closed by a constrained-random generator, soaked at 5,000 programs", "sim"],
          ["33/33", "planted pipeline bugs caught by the regression (mutation testing)", "sim"],
          ["CPI 1.13–2.2", "on directed programs; 1.52 on random code", "sim"],
          ["~71 MHz", "laid out on SKY130 at the typical corner (~44 MHz slow): 18,188 cells, 0.156 mm², DRC/LVS clean", "layout"],
        ]}/>
        <${Links} items=${[[src("riscv-core"), "Source ↗"], ["notes/cpu-pipeline.html", "Notes: the pipeline, cycle by cycle →"]]}/>
      </div>
      <div class="proj-viz"><${PipelineViz}/></div>
    </div>
    <${Layout} designs=${["cpu"]} shots=${CPU_DIE}/>`;
}

function TpuDetail() {
  return html`<div class="proj-body">
      <div class="proj-text">
        <p>An <b>int8 8×8 weight-stationary systolic array</b> with double-buffered weights, requantization and ReLU, behind
          an <b>AXI4-Lite</b> slave, wired into a SoC around my RISC-V core. Bare-metal C on the CPU drives it.</p>
        <${Bars} log=${true} unit="cycles / image" rows=${[
          { label: "RV32I alone", v: 1272163, cls: "muted" },
          { label: "RV32I + accelerator", v: 6748, cls: "accent", tag: "188×" },
        ]} note="784-64-10 int8 MLP, log scale, simulated SoC. The int8 model scores 97.0% on all 10,000 MNIST test images; on the 32 images run through the SoC, every prediction matches it."/>
        <${Specs} items=${[
          ["UVM", "AXI4-Lite agent with back-pressure, a scoreboard modeling every register and buffer, functional coverage, SVA protocol checks (Vivado xsim)", "sim"],
          ["cocotb", "random jobs with bus jitter, requantization edge cases, bank-overwrite timing proven exact by a mutation test", "sim"],
          ["64 MAC/cycle", "busy every cycle at M = 16; the bottleneck is now the CPU feeding the bus, so DMA is the next step", "sim"],
          ["flat vs tiled", "the array laid out twice: flat placement missed 50 MHz at the slow corner (~84 / ~43 MHz); 64 hardened PE macros on a grid reach ~102 / ~60 MHz, DRC/LVS clean", "layout"],
        ]}/>
        <${Links} items=${[[src("systolic-accel"), "Source ↗"], [VIEWER, "3D layout viewer ↗"]]}/>
      </div>
      <div class="proj-viz"><${SystolicViz}/></div>
    </div>
    <${Layout} designs=${["array"]} shots=${TPU_DIE}><${Viewer3D}/><//>`;
}

function GpuDetail() {
  return html`<div class="proj-body">
      <div class="proj-text">
        <p>A GPU is not a bunch of CPUs, so I built one to show the difference. Two SIMT cores, each with <b>4 warps × 8 lanes</b> sharing
          a single fetch, decode and scheduler, with the CPU’s decoder and ALU reused unchanged. One instruction runs on 8
          threads at once.</p>
        <${Specs} items=${[
          ["min-PC", "divergence: per-thread PCs, the warp runs its lowest PC with only those lanes on, and reconverges with no stack"],
          ["latency hiding", "one instruction in flight per warp means no forwarding at all; 4 warps per core run the same 512 threads 3.5× faster than 1 (4,002 → 1,146 cycles)", "sim"],
          ["byte-exact", "every kernel also runs thread by thread on the CPU’s golden model; 64 KiB of memory must match", "sim"],
          ["10/10", "planted bugs caught; one surviving mutant proved equivalent and was replaced", "sim"],
          ["1 latch", "found by hardening, not by simulation: a store-placement loop in the LSU left two temporaries unassigned on some paths. Icarus never noticed; Yosys reported 37 combinational loops. Fixed with defaults, tests rerun"],
          ["SKY130", "one SIMT core laid out at 25% utilization (the 45% attempt failed global routing on the register file’s read muxes)", "layout"],
        ]}/>
        <${Bars} unit="cycles" rows=${[
          { label: "CPU · Collatz", v: 169998, cls: "muted" },
          { label: "GPU · Collatz", v: 19287, cls: "accent", tag: "8.8×" },
          { label: "CPU · vecadd", v: 11276, cls: "muted" },
          { label: "GPU · vecadd", v: 2290, cls: "accent", tag: "4.9×" },
        ]} note="Same data, same algorithm, both results checked; GPU with its default 8-cycle memory (simulated). Collatz wins more despite 40% SIMD efficiency: it’s compute-bound, and the CPU loses over a third of its cycles to pipeline flushes and stalls."/>
        <${Links} items=${[[src("simt-gpu"), "Source ↗"], ["notes/simt-gpu.html", "Notes: the GPU explained, with a divergence trace →"]]}/>
      </div>
      <div class="proj-viz"><${WarpViz}/></div>
    </div>
    <div class="gpu-extra"><${CoalesceViz}/></div>
    <${Layout} designs=${["gpu"]} shots=${GPU_DIE}/>`;
}

function CudaDetail() {
  return html`<div class="proj-body">
    <div class="proj-text">
      <p>Nine kernels on an RTX 3060 Laptop GPU, plus cuBLAS as the reference, each checked against a CPU reference on every shape: coalesced dp4a, shared-memory
        tiling, WMMA tensor cores with <span class="mono">cp.async</span> double buffering, and decode-shape kernels, one of which
        reads <b>4-bit codebook weights</b> and unpacks them with two <span class="mono">__byte_perm</span>s.</p>
      <${Bars} unit="ms" rows=${[
        { label: "tiled_dp4a", v: 0.510, cls: "muted" },
        { label: "cuBLAS", v: 0.426, cls: "ref" },
        { label: "skinny_dp4a", v: 0.263, cls: "accent", tag: "1.62×" },
        { label: "skinny_cb (4-bit)", v: 0.252, cls: "muted", tag: "1.69×" },
      ]} note="16 × 11008 × 4096: a LLaMA-7B MLP projection at batch 16. skinny_dp4a reads the same int8 weights as cuBLAS; skinny_cb reads 4-bit codebook indices instead. Best of 3 runs, SM clock logged at ~1980 MHz (measured)."/>
      <${Specs} items=${[
        ["48.7 TOPS", "wmma_big at 4096³: 40% of the tensor-core roof, 59% of cuBLAS", "measured"],
        ["roofline", "every kernel placed against measured DRAM, dp4a and tensor-core ceilings"],
      ]}/>
      <${Links} items=${[[src("int8-gemm-cuda"), "Source ↗"]]}/>
    </div>
    <div class="proj-viz"><${Roofline}/></div>
  </div>`;
}

// one tab per project; the colour is the project's SKY130 metal layer, as in the die renders
const PROJECTS = [
  { id: "ew", name: "LLM weight decoder", repo: "ew-decoder", layer: "li1", c: "var(--li1)",
    title: "A hardware decoder for compressed LLM weights.", stack: "SystemVerilog · RISC-V custom-0 · SKY130 · CUDA",
    points: [["1.42× faster weight streaming than raw BF16 on a real Qwen2.5 layer, bit-exact", "sim"],
      ["Decoder laid out on SKY130: 50 MHz at every corner, DRC/LVS clean", "layout"]],
    Detail: EwDetail },
  { id: "cpu", name: "RISC-V CPU", repo: "riscv-core", layer: "met1", c: "var(--met1)",
    title: "A RISC-V CPU, pipelined and proven.", stack: "SystemVerilog · cocotb · SymbiYosys",
    points: [["41/41 official riscv-tests, in lockstep with a golden model", "sim"],
      ["30 pipeline properties proven by k-induction", "formal"]],
    Detail: CpuDetail },
  { id: "tpu", name: "AI accelerator", repo: "systolic-accel", layer: "met2", c: "var(--met2)",
    title: "A TPU-style accelerator that runs MNIST.", stack: "SystemVerilog · UVM · bare-metal C",
    points: [["MNIST in 188× fewer cycles than the CPU alone", "sim"],
      ["64 hardened PE macros on a grid: ~102 MHz, DRC/LVS clean", "layout"]],
    Detail: TpuDetail },
  { id: "gpu", name: "SIMT GPU", repo: "simt-gpu", layer: "met4", c: "var(--met4)",
    title: "A GPU is not a bunch of CPUs.", stack: "SystemVerilog · cocotb · golden-model ISS",
    points: [["4.9–8.8× fewer cycles than the CPU on the same kernels", "sim"],
      ["Byte-exact against a per-thread golden model", "sim"]],
    Detail: GpuDetail },
  { id: "cuda", name: "CUDA kernels", repo: "int8-gemm-cuda", layer: "met5", c: "var(--met5)",
    title: "int8 GEMM, from naive to tensor cores.", stack: "CUDA · WMMA · cp.async · Nsight",
    points: [["48.7 TOPS int8 on tensor cores (RTX 3060)", "measured"],
      ["LLM-decode kernel 1.62× faster than cuBLAS", "measured"]],
    Detail: CudaDetail },
];

const fromHash = () => (PROJECTS.some((p) => p.id === location.hash.slice(1)) ? location.hash.slice(1) : null);

function Work({ open, go }) {
  const p = PROJECTS.find((x) => x.id === open);
  const i = PROJECTS.indexOf(p);
  // clicking the open tab closes it; a panel that opens below the fold (phones) is scrolled into view
  const pick = (id) => {
    if (id === open) return go(null);
    go(id);
    requestAnimationFrame(() => {
      const el = document.getElementById("panel");
      if (el.getBoundingClientRect().top > innerHeight * 0.7) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };
  const back = () => { go(null); document.getElementById("work").scrollIntoView({ behavior: "smooth" }); };
  return html`<section id="work" class="wrap work">
    <div class="sec-head"><span class="mono over">Projects · Fall 2026</span>
      <h2>One stack, from the layout to the kernel.</h2>
      <p class="dim">Pick a project for the full write-up, interactive diagrams and layout renders. The CPU controls the accelerator and
        the decoder, the GPU reuses the CPU’s decoder and ALU, and the decoder is measured against my own CUDA kernels.</p></div>
    <div class="ptabs" role="tablist" aria-label="Projects">${PROJECTS.map((x) => html`<button role="tab" id=${"tab-" + x.id}
        aria-selected=${x.id === open} aria-controls="panel" class=${"ptab" + (x.id === open ? " on" : "")}
        style=${{ "--lc": x.c }} onClick=${() => pick(x.id)}>
      <span class="ptab-top"><span class="layer mono">${x.layer}</span><span class="chev" aria-hidden="true"></span></span>
      <h3>${x.name}</h3><span class="mono small dim">${x.repo}</span>
      <ul>${x.points.map(([t, k]) => html`<li>${t} <${Tag} k=${k}/></li>`)}</ul>
    </button>`)}</div>
    <div id="panel" class="panel-anchor">
      ${p ? html`<div class="panel" role="tabpanel" aria-labelledby=${"tab-" + p.id} key=${p.id} style=${{ "--lc": p.c }}>
          <div class="proj-head"><span class="mono over"><i class="sw"></i>${p.layer} · ${p.repo}</span><h2>${p.title}</h2>
            <p class="mono small dim">${p.stack}</p></div>
          <${p.Detail}/>
          <div class="panel-foot">
            <button class="btn-ghost" onClick=${back}>↑ Back to all projects</button>
            ${i < PROJECTS.length - 1
              ? html`<button class="btn-ghost" onClick=${() => go(PROJECTS[i + 1].id, true)}>Next: ${PROJECTS[i + 1].name} →</button>`
              : null}
          </div>
        </div>`
      : html`<p class="panel-hint mono small dim">Select a project above to open it.</p>`}
    </div>
  </section>`;
}

function Nav({ open, go }) {
  const [solid, setSolid] = useState(false);
  useEffect(() => {
    const f = () => setSolid(window.scrollY > 40);
    f(); window.addEventListener("scroll", f, { passive: true });
    return () => window.removeEventListener("scroll", f);
  }, []);
  return html`<nav class=${"top" + (solid ? " solid" : "")}>
    <a href="#top" class="mark mono" aria-label="Home">RB<span>/</span>silicon</a>
    <div class="links">${PROJECTS.map((p) => html`<button class=${"navtab" + (p.id === open ? " on" : "")} style=${{ "--lc": p.c }}
        onClick=${() => go(p.id, true)}>${p.name}</button>`)}
      <a href=${`mailto:${EMAIL}`} class="btn-sm">Contact</a></div>
  </nav>`;
}

function App() {
  const [open, setOpen] = useState(fromHash);
  const go = (id, scroll) => {
    setOpen(id);
    history.replaceState(null, "", id ? "#" + id : location.pathname + location.search);
    if (scroll) requestAnimationFrame(() => document.getElementById("panel").scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  useEffect(() => {
    const f = () => setOpen(fromHash());
    window.addEventListener("hashchange", f);
    if (fromHash()) requestAnimationFrame(() => document.getElementById("panel").scrollIntoView({ block: "start" }));
    return () => window.removeEventListener("hashchange", f);
  }, []);
  return html`<${React.Fragment}>
    <a class="skip" href="#work">Skip to content</a>
    <${Nav} open=${open} go=${go}/><${Hero}/>
    <${Work} open=${open} go=${go}/>
  <//>`;
}

createRoot(document.getElementById("root")).render(html`<${App}/>`);
