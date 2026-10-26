/* Monocular native render engine (offline, no models to download).
 *
 * Geometry is the user's own model, so it is exact by construction. What is
 * added on top is physically based: the sun's real position for the site and
 * time, materials taken from the confirmed drawing spec (unspecified =
 * neutral grey, never invented), the site's real satellite image as the
 * ground, and a progressive path tracer for photoreal output.
 */
import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";
import { WebGLPathTracer } from "three-gpu-pathtracer";
import { Muxer, ArrayBufferTarget } from "mp4-muxer";

/* ---------------- sun ---------------- */
// NOAA-style solar position. azimuth: radians clockwise from true north.
export function solarPosition(date, lat, lng) {
  const rad = Math.PI / 180;
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.460 + 0.9856474 * n) % 360;
  const g = (((357.528 + 0.9856003 * n) % 360) + 360) % 360 * rad;
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 0.0000004 * n) * rad;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmstHours = (((18.697374558 + 24.06570982441908 * n) % 24) + 24) % 24;
  const H = (gmstHours * 15 + lng) * rad - ra;
  const phi = lat * rad;
  const elevation = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const azimuth = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(H));
  return { azimuth: (azimuth + 2 * Math.PI) % (2 * Math.PI), elevation };
}
// Slider hours are local standard time; offset from the site's longitude.
export function siteDate(hours, lng, day = new Date()) {
  const offset = Math.round(lng / 15);
  const utcMs = Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()) + (hours - offset) * 3600000;
  return new Date(utcMs);
}
// World convention: true north = -Z, east = +X, up = +Y.
export function sunDirection(azimuth, elevation) {
  return new THREE.Vector3(
    Math.cos(elevation) * Math.sin(azimuth),
    Math.sin(elevation),
    -Math.cos(elevation) * Math.cos(azimuth)
  );
}

/* ---------------- colours ---------------- */
// Only colours that can be named from the spec or by the owner. Anything not
// recognised resolves to null and is rendered neutral - never guessed.
const NAMED = {
  "manor red": 0x5e1d1a, "heritage red": 0x6b2422, "surfmist": 0xe4e2d6, "classic cream": 0xe8ddc0, "cream": 0xeadfc4,
  "shale grey": 0xbdbfb7, "monument": 0x323233, "woodland grey": 0x4b4d46, "dune": 0xb0aa9b, "basalt": 0x6d6c6e,
  "jasper": 0x5a4e3f, "windspray": 0x7a7d7e, "night sky": 0x1e1f21, "off white": 0xeeece4, "white": 0xf0f0ee,
  "black": 0x1a1a1a, "charcoal": 0x36373a, "grey": 0x8e8e8b, "gray": 0x8e8e8b, "light grey": 0xbcbcb8, "dark grey": 0x55555a,
  "beige": 0xd8c9a8, "sand": 0xcdb98f, "terracotta": 0xb0563a, "red": 0x9a2a25, "brown": 0x5c4330, "green": 0x4c6a4a,
  "blue": 0x466a8a, "yellow": 0xd9c060, "orange": 0xc7743a, "tan": 0xb9a27c, "silver": 0xb8babc,
  // mixed hues people use for glazing ("blue green glass") — matched before the single-colour names, being longer
  "blue green": 0x3d8a8c, "blue-green": 0x3d8a8c, "green blue": 0x3f8c94, "green-blue": 0x3f8c94, "teal": 0x2f7f80,
  "aqua": 0x5fb3b3, "turquoise": 0x40a8a0, "sea green": 0x3f8f6f,
};
export const NEUTRAL = 0x9c9c98;
export function resolveColour(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  const hex = t.match(/#([0-9a-f]{6})\b/);
  if (hex) return parseInt(hex[1], 16);
  let best = null;
  for (const name of Object.keys(NAMED)) {
    if (t.includes(name) && (!best || name.length > best.length)) best = name;
  }
  return best ? NAMED[best] : null;
}

/* ---------------- materials ---------------- */
// Physical character per element (how shiny/rough), independent of colour.
const SURFACE = {
  poolHouseRoof: { roughness: 0.55, metalness: 0.12 },
  existingRoof: { roughness: 0.68, metalness: 0.0 },
  carport: { roughness: 0.6, metalness: 0.12 },
  poolHouseWalls: { roughness: 0.78, metalness: 0.0 },   // was 0.92 — pure-matte is what read as flat "pastel"
  existingWalls: { roughness: 0.76, metalness: 0.0 },
  doors: { roughness: 0.35, metalness: 0.0 },
  deck: { roughness: 0.75, metalness: 0.0 },
  pool: { roughness: 0.1, metalness: 0.0 },
  paving: { roughness: 0.8, metalness: 0.0 },
  fences: { roughness: 0.65, metalness: 0.0 },
  ground: { roughness: 0.95, metalness: 0.0 },
  windows: { roughness: 0.25, metalness: 0.5 }, // frames; the glazing itself is "glass"
  cladding: { roughness: 0.32, metalness: 0.6 },
  structure: { roughness: 0.42, metalness: 0.65 },
  roof: { roughness: 0.62, metalness: 0.12 },
  podium: { roughness: 0.78, metalness: 0.0 },
  entry: { roughness: 0.3, metalness: 0.32 },
  balustrade: { roughness: 0.32, metalness: 0.45 },
  landscape: { roughness: 1.0, metalness: 0.0 },
};
/* ---------------- textured finishes ----------------
 * Procedural, drawn locally: the pattern says what kind of finish it is (from the element and
 * the spec's own words), the colour comes only from the spec. No colour known = no texture. */
const FINISH_SIZE_M = { panels: 1.2, tile: 0.6, ribs: 0.9, brick: 0.6, render: 1.0, boards: 0.9, pavers: 0.9, lawn: 1.5, mosaic: 0.5, plain: 1.0 };
export function finishKind(key, valueText) {
  const t = String(valueText || "").toLowerCase();
  if (key === "poolHouseRoof" || key === "existingRoof" || key === "carport") return /tile/.test(t) ? "tile" : "ribs";
  if (key === "poolHouseWalls" || key === "existingWalls" || key === "fences") return /brick/.test(t) ? "brick" : "render";
  if (key === "deck") return "boards";
  if (key === "paving") return "pavers";
  if (key === "ground" || key === "landscape") return "lawn";
  if (key === "cladding") return "panels";
  if (key === "podium") return "pavers";
  if (key === "pool") return "mosaic";
  return "plain";
}
const finishCache = new Map();
function shade(c, k) { const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255; const f = v => Math.max(0, Math.min(255, Math.round(v * k))); return `rgb(${f(r)},${f(g)},${f(b)})`; }
function rnd(seed) { let x = seed | 0 || 1; return () => ((x = (x * 1664525 + 1013904223) | 0) >>> 0) / 4294967296; }
export function finishCanvas(kind, colour, size = 256) {
  const cv = document.createElement("canvas"); cv.width = cv.height = size;
  const g = cv.getContext("2d"), R = rnd(7 + kind.length * 13);
  g.fillStyle = shade(colour, 1); g.fillRect(0, 0, size, size);
  const speck = (n, a, k1, k2) => { for (let i = 0; i < n; i++) { g.fillStyle = shade(colour, k1 + R() * (k2 - k1)); g.globalAlpha = a; g.fillRect(R() * size, R() * size, 1 + R() * 2, 1 + R() * 2); } g.globalAlpha = 1; };
  if (kind === "tile") {
    const rows = 8, h = size / rows, w = size / 4;
    for (let r = 0; r < rows; r++) for (let c = -1; c < 5; c++) {
      const x = c * w + (r % 2) * w / 2, y = r * h;
      g.fillStyle = shade(colour, 0.9 + R() * 0.2); g.fillRect(x + 1, y + 1, w - 2, h - 2);
      const gr = g.createLinearGradient(0, y, 0, y + h); gr.addColorStop(0, "rgba(0,0,0,0)"); gr.addColorStop(1, "rgba(0,0,0,0.28)");
      g.fillStyle = gr; g.fillRect(x + 1, y + 1, w - 2, h - 2);
    }
  } else if (kind === "ribs") {
    const n = 8, w = size / n;
    for (let i = 0; i < n; i++) {
      const gr = g.createLinearGradient(i * w, 0, (i + 1) * w, 0);
      gr.addColorStop(0, shade(colour, 1.12)); gr.addColorStop(0.18, shade(colour, 0.78)); gr.addColorStop(0.5, shade(colour, 1)); gr.addColorStop(1, shade(colour, 0.94));
      g.fillStyle = gr; g.fillRect(i * w, 0, w, size);
    }
  } else if (kind === "brick") {
    const rows = 8, h = size / rows, w = size / 4;
    g.fillStyle = shade(colour, 1.25); g.fillRect(0, 0, size, size);
    for (let r = 0; r < rows; r++) for (let c = -1; c < 5; c++) { g.fillStyle = shade(colour, 0.88 + R() * 0.2); g.fillRect(c * w + (r % 2) * w / 2 + 2, r * h + 2, w - 4, h - 4); }
  } else if (kind === "boards") {
    const n = 6, h = size / n;
    for (let i = 0; i < n; i++) {
      g.fillStyle = shade(colour, 0.9 + R() * 0.2); g.fillRect(0, i * h, size, h - 2);
      for (let k = 0; k < 14; k++) { g.strokeStyle = shade(colour, 0.7 + R() * 0.2); g.globalAlpha = 0.35; g.beginPath(); const y = i * h + R() * h; g.moveTo(0, y); g.lineTo(size, y + (R() - 0.5) * 4); g.stroke(); }
      g.globalAlpha = 1; g.fillStyle = "rgba(0,0,0,0.35)"; g.fillRect(0, i * h + h - 2, size, 2);
    }
  } else if (kind === "pavers") {
    const n = 4, w = size / n;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) { g.fillStyle = shade(colour, 0.92 + R() * 0.16); g.fillRect(c * w + 2, r * w + 2, w - 4, w - 4); }
    speck(500, 0.25, 0.7, 1.2);
  } else if (kind === "lawn") {
    speck(2600, 0.5, 0.65, 1.3);
    for (let i = 0; i < 900; i++) { g.strokeStyle = shade(colour, 0.6 + R() * 0.7); g.globalAlpha = 0.4; g.beginPath(); const x = R() * size, y = R() * size; g.moveTo(x, y); g.lineTo(x + (R() - 0.5) * 6, y - 3 - R() * 5); g.stroke(); }
    g.globalAlpha = 1;
  } else if (kind === "mosaic") {
    const n = 12, w = size / n;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) { g.fillStyle = shade(colour, 0.94 + R() * 0.12); g.fillRect(c * w + 1, r * w + 1, w - 2, w - 2); }
  } else if (kind === "panels") {
    const n = 3, w = size / n;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) { g.fillStyle = shade(colour, 0.95 + R() * 0.1); g.fillRect(c * w + 2, r * w + 2, w - 4, w - 4); }
  } else if (kind === "render") {
    speck(3000, 0.35, 0.86, 1.1);
  } else { speck(800, 0.15, 0.9, 1.1); }
  return cv;
}
function finishTexture(kind, colour) {
  const k = kind + colour;
  let t = finishCache.get(k);
  if (!t) {
    t = new THREE.CanvasTexture(finishCanvas(kind, colour));
    t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
    t.repeat.set(1 / FINISH_SIZE_M[kind], 1 / FINISH_SIZE_M[kind]);   // UVs are model metres (see the viewer's projected UVs)
    t.updateMatrix();                                                  // the path tracer reads texture.matrix directly
    finishCache.set(k, t);
  }
  return t;
}
/* ---------------- finish bump ----------------
 * finishCanvas() above only ever painted colour variation — under a real directional sun that reads as a
 * flat, printed-on pattern with no actual surface relief, which is exactly what was making honoured spec
 * materials (corrugated roofing, brickwork, decking) look unconvincing regardless of how correct their
 * colour was. This builds a matching HEIGHTFIELD per finish kind (same grid/geometry the colour canvas
 * uses — ribs, brick coursing with mortar joints, board gaps, paver/panel/mosaic joints) and converts it
 * to a tangent-space normal map so the path tracer's real sun actually catches ridges and recessed joints. */
function finishHeightAt(kind, x, y, size) {
  switch (kind) {
    case "ribs": { const n = 8, w = size / n; const t = (x % w) / w; return (Math.sin(t * Math.PI * 2 - Math.PI * 0.6) + 1) / 2; }
    case "tile": {
      const rows = 8, h = size / rows, w = size / 4;
      const ry = Math.floor(y / h), off = (ry % 2) * w / 2;
      const xt = (((x - off) % w) + w) % w / w, yt = (y % h) / h;
      return Math.max(0, Math.sin(xt * Math.PI)) * 0.75 + Math.sin(yt * Math.PI) * 0.25;
    }
    case "brick": {
      const rows = 8, h = size / rows, w = size / 4;
      const ry = Math.floor(y / h), off = (ry % 2) * w / 2;
      const xl = (((x - off) % w) + w) % w, yl = y % h;
      const edge = Math.min(xl, w - xl, yl, h - yl);
      return edge < 3 ? edge / 3 * 0.3 : 1;
    }
    case "boards": { const n = 6, h = size / n, yl = y % h; return yl > h - 3 ? 0.1 : 0.55 + Math.sin((yl / h) * Math.PI) * 0.45; }
    case "pavers": { const n = 4, w = size / n, xl = x % w, yl = y % w, edge = Math.min(xl, w - xl, yl, w - yl); return edge < 3 ? edge / 3 * 0.4 : 1; }
    case "panels": { const n = 3, w = size / n, xl = x % w, yl = y % w, edge = Math.min(xl, w - xl, yl, w - yl); return edge < 4 ? edge / 4 * 0.5 : 1; }
    case "mosaic": { const n = 12, w = size / n, xl = x % w, yl = y % w, edge = Math.min(xl, w - xl, yl, w - yl); return edge < 1.5 ? 0.5 : 1; }
    case "lawn": { const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return s - Math.floor(s); }
    case "render": {
      const s1 = Math.sin(x * 34.55 + y * 21.13) * 27183.128, n1 = s1 - Math.floor(s1);
      const s2 = Math.sin(x * 0.15 * 91.7 + y * 0.15 * 63.2) * 15731.7, n2 = s2 - Math.floor(s2);
      return n1 * 0.4 + n2 * 0.6;
    }
    default: return 0.5;
  }
}
const FINISH_NORMAL_STRENGTH = { ribs: 1.3, tile: 0.9, brick: 0.7, boards: 0.6, pavers: 0.55, panels: 0.5, mosaic: 0.35, lawn: 0.4, render: 0.3, plain: 0 };
const finishNormalCache = new Map();
function finishNormalTexture(kind) {
  if (kind === "plain") return null;
  let t = finishNormalCache.get(kind);
  if (!t) {
    const size = 256, H = new Float32Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) H[y * size + x] = finishHeightAt(kind, x, y, size);
    const at = (x, y) => H[((y + size) % size) * size + ((x + size) % size)];
    const cv = document.createElement("canvas"); cv.width = cv.height = size;
    const g = cv.getContext("2d"), img = g.createImageData(size, size), strength = 3.2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (at(x + 1, y) - at(x - 1, y)) * strength, dy = (at(x, y + 1) - at(x, y - 1)) * strength;
        const len = Math.hypot(dx, dy, 1) || 1, idx = (y * size + x) * 4;
        img.data[idx] = Math.round((-dx / len * 0.5 + 0.5) * 255);
        img.data[idx + 1] = Math.round((-dy / len * 0.5 + 0.5) * 255);
        img.data[idx + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
        img.data[idx + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1 / FINISH_SIZE_M[kind], 1 / FINISH_SIZE_M[kind]);
    t.updateMatrix();
    finishNormalCache.set(kind, t);
  }
  return t;
}
/** Small preview of a finish for the paintbrush palette; null when the spec gives no colour. */
export function finishSwatch(key, valueText, size = 64) {
  const c = resolveColour(valueText);
  return c == null ? null : finishCanvas(finishKind(key, valueText), c, size);
}
export function makeSpecMaterial(key, valueText, modelColour) {
  if (key === "glass" || key === "curtainWall") {
    // Real architectural glazing: reflective, part-transmissive, tinted. It used to be hard-coded fully clear at 25%
    // opacity (one project's spec), which made any tower's glazing all but disappear — just the slab edges were left.
    // Tint: a colour the owner named ("blue green glass"), else the model's own glass colour, else a neutral blue-grey.
    let tint = resolveColour(valueText);
    if (tint == null && modelColour) {
      const c = modelColour.clone(), hsl = {}; c.getHSL(hsl);
      c.setHSL(hsl.h, Math.min(0.5, hsl.s), Math.max(0.42, hsl.l));   // a near-black CAD tint reads as a tinted pane, not a black hole
      tint = c.getHex();
    }
    if (tint == null) tint = 0x9fb7c2;
    // Mostly reflection, a little transmission: at building scale glazing reads as sky and city reflected in a tinted
    // pane, not as a hole. No alpha transparency — the path tracer applied it on top of transmission and the panes
    // all but vanished, leaving only the slab edges.
    const m = new THREE.MeshPhysicalMaterial({
      color: tint, roughness: 0.04, metalness: 0.15, transmission: 0.15, ior: 1.52, thickness: 0.024,
      specularIntensity: 1, clearcoat: 0.6, clearcoatRoughness: 0.03, envMapIntensity: 1.4, side: THREE.DoubleSide,
    });
    m.userData.specKey = key; m.userData.colourKnown = true;
    return m;
  }
  const s = SURFACE[key] || { roughness: 0.85, metalness: 0 };
  const c = resolveColour(valueText);
  const m = new THREE.MeshStandardMaterial({ color: c == null ? NEUTRAL : c, roughness: s.roughness, metalness: s.metalness, side: THREE.DoubleSide });
  m.userData.specKey = key;
  m.userData.colourKnown = c != null;
  if (c != null && key !== "windows" && key !== "doors") {
    const kind = finishKind(key, valueText);
    if (kind !== "plain") {
      m.map = finishTexture(kind, c); m.color.set(0xffffff);
      const nrm = finishNormalTexture(kind);
      if (nrm) { m.normalMap = nrm; const s = FINISH_NORMAL_STRENGTH[kind] || 0.5; m.normalScale.set(s, s); }
    }
  }
  return m;
}

/** Unique original materials of the model with meshes, for the assignment UI. */
export function listModelMaterials(modelRoot, origMats) {
  const map = new Map();
  modelRoot.traverse(n => {
    if (!n.isMesh) return;
    const mat = origMats.get(n) || n.material;
    (Array.isArray(mat) ? mat : [mat]).forEach(m => {
      if (!m) return;
      let e = map.get(m);
      if (!e) {
        e = { mat: m, name: m.name || "(unnamed)", hex: m.color ? "#" + m.color.getHexString() : "#888888", count: 0, meshes: [] };
        map.set(m, e);
      }
      e.count++; e.meshes.push(n);
    });
  });
  const out = Array.from(map.values()).sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex));
  // CAD exports often carry no material names (ids only): label by rank so choices can be saved per model.
  out.forEach((e, i) => { if (!e.mat.name) e.name = "Surface " + (i + 1); });
  return out;
}

/**
 * Suggest an element for a model material from its own name only. Never from
 * its colour: viewer/CAD placeholder colours are not specification.
 */
export function suggestElement(name) {
  const t = String(name || "").toLowerCase();
  if (/glass|glaz|window|igu|curtain/.test(t)) return "glass";
  if (/roof/.test(t)) return "poolHouseRoof";
  if (/wall|render|precast|plaster/.test(t)) return "poolHouseWalls";
  if (/door/.test(t)) return "doors";
  if (/deck|timber|wood/.test(t)) return "deck";
  if (/pool|water|tile/.test(t)) return "pool";
  if (/paving|drive|concrete|pave/.test(t)) return "paving";
  if (/terrain|ground|site|grass|lawn|soil/.test(t)) return "terrain";
  return "";
}

/* ---------------- site (sky, ground, sun) ---------------- */
export function createSite(scene) {
  const sky = new Sky();
  sky.scale.setScalar(4500);
  scene.add(sky);
  // envMapIntensity dimmed below default (1): confirmed live under the path tracer that an upward-facing,
  // fully-diffuse (roughness 1) surface integrates far more of the sky dome than a vertical wall does — at
  // full intensity the ground and terrain rings blow out to solid white under real midday sun + sky GI while
  // walls (seen mostly edge-on to the sky) look correct, and globally lowering scene.environmentIntensity to
  // fix this made wall shadow-fill go near-black instead (see preparePhoto). Scoped to just these
  // upward-facing ground materials rather than the whole scene.
  // NOTE: this materially reduces but does not fully eliminate the white-out — confirmed live it's still
  // visible by ~30-60 samples even at much more aggressive values than this, and pushing further than this
  // measurably dimmed the building's own glass reflections without fixing the ground/trees. The residual
  // cause looks like it's dominated by sun.intensity (direct light, untouched by envMapIntensity) below,
  // not GI — see the sunScale()-adjacent comment where that's trimmed.
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x8a8d84, roughness: 1, metalness: 0, envMapIntensity: 0.4 });
  // Subdivided, not a bare 2-triangle quad: the wide terrain rings (below) are always finely subdivided and
  // their satellite textures bake into the path tracer correctly; this single flat quad — scaled up to a
  // ~220m span in one untessellated step — was the one surface whose texture consistently failed to show
  // in path-traced renders (flat white instead), while the same texture loading code worked everywhere else.
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 32, 32), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.visible = false;
  scene.add(ground);
  // Surround out to the horizon, coloured from the real satellite image (see setGroundImage).
  const farMat = new THREE.MeshStandardMaterial({ color: 0x8a8d84, roughness: 1, metalness: 0, envMapIntensity: 0.4 });
  const far = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), farMat);
  far.rotation.x = -Math.PI / 2;
  far.receiveShadow = true;
  far.visible = false;
  scene.add(far);
  return { sky, ground, groundMat, far, farMat, footprint: 220 };
}
export function setGroundImage(site, dataUrl, footprintMetres, unitsPerMetre = 1) {
  if (!dataUrl) { site.groundMat.map = null; site.groundMat.color.set(0x8a8d84); site.groundMat.needsUpdate = true; return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(dataUrl, tex => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      tex.matrixAutoUpdate = false; tex.updateMatrix();   // baked once, up front — the path tracer reads texture.matrix at scene-bake time, not per frame
      site.groundMat.map = tex;
      // Not full white: confirmed live that a satellite/aerial photo used as albedo at full (0xffffff)
      // strength, on a horizontal surface that's nearly perpendicular to a near-overhead midday sun, still
      // blows out to solid white under the path tracer even after dimming envMapIntensity above — direct sun
      // alone (unaffected by envMapIntensity) is enough. Aerial photography is auto-exposed for viewing, not
      // a calibrated albedo map, so treating it as one at 1.0 was always going to read too bright; a real
      // ground surface (grass, concrete, pavement) is usually more like 0.3–0.5 reflectance.
      site.groundMat.color.set(0xaaaaaa);
      site.groundMat.needsUpdate = true;
      // Average colour of the real image tints the surround, so the ground blends out to the horizon.
      // Same shadow/artifact guard as the neighbour-building roof colours: a downsampled-to-1px average
      // that happens to come out near-black is a sampling fluke, not a real ground colour, and was leaving
      // the horizon rendering as a flat black band instead of tinted terrain.
      try {
        const c = document.createElement("canvas"); c.width = c.height = 1;
        const g = c.getContext("2d"); g.drawImage(tex.image, 0, 0, 1, 1);
        const [r, gg, b] = g.getImageData(0, 0, 1, 1).data;
        // Same albedo-dimming reasoning as groundMat just above: the sampled pixel is straight off the
        // aerial photo (view-exposed, not a calibrated albedo), so scale it down before using it as one.
        const k = 0.67;
        if (r + gg + b > 60) site.farMat.color.setRGB(r / 255 * k, gg / 255 * k, b / 255 * k, THREE.SRGBColorSpace);
      } catch {}
      site.footprint = footprintMetres * unitsPerMetre;
      site.ground.scale.set(site.footprint, site.footprint, 1);
      resolve();
    }, undefined, reject);
  });
}
export function updateSky(site, dir, turbidity = 2.2) {
  const u = site.sky.material.uniforms;
  u.turbidity.value = 6; u.rayleigh.value = 2.0; u.mieCoefficient.value = 0.005; u.mieDirectionalG.value = 0.8;
  u.sunPosition.value.copy(dir);
}

/* ---------------- photoreal still (progressive path tracing) ---------------- */
export class Photoreal {
  constructor(renderer) {
    this.renderer = renderer;
    this.pt = new WebGLPathTracer(renderer);
    this.pt.bounces = 6;   // glossy roofs need a bit more light-path depth to resolve cleanly, not just more samples
    this.pt.tiles.set(3, 3);   // smaller GPU jobs per step (a long single job can hit the GPU watchdog and kill the web view)
    // 0.5 smoothed glossy reflections (roofs, glazing) enough to blur out the specular highlights that
    // actually read as "real" material — flattening exactly the surfaces that should pop the most. Lower
    // value keeps reflections sharp; at 150 samples / 6 bounces there's enough convergence to not need the
    // extra denoising blur this was trading away.
    this.pt.filterGlossyFactor = 0.25;
    this.pt.renderScale = 1;
    this.ready = false;
  }
  setScene(scene, camera) { this.pt.setScene(scene, camera); this.ready = true; }
  reset() { if (this.ready) this.pt.updateCamera(); }
  get samples() { return this.pt.samples; }
  step() { if (this.ready) this.pt.renderSample(); }
  dispose() { this.pt.dispose && this.pt.dispose(); }
}

/* ---------------- video ---------------- */
// Deterministic frame-by-frame capture: each frame is rendered (raster, or N
// path-traced samples) and handed to the H.264 encoder with an exact timestamp,
// so the clip plays at the requested speed however long the render takes.
export async function recordOrbit({ renderer, camera, controls, drawFrame, seconds, fps = 30, width, height, arc = Math.PI * 2, onProgress, signal }) {
  if (typeof VideoEncoder === "undefined") throw new Error("This system's web view has no video encoder (WebCodecs).");
  const canvas = renderer.domElement;
  const total = Math.round(seconds * fps);
  // H.264 encoders work in 16px macroblocks; odd sizes like 1280x724 can be
  // accepted by configure() and then silently produce zero frames.
  width = Math.round(width / 16) * 16; height = Math.round(height / 16) * 16;
  let encError = null, chunks = 0;
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: "avc", width, height }, fastStart: "in-memory" });
  const encoder = new VideoEncoder({ output: (chunk, meta) => {
      // Exceptions thrown here vanish silently in a codec callback; keep the first one so the render fails loudly.
      try {
        // WebKit's encoder leaves chunk.duration null, which the muxer rejects; every frame lasts 1/fps.
        const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
        muxer.addVideoChunkRaw(data, chunk.type, chunk.timestamp, Math.round(1e6 / fps), meta);
        chunks++;
      } catch (e) { encError = encError || e; }
    }, error: e => { encError = e; } });
  // format "avc" = length-prefixed NAL units plus an avcC config, which is what an MP4 needs (not Annex B).
  encoder.configure({ codec: "avc1.640028", width, height, bitrate: 14_000_000, framerate: fps, avc: { format: "avc" } });

  const target = controls.target.clone();
  const offset = camera.position.clone().sub(target);
  const radius = Math.hypot(offset.x, offset.z);
  const startAngle = Math.atan2(offset.x, offset.z);
  for (let i = 0; i < total; i++) {
    if (signal && signal.aborted) throw new Error("Video render cancelled.");
    if (encError) throw new Error("Video encoder failed: " + encError.message);
    const a = startAngle + arc * (i / total);
    camera.position.set(target.x + Math.sin(a) * radius, target.y + offset.y, target.z + Math.cos(a) * radius);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    await drawFrame(i, total);
    const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
    encoder.encode(frame, { keyFrame: i % fps === 0 });
    frame.close();
    if (encoder.encodeQueueSize > 8) await encoder.flush();
    if (onProgress) onProgress((i + 1) / total);
  }
  await encoder.flush();
  if (encError) throw new Error("Video encoder failed: " + encError.message);
  if (!chunks) throw new Error("The video encoder produced no frames.");
  muxer.finalize();
  const blob = new Blob([muxer.target.buffer], { type: "video/mp4" });
  return blob;
}


/* ---------------- surrounding buildings ----------------
 * Apple's standard map draws every building as a flat grey shape. Trace those shapes from an
 * MKMapSnapshotter image (on-device), colour each roof from the satellite image of the same
 * region, and hand back footprints in metres (x east, z south, centred on the site).
 * Heights are NOT in the map data: the caller assumes one and must say so. */
function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("map image failed")); i.src = src; }); }
function pixels(img) { const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight; const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0); return g.getImageData(0, 0, c.width, c.height); }
function morph(mask, w, h, r, grow) {
  // separable box min (erode) / max (dilate), radius r
  const pass = (src, horiz) => {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = grow ? 0 : 1;
      for (let k = -r; k <= r; k++) {
        const xx = horiz ? x + k : x, yy = horiz ? y : y + k;
        const b = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : src[yy * w + xx];
        if (grow ? b : !b) { v = grow ? 1 : 0; break; }
      }
      out[y * w + x] = v;
    }
    return out;
  };
  return pass(pass(mask, true), false);
}
function simplify(pts, eps) {
  const dp = (a, b, out) => {
    let dmax = 0, idx = -1;
    const [x1, y1] = a === undefined ? [0, 0] : pts[a], [x2, y2] = pts[b];
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs(dy * (pts[i][0] - x1) - dx * (pts[i][1] - y1)) / len; if (d > dmax) { dmax = d; idx = i; } }
    if (dmax > eps) { dp(a, idx, out); out.push(pts[idx]); dp(idx, b, out); }
  };
  return dp;
}
function simplifyClosed(pts, eps) {
  if (pts.length < 5) return pts;
  let far = 0, dm = 0; for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d > dm) { dm = d; far = i; } }
  const half = (arr) => { const out = [arr[0]]; simplify(arr, eps)(0, arr.length - 1, out); out.push(arr[arr.length - 1]); return out; };
  const a = half(pts.slice(0, far + 1)), b = half(pts.slice(far).concat([pts[0]]));
  return a.concat(b.slice(1, -1));
}
export async function traceBuildings(mapDataUrl, satDataUrl, footprintMetres) {
  const mi = await loadImg(mapDataUrl), md = pixels(mi), w = md.width, h = md.height;
  let sat = null;
  try { const si = await loadImg(satDataUrl); const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(si, 0, 0, w, h); sat = g.getImageData(0, 0, w, h).data; } catch {}
  return traceFromPixels(md.data, sat, w, h, footprintMetres);
}
// Pure pixel version (RGBA arrays), so the tracing can be tested without a browser.
export function traceFromPixels(d, sat, w, h, footprintMetres) {
  const mpp = footprintMetres / w;
  // Apple's building fill: neutral light grey, distinct from the cream ground, white roads and green parks.
  let mask = new Uint8Array(w * h);
  // Two building fills: neutral light grey (houses, civic) and tan (commercial blocks). Both are tight colours,
  // well apart from roads (white), park green, the cream ground and the yellow commercial zone.
  const near = (R, G, B, r, g, b) => Math.abs(R - r) <= 3 && Math.abs(G - g) <= 3 && Math.abs(B - b) <= 3;
  for (let i = 0; i < w * h; i++) { const R = d[i * 4], G = d[i * 4 + 1], B = d[i * 4 + 2]; mask[i] = (near(R, G, B, 234, 233, 232) || near(R, G, B, 244, 232, 212)) ? 1 : 0; }
  mask = morph(morph(mask, w, h, 2, false), w, h, 2, true);        // opening: drops road casings and text
  const lab = new Int32Array(w * h), out = [], minPx = 10 / (mpp * mpp), maxPx = 60000 / (mpp * mpp);
  let next = 0;
  for (let y0 = 0; y0 < h; y0++) for (let x0 = 0; x0 < w; x0++) {
    if (!mask[y0 * w + x0] || lab[y0 * w + x0]) continue;
    const id = ++next, st = [y0 * w + x0], px = []; lab[y0 * w + x0] = id;
    while (st.length) {
      const p = st.pop(); px.push(p); const x = p % w, y = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx; if (mask[q] && !lab[q]) { lab[q] = id; st.push(q); }
      }
    }
    if (px.length < minPx || px.length > maxPx) continue;
    // boundary edges (clockwise), chained into loops; the biggest loop is the outline
    const edges = new Map(), key = (x, y) => y * (w + 1) + x, add = (x1, y1, x2, y2) => { const k = key(x1, y1); (edges.get(k) || edges.set(k, []).get(k)).push([x2, y2]); };
    const inC = (x, y) => x >= 0 && y >= 0 && x < w && y < h && lab[y * w + x] === id;
    for (const p of px) { const x = p % w, y = (p / w) | 0;
      if (!inC(x, y - 1)) add(x, y, x + 1, y); if (!inC(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!inC(x, y + 1)) add(x + 1, y + 1, x, y + 1); if (!inC(x - 1, y)) add(x, y + 1, x, y); }
    let best = null;
    for (const [k0, list0] of edges) {
      if (!list0.length) continue;
      const sx = k0 % (w + 1), sy = (k0 / (w + 1)) | 0, loop = [[sx, sy]];
      let cx = sx, cy = sy, guard = 0;
      for (;;) { const l = edges.get(key(cx, cy)); if (!l || !l.length || guard++ > 200000) break; const [nx, ny] = l.pop(); if (nx === sx && ny === sy) break; loop.push([nx, ny]); cx = nx; cy = ny; }
      if (!best || loop.length > best.length) best = loop;
    }
    if (!best || best.length < 4) continue;
    const poly = simplifyClosed(best, 1.6);
    if (poly.length < 3) continue;
    let ar = 0, ccx = 0, ccy = 0; for (const p of px) { ccx += p % w; ccy += (p / w) | 0; } ccx /= px.length; ccy /= px.length;
    ar = px.length * mpp * mpp;
    let col = 0xb9b4ab;
    // A roof shadowed in the satellite photo, or landing on a tile gap/edge, averages to near-black — that's
    // a sampling artifact, not a real roof colour (real roofs essentially never average out this dark), and
    // was showing up as "strange black geometric shapes" on neighbouring buildings. Fall back to the
    // default tan instead of trusting an implausibly dark sample.
    if (sat) {
      let r = 0, g2 = 0, b = 0, n = 0;
      for (const p of px) { r += sat[p * 4]; g2 += sat[p * 4 + 1]; b += sat[p * 4 + 2]; n++; }
      const rr = r / n | 0, gg = g2 / n | 0, bb = b / n | 0;
      if (rr + gg + bb > 60) col = (rr << 16) | (gg << 8) | bb;
    }
    out.push({ pts: poly.map(([x, y]) => [(x - w / 2) * mpp, (y - h / 2) * mpp]), area: ar, cx: (ccx - w / 2) * mpp, cz: (ccy - h / 2) * mpp, color: col });
  }
  return out;
}


/* ---------------- foliage ----------------
 * Mottled leaf-cluster texture per crown tone, mapped onto the crown geometry's own UVs (icosahedra
 * already carry spherical UVs). Flat colour reads as plastic; broken-up light/dark clusters read as leaves. */
export function makeFoliageTexture(baseHex, size = 256) {
  const cv = document.createElement("canvas"); cv.width = cv.height = size;
  const g = cv.getContext("2d"), R = rnd(baseHex);
  const [r0, g0, b0] = [(baseHex >> 16) & 255, (baseHex >> 8) & 255, baseHex & 255];
  const tone = (k, a) => `rgba(${Math.min(255, r0 * k) | 0},${Math.min(255, g0 * k) | 0},${Math.min(255, b0 * k) | 0},${a})`;
  g.fillStyle = tone(0.85, 1); g.fillRect(0, 0, size, size);
  // layered blobby clusters, dark-to-light, so the crown reads as many small leaves catching light unevenly
  for (const [n, rad, k, a] of [[90, 0.16, 0.55, 0.55], [140, 0.1, 0.7, 0.55], [160, 0.06, 1.25, 0.5], [70, 0.045, 1.5, 0.4]]) {
    for (let i = 0; i < n; i++) {
      const x = R() * size, y = R() * size, rr = (0.4 + R() * 0.6) * rad * size;
      g.fillStyle = tone(k, a); g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill();
    }
  }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 3); t.updateMatrix();   // a few repeats per crown so clusters stay leaf-sized, not one giant blotch
  return t;
}

/* ---------------- building facades ----------------
 * Procedural facades by building type (from OpenStreetMap tags): glazed curtain wall, banded office,
 * residential with balconies, retail with a shopfront, open car-park decks, and punched masonry.
 * Each style is a tile in real metres with a matching "some windows lit" emissive map.
 * Canvas row 0 is the BOTTOM of the tile (ground level), see the offset below. */
export function makeFacadeStyles() {
  const S = {};
  const mk = () => { const c = document.createElement("canvas"); c.width = c.height = 512; return c; };
  const defs = {
    //          tile W m, tile H m, draw(g, h, R)  (g = colour canvas ctx, h = emissive canvas ctx; both 512 x 512)
    curtain: { w: 12, h: 16, metal: 0.35, tints: [0x6f97ab, 0x4f7a8a, 0x7fa88f, 0x5b6e82], draw: (g, h, R) => {
      const cols = 8, rows = 4, bw = 512 / cols, bh = 512 / rows;
      g.fillStyle = "#586a74"; g.fillRect(0, 0, 512, 512); h.fillStyle = "#000"; h.fillRect(0, 0, 512, 512);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const x = c * bw, y = r * bh, gr = g.createLinearGradient(0, y, 0, y + bh);
        gr.addColorStop(0, "#9fb9c6"); gr.addColorStop(0.55, "#6f8a99"); gr.addColorStop(1, "#4a5f6b");
        g.fillStyle = gr; g.fillRect(x + 2, y + bh * 0.16, bw - 4, bh * 0.84 - 2);
        g.fillStyle = "#aeb4b8"; g.fillRect(x, y, bw, bh * 0.16);                      // spandrel / slab edge
        if (R() < 0.42) { h.fillStyle = R() < 0.3 ? "#ffe2ae" : "#ffc46e"; h.fillRect(x + 2, y + bh * 0.2, bw - 4, bh * 0.7); }
      } } },
    banded: { w: 24, h: 15.2, metal: 0.1, tints: [0xb8825a, 0x8c8c86, 0xa66b4a, 0x7d8a92], draw: (g, h, R) => {
      const cols = 8, rows = 4, bw = 512 / cols, bh = 512 / rows;
      g.fillStyle = "#d8d4cb"; g.fillRect(0, 0, 512, 512); h.fillStyle = "#000"; h.fillRect(0, 0, 512, 512);
      for (let r = 0; r < rows; r++) {
        const y = r * bh; g.fillStyle = "#3a4550"; g.fillRect(0, y + bh * 0.22, 512, bh * 0.5);   // ribbon glazing
        for (let c = 0; c < cols; c++) { g.fillStyle = "#9aa0a4"; g.fillRect(c * bw, y + bh * 0.22, 3, bh * 0.5); }   // mullions
        g.fillStyle = "rgba(0,0,0,0.16)"; g.fillRect(0, y + bh * 0.72, 512, bh * 0.08);            // shadow under the band
        for (let c = 0; c < cols; c++) if (R() < 0.4) { h.fillStyle = "#ffcf85"; h.fillRect(c * bw + 3, y + bh * 0.24, bw - 4, bh * 0.46); }
      } } },
    resi: { w: 27.2, h: 24, metal: 0.05, tints: [0xc99a6c, 0x9a4f3f, 0x707a76, 0x5e5850], draw: (g, h, R) => {
      const cols = 8, rows = 8, bw = 512 / cols, bh = 512 / rows;
      g.fillStyle = "#e0dcd2"; g.fillRect(0, 0, 512, 512); h.fillStyle = "#000"; h.fillRect(0, 0, 512, 512);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const x = c * bw, y = r * bh;
        g.fillStyle = "#3d4650"; g.fillRect(x + bw * 0.2, y + bh * 0.16, bw * 0.6, bh * 0.66);                 // window
        g.fillStyle = "#b9b4a9"; g.fillRect(x + bw * 0.08, y + bh * 0.82, bw * 0.84, bh * 0.08);               // balcony slab
        g.fillStyle = "rgba(60,60,60,0.55)"; g.fillRect(x + bw * 0.08, y + bh * 0.62, bw * 0.84, bh * 0.2);    // balustrade
        if (R() < 0.36) { h.fillStyle = "#ffd493"; h.fillRect(x + bw * 0.2, y + bh * 0.16, bw * 0.6, bh * 0.66); }
      } } },
    retail: { w: 24, h: 7.8, metal: 0.1, tints: [0xa8693f, 0x8f9296, 0x6b5745, 0xbf9a5a], draw: (g, h, R) => {
      // row 0 (bottom of the tile) = 4.2 m shopfront, then a 3.6 m punched-window storey
      const sf = 512 * 4.2 / 7.8;
      g.fillStyle = "#d3c8b6"; g.fillRect(0, 0, 512, 512); h.fillStyle = "#000"; h.fillRect(0, 0, 512, 512);
      g.fillStyle = "#3f4b53"; g.fillRect(0, 512 * 0.06, 512, sf * 0.72);                                        // glazed shopfront
      for (let c = 0; c < 6; c++) { g.fillStyle = "#8e8a80"; g.fillRect(c * 512 / 6, 512 * 0.06, 4, sf * 0.72); }
      g.fillStyle = "#7d7a72"; g.fillRect(0, sf * 0.82, 512, sf * 0.09);                                        // fascia
      for (let c = 0; c < 6; c++) {
        const x = c * 512 / 6; g.fillStyle = "#454f58"; g.fillRect(x + 512 / 6 * 0.2, sf + (512 - sf) * 0.2, 512 / 6 * 0.6, (512 - sf) * 0.55);
        if (R() < 0.5) { h.fillStyle = "#ffcf85"; h.fillRect(x + 512 / 6 * 0.2, sf + (512 - sf) * 0.2, 512 / 6 * 0.6, (512 - sf) * 0.55); }
        if (R() < 0.6) { h.fillStyle = "#ffe0a8"; h.fillRect(x + 4, 512 * 0.08, 512 / 6 - 8, sf * 0.66); }
      } } },
    deck: { w: 36, h: 19.2, metal: 0.1, tints: [0x8f8d86, 0x76746e, 0x9c988e], draw: (g, h, R) => {
      const rows = 6, bh = 512 / rows;
      g.fillStyle = "#c4c1b8"; g.fillRect(0, 0, 512, 512); h.fillStyle = "#000"; h.fillRect(0, 0, 512, 512);
      for (let r = 0; r < rows; r++) {
        const y = r * bh; g.fillStyle = "#26282a"; g.fillRect(0, y + bh * 0.24, 512, bh * 0.66);                 // open deck
        for (let c = 0; c < 6; c++) { g.fillStyle = "#b5b2a9"; g.fillRect(c * 512 / 6, y + bh * 0.24, 10, bh * 0.66); }   // columns
        g.fillStyle = "#9c998f"; g.fillRect(0, y + bh * 0.9, 512, bh * 0.1);                                       // slab edge
        h.fillStyle = "#c9b27a"; h.fillRect(0, y + bh * 0.3, 512, bh * 0.05);                                       // strip lighting
      } } },
    masonry: { w: 32, h: 24, metal: 0.05, tints: [0xb08b5a, 0x9a5a42, 0x7a8078, 0xceb887], draw: (g, h, R) => {
      const cols = 8, rows = 6, bw = 512 / cols, bh = 512 / rows;
      g.fillStyle = "#d4c9b6"; g.fillRect(0, 0, 512, 512); h.fillStyle = "#000"; h.fillRect(0, 0, 512, 512);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const x = c * bw, y = r * bh;
        g.fillStyle = "#39434c"; g.fillRect(x + bw * 0.3, y + bh * 0.14, bw * 0.4, bh * 0.62);
        g.fillStyle = "#a89f8f"; g.fillRect(x + bw * 0.26, y + bh * 0.76, bw * 0.48, bh * 0.05);                // sill
        if (R() < 0.3) { h.fillStyle = "#ffd08a"; h.fillRect(x + bw * 0.3, y + bh * 0.14, bw * 0.4, bh * 0.62); }
      } } },
  };
  for (const [name, d] of Object.entries(defs)) {
    const a = mk(), b = mk(); d.draw(a.getContext("2d"), b.getContext("2d"), rnd(3 + name.length * 17));
    const tex = c => { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
      t.repeat.set(1 / d.w, 1 / d.h); t.offset.set(0, 1 - 1 / d.h); t.updateMatrix(); return t; };   // canvas row 0 sits at ground level; matrix baked for the path tracer
    S[name] = { map: tex(a), emissiveMap: tex(b), metal: d.metal, tints: d.tints };
  }
  return S;
}
/** Parses a CSS colour string (as OpenStreetMap's building:colour/roof:colour tags use — named colours like
 * "red" or hex like "#a33") into a 0xRRGGBB number, via an offscreen canvas so the browser's own CSS colour
 * parsing does the work. Returns null for anything it can't resolve, rather than guessing. */
export function cssColorToHex(str) {
  if (!str) return null;
  try {
    const c = document.createElement("canvas").getContext("2d");
    c.fillStyle = "#000"; c.fillStyle = str;                 // stays "#000" if the browser rejected the string
    const m = /^#([0-9a-f]{6})$/i.exec(c.fillStyle);
    return m ? parseInt(m[1], 16) : null;
  } catch { return null; }
}
/** The tint in a facade style's palette that's the closest real-RGB match to a building's own satellite-
 * sampled colour (traceFromPixels' `color`), so a neighbouring building's walls read as related to what
 * the actual photo shows for that building instead of an arbitrary, unrelated pick. */
export function nearestTint(color, tints) {
  const cr = (color >> 16) & 255, cg = (color >> 8) & 255, cb = color & 255;
  let best = 0, bestD = Infinity;
  tints.forEach((t, i) => {
    const r = (t >> 16) & 255, g = (t >> 8) & 255, b = t & 255;
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}
/** Which facade a building gets, from its OpenStreetMap type and height (nothing else is known about it). */
export function facadeStyleFor(kind, heightM, levels) {
  const k = String(kind || "").toLowerCase();
  if (k === "parking" || k === "garages") return "deck";
  if (["apartments", "residential", "dormitory", "hotel", "house", "terrace"].includes(k)) return "resi";
  if (["retail", "shop", "supermarket", "kiosk"].includes(k)) return "retail";
  if (["university", "government", "civic", "public", "school", "college", "hospital", "church", "museum"].includes(k)) return "masonry";
  if (["office", "commercial", "industrial"].includes(k)) return (levels || heightM / 3.5) >= 8 ? "curtain" : "banded";
  return heightM >= 26 ? "curtain" : heightM < 9 ? "masonry" : "banded";       // untyped: by height only
}


/* ---------------- sky ----------------
 * An equirectangular sky painted from the sun's real position: a gradient from a deep zenith to a pale (or
 * warm, at dusk) horizon, a sun glow, soft cumulus lit from the sun's side, and stars at night. It is both the
 * background and the light the path tracer bounces off, so cloud and colour shape the whole scene's lighting. */
function hash2(x, y) { const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return h - Math.floor(h); }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return hash2(xi, yi) * (1 - u) * (1 - v) + hash2(xi + 1, yi) * u * (1 - v) + hash2(xi, yi + 1) * (1 - u) * v + hash2(xi + 1, yi + 1) * u * v;
}
function fbm(x, y) { let a = 0.5, f = 1, t = 0; for (let o = 0; o < 5; o++) { t += a * vnoise(x * f, y * f); f *= 2.03; a *= 0.5; x += 17.3; y += 9.1; } return t; }
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function skyPalette(elevDeg) {
  const day = smooth(-6, 14, elevDeg), dusk = Math.max(0, 1 - Math.abs(elevDeg - 2) / 11);
  const zen = mix3(mix3([0.03, 0.05, 0.11], [0.16, 0.34, 0.68], day), [0.10, 0.17, 0.36], dusk * 0.6);
  const hor = mix3(mix3([0.06, 0.09, 0.16], [0.68, 0.78, 0.88], day), [1.0, 0.55, 0.26], dusk * 0.85);
  return { day, dusk, zen, hor };
}
/** The painted sky's colour right at the horizon (away from the sun), as 0..1 sRGB — exactly the pixel value
 * makeSkyCanvas writes there, so distance fog set to it blends the far ground into the sky with no seam. */
export function skyHorizonColour(elevDeg, weather = {}) {
  const haze = Math.min(1, Math.max(0, weather.haze || 0)), { hor } = skyPalette(elevDeg);
  const c = haze > 0 ? mix3(hor, [hor[0] * 0.95 + 0.05, hor[1] * 0.95 + 0.05, hor[2] * 0.95 + 0.06], haze) : hor;
  return c.map(v => Math.min(1, Math.max(0, Math.pow(v, 1 / 2.2))));
}
export function makeSkyCanvas(sunDir, elevDeg, weather = {}, W = 1024, H = 512) {
  const cover = Math.min(1, Math.max(0, weather.cover == null ? 0.3 : weather.cover)), haze = Math.min(1, Math.max(0, weather.haze || 0));
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const g = cv.getContext("2d"), img = g.createImageData(W, H), d = img.data;
  const { day, dusk, zen, hor } = skyPalette(elevDeg);
  const nightAmt = 1 - smooth(-12, -2, elevDeg);
  const sunCol = mix3([1.0, 0.98, 0.94], [1.0, 0.55, 0.25], smooth(28, 0, elevDeg));
  const sx = sunDir.x, sy = sunDir.y, sz = sunDir.z;
  for (let y = 0; y < H; y++) {
    const th = (0.5 - (y + 0.5) / H) * Math.PI, st = Math.sin(th), ct = Math.cos(th);
    for (let x = 0; x < W; x++) {
      const ph = ((x + 0.5) / W - 0.5) * 2 * Math.PI, dx = ct * Math.cos(ph), dz = ct * Math.sin(ph), dy = st;
      const cosg = dx * sx + dy * sy + dz * sz;
      let c;
      if (dy >= 0) {
        c = mix3(hor, zen, Math.pow(Math.min(1, dy), 0.42));
        const veil = 1 - 0.9 * cover;                                                                            // cloud hides the sun
        const glow = (Math.exp((cosg - 1) * 42) * 1.3 + Math.exp((cosg - 1) * 7) * 0.3 * day) * veil;           // disc and halo
        const band = Math.exp((cosg - 1) * 2.6) * Math.exp(-dy * 7) * dusk * (1 - 0.6 * cover);                 // sunset horizon band
        c = [c[0] + sunCol[0] * (glow + band * 0.9), c[1] + sunCol[1] * (glow + band * 0.5), c[2] + sunCol[2] * (glow + band * 0.25)];
        if (day > 0.05 && dy > 0.02) {                                                                           // cumulus on a plane overhead
          const k = 1.9 / (dy + 0.16), n = fbm(dx * k * 0.8 + 3.1, dz * k * 0.8 - 1.7), t0 = 0.80 - 0.34 * cover, dens = smooth(t0, t0 + 0.17, n) * smooth(0.02, 0.2, dy);
          if (dens > 0) {
            const lit = 0.62 + 0.38 * Math.max(0, cosg) + 0.25 * Math.pow(Math.max(0, cosg), 8);
            const shade = 0.55 + 0.45 * smooth(0.5, 0.78, n);
            const cc = [(0.93 * shade * lit) * (0.85 + 0.15 * sunCol[0]) + hor[0] * 0.12, (0.94 * shade * lit) * (0.8 + 0.2 * sunCol[1]) + hor[1] * 0.1, (0.97 * shade * lit) * (0.75 + 0.25 * sunCol[2]) + hor[2] * 0.08];
            c = mix3(c, cc, dens * Math.min(1, day * 1.4));
          }
        }
        if (cover > 0.7 && day > 0.05) {                                                                         // a continuous grey deck
          const deck = smooth(0.7, 1, cover) * 0.78 * smooth(0, 0.08, dy), gr = [0.50 * (0.35 + 0.65 * day), 0.53 * (0.35 + 0.65 * day), 0.57 * (0.35 + 0.65 * day)];
          c = mix3(c, gr, deck);
        }
        if (haze > 0) c = mix3(c, [hor[0] * 0.95 + 0.05, hor[1] * 0.95 + 0.05, hor[2] * 0.95 + 0.06], haze * Math.exp(-dy * 3.2));   // fog / haze thickest at the horizon
        if (nightAmt > 0.2 && dy > 0.03 && cover < 0.6) { const s = hash2(Math.floor(x / 2), Math.floor(y / 2)); if (s > 0.9965) { const b = (s - 0.9965) / 0.0035 * nightAmt; c = [c[0] + b * 0.8, c[1] + b * 0.8, c[2] + b * 0.9]; } }
      } else {
        c = mix3(hor, [hor[0] * 0.55, hor[1] * 0.55, hor[2] * 0.6], Math.min(1, -dy * 3));                       // below the horizon: hazy ground colour
      }
      const i = (y * W + x) * 4;
      d[i] = Math.min(255, Math.max(0, Math.pow(c[0], 1 / 2.2) * 255)); d[i + 1] = Math.min(255, Math.max(0, Math.pow(c[1], 1 / 2.2) * 255)); d[i + 2] = Math.min(255, Math.max(0, Math.pow(c[2], 1 / 2.2) * 255)); d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return cv;
}


/* ---------------- OpenStreetMap footprints ----------------
 * Worldwide building outlines (metres east / south of the site) with their heights and types. Roof colour is the
 * average of the satellite image inside each outline. This is the primary source for the surroundings, because
 * Apple's map fills buildings in different colours in different countries, so tracing its pixels only works in some. */
export async function osmFootprints(osm, satDataUrl, satSpanM) {
  let sat = null, W = 0, Hh = 0;
  if (satDataUrl) { try { const im = await loadImg(satDataUrl); const c = document.createElement("canvas"); c.width = W = im.naturalWidth; c.height = Hh = im.naturalHeight; const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(im, 0, 0); sat = g.getImageData(0, 0, W, Hh).data; } catch {} }
  const inside = (x, z, pts) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, zi] = pts[i], [xj, zj] = pts[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; };
  const out = [];
  for (const o of osm || []) {
    const pts = o.pts.slice(); if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
    if (pts.length < 3) continue;
    let ar = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) ar += (pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]);
    const area = Math.abs(ar) / 2; if (area < 12) continue;
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    let col = 0xb4b0a6;
    if (sat) {
      let r = 0, gg = 0, b = 0, n = 0; const step = Math.max(2, Math.sqrt(area / 40));
      for (let x = x0 + step / 2; x < x1; x += step) for (let z = z0 + step / 2; z < z1; z += step) {
        if (!inside(x, z, pts)) continue;
        const px = Math.round((x / satSpanM + 0.5) * W), pz = Math.round((z / satSpanM + 0.5) * Hh);
        if (px < 0 || pz < 0 || px >= W || pz >= Hh) continue;
        const k = (pz * W + px) * 4; r += sat[k]; gg += sat[k + 1]; b += sat[k + 2]; n++;
      }
      // Same shadow/tile-gap guard as traceFromPixels(): a near-black average is a sampling artifact,
      // not a real roof colour, and was producing the same "black geometric shapes" on OSM-sourced neighbours.
      if (n) { const rr = r / n | 0, gg2 = gg / n | 0, bb = b / n | 0; if (rr + gg2 + bb > 60) col = (rr << 16) | (gg2 << 8) | bb; }
    }
    const holes = (o.holes || []).map(r => { const q = r.slice(); if (q.length > 1 && q[0][0] === q[q.length - 1][0] && q[0][1] === q[q.length - 1][1]) q.pop(); return q; }).filter(r => r.length >= 3);
    out.push({ pts, holes, area, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, color: col, h: o.h, minH: o.minH || 0, part: !!o.part, kind: o.kind, levels: o.levels, name: o.name,
      wallColour: o.wallColour || null, roofColour: o.roofColour || null, fromOsm: true });
  }
  return out;
}

/* ---------------- COLLADA export ----------------
 * A minimal, dependency-free .dae writer for a THREE.Group (three.js ships no COLLADA exporter, only a
 * loader). Used to save edits made in the app back to a real, independently-openable model file.
 * Always writes a NEW file — callers never overwrite the model that was imported. Geometry and base colour
 * round-trip faithfully; texture maps do not (COLLADA can carry them, but re-deriving clean UVs for a
 * writer this small is out of scope, so a flat colour per material is used instead — the caller should say
 * so to the person saving). */
/* ---------------- section cutting ----------------
 * Clips a Group's meshes against a single plane (world space) for a photoreal section-cut render — the path
 * tracer has no clipping-plane support of its own (unlike the raster preview, which uses the real
 * WebGLRenderer clippingPlanes), so this actually removes and re-triangulates geometry on the far side.
 * The result is a NEW group of plain meshes with the same materials; the original model is never touched.
 * Known limitation: the cut face is left open (no solid poché fill) — a true capped section is future work. */
function clipTriSoup(positions, normals, plane) {
  const outPos = [], outNor = [];
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const n = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const triCount = positions.length / 9;
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const i = (t * 3 + k) * 3;
      v[k].set(positions[i], positions[i + 1], positions[i + 2]);
      n[k].set(normals[i], normals[i + 1], normals[i + 2]);
    }
    const d = v.map(p => plane.distanceToPoint(p));
    const inside = d.filter(x => x >= 0).length;
    if (inside === 3) { for (let k = 0; k < 3; k++) { outPos.push(v[k].x, v[k].y, v[k].z); outNor.push(n[k].x, n[k].y, n[k].z); } continue; }
    if (inside === 0) continue;
    const poly = [];
    for (let k = 0; k < 3; k++) {
      const a = k, b = (k + 1) % 3, da = d[a], db = d[b];
      if (da >= 0) poly.push({ p: v[a].clone(), n: n[a].clone() });
      if ((da >= 0) !== (db >= 0)) { const tt = da / (da - db); poly.push({ p: v[a].clone().lerp(v[b], tt), n: n[a].clone().lerp(n[b], tt).normalize() }); }
    }
    for (let k = 1; k < poly.length - 1; k++) {
      outPos.push(poly[0].p.x, poly[0].p.y, poly[0].p.z, poly[k].p.x, poly[k].p.y, poly[k].p.z, poly[k + 1].p.x, poly[k + 1].p.y, poly[k + 1].p.z);
      outNor.push(poly[0].n.x, poly[0].n.y, poly[0].n.z, poly[k].n.x, poly[k].n.y, poly[k].n.z, poly[k + 1].n.x, poly[k + 1].n.y, poly[k + 1].n.z);
    }
  }
  return outPos.length ? { positions: new Float32Array(outPos), normals: new Float32Array(outNor) } : null;
}
export function buildSectionCut(modelRoot, plane) {
  const out = new THREE.Group(); out.name = "sectionCut";
  modelRoot.updateMatrixWorld(true);
  modelRoot.traverse(n => {
    if (!n.isMesh || !n.visible || !n.geometry || !n.geometry.attributes.position) return;
    const g = n.geometry.index ? n.geometry.toNonIndexed() : n.geometry;
    const P = g.attributes.position, N = g.attributes.normal || (g.computeVertexNormals(), g.attributes.normal);
    const wp = new Float32Array(P.count * 3), wn = new Float32Array(P.count * 3), v = new THREE.Vector3(), nm = new THREE.Matrix3().getNormalMatrix(n.matrixWorld);
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(n.matrixWorld); wp[i * 3] = v.x; wp[i * 3 + 1] = v.y; wp[i * 3 + 2] = v.z;
      v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); wn[i * 3] = v.x; wn[i * 3 + 1] = v.y; wn[i * 3 + 2] = v.z;
    }
    const clipped = clipTriSoup(wp, wn, plane);
    if (!clipped) return;
    const cg = new THREE.BufferGeometry();
    cg.setAttribute("position", new THREE.BufferAttribute(clipped.positions, 3));
    cg.setAttribute("normal", new THREE.BufferAttribute(clipped.normals, 3));
    const mat = Array.isArray(n.material) ? n.material[0] : n.material;
    out.add(new THREE.Mesh(cg, mat));
  });
  return out;
}

export function exportCollada(modelRoot) {
  const geoms = [], mats = new Map();     // material identity -> { id, color, rough, metal }
  let gi = 0;
  modelRoot.updateMatrixWorld(true);
  modelRoot.traverse(n => {
    if (!n.isMesh || !n.geometry || !n.geometry.attributes.position) return;
    const g = n.geometry.index ? n.geometry.toNonIndexed() : n.geometry;
    const P = g.attributes.position, N = g.attributes.normal || (g.computeVertexNormals(), g.attributes.normal);
    const srcMats = Array.isArray(n.material) ? n.material : [n.material];
    const groups = g.groups && g.groups.length ? g.groups : [{ start: 0, count: P.count, materialIndex: 0 }];
    for (const grp of groups) {
      const m = srcMats[grp.materialIndex] || srcMats[0]; if (!m) continue;
      let mid = mats.get(m);
      if (!mid) {
        const c = m.color ? m.color.getHexString() : "cccccc";
        mid = { id: "mat" + mats.size, name: m.name || "", color: c, rough: m.roughness != null ? m.roughness : 0.8, metal: m.metalness != null ? m.metalness : 0.0,
          opacity: m.transparent && m.opacity < 1 ? m.opacity : 1 };
        mats.set(m, mid);
      }
      const pos = [], nor = [], v = new THREE.Vector3(), nv = new THREE.Vector3(), nm = new THREE.Matrix3().getNormalMatrix(n.matrixWorld);
      for (let i = grp.start; i < grp.start + grp.count; i++) {
        v.fromBufferAttribute(P, i).applyMatrix4(n.matrixWorld); pos.push(v.x, v.y, v.z);
        nv.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); nor.push(nv.x, nv.y, nv.z);
      }
      geoms.push({ id: "geo" + gi++, name: n.name || "Surface", matId: mid.id, pos, nor });
    }
  });
  const esc = s => String(s || "").replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  const effects = [...mats.values()].map(m => `    <effect id="${m.id}-effect"><profile_COMMON><technique sid="common"><phong>
      <diffuse><color>${parseInt(m.color.slice(0,2),16)/255} ${parseInt(m.color.slice(2,4),16)/255} ${parseInt(m.color.slice(4,6),16)/255} 1</color></diffuse>
      <specular><color>${m.metal} ${m.metal} ${m.metal} 1</color></specular><shininess><float>${(1 - m.rough) * 128}</float></shininess>${m.opacity < 1 ? `
      <transparent opaque="A_ONE"><color>1 1 1 1</color></transparent><transparency><float>${m.opacity}</float></transparency>` : ""}
    </phong></technique></profile_COMMON></effect>`).join("\n");
  const materials = [...mats.values()].map(m => `    <material id="${m.id}" name="${esc(m.name || m.id)}"><instance_effect url="#${m.id}-effect"/></material>`).join("\n");
  const geometries = geoms.map(gm => {
    const n = gm.pos.length / 3, idx = Array.from({ length: n }, (_, k) => `${k} ${k}`).join(" ");
    return `    <geometry id="${gm.id}" name="${esc(gm.name)}"><mesh>
      <source id="${gm.id}-pos"><float_array id="${gm.id}-pos-array" count="${gm.pos.length}">${gm.pos.map(v => v.toFixed(5)).join(" ")}</float_array>
        <technique_common><accessor source="#${gm.id}-pos-array" count="${n}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
      <source id="${gm.id}-nor"><float_array id="${gm.id}-nor-array" count="${gm.nor.length}">${gm.nor.map(v => v.toFixed(5)).join(" ")}</float_array>
        <technique_common><accessor source="#${gm.id}-nor-array" count="${n}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
      <vertices id="${gm.id}-verts"><input semantic="POSITION" source="#${gm.id}-pos"/></vertices>
      <triangles material="${gm.matId}Symbol" count="${n / 3}"><input semantic="VERTEX" source="#${gm.id}-verts" offset="0"/><input semantic="NORMAL" source="#${gm.id}-nor" offset="1"/><p>${idx}</p></triangles>
    </mesh></geometry>`;
  }).join("\n");
  const nodes = geoms.map(gm => `      <node id="${gm.id}_node" name="${esc(gm.name)}"><instance_geometry url="#${gm.id}"><bind_material><technique_common>
        <instance_material symbol="${gm.matId}Symbol" target="#${gm.matId}"/></technique_common></bind_material></instance_geometry></node>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><created>${new Date().toISOString()}</created><modified>${new Date().toISOString()}</modified><unit name="meter" meter="1"/><up_axis>Y_UP</up_axis></asset>
  <library_effects>
${effects}
  </library_effects>
  <library_materials>
${materials}
  </library_materials>
  <library_geometries>
${geometries}
  </library_geometries>
  <library_visual_scenes><visual_scene id="Scene" name="Scene">
${nodes}
  </visual_scene></library_visual_scenes>
  <scene><instance_visual_scene url="#Scene"/></scene>
</COLLADA>
`;
}
