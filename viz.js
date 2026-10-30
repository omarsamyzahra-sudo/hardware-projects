// viz.js — interactive explainers. Each one simulates the real mechanism
// (pipeline timing, systolic wavefront, min-PC divergence, coalescing) rather
// than playing a canned animation, and every number shown is from the repos.
import React, { useEffect, useMemo, useRef, useState } from "react";
import htm from "htm";
const html = htm.bind(React.createElement);

const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function useInView(opts = { threshold: 0.25 }) {
  const ref = useRef(null);
  const [inView, set] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    const io = new IntersectionObserver(([e]) => set(e.isIntersecting), opts);
    io.observe(ref.current);
    return () => io.disconnect();
  }, []);
  return [ref, inView];
}

function useTicker(running, ms, onTick) {
  const cb = useRef(onTick);
  cb.current = onTick;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => cb.current(), ms);
    return () => clearInterval(id);
  }, [running, ms]);
}

function Controls({ playing, setPlaying, onStep, onReset, children }) {
  return html`<div class="ctrls">
    <button class="btn-ghost" onClick=${() => setPlaying(!playing)} aria-label=${playing ? "Pause" : "Play"}>
      ${playing ? "❚❚ Pause" : "▶ Play"}</button>
    <button class="btn-ghost" onClick=${onStep}>Step</button>
    <button class="btn-ghost" onClick=${onReset}>Reset</button>
    ${children}
  </div>`;
}

// ---------------------------------------------------------------- CPU pipeline
// riscv-core: 5 stages, full forwarding, 1-cycle load-use stall, branches
// resolved in EX (2 wrong-path instructions flushed).
const PIPE = [
  { ins: "addi x1, x0, 5", st: { 1: "IF", 2: "ID", 3: "EX", 4: "MEM", 5: "WB" } },
  { ins: "lw   x2, 0(x1)", st: { 2: "IF", 3: "ID", 4: "EX", 5: "MEM", 6: "WB" } },
  { ins: "add  x3, x2, x1", st: { 3: "IF", 4: "ID", 5: "ID*", 6: "EX", 7: "MEM", 8: "WB" } },
  { ins: "beq  x3, x3, L", st: { 4: "IF", 5: "IF*", 6: "ID", 7: "EX", 8: "MEM", 9: "WB" } },
  { ins: "addi x4, x0, 1", st: { 6: "IF", 7: "ID" }, flush: 8 },
  { ins: "addi x5, x0, 2", st: { 7: "IF" }, flush: 8 },
  { ins: "L: sub x6, x3, x1", st: { 8: "IF", 9: "ID", 10: "EX", 11: "MEM", 12: "WB" } },
];
const PIPE_EV = {
  1: "Fetch addi.",
  3: "addi computes x1 = 5 in EX.",
  4: "Forward x1 from EX/MEM into EX: the lw gets its base address without waiting.",
  5: "Load-use hazard: add needs x2, which lw is still reading from memory. Stall one cycle, send a bubble down.",
  6: "Forward x2 from MEM/WB into EX. The stall cost exactly one cycle.",
  7: "beq resolves in EX (x3 forwarded from EX/MEM): taken. The two wrong-path instructions are flushed.",
  8: "Fetch from the branch target L. The taken branch cost 2 cycles.",
  12: "Done: 7 fetched, 5 retired, 12 cycles. Every register value matches the golden model.",
};
const NC = 12;

export function PipelineViz() {
  const [ref, inView] = useInView();
  const [cyc, setCyc] = useState(reduce ? NC : 0);
  const [playing, setPlaying] = useState(!reduce);
  useTicker(playing && inView, 950, () => setCyc((c) => (c >= NC + 2 ? 0 : c + 1)));
  const shown = Math.min(cyc, NC);
  let ev = "Press play: one column is one clock cycle.";
  for (let c = shown; c >= 1; c--) if (PIPE_EV[c]) { ev = PIPE_EV[c]; break; }
  return html`<div class="viz" ref=${ref}>
    <div class="viz-head"><span class="mono dim">riscv-core · rtl/core.sv</span><span class="mono">cycle <b>${shown}</b> / ${NC}</span></div>
    <div class="scrollx"><table class="pipe">
      <thead><tr><th></th>${Array.from({ length: NC }, (_, i) => html`<th class=${i + 1 === shown ? "now" : ""}>${i + 1}</th>`)}</tr></thead>
      <tbody>${PIPE.map((r) => {
        const dead = r.flush && shown >= r.flush;
        return html`<tr class=${dead ? "flushed" : ""}>
          <td class="ins mono">${r.ins}</td>
          ${Array.from({ length: NC }, (_, i) => {
            const c = i + 1, s = r.st[c];
            if (!s || c > shown) return html`<td class=${c === shown ? "now" : ""}></td>`;
            const stall = s.endsWith("*");
            return html`<td class=${`st ${s.replace("*", "")} ${stall ? "stall" : ""} ${c === shown ? "now" : ""}`}>${s.replace("*", "")}</td>`;
          })}
        </tr>`;
      })}</tbody>
    </table></div>
    <p class="ev" aria-live="polite">${ev}</p>
    <${Controls} playing=${playing} setPlaying=${setPlaying}
      onStep=${() => { setPlaying(false); setCyc((c) => Math.min(NC, c + 1)); }}
      onReset=${() => setCyc(0)} />
  </div>`;
}

// ---------------------------------------------------------------- systolic array
// Weight-stationary 8x8: PE(k, n) works on input row m = c - k - n at cycle c.
// Activations move right, partial sums move down; the diagonal bands are the
// skew. Output row m leaves column n at cycle m + 7 + n.
const SA = 8, SA_M = 12;
export function SystolicViz() {
  const [ref, inView] = useInView();
  const [c, setC] = useState(reduce ? 12 : 0);
  const [playing, setPlaying] = useState(!reduce);
  const [hover, setHover] = useState(null);
  const total = SA_M + 2 * SA - 1;
  useTicker(playing && inView, 420, () => setC((x) => (x >= total + 3 ? 0 : x + 1)));
  const cc = Math.min(c, total);
  let macs = 0;
  for (let t = 0; t < cc; t++)
    for (let k = 0; k < SA; k++) for (let n = 0; n < SA; n++) { const m = t - k - n; if (m >= 0 && m < SA_M) macs++; }
  const done = Array.from({ length: SA }, (_, n) => Math.max(0, Math.min(SA_M, cc - (SA - 1) - n)));
  const hue = (m) => `hsl(${(195 + m * 13) % 360} 85% ${52}%)`;
  return html`<div class="viz" ref=${ref}>
    <div class="viz-head"><span class="mono dim">systolic_array.sv · 8×8 int8 PEs</span><span class="mono">cycle <b>${cc}</b> · ${macs.toLocaleString()} MACs</span></div>
    <div class="sa-wrap">
      <div class="sa-left mono dim">${Array.from({ length: SA }, (_, k) => html`<div>a<sub>k=${k}</sub> →</div>`)}</div>
      <div class="sa-grid" onMouseLeave=${() => setHover(null)}>
        ${Array.from({ length: SA * SA }, (_, i) => {
          const k = Math.floor(i / SA), n = i % SA, m = cc - k - n;
          const on = m >= 0 && m < SA_M;
          return html`<div class=${"pe" + (on ? " on" : "")} style=${on ? { "--c": hue(m) } : null}
              onMouseEnter=${() => setHover({ k, n, m: on ? m : null })}>
            ${on ? html`<span>${m}</span>` : null}</div>`;
        })}
      </div>
      <div class="sa-bottom mono dim">${done.map((d) => html`<div>↓ ${d}</div>`)}</div>
    </div>
    <p class="ev">${hover
      ? `PE[${hover.k}][${hover.n}] holds weight W[${hover.k}][${hover.n}]` + (hover.m !== null ? ` and is adding A[${hover.m}][${hover.k}]·W into output row ${hover.m}.` : " and is idle this cycle.")
      : "Each colored band is one input row sweeping through the array, skewed one cycle per row and column. Numbers under the grid count finished outputs per column (they leave 2N−1 = 15 cycles after entering)."}</p>
    <${Controls} playing=${playing} setPlaying=${setPlaying}
      onStep=${() => { setPlaying(false); setC((x) => Math.min(total, x + 1)); }} onReset=${() => setC(0)} />
  </div>`;
}

// ---------------------------------------------------------------- SIMT divergence
// Min-PC scheduling over the real if/else from the GPU study pack.
const PROG = [
  { pc: 0x00, txt: "andi  t1, a1, 1", next: () => 0x04 },
  { pc: 0x04, txt: "beqz  t1, even", next: (odd) => (odd ? 0x08 : 0x10) },
  { pc: 0x08, txt: "addi  a2, a2, 10   # odd side", next: () => 0x0c },
  { pc: 0x0c, txt: "j     done", next: () => 0x14 },
  { pc: 0x10, txt: "even: addi a2, a2, 20", next: () => 0x14 },
  { pc: 0x14, txt: "done: sw a2, 0(a3)", next: () => 0x18 },
];
const PATTERNS = {
  "lanes 1,3,5,7 odd": [0, 1, 0, 1, 0, 1, 0, 1],
  "all even": [0, 0, 0, 0, 0, 0, 0, 0],
  "only lane 0 odd": [1, 0, 0, 0, 0, 0, 0, 0],
  "random": [1, 1, 0, 1, 0, 0, 1, 0],
};
function simtTrace(odd) {
  let pcs = Array(8).fill(0);
  const out = [];
  while (pcs.some((p) => p < 0x18)) {
    const pc = Math.min(...pcs.filter((p) => p < 0x18));
    const mask = pcs.map((p) => p === pc);
    out.push({ pc, mask, before: pcs.slice() });
    const ins = PROG.find((i) => i.pc === pc);
    pcs = pcs.map((p, l) => (mask[l] ? ins.next(odd[l]) : p));
  }
  out.push({ pc: null, mask: Array(8).fill(false), before: pcs.slice() });
  return out;
}
export function WarpViz() {
  const [ref, inView] = useInView();
  const [pat, setPat] = useState("lanes 1,3,5,7 odd");
  const trace = useMemo(() => simtTrace(PATTERNS[pat]), [pat]);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(!reduce);
  useTicker(playing && inView, 1100, () => setI((x) => (x >= trace.length + 1 ? 0 : x + 1)));
  const step = trace[Math.min(i, trace.length - 1)];
  const issued = trace.slice(0, Math.min(i + 1, trace.length - 1));
  const useful = issued.reduce((s, t) => s + t.mask.filter(Boolean).length, 0);
  const eff = issued.length ? useful / (issued.length * 8) : 1;
  return html`<div class="viz" ref=${ref}>
    <div class="viz-head"><span class="mono dim">simt_core.sv · one warp, 8 lanes</span>
      <label class="mono sel">data: <select value=${pat} onChange=${(e) => { setPat(e.target.value); setI(0); }}>
        ${Object.keys(PATTERNS).map((k) => html`<option>${k}</option>`)}</select></label></div>
    <div class="warp">
      <ol class="code mono">${PROG.map((p) => html`<li class=${step.pc === p.pc ? "cur" : ""}>
        <span class="dim">0x${p.pc.toString(16).padStart(2, "0")}</span> ${p.txt}</li>`)}</ol>
      <div class="lanes">
        ${step.before.map((pc, l) => {
          const on = step.mask[l], exited = pc >= 0x18;
          return html`<div class=${"lane" + (on ? " on" : exited ? " exit" : " wait")}>
            <b class="mono">L${l}</b>
            <span class="mono">${exited ? "exit" : on ? "run" : "0x" + pc.toString(16).padStart(2, "0")}</span>
            <i class=${PATTERNS[pat][l] ? "odd" : "even"}>${PATTERNS[pat][l] ? "odd" : "even"}</i>
          </div>`;
        })}
      </div>
    </div>
    <div class="meter"><span>issues <b>${issued.length}</b></span><span>useful lane-slots <b>${useful}</b> / ${issued.length * 8}</span>
      <span>SIMD efficiency <b class=${eff < 0.9 ? "warn" : "ok"}>${Math.round(eff * 100)}%</b></span></div>
    <p class="ev">${step.pc === null
      ? "Reconverged and done. The warp ran both sides of the if/else one after the other; nobody told it where the if/else ends."
      : `Scheduler picks the smallest PC among live threads (0x${step.pc.toString(16).padStart(2, "0")}); only lanes sitting at that PC are switched on.`}</p>
    <${Controls} playing=${playing} setPlaying=${setPlaying}
      onStep=${() => { setPlaying(false); setI((x) => Math.min(trace.length - 1, x + 1)); }} onReset=${() => setI(0)} />
  </div>`;
}

// ---------------------------------------------------------------- coalescing
export function CoalesceViz() {
  const [stride, setStride] = useState(1);
  const words = 64; // 8 lines of 8 words
  const addr = Array.from({ length: 8 }, (_, l) => (l * stride) % words);
  const lines = new Set(addr.map((a) => Math.floor(a / 8)));
  const laneOf = {};
  addr.forEach((a, l) => (laneOf[a] = l));
  return html`<div class="viz">
    <div class="viz-head"><span class="mono dim">lsu.sv · thread i loads in[i × stride]</span>
      <span class="seg">${[1, 2, 4, 8].map((s) => html`<button class=${s === stride ? "on" : ""} onClick=${() => setStride(s)}>stride ${s}</button>`)}</span></div>
    <div class="mem">${Array.from({ length: 8 }, (_, ln) => html`
      <div class=${"line" + (lines.has(ln) ? " hit" : "")}>
        ${Array.from({ length: 8 }, (_, w) => {
          const a = ln * 8 + w, l = laneOf[a];
          return html`<div class=${"word" + (l !== undefined ? " used" : "")} style=${l !== undefined ? { "--h": 190 + l * 22 } : null}>
            ${l !== undefined ? html`<span>L${l}</span>` : null}</div>`;
        })}
      </div>`)}</div>
    <div class="meter"><span>32-byte requests <b>${lines.size}</b></span>
      <span>bytes moved <b>${lines.size * 32}</b> for 32 used</span>
      <span>bus efficiency <b class=${lines.size > 2 ? "warn" : "ok"}>${Math.round(100 / lines.size)}%</b></span></div>
    <p class="ev">Measured on the RTL: 256 threads need exactly 192 / 224 / 288 / 416 memory lines at stride 1 / 2 / 4 / 8.</p>
  </div>`;
}

// ---------------------------------------------------------------- bar charts
export function Bars({ rows, unit, log = false, note }) {
  const [ref, inView] = useInView({ threshold: 0.3 });
  const max = Math.max(...rows.map((r) => r.v));
  const scale = (v) => (log ? Math.log10(v) / Math.log10(max) : v / max);
  return html`<div class="bars" ref=${ref}>
    ${rows.map((r) => html`<div class="bar-row">
      <span class="bar-label">${r.label}</span>
      <div class="bar-track"><div class=${"bar " + (r.cls || "")} style=${{ width: inView ? `${Math.max(1.2, scale(r.v) * 100)}%` : "0%" }}></div></div>
      <span class="bar-val mono">${r.v.toLocaleString()}${unit ? " " + unit : ""}${r.tag ? html` <b>${r.tag}</b>` : null}</span>
    </div>`)}
    ${note ? html`<p class="small dim">${note}</p>` : null}
  </div>`;
}

// ---------------------------------------------------------------- roofline
// RTX 3060 Laptop at ~1980 MHz: 336 GB/s DRAM, 30 TOPS dp4a, 122 TOPS int8 tensor.
const PTS = [
  { k: "tiled_dp4a", i: 1360.9, y: 11.74, s: "4096³" },
  { k: "wmma", i: 1363.5, y: 34.29, s: "4096³" },
  { k: "wmma_big", i: 1365.9, y: 48.66, s: "4096³", me: 1 },
  { k: "cuBLAS", i: 1364.3, y: 82.38, s: "4096³", ref: 1 },
  { k: "tiled_dp4a", i: 31.5, y: 2.83, s: "16×11008×4096" },
  { k: "cuBLAS", i: 31.5, y: 3.39, s: "16×11008×4096", ref: 1 },
  { k: "skinny_dp4a", i: 31.5, y: 5.49, s: "16×11008×4096", me: 1 },
  { k: "skinny_cb (4-bit)", i: 61.9, y: 5.73, s: "16×11008×4096", me: 1 },
];
export function Roofline() {
  const [tip, setTip] = useState(null);
  const W = 640, H = 380, L = 56, R = 16, T = 16, B = 44;
  const x = (v) => L + ((Math.log10(v) - 1) / (Math.log10(4000) - 1)) * (W - L - R);
  const y = (v) => T + (1 - (Math.log10(v) - Math.log10(1)) / (Math.log10(200) - Math.log10(1))) * (H - T - B);
  const roof = (peak) => {
    const ridge = peak / 0.336;
    return `M${x(10)},${y(0.336 * 10 < 1 ? 1 : 0.336 * 10)} L${x(ridge)},${y(peak)} L${x(4000)},${y(peak)}`;
  };
  const xt = [10, 30, 100, 300, 1000, 3000], yt = [1, 3, 10, 30, 100];
  return html`<div class="viz roof">
    <div class="viz-head"><span class="mono dim">int8 GEMM on RTX 3060 Laptop (sm_86) · log–log</span></div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Roofline chart of int8 GEMM kernels">
      ${xt.map((v) => html`<g><line x1=${x(v)} x2=${x(v)} y1=${T} y2=${H - B} class="grid"/><text x=${x(v)} y=${H - B + 18} class="tick" text-anchor="middle">${v}</text></g>`)}
      ${yt.map((v) => html`<g><line x1=${L} x2=${W - R} y1=${y(v)} y2=${y(v)} class="grid"/><text x=${L - 8} y=${y(v) + 4} class="tick" text-anchor="end">${v}</text></g>`)}
      <text x=${(L + W - R) / 2} y=${H - 6} class="axis" text-anchor="middle">arithmetic intensity (int8 ops / DRAM byte)</text>
      <text transform=${`translate(14 ${(T + H - B) / 2}) rotate(-90)`} class="axis" text-anchor="middle">TOPS</text>
      <path d=${roof(122)} class="roofline tc"/><text x=${x(1500)} y=${y(122) - 6} class="rl tc">tensor cores 122</text>
      <path d=${roof(30)} class="roofline dp"/><text x=${x(1500)} y=${y(30) - 6} class="rl dp">dp4a 30</text>
      <text x=${x(14)} y=${y(5.4) - 8} class="rl mem" transform=${`rotate(-27 ${x(14)} ${y(5.4)})`}>DRAM 336 GB/s</text>
      ${PTS.map((p, i) => html`<circle cx=${x(p.i) + (i % 2 ? 4 : -4) * (p.i < 100 ? 1 : 0)} cy=${y(p.y)} r=${tip === i ? 8 : 6}
          class=${"pt" + (p.me ? " me" : "") + (p.ref ? " ref" : "")} tabindex="0"
          onMouseEnter=${() => setTip(i)} onFocus=${() => setTip(i)} onMouseLeave=${() => setTip(null)} onBlur=${() => setTip(null)}/>`)}
      ${tip !== null ? (() => { const p = PTS[tip]; const tx = Math.min(x(p.i) + 12, W - 190);
        return html`<g class="tipbox"><rect x=${tx} y=${y(p.y) - 46} width="178" height="40" rx="6"/>
          <text x=${tx + 10} y=${y(p.y) - 29}>${p.k}</text><text x=${tx + 10} y=${y(p.y) - 13} class="dimt">${p.y} TOPS · ${p.s}</text></g>`; })() : null}
    </svg>
    <div class="legend small"><span><i class="lg me"></i>my kernels</span><span><i class="lg ref"></i>cuBLAS</span><span><i class="lg"></i>baseline</span></div>
  </div>`;
}

// ---------------------------------------------------------------- die explorer with a loupe
export function DieExplorer({ shots }) {
  const [sel, setSel] = useState(0);
  const [lens, setLens] = useState(null);
  const s = shots[sel];
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    if (px < 0 || py < 0 || px > 1 || py > 1) return setLens(null);
    setLens({ px, py, x: e.clientX - r.left, y: e.clientY - r.top });
  };
  return html`<div class="die-ex">
    <div class="tabs" role="tablist">${shots.map((d, i) => html`<button role="tab" aria-selected=${i === sel}
      class=${i === sel ? "on" : ""} onClick=${() => { setSel(i); setLens(null); }}>${d.tab}</button>`)}</div>
    <div class="die-stage">
      <div class="die-img" onPointerMove=${onMove} onPointerLeave=${() => setLens(null)}>
        <img src=${s.src} alt=${s.alt} loading="lazy" decoding="async"/>
        ${lens ? html`<div class="loupe" style=${{ left: lens.x + "px", top: lens.y + "px",
          backgroundImage: `url(${s.src})`, backgroundPosition: `${lens.px * 100}% ${lens.py * 100}%` }}></div>` : null}
        ${s.labels ? s.labels.map((l) => html`<span class="die-label mono" style=${{ left: l.x + "%", top: l.y + "%", "--lc": l.c }}>${l.t}</span>`) : null}
      </div>
      <div class="die-meta">
        <h4>${s.title}</h4>
        <p class="dim">${s.desc}</p>
        <dl>${s.specs.map(([k, v]) => html`<div><dt>${k}</dt><dd class="mono">${v}</dd></div>`)}</dl>
        <p class="small dim">Hover the image for a loupe.</p>
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- counters
export function Count({ to, dec = 0, suffix = "", prefix = "" }) {
  const [ref, inView] = useInView({ threshold: 0.6 });
  const [v, setV] = useState(reduce ? to : 0);
  useEffect(() => {
    if (!inView || reduce) return;
    let raf, t0;
    const run = (t) => {
      t0 = t0 || t;
      const p = Math.min(1, (t - t0) / 1400), e = 1 - Math.pow(1 - p, 3);
      setV(to * e);
      if (p < 1) raf = requestAnimationFrame(run);
    };
    raf = requestAnimationFrame(run);
    return () => cancelAnimationFrame(raf);
  }, [inView]);
  return html`<span ref=${ref}>${prefix}${v.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })}${suffix}</span>`;
}
