// hero_engine.js — the hero, whole-engine version: the ew-decoder engine's SKY130 layout (ew_top: AXI read
// streams and FIFOs, the weight decoder, the activation buffer, BF16 multipliers, the FP32 adder tree, the
// accumulator and the output stream) as a map of the 2.8 mm die. The die is cut into 256 x 256 bins; each bin
// (merged 2 x 2) is a column in the colour of the block that owns most of its logic, taller the fuller of logic it
// is; storage is drawn low and the compute blocks as towers so the datapath stands out.
// The animation is the dataflow, simplified: a wave runs through the blocks in the order data does (streams ->
// decoder and x buffer -> multipliers -> adder tree -> accumulator -> output), and arcs between the blocks'
// centres carry it from one to the next. In the real pipeline every block is busy every cycle; the wave and
// the arcs are for the eye. Data: assets/hero_engine.json + .bin (ew-decoder/openlane/build_hero_engine.py).
import * as THREE from "./vendor/three-hero.js";   // three.js 0.160, the parts used here, bundled (vendor/three-hero.src.js)
import { EffectComposer, RenderPass, UnrealBloomPass, OutputPass } from "./vendor/three-hero.js";

const UM = 2 / 2780;                 // scene units per micron: the 2.8 mm die is ~2 units wide
const PERIOD = 6;                    // seconds per trip through the engine
const RISE = 0.35;                   // seconds a column takes to brighten
const HMAX = 0.13;                   // tallest column, scene units
const MERGE = 2;                     // columns are MERGE x MERGE bins, so gaps between them show
// storage (FIFOs, the activation buffer) is drawn low and the compute blocks as towers: a liberty for the look
const LIFT = { fifo_in: 0.45, xbuf: 0.45, axi_in: 0.6, ctrl: 0.35, out: 0.6 };
// when the wave reaches each block (fraction of the period) and what it comes from, for its direction
const FLOW = {
  axi_in: [0.0, null], fifo_in: [0.1, "axi_in"], xbuf: [0.1, "axi_in"], dec: [0.22, "fifo_in"],
  mul: [0.36, "dec"], add: [0.48, "mul"], acc: [0.6, "add"], out: [0.7, "acc"],
};
const ARCS = [["axi_in", "fifo_in"], ["axi_in", "xbuf"], ["fifo_in", "dec"], ["dec", "mul"], ["xbuf", "mul"],
  ["mul", "add"], ["add", "acc"], ["acc", "out"]];
const SPREAD = 0.2;                  // how long the wave takes to cross one block
// how brightly each block lights: the big storage blocks gently, the datapath fully
const GLOW = { axi_in: 0.7, fifo_in: 0.35, xbuf: 0.3, dec: 1, mul: 1, add: 1, acc: 1, out: 0.6 };

const HIT = /* glsl */ `
uniform float t;
float hit(float f, float at, float k) {
  float r = ${(RISE / PERIOD).toFixed(4)};
  return smoothstep(at, at + r, f) * exp(-max(f - at - r, 0.0) * k);
}
float wave(float at, float k) {
  float x = t / ${PERIOD.toFixed(1)}, f = fract(x);
  return hit(f, at, k) + hit(f + 1.0, at, k);
}`;

const COL_VERT = /* glsl */ `
${HIT}
attribute vec4 aCol;    // centre x, centre z, height, block
attribute vec2 aWave;   // arrival (fraction of the period, < 0: never), random
uniform vec3 blockColor[9];
uniform float blockGlow[9];
uniform float foot;
varying vec3 vColor;
void main() {
  int k = int(aCol.w + 0.5);
  vec3 c = blockColor[k];
  float a = aWave.x < 0.0 ? 0.0 : wave(aWave.x, 11.0) * (0.7 + 0.6 * aWave.y) * blockGlow[k];
  float h = aCol.z * (1.0 + 0.35 * a);
  vec3 p = position * vec3(foot, h, foot) + vec3(aCol.x, 0.0, aCol.y);
  float shade = normal.y > 0.5 ? 0.22 : normal.x != 0.0 ? 0.1 : 0.15;
  shade *= normal.y > 0.5 ? 1.0 : 0.55 + 0.45 * position.y;
  vColor = c * shade * (0.75 + 0.5 * aWave.y) + mix(c, vec3(1.0), 0.12) * a * 0.6;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const FLAT_FRAG = /* glsl */ `
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0); }`;

// an arc: faint all the time, with a bright packet that leaves when the wave leaves its source block and
// lands when the wave reaches the destination
const ARC_VERT = /* glsl */ `
varying float s;
void main() { s = uv.x; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const ARC_FRAG = /* glsl */ `
${HIT}
uniform vec3 c0, c1;
uniform vec2 span;
varying float s;
void main() {
  float f = fract(t / ${PERIOD.toFixed(1)});
  float head = (f - span.x) / (span.y - span.x);
  float on = smoothstep(-0.05, 0.05, head) * (1.0 - smoothstep(1.0, 1.35, head));
  float d = head - s;
  float packet = (exp(-d * d * 220.0) + step(0.0, d) * exp(-d * 5.0) * 0.35) * on;
  vec3 c = mix(c0, c1, s);
  gl_FragColor = vec4(c * (0.09 + packet * 1.3), 1.0);
}`;

export function mountEngine(canvas, { head, buf, reducedMotion, onReady }) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  } catch (e) {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
  const rig = new THREE.Group();
  scene.add(rig);
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x10141c, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(-2, 4, 3);
  scene.add(sun);

  const [sx, sy] = head.size, G = head.grid, B = head.blocks;
  const bx = sx / G, by = sy / G;
  const wx = (x) => (x - sx / 2) * UM, wz = (y) => (sy / 2 - y) * UM;   // layout y (north) -> scene -z
  const bins = new Uint8Array(buf, 0, G * G * 2);

  // die slab
  const slab = new THREE.Mesh(new THREE.BoxGeometry(sx * UM * 1.02, 0.03, sy * UM * 1.02),
    new THREE.MeshStandardMaterial({ color: 0x0c1017, roughness: 0.45, metalness: 0.5 }));
  slab.position.y = -0.015;
  rig.add(slab);

  // merge MERGE x MERGE bins: the block with the most logic among them, and their mean density
  const M = G / MERGE, cx = bx * MERGE, cy = by * MERGE;
  const blk = new Uint8Array(M * M).fill(255), den = new Float32Array(M * M);
  for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
    const vote = new Float32Array(B.length);
    let s = 0;
    for (let dj = 0; dj < MERGE; dj++) for (let di = 0; di < MERGE; di++) {
      const q = ((j * MERGE + dj) * G + i * MERGE + di) * 2, d = bins[q + 1] / 255;
      if (bins[q] !== 255) vote[bins[q]] += d;
      s += d;
    }
    let best = -1;
    vote.forEach((v, k) => { if (v > 0 && (best < 0 || v > vote[best])) best = k; });
    if (best >= 0) { blk[j * M + i] = best; den[j * M + i] = s / (MERGE * MERGE); }
  }

  // where the wave enters each block: along the line from its source block's centre (or the die's east edge)
  const cen = Object.fromEntries(B.map((b) => [b, head.centroids[b]]));
  const dir = {}, lo = {}, hi = {};
  for (const b of B) {
    if (!FLOW[b]) continue;
    const from = FLOW[b][1] ? cen[FLOW[b][1]] : [sx, cen[b][1]];
    const dx = cen[b][0] - from[0], dy = cen[b][1] - from[1], l = Math.hypot(dx, dy) || 1;
    dir[b] = [dx / l, dy / l]; lo[b] = Infinity; hi[b] = -Infinity;
  }
  const cells = [];
  for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
    const k = blk[j * M + i];
    if (k === 255) continue;
    const b = B[k], x = (i + 0.5) * cx, y = (j + 0.5) * cy;
    const p = dir[b] ? x * dir[b][0] + y * dir[b][1] : 0;
    if (dir[b]) { lo[b] = Math.min(lo[b], p); hi[b] = Math.max(hi[b], p); }
    cells.push([x, y, k, p, den[j * M + i]]);
  }
  const n = cells.length;
  const aCol = new Float32Array(n * 4), aWave = new Float32Array(n * 2);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  cells.forEach(([x, y, k, p, d], q) => {
    const b = B[k], r = rnd();
    aCol.set([wx(x), wz(y), HMAX * (LIFT[b] || 1) * (0.08 + 0.92 * Math.pow(Math.min(1, d * 1.2), 1.2)) * (0.85 + 0.3 * r), k], q * 4);
    aWave.set([FLOW[b] ? FLOW[b][0] + SPREAD * (p - lo[b]) / Math.max(1, hi[b] - lo[b]) : -1, rnd()], q * 2);
  });

  const uniforms = {
    t: { value: 0 },
    blockColor: { value: head.colors.map((c) => new THREE.Color(c)) },
    blockGlow: { value: B.map((b) => GLOW[b] || 0) },
    foot: { value: Math.min(cx, cy) * UM * 0.72 },
  };
  const cube = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const g = new THREE.InstancedBufferGeometry();
  g.index = cube.index;
  g.setAttribute("position", cube.getAttribute("position"));
  g.setAttribute("normal", cube.getAttribute("normal"));
  g.setAttribute("aCol", new THREE.InstancedBufferAttribute(aCol, 4));
  g.setAttribute("aWave", new THREE.InstancedBufferAttribute(aWave, 2));
  g.instanceCount = n;
  const city = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms, vertexShader: COL_VERT, fragmentShader: FLAT_FRAG }));
  city.frustumCulled = false;
  rig.add(city);

  // arcs between block centres
  for (const [a, b] of ARCS) {
    const p0 = new THREE.Vector3(wx(cen[a][0]), HMAX * 0.8, wz(cen[a][1]));
    const p1 = new THREE.Vector3(wx(cen[b][0]), HMAX * 0.8, wz(cen[b][1]));
    const mid = p0.clone().add(p1).multiplyScalar(0.5);
    mid.y += 0.12 + 0.3 * p0.distanceTo(p1);
    const curve = new THREE.QuadraticBezierCurve3(p0, mid, p1);
    const mat = new THREE.ShaderMaterial({
      uniforms: { t: uniforms.t, c0: { value: new THREE.Color(head.colors[B.indexOf(a)]) },
        c1: { value: new THREE.Color(head.colors[B.indexOf(b)]) },
        span: { value: new THREE.Vector2(FLOW[a][0] + SPREAD * 0.6, FLOW[b][0] + 0.02) } },
      vertexShader: ARC_VERT, fragmentShader: ARC_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    rig.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 128, 0.0055, 8, false), mat));
  }

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.3, 0.6, 0.85);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  let w = 0, h = 0, wide = true;
  function resize() {
    const rc = canvas.getBoundingClientRect();
    w = Math.max(1, rc.width); h = Math.max(1, rc.height);
    wide = w / h > 1.15;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    bloom.resolution.set(w / 2, h / 2);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  const pointer = { x: 0, y: 0 }, cur = { x: 0, y: 0 };
  const onMove = (e) => { pointer.x = e.clientX / window.innerWidth - 0.5; pointer.y = e.clientY / window.innerHeight - 0.5; };
  window.addEventListener("pointermove", onMove, { passive: true });

  let raf = 0, visible = true, t0 = performance.now(), first = true;
  const iob = new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible && !raf) raf = requestAnimationFrame(frame); });
  iob.observe(canvas);

  function frame(now) {
    raf = 0;
    const t = (now - t0) / 1000;
    uniforms.t.value = reducedMotion ? 0.45 * PERIOD : t;
    cur.x += (pointer.x - cur.x) * 0.05;
    cur.y += (pointer.y - cur.y) * 0.05;
    rig.rotation.y = -0.5 + cur.x * 0.3 + (reducedMotion ? 0 : Math.sin(t * 0.13) * 0.08);
    rig.rotation.x = cur.y * 0.1;
    const dist = wide ? 4.3 : Math.max(4.6, 5.2 / camera.aspect), el = 0.8;   // portrait: fit the die across the width
    camera.position.set(0, Math.sin(el) * dist, Math.cos(el) * dist);
    camera.lookAt(0, 0, 0);
    camera.setViewOffset(w, h, wide ? -w * 0.24 : 0, wide ? h * 0.06 : h * 0.27, w, h);
    composer.render();
    if (first) { first = false; onReady && onReady(); }
    if (visible && !reducedMotion) raf = requestAnimationFrame(frame);
  }
  frame(performance.now());          // first frame now, not a frame later

  return () => {
    cancelAnimationFrame(raf); ro.disconnect(); iob.disconnect();
    window.removeEventListener("pointermove", onMove);
    renderer.dispose();
  };
}
