// chip.js — the hero: the real 8x8 systolic-array die (SKY130, 1.96 mm) as a
// 3D package, with light pulses that follow the array's dataflow: activations
// move right along each row of PEs, partial sums move down each column, with
// the same diagonal skew the hardware uses.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// Tile centers in texture space. The render has a 52 px border on a 1932 px
// image; the die is 1960 um; PE tiles are 180 um on a 220 um pitch with a
// 120 um margin (openlane/tiled/top/make_config.py).
const U0 = 52 / 1932, PER_UM = (1828 / 1932) / 1960;
const tileC = (i) => U0 + (120 + 90 + 220 * i) * PER_UM;

const DIE_FRAG = /* glsl */ `
uniform sampler2D map; uniform float t; uniform float tc[8];
varying vec2 vUv;
void main() {
  vec3 base = texture2D(map, vUv).rgb;
  base = base * 1.05 + vec3(0.004, 0.006, 0.01);
  vec3 glow = vec3(0.0);
  float lo = tc[0] - 0.07, hi = tc[7] + 0.07;
  for (int k = 0; k < 8; k++) {
    float fk = float(k);
    // activation pulses: row k, entering k steps late (the input skew)
    float rv = 1.0 - tc[k];
    float dv = vUv.y - rv;
    float line = exp(-dv * dv * 9.0e4);
    for (int j = 0; j < 2; j++) {
      float p = fract(t * 0.11 - fk * 0.035 - float(j) * 0.5);
      float x = mix(lo, hi, p);
      float dx = vUv.x - x;
      float head = exp(-dx * dx * 6.0e3);
      float trail = dx < 0.0 ? exp(dx * 22.0) * smoothstep(lo, lo + 0.05, vUv.x) : 0.0;
      glow += vec3(0.25, 0.82, 1.0) * line * (head * 2.6 + trail * 0.55);
    }
    // partial sums: column k, flowing down, one step behind
    float cu = tc[k];
    float du = vUv.x - cu;
    float lineC = exp(-du * du * 9.0e4);
    for (int j = 0; j < 2; j++) {
      float q = fract(t * 0.11 - fk * 0.035 - 0.02 - float(j) * 0.5);
      float y = mix(1.0 - lo, 1.0 - hi, q);
      float dy = vUv.y - y;
      float headC = exp(-dy * dy * 6.0e3);
      float trailC = dy > 0.0 ? exp(-dy * 22.0) * smoothstep(1.0 - lo, 1.0 - lo - 0.05, vUv.y) : 0.0;
      glow += vec3(1.0, 0.6, 0.16) * lineC * (headC * 2.6 + trailC * 0.55);
    }
  }
  gl_FragColor = vec4(base + glow, 1.0);
}`;
const DIE_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export function mountChip(canvas, { texture, reducedMotion, onReady }) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  } catch (e) {
    return null;
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
  renderer.setPixelRatio(dpr);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 50);
  const rig = new THREE.Group();
  scene.add(rig);

  // package substrate
  const sub = new THREE.Mesh(
    new THREE.BoxGeometry(1.72, 0.05, 1.72),
    new THREE.MeshStandardMaterial({ color: 0x0b1411, roughness: 0.55, metalness: 0.2, envMapIntensity: 0.5 }));
  sub.position.y = -0.025;
  rig.add(sub);
  // substrate edge traces
  const gold = new THREE.MeshStandardMaterial({ color: 0xd8aa52, roughness: 0.34, metalness: 1.0, envMapIntensity: 0.75 });
  const pads = [], wires = [];
  const N = 22;
  for (let side = 0; side < 4; side++) {
    for (let i = 0; i < N; i++) {
      const s = -0.44 + (0.88 * i) / (N - 1);
      const rot = (v) => {
        const [x, z] = v;
        return side === 0 ? [x, z] : side === 1 ? [-z, x] : side === 2 ? [-x, -z] : [z, -x];
      };
      const [px, pz] = rot([s * 1.32, 0.74]);
      const pad = new THREE.BoxGeometry(0.022, 0.006, 0.05);
      if (side % 2) pad.rotateY(Math.PI / 2);
      pad.translate(px, 0.003, pz);
      pads.push(pad);
      const [dx, dz] = rot([s, 0.49]);
      const a = new THREE.Vector3(dx, 0.036, dz), b = new THREE.Vector3(px, 0.006, pz);
      const mid = a.clone().lerp(b, 0.42); mid.y = 0.11;
      wires.push(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(a, mid, b), 14, 0.0022, 4));
    }
  }
  rig.add(new THREE.Mesh(mergeGeometries(pads), gold));
  rig.add(new THREE.Mesh(mergeGeometries(wires), gold));

  // the die: a thin slab, top face is the GDS render with the dataflow shader
  const dieSide = new THREE.Mesh(
    new THREE.BoxGeometry(1.0, 0.035, 1.0),
    new THREE.MeshStandardMaterial({ color: 0x1a1d22, roughness: 0.35, metalness: 0.6 }));
  dieSide.position.y = 0.0175;
  rig.add(dieSide);
  const uniforms = { map: { value: texture }, t: { value: 0 }, tc: { value: Array.from({ length: 8 }, (_, i) => tileC(i)) } };
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const top = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
    new THREE.ShaderMaterial({ uniforms, vertexShader: DIE_VERT, fragmentShader: DIE_FRAG }));
  top.rotation.x = -Math.PI / 2;
  top.position.y = 0.0352;
  rig.add(top);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.8, 0.55, 0.7);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  let w = 0, h = 0, wide = true;
  function resize() {
    const r = canvas.getBoundingClientRect();
    w = Math.max(1, r.width); h = Math.max(1, r.height);
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
    uniforms.t.value = reducedMotion ? 3.2 : t;
    cur.x += (pointer.x - cur.x) * 0.05;
    cur.y += (pointer.y - cur.y) * 0.05;
    const scroll = Math.min(1, window.scrollY / Math.max(1, h));
    rig.rotation.y = -0.62 + cur.x * 0.35 + (reducedMotion ? 0 : Math.sin(t * 0.15) * 0.06) + scroll * 0.5;
    rig.rotation.x = 0.0 + cur.y * 0.12;
    rig.position.y = reducedMotion ? 0 : Math.sin(t * 0.6) * 0.012;
    const dist = wide ? 3.05 : 4.1;
    const el = 0.92 - scroll * 0.35;
    camera.position.set(Math.cos(el) * dist * 0.0, Math.sin(el) * dist, Math.cos(el) * dist);
    camera.lookAt(0, 0, 0);
    camera.setViewOffset(w, h, wide ? -w * 0.23 : 0, wide ? 0 : h * 0.2, w, h);
    composer.render();
    if (first) { first = false; onReady && onReady(); }
    if (visible && !(reducedMotion && !first)) raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf); ro.disconnect(); io.disconnect();
    window.removeEventListener("pointermove", onMove);
    renderer.dispose();
  };
}
