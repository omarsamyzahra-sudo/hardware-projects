// hero3d.js — the hero: the LLM weight decoder's SKY130 layout (ew-decoder/openlane), every cell where the
// placer put it and every routed wire on met1-met5, coloured by its job. The animation is the decoder's
// dataflow, one 8-weight chunk per beat as in the RTL: the chunk's 3-bit codes leave the tile registers, the
// eight lanes turn code + base into exponents and the chunk lands in the output registers; a lane whose code
// is 0 escapes, so the prefix popcount gives it a slot, the escape routing pulls its exponent byte from the
// window and the window shifts. Lanes escape at random at the measured rate (2.81% of Qwen2.5-0.5B weights
// fall outside the window). Meanwhile the next tile's three code words fill the staging registers.
// Data: assets/hero_decoder.json + .bin, written by ew-decoder/openlane/build_hero.py.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const UM = 1 / 190;                  // scene units per micron: the 0.37 mm die is ~2 units wide
const Z = 3;                         // heights exaggerated 3x so the layers read at this scale
const BEAT = 2.6, ESC = 0.0281;      // seconds per chunk; escape probability per weight [measured, Phase 1]
// layer z ranges in microns (SKY130 stack) and colours
const LAYER = [[1.38, 1.74, 0x5b8fd6], [2.0, 2.36, 0x47c1b0], [2.79, 3.63, 0xd8b04a], [4.02, 4.87, 0xe8c547], [5.37, 6.63, 0xe0883a]];

// kinds the shader animates
const K = { reg_cur: 1, reg_stg: 2, tile: 3, prefix: 4, lane: 5, escmux: 6, reg_win: 7, window: 8, reg_out: 9,
  ctrl: 10, reg_ctrl: 10, clock: 11, io: 12 };

// the decode cycle, shared by both shaders: beat b is chunk j = b mod 8 of the current tile
const CYCLE = /* glsl */ `
uniform float t;
float hash(float x) { return fract(sin(x * 12.9898 + 4.1414) * 43758.5453); }
float escaped(float b, float lane) { return step(hash(b * 8.0 + lane), ${ESC}); }
float hit(float f, float at, float k) { return smoothstep(at - 0.1, at, f) * exp(-max(f - at, 0.0) * k * 0.7); }
// how hard a cell or wire of this kind / lane / sub fires right now, delayed by d (fraction of a beat)
float act(float kind, float lane, float sub, float d) {
  float x = t / ${BEAT.toFixed(2)} - d, b = floor(x), f = fract(x), j = mod(b, 8.0);
  float need = 0.0;
  for (int i = 0; i < 8; i++) need += escaped(b, float(i));
  float any = step(0.5, need);
  if (kind == 1.0) return hit(f, 0.0, 5.0) * (floor(mod(sub, 64.0) / 8.0) == j ? 1.0 : j == 0.0 ? 0.25 : 0.0);
  if (kind == 2.0) return hit(f, 0.0, 4.0) * (j == floor(sub / 64.0) * 2.0 + 1.0 ? 1.0 : 0.0);
  if (kind == 3.0) return hit(f, 0.02, 5.0) * (j == 1.0 || j == 3.0 || j == 5.0 || j == 0.0 ? 0.8 : 0.0);
  if (kind == 4.0) return hit(f, 0.06, 6.0) * (0.15 + any);
  if (kind == 5.0) return hit(f, 0.12, 5.0) * 0.6;
  if (kind == 6.0) return hit(f, 0.18, 4.0) * (0.06 + escaped(b, lane));
  if (kind == 7.0) return hit(f, 0.2, 4.0) * (sub < need ? 1.2 : 0.18 * any);
  if (kind == 8.0) return hit(f, 0.28, 3.5) * any;
  if (kind == 9.0) return hit(f, 0.42, 4.5) * (0.85 + 0.6 * escaped(b, lane));
  if (kind == 10.0) return hit(f, 0.0, 7.0) * 0.12;
  if (kind == 11.0) return hit(f, 0.0, 9.0) * 0.1;
  if (kind == 12.0) return hit(f, 0.0, 5.0) * 0.1;
  return 0.0;
}`;

const CELL_VERT = /* glsl */ `
${CYCLE}
attribute vec4 aBox;   // centre x, centre z, width, depth (scene units)
attribute vec4 aMeta;  // kind, lane, sub, height (scene units)
attribute vec3 aColor;
varying vec3 vColor;
void main() {
  vec3 p = position * vec3(aBox.z, aMeta.w, aBox.w) + vec3(aBox.x, ${(0.4 * UM).toFixed(6)}, aBox.y);
  float a = aMeta.x > 0.0 ? act(aMeta.x, aMeta.y, aMeta.z, 0.0) : 0.0;
  float shade = normal.y > 0.5 ? 1.0 : 0.55;
  vColor = aColor * (aMeta.x > 0.0 ? 0.3 : 0.5) * shade + aColor * a * 0.85;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

// wires: drawn additively, faint in their layer's colour, lit in the colour of the cell driving the net
const WIRE_VERT = /* glsl */ `
${CYCLE}
attribute vec4 aBox;   // centre x, centre z, width, depth (scene units)
attribute vec4 aMeta;  // kind, lane, sub, layer
attribute vec3 aColor; // the driver's colour
uniform vec3 layerColor[5];
uniform vec2 layerY[5];
varying vec3 vColor;
void main() {
  int l = int(aMeta.w + 0.5);
  vec2 y = layerY[l];
  vec3 p = position * vec3(max(aBox.z, ${(0.55 * UM).toFixed(6)}), y.y - y.x, max(aBox.w, ${(0.55 * UM).toFixed(6)}))
         + vec3(aBox.x, y.x, aBox.y);
  float a = aMeta.x > 0.0 ? act(aMeta.x, aMeta.y, aMeta.z, 0.03 + 0.01 * aMeta.w) : 0.0;
  vColor = layerColor[l] * 0.055 + aColor * a * 0.45;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const FLAT_FRAG = /* glsl */ `
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0); }`;

export function mountDecoder(canvas, { head, buf, reducedMotion, onReady }) {
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

  const [sx, sy] = head.size, u = head.unit;
  const wx = (x) => (x - sx / 2) * UM, wz = (y) => (sy / 2 - y) * UM;   // layout y (north) -> scene -z
  const a = new Uint16Array(buf);
  const rgb = head.colors.map((h) => new THREE.Color(h));
  const kindOf = head.roles.map((r) => K[r] || 0);
  const fillRole = new Set(["filler", "decap", "tap"].map((r) => head.roles.indexOf(r)));

  // die slab
  const slab = new THREE.Mesh(new THREE.BoxGeometry(sx * UM, 0.03, sy * UM),
    new THREE.MeshStandardMaterial({ color: 0x0c1017, roughness: 0.45, metalness: 0.5 }));
  slab.position.y = -0.015;
  rig.add(slab);

  const uniforms = {
    t: { value: 0 },
    layerColor: { value: LAYER.map((l) => new THREE.Color(l[2])) },
    layerY: { value: LAYER.map((l) => new THREE.Vector2(l[0] * Z * UM, l[1] * Z * UM)) },
  };
  const cube = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const instanced = (n, attrs, vertexShader, extra) => {
    const g = new THREE.InstancedBufferGeometry();
    g.index = cube.index;
    g.setAttribute("position", cube.getAttribute("position"));
    g.setAttribute("normal", cube.getAttribute("normal"));
    for (const [k, v, s] of attrs) g.setAttribute(k, new THREE.InstancedBufferAttribute(v, s));
    g.instanceCount = n;
    const mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader: FLAT_FRAG, ...extra }));
    mesh.frustumCulled = false;
    rig.add(mesh);
  };

  // cells: x, y, w, h, role, lane, sub
  const nc = head.cells;
  const cBox = new Float32Array(nc * 4), cMeta = new Float32Array(nc * 4), cCol = new Float32Array(nc * 3);
  for (let i = 0; i < nc; i++) {
    const [x, y, w, h, r, lane, sub] = a.subarray(i * 7, i * 7 + 7);
    cBox.set([wx((x + w / 2) * u), wz((y + h / 2) * u), w * u * UM, h * u * UM], i * 4);
    cMeta.set([kindOf[r], lane, sub, (fillRole.has(r) ? 0.35 : 0.9) * Z * UM], i * 4);
    cCol.set([rgb[r].r, rgb[r].g, rgb[r].b], i * 3);
  }
  instanced(nc, [["aBox", cBox, 4], ["aMeta", cMeta, 4], ["aColor", cCol, 3]], CELL_VERT);

  // wires: x0, y0, x1, y1, layer, ref. Signal wires take their driver's kind and colour; the power grid
  // (met4 straps, met5 rails) is drawn as translucent metal instead
  const nw = head.wires, o = nc * 7;
  const wBox = new Float32Array(nw * 4), wMeta = new Float32Array(nw * 4), wCol = new Float32Array(nw * 3);
  const io = head.roles.indexOf("io"), grid = [];
  let n = 0;
  for (let i = 0; i < nw; i++) {
    const [x0, y0, x1, y1, l, ref] = a.subarray(o + i * 6, o + i * 6 + 6);
    if (ref === 65535) { if (l >= 3) grid.push([x0 * u, y0 * u, x1 * u, y1 * u, l]); continue; }
    const r = ref === 65534 ? io : a[ref * 7 + 4];
    wBox.set([wx((x0 + x1) / 2 * u), wz((y0 + y1) / 2 * u), (x1 - x0) * u * UM, (y1 - y0) * u * UM], n * 4);
    wMeta.set([kindOf[r], ref === 65534 ? 8 : a[ref * 7 + 5], ref === 65534 ? 0 : a[ref * 7 + 6], l], n * 4);
    wCol.set([rgb[r].r, rgb[r].g, rgb[r].b], n * 3);
    n++;
  }
  instanced(n, [["aBox", wBox, 4], ["aMeta", wMeta, 4], ["aColor", wCol, 3]], WIRE_VERT,
    { blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });

  const m = new THREE.Matrix4();
  for (const l of [3, 4]) {
    const rects = grid.filter((g) => g[4] === l);
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({
      color: LAYER[l][2], roughness: 0.3, metalness: 0.9, transparent: true, opacity: l === 3 ? 0.3 : 0.4, depthWrite: false }), rects.length);
    rects.forEach(([x0, y0, x1, y1], k) => {
      m.makeScale((x1 - x0) * UM, (LAYER[l][1] - LAYER[l][0]) * Z * UM, (y1 - y0) * UM);
      m.setPosition(wx((x0 + x1) / 2), (LAYER[l][0] + LAYER[l][1]) / 2 * Z * UM, wz((y0 + y1) / 2));
      mesh.setMatrixAt(k, m);
    });
    rig.add(mesh);
  }

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.35, 0.6, 0.82);
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
    uniforms.t.value = reducedMotion ? 0.12 * BEAT : t;
    cur.x += (pointer.x - cur.x) * 0.05;
    cur.y += (pointer.y - cur.y) * 0.05;
    rig.rotation.y = -0.5 + cur.x * 0.3 + (reducedMotion ? 0 : Math.sin(t * 0.13) * 0.08);
    rig.rotation.x = cur.y * 0.1;
    const dist = wide ? 4.7 : Math.max(4.7, 5.2 / camera.aspect), el = 0.98;   // portrait: fit the die across the width
    camera.position.set(0, Math.sin(el) * dist, Math.cos(el) * dist);
    camera.lookAt(0, 0, 0);
    camera.setViewOffset(w, h, wide ? -w * 0.19 : 0, wide ? 0 : h * 0.27, w, h);
    composer.render();
    if (first) { first = false; onReady && onReady(); }
    if (visible && !reducedMotion) raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf); ro.disconnect(); iob.disconnect();
    window.removeEventListener("pointermove", onMove);
    renderer.dispose();
  };
}
