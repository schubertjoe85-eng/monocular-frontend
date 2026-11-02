// Synced from Monocular Desktop (src/modelspec.js). Keep the two in step.
// modelspec.js — the AI Model Builder's deterministic half (from the model-builder package, buildingGeometry.js)
// Deterministic half of the pipeline: BuildingSpec JSON -> validation report -> Collada (.dae).
// The AI never writes raw geometry; it writes a spec, this file turns the spec into a model.
// Units: metres. Axes: X east, Y north, Z up (DAE written as Z_UP, same as ArchiCAD).


// ---------------------------------------------------------------------------
// Default materials (names survive into ArchiCAD / SketchUp / Blender on import)
// ---------------------------------------------------------------------------
const DEFAULT_MATERIALS = {
  wall_external: { color: "#e9e6df" },
  wall_internal: { color: "#f4f2ee" },
  glass: { color: "#9fc3d6", opacity: 0.35 },
  frame: { color: "#3a3a3a" },
  door: { color: "#7a5a3c" },
  roof: { color: "#55595c" },
  slab: { color: "#bdbab3" },
  deck: { color: "#9b7653" },
  concrete: { color: "#b8b6b0" },
  pool_water: { color: "#4fa3c7", opacity: 0.7 },
  ground: { color: "#8a9a6b" },
};

// ---------------------------------------------------------------------------
// Small vector helpers
// ---------------------------------------------------------------------------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const num = (v, d) => (typeof v === "number" && isFinite(v) ? v : d);
const r4 = (n) => Math.round(n * 10000) / 10000;

// ---------------------------------------------------------------------------
// Mesh accumulator: triangles grouped by material
// ---------------------------------------------------------------------------
class MeshBuilder {
  constructor() { this.groups = new Map(); }
  tri(mat, a, b, c) {
    if (!this.groups.has(mat)) this.groups.set(mat, []);
    const n = cross(sub(b, a), sub(c, a));
    if (Math.hypot(n[0], n[1], n[2]) < 1e-10) return; // degenerate
    this.groups.get(mat).push([a, b, c]);
  }
  quad(mat, a, b, c, d) { this.tri(mat, a, b, c); this.tri(mat, a, c, d); }
  doubleQuad(mat, a, b, c, d) { this.quad(mat, a, b, c, d); this.quad(mat, a, d, c, b); }
  doubleTri(mat, a, b, c) { this.tri(mat, a, b, c); this.tri(mat, a, c, b); }

  // Box from a corner function P(i,j,k), i,j,k in {0,1}. Winding is forced outward.
  box(mat, P) {
    const C = [0, 1].flatMap((i) => [0, 1].flatMap((j) => [0, 1].map((k) => P(i, j, k))));
    const at = (i, j, k) => C[i * 4 + j * 2 + k];
    const centre = C.reduce((s, p) => [s[0] + p[0] / 8, s[1] + p[1] / 8, s[2] + p[2] / 8], [0, 0, 0]);
    const faces = [
      [at(0, 0, 0), at(0, 1, 0), at(0, 1, 1), at(0, 0, 1)],
      [at(1, 0, 0), at(1, 0, 1), at(1, 1, 1), at(1, 1, 0)],
      [at(0, 0, 0), at(0, 0, 1), at(1, 0, 1), at(1, 0, 0)],
      [at(0, 1, 0), at(1, 1, 0), at(1, 1, 1), at(0, 1, 1)],
      [at(0, 0, 0), at(1, 0, 0), at(1, 1, 0), at(0, 1, 0)],
      [at(0, 0, 1), at(0, 1, 1), at(1, 1, 1), at(1, 0, 1)],
    ];
    for (let [a, b, c, d] of faces) {
      const fc = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2];
      const n = cross(sub(b, a), sub(c, a));
      if (dot(n, sub(fc, centre)) < 0) [b, d] = [d, b];
      this.quad(mat, a, b, c, d);
    }
  }
  triangleCount() { let n = 0; for (const t of this.groups.values()) n += t.length; return n; }
}

// ---------------------------------------------------------------------------
// Polygon helpers (slabs)
// ---------------------------------------------------------------------------
function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

// Ear clipping for simple polygons (CCW). Good enough for slab outlines.
function triangulate(poly) {
  const idx = poly.map((_, i) => i);
  const out = [];
  const isConvex = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 1e-12;
  const inTri = (p, a, b, c) => {
    const s = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
    const d1 = s(p, a, b), d2 = s(p, b, c), d3 = s(p, c, a);
    const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = poly[ia], b = poly[ib], c = poly[ic];
      if (!isConvex(a, b, c)) continue;
      let ok = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (inTri(poly[j], a, b, c)) { ok = false; break; }
      }
      if (!ok) continue;
      out.push([ia, ib, ic]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // self-intersecting outline; give up on the remainder
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  return out;
}

function prism(mesh, mat, outline, zBottom, zTop) {
  let poly = outline.map((p) => [num(p[0], 0), num(p[1], 0)]);
  if (signedArea(poly) < 0) poly = poly.slice().reverse();
  for (const [a, b, c] of triangulate(poly)) {
    mesh.tri(mat, [...poly[a], zTop], [...poly[b], zTop], [...poly[c], zTop]);
    mesh.tri(mat, [...poly[a], zBottom], [...poly[c], zBottom], [...poly[b], zBottom]);
  }
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    mesh.quad(mat, [p[0], p[1], zBottom], [q[0], q[1], zBottom], [q[0], q[1], zTop], [p[0], p[1], zTop]);
  }
}

// ---------------------------------------------------------------------------
// Spec normalisation (defaults, level lookup, endpoint snapping)
// ---------------------------------------------------------------------------
function normaliseSpec(input) {
  const spec = JSON.parse(JSON.stringify(input || {}));
  spec.units = "m";
  spec.levels = Array.isArray(spec.levels) && spec.levels.length ? spec.levels : [{ id: "L0", name: "Ground", elevation: 0, height: 2.7 }];
  spec.levels.forEach((l, i) => { l.id = l.id || `L${i}`; l.elevation = num(l.elevation, 0); l.height = num(l.height, 2.7); });
  spec.walls = Array.isArray(spec.walls) ? spec.walls : [];
  spec.slabs = Array.isArray(spec.slabs) ? spec.slabs : [];
  spec.roofs = Array.isArray(spec.roofs) ? spec.roofs : [];
  spec.blocks = Array.isArray(spec.blocks) ? spec.blocks : [];
  spec.assumptions = Array.isArray(spec.assumptions) ? spec.assumptions : [];
  spec.walls.forEach((w, i) => {
    w.id = w.id || `W${i + 1}`;
    w.level = w.level || spec.levels[0].id;
    w.thickness = num(w.thickness, 0.25);
    w.material = w.material || "wall_external";
    w.openings = Array.isArray(w.openings) ? w.openings : [];
    w.openings.forEach((o, j) => {
      o.id = o.id || `${w.id}-O${j + 1}`;
      o.type = o.type === "door" ? "door" : o.type === "opening" ? "opening" : "window";
      o.width = num(o.width, o.type === "door" ? 0.82 : 1.2);
      o.height = num(o.height, o.type === "door" ? 2.1 : 1.2);
      o.sill = num(o.sill, o.type === "window" ? 0.9 : 0);
      o.offset = num(o.offset, 0);
    });
  });
  return spec;
}

// Snap wall endpoints that are within `tol` of each other to a shared point.
function snapWallEnds(spec, tol = 0.15) {
  const ends = [];
  spec.walls.forEach((w) => { ends.push({ w, k: "start" }, { w, k: "end" }); });
  const used = new Set();
  for (let i = 0; i < ends.length; i++) {
    if (used.has(i)) continue;
    const cluster = [i];
    for (let j = i + 1; j < ends.length; j++) {
      if (used.has(j) || ends[j].w === ends[i].w) continue;
      if (dist2(ends[i].w[ends[i].k], ends[j].w[ends[j].k]) <= tol) cluster.push(j);
    }
    if (cluster.length < 2) continue;
    const avg = [0, 0];
    cluster.forEach((c) => { const p = ends[c].w[ends[c].k]; avg[0] += p[0] / cluster.length; avg[1] += p[1] / cluster.length; });
    cluster.forEach((c) => { ends[c].w[ends[c].k] = [r4(avg[0]), r4(avg[1])]; used.add(c); });
  }
  return spec;
}

const levelOf = (spec, id) => spec.levels.find((l) => l.id === id) || spec.levels[0];
const wallHeight = (spec, w) => num(w.height, levelOf(spec, w.level).height);
const wallLen = (w) => dist2(w.start, w.end);

// ---------------------------------------------------------------------------
// Validation — the deterministic "checking architect"
// ---------------------------------------------------------------------------
function validateSpec(rawSpec) {
  const errors = [], warnings = [];
  const E = (id, msg) => errors.push({ id, msg });
  const Wn = (id, msg) => warnings.push({ id, msg });
  const spec = normaliseSpec(rawSpec);

  const ids = new Set();
  spec.levels.forEach((l) => { if (ids.has(l.id)) E(l.id, "Duplicate level id"); ids.add(l.id); });
  const sorted = spec.levels.slice().sort((a, b) => a.elevation - b.elevation);
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].elevation - sorted[i - 1].elevation;
    if (gap < sorted[i - 1].height - 0.05) Wn(sorted[i].id, `Level sits ${gap.toFixed(2)} m above ${sorted[i - 1].id}, less than that level's ${sorted[i - 1].height} m wall height`);
  }
  if (!spec.walls.length && !spec.blocks.length) E("spec", "No walls or blocks — nothing to build");

  for (const w of spec.walls) {
    const ok = Array.isArray(w.start) && Array.isArray(w.end) && w.start.length >= 2 && w.end.length >= 2;
    if (!ok) { E(w.id, "Wall needs start [x,y] and end [x,y]"); continue; }
    if (!spec.levels.some((l) => l.id === w.level)) E(w.id, `Wall references unknown level "${w.level}"`);
    const L = wallLen(w), H = wallHeight(spec, w);
    if (L < 0.05) { E(w.id, "Wall has zero length"); continue; }
    if (w.thickness < 0.05 || w.thickness > 0.6) Wn(w.id, `Unusual wall thickness ${w.thickness} m`);
    if (H < 1.8 || H > 8) Wn(w.id, `Unusual wall height ${H} m`);
    if (L > 60) Wn(w.id, `Very long wall (${L.toFixed(1)} m) — check scale`);
    const ops = w.openings.slice().sort((a, b) => a.offset - b.offset);
    ops.forEach((o, i) => {
      if (o.offset < 0) E(o.id, "Opening offset is negative");
      if (o.offset + o.width > L + 1e-3) E(o.id, `Opening runs past wall end (offset ${o.offset} + width ${o.width} > wall ${L.toFixed(2)} m)`);
      if (o.sill + o.height > H + 1e-3) E(o.id, `Opening head ${(o.sill + o.height).toFixed(2)} m is above wall height ${H} m`);
      if (o.width <= 0 || o.height <= 0) E(o.id, "Opening has no size");
      if (o.type === "door" && (o.height < 1.9 || o.height > 3.0)) Wn(o.id, `Door height ${o.height} m is outside 1.9–3.0 m`);
      if (o.type === "door" && o.sill > 0.05) Wn(o.id, `Door sill ${o.sill} m above floor`);
      if (o.type === "window" && o.sill < 0.0) E(o.id, "Window sill below floor");
      if (i > 0) {
        const p = ops[i - 1];
        if (p.offset + p.width > o.offset + 1e-3) E(o.id, `Overlaps opening ${p.id}`);
      }
    });
  }

  // Connectivity: free wall ends usually mean a misread plan.
  const tol = 0.05;
  const onSeg = (p, a, b, t) => {
    const ab = [b[0] - a[0], b[1] - a[1]], L2 = ab[0] ** 2 + ab[1] ** 2;
    if (!L2) return false;
    const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / L2));
    return Math.hypot(p[0] - a[0] - u * ab[0], p[1] - a[1] - u * ab[1]) <= t;
  };
  for (const w of spec.walls) {
    if (!Array.isArray(w.start) || !Array.isArray(w.end)) continue;
    for (const k of ["start", "end"]) {
      const p = w[k];
      const joined = spec.walls.some((o) => o !== w && o.level === w.level && Array.isArray(o.start) && Array.isArray(o.end) &&
        onSeg(p, o.start, o.end, Math.max(tol, o.thickness / 2 + tol)));
      if (!joined && !w.freeEnd) Wn(w.id, `Wall ${k} at [${p.map((v) => v.toFixed(2))}] does not meet another wall (set "freeEnd": true if intentional)`);
    }
  }

  for (const [i, s] of spec.slabs.entries()) {
    const id = s.id || `S${i + 1}`;
    if (!Array.isArray(s.outline) || s.outline.length < 3) { E(id, "Slab outline needs at least 3 points"); continue; }
    if (Math.abs(signedArea(s.outline)) < 0.5) E(id, "Slab outline has (almost) no area");
  }

  const allX = [], allY = [];
  spec.walls.forEach((w) => { if (Array.isArray(w.start)) { allX.push(w.start[0], w.end[0]); allY.push(w.start[1], w.end[1]); } });
  for (const [i, r] of spec.roofs.entries()) {
    const id = r.id || `R${i + 1}`;
    if (!["gable", "hip", "skillion", "flat"].includes(r.type)) E(id, `Unknown roof type "${r.type}" (use gable, hip, skillion or flat)`);
    const pitch = num(r.pitch, 22.5);
    if (r.type !== "flat" && (pitch <= 0 || pitch > 60)) E(id, `Roof pitch ${pitch}° out of range`);
    if (allX.length) {
      const rect = roofRect(spec, r);
      const wx0 = Math.min(...allX), wx1 = Math.max(...allX), wy0 = Math.min(...allY), wy1 = Math.max(...allY);
      if (rect.x0 > wx0 + 0.3 || rect.x1 < wx1 - 0.3 || rect.y0 > wy0 + 0.3 || rect.y1 < wy1 - 0.3)
        Wn(id, "Roof footprint does not cover all walls");
    }
  }

  const span = allX.length ? Math.max(Math.max(...allX) - Math.min(...allX), Math.max(...allY) - Math.min(...allY)) : 0;
  if (allX.length && span < 1.5) Wn("spec", `Whole building is only ${span.toFixed(2)} m across — probably read in the wrong units`);
  if (span > 200) Wn("spec", `Building is ${span.toFixed(0)} m across — probably read in mm, not m`);

  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Geometry generation
// ---------------------------------------------------------------------------
function buildWall(mesh, spec, w) {
  const L = wallLen(w);
  if (L < 0.05) return;
  const lvl = levelOf(spec, w.level);
  const base = lvl.elevation + num(w.baseOffset, 0);
  const H = wallHeight(spec, w), t = w.thickness;
  const d = [(w.end[0] - w.start[0]) / L, (w.end[1] - w.start[1]) / L];
  const n = [-d[1], d[0]];
  const ext = w.extendEnds === false ? 0 : t / 2; // overlap at corners so joints close
  const P = (u, v, z) => [r4(w.start[0] + d[0] * u + n[0] * v), r4(w.start[1] + d[1] * u + n[1] * v), r4(base + z)];
  const piece = (mat, u0, u1, v0, v1, z0, z1) => {
    if (u1 - u0 < 1e-4 || z1 - z0 < 1e-4) return;
    mesh.box(mat, (i, j, k) => P(i ? u1 : u0, j ? v1 : v0, k ? z1 : z0));
  };
  const v0 = -t / 2, v1 = t / 2;
  const ops = w.openings.slice().sort((a, b) => a.offset - b.offset);
  let cursor = -ext;
  for (const o of ops) {
    const o0 = Math.max(0, o.offset), o1 = Math.min(L, o.offset + o.width);
    if (o1 <= o0) continue;
    const head = Math.min(H, o.sill + o.height);
    piece(w.material, cursor, o0, v0, v1, 0, H);
    piece(w.material, o0, o1, v0, v1, 0, o.sill);
    piece(w.material, o0, o1, v0, v1, head, H);
    const f = 0.05; // frame section
    if (o.type === "window") {
      piece("glass", o0 + f, o1 - f, -0.006, 0.006, o.sill + f, head - f);
      piece("frame", o0, o0 + f, -0.03, 0.03, o.sill, head);
      piece("frame", o1 - f, o1, -0.03, 0.03, o.sill, head);
      piece("frame", o0 + f, o1 - f, -0.03, 0.03, o.sill, o.sill + f);
      piece("frame", o0 + f, o1 - f, -0.03, 0.03, head - f, head);
    } else if (o.type === "door") {
      const glazed = /glaz|slid|stack|bifold|french/i.test(o.style || "");
      piece(glazed ? "glass" : "door", o0 + 0.02, o1 - 0.02, -0.02, 0.02, o.sill, head - 0.02);
      piece("frame", o0, o0 + 0.04, -0.04, 0.04, o.sill, head);
      piece("frame", o1 - 0.04, o1, -0.04, 0.04, o.sill, head);
      piece("frame", o0 + 0.04, o1 - 0.04, -0.04, 0.04, head - 0.04, head);
    }
    cursor = Math.max(cursor, o1);
  }
  piece(w.material, cursor, L + ext, v0, v1, 0, H);
}

function roofRect(spec, r) {
  let pts = Array.isArray(r.outline) && r.outline.length >= 3 ? r.outline : null;
  if (!pts) {
    pts = [];
    const lvl = r.level || null;
    spec.walls.filter((w) => !lvl || w.level === lvl).forEach((w) => {
      if (!Array.isArray(w.start)) return;
      const h = w.thickness / 2;
      pts.push([w.start[0] - h, w.start[1] - h], [w.end[0] + h, w.end[1] + h], [w.start[0] + h, w.start[1] + h], [w.end[0] - h, w.end[1] - h]);
    });
  }
  if (!pts.length) pts = [[0, 0], [1, 1]];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

function topPlate(spec) {
  let z = 0;
  spec.walls.forEach((w) => { z = Math.max(z, levelOf(spec, w.level).elevation + num(w.baseOffset, 0) + wallHeight(spec, w)); });
  return z || spec.levels[0].elevation + spec.levels[0].height;
}

function buildRoof(mesh, spec, r) {
  const inner = roofRect(spec, r);
  const oh = num(r.overhang, 0.45);
  const lv = r.level && spec.levels.find((l) => l.id === r.level);
  const base = num(r.baseElevation, lv ? lv.elevation + lv.height : topPlate(spec));
  const mat = r.material || "roof";
  const tan = Math.tan((num(r.pitch, 22.5) * Math.PI) / 180);
  const x0 = inner.x0 - oh, x1 = inner.x1 + oh, y0 = inner.y0 - oh, y1 = inner.y1 + oh;
  const T = num(r.thickness, 0.25);

  if (r.type === "flat") {
    const parapet = num(r.parapet, 0);
    prism(mesh, mat, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], base, base + T);
    if (parapet > 0) {
      const t = 0.2, z0 = base + T, z1 = z0 + parapet;
      prism(mesh, "wall_external", [[x0, y0], [x1, y0], [x1, y0 + t], [x0, y0 + t]], z0, z1);
      prism(mesh, "wall_external", [[x0, y1 - t], [x1, y1 - t], [x1, y1], [x0, y1]], z0, z1);
      prism(mesh, "wall_external", [[x0, y0 + t], [x0 + t, y0 + t], [x0 + t, y1 - t], [x0, y1 - t]], z0, z1);
      prism(mesh, "wall_external", [[x1 - t, y0 + t], [x1, y0 + t], [x1, y1 - t], [x1 - t, y1 - t]], z0, z1);
    }
    return;
  }

  // Work in a local frame where the ridge (or the skillion's level edge) runs along local X.
  const alongX = (r.ridgeAxis || (inner.x1 - inner.x0 >= inner.y1 - inner.y0 ? "x" : "y")) === "x";
  const toWorld = alongX ? (a, b, z) => [r4(a), r4(b), r4(z)] : (a, b, z) => [r4(b), r4(a), r4(z)];
  const A0 = alongX ? x0 : y0, A1 = alongX ? x1 : y1;   // along ridge
  const B0 = alongX ? y0 : x0, B1 = alongX ? y1 : x1;   // across ridge
  const iA0 = alongX ? inner.x0 : inner.y0, iA1 = alongX ? inner.x1 : inner.y1;
  const iB0 = alongX ? inner.y0 : inner.x0, iB1 = alongX ? inner.y1 : inner.x1;
  const eave = base - oh * tan;
  const fascia = (p, q) => { // vertical fascia band under an eave edge
    mesh.doubleQuad(mat, p, q, [q[0], q[1], q[2] - T], [p[0], p[1], p[2] - T]);
  };

  if (r.type === "skillion") {
    const high = r.highSide === "start" ? 0 : 1; // rises toward B1 by default
    const zAt = (b) => base + (high ? b - iB0 : iB1 - b) * tan;
    const p00 = toWorld(A0, B0, zAt(B0)), p10 = toWorld(A1, B0, zAt(B0));
    const p11 = toWorld(A1, B1, zAt(B1)), p01 = toWorld(A0, B1, zAt(B1));
    mesh.doubleQuad(mat, p00, p10, p11, p01);
    fascia(p00, p10); fascia(p01, p11);
    // infill the wall tops at the two raking ends
    for (const a of [iA0, iA1]) {
      mesh.doubleTri("wall_external", toWorld(a, iB0, base), toWorld(a, iB1, base), toWorld(a, high ? iB1 : iB0, zAt(high ? iB1 : iB0)));
    }
    return;
  }

  const Bm = (B0 + B1) / 2;
  const ridgeZ = base + ((iB1 - iB0) / 2) * tan;
  if (r.type === "gable") {
    const e0a = toWorld(A0, B0, eave), e0b = toWorld(A1, B0, eave);
    const e1a = toWorld(A0, B1, eave), e1b = toWorld(A1, B1, eave);
    const ra = toWorld(A0, Bm, ridgeZ), rb = toWorld(A1, Bm, ridgeZ);
    mesh.doubleQuad(mat, e0a, e0b, rb, ra);
    mesh.doubleQuad(mat, e1b, e1a, ra, rb);
    fascia(e0a, e0b); fascia(e1a, e1b);
    for (const a of [iA0, iA1]) { // gable-end infill walls
      mesh.doubleTri(r.gableMaterial || "wall_external", toWorld(a, iB0, base), toWorld(a, iB1, base), toWorld(a, Bm, ridgeZ));
    }
    return;
  }

  if (r.type === "hip") {
    const halfB = (B1 - B0) / 2;
    const ra = Math.min(A0 + halfB, (A0 + A1) / 2), rb = Math.max(A1 - halfB, (A0 + A1) / 2);
    const c00 = toWorld(A0, B0, eave), c10 = toWorld(A1, B0, eave), c11 = toWorld(A1, B1, eave), c01 = toWorld(A0, B1, eave);
    const R0 = toWorld(ra, Bm, ridgeZ), R1 = toWorld(rb, Bm, ridgeZ);
    mesh.doubleQuad(mat, c00, c10, R1, R0);
    mesh.doubleQuad(mat, c11, c01, R0, R1);
    mesh.doubleTri(mat, c01, c00, R0);
    mesh.doubleTri(mat, c10, c11, R1);
    fascia(c00, c10); fascia(c01, c11); fascia(c00, c01); fascia(c10, c11);
  }
}

function buildBlock(mesh, b) {
  const min = b.min || [0, 0, 0], max = b.max || [1, 1, 1];
  const rot = (num(b.rotation, 0) * Math.PI) / 180;
  const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2;
  const R = (x, y) => [r4(cx + (x - cx) * Math.cos(rot) - (y - cy) * Math.sin(rot)), r4(cy + (x - cx) * Math.sin(rot) + (y - cy) * Math.cos(rot))];
  mesh.box(b.material || "concrete", (i, j, k) => [...R(i ? max[0] : min[0], j ? max[1] : min[1]), k ? max[2] : min[2]]);
}

function buildMesh(rawSpec) {
  const spec = snapWallEnds(normaliseSpec(rawSpec));
  const mesh = new MeshBuilder();
  for (const s of spec.slabs) {
    if (!Array.isArray(s.outline) || s.outline.length < 3) continue;
    const top = num(s.elevation, levelOf(spec, s.level).elevation);
    prism(mesh, s.material || "slab", s.outline, top - num(s.thickness, 0.2), top);
  }
  for (const w of spec.walls) if (Array.isArray(w.start) && Array.isArray(w.end)) buildWall(mesh, spec, w);
  for (const r of spec.roofs) buildRoof(mesh, spec, r);
  for (const b of spec.blocks) buildBlock(mesh, b);
  return { mesh, spec };
}

// ---------------------------------------------------------------------------
// Collada writer
// ---------------------------------------------------------------------------
const xmlEsc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
const safeId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "_");
function hexToRgb(hex) {
  const h = String(hex || "#cccccc").replace("#", "");
  const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.padEnd(6, "c");
  return [0, 2, 4].map((i) => (parseInt(v.slice(i, i + 2), 16) || 0) / 255);
}

function meshToCollada(mesh, { materials = {}, name = "Monocular model" } = {}) {
  const mats = { ...DEFAULT_MATERIALS, ...materials };
  const now = new Date().toISOString();
  const effects = [], materialsXml = [], geoms = [], instances = [];
  for (const [matName, tris] of mesh.groups) {
    if (!tris.length) continue;
    const id = safeId(matName);
    const m = mats[matName] || { color: "#cccccc" };
    const [r, g, b] = hexToRgb(m.color);
    const op = num(m.opacity, 1);
    effects.push(`    <effect id="${id}-effect"><profile_COMMON><technique sid="common"><lambert>
      <diffuse><color sid="diffuse">${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)} 1</color></diffuse>${op < 1 ? `
      <transparent opaque="A_ONE"><color>1 1 1 ${op}</color></transparent><transparency><float>1</float></transparency>` : ""}
    </lambert></technique></profile_COMMON></effect>`);
    materialsXml.push(`    <material id="${id}-material" name="${xmlEsc(matName)}"><instance_effect url="#${id}-effect"/></material>`);
    const pos = [], nrm = [], p = [];
    tris.forEach((t, i) => {
      const n = norm(cross(sub(t[1], t[0]), sub(t[2], t[0])));
      t.forEach((v) => pos.push(v[0], v[1], v[2]));
      nrm.push(r4(n[0]), r4(n[1]), r4(n[2]));
      p.push(i * 3, i, i * 3 + 1, i, i * 3 + 2, i);
    });
    geoms.push(`    <geometry id="${id}-mesh" name="${xmlEsc(matName)}"><mesh>
      <source id="${id}-pos"><float_array id="${id}-pos-array" count="${pos.length}">${pos.join(" ")}</float_array>
        <technique_common><accessor source="#${id}-pos-array" count="${pos.length / 3}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
      <source id="${id}-nrm"><float_array id="${id}-nrm-array" count="${nrm.length}">${nrm.join(" ")}</float_array>
        <technique_common><accessor source="#${id}-nrm-array" count="${nrm.length / 3}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
      <vertices id="${id}-vtx"><input semantic="POSITION" source="#${id}-pos"/></vertices>
      <triangles material="${id}-sym" count="${tris.length}">
        <input semantic="VERTEX" source="#${id}-vtx" offset="0"/><input semantic="NORMAL" source="#${id}-nrm" offset="1"/>
        <p>${p.join(" ")}</p>
      </triangles>
    </mesh></geometry>`);
    instances.push(`      <node id="${id}-node" name="${xmlEsc(matName)}"><instance_geometry url="#${id}-mesh"><bind_material><technique_common>
        <instance_material symbol="${id}-sym" target="#${id}-material"/></technique_common></bind_material></instance_geometry></node>`);
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><contributor><authoring_tool>Monocular Model Builder</authoring_tool></contributor>
    <created>${now}</created><modified>${now}</modified><unit name="meter" meter="1"/><up_axis>Z_UP</up_axis></asset>
  <library_effects>
${effects.join("\n")}
  </library_effects>
  <library_materials>
${materialsXml.join("\n")}
  </library_materials>
  <library_geometries>
${geoms.join("\n")}
  </library_geometries>
  <library_visual_scenes>
    <visual_scene id="scene" name="${xmlEsc(name)}">
${instances.join("\n")}
    </visual_scene>
  </library_visual_scenes>
  <scene><instance_visual_scene url="#scene"/></scene>
</COLLADA>
`;
}

function specToCollada(spec, opts = {}) {
  const { mesh, spec: s } = buildMesh(spec);
  return { dae: meshToCollada(mesh, { materials: s.materials, name: s.name || opts.name }), triangles: mesh.triangleCount() };
}

export { DEFAULT_MATERIALS, normaliseSpec, snapWallEnds, validateSpec, buildMesh, meshToCollada, specToCollada };
