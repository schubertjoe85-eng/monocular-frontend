/* Monocular on-phone renderer (runs inside a WebView, bundled by build.mjs).
 *
 * Same engine as Monocular Desktop's built-in renderer: the user's own model,
 * so the geometry is exact; the sun at its real position for the site and time;
 * the desktop's painted sky; and the same patched path tracer for Photoreal.
 * Nothing leaves the phone.
 *
 * Talks to React Native through window.ReactNativeWebView.postMessage (out) and
 * window.__mono (in) - see LocalRenderScreen.js.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { ColladaLoader } from "three/addons/loaders/ColladaLoader.js";
import * as Engine from "./engine.js";
import * as Builder from "./builder.js";
import * as Drawings from "./drawings.js";

const PHOTO_EXPOSURE = 0.9, RASTER_EXPOSURE = 1.0, RASTER_SUN_GAIN = 2.2;
const PHOTO_SAMPLES = 120;          // enough to converge on a phone; desktop uses ~150
const PHOTO_TIME_LIMIT_MS = 120000; // never leave the user waiting forever
// No site: a fixed, pleasant sun rather than one pretending to be real.
const DEFAULT_SUN = { azimuth: 220 * Math.PI / 180, elevation: 35 * Math.PI / 180 };
const CLAY = new THREE.MeshStandardMaterial({ color: 0xd9d9d2, roughness: 0.92, metalness: 0 });

const $ = id => document.getElementById(id);
const post = msg => { try { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); } catch {} };
const status = text => { $("status").textContent = text || ""; };

let renderer, scene, camera, controls, site, sun, hemi;
let modelRoot = null, origMats = new Map(), modelRadius = 5;
let groundImage = false;   // true once the real satellite image is the ground
let siteImages = {};       // metres span -> data URL of the Apple Maps satellite image (220 / 1100 / 5500)
let osmRaw = null;         // parsed OpenStreetMap buildings around the site (see parseOsm)
let neighbours = null;     // group of the neighbouring buildings
let nbSummary = "";
let mapNear = null, mapWide = null;   // Apple standard map (220 m / 1100 m) base64 PNGs, traced where OSM is thin
let traced = null;                     // traced footprints, once both are in
let holdFrame = false;     // a finished photoreal render stays on screen until the view is touched
let clayOn = false, hours = 10, siteInfo = null, rendering = false, photo = null, skyTex = null, cancelRender = false;

function init() {
  const canvas = $("view");
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  } catch (e) {
    status("This device can't run the 3D renderer (no WebGL 2).");
    post({ type: "error", error: "WebGL unavailable: " + (e && e.message) });
    return;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = RASTER_EXPOSURE;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);
  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20000);
  camera.position.set(12, 8, 12);
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  // only the user's own touch cancels a render - not the app nudging the view (e.g. as the terrain arrives)
  controls.addEventListener("start", () => { if (rendering) cancelRender = true; holdFrame = false; });

  hemi = new THREE.HemisphereLight(0xe6eef8, 0x6e6a5c, 1.6);
  scene.add(hemi);
  sun = new THREE.DirectionalLight(0xffffff, 2.7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  site = Engine.createSite(scene);
  site.sky.visible = false;

  window.addEventListener("resize", resize);
  resize();
  bindUi();
  applySun();
  renderer.setAnimationLoop(() => {
    if (rendering || holdFrame) return;
    const w = window.innerWidth, h = Math.max(1, window.innerHeight - $("panel").offsetHeight);
    if (w !== lastW || h !== lastH) resize();
    controls.update(); syncModelClip(); renderer.render(scene, camera); drawOverlay();
  });
  status("Open a 3D model (.dae, .glb, .obj) or a PDF drawing set, or build one from a SKETCH.");
  post({ type: "ready" });
}

let lastW = 0, lastH = 0;
function resize() {
  const w = window.innerWidth, h = Math.max(1, window.innerHeight - $("panel").offsetHeight);
  lastW = w; lastH = h;
  renderer.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}

/* ---------------- sun & sky ---------------- */
function sunNow() {
  if (!siteInfo) return { ...DEFAULT_SUN, real: false };
  const p = Engine.solarPosition(Engine.siteDate(hours, siteInfo.lng), siteInfo.lat, siteInfo.lng);
  return { ...p, real: true };
}
function applySun() {
  const p = sunNow();
  const dir = Engine.sunDirection(p.azimuth, p.elevation);
  const elevDeg = p.elevation * 180 / Math.PI;
  const day = THREE.MathUtils.clamp(elevDeg / 25, 0, 1);
  const r = Math.max(modelRadius * 6, 20);
  // aimed at the model (wherever MOVE has put it), so its shadow map covers it
  const c = modelRoot ? new THREE.Box3().setFromObject(modelRoot).getCenter(new THREE.Vector3()) : new THREE.Vector3();
  sun.position.copy(dir).multiplyScalar(r).add(c);
  sun.target.position.copy(c);
  const base = elevDeg > 0 ? 2.7 * Math.pow(day, 0.55) : 0;
  sun.intensity = base * (rendering ? 1 : RASTER_SUN_GAIN);
  sun.color.lerpColors(new THREE.Color(0xff9a4d), new THREE.Color(0xfff4e6), THREE.MathUtils.clamp(elevDeg / 22, 0, 1));
  sun.castShadow = elevDeg > 0 && planCut == null;   // the floors above are cut away in INTERIOR: no shadow from them
  const sc = sun.shadow.camera, sr = Math.max(modelRadius * 2.2, 5);
  sc.left = -sr; sc.right = sr; sc.top = sr; sc.bottom = -sr; sc.near = 0.1; sc.far = r * 2.5; sc.updateProjectionMatrix();
  hemi.intensity = 0.35 + 1.85 * day;
  if (skyTex) { skyTex.dispose(); skyTex = null; }
  const hh = Math.floor(hours), mm = Math.round((hours - hh) * 60);
  $("timeLabel").textContent = siteInfo
    ? `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")} · real sun${elevDeg <= 0 ? " (below the horizon)" : ""}`
    : "Default sun · find an address for the real sun";
  scene.background = skyTexture(dir, elevDeg);
}
// The path tracer reads environment maps as raw float data, so the painted sky becomes a float DataTexture
// (the same conversion as desktop's currentSky()).
function skyTexture(dir, elevDeg) {
  if (skyTex) return skyTex;
  const cv = Engine.makeSkyCanvas(dir, elevDeg, {}, 512, 256), W = cv.width, H = cv.height;
  const px = cv.getContext("2d").getImageData(0, 0, W, H).data, f = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, o = ((H - 1 - y) * W + x) * 4;
    f[o] = Math.pow(px[i] / 255, 2.2); f[o + 1] = Math.pow(px[i + 1] / 255, 2.2); f[o + 2] = Math.pow(px[i + 2] / 255, 2.2); f[o + 3] = 1;
  }
  skyTex = new THREE.DataTexture(f, W, H, THREE.RGBAFormat, THREE.FloatType);
  skyTex.mapping = THREE.EquirectangularReflectionMapping; skyTex.colorSpace = THREE.LinearSRGBColorSpace;
  // Nearest, not linear: iPhones' WebGL has no linear filtering for 32-bit float textures (no
  // OES_texture_float_linear), so a linear-filtered float sky renders black there. The sky is a smooth gradient, so
  // nearest sampling looks the same.
  skyTex.magFilter = THREE.NearestFilter; skyTex.minFilter = THREE.NearestFilter; skyTex.generateMipmaps = false; skyTex.needsUpdate = true;
  return skyTex;
}

/* ---------------- model ---------------- */
let incoming = null, incomingOsm = null, incomingSketch = null, osmDone = false;
function b64ToBytes(b64) {
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function parseModel(name, bytes) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "glb" || ext === "gltf") {
    const gltf = await new GLTFLoader().parseAsync(bytes.buffer, "");
    return gltf.scene;
  }
  const text = new TextDecoder().decode(bytes);
  if (ext === "obj") {
    // ArchiCAD/CAD exports are Z-up; three.js is Y-up. Stand it upright (TURN covers stragglers).
    const obj = new OBJLoader().parse(text);
    obj.rotation.x = -Math.PI / 2;
    return obj;
  }
  if (ext === "dae") {
    const dae = new ColladaLoader().parse(text, "");
    if (!dae || !dae.scene) throw new Error("This .dae file has no geometry.");
    return dae.scene;
  }
  throw new Error("Unsupported file type ." + ext + " — use .dae, .glb or .obj.");
}
function setModel(root) {
  holdFrame = false;
  if (modelRoot) scene.remove(modelRoot);
  origMats = new Map();
  modelRoot = new THREE.Group();
  modelRoot.add(root);
  root.updateMatrixWorld(true);
  // Centre on the origin with the base on the ground, so the sun and ground sit around it.
  const box = new THREE.Box3().setFromObject(root);
  const c = box.getCenter(new THREE.Vector3());
  root.position.sub(new THREE.Vector3(c.x, box.min.y, c.z));
  root.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = o.receiveShadow = true;
    origMats.set(o, o.material);
  });
  scene.add(modelRoot);
  frame();
  applyClay();
  buildNeighbours();
}
function frame() {
  placeModel();
  const box = new THREE.Box3().setFromObject(modelRoot);
  const size = box.getSize(new THREE.Vector3());
  modelRadius = Math.max(size.length() / 2, 0.5);
  const centre = box.getCenter(new THREE.Vector3());
  controls.target.copy(centre);
  camera.near = modelRadius / 200; camera.far = Math.max(modelRadius * 400, 60000); camera.updateProjectionMatrix();
  // far enough back that the whole model fits the narrower of the two fields of view (a phone is tall and thin)
  const vFov = camera.fov * Math.PI / 180, hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const dist = 1.15 * modelRadius / Math.sin(Math.min(vFov, hFov) / 2);
  camera.position.copy(centre).add(new THREE.Vector3(1, 0.55, 1).normalize().multiplyScalar(dist));
  controls.update();
  setupGround();
}
// The site's real satellite image as the ground when there is one (setGroundImage sizes it to the true span),
// otherwise a plain neutral ground around the model. Never moves the camera.
function setupGround() {
  if (!groundImage) { const span = modelRadius * 30; site.ground.scale.set(span, span, 1); }
  site.ground.visible = true; site.ground.position.y = -0.002;
  if (!wideGroup.children.length) { site.far.visible = true; site.far.position.y = -0.2; }
  applySun();
}
function applyClay() {
  if (!modelRoot) return;
  modelRoot.traverse(o => { if (o.isMesh) o.material = clayOn ? CLAY : origMats.get(o) || o.material; });
  retintPicked();
  $("clayBtn").classList.toggle("on", clayOn);
}
// MOVE: drag the model across the site with one finger (orbit is paused while it's on), like desktop's Move tool.
let moveOn = false, dragFrom = null, yLift = 0, moved = { x: 0, z: 0 };
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function groundPoint(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  groundPlane.constant = modelRoot ? -new THREE.Box3().setFromObject(modelRoot).min.y : 0;
  return ray.ray.intersectPlane(groundPlane, new THREE.Vector3());
}
function setMove(on) {
  holdFrame = false;
  if (on && (MOD.on || IN.on)) setTool(null);
  moveOn = !!on && !!modelRoot;
  controls.enabled = !moveOn;
  $("moveBtn").classList.toggle("on", moveOn);
  renderToolRows();
  if (moveOn) status("MOVE: drag the model to its place on the site, or move it exactly with X (east), Y (up) and Z (south). Tap MOVE again to orbit.");
  else status(siteStatus() || "");
}
function bindMove() {
  const c = renderer.domElement;
  c.addEventListener("pointerdown", e => { if (!moveOn) return; dragFrom = groundPoint(e); c.setPointerCapture(e.pointerId); });
  c.addEventListener("pointermove", e => {
    if (!moveOn || !dragFrom) return;
    const p = groundPoint(e); if (!p) return;
    modelRoot.position.x += p.x - dragFrom.x; modelRoot.position.z += p.z - dragFrom.z;
    controls.target.x += p.x - dragFrom.x; controls.target.z += p.z - dragFrom.z;
    camera.position.x += p.x - dragFrom.x; camera.position.z += p.z - dragFrom.z;
    dragFrom = groundPoint(e);
  });
  const end = () => { if (dragFrom) { dragFrom = null; placeModel(); applySun(); buildNeighbours(); } };
  c.addEventListener("pointerup", end); c.addEventListener("pointercancel", end);
}

// Exact moves along the site axes: x east, y up (on top of seating it on the ground), z south.
const STEPS = [0.01, 0.1, 1, 10];
let stepI = 1;
function nudge(ax, sign) {
  if (!modelRoot) return;
  if (!moveOn && moveSelected(ax, sign)) return;
  holdFrame = false;
  const d = sign * STEPS[stepI];
  if (ax === "y") yLift += d;
  else { modelRoot.position[ax] += d; controls.target[ax] += d; camera.position[ax] += d; moved[ax] += d; }
  placeModel(); applySun(); buildNeighbours();
  status(`Moved x ${moved.x.toFixed(2)} m · y ${yLift.toFixed(2)} m · z ${moved.z.toFixed(2)} m`);
}
function stepLabel() { const v = STEPS[stepI]; $("stepBtn").textContent = "STEP " + (v < 1 ? Math.round(v * 1000) + " MM" : v + " M"); }

// Rotates the model about the vertical, to face it correctly on the satellite site (the map is north-up).
function spin(deg) {
  holdFrame = false;
  if (!modelRoot) return;
  modelRoot.rotation.y += deg * Math.PI / 180;
  placeModel();
  buildNeighbours();
}
function turn(dir) {
  holdFrame = false;
  if (!modelRoot) return;
  const inner = modelRoot.children[0];
  inner.position.set(0, 0, 0);
  inner.rotation.x += dir * Math.PI / 2;
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner), c = box.getCenter(new THREE.Vector3());
  inner.position.sub(new THREE.Vector3(c.x, box.min.y, c.z));
  frame();
}

/* ---------------- surroundings (ported from Monocular Desktop) ---------------- */
// ---- terrain: real elevations (metres relative to the site) from the Copernicus DEM, as on desktop: a 2 km grid
// (100 m cells) blended into a 30 km grid beyond 800 m. Grids: { n, half, step, z } with x east, z south.
let dem = null, demFar = null, relief = null;
function sampleGrid(g, x, zs) {
  const fx = Math.min(Math.max((x + g.half) / g.step, 0), g.n - 1.001), fz = Math.min(Math.max((zs + g.half) / g.step, 0), g.n - 1.001);
  const c = Math.floor(fx), r = Math.floor(fz), tx = fx - c, tz = fz - r, v = (rr, cc) => g.z[rr * g.n + cc];
  return v(r, c) * (1 - tx) * (1 - tz) + v(r, c + 1) * tx * (1 - tz) + v(r + 1, c) * (1 - tx) * tz + v(r + 1, c + 1) * tx * tz;
}
function demAt(x, zs) {
  if (!dem && !demFar) return 0;
  const far = demFar ? sampleGrid(demFar, x, zs) : null;
  if (!dem) return far;
  const fine = sampleGrid(dem, x, zs);
  if (far === null) return fine;
  const d = Math.max(Math.abs(x), Math.abs(zs)), t = Math.min(1, Math.max(0, (d - 800) / 200));
  return fine * (1 - t) + far * t;
}
function setTerrain() {
  const fp = site.footprint || 220;
  const gg = new THREE.PlaneGeometry(1, 1, 64, 64), gp = gg.attributes.position;
  for (let i = 0; i < gp.count; i++) gp.setZ(i, demAt(gp.getX(i) * fp, -gp.getY(i) * fp));
  gg.computeVertexNormals(); site.ground.geometry.dispose(); site.ground.geometry = gg;
  site.ground.position.y = 0;
  buildWide();
  placeModel();
  if (osmRaw) buildNeighbours();
}

// ---- ground to the horizon: Apple satellite at 1.1 km and 5.5 km, each a ring around the last (no overlap), all
// following the terrain; beyond them a plain ring in their average colour, easing flat far out (desktop's buildWide).
const ringTex = {};
const wideGroup = new THREE.Group();
function ringGeometry(size, n, holeCells, fall) {
  const step = size / n, pos = [], uv = [], idx = [], vid = (r, c) => r * (n + 1) + c;
  for (let r = 0; r <= n; r++) for (let c = 0; c <= n; c++) { const x = -size / 2 + c * step, z = -size / 2 + r * step; pos.push(x, demAt(x, z) * (fall ? fall(x, z) : 1), z); uv.push(c / n, 1 - r / n); }
  const h0 = (n - holeCells) / 2, h1 = h0 + holeCells;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (r >= h0 && r < h1 && c >= h0 && c < h1) continue;
    const a = vid(r, c), b = vid(r, c + 1), d = vid(r + 1, c), e = vid(r + 1, c + 1);
    idx.push(a, d, b, b, d, e);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
  g.computeVertexNormals(); return g;
}
function buildWide() {
  if (!wideGroup.parent) scene.add(wideGroup);
  wideGroup.children.slice().forEach(m => { m.geometry.dispose(); m.material.dispose(); wideGroup.remove(m); });
  if (!siteInfo || !(ringTex[1100] || ringTex[5500])) { site.far.visible = !!siteInfo || !!modelRoot; return; }
  const add = (size, n, hole, map, colour, fall) => {
    const m = new THREE.Mesh(ringGeometry(size, n, hole, fall), new THREE.MeshStandardMaterial({ map: map || null, color: map ? 0xaaaaaa : colour, roughness: 1, metalness: 0, envMapIntensity: 0.4 }));
    m.position.y = -0.03; m.receiveShadow = true; wideGroup.add(m);
  };
  // each ring's hole is a little smaller than what sits inside it, so it runs under the inner ground's edge:
  // on a slope the two meshes don't share vertices, and an exact fit left a see-through crack along the seam
  if (ringTex[1100]) add(1100, 50, 8, ringTex[1100]);
  if (ringTex[5500]) add(5500, 50, ringTex[1100] ? 8 : 2, ringTex[5500]);
  let avg = 0x6b6a5e;
  try {
    const img = (ringTex[5500] || ringTex[1100]).image, c = document.createElement("canvas"); c.width = c.height = 1;
    const g = c.getContext("2d"); g.drawImage(img, 0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data;
    if (d[0] + d[1] + d[2] > 60) avg = (d[0] << 16) | (d[1] << 8) | d[2];
  } catch {}
  const outer = ringTex[5500] ? 5500 : 1100;
  add(110000, 44, Math.max(2, Math.round(44 * outer / 110000)), null, avg, (x, z) => Math.max(0, 1 - (Math.max(Math.abs(x), Math.abs(z)) - 15000) / 30000));
  site.far.visible = false;
}
function setRing(meters, b64) {
  new THREE.TextureLoader().load("data:image/jpeg;base64," + b64, tex => {
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; tex.matrixAutoUpdate = false; tex.updateMatrix();
    if (ringTex[meters]) ringTex[meters].dispose();
    ringTex[meters] = tex;
    siteImages[meters] = "data:image/jpeg;base64," + b64;
    buildWide();
    status(siteStatus());
  });
}
// The model stands at the LOWEST ground under its footprint (it sinks into a slope, like a real building).
function placeModel() {
  if (!modelRoot) return;
  modelRoot.position.y = 0; modelRoot.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(modelRoot);
  const pts = [[b.min.x, b.min.z], [b.max.x, b.min.z], [b.min.x, b.max.z], [b.max.x, b.max.z], [(b.min.x + b.max.x) / 2, (b.min.z + b.max.z) / 2]];
  const low = Math.min(...pts.map(([x, z]) => demAt(x, z)));
  modelRoot.position.y = low - b.min.y + yLift; modelRoot.updateMatrixWorld(true);
}
function clearSurroundings() {
  for (const k of Object.keys(ringTex)) { ringTex[k].dispose(); delete ringTex[k]; }
  siteImages = {}; osmRaw = null; nbSummary = ""; dem = demFar = relief = null;
  mapNear = mapWide = null; traced = null; osmDone = false;
  buildWide();
  if (neighbours) { scene.remove(neighbours); neighbours.traverse(o => o.geometry && o.geometry.dispose()); neighbours = null; }
  const gg = new THREE.PlaneGeometry(1, 1, 32, 32); site.ground.geometry.dispose(); site.ground.geometry = gg;
}

// OpenStreetMap (Overpass) JSON -> building outlines in metres around the site, with heights where OSM has them.
// Same rules as desktop's fetchOsmBuildings: parts replace their building's outline, covers need a mapped height.
const OSM_LEVEL_M = 3.5;
function osmMetres(v) { const n = parseFloat(String(v || "").replace(",", ".")); return n > 0 ? n : null; }
const pip = (x, z, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, zi] = poly[i], [xj, zj] = poly[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; };
function joinRings(segs) {
  const same = (a, b) => Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;
  const open = segs.map(sg => sg.slice()), out = [];
  while (open.length) {
    let ring = open.shift();
    for (let guard = 0; !same(ring[0], ring[ring.length - 1]) && guard < 500; guard++) {
      const i = open.findIndex(sg => same(sg[0], ring[ring.length - 1]) || same(sg[sg.length - 1], ring[ring.length - 1]));
      if (i < 0) break;
      let sg = open.splice(i, 1)[0];
      if (!same(sg[0], ring[ring.length - 1])) sg = sg.reverse();
      ring = ring.concat(sg.slice(1));
    }
    if (ring.length >= 4 && same(ring[0], ring[ring.length - 1])) out.push(ring);
  }
  return out;
}
function parseOsm(data, lat, lng) {
  const kx = 111320 * Math.cos(lat * Math.PI / 180), kz = 110540, toXY = g => [(g.lon - lng) * kx, -(g.lat - lat) * kz];
  const items = [];
  for (const e of data.elements || []) {
    const t = e.tags || {};
    let outers = [], inners = [];
    if (e.type === "way" && e.geometry && e.geometry.length >= 4) outers = [e.geometry.map(toXY)];
    else if (e.type === "relation" && e.members) {
      const seg = role => e.members.filter(m => m.type === "way" && m.role === role && m.geometry && m.geometry.length >= 2).map(m => m.geometry.map(toXY));
      outers = joinRings(seg("outer")); inners = joinRings(seg("inner"));
    }
    if (!outers.length) continue;
    const isPart = !!t["building:part"] && !t.building;
    let h = osmMetres(t.height);
    if (!h && parseFloat(t["building:levels"]) > 0) h = (parseFloat(t["building:levels"]) + (parseFloat(t["roof:levels"]) || 0)) * OSM_LEVEL_M;
    let minH = osmMetres(t.min_height);
    if (!minH && parseFloat(t["building:min_level"]) > 0) minH = parseFloat(t["building:min_level"]) * OSM_LEVEL_M;
    const cover = /^(roof|canopy|carport|shelter)$/.test(String(t.building || t["building:part"] || ""));
    if (cover && !h && !minH) continue;
    if (cover) { const top = h || (minH + 0.4); minH = Math.max(0, minH || top - 0.4); h = top; }
    for (const pts of outers) {
      const holes = inners.filter(r => pip(r[0][0], r[0][1], pts));
      const cx = pts.reduce((a, q) => a + q[0], 0) / pts.length, cz = pts.reduce((a, q) => a + q[1], 0) / pts.length;
      items.push({ pts, holes, cx, cz, h: h || null, minH: minH && h && minH < h ? minH : 0, part: isPart, name: t.name || null,
        kind: (t.building && t.building !== "yes" ? t.building : null) || (t["building:part"] && t["building:part"] !== "yes" ? t["building:part"] : null),
        levels: parseFloat(t["building:levels"]) || null, wallColour: t["building:colour"] || t.colour || null, roofColour: t["roof:colour"] || null });
    }
  }
  const parts = items.filter(i => i.part);
  const out = items.filter(i => i.part || !parts.some(pt => Math.abs(pt.cx - i.cx) < 150 && Math.abs(pt.cz - i.cz) < 150 && pip(pt.cx, pt.cz, i.pts)));
  for (const it of out) {
    if (!(it.minH > 0)) continue;
    const below = out.some(o => o !== it && (o.h || 3.6) >= it.minH - 1 && (o.minH || 0) < it.minH && Math.abs(o.cx - it.cx) < 150 && Math.abs(o.cz - it.cz) < 150 && pip(it.cx, it.cz, o.pts));
    if (!below && !/^(roof|canopy|carport|shelter)$/.test(it.kind || "")) it.minH = 0;
  }
  return out;
}

const NB_DEFAULT_H = 3.6;   // no height in OpenStreetMap: one storey, and the status line says so
let FACADES = null;
const nbMats = new Map(), roofMats = new Map();
function wallMat(style, tintIdx) {
  const key = style + ":" + tintIdx; let m = nbMats.get(key);
  if (!m) { const f = FACADES[style]; m = new THREE.MeshStandardMaterial({ color: f.tints[tintIdx % f.tints.length], map: f.map, roughness: 0.8, metalness: f.metal }); nbMats.set(key, m); }
  return m;
}
function roofMat(hex) {
  const q = ((hex >> 16) & 0xf8) << 16 | ((hex >> 8) & 0xf8) << 8 | (hex & 0xf8);
  let m = roofMats.get(q);
  if (!m) { m = new THREE.MeshStandardMaterial({ color: q, roughness: 0.85, metalness: 0 }); roofMats.set(q, m); }
  return m;
}
let nbFoot = null;   // neighbour footprints (OSM outlines, plus Apple-traced shapes where OSM has few), nearest first
// Desktop's setNeighbours rules: the sharp 220 m trace inside its square, the 1100 m trace outside it; traced shapes the
// size of a city block are land-use blocks, not buildings; OpenStreetMap first, traced shapes only where OSM barely maps.
async function traceMaps() {
  if (traced || !(mapNear || mapWide)) return traced || [];
  let near = [], far = [];
  try { if (mapNear) near = await Engine.traceBuildings("data:image/png;base64," + mapNear, siteImages[220] || null, 220); } catch {}
  try { if (mapWide) far = await Engine.traceBuildings("data:image/png;base64," + mapWide, siteImages[1100] || null, 1100); } catch {}
  near = near.filter(b => !b.pts.some(([x, z]) => Math.abs(x) > 108 || Math.abs(z) > 108));
  far = far.filter(b => Math.abs(b.cx) > 105 || Math.abs(b.cz) > 105);
  traced = near.concat(far).filter(b => !(b.area > 2500));
  return traced;
}
// Serialised: the OSM reply, the two Apple maps, MOVE and SPIN can all ask for a rebuild at nearly the same time.
let nbQueue = Promise.resolve();
function buildNeighbours() { nbQueue = nbQueue.then(buildNeighboursNow, buildNeighboursNow); return nbQueue; }
async function buildNeighboursNow() {
  if (!osmRaw && !mapNear && !mapWide) return;
  if (!FACADES) FACADES = Engine.makeFacadeStyles();
  if (!nbFoot) {
    let fromOsm = [];
    if (osmRaw && osmRaw.length) {
      const sat = siteImages[1100] || siteImages[220] || null;
      try { fromOsm = await Engine.osmFootprints(osmRaw, sat, siteImages[1100] ? 1100 : 220); } catch (e) { fromOsm = []; }
    }
    const tr = await traceMaps();
    const covered = c => fromOsm.some(o => Math.abs(o.cx - c.cx) < 60 && Math.abs(o.cz - c.cz) < 60 && (pip(c.cx, c.cz, o.pts) || Math.hypot(o.cx - c.cx, o.cz - c.cz) < 12));
    const extra = fromOsm.length >= 40 ? [] : tr.filter(t => !covered(t));
    // a traced shape takes the height of the OpenStreetMap building it sits in, where there is one
    for (const b of extra) {
      const hit = (osmRaw || []).find(o => pip(b.cx, b.cz, o.pts) || pip(o.cx, o.cz, b.pts));
      if (hit) { b.kind = hit.kind; b.levels = hit.levels; if (hit.h) b.h = hit.h; }
    }
    nbFoot = fromOsm.map(b => ({ ...b, src: "osm" })).concat(extra.map(b => ({ ...b, src: "map" })));
    nbFoot.sort((a, b) => (a.cx * a.cx + a.cz * a.cz) - (b.cx * b.cx + b.cz * b.cz));
    // the nearest 450 plus the tall ones further out: enough for the street and the skyline, light enough for a phone
    nbFoot = nbFoot.slice(0, 450).concat(nbFoot.slice(450).filter(b => (b.h || 0) >= 30).slice(0, 150));
  }
  if (neighbours) { scene.remove(neighbours); neighbours.traverse(o => o.geometry && o.geometry.dispose()); }
  neighbours = new THREE.Group();
  let box = null;
  if (modelRoot) { modelRoot.updateMatrixWorld(true); box = new THREE.Box3().setFromObject(modelRoot).expandByScalar(4); }
  let n = 0, withH = 0, nMap = 0;
  for (const b of nbFoot) {
    if (box) {   // anything overlapping the user's own building is the existing building it replaces
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
      for (const [x, z] of b.pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
      if (x1 >= box.min.x && x0 <= box.max.x && z1 >= box.min.z && z0 <= box.max.z) continue;
    }
    const shape = new THREE.Shape(b.pts.map(([x, z]) => new THREE.Vector2(x, -z)));
    for (const hole of b.holes || []) shape.holes.push(new THREE.Path(hole.map(([x, z]) => new THREE.Vector2(x, -z))));
    const base = b.minH || 0, hh = b.h || NB_DEFAULT_H;
    // on a slope: start at the lowest ground under the footprint, roof at its real height above the ground at its centre
    const gC = demAt(b.cx, b.cz), gLow = b.pts.reduce((m, [x, z]) => Math.min(m, demAt(x, z)), gC);
    const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.5, hh - base + (base ? 0 : gC - gLow + 0.3)), bevelEnabled: false });
    const roofHex = b.roofColour ? Engine.cssColorToHex(b.roofColour) : null;
    const style = Engine.facadeStyleFor(b.kind, hh, b.levels);
    const wallHex = b.wallColour ? Engine.cssColorToHex(b.wallColour) : null;
    const tint = Engine.nearestTint(wallHex != null ? wallHex : b.color, FACADES[style].tints);
    const mesh = new THREE.Mesh(g, [roofMat(roofHex != null ? roofHex : (b.color || 0x8e8e8b)), wallMat(style, tint)]);
    mesh.rotation.x = -Math.PI / 2; mesh.position.y = base ? gC + base : gLow - 0.3; mesh.castShadow = mesh.receiveShadow = true;
    neighbours.add(mesh); n++; if (b.h) withH++; if (b.src === "map") nMap++;
  }
  scene.add(neighbours);
  nbSummary = n ? `${n} neighbouring buildings (${nMap ? `${n - nMap} from OpenStreetMap, ${nMap} traced from Apple Maps; ` : "OpenStreetMap; "}${withH} with real heights, the rest assumed one storey)` : "no neighbouring buildings mapped";
  status(siteStatus());
}
function siteStatus() {
  if (!siteInfo) return "";
  const ground = groundImage ? `satellite ground to ${ringTex[5500] ? "5.5 km" : ringTex[1100] ? "1.1 km" : "220 m"}` : "no satellite image";
  const terr = relief ? `${Math.round(relief.max - relief.min)} m terrain relief` : (dem === null && demFar === null ? "flat ground" : "");
  return `On the site — ${ground}, ${terr ? terr + ", " : ""}real sun${nbSummary ? ", " + nbSummary : ""}. MOVE and SPIN place the model on the site.`;
}

/* ---------------- photoreal render ---------------- */
const nextFrame = () => new Promise(r => requestAnimationFrame(r));
async function renderPhoto() {
  if (!modelRoot || rendering) return;
  rendering = true; cancelRender = false;
  setBusy(true);
  try {
    applySun();   // path tracer's own sun strength (rendering = true)
    renderer.toneMappingExposure = PHOTO_EXPOSURE;
    hemi.visible = false;
    const sky = scene.background;
    scene.environment = sky;
    scene.environmentIntensity = 1;
    if (!photo) {
      photo = new Engine.Photoreal(renderer);
      photo.pt.tiles.set(4, 4);    // smaller GPU jobs: a long single job can trip the phone's GPU watchdog
    }
    status("Preparing the scene…");
    await nextFrame();
    photo.setScene(scene, camera);
    const t0 = performance.now();
    while (photo.samples < PHOTO_SAMPLES) {
      if (cancelRender) { status("Render cancelled — you moved the view."); return; }
      if (performance.now() - t0 > PHOTO_TIME_LIMIT_MS) break;
      photo.step();
      status(`Rendering on this phone… ${Math.min(100, Math.round(photo.samples / PHOTO_SAMPLES * 100))}%`);
      await nextFrame();
    }
    const dataUrl = renderer.domElement.toDataURL("image/jpeg", 0.92);
    holdFrame = true;
    status("Done — rendered on this phone. Touch the view to carry on.");
    post({ type: "result", dataUrl, samples: Math.round(photo.samples), clay: clayOn, realSun: !!siteInfo });
  } catch (e) {
    status("Render failed: " + (e && e.message));
    post({ type: "error", error: String(e && e.message || e) });
  } finally {
    rendering = false;
    renderer.toneMappingExposure = RASTER_EXPOSURE;
    hemi.visible = true; scene.environment = null;
    applySun();
    setBusy(false);
  }
}
// The clay / raster view as it is on screen, for a quick capture.
function captureView() {
  if (!modelRoot) return;
  renderer.render(scene, camera);
  post({ type: "result", dataUrl: renderer.domElement.toDataURL("image/jpeg", 0.92), samples: 0, clay: clayOn, realSun: !!siteInfo, quick: true });
}
function setBusy(b) {
  for (const id of ["openBtn", "sketchBtn", "elevBtn", "winBtn", "clayBtn", "turnBtn", "spinBtn", "moveBtn", "renderBtn", "captureBtn", "time", "modBtn", "intBtn"]) $(id).disabled = b;
}

/* ---------------- a model built from a photographed sketch (desktop's Builder, on the phone) ---------------- */
let sketchParams = null;   // builder params from the last sketch reading; WINDOWS rebuilds from these
const WINDOW_LABEL = { punched: "PUNCHED", ribbon: "RIBBON", curtain: "CURTAIN", none: "NO" };
function buildFromSketch(vision, name) {
  const cur = { ...Builder.DEFAULTS, windowType: sketchParams ? sketchParams.windowType : Builder.DEFAULTS.windowType };
  const r = Builder.interpretSketch(vision, cur, { level: 0 });
  if (r.error) { status("Couldn't build from the sketch: " + r.error); post({ type: "sketchRead", error: r.error }); return; }
  sketchParams = { ...cur, ...r.params };
  yLift = 0; moved = { x: 0, z: 0 };
  resetTools();
  sketchParams.roofPitchDeg = PITCH[sketchParams.roofType] ?? sketchParams.roofPitchDeg;
  setModel(Builder.buildModel(sketchParams));
  $("renderBtn").disabled = false; $("captureBtn").disabled = false;
  $("editRow").hidden = false; $("elevBtn").hidden = false; showSketchValues(); renderToolRows();
  const h = Builder.totalHeight(sketchParams);
  // the reader's notes are worded for desktop's panel: here the − / + buttons under the model do that job
  const phone = t => t.replace(/: click the width on the model to set the real size/, ": use SIZE − / + to set the real width").replace(/uses the Storeys field/, "has " + mainStoreys(sketchParams) + " (change it with − / +)");
  status(`Built from ${name}: ` + r.read.join("; ") + `; ${h.toFixed(1)} m high.` + (r.assumed.length ? " Assumed: " + r.assumed.map(phone).join("; ") + "." : ""));
  post({ type: "sketchRead", read: r.read, assumed: r.assumed, height: h });
}
const PITCH = { mono: 10, gable: 25, hip: 25 };   // a skillion is a low roof; 25° makes it a tall wall
const ROOF_LABEL = { flat: "FLAT ROOF", gable: "GABLE ROOF", hip: "HIP ROOF", mono: "SKILLION ROOF" };
// the storeys of the main (ground) blocks: what the − / + buttons change
const mainStoreys = p => Math.max(1, ...p.sketch.blocks.filter(b => b.parent == null).map(b => b.storeys ?? p.storeys));
function showSketchValues() {
  $("winBtn").textContent = WINDOW_LABEL[sketchParams.windowType] + " WINDOWS";
  $("roofBtn").textContent = ROOF_LABEL[sketchParams.roofType] || "FLAT ROOF";
  $("stVal").textContent = mainStoreys(sketchParams) + " ST";
  $("szVal").textContent = Math.round(sketchParams.width) + " M";
}
// Rebuild the sketch model after a change, keeping where it sits on the site and the view.
function rebuildSketch(changes) {
  if (!sketchParams || !modelRoot) return;
  sketchParams = { ...sketchParams, ...changes };
  replaceBuilt();
  if (IN.on) { IN.level = Math.min(IN.level, Builder.floorCount(sketchParams) - 1); setPlanCut(cutHeight()); renderToolRows(); }
  showSketchValues();
  status(`${sketchParams.width.toFixed(1)} m × ${sketchParams.depth.toFixed(1)} m, ${mainStoreys(sketchParams)} storey${mainStoreys(sketchParams) > 1 ? "s" : ""}, ${(ROOF_LABEL[sketchParams.roofType] || "").toLowerCase()}, ${Builder.totalHeight(sketchParams).toFixed(1)} m high.`);
}
// An elevation photographed after the plan: wall height, storeys, roof and windows for the whole building.
function applyElevationSketch(vision) {
  if (!sketchParams) { status("Build the model from a plan sketch first, then add its elevation."); return; }
  const e = Builder.interpretElevation(vision, sketchParams);
  if (e.error) { status("Couldn't read the elevation: " + e.error); post({ type: "sketchRead", error: e.error }); return; }
  const next = Builder.applyElevation(sketchParams, e.params);
  rebuildSketch(next);
  status("Elevation: " + e.read.join("; ") + "." + (e.assumed.length ? " Assumed: " + e.assumed.join("; ") + "." : ""));
  post({ type: "sketchRead", read: e.read, assumed: e.assumed });
}
// WINDOWS: the builder's Windows setting for the walls the sketch doesn't mark as glass or solid
function cycleWindows() { rebuildSketch({ windowType: Builder.cycleWindows(sketchParams.windowType) }); }
function cycleRoof() {
  const T = Builder.ROOF_TYPES, next = T[(T.indexOf(sketchParams.roofType) + 1) % T.length];
  // the chosen roof replaces any roof read off the drawing
  rebuildSketch({ roofType: next, roofPitchDeg: PITCH[next] ?? sketchParams.roofPitchDeg, sketch: { ...sketchParams.sketch, blocks: sketchParams.sketch.blocks.map(b => b.roof ? { ...b, roof: { ...b.roof, type: null, ridge: null } } : b) } });
}
function stepStoreys(d) {
  const n = Math.max(1, Math.min(60, mainStoreys(sketchParams) + d));
  rebuildSketch({ storeys: n, sketch: { ...sketchParams.sketch, blocks: sketchParams.sketch.blocks.map(b => b.parent == null ? { ...b, storeys: n } : b) } });
}
function stepSize(d) {
  const w = Math.max(4, Math.min(300, Math.round(sketchParams.width) + d));
  rebuildSketch({ width: w, depth: sketchParams.depth * w / sketchParams.width });
}

/* ---------------- Modify, Interior, Snap and building styles (the desktop's tools, on the phone) ---------------- */
// Parts added by the tools are registered like the model's own (shadows, Clay, both sides drawn).
function addParts(list) {
  for (const n of list) n.traverse(m => {
    if (!m.isMesh) return;
    m.castShadow = m.receiveShadow = true;
    (Array.isArray(m.material) ? m.material : [m.material]).forEach(x => { if (x) x.side = THREE.DoubleSide; });
    origMats.set(m, m.material);
  });
  partsChanged();
}
function partsChanged() { holdFrame = false; snapCache = new WeakMap(); applyClay(); retintPicked(); placeModel(); }
const originalMaterial = (mesh, mi) => { const m = origMats.get(mesh) || mesh.material; return Array.isArray(m) ? (m[mi || 0] || m[0]) : m; };
const built = () => modelRoot && modelRoot.children[0];
const isUnder = (o, g) => { for (; o; o = o.parent) if (o === g) return true; return false; };
// Swap the built model for a fresh build of sketchParams, keeping where it sits, the view and everything added since.
function replaceBuilt() {
  const obj = built(); if (!obj) return;
  const group = Builder.buildModel(sketchParams);
  for (const o of MOD.ops) for (const m of o.res.added || []) if (m.parent) m.parent.remove(m);
  for (const c of [...obj.children]) { obj.remove(c); c.traverse(m => { if (m.isMesh) { origMats.delete(m); m.geometry && m.geometry.dispose(); } }); }
  for (const c of [...group.children]) obj.add(c);
  obj.userData = group.userData;
  const cam = camera.position.clone(), tgt = controls.target.clone();
  addParts([obj]);
  // windows, glazing, doors, verandahs and balustrades go back on, in order, on the wall now at the same spot
  modelRoot.updateMatrixWorld(true);
  const keep = [];
  for (const o of MOD.ops) {
    const dir = o.dir.clone().normalize(), rc = new THREE.Raycaster(o.hit.point.clone().addScaledVector(dir, -0.5), dir, 0, 1.5);
    const h = rc.intersectObject(modelRoot, true).find(x => x.object.isMesh && x.face);
    if (!h) continue;
    const hit = { ...h, point: o.hit.point.clone() }, r = Builder.applyFaceOp(modelRoot, hit, o.dir, o.opts, o.wallMat);
    if (!r.ok) continue;
    o.hit = hit; o.res = r; tagOp(o); addParts(r.added); keep.push(o);
  }
  MOD.ops = keep;
  if (MOD.lastOp && !MOD.ops.includes(MOD.lastOp)) MOD.lastOp = null;
  camera.position.copy(cam); controls.target.copy(tgt); controls.update(); applySun(); buildNeighbours();
}

// tap, not drag: a short touch that barely moves
let tapFrom = null;
function bindTaps() {
  const c = renderer.domElement;
  c.addEventListener("pointerdown", e => { tapFrom = { x: e.clientX, y: e.clientY, t: Date.now() }; });
  c.addEventListener("pointerup", e => {
    const t = tapFrom; tapFrom = null;
    if (!t || moveOn || rendering || Math.hypot(e.clientX - t.x, e.clientY - t.y) > 10 || Date.now() - t.t > 450) return;
    if (MOD.on) onModifyTap(e); else if (IN.on) onInteriorTap(e);
  });
}
function rayAt(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  return { px: { x: e.clientX - r.left, y: e.clientY - r.top } };
}
function hitAt() {
  if (!modelRoot) return null;
  const hits = ray.intersectObject(modelRoot, true).filter(h => h.object.isMesh && h.object.visible && h.face);
  return hits[0] || null;
}
function worldToScreen(v) {
  const q = v.clone().project(camera), w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
  return { x: (q.x + 1) / 2 * w, y: (1 - q.y) / 2 * h, visible: q.z > -1 && q.z < 1 };
}

// ---- Snap, like ArchiCAD's special snap points: a tap near an end, midpoint, edge or centre lands exactly on it
const SNAPS = { on: true };
let snapCache = new WeakMap();
function featureEdges(mesh) {   // a mesh's real edges (creases over 25°), not the diagonals of its triangles
  let e = snapCache.get(mesh);
  if (!e) { const g = new THREE.EdgesGeometry(mesh.geometry, 25); e = g.attributes.position.array; g.dispose(); snapCache.set(mesh, e); }
  return e;
}
function findSnap(hit, px) {
  if (!SNAPS.on || !modelRoot) return null;
  const found = [], TOL = 26;   // a fingertip, in screen points
  const add = (v, kind, extra = 0) => { const sp = worldToScreen(v); if (sp.visible) { const d = Math.hypot(sp.x - px.x, sp.y - px.y); if (d < TOL) found.push({ p: v, kind, d: d + extra, sp }); } };
  for (const c of modelRoot.children) if (c.userData.element) {
    const e = c.userData.element;
    for (const q of Builder.elementSnapPoints(e)) add(modelRoot.localToWorld(new THREE.Vector3(q[0], q[1], q[2])), "End");
    add(modelRoot.localToWorld(new THREE.Vector3(e.x, e.y + (e.kind === "column" || e.kind === "wall" ? e.height : e.thickness || 0), e.z)), "Centre", 2);
  }
  if (hit) {
    const m = hit.object, pos = featureEdges(m), A = new THREE.Vector3(), B = new THREE.Vector3(), hp = hit.point;
    m.updateMatrixWorld();
    for (let i = 0; i < pos.length; i += 6) {
      A.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(m.matrixWorld); B.set(pos[i + 3], pos[i + 4], pos[i + 5]).applyMatrix4(m.matrixWorld);
      if (A.distanceTo(hp) > 10 && B.distanceTo(hp) > 10) continue;
      add(A.clone(), "End"); add(B.clone(), "End");
      add(A.clone().add(B).multiplyScalar(0.5), "Mid", 2);
      const sa = worldToScreen(A), sb = worldToScreen(B); if (!sa.visible || !sb.visible) continue;
      const dx = sb.x - sa.x, dy = sb.y - sa.y, t = Math.max(0, Math.min(1, ((px.x - sa.x) * dx + (px.y - sa.y) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(sa.x + dx * t - px.x, sa.y + dy * t - px.y);
      if (d < 14) found.push({ p: A.clone().lerp(B, t), kind: "Edge", d: d + 10, sp: { x: sa.x + dx * t, y: sa.y + dy * t } });   // points win over edges
    }
    const c = new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3());
    if (Math.abs(hit.face.normal.clone().transformDirection(m.matrixWorld).y) > 0.9) c.y = hp.y;
    add(c, "Centre", 4);
  }
  if (!found.length) return null;
  return found.sort((a, b) => a.d - b.d)[0];
}
let snapTimer = 0;
function showSnap(s) {
  const el = $("snapMark"); clearTimeout(snapTimer);
  if (!s) { el.hidden = true; return; }
  el.hidden = false; el.style.left = s.sp.x + "px"; el.style.top = s.sp.y + "px"; el.querySelector("b").textContent = s.kind;
  snapTimer = setTimeout(() => { el.hidden = true; }, 1600);
}

// ---- Modify: doors, windows, glazing, verandahs, balustrades, columns, slabs and walls on any model; select, move, delete
const MOD = { on: false, mode: "select", door: "single", flip: false, bal: "glass", col: "square", ops: [], undo: [], lastOp: null, element: null, picked: null };
const MOD_MODES = [["select", "SELECT"], ["door", "DOOR"], ["windows", "WINDOWS"], ["curtain", "GLAZE"], ["verandah", "VERANDAH"], ["balustrade", "BALUSTRADE"], ["column", "COLUMN"], ["slab", "SLAB"], ["wall", "WALL"], ["remove", "REMOVE"]];
const MOD_HINT = {
  select: "Tap any part: it turns blue. DELETE removes it, X / Y / Z move it.",
  door: "Pick a style, then tap a wall where the door goes. FLIP swaps its side.",
  windows: "Tap a flat wall to cut windows through it, sized per storey.",
  curtain: "Tap a flat wall to replace it with glazing and mullions.",
  verandah: "Tap a wall: a verandah runs its whole length at that floor, with a deck, posts and a skillion roof.",
  balustrade: "Pick a style, then tap the top of a deck, balcony or slab near the edge it runs along.",
  column: "Pick a shape, then tap the ground or a floor. X / Y / Z move it; it snaps to ends and corners.",
  slab: "Tap the ground or the model to place a slab.",
  wall: "Tap the ground or a floor to place a wall. Tapping a wall runs the new one along it.",
  remove: "Tap a part to take it out of the model.",
};
const PICK_MAT = new THREE.MeshStandardMaterial({ color: 0x4a8cff, emissive: 0x1b3f99, emissiveIntensity: 0.6, roughness: 0.6 });
function pickPart(obj) {
  if (MOD.picked) MOD.picked.traverse(m => { if (m.isMesh && m.userData._pick) { m.material = clayOn ? CLAY : origMats.get(m) || m.material; delete m.userData._pick; } });
  MOD.picked = obj || null;
  if (obj) { MOD.element = null; MOD.lastOp = null; obj.traverse(m => { if (m.isMesh) { m.userData._pick = true; m.material = PICK_MAT; } }); }
  holdFrame = false;
}
function retintPicked() { if (MOD.picked) MOD.picked.traverse(m => { if (m.isMesh && m.userData._pick) m.material = PICK_MAT; }); }
const opName = op => ({ curtain: "glazing", door: "door", verandah: "verandah", balustrade: "balustrade" }[op.opts.mode] || "windows");
function modOpts() {
  const D = Builder.DEFAULTS;
  return { windowWidth: D.windowWidth, windowHeight: D.windowHeight, sillHeight: D.sillHeight, windowPitch: D.windowPitch, storeyHeight: sketchParams ? sketchParams.storeyHeight : D.storeyHeight,
    doorStyle: MOD.door, doorFlip: MOD.flip, balustradeStyle: MOD.bal };
}
function tagOp(op) { for (const m of op.res.added || []) m.traverse(x => { x.userData.op = op; }); }
// Face edits are kept in order, each cut into what the ones before it left: to change or delete one, the ones after it
// come off, it's redone (or left out), and they go back on in order.
function rerunFrom(i, apply) {
  const ops = MOD.ops;
  for (let j = ops.length - 1; j >= i; j--) ops[j].res.undo();
  const ok = apply();
  for (let j = i; j < ops.length; j++) {
    const o = ops[j]; if (o.skip) continue;
    const r = Builder.applyFaceOp(modelRoot, o.hit, o.dir, o.opts, o.wallMat);
    if (r.ok) { o.res = r; tagOp(o); addParts(r.added); } else o.res = { undo() {}, added: [] };
  }
  partsChanged(); return ok;
}
function editOp(op, patch, shift) {
  const i = MOD.ops.indexOf(op); if (i < 0) return;
  const before = { ...op.opts }, beforePt = op.hit.point.clone(); let msg = null, ok = true;
  rerunFrom(i, () => {
    Object.assign(op.opts, patch); if (shift) op.hit.point.add(shift);
    op.skip = true;
    let r = Builder.applyFaceOp(modelRoot, op.hit, op.dir, op.opts, op.wallMat);
    if (!r.ok) { msg = r.message; ok = false; Object.assign(op.opts, before); op.hit.point.copy(beforePt); r = Builder.applyFaceOp(modelRoot, op.hit, op.dir, op.opts, op.wallMat); }
    op.res = r; tagOp(op); addParts(r.added || []);
    if (ok) msg = r.message;
    return ok;
  });
  delete op.skip;
  status(msg || "");
}
function removeOp(op, withUndo) {
  const i = MOD.ops.indexOf(op); if (i < 0) return;
  rerunFrom(i, () => { MOD.ops.splice(i, 1); return true; });
  if (MOD.lastOp === op) MOD.lastOp = null;
  if (withUndo) { MOD.undo.push(() => rerunFrom(Math.min(i, MOD.ops.length), () => { MOD.ops.splice(i, 0, op); return true; })); status(`Deleted the ${opName(op)}. UNDO brings it back.`); }
}
// ---- slabs, walls and columns added here: they connect at their ends and corners
const SNAP_M = 0.2;
function snapTargets(except) {
  const out = [];
  for (const c of modelRoot.children) if (c.userData.element && c !== except) for (const q of Builder.elementSnapPoints(c.userData.element)) out.push({ q, what: "the " + c.userData.element.kind });
  return out;
}
function nearestTarget(p, targets, tol = SNAP_M) {
  let best = null;
  for (const t of targets) {
    const d = Math.hypot(t.q[0] - p[0], t.q[1] - p[1], t.q[2] - p[2]), score = d + (p[3] && t.q[3] !== p[3] ? 0.05 : 0);
    if (d < tol && (!best || score < best.score)) best = { ...t, d, score };
  }
  return best;
}
function updateElement(mesh, patch) {
  const spec = Builder.clampElement({ ...mesh.userData.element, ...patch });
  mesh.userData.element = spec; mesh.geometry.dispose(); mesh.geometry = Builder.elementGeometry(spec);
  snapCache = new WeakMap(); holdFrame = false;
}
function snapElement(mesh) {
  const e = mesh.userData.element, targets = snapTargets(mesh); let best = null;
  for (const p of Builder.elementSnapPoints(e)) { const t = nearestTarget(p, targets); if (t && (!best || t.score < best.t.score)) best = { p, t }; }
  if (!best || best.t.d < 1e-4) return null;
  updateElement(mesh, { x: +(e.x + best.t.q[0] - best.p[0]).toFixed(4), y: +(e.y + best.t.q[1] - best.p[1]).toFixed(4), z: +(e.z + best.t.q[2] - best.p[2]).toFixed(4) });
  return best.t.what;
}
function removeElement(mesh) {
  const root = mesh.parent; if (!root) return;
  root.remove(mesh); MOD.element = null;
  MOD.undo.push(() => { root.add(mesh); partsChanged(); });
  partsChanged(); status(`Removed the ${mesh.userData.element.kind}. UNDO brings it back.`);
}
function deleteSelected() {
  if (IN.on) { removeInteriorSel(); return; }
  if (MOD.picked && MOD.picked.parent) {
    const obj = MOD.picked, parent = obj.parent; pickPart(null); parent.remove(obj);
    MOD.undo.push(() => { parent.add(obj); partsChanged(); });
    partsChanged(); status(`Deleted “${obj.name || "part"}”. UNDO brings it back.`); return;
  }
  if (MOD.element && MOD.element.parent) { removeElement(MOD.element); return; }
  if (MOD.lastOp) { removeOp(MOD.lastOp, true); return; }
  status("Tap a part with SELECT first, then DELETE.");
}
function undoModify() {
  if (IN.on) { undoInterior(); return; }
  const u = MOD.undo.pop();
  if (!u) { status("Nothing to undo."); return; }
  u(); partsChanged(); status("Undone.");
}
function onModifyTap(e) {
  const { px } = rayAt(e), mode = MOD.mode;
  let hit = hitAt();
  if (mode === "select") {
    pickPart(null);
    if (!hit) { status("Tap a part of the model."); return; }
    if (hit.object.userData.element) { MOD.element = hit.object; MOD.lastOp = null; status(`Selected the ${hit.object.userData.element.kind}. X / Y / Z move it, DELETE removes it.`); return; }
    const op = hit.object.userData.op;
    if (op && MOD.ops.includes(op)) { MOD.lastOp = op; MOD.element = null; renderToolRows(); status(`Selected the ${opName(op)}. X / Y / Z slide it, DELETE removes it.`); return; }
    const obj = hit.object.parent && hit.object.parent.userData.unit ? hit.object.parent : hit.object;
    pickPart(obj); status(`Selected “${obj.name || "part"}”. DELETE removes it, X / Y / Z move it.`);
    return;
  }
  // a tap lands on the snap point it was near
  const snap = mode === "remove" ? null : findSnap(hit, px);
  showSnap(snap);
  if (snap) {
    if (hit) hit = { ...hit, point: snap.p.clone() };
    else if (["slab", "wall", "column"].includes(mode)) hit = { point: snap.p.clone(), object: modelRoot, face: null };
  }
  const placing = ["slab", "wall", "column"].includes(mode);
  if (hit && hit.object.userData.element && mode !== "remove" && !(placing && snap)) { MOD.element = hit.object; status(`Selected the ${hit.object.userData.element.kind}. X / Y / Z move it, DELETE removes it.`); return; }
  const tapped = hit && hit.object.userData.op;
  if (tapped && MOD.ops.includes(tapped) && mode !== "balustrade") {
    if (mode === "remove") { removeOp(tapped, true); return; }
    MOD.lastOp = tapped; MOD.element = null; renderToolRows(); status(`Selected the ${opName(tapped)}. X / Y / Z slide it, DELETE removes it.`); return;
  }
  if (placing) {
    const cam = new THREE.Vector3(); camera.getWorldDirection(cam); cam.y = 0; cam.normalize();
    const right = new THREE.Vector3().crossVectors(cam, new THREE.Vector3(0, 1, 0)).normalize();
    let spec = Builder.elementFromClick(mode, modelRoot, hit, ray.ray, right);
    if (!spec) { status("Tap on the model or the ground."); return; }
    if (mode === "column") spec = { ...spec, shape: MOD.col };
    const mesh = new THREE.Mesh(Builder.elementGeometry(spec), Builder.elementMaterial(mode));
    mesh.name = { slab: "Added slab", wall: "Added wall", column: "Added column" }[mode];
    mesh.userData.element = spec;
    modelRoot.add(mesh); addParts([mesh]);
    const to = snapElement(mesh);
    MOD.undo.push(() => { modelRoot.remove(mesh); if (MOD.element === mesh) MOD.element = null; });
    MOD.element = mesh;
    status(`Added a ${mode === "column" ? Builder.COLUMN_SHAPES[MOD.col].toLowerCase() + " column" : mode}${snap ? `, on the ${snap.kind.toLowerCase()} point` : to ? `, snapped to ${to}` : ""}. X / Y / Z move it.`);
    return;
  }
  if (!hit) { status("Tap a part of the model."); return; }
  if (mode === "remove") {
    if (hit.object.userData.element) { removeElement(hit.object); return; }
    const r = Builder.removePart(hit);
    if (!r.ok) { status(r.message); return; }
    MOD.undo.push(r.undo); partsChanged(); status(r.message + " UNDO puts it back.");
    return;
  }
  // a door on a model built here goes in as one of its own doors (it replaces windows in the way and rebuilds with it)
  if (mode === "door" && sketchParams && isUnder(hit.object, built())) {
    const P = sketchParams, lp = built().worldToLocal(hit.point.clone()), L = Math.max(0, Math.min(Builder.floorCount(P) - 1, Math.floor((lp.y - P.slabThickness + 0.05) / P.storeyHeight)));
    const ds = Builder.DOOR_STYLES[MOD.door], d = Builder.doorFromClick(P, L, [lp.x, lp.z], 0.6, "door", { w: ds.w, h: ds.h, outsideOnly: true });
    if (!d) { status("Tap an outside wall of the building to put a door in it."); return; }
    const it = { id: newId(), kind: "door", host: d.host, u: d.u, w: d.w, h: d.h, swing: MOD.flip ? -1 : 1, lv: [L, L], style: MOD.door };
    commitInterior([...intItems(), it], `Added ${/^[aeiou]/i.test(ds.label) ? "an" : "a"} ${ds.label.toLowerCase()} door on the ${Builder.levelName(L).toLowerCase()}. In INTERIOR you can select it to restyle, flip or move it.`);
    return;
  }
  const opts = { mode: ["curtain", "door", "verandah", "balustrade"].includes(mode) ? mode : "windows", ...modOpts() };
  const wallMat = originalMaterial(hit.object, hit.face && hit.face.materialIndex);
  const res = Builder.applyFaceOp(modelRoot, hit, ray.ray.direction, opts, wallMat);
  if (!res.ok) { status(res.message); return; }
  addParts(res.added);
  const op = { hit, dir: ray.ray.direction.clone(), opts, res, wallMat };
  tagOp(op); MOD.ops.push(op);
  MOD.undo.push(() => removeOp(op, false));
  MOD.lastOp = op; MOD.element = null;
  status(res.message);
}
// X / Y / Z for the selected part (the step is the same STEP as MOVE)
function moveSelected(ax, sign) {
  const d = sign * STEPS[stepI];
  if (IN.on) { nudgeInterior(ax, d); return true; }
  if (!MOD.on) return false;
  const pk = MOD.picked, el = MOD.element && MOD.element.parent ? MOD.element : null, op = MOD.lastOp;
  if (pk && pk.parent) {
    const v = new THREE.Vector3(); v[ax] = d;
    const w0 = modelRoot.localToWorld(new THREE.Vector3()), w1 = modelRoot.localToWorld(v.clone());
    const dl = pk.parent.worldToLocal(w1).sub(pk.parent.worldToLocal(w0)), before = pk.position.clone();
    pk.position.add(dl); MOD.undo.push(() => { pk.position.copy(before); });
    partsChanged(); status(`Moved “${pk.name || "part"}” ${d > 0 ? "+" : ""}${+d.toFixed(3)} m along ${ax.toUpperCase()}.`); return true;
  }
  if (el) {
    const e = el.userData.element, before = { x: e.x, y: e.y, z: e.z };
    MOD.undo.push(() => updateElement(el, before));
    updateElement(el, { [ax]: +((+e[ax]) + d).toFixed(3) }); const to = snapElement(el); partsChanged();
    status(to ? `Snapped to ${to}.` : `Moved the ${e.kind} ${d > 0 ? "+" : ""}${+d.toFixed(3)} m along ${ax.toUpperCase()}.`); return true;
  }
  if (op) {
    const v = new THREE.Vector3(); v[ax] = d;
    if (op.hit.face) { const n = op.hit.face.normal.clone().transformDirection(op.hit.object.matrixWorld); v.addScaledVector(n, -v.dot(n)); }
    if (v.length() < 1e-4) { status(`${ax.toUpperCase()} runs straight into that wall. Use one of the other two to slide the ${opName(op)}.`); return true; }
    editOp(op, {}, v); return true;
  }
  status("Tap a part with SELECT first, then move it with X / Y / Z."); return true;
}
function flipDoor() {
  if (IN.on) { const it = selItem(); if (it && it.kind === "door") { replaceItem({ ...it, swing: it.swing === -1 ? 1 : -1 }); status("Flipped the door."); } else status("Select a door to flip it."); return; }
  MOD.flip = !MOD.flip;
  if (MOD.lastOp && MOD.lastOp.opts.mode === "door") editOp(MOD.lastOp, { doorFlip: !MOD.lastOp.opts.doorFlip });
  else status("The next door goes in flipped" + (MOD.flip ? "." : " back."));
}
function turnSelected() {
  if (IN.on) { const it = selItem(); if (it && it.kind !== "wall" && it.kind !== "door" && it.kind !== "opening") replaceItem({ ...it, ang: ((it.ang || 0) + 90) % 360 }); else { IN.ang = (IN.ang + 90) % 360; status(`New stairs and lifts turned ${IN.ang}°.`); } return; }
  const el = MOD.element && MOD.element.parent ? MOD.element : null;
  if (el) { updateElement(el, { angleDeg: (el.userData.element.angleDeg || 0) + 15 }); partsChanged(); status("Turned 15°."); }
  else status("Select a slab, wall or column to turn it.");
}

// ---- Interior: walls, doors, openings, stairs, lifts and columns, floor by floor, in a plan cut through the floor
const IN = { on: false, level: 0, mode: "wall", all: false, chain: null, sel: null, ang: 0, undo: [], style: { door: "single", extdoor: "entry", stair: "dogleg", core: "lift" } };
const INT_MODES = [["select", "SELECT"], ["wall", "WALL"], ["door", "DOOR"], ["extdoor", "EXT DOOR"], ["opening", "OPENING"], ["stair", "STAIR"], ["core", "LIFT"], ["column", "COLUMN"]];
const INT_HINT = {
  select: "Tap a wall, door, stair, lift or column to select it. X / Z move it, DELETE removes it.",
  wall: "Tap to start a wall, tap again for each corner. DONE ends it.",
  door: "Pick a style, then tap a wall (inside or outside) to put a door in it.",
  extdoor: "Pick a style, then tap near an outside wall to put a door in it.",
  opening: "Tap a wall to put an opening (no door) in it.",
  stair: "Pick a style, then tap to place a stair to the floor above. TURN turns it.",
  core: "Pick Lift, Glass lift or Services, then tap to place it. It runs through every floor.",
  column: "Tap to place a column.",
};
const intItems = () => (sketchParams && sketchParams.interior) || [];
const newId = () => Math.random().toString(36).slice(2, 9);
const selItem = () => IN.sel && intItems().find(x => x.id === IN.sel);
var planCut = null, savedView = null, sunShadow = null;   // var: the sun reads planCut before this line runs
// The plan cut clips the model only: renderer.clippingPlanes would also slice the satellite ground, terrain,
// neighbours and trees. The loop keeps the planes on parts added later (Modify, rebuilds).
var modelClip = [], clipSynced = false;
function syncModelClip() {
  modelClip = modelClip || [];
  if (clipSynced && !modelClip.length) return;
  clipSynced = true;
  if (!modelRoot) return;
  modelRoot.traverse(n => {
    if (!n.isMesh || !n.material) return;
    (Array.isArray(n.material) ? n.material : [n.material]).forEach(m => {
      if (m.clippingPlanes === modelClip || (!modelClip.length && !(m.clippingPlanes && m.clippingPlanes.length))) return;
      m.clippingPlanes = modelClip.length ? modelClip : null; m.clipShadows = true; m.needsUpdate = true;
    });
  });
}
function setPlanCut(yModel) {
  const obj = built();
  planCut = yModel == null || !obj ? null : obj.localToWorld(new THREE.Vector3(0, yModel, 0)).y;
  renderer.localClippingEnabled = true;
  renderer.clippingPlanes = [];
  modelClip = planCut == null ? [] : [new THREE.Plane(new THREE.Vector3(0, -1, 0), planCut)]; clipSynced = false; syncModelClip();
  if (planCut != null) { if (sunShadow == null) sunShadow = sun.castShadow; sun.castShadow = false; }
  else if (planCut == null && sunShadow != null) { sun.castShadow = sunShadow; sunShadow = null; }
  holdFrame = false;
}
function setTopView(on) {
  if (on && !savedView) {
    savedView = { pos: camera.position.clone(), target: controls.target.clone() };
    const box = new THREE.Box3().setFromObject(built()), c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const vFov = camera.fov * Math.PI / 180, hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    const h = Math.max(size.x / Math.tan(hFov / 2), size.z / Math.tan(vFov / 2)) * 0.6 + (planCut ?? box.max.y);
    controls.target.set(c.x, planCut ?? box.min.y, c.z);
    camera.position.set(c.x, h, c.z + 0.001); controls.update();
  } else if (!on && savedView) { camera.position.copy(savedView.pos); controls.target.copy(savedView.target); controls.update(); savedView = null; }
  holdFrame = false;
}
const floorAt = () => { const l = Builder.levelLifts(sketchParams, IN.level); return Builder.floorY(sketchParams, IN.level) + (l.length ? Math.min(...l) : 0); };
const cutHeight = () => { const l = Builder.levelLifts(sketchParams, IN.level); return Builder.floorY(sketchParams, IN.level) + 1.2 + (l.length ? Math.max(...l) : 0) * 0.5; };
function planPoint(yModel) {
  const obj = built(); obj.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert(), lr = ray.ray.clone().applyMatrix4(inv);
  const q = lr.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -yModel), new THREE.Vector3());
  return q ? [q.x, q.z] : null;
}
const toScreen = (q, y) => worldToScreen(built().localToWorld(new THREE.Vector3(q[0], y, q[1])));
function snapTol(pt) {   // metres for a fingertip near a plan point, so snapping feels the same at any zoom
  const y = floorAt(), a = toScreen(pt, y), b = toScreen([pt[0] + 1, pt[1]], y), px = Math.hypot(b.x - a.x, b.y - a.y);
  return Math.min(2, Math.max(0.05, 22 / Math.max(px, 1e-3)));
}
function setInterior(on) {
  if (on && !sketchParams) { status("INTERIOR works on a model built here from a sketch. For an imported model or drawings, use MODIFY."); return false; }
  IN.on = !!on;
  if (on) {
    if (moveOn) setMove(false);
    IN.level = Math.min(IN.level, Builder.floorCount(sketchParams) - 1);
    setPlanCut(cutHeight()); setTopView(true);
    status("INTERIOR: plan of the " + Builder.levelName(IN.level).toLowerCase() + ". " + INT_HINT[IN.mode]);
  } else { IN.chain = null; IN.sel = null; setPlanCut(null); setTopView(false); }
  return true;
}
function changeLevel(d) {
  const n = Builder.floorCount(sketchParams);
  IN.level = Math.max(0, Math.min(n - 1, IN.level + d)); IN.chain = null; IN.sel = null;
  setPlanCut(cutHeight()); renderToolRows();
  status("Plan of the " + Builder.levelName(IN.level).toLowerCase() + ".");
}
function commitInterior(items, msg) {
  IN.undo.push(JSON.stringify(intItems())); if (IN.undo.length > 100) IN.undo.shift();
  sketchParams = { ...sketchParams, interior: items };
  replaceBuilt();
  if (IN.on) setPlanCut(cutHeight());
  renderToolRows();
  if (msg) status(msg);
}
function undoInterior() {
  const s = IN.undo.pop(); if (!s) { status("Nothing to undo."); return; }
  IN.sel = null; IN.chain = null;
  sketchParams = { ...sketchParams, interior: JSON.parse(s) }; replaceBuilt(); setPlanCut(cutHeight()); renderToolRows(); status("Undone.");
}
function replaceItem(it) { commitInterior(intItems().map(x => x.id === it.id ? it : x)); }
function removeInteriorSel() {
  const it = selItem(); if (!it) { status("Tap something with SELECT first, then DELETE."); return; }
  commitInterior(intItems().filter(x => x.id !== it.id && x.host !== it.id), `Removed the ${it.kind}${it.kind === "wall" ? " and its doors" : ""}. UNDO brings it back.`);
  IN.sel = null;
}
function nudgeInterior(ax, d) {
  const it = selItem(); if (!it) { status("Tap something with SELECT first, then move it with X / Z."); return; }
  if (ax === "y") { status("Interior items sit on their floor: use ▼ ▲ for another floor."); return; }
  const v = ax === "x" ? [d, 0] : [0, d];
  if (it.kind === "wall") replaceItem({ ...it, a: [it.a[0] + v[0], it.a[1] + v[1]], b: [it.b[0] + v[0], it.b[1] + v[1]] });
  else if (it.kind === "door" || it.kind === "opening") {
    const s = Builder.interiorDims(sketchParams, IN.level, it.id).find(q => q.key === "w"), ex = s ? [s.b[0] - s.a[0], s.b[2] - s.a[2]] : [1, 0], L = Math.hypot(...ex) || 1;
    replaceItem({ ...it, u: it.u + (v[0] * ex[0] + v[1] * ex[1]) / L });
  } else replaceItem({ ...it, x: +(it.x + v[0]).toFixed(3), z: +(it.z + v[1]).toFixed(3) });
}
function onInteriorTap(e) {
  rayAt(e);
  const pt = planPoint(floorAt()); if (!pt) return;
  const tol = snapTol(pt), P = sketchParams, m = IN.mode;
  if (m === "wall") {
    const q = Builder.snapPlan(P, IN.level, pt, tol, IN.chain, false).pt;
    if (!IN.chain) { IN.chain = q; status("Tap the next corner. DONE ends the wall."); return; }
    const a = IN.chain;
    if (Math.hypot(q[0] - a[0], q[1] - a[1]) < 0.1) { IN.chain = null; return; }
    const it = { id: newId(), kind: "wall", a: a.map(v => +v.toFixed(3)), b: q.map(v => +v.toFixed(3)), t: Builder.INTERIOR_DEFAULTS.wall.t, lv: IN.all ? null : [IN.level, IN.level] };
    commitInterior([...intItems(), it], `Wall ${Math.hypot(q[0] - a[0], q[1] - a[1]).toFixed(2)} m. Keep tapping, or DONE to finish.`);
    IN.chain = q; return;
  }
  if (m === "door" || m === "opening" || m === "extdoor") {
    const kind = m === "extdoor" ? "door" : m, sk = m === "extdoor" ? IN.style.extdoor : IN.style.door, ds = kind === "door" ? Builder.DOOR_STYLES[sk] : null;
    const d = Builder.doorFromClick(P, IN.level, pt, tol, kind, { ...(ds ? { w: ds.w, h: ds.h } : {}), outsideOnly: m === "extdoor" });
    if (d) {
      const it = { id: newId(), kind, host: d.host, u: d.u, w: d.w, h: d.h, swing: 1, lv: d.outside ? (IN.all ? null : [IN.level, IN.level]) : null, ...(ds ? { style: sk } : {}) };
      IN.sel = it.id;
      commitInterior([...intItems(), it], `Added ${kind === "opening" ? "an opening" : `${/^[aeiou]/i.test(ds.label) ? "an" : "a"} ${ds.label.toLowerCase()} door`} in the ${d.outside ? "outside" : "internal"} wall.`);
      return;
    }
    const hitId = Builder.pickInterior(P, IN.level, pt, tol); if (hitId) { IN.sel = hitId; renderToolRows(); return; }
    status(m === "extdoor" ? "Tap near an outside wall to put a door in it." : "Tap on a wall to put a " + m + " in it."); return;
  }
  const hitId = Builder.pickInterior(P, IN.level, pt, tol);
  if (m === "select" || hitId) { IN.sel = hitId; renderToolRows(); const it = selItem(); status(it ? `Selected the ${it.kind}. X / Z move it, DELETE removes it${it.kind === "door" ? ", FLIP swaps its side" : ""}.` : "Nothing there."); return; }
  const it = { id: newId(), kind: m, x: +pt[0].toFixed(3), z: +pt[1].toFixed(3), ang: IN.ang, lv: m === "core" || IN.all ? null : [IN.level, IN.level],
    ...(m === "stair" ? { type: IN.style.stair } : m === "core" ? { style: IN.style.core } : {}) };
  IN.sel = it.id;
  commitInterior([...intItems(), it], { stair: `Added ${IN.style.stair === "L" ? "an L-shaped" : "a " + Builder.STAIR_TYPES[IN.style.stair].toLowerCase()} stair to the floor above.`, core: `Added a ${Builder.CORE_STYLES[IN.style.core].toLowerCase()} through every floor.`, column: "Added a column." }[m]);
}
// selection and the wall being drawn, over the plan
function drawOverlay() {
  const svg = $("overlay");
  if (!IN.on || !sketchParams || !built()) { if (svg.innerHTML) svg.innerHTML = ""; return; }
  const P = sketchParams, y = floorAt() + 0.02, S = q => toScreen(q, y);
  const poly = (q, cls) => { const pts = q.map(S); if (pts.some(p => !p.visible)) return ""; return `<polygon class="${cls}" points="${pts.map(p => p.x + "," + p.y).join(" ")}"/>`; };
  let out = "";
  const sel = selItem();
  if (sel) {
    if (sel.kind === "door" || sel.kind === "opening") { const ds = Builder.interiorDims(P, IN.level, sel.id).find(d => d.key === "w"); if (ds) out += poly([[ds.a[0], ds.a[2]], [ds.b[0], ds.b[2]]], "sel"); }
    else out += poly(Builder.itemOutline(P, Builder.clampItem(sel)), "sel");
  }
  if (IN.mode === "wall" && IN.chain) { const c = S(IN.chain); if (c.visible) out += `<circle class="snap" cx="${c.x}" cy="${c.y}" r="7"/>`; }
  svg.innerHTML = out;
}

// ---- the tool rows under the model
function setTool(which) {
  const was = MOD.on ? "modify" : IN.on ? "interior" : null;
  if (MOD.on) { MOD.on = false; pickPart(null); MOD.element = null; MOD.lastOp = null; showSnap(null); }
  if (IN.on) setInterior(false);
  if (which && which !== was) {
    if (which === "modify") { if (moveOn) setMove(false); MOD.on = true; status("MODIFY: " + MOD_HINT[MOD.mode]); }
    else if (which === "interior" && !setInterior(true)) which = null;
  } else if (!which || which === was) status(siteStatus() || "Drag to orbit, pinch to zoom.");
  renderToolRows();
}
function seg(id, list, cur, onPick, extra = []) {
  const box = $(id);
  box.innerHTML = list.map(([k, label]) => `<button data-k="${k}" class="${k === cur ? "on" : ""}">${label}</button>`).join("") + extra.map(([k, label]) => `<button data-x="${k}">${label}</button>`).join("");
  box.querySelectorAll("[data-k]").forEach(b => b.onclick = () => onPick(b.dataset.k));
  return box;
}
const entries = o => Object.entries(o).map(([k, v]) => [k, (typeof v === "string" ? v : v.label).toUpperCase()]);
function renderToolRows() {
  const has = !!modelRoot, tool = MOD.on ? "modify" : IN.on ? "interior" : null;
  $("toolRow").hidden = !has;
  $("modBtn").classList.toggle("on", MOD.on); $("intBtn").classList.toggle("on", IN.on);
  $("intBtn").disabled = !sketchParams;
  $("styleRow").hidden = !sketchParams || !!tool;
  $("toolPanel").hidden = !tool;
  $("nudgeRow").hidden = !(moveOn || tool);
  document.body.classList.toggle("tooling", !!tool);
  if (!tool) return;
  if (MOD.on) {
    seg("modeRow", MOD_MODES, MOD.mode, k => { MOD.mode = k; if (k !== "select") pickPart(null); renderToolRows(); status("MODIFY: " + MOD_HINT[k]); });
    const m = MOD.mode;
    const opts = m === "door" ? [entries(Builder.DOOR_STYLES), MOD.door, k => { MOD.door = k; if (MOD.lastOp && MOD.lastOp.opts.mode === "door") editOp(MOD.lastOp, { doorStyle: k, doorWidth: undefined, doorHeight: undefined }); renderToolRows(); }]
      : m === "balustrade" ? [entries(Builder.BALUSTRADE_STYLES), MOD.bal, k => { MOD.bal = k; if (MOD.lastOp && MOD.lastOp.opts.mode === "balustrade") editOp(MOD.lastOp, { balustradeStyle: k }); renderToolRows(); }]
      : m === "column" ? [entries(Builder.COLUMN_SHAPES), MOD.col, k => { MOD.col = k; const el = MOD.element; if (el && el.parent && el.userData.element.kind === "column") { updateElement(el, { shape: k }); partsChanged(); } renderToolRows(); }]
      : null;
    $("optRow").hidden = !opts; if (opts) seg("optRow", ...opts);
    $("levelBox").hidden = true; $("allBtn").hidden = true; $("doneBtn").hidden = true;
    $("snapBtn").hidden = false; $("snapBtn").classList.toggle("on", SNAPS.on);
    $("flipBtn").hidden = m !== "door";
  } else {
    seg("modeRow", INT_MODES, IN.mode, k => { IN.mode = k; IN.chain = null; renderToolRows(); status(INT_HINT[k]); });
    const sel = selItem(), slot = ["door", "extdoor", "stair", "core"].includes(IN.mode) ? IN.mode : sel && ["door", "stair", "core"].includes(sel.kind) ? sel.kind : null;
    const kind = slot === "extdoor" ? "door" : slot;
    $("optRow").hidden = !kind;
    if (kind) {
      const set = { door: Builder.DOOR_STYLES, stair: Builder.STAIR_TYPES, core: Builder.CORE_STYLES }[kind];
      const cur = sel && sel.kind === kind ? (kind === "door" ? (sel.style || "single") : kind === "stair" ? (sel.type || "dogleg") : (sel.style || "lift")) : IN.style[slot];
      seg("optRow", entries(set), cur, k => {
        IN.style[slot] = k;
        const it = selItem();
        if (it && it.kind === kind) {
          if (kind === "door") replaceItem({ ...it, style: k, w: Builder.DOOR_STYLES[k].w, h: Builder.DOOR_STYLES[k].h });
          else if (kind === "stair") { const n2 = { ...it, type: k }; delete n2.rise; replaceItem(n2); }
          else replaceItem({ ...it, style: k });
        } else renderToolRows();
      });
    }
    const n = Builder.floorCount(sketchParams);
    $("levelBox").hidden = false; $("levelVal").textContent = (IN.level === 0 ? "GROUND" : "LEVEL " + IN.level) + (n > 1 ? ` / ${n}` : "");
    $("allBtn").hidden = false; $("allBtn").textContent = IN.all ? "ALL FLOORS" : "THIS FLOOR"; $("allBtn").classList.toggle("on", IN.all);
    $("doneBtn").hidden = IN.mode !== "wall"; $("snapBtn").hidden = true;
    $("flipBtn").hidden = !(IN.mode === "door" || IN.mode === "extdoor" || (sel && sel.kind === "door"));
  }
  holdFrame = false;
}
// building styles for a model built here: the style's roof, walls, windows and front door
function applyStyle(key) {
  if (!sketchParams) return;
  const st = Builder.BUILDING_STYLES[key]; if (!st) return;
  rebuildSketch(Builder.applyBuildingStyle(sketchParams, key));
  status(`${st.label}: ${(ROOF_LABEL[sketchParams.roofType] || "").toLowerCase()}, ${WINDOW_LABEL[sketchParams.windowType].toLowerCase()} windows. Add its ${Builder.DOOR_STYLES[st.door].label.toLowerCase()} front door with MODIFY → DOOR.`);
  MOD.door = st.door; IN.style.extdoor = st.door;
}
function bindTools() {
  $("modBtn").onclick = () => setTool("modify");
  $("intBtn").onclick = () => setTool("interior");
  seg("styleRow", entries(Builder.BUILDING_STYLES), null, applyStyle);
  $("deleteBtn").onclick = deleteSelected;
  $("undoBtn").onclick = undoModify;
  $("flipBtn").onclick = flipDoor;
  $("turnSelBtn").onclick = turnSelected;
  $("snapBtn").onclick = () => { SNAPS.on = !SNAPS.on; renderToolRows(); status(`Snap ${SNAPS.on ? "on: taps land on the nearest end, midpoint, edge or centre" : "off"}.`); };
  $("lvDown").onclick = () => changeLevel(-1); $("lvUp").onclick = () => changeLevel(1);
  $("allBtn").onclick = () => { IN.all = !IN.all; renderToolRows(); status(IN.all ? "New items go on every floor." : "New items go on this floor only."); };
  $("doneBtn").onclick = () => { IN.chain = null; status("Wall finished."); };
  bindTaps();
}

/* ---------------- a model from a PDF drawing set (desktop's reader, on the phone) ---------------- */
let drawingModel = null;
function buildFromDrawings(d, name) {
  if (!d.ok) throw new Error(d.error || "the PDF couldn't be read");
  const sheets = Drawings.classifySheets(d.pages.map(p => ({ page: p.page, words: p.words })));
  const plans = sheets.filter(s => s.kind === "plan");
  if (!plans.length) { status("No floor plan sheet was found in " + name + " (it looks for titles like GROUND FLOOR or FLOOR PLAN), so no model was built."); post({ type: "error", error: "No floor plan found" }); return; }
  const sh = plans[0], page = d.pages.find(p => p.page === sh.page);
  const written = [sh.scale, ...sheets.filter(s => s.scale && s.kind !== "plan").map(s => s.scale)].filter(Boolean);
  const sc = Drawings.planScale(page, sh.scale ? [sh.scale] : written), scale = sc.scale;
  const plan = Drawings.readPlan(page, page.words, scale);
  if (plan.error) { status(plan.error); return; }
  if (!sh.scale) plan.assumed.unshift(`the plan's scale wasn't legible, so 1:${scale}: ` + (sc.checked ? `it makes the outside walls ${Math.round(sc.wall * 1000)} mm thick` : "check the sizes"));
  else if (!sc.checked) plan.assumed.unshift(`1:${scale} as written, though the outside walls come out ${Math.round((sc.wall || 0) * 1000)} mm thick: check the scale`);
  if (plans.length > 1) plan.assumed.push(`${plans.length} plan sheets: this builds sheet ${sh.page} (the first); the others aren't stacked yet`);
  const h = Drawings.readHeights(sheets, plan);
  const sched = sheets.filter(s => s.kind === "windows").flatMap(s => Drawings.readWindowSchedule(d.pages.find(p => p.page === s.page).words));
  const nMatched = Drawings.applyWindowSchedule(plan, sched);
  if (sched.length) plan.read.push(`window schedule: ${sched.length} windows listed, ${nMatched} matched by width`);
  const roofSheet = sheets.find(s => s.kind === "roof"), roofs = roofSheet ? Drawings.readRoofPlan(d.pages.find(p => p.page === roofSheet.page), roofSheet.scale || 200) : [];
  for (const r of roofs) plan.read.push(`roof plan: ${r.who === "existing" ? "existing" : r.who === "carport" ? "carport" : "new"} ${r.type === "mono" ? "skillion" : r.type} roof${r.pitch ? ` at ${r.pitch}°` : ""}`);
  if (!roofSheet) plan.assumed.push("no roof plan in the set: add a roof with SKETCH or MODIFY");
  drawingModel = { plan, h, name, sheet: sh.page, roofs, sheets: sheets.length };
  showDrawingModel(true);
  post({ type: "loaded", name });
}
function showDrawingModel(first) {
  const dm = drawingModel, { plan, h } = dm;
  const keepPos = !first && modelRoot ? { p: modelRoot.position.clone(), r: modelRoot.rotation.y, cam: camera.position.clone(), tgt: controls.target.clone() } : null;
  MOD.ops = []; MOD.undo = []; MOD.lastOp = null; MOD.element = null; MOD.picked = null;
  setModel(Drawings.buildPlanModel(plan, h, { roofs: dm.roofs }));
  if (keepPos) { modelRoot.position.copy(keepPos.p); modelRoot.rotation.y = keepPos.r; placeModel(); camera.position.copy(keepPos.cam); controls.target.copy(keepPos.tgt); controls.update(); buildNeighbours(); }
  $("renderBtn").disabled = false; $("captureBtn").disabled = false;
  seg("drawRow", plan.buildings.map((b, i) => [String(i), `BUILDING ${i + 1}: ${b.existing ? "EXISTING" : "NEW"}`]), null, k => {
    const b = plan.buildings[+k]; b.existing = !b.existing;
    for (const i of b.walls) plan.walls[i].existing = b.existing;
    showDrawingModel(false);
    status(`Building ${+k + 1} is ${b.existing ? "existing" : "new"} work.`);
  });
  $("drawRow").hidden = plan.buildings.length < 1;
  renderToolRows();
  if (first) status(`Built from ${dm.name} (${dm.sheets} sheets, plan on sheet ${dm.sheet}). Read: ${[...plan.read, ...h.read].join("; ")}.` + ([...plan.assumed, ...h.assumed].length ? ` Assumed: ${[...plan.assumed, ...h.assumed].join("; ")}.` : "") + " Tap a building number to mark it existing or new.");
}

let incomingDrawings = null;
function resetTools() {
  if (MOD.on || IN.on) setTool(null);
  MOD.ops = []; MOD.undo = []; MOD.lastOp = null; MOD.element = null; MOD.picked = null; IN.undo = []; IN.sel = null; IN.chain = null; IN.level = 0;
  drawingModel = null; $("drawRow").hidden = true;
}

/* ---------------- UI ---------------- */
function bindUi() {
  $("openBtn").onclick = () => post({ type: "pickModel" });
  $("sketchBtn").onclick = () => post({ type: "pickSketch" });
  $("winBtn").onclick = cycleWindows;
  $("roofBtn").onclick = cycleRoof;
  $("elevBtn").onclick = () => post({ type: "pickElevation" });
  $("stDown").onclick = () => stepStoreys(-1); $("stUp").onclick = () => stepStoreys(1);
  $("szDown").onclick = () => stepSize(-1); $("szUp").onclick = () => stepSize(1);
  $("clayBtn").onclick = () => { holdFrame = false; clayOn = !clayOn; applyClay(); };
  $("turnBtn").onclick = () => turn(-1);
  $("spinBtn").onclick = () => spin(-45);
  $("moveBtn").onclick = () => setMove(!moveOn);
  for (const ax of ["x", "y", "z"]) { $(ax + "Down").onclick = () => nudge(ax, -1); $(ax + "Up").onclick = () => nudge(ax, 1); }
  $("stepBtn").onclick = () => { stepI = (stepI + 1) % STEPS.length; stepLabel(); };
  stepLabel();
  bindMove();
  bindTools();
  $("renderBtn").onclick = renderPhoto;
  $("captureBtn").onclick = captureView;
  $("time").oninput = e => { holdFrame = false; hours = Number(e.target.value); applySun(); };
}

/* ---------------- bridge from React Native ---------------- */
window.__mono = {
  // s: { lat, lng, imageBase64?, meters? } or null. The image is Apple Maps satellite, north up, `meters` square.
  async setSite(s) {
    siteInfo = s && Number.isFinite(s.lat) && Number.isFinite(s.lng) ? { lat: s.lat, lng: s.lng } : null;
    $("timeRow").style.opacity = siteInfo ? 1 : 0.45;
    groundImage = false;
    clearSurroundings(); nbFoot = null;
    try {
      if (siteInfo && s.imageBase64) {
        siteImages[s.meters || 220] = "data:image/jpeg;base64," + s.imageBase64;
        await Engine.setGroundImage(site, "data:image/jpeg;base64," + s.imageBase64, s.meters || 220, 1);
        groundImage = true;
      } else {
        await Engine.setGroundImage(site, null);
        site.farMat.color.set(0x8a8d84);
      }
    } catch (e) { post({ type: "error", error: "The satellite image couldn't be used: " + (e && e.message) }); }
    if (modelRoot) {   // keep the user's view; just settle the model on the new ground
      const y0 = modelRoot.position.y; placeModel(); const dy = modelRoot.position.y - y0;
      camera.position.y += dy; controls.target.y += dy; controls.update(); setupGround();
    } else { site.ground.visible = groundImage; if (groundImage) site.far.visible = true; }
    applySun();
    if (siteInfo) status(siteStatus());
  },
  setRing(meters, b64) { if (siteInfo) setRing(meters, b64); },
  // d: { n, half, step, z: number[] } in metres relative to the site; which: "near" (2 km) or "far" (30 km)
  setDem(which, d) {
    if (!siteInfo || !d) return;
    if (which === "far") demFar = d; else dem = d;
    const zs = (demFar || dem).z; relief = { min: Math.min(...zs), max: Math.max(...zs) };
    // keep the user's view: lift the camera with the model as it settles onto the terrain
    const y0 = modelRoot ? modelRoot.position.y : 0;
    setTerrain();
    if (modelRoot) { const dy = modelRoot.position.y - y0; camera.position.y += dy; controls.target.y += dy; controls.update(); }
    applySun();
    status(siteStatus());
  },
  demFailed(msg) { status(siteStatus() + " Terrain unavailable (" + msg + "), so the ground is flat."); },
  // Overpass JSON arrives in chunks (it can be a few MB in a city).
  osmBegin() { incomingOsm = []; status("Reading the buildings around the site…"); },
  osmChunk(part) { if (incomingOsm) incomingOsm.push(part); },
  async osmEnd() {
    const parts = incomingOsm; incomingOsm = null;
    if (!parts || !siteInfo) return;
    try { osmRaw = parseOsm(JSON.parse(parts.join("")), siteInfo.lat, siteInfo.lng); nbFoot = null; osmDone = true; await buildNeighbours(); }
    catch (e) { nbSummary = "the neighbouring buildings couldn't be read"; status(siteStatus()); }
  },
  osmFailed(msg) { osmDone = true; nbFoot = null; buildNeighbours().then(() => { if (!nbSummary) nbSummary = "OpenStreetMap unavailable (" + msg + ")"; status(siteStatus()); }); },
  // Apple standard map (base64 PNG) at 220 or 1100 m, for tracing the buildings OpenStreetMap doesn't have
  setMap(meters, b64) { if (!siteInfo) return; if (meters > 300) mapWide = b64; else mapNear = b64; traced = null; nbFoot = null; buildNeighbours(); },
  // Screenshot builds only (see SCREENSHOT_MODE in App.js): set the time / clay, orbit the camera, and render.
  demo(o) {
    if (o.nudges && modelRoot) { setMove(true); for (const [ax, sign] of o.nudges) nudge(ax, sign); }
    if (o.hours != null) { hours = o.hours; $("time").value = o.hours; applySun(); }
    if (o.clay != null) { clayOn = !!o.clay; applyClay(); }
    if (o.windows && sketchParams) { let n = 0; while (sketchParams.windowType !== o.windows && n++ < 4) cycleWindows(); }
    if (o.move && modelRoot) {
      modelRoot.position.x += o.move[0]; modelRoot.position.z += o.move[1];
      controls.target.x += o.move[0]; controls.target.z += o.move[1];
      camera.position.x += o.move[0]; camera.position.z += o.move[1];
      placeModel(); applySun(); buildNeighbours();
    }
    if (o.spinDeg) spin(o.spinDeg);
    // camera: tiltDeg = how far above the horizon it looks down from; zoom < 1 moves it closer
    if ((o.tiltDeg != null || o.zoom != null) && modelRoot) {
      const t = controls.target, off = camera.position.clone().sub(t), r = off.length() * (o.zoom || 1);
      const az = Math.atan2(off.x, off.z), el = (o.tiltDeg != null ? o.tiltDeg : Math.asin(off.y / off.length()) * 180 / Math.PI) * Math.PI / 180;
      camera.position.set(t.x + r * Math.cos(el) * Math.sin(az), t.y + r * Math.sin(el), t.z + r * Math.cos(el) * Math.cos(az));
      controls.update();
    }
    if (o.orbitDeg != null && modelRoot) {
      const t = controls.target, off = camera.position.clone().sub(t);
      off.applyAxisAngle(new THREE.Vector3(0, 1, 0), o.orbitDeg * Math.PI / 180);
      camera.position.copy(t).add(off); controls.update();
    }
    if (o.render) {   // wait for the surroundings (rings and buildings) to arrive, up to 40 s
      const t0 = Date.now();
      const go = () => (!(siteInfo && ringTex[1100] && ringTex[5500] && osmDone && nbSummary && demFar) && Date.now() - t0 < 300000) ? setTimeout(go, 500) : setTimeout(renderPhoto, 800);
      go();
    }
  },
  // Apple Vision's reading of a sketch photo (JSON text, in chunks: it carries line-weight masks)
  sketchBegin() { incomingSketch = []; status("Building the model from the sketch…"); },
  sketchChunk(part) { if (incomingSketch) incomingSketch.push(part); },
  sketchEnd(name, kind) {
    const parts = incomingSketch; incomingSketch = null;
    try { if (kind === "elevation") applyElevationSketch(JSON.parse(parts.join(""))); else buildFromSketch(JSON.parse(parts.join("")), name || "the sketch"); }
    catch (e) { status("Couldn't build from the sketch: " + (e && e.message)); post({ type: "sketchRead", error: String(e && e.message || e) }); }
  },
  modelBegin(name) { resetTools(); sketchParams = null; drawingModel = null; $("drawRow").hidden = true; yLift = 0; moved = { x: 0, z: 0 }; $("editRow").hidden = true; $("elevBtn").hidden = true; incoming = { name, parts: [] }; status("Loading " + name + "…"); },
  // a PDF drawing set read on the phone (Drawings.swift's JSON, in chunks)
  drawingsBegin(name) { resetTools(); sketchParams = null; $("editRow").hidden = true; $("elevBtn").hidden = true; incomingDrawings = []; status("Building the model from " + name + "…"); },
  drawingsChunk(part) { if (incomingDrawings) incomingDrawings.push(part); },
  drawingsEnd(name) {
    const parts = incomingDrawings; incomingDrawings = null; if (!parts) return;
    try { buildFromDrawings(JSON.parse(parts.join("")), name || "the drawings"); }
    catch (e) { status("Couldn't build from the drawings: " + (e && e.message)); post({ type: "error", error: String(e && e.message || e) }); }
  },
  modelChunk(part) { if (incoming) incoming.parts.push(part); },
  async modelEnd() {
    const job = incoming; incoming = null;
    if (!job) return;
    try {
      const root = await parseModel(job.name, b64ToBytes(job.parts.join("")));
      setModel(root);
      let meshes = 0; root.traverse(o => { if (o.isMesh) meshes++; });
      if (!meshes) throw new Error("No geometry found in " + job.name + ".");
      renderToolRows();
      status(job.name + " — drag to orbit, pinch to zoom. If it's lying on its side, tap Turn. MODIFY adds doors, windows, verandahs and more.");
      $("renderBtn").disabled = false; $("captureBtn").disabled = false;
      post({ type: "loaded", name: job.name });
    } catch (e) {
      status("Couldn't open " + job.name + ": " + (e && e.message));
      post({ type: "error", error: String(e && e.message || e) });
    }
  },
};

init();
