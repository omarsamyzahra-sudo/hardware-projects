// hero3d.js — the hero: the tiled 8x8 systolic array from the 3D layout model
// (systolic-accel/openlane/viewer3d), at full-die scale. Every logic cell of
// every PE sits where the placer put it, coloured by its job as in the viewer's
// "cell functions" view, under the met4/met5 power grid. The animation is the
// array's dataflow: activations enter each row one cycle later than the row
// above (the input skew) and move right, partial sums move down, so each PE
// fires on the diagonal wavefront; inside a PE the activation registers light
// first, then the multiplier, the adder and the partial-sum registers.
// Data: assets/hero_array.json, written by viewer3d/build_hero.py.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const UM = 1 / 1000;                 // scene units per micron: the 1.96 mm die is 1.96 units wide
const Z = 3;                         // heights exaggerated 3x so the layers read at this scale
const RATE = 0.16, SKEW = 1 / 18;    // wavefronts per second; phase lag per PE step

// phase of the wavefront at PE (row r, column c); the same expression in both shaders
const PHASE = /* glsl */ `
uniform float t;
float wave(float r, float c, float lag) { return fract(t * ${RATE.toFixed(3)} - (r + c) * ${SKEW.toFixed(5)} - lag); }`;

const CELL_VERT = /* glsl */ `
${PHASE}
attribute vec4 aBox;   // centre x, centre z, width, depth (scene units)
attribute vec4 aMeta;  // role, pe row, pe column, glow kind
attribute vec3 aColor;
varying vec3 vColor;
void main() {
  vec3 p = position * vec3(aBox.z, ${(0.9 * Z * UM).toFixed(6)}, aBox.w) + vec3(aBox.x, ${(0.4 * UM).toFixed(6)}, aBox.y);
  float k = aMeta.w;   // 0 none, 1 activation, 2 multiply, 3 add, 4 partial sum, 5 weight
  float lag = k == 1.0 ? 0.0 : k == 2.0 ? 0.012 : k == 3.0 ? 0.024 : k == 4.0 ? 0.036 : 0.0;
  float u = wave(aMeta.y, aMeta.z, lag);
  float pulse = k > 0.0 && k < 5.0 ? exp(-u * 26.0) : 0.0;
  float shade = normal.y > 0.5 ? 1.0 : 0.5;
  vec3 hot = k == 1.0 ? vec3(0.3, 0.85, 1.0) : k == 4.0 ? vec3(1.0, 0.62, 0.15) : aColor;
  float gain = k == 1.0 || k == 4.0 ? 2.6 : 0.9;
  vColor = aColor * (k == 0.0 ? 0.3 : 0.45) * shade + hot * pulse * gain;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const FLAT_FRAG = /* glsl */ `
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0); }`;

// the systolic buses drawn over the array: a line per row (activations, right) and per column (sums, down)
const BUS_VERT = /* glsl */ `
attribute vec3 aBus;   // lane, position along the lane in PE steps, 0 = row / 1 = column
varying vec3 vBus;
void main() { vBus = aBus; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const BUS_FRAG = /* glsl */ `
${PHASE}
varying vec3 vBus;
void main() {
  float u = vBus.z < 0.5 ? wave(vBus.x, vBus.y, 0.0) : wave(vBus.y, vBus.x, 0.03);
  float head = exp(-u * 40.0) + 0.35 * exp(-u * 9.0);
  vec3 c = vBus.z < 0.5 ? vec3(0.3, 0.85, 1.0) : vec3(1.0, 0.62, 0.15);
  float ends = smoothstep(-0.9, -0.4, vBus.y) * smoothstep(7.9, 7.4, vBus.y);
  gl_FragColor = vec4(c * (head * 1.8 + 0.06) * ends, 1.0);
}`;

const KIND = { reg_act: 1, reg_skew: 1, mult: 2, adder: 3, reg_ps: 4, reg_deskew: 4, reg_w: 5 };

export function mountArray(canvas, { data, reducedMotion, onReady }) {
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

  const { size, grid, colors } = data;
  const half = size / 2;
  const wx = (x) => (x - half) * UM, wz = (y) => (half - y) * UM;   // layout y (north) -> scene -z
  const peX = (c) => grid.margin + c * grid.pitch, peY = (r) => size - grid.margin - grid.tile - r * grid.pitch;

  // die slab and the 64 PE footprints
  const slab = new THREE.Mesh(new THREE.BoxGeometry(size * UM, 0.03, size * UM),
    new THREE.MeshStandardMaterial({ color: 0x0c1017, roughness: 0.45, metalness: 0.5 }));
  slab.position.y = -0.015;
  rig.add(slab);
  const plate = new THREE.InstancedMesh(new THREE.BoxGeometry(grid.tile * UM, 0.4 * UM, grid.tile * UM),
    new THREE.MeshStandardMaterial({ color: 0x1b2230, roughness: 0.6, metalness: 0.3 }), grid.n * grid.n);
  const m = new THREE.Matrix4();
  for (let r = 0; r < grid.n; r++) for (let c = 0; c < grid.n; c++) {
    m.makeTranslation(wx(peX(c) + grid.tile / 2), 0.2 * UM, wz(peY(r) + grid.tile / 2));
    plate.setMatrixAt(r * grid.n + c, m);
  }
  rig.add(plate);

  // cells: one instanced unit cube, placed and coloured per instance
  const rgb = colors.map((h) => new THREE.Color(h));
  const pe = data.pe_cells, top = data.top_cells;
  const count = (pe.length / 5) * grid.n * grid.n + top.length / 5;
  const box = new Float32Array(count * 4), meta = new Float32Array(count * 4), col = new Float32Array(count * 3);
  let i = 0;
  const put = (x, y, w, h, role, r, c) => {
    box.set([wx(x + w / 2), wz(y + h / 2), w * UM, h * UM], i * 4);
    meta.set([role, r, c, KIND[data.roles[role]] || 0], i * 4);
    const k = rgb[role];
    col.set([k.r, k.g, k.b], i * 3);
    i++;
  };
  for (let r = 0; r < grid.n; r++) for (let c = 0; c < grid.n; c++)
    for (let j = 0; j < pe.length; j += 5) put(peX(c) + pe[j], peY(r) + pe[j + 1], pe[j + 2], pe[j + 3], pe[j + 4], r, c);
  // top-level cells take the phase of the PE row / column they sit beside
  for (let j = 0; j < top.length; j += 5) {
    const x = top[j], y = top[j + 1];
    const c = (x - grid.margin - grid.tile / 2) / grid.pitch, r = (size - y - grid.margin - grid.tile / 2) / grid.pitch;
    put(x, y, top[j + 2], top[j + 3], top[j + 4], r, c);
  }
  const cube = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const cg = new THREE.InstancedBufferGeometry();
  cg.index = cube.index;
  cg.setAttribute("position", cube.getAttribute("position"));
  cg.setAttribute("normal", cube.getAttribute("normal"));
  cg.setAttribute("aBox", new THREE.InstancedBufferAttribute(box, 4));
  cg.setAttribute("aMeta", new THREE.InstancedBufferAttribute(meta, 4));
  cg.setAttribute("aColor", new THREE.InstancedBufferAttribute(col, 3));
  cg.instanceCount = count;
  const uniforms = { t: { value: 0 } };
  const cellsMesh = new THREE.Mesh(cg, new THREE.ShaderMaterial({ uniforms, vertexShader: CELL_VERT, fragmentShader: FLAT_FRAG }));
  cellsMesh.frustumCulled = false;
  rig.add(cellsMesh);

  // power grid: met4 straps (in every PE and at the top level) and met5 rails, as thin translucent metal
  const metal = (rects, y0, y1, color, opacity, offsets) => {
    const n = (rects.length / 4) * offsets.length;
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.9, transparent: true, opacity, depthWrite: false }), n);
    let k = 0;
    for (const [ox, oy] of offsets) for (let j = 0; j < rects.length; j += 4) {
      const [x0, y0_, x1, y1_] = rects.slice(j, j + 4);
      m.makeScale((x1 - x0) * UM, (y1 - y0) * Z * UM, (y1_ - y0_) * UM);
      m.setPosition(wx(ox + (x0 + x1) / 2), (y0 + y1) / 2 * Z * UM, wz(oy + (y0_ + y1_) / 2));
      mesh.setMatrixAt(k++, m);
    }
    rig.add(mesh);
  };
  const peOffsets = [];
  for (let r = 0; r < grid.n; r++) for (let c = 0; c < grid.n; c++) peOffsets.push([peX(c), peY(r)]);
  metal(data.pe_met4, 4.02, 4.87, 0xe8c547, 0.35, peOffsets);
  metal(data.met4, 4.02, 4.87, 0xe8c547, 0.35, [[0, 0]]);
  metal(data.met5, 5.37, 6.63, 0xe0883a, 0.45, [[0, 0]]);

  // buses: 8 row lines and 8 column lines through the PE centres, above the metal
  const pos = [], bus = [], idx = [];
  const lineW = 4 * UM, yb = 8 * Z * UM;
  const quad = (lane, dir) => {
    const n0 = pos.length / 3, steps = 40;
    for (let s = 0; s <= steps; s++) {
      const a = -0.9 + (8.8 * s) / steps;                       // PE steps along the lane
      const along = grid.margin + grid.tile / 2 + a * grid.pitch;
      const across = grid.margin + grid.tile / 2 + lane * grid.pitch;
      for (const side of [-1, 1]) {
        if (dir === 0) pos.push(wx(along), yb, wz(size - across) + side * lineW);
        else pos.push(wx(across) + side * lineW, yb, wz(size - along));
        bus.push(lane, a, dir);
      }
      if (s) { const q = n0 + (s - 1) * 2; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
    }
  };
  for (let k = 0; k < grid.n; k++) { quad(k, 0); quad(k, 1); }
  const bg = new THREE.BufferGeometry();
  bg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  bg.setAttribute("aBus", new THREE.Float32BufferAttribute(bus, 3));
  bg.setIndex(idx);
  rig.add(new THREE.Mesh(bg, new THREE.ShaderMaterial({ uniforms, vertexShader: BUS_VERT, fragmentShader: BUS_FRAG,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide })));

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.45, 0.8);
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
  const io = new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible && !raf) raf = requestAnimationFrame(frame); });
  io.observe(canvas);

  function frame(now) {
    raf = 0;
    const t = (now - t0) / 1000;
    uniforms.t.value = reducedMotion ? 2.4 : t;
    cur.x += (pointer.x - cur.x) * 0.05;
    cur.y += (pointer.y - cur.y) * 0.05;
    rig.rotation.y = -0.5 + cur.x * 0.3 + (reducedMotion ? 0 : Math.sin(t * 0.13) * 0.08);
    rig.rotation.x = cur.y * 0.1;
    const dist = wide ? 4.7 : Math.max(4.7, 4.0 / camera.aspect), el = 0.98;   // portrait: fit the die across the width
    camera.position.set(0, Math.sin(el) * dist, Math.cos(el) * dist);
    camera.lookAt(0, 0, 0);
    camera.setViewOffset(w, h, wide ? -w * 0.19 : 0, wide ? 0 : h * 0.27, w, h);
    composer.render();
    if (first) { first = false; onReady && onReady(); }
    if (visible && !reducedMotion) raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf); ro.disconnect(); io.disconnect();
    window.removeEventListener("pointermove", onMove);
    renderer.dispose();
  };
}
