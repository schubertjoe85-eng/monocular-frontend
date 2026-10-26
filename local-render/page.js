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
    controls.update(); renderer.render(scene, camera);
  });
  status("Open a 3D model (.dae, .glb, .obj) to start.");
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
  sun.castShadow = elevDeg > 0;
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
  modelRoot.traverse(o => { if (o.isMesh) o.material = clayOn ? CLAY : origMats.get(o); });
  $("clayBtn").classList.toggle("on", clayOn);
}
// MOVE: drag the model across the site with one finger (orbit is paused while it's on), like desktop's Move tool.
let moveOn = false, dragFrom = null;
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
  moveOn = !!on && !!modelRoot;
  controls.enabled = !moveOn;
  $("moveBtn").classList.toggle("on", moveOn);
  if (moveOn) status("MOVE: drag the model to its place on the site. Tap MOVE again to orbit.");
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
  modelRoot.position.y = low - b.min.y; modelRoot.updateMatrixWorld(true);
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
  for (const id of ["openBtn", "sketchBtn", "winBtn", "clayBtn", "turnBtn", "spinBtn", "moveBtn", "renderBtn", "captureBtn", "time"]) $(id).disabled = b;
}

/* ---------------- a model built from a photographed sketch (desktop's Builder, on the phone) ---------------- */
let sketchParams = null;   // builder params from the last sketch reading; WINDOWS rebuilds from these
const WINDOW_LABEL = { punched: "PUNCHED", ribbon: "RIBBON", curtain: "CURTAIN", none: "NO" };
function buildFromSketch(vision, name) {
  const cur = { ...Builder.DEFAULTS, windowType: sketchParams ? sketchParams.windowType : Builder.DEFAULTS.windowType };
  const r = Builder.interpretSketch(vision, cur, { level: 0 });
  if (r.error) { status("Couldn't build from the sketch: " + r.error); post({ type: "sketchRead", error: r.error }); return; }
  sketchParams = { ...cur, ...r.params };
  setModel(Builder.buildModel(sketchParams));
  $("renderBtn").disabled = false; $("captureBtn").disabled = false;
  $("winBtn").hidden = false; $("winBtn").textContent = WINDOW_LABEL[sketchParams.windowType] + " WINDOWS";
  const h = Builder.totalHeight(sketchParams);
  status(`Built from ${name}: ` + r.read.join("; ") + `; ${h.toFixed(1)} m high.` + (r.assumed.length ? " Assumed: " + r.assumed.join("; ") + "." : ""));
  post({ type: "sketchRead", read: r.read, assumed: r.assumed, height: h });
}
// WINDOWS: the builder's Windows setting for the walls the sketch doesn't mark as glass or solid
function cycleWindows() {
  if (!sketchParams || !modelRoot) return;
  const keepPos = modelRoot.position.clone(), keepRot = modelRoot.rotation.y;
  sketchParams = { ...sketchParams, windowType: Builder.cycleWindows(sketchParams.windowType) };
  const cam = camera.position.clone(), tgt = controls.target.clone();
  setModel(Builder.buildModel(sketchParams));
  modelRoot.position.copy(keepPos); modelRoot.rotation.y = keepRot; placeModel();
  camera.position.copy(cam); controls.target.copy(tgt); controls.update(); applySun(); buildNeighbours();
  $("winBtn").textContent = WINDOW_LABEL[sketchParams.windowType] + " WINDOWS";
}

/* ---------------- UI ---------------- */
function bindUi() {
  $("openBtn").onclick = () => post({ type: "pickModel" });
  $("sketchBtn").onclick = () => post({ type: "pickSketch" });
  $("winBtn").onclick = cycleWindows;
  $("clayBtn").onclick = () => { holdFrame = false; clayOn = !clayOn; applyClay(); };
  $("turnBtn").onclick = () => turn(-1);
  $("spinBtn").onclick = () => spin(-45);
  $("moveBtn").onclick = () => setMove(!moveOn);
  bindMove();
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
  sketchEnd(name) {
    const parts = incomingSketch; incomingSketch = null;
    try { buildFromSketch(JSON.parse(parts.join("")), name || "the sketch"); }
    catch (e) { status("Couldn't build from the sketch: " + (e && e.message)); post({ type: "sketchRead", error: String(e && e.message || e) }); }
  },
  modelBegin(name) { sketchParams = null; $("winBtn").hidden = true; incoming = { name, parts: [] }; status("Loading " + name + "…"); },
  modelChunk(part) { if (incoming) incoming.parts.push(part); },
  async modelEnd() {
    const job = incoming; incoming = null;
    if (!job) return;
    try {
      const root = await parseModel(job.name, b64ToBytes(job.parts.join("")));
      setModel(root);
      let meshes = 0; root.traverse(o => { if (o.isMesh) meshes++; });
      if (!meshes) throw new Error("No geometry found in " + job.name + ".");
      status(job.name + " — drag to orbit, pinch to zoom. If it's lying on its side, tap Turn.");
      $("renderBtn").disabled = false; $("captureBtn").disabled = false;
      post({ type: "loaded", name: job.name });
    } catch (e) {
      status("Couldn't open " + job.name + ": " + (e && e.message));
      post({ type: "error", error: String(e && e.message || e) });
    }
  },
};

init();
