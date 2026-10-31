import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";
import { PipelineViz, SystolicViz, WarpViz, CoalesceViz, Bars, Roofline, DieExplorer, Count, useInView } from "./viz.js";
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

// one metal layer per project: the same colors as the die renders
const LAYERS = [
  { id: "ew", name: "LLM decoder", layer: "li1", c: "var(--li1)" },
  { id: "cpu", name: "RISC-V CPU", layer: "met1", c: "var(--met1)" },
  { id: "tpu", name: "AI accelerator", layer: "met2", c: "var(--met2)" },
  { id: "gpu", name: "SIMT GPU", layer: "met4", c: "var(--met4)" },
  { id: "cuda", name: "CUDA kernels", layer: "met5", c: "var(--met5)" },
  { id: "silicon", name: "Layouts", layer: "met3", c: "var(--met3)" },
];

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
        const THREE = await import("three");
        const { mountChip } = await import("./chip.js");
        const tex = await new THREE.TextureLoader().loadAsync("assets/tpu_die_tex.jpg");
        if (dead) return;
        stop = mountChip(canvas.current, { texture: tex, reducedMotion, onReady: () => setReady(true) });
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
      <p class="lede">I build computers from the logic up: a <b>hardware decoder for compressed LLM weights</b> that streams a real
        model’s weights 1.42× faster, bit for bit; a pipelined, formally verified <b>RISC-V CPU</b>; an <b>int8 systolic-array
        accelerator</b>; a <b>SIMT GPU</b>; and <b>CUDA kernels</b>, with the hardware taken to <b>SkyWater 130 nm layouts</b>. Every
        number on this page comes from a test, a tool report or a benchmark log in the <a href=${REPO} target="_blank" rel="noopener">public repository</a>.</p>
      <p class="disclose small">Built with Claude Code (Anthropic’s AI coding agent) under my direction: I chose what to build, what to
        measure and which trade-offs to take; Claude wrote the code and ran the tools.</p>
      <div class="cta">
        <a class="btn" href="#ew">See the work</a>
        <a class="btn-ghost" href=${REPO} target="_blank" rel="noopener">GitHub ↗</a>
        <a class="btn-ghost" href=${`mailto:${EMAIL}`}>Email</a>
      </div>
    </div>
    <p class="hero-cap mono small">Live render of my 8×8 systolic-array die (SKY130, 1.96 mm). <span class="cy">●</span> activations flow right,
      <span class="am">●</span> partial sums flow down, skewed one cycle per PE, just like the RTL.</p>
    <a class="scroll-cue" href="#stats" aria-label="Scroll down"><span></span></a>
  </header>`;
}

function Stats() {
  const done = new Set(LAYOUTS.filter((l) => !l.pending).map((l) => l.design)).size;
  const items = [
    [html`<${Count} to=${1.42} dec=${2} suffix="×"/>`, "faster LLM weight streaming on a real Qwen2.5 layer, lossless", "sim"],
    [html`<${Count} to=${41}/>/41`, "official riscv-tests, plus 30 SVA properties proven by k-induction", "sim + formal"],
    [html`<${Count} to=${188} suffix="×"/>`, "fewer cycles per MNIST image: CPU + my systolic array vs the CPU alone", "sim"],
    [html`<${Count} to=${done}/>`, "designs taken from RTL to a routed SKY130 layout (table below)", "layout"],
  ];
  return html`<section id="stats" class="stats wrap">${items.map(([v, l, k]) => html`<div class="stat reveal">
    <div class="num">${v}</div><p>${l} <${Tag} k=${k}/></p></div>`)}</section>`;
}

function Index() {
  const cards = [
    { id: "ew", t: "ew-decoder", s: "Hardware decoder for losslessly compressed LLM weights", k: "SystemVerilog · RISC-V custom-0 · SKY130 · CUDA" },
    { id: "cpu", t: "riscv-core", s: "5-stage RV32I pipeline, formally verified", k: "SystemVerilog · cocotb · SymbiYosys" },
    { id: "tpu", t: "systolic-accel", s: "int8 8×8 systolic array + AXI4-Lite SoC", k: "UVM · bare-metal C · MNIST" },
    { id: "gpu", t: "simt-gpu", s: "Warps, divergence, coalescing, built on the CPU’s ALU", k: "SystemVerilog · cocotb · ISS" },
    { id: "cuda", t: "int8-gemm-cuda", s: "From naive to tensor cores, plus 4-bit codebook decode", k: "CUDA · dp4a · WMMA · cp.async" },
    { id: "silicon", t: "RTL → GDS", s: "Every block hardened on SkyWater 130 nm", k: "LibreLane · OpenROAD · KLayout" },
  ];
  return html`<section id="work" class="wrap">
    <div class="sec-head reveal"><span class="mono over">Selected work · Fall 2026</span><h2>One stack, from the transistor layout to the kernel.</h2>
      <p class="dim">Each project builds on the last: the CPU controls the accelerator and the decoder, the GPU reuses the CPU’s decoder
        and ALU, and the LLM decoder is measured against my own CUDA kernels.</p></div>
    <div class="cards">${cards.map((c, i) => {
      const L = LAYERS.find((l) => l.id === c.id);
      return html`<a class="card reveal" href=${"#" + c.id} style=${{ "--lc": L.c, transitionDelay: i * 60 + "ms" }}>
        <span class="layer mono">${L.layer}</span>
        <h3>${c.t}</h3><p>${c.s}</p><span class="mono small dim">${c.k}</span>
      </a>`;
    })}</div>
  </section>`;
}

function Project({ id, kicker, title, children, aside }) {
  const L = LAYERS.find((l) => l.id === id);
  return html`<section id=${id} class="project wrap" style=${{ "--lc": L.c }}>
    <div class="proj-head reveal"><span class="mono over"><i class="sw"></i>${L.layer} · ${kicker}</span><h2>${title}</h2></div>
    <div class="proj-body">
      <div class="proj-text reveal">${children}</div>
      <div class="proj-viz reveal">${aside}</div>
    </div>
  </section>`;
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
  return html`<div class="viewer reveal">
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

function LayoutTable() {
  return html`<div class="lt-wrap reveal"><table class="lt">
    <thead><tr><th>block</th><th>cells</th><th>die</th><th>fmax tt / ss</th><th>DRC / LVS / antenna</th></tr></thead>
    <tbody>${LAYOUTS.map((l) => html`<tr class=${l.pending ? "pending" : ""}>
      <td><b>${l.block}</b>${l.note ? html`<span class="small dim">${l.note}</span>` : null}</td>
      ${l.pending
        ? html`<td colspan="4"><span class="pill">Layout running</span> <span class="small dim">${l.pending}</span></td>`
        : html`<td class="mono">${l.cells}</td><td class="mono">${l.die}</td><td class="mono">${l.fmax}</td><td class="mono">${l.checks}</td>`}
    </tr>`)}</tbody>
  </table>
  <p class="small dim">SkyWater SKY130 open-PDK layouts from the LibreLane / OpenROAD flow, signed off with Magic, KLayout and Netgen.
    These are tool estimates of layouts, not fabricated chips, and there are no FPGA results. fmax = 1 / (clock period − worst setup
    slack) at the typical (tt, 25 °C, 1.8 V) and slow (ss, 100 °C, 1.6 V) corners.</p></div>`;
}

function Earlier() {
  const projects = [
    { t: "CNN digit classifier", m: "99.30%", d: "450k-parameter CNN, 0.993 macro-F1 on 10,000 held-out images; four model families compared, 15-trial Optuna search.", tag: "ML · Summer 2026" },
    { t: "Ball-balancing platform", m: "PID", d: "Real-time sensor-to-servo PID loop on an Arduino for under $75. First tuning pinned the ball to an edge; diagnosed, re-tuned, now recovers from pushes.", tag: "Controls · team · Spring 2026" },
  ];
  const roles = [
    { t: "TCG Audit", m: "intern", d: "Automated the organization of client financial records in Python; cross-checked entries against source documents before reports shipped.", tag: "Accounting & automation intern · Summer 2024" },
    { t: "VibeNest", m: "RSO", d: "Founding a UNF student organization for building apps, games and tools with AI coding assistants; constitution written, registering spring 2027.", tag: "Founder · Fall 2026" },
    { t: "Muslim Student Association", m: "VP", d: "Planned events and outreach, ran executive-board logistics, reworked event organization to raise attendance.", tag: "Vice President · 2025–26" },
  ];
  return html`<section id="about" class="wrap">
    <div class="sec-head reveal"><span class="mono over">Before and around the hardware work</span><h2>Other projects and experience.</h2></div>
    ${[["Projects", projects, " two"], ["Experience & leadership", roles, ""]].map(([g, xs, cls]) => html`
      <h4 class="mono group-h reveal">${g}</h4>
      <div class=${"earlier" + cls}>${xs.map((x, i) => html`<article class="mini reveal" style=${{ transitionDelay: i * 60 + "ms" }}>
        <span class="mini-m mono">${x.m}</span><h3>${x.t}</h3><p>${x.d}</p><span class="small dim mono">${x.tag}</span></article>`)}</div>`)}
  </section>`;
}

function Toolbox() {
  const groups = [
    ["RTL & verification", "SystemVerilog, cocotb, UVM (Vivado xsim), SVA + SymbiYosys (k-induction), constrained-random + functional coverage, mutation testing, gate-level simulation, Icarus, Verilator (lint), Yosys"],
    ["Physical design", "LibreLane / OpenLane 2, OpenROAD, SkyWater SKY130, multi-corner STA, power from simulated switching (OpenSTA), hierarchical macros, KLayout, Magic, Netgen"],
    ["GPU & systems", "CUDA (dp4a, WMMA tensor cores, cp.async, __byte_perm), Nsight Compute, cuBLAS, PyTorch, roofline analysis, RISC-V assembly, bare-metal C, AXI4-Lite"],
    ["ML", "TensorFlow / Keras, Optuna, int8 quantization, BF16 weight formats"],
    ["Languages & tools", "Python, C, Java, MATLAB, three.js, React, Git, WSL / Nix"],
    ["Bench", "Circuits I & II, oscilloscopes, multimeters, Arduino, CAD"],
  ];
  return html`<section id="tools" class="wrap toolbox reveal">
    ${groups.map(([g, v]) => html`<div><h4 class="mono">${g}</h4><p>${v}</p></div>`)}
  </section>`;
}

function Rail() {
  const [active, setActive] = useState(null);
  useEffect(() => {
    const els = LAYERS.map((l) => document.getElementById(l.id)).filter(Boolean);
    const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && setActive(e.target.id)), { rootMargin: "-45% 0px -50% 0px" });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);
  return html`<nav class="rail" aria-label="Projects">${LAYERS.map((l) => html`<a href=${"#" + l.id}
    class=${active === l.id ? "on" : ""} style=${{ "--lc": l.c }}><i></i><span class="mono">${l.name}</span></a>`)}</nav>`;
}

function Nav() {
  const [solid, setSolid] = useState(false);
  useEffect(() => {
    const f = () => setSolid(window.scrollY > 40);
    f(); window.addEventListener("scroll", f, { passive: true });
    return () => window.removeEventListener("scroll", f);
  }, []);
  return html`<nav class=${"top" + (solid ? " solid" : "")}>
    <a href="#top" class="mark mono" aria-label="Home">RB<span>/</span>silicon</a>
    <div class="links"><a href="#ew">Decoder</a><a href="#cpu">CPU</a><a href="#tpu">Accelerator</a><a href="#gpu">GPU</a><a href="#silicon">Layouts</a><a href="#contact" class="btn-sm">Contact</a></div>
  </nav>`;
}

function useReveal() {
  useEffect(() => {
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }),
      { threshold: 0.12 });
    const scan = () => document.querySelectorAll(".reveal:not(.in)").forEach((el) => io.observe(el));
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => { io.disconnect(); mo.disconnect(); };
  }, []);
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

const DIE_SHOTS = [...EW_DIE, ...CPU_DIE, ...TPU_DIE, ...GPU_DIE];

function App() {
  useReveal();
  return html`<${React.Fragment}>
    <a class="skip" href="#work">Skip to content</a>
    <${Nav}/><${Rail}/><${Hero}/><${Stats}/><${Index}/>

    <${Project} id="ew" kicker="ew-decoder" title="A hardware decoder for compressed LLM weights." aside=${html`<figure class="die-fig">
        <img src="assets/ew_decoder_die.jpg" alt="Layout of the weight decoder on SKY130" loading="lazy"/>
        <figcaption class="small dim mono">The decoder on SKY130, 370 × 381 µm, DRC/LVS clean</figcaption></figure>`}>
      <p>Generating one token at batch 1 reads every weight of the model once, so LLM decode is limited by memory, not math.
        BF16 exponents cluster in a narrow band, and <b>ZipServ’s exponent-window format</b> (TCA-TBE) exploits that: each exponent
        becomes a 3-bit offset from a base, with escapes for the rest, for <b>11.23 bits per weight instead of 16, losslessly</b>.
        GPUs decode it in software. I built the decoder in hardware: it rebuilds <b>8 BF16 weights per cycle</b> in front of a GEMV
        core, driven by <b>RISC-V custom-0 instructions</b>, and I swept the format variants that a hardware decoder makes cheap.</p>
      <${Bars} unit="cycles" rows=${[
        { label: "raw BF16", v: 3736792, cls: "muted" },
        { label: "compressed + decoder", v: 2622992, cls: "accent", tag: "1.42×" },
      ]} note="All 7 matrices of a real Qwen2.5-0.5B layer, cycle-accurate RTL simulation with memory limited to 8 B/cycle (half what raw BF16 needs). Ceiling 16 ÷ bits = 1.426×: the decoder reaches 99.9% of it, and every output is bit-exact."/>
      <h4 class="mono sub-h">Why in hardware: the same format on a GPU</h4>
      <${Bars} rows=${[
        { label: "GPU, first decode kernel", v: 0.977, show: "0.97–0.98×", cls: "muted" },
        { label: "GPU, after Nsight rewrite", v: 1.044, show: "1.03–1.05×", cls: "muted" },
        { label: "hardware decoder", v: 1.4246, show: "1.42×", cls: "accent" },
      ]} note="Speed against the same kernel on raw BF16, one layer. GPU: RTX 3060 Laptop, wall clock (measured). Nsight Compute showed why: decoding turns a DRAM-bound kernel (89% of DRAM peak) into an ALU-bound one (78% SM busy). Cutting 26% of its instructions with byte-permute lookups made it a small win. Hardware: cycle-accurate RTL (sim), decoding beside the MACs for free."/>
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
    <//>

    <${Project} id="cpu" kicker="riscv-core" title="A RISC-V CPU, pipelined and proven." aside=${html`<${PipelineViz}/>`}>
      <p>An RV32I processor written twice: single-cycle first, then a <b>5-stage pipeline</b> with full forwarding, a one-cycle
        load-use stall, predict-not-taken branches resolved in EX, precise machine-mode traps and memory wait states. It is the
        controller in the accelerator and decoder SoCs.</p>
      <p class="dim">The visualizer on the right replays the hazard rules of <span class="mono">core.sv</span>: watch the
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
    <//>

    <${Project} id="tpu" kicker="systolic-accel" title="A TPU-style accelerator that runs MNIST." aside=${html`<${SystolicViz}/>`}>
      <p>An <b>int8 8×8 weight-stationary systolic array</b> with double-buffered weights, requantization and ReLU, behind an
        <b>AXI4-Lite</b> slave, wired into a SoC around my RISC-V core. Bare-metal C on the CPU drives it.</p>
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
    <//>

    <${Project} id="gpu" kicker="simt-gpu" title="A GPU is not a bunch of CPUs." aside=${html`<${WarpViz}/>`}>
      <p>So I built one to show the difference. Two SIMT cores, each with <b>4 warps × 8 lanes</b> sharing a single fetch, decode
        and scheduler, with the CPU’s decoder and ALU reused unchanged. One instruction runs on 8 threads at once.</p>
      <${Specs} items=${[
        ["min-PC", "divergence: per-thread PCs, the warp runs its lowest PC with only those lanes on, and reconverges with no stack"],
        ["latency hiding", "one instruction in flight per warp means no forwarding at all; 4 warps per core run the same 512 threads 3.5× faster than 1 (4,002 → 1,146 cycles)", "sim"],
        ["byte-exact", "every kernel also runs thread by thread on the CPU’s golden model; 64 KiB of memory must match", "sim"],
        ["10/10", "planted bugs caught; one surviving mutant proved equivalent and was replaced", "sim"],
        ["1 latch", "found by hardening, not by simulation: a store-placement loop in the LSU left two temporaries unassigned on some paths. Icarus never noticed; Yosys reported 37 combinational loops. Fixed with defaults, tests rerun"],
        ["SKY130", "one SIMT core laid out at 25% utilization (the 45% attempt failed global routing on the register file’s read muxes); results in the layout table", "layout"],
      ]}/>
      <${Bars} unit="cycles" rows=${[
        { label: "CPU · Collatz", v: 169998, cls: "muted" },
        { label: "GPU · Collatz", v: 19287, cls: "accent", tag: "8.8×" },
        { label: "CPU · vecadd", v: 11276, cls: "muted" },
        { label: "GPU · vecadd", v: 2290, cls: "accent", tag: "4.9×" },
      ]} note="Same data, same algorithm, both results checked; GPU with its default 8-cycle memory (simulated). Collatz wins more despite 40% SIMD efficiency: it’s compute-bound, and the CPU loses over a third of its cycles to pipeline flushes and stalls."/>
      <${Links} items=${[[src("simt-gpu"), "Source ↗"], ["notes/simt-gpu.html", "Notes: the GPU explained, with a divergence trace →"]]}/>
    <//>
    <div class="wrap gpu-extra reveal"><${CoalesceViz}/></div>

    <${Project} id="cuda" kicker="int8-gemm-cuda" title="int8 GEMM, from naive to tensor cores." aside=${html`<${Roofline}/>`}>
      <p>Nine kernels on an RTX 3060 Laptop GPU, plus cuBLAS as the reference, each checked against a CPU reference on every shape: coalesced dp4a, shared-memory
        tiling, WMMA tensor cores with <span class="mono">cp.async</span> double buffering, and decode-shape kernels, one of which reads
        <b>4-bit codebook weights</b> and unpacks them with two <span class="mono">__byte_perm</span>s.</p>
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
    <//>

    <section id="silicon" class="wrap silicon" style=${{ "--lc": "var(--met3)" }}>
      <div class="proj-head reveal"><span class="mono over"><i class="sw"></i>met3 · physical design</span>
        <h2>From RTL to a finished layout.</h2>
        <p class="dim">Synthesis, floorplan, placement, clock-tree synthesis, routing, multi-corner timing, DRC and LVS with the open-source
          LibreLane flow on SkyWater’s 130 nm PDK. The tabs below are KLayout renders of the final GDS files.</p></div>
      <${LayoutTable}/>
      <div class="reveal"><${DieExplorer} shots=${DIE_SHOTS}/></div>
      <${Viewer3D}/>
    </section>

    <${Earlier}/>
    <${Toolbox}/>

    <section class="wrap honest reveal">
      <h4 class="mono">How these were built</h4>
      <p>The hardware projects were built with Claude Code (Anthropic’s AI coding agent) under my direction: I chose what to build,
        what to measure and which trade-offs to take; Claude wrote the code and ran the tools. Every number on this page comes from a
        simulation, a tool report or a benchmark log in the <a href=${REPO} target="_blank" rel="noopener">repository</a>, each tagged
        <${Tag} k="measured"/> on real hardware, <${Tag} k="sim"/> in simulation, or <${Tag} k="layout"/> / <${Tag} k="estimate"/> from
        layout tools and models. The commit history is public, co-author trailers included.</p>
    </section>

    <footer id="contact" class="wrap foot">
      <h2>Looking for a Summer 2027 internship<br/>in chip design, verification or GPU architecture.</h2>
      <div class="cta">
        <a class="btn" href=${`mailto:${EMAIL}`}>${EMAIL}</a>
        <a class="btn-ghost" href=${REPO} target="_blank" rel="noopener">GitHub ↗</a>
      </div>
      <p class="small dim mono">Rayan Benaoussar · Jacksonville, FL · Built with React and three.js; the die images are KLayout renders of my GDS files.</p>
    </footer>
  <//>`;
}

createRoot(document.getElementById("root")).render(html`<${App}/>`);
