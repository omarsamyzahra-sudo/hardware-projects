import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";
import { PipelineViz, SystolicViz, WarpViz, CoalesceViz, Bars, Roofline, DieExplorer, Count, useInView } from "./viz.js";
import { GPU_DIE } from "./gpu_die.js";
import { EW_DIE } from "./ew_die.js";
const html = htm.bind(React.createElement);

const VIEWER = "https://systolic-array-3d.vercel.app";
const GITHUB = "https://github.com/withered24";
const EMAIL = "rayanbenaoussar@gmail.com";

// one metal layer per project: the same colors as the die renders
const LAYERS = [
  { id: "cpu", name: "RISC-V CPU", layer: "met1", c: "var(--met1)" },
  { id: "tpu", name: "AI accelerator", layer: "met2", c: "var(--met2)" },
  { id: "silicon", name: "Silicon", layer: "met3", c: "var(--met3)" },
  { id: "gpu", name: "SIMT GPU", layer: "met4", c: "var(--met4)" },
  { id: "cuda", name: "CUDA kernels", layer: "met5", c: "var(--met5)" },
  { id: "ew", name: "LLM decoder", layer: "li1", c: "var(--li1)" },
  { id: "research", name: "Research", layer: "wip", c: "var(--wip)" },
];

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
      <p class="lede">I build computers from the logic up: a pipelined <b>RISC-V CPU</b>, an <b>int8 systolic-array accelerator</b> taken
        all the way to a DRC/LVS-clean <b>SkyWater 130 nm layout</b>, a <b>SIMT GPU</b>, <b>CUDA kernels</b> that beat cuBLAS on
        LLM-decode shapes, and a <b>lossless LLM weight decoder</b> that streams real model weights 1.42× faster, bit for bit. Every claim on this page links back to a test, a tool report or a benchmark log.</p>
      <div class="cta">
        <a class="btn" href="#work">See the work</a>
        <a class="btn-ghost" href=${`mailto:${EMAIL}`}>Get in touch</a>
      </div>
    </div>
    <p class="hero-cap mono small">Live render of my 8×8 systolic-array die (SKY130, 1.96 mm). <span class="cy">●</span> activations flow right,
      <span class="am">●</span> partial sums flow down, skewed one cycle per PE, just like the RTL.</p>
    <a class="scroll-cue" href="#stats" aria-label="Scroll down"><span></span></a>
  </header>`;
}

function Stats() {
  const items = [
    [html`<${Count} to=${188} suffix="×"/>`, "MNIST speedup: CPU + my accelerator vs CPU alone"],
    [html`<${Count} to=${1.69} dec=${2} suffix="×"/>`, "faster than cuBLAS on a 16×11008×4096 LLM-decode GEMM"],
    [html`<${Count} to=${41}/>/41`, "official riscv-tests passing, in lockstep with a golden model"],
    [html`<${Count} to=${102}/> MHz`, "tiled accelerator layout at the typical corner, DRC/LVS clean"],
    [html`<${Count} to=${1.42} dec=${2} suffix="×"/>`, "faster weight streaming on a real LLM layer, lossless (my decoder, RTL sim)"],
    [html`<${Count} to=${8.9} dec=${1} suffix="×"/>`, "my GPU over my CPU on a divergent workload"],
  ];
  return html`<section id="stats" class="stats wrap">${items.map(([v, l]) => html`<div class="stat reveal"><div class="num">${v}</div><p>${l}</p></div>`)}</section>`;
}

function Index() {
  const cards = [
    { id: "cpu", t: "riscv-core", s: "5-stage RV32I pipeline, formally verified", k: "SystemVerilog · cocotb · SymbiYosys" },
    { id: "tpu", t: "systolic-accel", s: "int8 8×8 systolic array + AXI4-Lite SoC", k: "UVM · bare-metal C · MNIST" },
    { id: "silicon", t: "RTL → GDS", s: "Hardened on SkyWater 130 nm, flat and hierarchical", k: "LibreLane · OpenROAD · KLayout" },
    { id: "gpu", t: "simt-gpu", s: "Warps, divergence, coalescing, built on the CPU's ALU", k: "SystemVerilog · cocotb · ISS" },
    { id: "cuda", t: "int8-gemm-cuda", s: "From naive to tensor cores, plus 4-bit codebook decode", k: "CUDA · dp4a · WMMA · cp.async" },
    { id: "ew", t: "ew-decoder", s: "Lossless BF16 weight compression, decoded in hardware", k: "RISC-V custom-0 · SKY130 · CUDA" },
    { id: "research", t: "Per-expert safety", s: "What does quantization break inside a mixture-of-experts?", k: "In progress · OLMoE", wip: true },
  ];
  return html`<section id="work" class="wrap">
    <div class="sec-head reveal"><span class="mono over">Selected work · Fall 2026</span><h2>One stack, from the transistor layout to the kernel.</h2>
      <p class="dim">Each project builds on the last: the GPU reuses the CPU's decoder and ALU, the accelerator plugs into the CPU's SoC,
        the CUDA kernels use the same weight layout as the accelerator, and the LLM decoder joins the CPU and the GPU kernels.</p></div>
    <div class="cards">${cards.map((c, i) => {
      const L = LAYERS.find((l) => l.id === c.id);
      return html`<a class=${"card reveal" + (c.wip ? " wip" : "")} href=${"#" + c.id} style=${{ "--lc": L.c, transitionDelay: i * 60 + "ms" }}>
        <span class="layer mono">${L.layer}</span>
        <h3>${c.t}</h3><p>${c.s}</p><span class="mono small dim">${c.k}</span>
        ${c.wip ? html`<span class="pill">Work in progress</span>` : null}
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
  return html`<ul class="specs">${items.map(([k, v]) => html`<li><b class="mono">${k}</b><span>${v}</span></li>`)}</ul>`;
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

function Research() {
  const L = LAYERS.find((l) => l.id === "research");
  const steps = [
    ["R0", "Reproduce", "Baseline OLMoE quality and safety evals at full precision."],
    ["R1", "Measure", "Quantize with off-the-shelf methods; record per-expert weight entropy and what each expert's error does."],
    ["R2", "Attribute", "Score refusals and an unlearning eval for compressed vs. full-precision models, and trace the gaps back to individual experts."],
  ];
  return html`<section id="research" class="project wrap" style=${{ "--lc": L.c }}>
    <div class="proj-head reveal"><span class="mono over"><i class="sw"></i>research · work in progress</span>
      <h2>What does compression break, expert by expert?</h2></div>
    <div class="research reveal">
      <div>
        <p>Mixture-of-experts language models get quantized aggressively to fit on smaller GPUs. Accuracy benchmarks barely move.
          My question is whether the <b>safety</b> behavior survives too, and whether the damage concentrates in a few experts the router
          leans on for refusals.</p>
        <p class="dim">The plan went through a seven-agent adversarial review in July 2026. The original headline turned out to be
          pre-empted by published work, so it was redirected to this per-expert safety study, and the expected cloud budget
          dropped from ~$1.9k to $185–935. Experiments start winter break 2026–27; write-up spring 2027.</p>
        <span class="pill big">Status: designed, not yet run</span>
      </div>
      <ol class="timeline">${steps.map(([k, t, d]) => html`<li><span class="mono">${k}</span><div><b>${t}</b><p class="dim">${d}</p></div></li>`)}</ol>
    </div>
  </section>`;
}

function Earlier() {
  const items = [
    { t: "CNN digit classifier", m: "99.30%", d: "450k-parameter CNN, 0.993 macro-F1 on 10,000 held-out images; four model families compared, 15-trial Optuna search.", tag: "ML · Summer 2026" },
    { t: "Ball-balancing platform", m: "PID", d: "Real-time sensor-to-servo PID loop on an Arduino for under $75. First tuning pinned the ball to an edge; diagnosed, re-tuned, now recovers from pushes.", tag: "Controls · team · Spring 2026" },
    { t: "Windmill", m: "→ ⟳", d: "Designed and built a small working windmill, testing each revision with oscilloscopes and multimeters.", tag: "Build · Spring 2026" },
    { t: "VibeNest", m: "RSO", d: "Founding a UNF student organization for building apps, games and tools with AI coding assistants; constitution written, registering spring 2027.", tag: "Founder · Fall 2026" },
    { t: "Al Rayan Rings", m: "store", d: "Run a one-product e-commerce store end to end: storefront overhaul, product data and imagery.", tag: "Venture" },
    { t: "TCG Audit", m: "intern", d: "Automated the organization of client financial records in Python; cross-checked entries against source documents before reports shipped.", tag: "Accounting & automation intern · Summer 2024" },
    { t: "Muslim Student Association", m: "VP", d: "Planned events and outreach, ran executive-board logistics, reworked event organization to raise attendance.", tag: "Vice President · 2025–26" },
  ];
  return html`<section id="about" class="wrap">
    <div class="sec-head reveal"><span class="mono over">Before and around the sprint</span><h2>Other things I’ve built and run.</h2></div>
    ${[["Projects", items.slice(0, 3), ""], ["Experience & leadership", items.slice(3), " four"]].map(([g, xs, cls]) => html`
      <h4 class="mono group-h reveal">${g}</h4>
      <div class=${"earlier" + cls}>${xs.map((x, i) => html`<article class="mini reveal" style=${{ transitionDelay: i * 60 + "ms" }}>
        <span class="mini-m mono">${x.m}</span><h3>${x.t}</h3><p>${x.d}</p><span class="small dim mono">${x.tag}</span></article>`)}</div>`)}
  </section>`;
}

function Toolbox() {
  const groups = [
    ["RTL & verification", "SystemVerilog, cocotb, UVM (Vivado xsim), SVA + SymbiYosys (k-induction), constrained-random + functional coverage, mutation testing, Icarus, Yosys"],
    ["Physical design", "LibreLane / OpenLane 2, OpenROAD, SkyWater SKY130, STA across corners, hierarchical macros, KLayout, Magic, Netgen"],
    ["GPU & systems", "CUDA (dp4a, WMMA tensor cores, cp.async), cuBLAS, PyTorch, roofline analysis, RISC-V assembly, bare-metal C, AXI4-Lite"],
    ["ML", "TensorFlow / Keras, Optuna, int8 quantization, mixture-of-experts"],
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
    <div class="links"><a href="#work">Work</a><a href="#silicon">Silicon</a><a href="#gpu">GPU</a><a href="#about">About</a><a href="#contact" class="btn-sm">Contact</a></div>
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

const DIE_SHOTS = [
  { tab: "Tiled array", src: "assets/tpu_die_tiled.jpg", alt: "Layout of the 8x8 systolic array: 64 identical PE macros on a grid",
    title: "8×8 systolic array, hierarchical", desc: "One processing element hardened as a 180 µm macro, then 64 copies placed on a 220 µm grid so neighbors connect straight across: activations west→east, partial sums north→south. The top level adds the skew registers, clock tree and power grid around them.",
    specs: [["die", "1.96 × 1.96 mm"], ["cells", "64 macros + 22,832"], ["fmax (tt / ss)", "~102 / ~60 MHz"], ["DRC · LVS · antenna", "0 · 0 · 0"]] },
  { tab: "Flat array", src: "assets/tpu_die_flat.jpg", alt: "Flat-placed layout of the systolic array",
    title: "Same RTL, flat placement", desc: "The first run let the placer scatter all 64 PEs together. Smaller, but slower: long wires failed 50 MHz at the slow corner. Going hierarchical fixed it, which is the point of comparing both.",
    specs: [["die", "1.89 mm²"], ["cells", "108,707"], ["fmax (tt / ss)", "~84 / ~43 MHz"], ["power @ 50 MHz", "25.3 mW"]] },
  { tab: "250 µm", src: "assets/tpu_mid.jpg", alt: "250 micrometer window of the tiled array",
    title: "Zoom: PE macros and routing channels", desc: "A 250 µm window of the tiled layout: PE macros, the routing channels between them, and the met4/met5 power straps.",
    specs: [["metal", "met1–met5"], ["PE macro", "180 × 180 µm, 1,865 cells"], ["pitch", "220 µm"]] },
  { tab: "60 µm", src: "assets/tpu_closeup.jpg", alt: "60 micrometer close-up of standard cells in SKY130 layer colors",
    title: "Zoom: standard cells", desc: "60 µm across, in the SkyWater layer colors: rows of standard cells, poly gates, local interconnect and the first metal layers.",
    specs: [["PDK", "SKY130A"], ["library", "sky130_fd_sc_hd"]] },
  ...GPU_DIE,
  ...EW_DIE,
];

function App() {
  useReveal();
  return html`<${React.Fragment}>
    <a class="skip" href="#work">Skip to content</a>
    <${Nav}/><${Rail}/><${Hero}/><${Stats}/><${Index}/>

    <${Project} id="cpu" kicker="riscv-core" title="A RISC-V CPU, pipelined and proven." aside=${html`<${PipelineViz}/>`}>
      <p>An RV32I processor written twice: single-cycle first, then a <b>5-stage pipeline</b> with full forwarding, a one-cycle
        load-use stall, predict-not-taken branches resolved in EX, precise machine-mode traps and memory wait states.</p>
      <p class="dim">The visualizer on the right replays the hazard rules of <span class="mono">core.sv</span>: watch the
        load-use stall at cycle 5 and the two flushed instructions after the taken branch.</p>
      <${Specs} items=${[
        ["41/41", "official rv32ui riscv-tests pass on both cores, every instruction in lockstep with a Python golden model"],
        ["30 SVA", "properties proven with SymbiYosys by k-induction: no depth bound"],
        ["126/126", "functional-coverage bins closed by a constrained-random generator, soaked at 5,000 programs"],
        ["33/33", "planted pipeline bugs caught by the regression (mutation testing)"],
        ["CPI 1.13–2.2", "on directed programs; 1.52 on random code"],
      ]}/>
      <div class="links-row"><a class="link" href=${GITHUB + "/riscv-core"} target="_blank" rel="noopener">github.com/withered24/riscv-core ↗</a>
        <a class="link" href="notes/cpu-pipeline.html">Notes: the pipeline, cycle by cycle →</a></div>
    <//>

    <${Project} id="tpu" kicker="systolic-accel" title="A TPU-style accelerator that runs MNIST." aside=${html`<${SystolicViz}/>`}>
      <p>An <b>int8 8×8 weight-stationary systolic array</b> with double-buffered weights, requantization and ReLU, behind an
        <b>AXI4-Lite</b> slave, wired into a SoC around my RISC-V core. Bare-metal C on the CPU drives it.</p>
      <${Bars} log=${true} unit="cycles / image" rows=${[
        { label: "RV32I alone", v: 1272163, cls: "muted" },
        { label: "RV32I + accelerator", v: 6748, cls: "accent", tag: "188×" },
      ]} note="784-64-10 int8 MLP, log scale. 97.0% int8 accuracy on all 10,000 MNIST test images; on 32 images run on the simulated SoC, every prediction matches the Python int8 model."/>
      <${Specs} items=${[
        ["UVM", "AXI4-Lite agent with back-pressure, a scoreboard modeling every register and buffer, functional coverage, SVA protocol checks (Vivado xsim)"],
        ["cocotb", "random jobs with bus jitter, requantization edge cases, bank-overwrite timing proven exact by a mutation test"],
        ["64 MAC/cycle", "busy every cycle at M = 16; the bottleneck is now the CPU feeding the bus, so DMA is the next step"],
      ]}/>
    <//>

    <section id="silicon" class="wrap silicon" style=${{ "--lc": "var(--met3)" }}>
      <div class="proj-head reveal"><span class="mono over"><i class="sw"></i>met3 · physical design</span>
        <h2>From RTL to a finished layout.</h2>
        <p class="dim">Synthesis, floorplan, placement, clock-tree synthesis, routing, multi-corner timing, DRC and LVS with the open-source
          LibreLane flow on SkyWater’s 130 nm PDK. The four array tabs and the decoder tabs are real renders of final GDS files. (Open item: 39 slow-corner hold violations on top-level inputs, from the default I/O constraint.)
          The GPU core tabs are its real placed layout: its global routing hasn’t converged yet, so it has cells, clock tree and power grid but no signal wires.</p></div>
      <div class="reveal"><${DieExplorer} shots=${DIE_SHOTS}/></div>
      <${Viewer3D}/>
    </section>

    <${Project} id="gpu" kicker="simt-gpu" title="A GPU is not a bunch of CPUs." aside=${html`<${WarpViz}/>`}>
      <p>So I built one to show the difference. Two SIMT cores, each with <b>4 warps × 8 lanes</b> sharing a single fetch, decode
        and scheduler, with the CPU’s decoder and ALU reused unchanged. One instruction runs on 8 threads at once.</p>
      <${Specs} items=${[
        ["min-PC", "divergence: per-thread PCs, the warp runs its lowest PC with only those lanes on, and reconverges with no stack"],
        ["latency hiding", "one instruction in flight per warp means no forwarding at all; 4 warps per core run 3.5× faster than 1"],
        ["byte-exact", "every kernel also runs thread by thread on the CPU’s golden model; 64 KiB of memory must match"],
        ["10/10", "planted bugs caught; one surviving mutant proved equivalent and was replaced"],
        ["1 latch", "found by hardening, not by simulation: a store-placement loop in the LSU left two temporaries unassigned on some paths. Icarus never noticed; Yosys reported 37 combinational loops. Fixed with defaults, tests rerun"],
      ]}/>
      <div class="links-row"><a class="link" href="notes/simt-gpu.html">Notes: the GPU explained, with a divergence trace →</a></div>
      <${Bars} unit="cycles" rows=${[
        { label: "CPU · Collatz", v: 169998, cls: "muted" },
        { label: "GPU · Collatz", v: 19287, cls: "accent", tag: "8.8×" },
        { label: "CPU · vecadd", v: 11276, cls: "muted" },
        { label: "GPU · vecadd", v: 2290, cls: "accent", tag: "4.9×" },
      ]} note="Same data, same algorithm, both results checked; GPU with 8-cycle memory. Collatz wins more despite 40% SIMD efficiency: it’s compute-bound, and the CPU loses over a third of its cycles to pipeline flushes and stalls."/>
    <//>
    <div class="wrap gpu-extra reveal"><${CoalesceViz}/></div>

    <${Project} id="cuda" kicker="int8-gemm-cuda" title="int8 GEMM, from naive to tensor cores." aside=${html`<${Roofline}/>`}>
      <p>Nine kernels on an RTX 3060 Laptop GPU, plus cuBLAS as the reference, each checked against a CPU reference on every shape: coalesced dp4a, shared-memory
        tiling, WMMA tensor cores with <span class="mono">cp.async</span> double buffering, and decode-shape kernels that read
        <b>4-bit codebook weights</b> and unpack them with two <span class="mono">__byte_perm</span>s.</p>
      <${Bars} unit="ms" rows=${[
        { label: "tiled_dp4a", v: 0.510, cls: "muted" },
        { label: "cuBLAS", v: 0.426, cls: "ref" },
        { label: "skinny_dp4a", v: 0.263, cls: "accent", tag: "1.6×" },
        { label: "skinny_cb (4-bit)", v: 0.252, cls: "accent", tag: "1.69×" },
      ]} note="16 × 11008 × 4096: a LLaMA-7B MLP projection at batch 16. Best of 3 runs, SM clock logged at ~1980 MHz."/>
      <${Specs} items=${[
        ["48.7 TOPS", "wmma_big at 4096³: 40% of the tensor-core roof, 59% of cuBLAS"],
        ["roofline", "every kernel placed against measured DRAM, dp4a and tensor-core ceilings"],
      ]}/>
    <//>

    <${Project} id="ew" kicker="ew-decoder" title="Smaller LLM weights, decoded in hardware, bit for bit." aside=${html`<figure class="die-fig">
        <img src="assets/ew_decoder_die.jpg" alt="Layout of the weight decoder on SKY130" loading="lazy"/>
        <figcaption class="small dim mono">The decoder on SKY130, 329 × 340 µm, DRC/LVS clean</figcaption></figure>`}>
      <p>Generating one token at batch 1 reads every weight of the model once, so LLM decode is limited by memory, not math.
        BF16 exponents cluster in a narrow band, so I store each one as a <b>3-bit offset</b> from a per-matrix base, with
        escapes for the rest: <b>11.23 bits per weight instead of 16, losslessly</b>. A decoder rebuilds 8 BF16 weights per
        cycle in front of a GEMV core, driven by <b>RISC-V custom-0 instructions</b>.</p>
      <${Bars} unit="cycles" rows=${[
        { label: "raw BF16", v: 3736792, cls: "muted" },
        { label: "compressed + decoder", v: 2622992, cls: "accent", tag: "1.42×" },
      ]} note="All 7 matrices of a real Qwen2.5-0.5B layer, cycle-accurate RTL simulation with memory limited to 8 B/cycle (half what raw BF16 needs). Ceiling 16 ÷ bits = 1.426×: the decoder reaches 99.9% of it, and every output is bit-exact."/>
      <${Specs} items=${[
        ["170/170", "weight matrices of Qwen2.5-0.5B round-trip bit-exact; 1.42× less memory"],
        ["541/541", "functional-coverage bins over 6 builds (lane counts, code widths, per-tile bases), plus 10,000 random seeds"],
        ["14,336/14,336", "chunks bit-exact when the routed gate-level netlist decodes real weights"],
        ["~80 MHz", "decoder on SKY130 at the typical corner, 0.053 mm² of cells, 3.53 mW from real switching (8.8 pJ per weight)"],
        ["16–26%", "less DRAM + decode energy per token, with HBM2 / GDDR5 energy from O’Connor et al., MICRO 2017 (an estimate)"],
        ["792 MiB", "peak GPU memory for the whole model running from compressed weights with my fused CUDA kernels (stock: 1,078), logits bit-identical. In software the GPU only breaks even on speed (0.98×), which is the case for a hardware decoder"],
      ]}/>
    <//>

    <${Research}/>
    <${Earlier}/>
    <${Toolbox}/>

    <section class="wrap honest reveal">
      <h4 class="mono">How these were built</h4>
      <p>The fall 2026 projects came out of an intensive hardware sprint, built AI-assisted with Claude Code as a pair programmer.
        My job is to direct the work, review it, and learn every piece well enough to defend it in an interview. Everything
        here comes from a simulation, a tool report or a benchmark log, and the repositories keep the full history, co-author trailers included.</p>
    </section>

    <footer id="contact" class="wrap foot">
      <h2>Looking for a Summer 2027 internship<br/>in chip design, verification or GPU architecture.</h2>
      <div class="cta">
        <a class="btn" href=${`mailto:${EMAIL}`}>${EMAIL}</a>
        <a class="btn-ghost" href=${GITHUB} target="_blank" rel="noopener">GitHub ↗</a>
      </div>
      <p class="small dim mono">Rayan Benaoussar · Jacksonville, FL · Built with React and three.js; the die images are KLayout renders of my GDS files.</p>
    </footer>
  <//>`;
}

createRoot(document.getElementById("root")).render(html`<${App}/>`);
