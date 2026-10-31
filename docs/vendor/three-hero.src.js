// three-hero.src.js — the parts of three.js 0.160 the heroes use (hero_engine.js, hero3d.js), bundled and
// minified into three-hero.js so the hero loads as one same-origin file instead of a chain of ~11 CDN modules:
//
//   npm i three@0.160.0 esbuild && npx esbuild three-hero.src.js --bundle --minify --format=esm --outfile=three-hero.js
export {
  ACESFilmicToneMapping, AdditiveBlending, BoxGeometry, Color, DirectionalLight, Group, HemisphereLight,
  InstancedBufferAttribute, InstancedBufferGeometry, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, QuadraticBezierCurve3, SRGBColorSpace, Scene,
  ShaderMaterial, TextureLoader, TubeGeometry, Vector2, Vector3, WebGLRenderer,
} from "three";
export { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
export { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
export { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
export { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
