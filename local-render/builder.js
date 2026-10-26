// Copied from Monocular Desktop (src/builder.js) - keep the two in step.
/* Model builder: an on-device parametric building generator, plus click-to-edit tools for an imported model
   (windows punched into a wall, a wall turned to curtain glazing, a part removed). Everything is local geometry.
   Materials are always named as placeholders, never as a specification: Monocular reads finishes from the
   drawing set, so nothing made here pretends to know them. */
import * as THREE from "three";

export const DEFAULTS = {
  shape: "rect", width: 24, depth: 16, wing: 8, storeys: 4, storeyHeight: 3.2, slabThickness: 0.3, wallThickness: 0.3,
  windowType: "punched", windowWidth: 1.8, windowHeight: 1.8, sillHeight: 0.9, windowPitch: 3.0,
  slabEdge: 0, twistDeg: 0, taper: 100, split: 0, roofType: "flat", roofPitchDeg: 25, overhang: 0.45, parapet: 1.0, roofThickness: 0.3,
};
export const LIMITS = {
  width: [3, 300], depth: [3, 300], wing: [2, 60], storeys: [1, 120], storeyHeight: [2.4, 8], slabThickness: [0.15, 1],
  wallThickness: [0.1, 0.8], windowWidth: [0.3, 6], windowHeight: [0.3, 6], sillHeight: [0, 3], windowPitch: [0.6, 12],
  slabEdge: [0, 4], split: [0, 4], twistDeg: [-15, 15], taper: [30, 200], roofPitchDeg: [5, 60], overhang: [0, 3], parapet: [0, 2], roofThickness: [0.05, 1],
};
export const SHAPES = ["rect", "L", "U", "courtyard", "round", "sketch"];
export const WINDOW_TYPES = ["punched", "ribbon", "curtain", "none"];
export const ROOF_TYPES = ["flat", "gable", "hip", "mono"];

export function clampParams(raw){
  const p = { ...DEFAULTS, ...raw };
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    const v = Number(p[k]);
    p[k] = Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : DEFAULTS[k]));
  }
  p.storeys = Math.round(p.storeys);
  if (!SHAPES.includes(p.shape) || (p.shape === "sketch" && !(p.sketch && p.sketch.blocks && p.sketch.blocks.length))) p.shape = "rect";
  if (p.shape === "sketch") p.depth = p.sketch.d0 * p.width / p.sketch.w0;   // a sketch scales as a whole, keeping its proportions
  if (!WINDOW_TYPES.includes(p.windowType)) p.windowType = "punched";
  if (!ROOF_TYPES.includes(p.roofType)) p.roofType = "flat";
  const minSide = Math.min(p.width, p.depth);
  p.wing = Math.min(p.wing, p.shape === "courtyard" ? minSide / 2 - 1 : minSide - 1);
  p.slabThickness = Math.min(p.slabThickness, p.storeyHeight * 0.3);
  return p;
}

const PLACEHOLDER = ", placeholder, not a real material";
function mat(name, color, extra = {}){
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...extra });
  m.name = name + PLACEHOLDER;
  return m;
}
function builderMats(){
  return {
    wall: mat("Concept wall", 0xd6d1c4),
    slab: mat("Concept floor slab", 0xb9b4a8),
    roof: mat("Concept roof", 0x6b6459),
    frame: mat("Concept frame profile", 0x3b3f42, { roughness: 0.5, metalness: 0.3 }),   // no "window" in the name: that word means glass to Monocular
    glass: mat("Concept window glazing", 0x6f8f94, { roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.4 }),
    iwall: mat("Concept internal wall", 0xe6e2da),
    door: mat("Concept door leaf", 0x8b7a66),
    stair: mat("Concept stair", 0xaaa49a),
    col: mat("Concept core and column", 0xc9c4b8),
  };
}
let addedMats = null;   // one shared pair for every edit, so the material list doesn't grow with each click
function editMats(){
  return addedMats || (addedMats = {
    frame: mat("Added frame profile", 0x3b3f42, { roughness: 0.5, metalness: 0.3 }),
    glass: mat("Added window glazing", 0x6f8f94, { roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.4 }),
  });
}

// ---- triangle soup accumulator (world or builder-local coordinates, flat normals)
class Acc {
  constructor(){ this.p = []; }
  tri(a, b, c){ this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); }
  quad(a, b, c, d){ this.tri(a, b, c); this.tri(a, c, d); }
  box(o, ex, ey, ez, sx, sy, sz){
    const P = (i, j, k) => [0, 1, 2].map(t => o[t] + ex[t] * sx * (i - 0.5) + ey[t] * sy * (j - 0.5) + ez[t] * sz * (k - 0.5));
    const c = [P(0,0,0), P(1,0,0), P(1,1,0), P(0,1,0), P(0,0,1), P(1,0,1), P(1,1,1), P(0,1,1)];
    this.quad(c[0], c[3], c[2], c[1]); this.quad(c[4], c[5], c[6], c[7]);
    this.quad(c[0], c[4], c[7], c[3]); this.quad(c[1], c[2], c[6], c[5]);
    this.quad(c[0], c[1], c[5], c[4]); this.quad(c[3], c[7], c[6], c[2]);
  }
  // A flat polygon given a real thickness: the face as drawn is the top, the solid runs back along its normal.
  thick(pts, t, up = true){
    const a = new THREE.Vector3(), n = new THREE.Vector3();
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; n.x += (p[1] - q[1]) * (p[2] + q[2]); n.y += (p[2] - q[2]) * (p[0] + q[0]); n.z += (p[0] - q[0]) * (p[1] + q[1]); }
    n.normalize(); if (up && n.y < 0) n.negate();
    const lo = pts.map(p => a.set(...p).addScaledVector(n, -t).toArray());
    for (let i = 1; i + 1 < pts.length; i++) { this.tri(pts[0], pts[i], pts[i + 1]); this.tri(lo[0], lo[i + 1], lo[i]); }
    for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; this.quad(pts[i], lo[i], lo[j], pts[j]); }
  }
  geometry(){
    if (!this.p.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3));
    g.computeVertexNormals();
    return g;
  }
  mesh(name, material){
    const g = this.geometry(); if (!g) return null;
    const m = new THREE.Mesh(g, material); m.name = name; return m;
  }
}

// ---- footprint (plan coordinates [x, z], centred on the origin)
export function footprint(p){
  const W = p.width, D = p.depth, t = p.wing, x0 = -W / 2, x1 = W / 2, z0 = -D / 2, z1 = D / 2;
  const rect = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  switch (p.shape) {
    case "L": return { outer: [[x0, z0], [x1, z0], [x1, z0 + t], [x0 + t, z0 + t], [x0 + t, z1], [x0, z1]], holes: [] };
    case "U": return { outer: [[x0, z0], [x1, z0], [x1, z1], [x1 - t, z1], [x1 - t, z0 + t], [x0 + t, z0 + t], [x0 + t, z1], [x0, z1]], holes: [] };
    case "courtyard": return { outer: rect, holes: [[[x0 + t, z0 + t], [x0 + t, z1 - t], [x1 - t, z1 - t], [x1 - t, z0 + t]]] };
    case "round": {
      const pts = [], n = 40;
      for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; pts.push([(W / 2) * Math.cos(a), (D / 2) * Math.sin(a)]); }
      return { outer: pts, holes: [] };
    }
    default: return { outer: rect, holes: [] };
  }
}
const area2 = loop => loop.reduce((s, a, i) => { const b = loop[(i + 1) % loop.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0);
// Each edge with its outward normal, "outward" meaning away from the solid (into the courtyard for a hole).
function edges(loop, isHole){
  const s = Math.sign(area2(loop)) * (isHole ? -1 : 1), out = [];
  for (let i = 0; i < loop.length; i++) {
    const A = loop[i], B = loop[(i + 1) % loop.length], dx = B[0] - A[0], dz = B[1] - A[1], L = Math.hypot(dx, dz);
    if (L < 1e-6) continue;
    const e = [dx / L, dz / L];
    out.push({ A, B, L, e, n: [s * e[1], -s * e[0]] });
  }
  return out;
}
function offsetLoop(loop, d, isHole){
  const E = edges(loop, isHole), k = E.length;
  return E.map((ed, i) => {
    const prev = E[(i - 1 + k) % k].n, cur = ed.n, m = [prev[0] + cur[0], prev[1] + cur[1]], ml = Math.hypot(m[0], m[1]) || 1;
    const u = [m[0] / ml, m[1] / ml], s = d / Math.max(0.3, u[0] * cur[0] + u[1] * cur[1]);
    return [ed.A[0] + u[0] * s, ed.A[1] + u[1] * s];
  });
}

// Openings along one wall edge, in edge-local (u along the edge, v up from the floor).
function openingsFor(p, L, h){
  const out = [], sill = Math.min(p.sillHeight, Math.max(0, h - 0.45)), wh = Math.min(p.windowHeight, h - sill - 0.15);
  if (p.windowType === "curtain") return [{ u0: 0, u1: L, v0: 0, v1: h, panes: Math.max(1, Math.round(L / p.windowWidth)), curtain: true }];
  if (p.windowType === "none" || wh < 0.3) return out;
  if (p.windowType === "ribbon") {
    if (L > 1.2) out.push({ u0: 0.3, u1: L - 0.3, v0: sill, v1: sill + wh, panes: Math.max(1, Math.round((L - 0.6) / p.windowWidth)) });
    return out;
  }
  const ww = Math.min(p.windowWidth, L - 0.6);
  if (ww < 0.3) return out;
  const pitch = Math.max(p.windowPitch, ww + 0.2), k = Math.floor((L - 0.6 - ww) / pitch) + 1;
  for (let j = 0; j < k; j++) {
    const uc = L / 2 + (j - (k - 1) / 2) * pitch;
    out.push({ u0: uc - ww / 2, u1: uc + ww / 2, v0: sill, v1: sill + wh, panes: Math.max(1, Math.ceil(ww / 1.6)) });
  }
  return out;
}

const FRAME = 0.06, FRAME_DEPTH = 0.08;
// A frame (head, sill, jambs, mullions) and a glass pane filling an opening, in a plane at depth w.
function windowUnit(acc, P, ex, ey, ez, o, w){
  const { u0, u1, v0, v1, panes } = o, f = FRAME, bx = (uc, vc, su, sv) => acc.frame.box(P(uc, vc, w), ex, ey, ez, su, sv, FRAME_DEPTH);
  bx((u0 + u1) / 2, v0 + f / 2, u1 - u0, f); bx((u0 + u1) / 2, v1 - f / 2, u1 - u0, f);
  bx(u0 + f / 2, (v0 + v1) / 2, f, v1 - v0 - 2 * f); bx(u1 - f / 2, (v0 + v1) / 2, f, v1 - v0 - 2 * f);
  for (let k = 1; k < panes; k++) bx(u0 + (u1 - u0) * k / panes, (v0 + v1) / 2, f, v1 - v0 - 2 * f);
  acc.glass.quad(P(u0 + f / 2, v0 + f / 2, w), P(u1 - f / 2, v0 + f / 2, w), P(u1 - f / 2, v1 - f / 2, w), P(u0 + f / 2, v1 - f / 2, w));
}

function wallEdge(acc, p, ed, y0, h, doors = [], blank = false, notes = null){
  const tw = p.wallThickness, ex = [ed.e[0], 0, ed.e[1]], ez = [ed.n[0], 0, ed.n[1]], ey = [0, 1, 0];
  const P = (u, v, w) => [ed.A[0] + ed.e[0] * u + ed.n[0] * w, y0 + v, ed.A[1] + ed.e[1] * u + ed.n[1] * w];
  let ops = blank ? [] : openingsFor(p, ed.L, h);
  if (doors.length) {
    if (ops.some(o => o.curtain)) { if (notes) notes.add("Doors in a curtain wall aren't cut; the glazing runs through."); }
    else {
      const ds = doors.map(d => ({ u0: Math.max(0.05, d.u - d.w / 2), u1: Math.min(ed.L - 0.05, d.u + d.w / 2), v0: 0, v1: Math.min(d.h, h - 0.1), panes: d.kind === "door" ? 1 : 0 }))
        .filter(o => o.u1 - o.u0 > 0.3);
      ops = ops.filter(o => !ds.some(d => o.u1 > d.u0 - 0.15 && o.u0 < d.u1 + 0.15)).concat(ds);
    }
  }
  const us = [...new Set([0, ed.L, ...ops.flatMap(o => [o.u0, o.u1])])].sort((a, b) => a - b);
  const vs = [...new Set([0, h, ...ops.flatMap(o => [o.v0, o.v1])])].sort((a, b) => a - b);
  for (let i = 0; i + 1 < us.length; i++) for (let j = 0; j + 1 < vs.length; j++) {
    const ua = us[i], ub = us[i + 1], va = vs[j], vb = vs[j + 1], um = (ua + ub) / 2, vm = (va + vb) / 2;
    if (ops.some(o => um > o.u0 && um < o.u1 && vm > o.v0 && vm < o.v1)) continue;
    acc.wall.quad(P(ua, va, 0), P(ub, va, 0), P(ub, vb, 0), P(ua, vb, 0));
    acc.wall.quad(P(ua, va, -tw), P(ua, vb, -tw), P(ub, vb, -tw), P(ub, va, -tw));
  }
  for (const o of ops) {
    if (!o.curtain) {
      acc.wall.quad(P(o.u0, o.v0, 0), P(o.u1, o.v0, 0), P(o.u1, o.v0, -tw), P(o.u0, o.v0, -tw));
      acc.wall.quad(P(o.u0, o.v1, 0), P(o.u0, o.v1, -tw), P(o.u1, o.v1, -tw), P(o.u1, o.v1, 0));
      acc.wall.quad(P(o.u0, o.v0, 0), P(o.u0, o.v0, -tw), P(o.u0, o.v1, -tw), P(o.u0, o.v1, 0));
      acc.wall.quad(P(o.u1, o.v0, 0), P(o.u1, o.v1, 0), P(o.u1, o.v1, -tw), P(o.u1, o.v0, -tw));
    }
    if (o.panes) windowUnit(acc, P, ex, ey, ez, o, o.curtain ? -0.05 : -tw * 0.4);   // an opening (panes 0) stays open
  }
}

function slabInto(acc, outer, holes, y, t){
  const shape = new THREE.Shape(outer.map(([x, z]) => new THREE.Vector2(x, -z)));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, z]) => new THREE.Vector2(x, -z))));
  const g = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 1 });
  g.rotateX(-Math.PI / 2); g.translate(0, y, 0);
  const P = (g.index ? g.toNonIndexed() : g).attributes.position.array;
  for (let i = 0; i < P.length; i++) acc.p.push(P[i]);
  g.dispose();
}

function pitchedRoof(acc, p, f, s, y0){
  const along = p.along ?? (p.width >= p.depth), A = (along ? p.width : p.depth) / 2, B = (along ? p.depth : p.width) / 2;   // the ridge runs along A
  const oA = p.overhangA ?? p.overhang, oB = p.overhangB ?? p.overhang;   // past the gable ends, and past the eaves
  const Ao = A + oA / s, Bo = B + oB / s, tan = Math.tan(THREE.MathUtils.degToRad(p.roofPitchDeg));
  const Q = (a, b, y) => { const [x, z] = f(along ? [a, b] : [b, a]); return [x, y, z]; };
  const ye = y0 - oB * tan, rt = p.roofThickness, F = (...pts) => acc.roof.thick(pts, rt);
  if (p.roofType === "mono") {
    const yh = y0 + (2 * B * s + oB) * tan, yt = y0 + 2 * B * s * tan;
    F(Q(-Ao, -Bo, ye), Q(Ao, -Bo, ye), Q(Ao, Bo, yh), Q(-Ao, Bo, yh));
    for (const a of [-A, A]) acc.wall.tri(Q(a, -B, y0), Q(a, B, y0), Q(a, B, yt));
    acc.wall.quad(Q(-A, B, y0), Q(A, B, y0), Q(A, B, yt), Q(-A, B, yt));
    return;
  }
  const yr = y0 + B * s * tan;
  if (p.roofType === "gable") {
    F(Q(-Ao, -Bo, ye), Q(Ao, -Bo, ye), Q(Ao, 0, yr), Q(-Ao, 0, yr));
    F(Q(-Ao, Bo, ye), Q(-Ao, 0, yr), Q(Ao, 0, yr), Q(Ao, Bo, ye));
    for (const a of [-A, A]) acc.wall.tri(Q(a, -B, y0), Q(a, B, y0), Q(a, 0, yr));
    return;
  }
  const R = A - B;   // hip: equal pitch all round, so the ridge is the long side less the short side
  F(Q(-Ao, -Bo, ye), Q(Ao, -Bo, ye), Q(R, 0, yr), Q(-R, 0, yr));
  F(Q(-Ao, Bo, ye), Q(-R, 0, yr), Q(R, 0, yr), Q(Ao, Bo, ye));
  F(Q(Ao, -Bo, ye), Q(Ao, Bo, ye), Q(R, 0, yr));
  F(Q(-Ao, Bo, ye), Q(-Ao, -Bo, ye), Q(-R, 0, yr));
}

// A rectangle (4 square corners, no holes) gets its centre, direction and sides, so a pitched roof can sit on it.
function rectOf(outer, holes){
  if (outer.length !== 4 || (holes && holes.length)) return null;
  const E = edges(outer, false);
  if (E.length !== 4 || E.some((e, i) => Math.abs(e.e[0] * E[(i + 1) % 4].e[0] + e.e[1] * E[(i + 1) % 4].e[1]) > 0.03)) return null;
  const cx = outer.reduce((s, q) => s + q[0], 0) / 4, cz = outer.reduce((s, q) => s + q[1], 0) / 4;
  return { cx, cz, e: E[0].e, w: E[0].L, d: E[1].L };
}
// The building as blocks: one for a parametric plan, or one per traced outline for a sketch. A block sitting on
// another starts at its parent's roof.
function blocksFor(p){
  if (p.shape !== "sketch") {
    const rect = p.shape === "rect" ? { cx: 0, cz: 0, e: [1, 0], w: p.width, d: p.depth } : null;
    if (p.split > 0 && p.shape === "rect" && !p.twistDeg && p.taper === 100) {
      // split level: the back half of the plan sits part of a storey higher than the front half
      const W = p.width / 2, D = p.depth / 2, half = (z0, z1, lift, i) => ({ fp: { outer: [[-W, z0], [W, z0], [W, z1], [-W, z1]], holes: [] }, base: 0, n: p.storeys, lift,
        xf: () => ({ s: 1, f: q => q }), rect: { cx: 0, cz: (z0 + z1) / 2, e: [1, 0], w: p.width, d: z1 - z0 }, top: true, index: i });
      return [half(0, D, 0, 0), half(-D, 0, p.split, 1)];
    }
    return [{ fp: footprint(p), base: 0, n: p.storeys, lift: 0, xf: i => storeyXf(p, i), rect, top: true, index: 0 }];
  }
  const B = p.sketch.blocks, k = p.width / p.sketch.w0, sc = loop => loop.map(([x, z]) => [x * k, z * k]);
  const nOf = i => Math.max(1, Math.round(B[i].storeys ?? p.storeys));
  const ok = i => B[i].parent != null && B[i].parent !== i && B[B[i].parent];
  const baseOf = (i, guard = 0) => B[i].level != null ? B[i].level : !ok(i) || guard > 20 ? 0 : baseOf(B[i].parent, guard + 1) + nOf(B[i].parent);
  const liftOf = (i, guard = 0) => (B[i].lift || 0) + (ok(i) && guard < 20 ? liftOf(B[i].parent, guard + 1) : 0);
  return B.map((b, i) => {
    const outer = sc(b.outer), holes = (b.holes || []).map(sc);
    const roof = b.roof ? { ...b.roof, outline: b.roof.outline ? sc(b.roof.outline) : null, ...(b.roof.apex ? { apex: [b.roof.apex[0] * k, b.roof.apex[1] * k] } : {}) } : null;
    return { fp: { outer, holes }, base: baseOf(i), n: nOf(i), lift: liftOf(i), onParent: ok(i) && B[i].level == null, xf: () => ({ s: 1, f: q => q }), rect: rectOf(outer, holes), roof,
      top: !B.some(c => c.parent === i), index: i };
  });
}

function storeyXf(p, i){
  const n = p.storeys, s = n > 1 ? 1 + (p.taper / 100 - 1) * i / (n - 1) : 1;
  const th = THREE.MathUtils.degToRad(p.twistDeg * i), c = Math.cos(th), sn = Math.sin(th);
  return { s, f: ([x, z]) => [(x * c - z * sn) * s, (x * sn + z * c) * s] };
}

// Where another block shares this wall (a split level, or blocks drawn side by side): its floor-to-roof span.
function sharedSpans(p, blocks, b, ed){
  const out = [];
  for (const o of blocks) {
    if (o === b) continue;
    for (const [loop, isHole] of [[o.fp.outer, false], ...o.fp.holes.map(h => [h, true])]) for (const f of edges(loop, isHole)) {
      if (f.n[0] * ed.n[0] + f.n[1] * ed.n[1] > -0.99) continue;   // must face the other way
      const off = (f.A[0] - ed.A[0]) * ed.n[0] + (f.A[1] - ed.A[1]) * ed.n[1];
      if (Math.abs(off) > 0.05) continue;
      const u0 = (f.A[0] - ed.A[0]) * ed.e[0] + (f.A[1] - ed.A[1]) * ed.e[1], u1 = (f.B[0] - ed.A[0]) * ed.e[0] + (f.B[1] - ed.A[1]) * ed.e[1];
      const lo = Math.max(0, Math.min(u0, u1)), hi = Math.min(ed.L, Math.max(u0, u1));
      if (hi - lo > ed.L * 0.9) out.push({ y0: o.base * p.storeyHeight + o.lift, y1: (o.base + o.n) * p.storeyHeight + o.lift, block: o });
    }
  }
  return out;
}

// One outside wall's own thickness and windows, where they've been set; the building's otherwise.
export const facadeKey = (b, l, e) => `${b}:${l}:${e}`;
function facadeParams(p, b, l, e){
  const o = p.facades && p.facades[facadeKey(b, l, e)];
  if (!o) return p;
  return { ...p, wallThickness: Math.min(LIMITS.wallThickness[1], Math.max(LIMITS.wallThickness[0], o.t ?? p.wallThickness)), windowType: WINDOW_TYPES.includes(o.windowType) ? o.windowType : p.windowType };
}

/** Build the whole building as a Y-up THREE.Group, ground floor at y = 0. */
export function buildModel(raw){
  const p = clampParams(raw), M = builderMats(), notes = new Set();
  const acc = { wall: new Acc(), slab: new Acc(), roof: new Acc(), frame: new Acc(), glass: new Acc(), iwall: new Acc(), door: new Acc(), stair: new Acc(), col: new Acc() };
  const H = p.storeyHeight, ts = p.slabThickness, blocks = blocksFor(p), voids = interiorVoids(p, blocks), fdoors = facadeDoors(p, blocks);
  if (p.shape === "sketch" && (p.twistDeg || p.taper !== 100)) notes.add("Twist and top size apply to the parametric plans only, not to a sketch.");
  if (p.split > 0 && p.shape !== "rect") notes.add("A split level needs the rectangle plan (or a sketch with a raised block).");
  if (p.split > 0 && p.shape === "rect" && (p.twistDeg || p.taper !== 100)) notes.add("A split level can't be twisted or tapered, so it was left whole.");
  let flatForced = false;
  blocks.forEach((b, bi) => {
    const n = b.n, y0 = b.base * H + b.lift;
    const loopsAt = i => { const { f } = b.xf(i); return { outer: b.fp.outer.map(f), holes: b.fp.holes.map(h => h.map(f)) }; };
    // a block on another stands on its parent's roof slab, unless it overhangs it (then it needs its own floor)
    const par = b.onParent ? blocks[p.sketch.blocks[b.index].parent] : null;
    const overhangs = par && !b.fp.outer.every(q => insidePoly(par.fp.outer, q) || segDistToLoop(par.fp.outer, q) < 0.05);
    const covered = blocks.some(c => c.onParent && p.sketch.blocks[c.index].parent === b.index && b.fp.outer.every(q => insidePoly(c.fp.outer, q) || segDistToLoop(c.fp.outer, q) < 0.05));
    for (let k = b.onParent && !overhangs ? 1 : 0; k <= (covered ? n - 1 : n); k++) {
      const { outer, holes } = loopsAt(Math.min(k, n - 1)), ext = k > 0 && k < n ? p.slabEdge : 0;
      const o2 = ext ? offsetLoop(outer, ext, false) : outer, h2 = ext ? holes.map(h => offsetLoop(h, ext, true)) : holes;
      const cut = k > 0 && k < n ? voidsFor(outer, h2, voids.get(b.base + k) || [], notes) : [];
      slabInto(acc.slab, o2, [...h2, ...cut], y0 + k * H, ts);
      if (ext >= 0.5) for (const [loop, isHole] of [[o2, false], ...h2.map(h => [h, true])]) for (const ed of edges(loop, isHole)) {
        const P = (u, v) => [ed.A[0] + ed.e[0] * u, y0 + k * H + ts + v, ed.A[1] + ed.e[1] * u];
        acc.glass.quad(P(0, 0), P(ed.L, 0), P(ed.L, 1.0), P(0, 1.0));
        acc.frame.box(P(ed.L / 2, 1.0), [ed.e[0], 0, ed.e[1]], [0, 1, 0], [ed.n[0], 0, ed.n[1]], ed.L, 0.05, 0.05);
      }
    }
    const base0 = loopsAt(0);
    [base0.outer, ...base0.holes].forEach((loop0, li) => edges(loop0, li !== 0).forEach((ed0, ei) => {
      const shared = sharedSpans(p, blocks, b, ed0), doors = fdoors.get(`${bi}:${li}:${ei}`) || [];
      for (let i = 0; i < n; i++) {
        const { outer, holes } = loopsAt(i), loop = li === 0 ? outer : holes[li - 1], ed = edges(loop, li !== 0)[ei];
        if (!ed) continue;
        const ya = y0 + i * H, yb = ya + H;
        if (shared.some(s => s.y0 <= ya + 0.01 && s.y1 >= yb - 0.01)) {
          // open to the block beside it: only the step between the two floors needs a face
          for (const s of shared) {
            const below = Math.floor((ya - s.y0) / H + 1e-6), yn = s.y0 + below * H, step = ya - yn;
            if (step > 0.05 && step < H) acc.wall.box([ed.A[0] + ed.e[0] * ed.L / 2 - ed.n[0] * 0.1, yn + ts + step / 2, ed.A[1] + ed.e[1] * ed.L / 2 - ed.n[1] * 0.1],
              [ed.e[0], 0, ed.e[1]], [0, 1, 0], [ed.n[0], 0, ed.n[1]], ed.L, step, 0.2);
          }
          continue;
        }
        const here = doors.filter(d => d.levels.includes(b.base + i));
        wallEdge(acc, facadeParams(p, bi, li, ei), ed, ya + ts, H - ts, here, shared.length > 0, notes);
      }
    }));
    const top = y0 + n * H + ts, { outer, holes } = loopsAt(n - 1);
    const rs = b.roof;   // a roof outline drawn dashed on the sketch
    let roofType = rs && rs.type ? rs.type : p.roofType;
    if (roofType !== "flat" && !b.top) roofType = "flat";   // a block with another on it has a flat roof (a terrace)
    // an irregular plan can't take a simple gable or hip: its eaves rise to one peak instead
    const eaveLine = rs && rs.outline ? rs.outline : p.overhang > 0 ? offsetLoop(outer, p.overhang, false) : outer;
    const peak = roofType !== "flat" && (rs && rs.type === "pyramid" || !b.rect || holes.length);
    if (peak && holes.length) { notes.add("A pitched roof over a courtyard isn't drawn; it has a flat roof."); roofType = "flat"; }
    else if (peak && !(rs && rs.type === "pyramid") && roofType !== "hip") flatForced = true;
    if (peak && roofType !== "flat") {
      // hips from the corners to one point (the drawn apex, or the middle): each eave rises to it at the roof pitch
      const L = eaveLine, A = rs && rs.apex ? rs.apex : centroid(outer), tan = Math.tan(THREE.MathUtils.degToRad(p.roofPitchDeg));
      const dmin = Math.min(...L.map((q, i) => segDist(A, q, L[(i + 1) % L.length]).d)), yA = top + dmin * tan;
      L.forEach((q, i) => { const r = L[(i + 1) % L.length]; acc.roof.thick([[q[0], top, q[1]], [r[0], top, r[1]], [A[0], yA, A[1]]], p.roofThickness); });
    } else if (rs && rs.outline && roofType !== "flat") {
      const r = b.rect, en = [-r.e[1], r.e[0]], ext = (d, c) => { const v = rs.outline.map(q => (q[0] - r.cx) * d[0] + (q[1] - r.cz) * d[1]); return (Math.max(...v) - Math.min(...v)) / 2 - c / 2; };
      const oE = Math.max(0, ext(r.e, r.w)), oN = Math.max(0, ext(en, r.d));
      const along = rs.ridge ? Math.abs(rs.ridge[0] * r.e[0] + rs.ridge[1] * r.e[1]) > 0.7 : r.w >= r.d;
      const g = ([x, z]) => [r.cx + x * r.e[0] - z * r.e[1], r.cz + x * r.e[1] + z * r.e[0]];
      pitchedRoof(acc, { ...p, roofType, width: r.w, depth: r.d, along, overhangA: along ? oE : oN, overhangB: along ? oN : oE }, g, 1, top);
    } else if (rs && rs.outline) {
      // flat: the drawn outline is the roof's edge (eaves or a canopy beyond the walls)
      acc.roof.thick(rs.outline.map(([x, z]) => [x, top + p.roofThickness, z]), p.roofThickness);
    } else if (roofType === "flat" && !covered && p.parapet === 0 && p.overhang > 0) {
      // a flat roof with eaves: the roof slab runs past the walls by the eave width
      slabInto(acc.roof, offsetLoop(outer, p.overhang, false), holes.map(h => offsetLoop(h, p.overhang, true)), top, p.roofThickness);
    } else if (roofType === "flat") {
      if (p.parapet > 0 && !covered) for (const [loop, isHole] of [[outer, false], ...holes.map(h => [h, true])]) for (const ed of edges(loop, isHole)) {
        if (sharedSpans(p, blocks, b, ed).some(s => s.y1 > top - ts + 0.01)) continue;   // no parapet where it meets a taller part
        const ei = edges(loop, isHole).findIndex(x => x.A === ed.A), tw = facadeParams(p, bi, loop === outer ? 0 : holes.indexOf(loop) + 1, ei).wallThickness;
        const c = [ed.A[0] + ed.e[0] * ed.L / 2 - ed.n[0] * tw / 2, top + p.parapet / 2, ed.A[1] + ed.e[1] * ed.L / 2 - ed.n[1] * tw / 2];
        acc.wall.box(c, [ed.e[0], 0, ed.e[1]], [0, 1, 0], [ed.n[0], 0, ed.n[1]], ed.L, p.parapet, tw);
      }
    } else {
      const { f, s } = b.xf(n - 1), r = b.rect;
      const g = r.e[0] === 1 && r.e[1] === 0 && !r.cx && !r.cz ? f : ([x, z]) => f([r.cx + x * r.e[0] - z * r.e[1], r.cz + x * r.e[1] + z * r.e[0]]);
      pitchedRoof(acc, { ...p, roofType, width: r.w, depth: r.d }, g, s, top);
    }
  });
  interiorInto(acc, p, blocks, notes);
  if (flatForced) notes.add("Gable and mono-pitch roofs need a rectangular block; on the others the eaves rise to one peak (hips).");
  const group = new THREE.Group(); group.name = "Built model (concept)";
  for (const [key, name] of [["slab", "Floor slabs"], ["wall", "Walls"], ["roof", "Roof"], ["frame", "Frames and mullions"], ["glass", "Glazing"],
    ["iwall", "Internal walls"], ["door", "Doors"], ["stair", "Stairs"], ["col", "Columns and cores"]]) {
    const m = acc[key].mesh(name, M[key]); if (m) group.add(m);
  }
  group.userData.builder = { params: p, notes: [...notes] };
  return group;
}

/** Overall height to the top of the roof slab. */
export const totalHeight = raw => { const p = clampParams(raw); return Math.max(...blocksFor(p).map(b => (b.base + b.n) * p.storeyHeight + b.lift)) + p.slabThickness; };

/** Live dimensions for the builder, in the built group's own coordinates. Each one can be edited. */
const centroid = loop => { let a = 0, x = 0, z = 0; loop.forEach((P, i) => { const Q = loop[(i + 1) % loop.length], c = P[0] * Q[1] - Q[0] * P[1]; a += c; x += (P[0] + Q[0]) * c; z += (P[1] + Q[1]) * c; }); return a ? [x / (3 * a), z / (3 * a)] : loop[0]; };
export function dimensionsFor(raw){
  const p = clampParams(raw), W = p.width, D = p.depth, ts = p.slabThickness, ht = totalHeight(p);
  if (p.shape === "sketch") return sketchDims(p);
  const off = 1.5 + p.slabEdge + (p.roofType !== "flat" ? p.overhang : 0);
  const d = (key, a, b, value, extra = {}) => ({ key, a, b, value, unit: "m", step: 0.1, min: (LIMITS[key] || [0])[0], max: (LIMITS[key] || [0, 1e9])[1], ...extra });
  const out = [
    d("width", [-W / 2, 0, D / 2 + off], [W / 2, 0, D / 2 + off], W, { hint: "Overall width" }),
    d("depth", [W / 2 + off, 0, D / 2], [W / 2 + off, 0, -D / 2], D, { hint: "Overall depth" }),
    d("height", [W / 2 + off, 0, D / 2 + off], [W / 2 + off, ht, D / 2 + off], ht, {
      min: p.storeys * LIMITS.storeyHeight[0] + ts, max: p.storeys * LIMITS.storeyHeight[1] + ts,
      set: v => ({ storeyHeight: (v - ts) / p.storeys }), hint: "Overall height (sets the floor to floor)" }),
    d("storeyHeight", [-W / 2 - off, ts, D / 2 + off], [-W / 2 - off, ts + p.storeyHeight, D / 2 + off], p.storeyHeight, { hint: "Floor to floor" }),
    { key: "storeys", a: [0, ht + 1.5 + (p.roofType !== "flat" ? Math.min(W, D) * 0.3 : 0), 0], value: p.storeys, unit: "storeys", step: 1, min: 1, max: 120, point: true, hint: "Storeys" },
  ];
  if (["L", "U", "courtyard"].includes(p.shape)) out.push(d("wing", [-W / 2, 0, D / 2 + off + 1.6], [-W / 2 + p.wing, 0, D / 2 + off + 1.6], p.wing, { hint: "Wing depth" }));
  if (p.windowType !== "none") {
    // the facade the default camera looks at: the longest edge facing +z / +x
    const E = edges(blocksFor(p)[0].fp.outer, false).filter(e => e.n[0] * 0.5 + e.n[1] * 0.85 > 0.5).sort((a, b) => b.L - a.L)[0];
    const ops = E ? openingsFor(p, E.L, p.storeyHeight - ts) : [];
    if (E && ops.length) {
      const P = (u, v) => [E.A[0] + E.e[0] * u + E.n[0] * 0.08, ts + v, E.A[1] + E.e[1] * u + E.n[1] * 0.08];
      const o = ops[0];
      if (o.curtain || p.windowType === "ribbon") {
        const pw = (o.u1 - o.u0) / o.panes;
        out.push(d("windowWidth", P(o.u0, o.v0 + 0.4), P(o.u0 + pw, o.v0 + 0.4), p.windowWidth, { hint: "Pane width" }));
      } else out.push(d("windowWidth", P(o.u0, o.v0 - 0.3), P(o.u1, o.v0 - 0.3), p.windowWidth, { hint: "Window width" }));
      if (!o.curtain) {
        out.push(d("windowHeight", P(o.u1 + 0.3, o.v0), P(o.u1 + 0.3, o.v1), p.windowHeight, { hint: "Window height" }));
        out.push(d("sillHeight", P(o.u0 - 0.3, 0), P(o.u0 - 0.3, o.v0), p.sillHeight, { hint: "Sill height" }));
      }
      if (p.windowType === "punched" && ops.length > 1) {
        const o1 = ops[1];
        out.push(d("windowPitch", P((o.u0 + o.u1) / 2, o.v1 + 0.3), P((o1.u0 + o1.u1) / 2, o.v1 + 0.3), p.windowPitch, { hint: "Window spacing, centre to centre" }));
      }
    }
  }
  // thicknesses: slab edge at level 1, wall at the roof line, roof at its front eave
  const x0 = -W / 2, z1 = D / 2, lvl = p.storeys > 1 ? p.storeyHeight : 0;
  out.push(d("slabThickness", [x0 - 0.6, lvl, z1 + 0.6], [x0 - 0.6, lvl + ts, z1 + 0.6], ts, { step: 0.01, hint: "Floor slab thickness" }));
  const yw = totalHeight(p) + (p.roofType === "flat" ? p.parapet : 0) + 0.15;
  out.push(d("wallThickness", [x0 + 1, yw, z1], [x0 + 1, yw, z1 - p.wallThickness], p.wallThickness, { step: 0.01, hint: "Wall thickness" }));
  if (p.overhang > 0 && (p.roofType !== "flat" || p.parapet === 0)) {
    const E = edges(blocksFor(p)[0].fp.outer, false).filter(e => e.n[0] * 0.5 + e.n[1] * 0.85 > 0.3).sort((a, b) => b.L - a.L)[0];
    if (E) { const m = [E.A[0] + E.e[0] * E.L * 0.75, E.A[1] + E.e[1] * E.L * 0.75], y = totalHeight(p) - 0.05;
      out.push(d("overhang", [m[0], y, m[1]], [m[0] + E.n[0] * p.overhang, y, m[1] + E.n[1] * p.overhang], p.overhang, { step: 0.05, hint: "Eave width (past the wall)" })); }
  }
  if (p.roofType !== "flat" && p.shape === "rect") {
    const { f, s } = storeyXf(p, p.storeys - 1), along = W >= D, Bh = (along ? D : W) / 2, os = p.overhang / s, tan = Math.tan(THREE.MathUtils.degToRad(p.roofPitchDeg));
    const ye = totalHeight(p) - p.overhang * tan, [ex, ez] = f(along ? [0, Bh + os] : [Bh + os, 0]);
    const c = Math.cos(Math.atan(tan)), sn = Math.sin(Math.atan(tan)), dir = along ? [0, 1] : [1, 0];   // underside normal of the front face
    out.push(d("roofThickness", [ex, ye, ez], [ex - dir[0] * sn * p.roofThickness, ye - c * p.roofThickness, ez - dir[1] * sn * p.roofThickness], p.roofThickness, { step: 0.01, hint: "Roof thickness" }));
    out.push({ key: "roofPitchDeg", a: [ex * 0.5, ye + (Bh * s) * tan * 0.5 + 0.6, ez * 0.5], value: p.roofPitchDeg, unit: "°", step: 1, min: 5, max: 60, point: true, hint: "Roof pitch" });
  }
  return out;
}

// A sketch: overall size scales the whole drawing; each block has its own storeys; windows and thicknesses on the
// main block's front face.
function sketchDims(p){
  const B = blocksFor(p), H = p.storeyHeight, ts = p.slabThickness, W = p.width, D = p.depth, off = 1.5 + p.slabEdge;
  const d = (key, a, b, value, extra = {}) => ({ key, a, b, value, unit: "m", step: 0.1, min: (LIMITS[key] || [0])[0], max: (LIMITS[key] || [0, 1e9])[1], ...extra });
  const r = D / W, out = [
    d("width", [-W / 2, 0, D / 2 + off], [W / 2, 0, D / 2 + off], W, { hint: "Overall width (scales the whole sketch)" }),
    d("depth", [W / 2 + off, 0, D / 2], [W / 2 + off, 0, -D / 2], D, { min: LIMITS.width[0] * r, max: LIMITS.width[1] * r, set: v => ({ width: v / r }), hint: "Overall depth (scales the whole sketch)" }),
    d("storeyHeight", [-W / 2 - off, ts, D / 2 + off], [-W / 2 - off, ts + H, D / 2 + off], H, { hint: "Floor to floor" }),
  ];
  for (const b of B) {
    const c = centroid(b.fp.outer);
    out.push({ key: `storeys_${b.index}`, a: [c[0], (b.base + b.n) * H + ts + 1.2, c[1]], value: b.n, unit: "storeys", step: 1, min: 1, max: 120, point: true,
      hint: `Block ${b.index + 1}: storeys` + (b.base ? " above the block it stands on" : ""),
      set: v => ({ sketch: { ...p.sketch, blocks: p.sketch.blocks.map((x, j) => j === b.index ? { ...x, storeys: Math.max(1, Math.round(v)) } : x) } }) });
  }
  // a plan read for an upper level: how far it sits from the building's left and front edges (type to shift it)
  const groups = [...new Set(p.sketch.blocks.map(b => b.grp).filter(g => g != null))];
  const k = p.width / p.sketch.w0, all0 = B.filter(b => p.sketch.blocks[b.index].grp == null).flatMap(b => b.fp.outer);
  if (all0.length) for (const g of groups) {
    const gb = B.filter(b => p.sketch.blocks[b.index].grp === g), pts = gb.flatMap(b => b.fp.outer), y = gb[0].base * H + ts + gb[0].lift + 0.05;
    const x0 = Math.min(...all0.map(q => q[0])), z1 = Math.max(...all0.map(q => q[1])), gx0 = Math.min(...pts.map(q => q[0])), gz1 = Math.max(...pts.map(q => q[1]));
    const move = (dx, dz) => ({ sketch: { ...p.sketch, blocks: p.sketch.blocks.map(b => b.grp !== g ? b : { ...b, outer: b.outer.map(([x, z]) => [x + dx / k, z + dz / k]), holes: (b.holes || []).map(h => h.map(([x, z]) => [x + dx / k, z + dz / k])) }) } });
    out.push(d(`gx_${g}`, [x0, y, gz1 + 0.6], [gx0, y, gz1 + 0.6], gx0 - x0, { min: -300, max: 300, hint: `${levelName(g)} plan: distance in from the left edge of the building`, set: v => move(v - (gx0 - x0), 0) }));
    out.push(d(`gz_${g}`, [gx0 - 0.6, y, z1], [gx0 - 0.6, y, gz1], z1 - gz1, { min: -300, max: 300, hint: `${levelName(g)} plan: distance back from the front edge of the building`, set: v => move(0, -(v - (z1 - gz1))) }));
  }
  const main = B[0], E = edges(main.fp.outer, false).sort((a, b) => (b.n[1] * 0.85 + b.n[0] * 0.5) * b.L - (a.n[1] * 0.85 + a.n[0] * 0.5) * a.L)[0];
  if (!E) return out;
  const P = (u, v, w = 0.08) => [E.A[0] + E.e[0] * u + E.n[0] * w, ts + v, E.A[1] + E.e[1] * u + E.n[1] * w];
  const ops = p.windowType !== "none" ? openingsFor(p, E.L, H - ts) : [];
  if (ops.length) {
    const o = ops[0];
    if (o.curtain || p.windowType === "ribbon") out.push(d("windowWidth", P(o.u0, o.v0 + 0.4), P(o.u0 + (o.u1 - o.u0) / o.panes, o.v0 + 0.4), p.windowWidth, { hint: "Pane width" }));
    else out.push(d("windowWidth", P(o.u0, o.v0 - 0.3), P(o.u1, o.v0 - 0.3), p.windowWidth, { hint: "Window width" }));
    if (!o.curtain) {
      out.push(d("windowHeight", P(o.u1 + 0.3, o.v0), P(o.u1 + 0.3, o.v1), p.windowHeight, { hint: "Window height" }));
      out.push(d("sillHeight", P(o.u0 - 0.3, 0), P(o.u0 - 0.3, o.v0), p.sillHeight, { hint: "Sill height" }));
    }
    if (p.windowType === "punched" && ops.length > 1) out.push(d("windowPitch", P((o.u0 + o.u1) / 2, o.v1 + 0.3), P((ops[1].u0 + ops[1].u1) / 2, o.v1 + 0.3), p.windowPitch, { hint: "Window spacing, centre to centre" }));
  }
  {   // eave width: typing it replaces any roof outline drawn on the sketch with the walls plus this width
    const top = B.filter(b => b.top).sort((a, b) => (b.base + b.n) - (a.base + a.n))[0], T = top && edges(top.fp.outer, false).sort((a, b) => b.L - a.L)[0];
    if (T) {
      const y = (top.base + top.n) * H + ts + top.lift - 0.05, m = [T.A[0] + T.e[0] * T.L * 0.75, T.A[1] + T.e[1] * T.L * 0.75];
      const drawn = top.roof && top.roof.outline, eave = drawn ? Math.max(0, ...top.roof.outline.map(q => -((q[0] - T.A[0]) * -T.n[0] + (q[1] - T.A[1]) * -T.n[1]))) : p.overhang;
      out.push(d("overhang", [m[0], y, m[1]], [m[0] + T.n[0] * eave, y, m[1] + T.n[1] * eave], eave, { step: 0.05, min: 0, max: 3, hint: "Eave width (past the wall)" + (drawn ? ", as drawn" : ""),
        set: v => ({ overhang: v, ...(p.roofType === "flat" ? { parapet: 0 } : {}), sketch: { ...p.sketch, blocks: p.sketch.blocks.map(b => b.roof ? { ...b, roof: { ...b.roof, outline: null } } : b) } }) }));
    }
  }
  const lvl = main.n > 1 ? H : 0, A = [E.A[0] + E.n[0] * 0.6 - E.e[0] * 0.6, E.A[1] + E.n[1] * 0.6 - E.e[1] * 0.6];
  out.push(d("slabThickness", [A[0], lvl, A[1]], [A[0], lvl + ts, A[1]], ts, { step: 0.01, hint: "Floor slab thickness" }));
  const yw = (main.base + main.n) * H + ts + (p.parapet || 0) + 0.15, M = [E.A[0] + E.e[0] * E.L * 0.2, E.A[1] + E.e[1] * E.L * 0.2];
  out.push(d("wallThickness", [M[0], yw, M[1]], [M[0] - E.n[0] * p.wallThickness, yw, M[1] - E.n[1] * p.wallThickness], p.wallThickness, { step: 0.01, hint: "Wall thickness" }));
  return out;
}

/* ---------------- Edit tools on an imported model ----------------
   All work in world space on the clicked mesh, then hand back an undo. Nothing here touches the file on disk. */
const Y = new THREE.Vector3(0, 1, 0);
function worldTris(mesh){
  const g = mesh.geometry, P = g.attributes.position, I = g.index, cnt = I ? I.count : P.count, out = new Float32Array(cnt * 3), v = new THREE.Vector3();
  mesh.updateWorldMatrix(true, false);
  for (let i = 0; i < cnt; i++) { v.fromBufferAttribute(P, I ? I.getX(i) : i).applyMatrix4(mesh.matrixWorld); out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z; }
  return out;
}
const triV = (T, t, k) => new THREE.Vector3(T[t * 9 + k * 3], T[t * 9 + k * 3 + 1], T[t * 9 + k * 3 + 2]);
function triNormal(T, t){
  const a = triV(T, t, 0), n = triV(T, t, 1).sub(a).cross(triV(T, t, 2).sub(a)), l = n.length();
  return l > 1e-10 ? n.divideScalar(l) : null;
}

// convex polygon clipping in the face plane; vertices carry barycentrics of their source triangle
const lerpV = (A, B, t) => ({ u: A.u + (B.u - A.u) * t, v: A.v + (B.v - A.v) * t, b: A.b.map((x, i) => x + (B.b[i] - x) * t) });
function clip(poly, f){
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const A = poly[i], B = poly[(i + 1) % poly.length], fa = f(A), fb = f(B);
    if (fa >= 0) out.push(A);
    if ((fa >= 0) !== (fb >= 0)) out.push(lerpV(A, B, fa / (fa - fb)));
  }
  return out;
}
const polyArea = q => q.reduce((s, a, i) => { const b = q[(i + 1) % q.length]; return s + a.u * b.v - b.u * a.v; }, 0) / 2;
function subtractRect(poly, r){
  const us = poly.map(q => q.u), vs = poly.map(q => q.v);
  if (Math.max(...us) <= r.u0 || Math.min(...us) >= r.u1 || Math.max(...vs) <= r.v0 || Math.min(...vs) >= r.v1) return [poly];
  const mid = clip(clip(poly, q => q.u - r.u0), q => r.u1 - q.u);
  return [clip(poly, q => r.u0 - q.u), clip(poly, q => q.u - r.u1), clip(mid, q => r.v0 - q.v), clip(mid, q => q.v - r.v1)]
    .filter(q => q.length >= 3 && Math.abs(polyArea(q)) > 1e-7);
}

// Rebuild a mesh's geometry with chosen triangles cut by rectangles (or dropped). Returns its undo.
function cutMesh(mesh, triSet, frame, rects, dropAll){
  const old = mesh.geometry, g = old.index ? old.toNonIndexed() : old.clone(), T = worldTris(mesh);
  const names = Object.keys(g.attributes).filter(k => g.attributes[k].itemSize <= 4);
  const groups = g.groups.length ? g.groups : [{ start: 0, count: g.attributes.position.count, materialIndex: 0 }];
  const out = new Map();
  const bucket = mi => { if (!out.has(mi)) out.set(mi, Object.fromEntries(names.map(k => [k, []]))); return out.get(mi); };
  const copyVert = (bk, vi) => { for (const k of names) { const a = g.attributes[k]; for (let c = 0; c < a.itemSize; c++) bk[k].push(a.getComponent(vi, c)); } };
  const mixVert = (bk, t, b) => { for (const k of names) { const a = g.attributes[k]; for (let c = 0; c < a.itemSize; c++) bk[k].push(b[0] * a.getComponent(t * 3, c) + b[1] * a.getComponent(t * 3 + 1, c) + b[2] * a.getComponent(t * 3 + 2, c)); } };
  for (const grp of groups) for (let t = grp.start / 3; t < (grp.start + grp.count) / 3; t++) {
    const bk = bucket(grp.materialIndex || 0);
    if (!triSet.has(t)) { copyVert(bk, t * 3); copyVert(bk, t * 3 + 1); copyVert(bk, t * 3 + 2); continue; }
    if (dropAll) continue;
    let polys = [[0, 1, 2].map(k => { const [u, v] = frame.uv(triV(T, t, k)); return { u, v, b: [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0] }; })];
    for (const r of rects) polys = polys.flatMap(q => subtractRect(q, r));
    for (const q of polys) for (let i = 1; i + 1 < q.length; i++) { mixVert(bk, t, q[0].b); mixVert(bk, t, q[i].b); mixVert(bk, t, q[i + 1].b); }
  }
  const ng = new THREE.BufferGeometry(), keys = [...out.keys()].sort((a, b) => a - b);
  let start = 0;
  for (const k of names) {
    const a = g.attributes[k], arr = keys.flatMap(mi => out.get(mi)[k]);
    ng.setAttribute(k, new THREE.BufferAttribute(new (a.array.constructor)(arr), a.itemSize, a.normalized));
  }
  for (const mi of keys) { const c = out.get(mi).position.length / 3; ng.addGroup(start, c, mi); start += c; }
  ng.computeBoundingBox(); ng.computeBoundingSphere();
  if (g !== old) g.dispose();
  mesh.geometry = ng;
  return () => { ng.dispose(); mesh.geometry = old; };
}

// The flat, connected patch of wall around a click, and a 2D frame on it (u to the right as seen, v up).
function facePatch(hit, rayDir){
  const mesh = hit.object, T = worldTris(mesh), nt = T.length / 9;
  const n = triNormal(T, hit.faceIndex);
  if (!n) return { error: "That face is too small to work on." };
  if (n.dot(rayDir) > 0) n.negate();
  if (Math.abs(n.y) > 0.35) return { error: "Click a wall. That face isn't vertical enough for windows." };
  const o = hit.point.clone(), U = new THREE.Vector3().crossVectors(Y, n).normalize(), V = new THREE.Vector3().crossVectors(n, U).normalize();
  const frame = { o, n, U, V, uv: p => { const d = p.clone().sub(o); return [d.dot(U), d.dot(V)]; }, at: (u, v, w = 0) => o.clone().addScaledVector(U, u).addScaledVector(V, v).addScaledVector(n, w) };
  const cop = new Set(), key = (t, k) => `${Math.round(T[t * 9 + k * 3] * 1000)},${Math.round(T[t * 9 + k * 3 + 1] * 1000)},${Math.round(T[t * 9 + k * 3 + 2] * 1000)}`;
  const byVert = new Map();
  for (let t = 0; t < nt; t++) {
    const m = triNormal(T, t);
    if (!m || Math.abs(m.dot(n)) < 0.995 || Math.abs(triV(T, t, 0).sub(o).dot(n)) > 0.02) continue;
    cop.add(t);
    for (let k = 0; k < 3; k++) { const kk = key(t, k); if (!byVert.has(kk)) byVert.set(kk, []); byVert.get(kk).push(t); }
  }
  const region = new Set([hit.faceIndex]), queue = [hit.faceIndex];
  while (queue.length) { const t = queue.pop(); for (let k = 0; k < 3; k++) for (const s of byVert.get(key(t, k)) || []) if (!region.has(s)) { region.add(s); queue.push(s); } }
  const tris2 = [...region].map(t => [0, 1, 2].map(k => frame.uv(triV(T, t, k))));
  const all = tris2.flat(), us = all.map(q => q[0]), vs = all.map(q => q[1]);
  return { mesh, T, region, tris2, frame, umin: Math.min(...us), umax: Math.max(...us), vmin: Math.min(...vs), vmax: Math.max(...vs) };
}
function inTri(u, v, [a, b, c]){
  const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]); if (Math.abs(d) < 1e-12) return false;
  const l1 = ((b[1] - c[1]) * (u - c[0]) + (c[0] - b[0]) * (v - c[1])) / d, l2 = ((c[1] - a[1]) * (u - c[0]) + (a[0] - c[0]) * (v - c[1])) / d;
  return l1 >= -1e-4 && l2 >= -1e-4 && 1 - l1 - l2 >= -1e-4;
}
const inPatch = (patch, u, v) => patch.tris2.some(t => inTri(u, v, t));
function lineIntervals(patch, axis, c){   // where a vertical (axis 0: u = c) or horizontal (axis 1: v = c) line crosses the patch
  const iv = [];
  for (const t of patch.tris2) {
    const hits = [];
    for (let k = 0; k < 3; k++) {
      const A = t[k], B = t[(k + 1) % 3], fa = A[axis] - c, fb = B[axis] - c;
      if (fa === 0) hits.push(A[1 - axis]);
      if (fa * fb < 0) hits.push(A[1 - axis] + (B[1 - axis] - A[1 - axis]) * fa / (fa - fb));
    }
    if (hits.length >= 2) iv.push([Math.min(...hits), Math.max(...hits)]);
  }
  iv.sort((a, b) => a[0] - b[0]);
  const m = [];
  for (const s of iv) { if (m.length && s[0] <= m[m.length - 1][1] + 1e-3) m[m.length - 1][1] = Math.max(m[m.length - 1][1], s[1]); else m.push([...s]); }
  return m;
}
// Parallel faces behind the patch (the inside face of a solid wall) within maxDepth, mesh -> triangle set.
function backFaces(root, patch, maxDepth, overlaps){
  const { frame } = patch, found = new Map(); let depth = Infinity;
  const box = new THREE.Box3(frame.at(patch.umin, patch.vmin, 0), frame.at(patch.umin, patch.vmin, 0));
  for (const [u, v] of [[patch.umax, patch.vmin], [patch.umin, patch.vmax], [patch.umax, patch.vmax]]) box.expandByPoint(frame.at(u, v, 0));
  box.expandByScalar(maxDepth);
  root.traverse(m => {
    if (!m.isMesh || !m.visible || !m.geometry || !m.geometry.attributes.position) return;
    if (!new THREE.Box3().setFromObject(m).intersectsBox(box)) return;
    const T = worldTris(m), set = new Set();
    for (let t = 0; t < T.length / 9; t++) {
      if (m === patch.mesh && patch.region.has(t)) continue;
      const nn = triNormal(T, t); if (!nn || Math.abs(nn.dot(frame.n)) < 0.995) continue;
      const c = triV(T, t, 0).add(triV(T, t, 1)).add(triV(T, t, 2)).divideScalar(3), dd = c.clone().sub(frame.o).dot(frame.n);
      if (dd > -0.02 || dd < -maxDepth) continue;
      const q = [0, 1, 2].map(k => frame.uv(triV(T, t, k)));
      if (!overlaps(q)) continue;
      set.add(t); depth = Math.min(depth, -dd);
    }
    if (set.size) found.set(m, set);
  });
  return { found, depth: Number.isFinite(depth) ? depth : 0 };
}

function addMeshes(root, accs, names){
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert(), out = [];
  for (const [acc, name, material] of accs) {
    const g = acc.geometry(); if (!g) continue;
    g.applyMatrix4(inv);
    const m = new THREE.Mesh(g, material); m.name = name; root.add(m); out.push(m);
  }
  return out;
}

/** Punch windows into, or curtain-glaze, the flat wall patch that was clicked. */
export function applyFaceOp(root, hit, rayDir, opts, wallMaterial){
  const patch = facePatch(hit, rayDir);
  if (patch.error) return { ok: false, message: patch.error };
  root.updateMatrixWorld(true);
  const { frame } = patch, M = editMats(), acc = { frame: new Acc(), glass: new Acc(), wall: new Acc() };
  const H = patch.vmax - patch.vmin, bands = Math.max(1, Math.round(H / opts.storeyHeight)), bh = H / bands;
  const P = (u, v, w) => frame.at(u, v, w).toArray(), ex = frame.U.toArray(), ey = frame.V.toArray(), ez = frame.n.toArray();
  const undos = [], dims = [], toRoot = (u, v, w) => root.worldToLocal(frame.at(u, v, w)).toArray();
  const dim = (key, a, b, hint) => dims.push({ key, a, b, value: opts[key], unit: "m", step: 0.1, min: LIMITS[key][0], max: LIMITS[key][1], hint });

  if (opts.mode === "curtain") {
    const back = backFaces(root, patch, 0.8, q => { const c = [(q[0][0] + q[1][0] + q[2][0]) / 3, (q[0][1] + q[1][1] + q[2][1]) / 3]; return inPatch(patch, c[0], c[1]); });
    undos.push(cutMesh(patch.mesh, patch.region, frame, [], true));
    for (const [m, set] of back.found) undos.push(cutMesh(m, set, frame, [], true));
    const w = back.depth ? -Math.min(back.depth / 2, 0.1) : 0;
    for (const t of patch.tris2) acc.glass.tri(...t.map(([u, v]) => P(u, v, w)));
    const f = FRAME, pane = Math.max(0.3, opts.windowWidth), span = patch.umax - patch.umin, cols = Math.max(1, Math.round(span / pane));
    for (let k = 0; k <= cols; k++) {
      const u = Math.min(patch.umax - f / 2, Math.max(patch.umin + f / 2, patch.umin + span * k / cols));
      for (const [a, b] of lineIntervals(patch, 0, u)) acc.frame.box(P(u, (a + b) / 2, w), ex, ey, ez, f, b - a, FRAME_DEPTH);
    }
    for (let k = 0; k <= bands; k++) {
      const v = Math.min(patch.vmax - f / 2, Math.max(patch.vmin + f / 2, patch.vmin + bh * k));
      for (const [a, b] of lineIntervals(patch, 1, v)) acc.frame.box(P((a + b) / 2, v, w), ex, ey, ez, b - a, f, FRAME_DEPTH);
    }
    const added = addMeshes(root, [[acc.glass, "Added curtain wall glazing", M.glass], [acc.frame, "Added curtain wall mullions", M.frame]]);
    const u0 = patch.umin, pw = span / cols;
    dim("windowWidth", toRoot(u0, patch.vmin + 0.5, 0.1), toRoot(u0 + pw, patch.vmin + 0.5, 0.1), "Pane width");
    if (bands > 1 || H > 2) dim("storeyHeight", toRoot(patch.umax + 0.4, patch.vmin, 0.1), toRoot(patch.umax + 0.4, patch.vmin + bh, 0.1), "Transom spacing (storey height)");
    return { ok: true, message: `Glazed a ${span.toFixed(2)} × ${H.toFixed(2)} m wall: ${cols} bays, ${bands} storey${bands > 1 ? "s" : ""}.`, added, undo: () => { added.forEach(m => { root.remove(m); m.geometry.dispose(); }); undos.reverse().forEach(u => u()); }, dims };
  }

  const ww = opts.windowWidth, rects = [];
  for (let b = 0; b < bands; b++) {
    const vb = patch.vmin + b * bh, sill = vb + Math.min(opts.sillHeight, bh - 0.45), head = Math.min(sill + opts.windowHeight, vb + bh - 0.15);
    if (head - sill < 0.3) continue;
    const pitch = Math.max(opts.windowPitch, ww + 0.2), span = patch.umax - patch.umin, k = Math.floor((span - 0.6 - ww) / pitch) + 1;
    for (let j = 0; j < k; j++) {
      const uc = (patch.umin + patch.umax) / 2 + (j - (k - 1) / 2) * pitch, r = { u0: uc - ww / 2, u1: uc + ww / 2, v0: sill, v1: head, vb, panes: Math.max(1, Math.ceil(ww / 1.6)) };
      let inside = true;
      for (let a = 0; a <= 2 && inside; a++) for (let c = 0; c <= 2 && inside; c++) inside = inPatch(patch, r.u0 + 0.01 + (ww - 0.02) * a / 2, r.v0 + 0.01 + (r.v1 - r.v0 - 0.02) * c / 2);
      if (inside) rects.push(r);
    }
  }
  if (!rects.length) return { ok: false, message: "No room on that wall for a window of this size. Try a smaller width or height." };
  const overlap = q => rects.some(r => Math.max(...q.map(x => x[0])) > r.u0 && Math.min(...q.map(x => x[0])) < r.u1 && Math.max(...q.map(x => x[1])) > r.v0 && Math.min(...q.map(x => x[1])) < r.v1);
  const back = backFaces(root, patch, 0.8, overlap), dd = back.depth;
  undos.push(cutMesh(patch.mesh, patch.region, frame, rects, false));
  for (const [m, set] of back.found) undos.push(cutMesh(m, set, frame, rects, false));
  for (const r of rects) {
    if (dd > 0) {
      acc.wall.quad(P(r.u0, r.v0, 0), P(r.u1, r.v0, 0), P(r.u1, r.v0, -dd), P(r.u0, r.v0, -dd));
      acc.wall.quad(P(r.u0, r.v1, 0), P(r.u0, r.v1, -dd), P(r.u1, r.v1, -dd), P(r.u1, r.v1, 0));
      acc.wall.quad(P(r.u0, r.v0, 0), P(r.u0, r.v0, -dd), P(r.u0, r.v1, -dd), P(r.u0, r.v1, 0));
      acc.wall.quad(P(r.u1, r.v0, 0), P(r.u1, r.v1, 0), P(r.u1, r.v1, -dd), P(r.u1, r.v0, -dd));
    }
    windowUnit(acc, P, ex, ey, ez, r, -dd * 0.4);
  }
  const added = addMeshes(root, [[acc.glass, "Added window glazing", M.glass], [acc.frame, "Added window frames", M.frame], [acc.wall, "Added window reveals", wallMaterial]]);
  const r0 = rects[0], r1 = rects.find(r => r !== r0 && r.vb === r0.vb);
  dim("windowWidth", toRoot(r0.u0, r0.v0 - 0.3, 0.1), toRoot(r0.u1, r0.v0 - 0.3, 0.1), "Window width");
  dim("windowHeight", toRoot(r0.u1 + 0.3, r0.v0, 0.1), toRoot(r0.u1 + 0.3, r0.v1, 0.1), "Window height");
  dim("sillHeight", toRoot(r0.u0 - 0.3, r0.vb, 0.1), toRoot(r0.u0 - 0.3, r0.v0, 0.1), "Sill height above the floor band");
  if (r1) dim("windowPitch", toRoot((r0.u0 + r0.u1) / 2, r0.v1 + 0.3, 0.1), toRoot((r1.u0 + r1.u1) / 2, r0.v1 + 0.3, 0.1), "Window spacing, centre to centre");
  if (bands > 1) dim("storeyHeight", toRoot(patch.umax + 0.4, patch.vmin, 0.1), toRoot(patch.umax + 0.4, patch.vmin + bh, 0.1), "Floor band height (storey height)");
  return {
    ok: true,
    message: `Added ${rects.length} window${rects.length > 1 ? "s" : ""} over ${bands} floor band${bands > 1 ? "s" : ""}` + (dd > 0 ? `, ${Math.round(dd * 1000)} mm reveals.` : ". The wall has no inside face, so there are no reveals."),
    added, undo: () => { added.forEach(m => { root.remove(m); m.geometry.dispose(); }); undos.reverse().forEach(u => u()); }, dims,
  };
}

/** Take a part out of the model (kept for undo). */
export function removePart(hit){
  const mesh = hit.object, parent = mesh.parent;
  if (!parent) return { ok: false, message: "Nothing to remove there." };
  parent.remove(mesh);
  return { ok: true, message: `Removed "${mesh.name || "part"}".`, undo: () => parent.add(mesh) };
}

/** "12.5", "1800mm", "3*4", "(10+2.5)/2", "45°" -> number (metres or plain), or NaN. */
export function parseDim(text){
  let s = String(text || "").trim().toLowerCase().replace(/,/g, "."), scale = 1;
  const unit = s.match(/(mm|cm|m|°|deg|storeys?|stories)$/);
  if (unit) { s = s.slice(0, -unit[1].length).trim(); scale = unit[1] === "mm" ? 0.001 : unit[1] === "cm" ? 0.01 : 1; }
  let i = 0;
  const peek = () => s[i], ws = () => { while (s[i] === " ") i++; };
  function num(){ ws(); const m = s.slice(i).match(/^\d*\.?\d+/); if (!m) throw 0; i += m[0].length; return parseFloat(m[0]); }
  function atom(){ ws(); if (peek() === "(") { i++; const v = expr(); ws(); if (peek() !== ")") throw 0; i++; return v; } if (peek() === "-") { i++; return -atom(); } return num(); }
  function term(){ let v = atom(); for (;;) { ws(); const c = peek(); if (c === "*" || c === "x") { i++; v *= atom(); } else if (c === "/") { i++; v /= atom(); } else return v; } }
  function expr(){ let v = term(); for (;;) { ws(); const c = peek(); if (c === "+") { i++; v += term(); } else if (c === "-") { i++; v -= term(); } else return v; } }
  try { const v = expr(); ws(); return i === s.length && Number.isFinite(v) ? v * scale : NaN; } catch { return NaN; }
}

/* ---------------- Single elements: a horizontal slab, a vertical wall or an angled roof plane ----------------
   Each one is a solid with its own thickness, placed at an anchor in the model's own coordinates. */
export const ELEMENT_DEFAULTS = {
  slab: { length: 6, width: 4, thickness: 0.25 },
  wall: { length: 6, height: 3, thickness: 0.2 },
  roof: { length: 6, width: 4, thickness: 0.25, pitchDeg: 25 },
};
const ELEMENT_LIMITS = { length: [0.1, 200], width: [0.1, 200], height: [0.1, 100], thickness: [0.01, 3], pitchDeg: [0, 75], y: [-50, 500], angleDeg: [-360, 360] };
let elementMats = null;
export function elementMaterial(kind){
  elementMats = elementMats || {
    slab: mat("Added slab", 0xb9b4a8), wall: mat("Added wall", 0xd6d1c4), roof: mat("Added roof", 0x6b6459),
  };
  return elementMats[kind];
}
export function clampElement(e){
  const out = { ...ELEMENT_DEFAULTS[e.kind], ...e };
  for (const [k, [lo, hi]] of Object.entries(ELEMENT_LIMITS)) if (k in out) out[k] = Math.min(hi, Math.max(lo, Number(out[k]) || 0));
  return out;
}
// Local frame of an element: along its length (ex), across (ez), both horizontal.
const elFrame = e => { const a = THREE.MathUtils.degToRad(e.angleDeg || 0); return { ex: [Math.cos(a), 0, -Math.sin(a)], ez: [Math.sin(a), 0, Math.cos(a)] }; };
export function elementGeometry(raw){
  const e = clampElement(raw), { ex, ez } = elFrame(e), acc = new Acc(), o = [e.x, e.y, e.z];
  const at = (u, v, w) => [o[0] + ex[0] * u + ez[0] * w, o[1] + v, o[2] + ex[2] * u + ez[2] * w];
  if (e.kind === "slab") acc.box(at(0, e.thickness / 2, 0), ex, [0, 1, 0], ez, e.length, e.thickness, e.width);
  else if (e.kind === "wall") acc.box(at(0, e.height / 2, 0), ex, [0, 1, 0], ez, e.length, e.height, e.thickness);
  else {
    // low edge at the anchor height on the -w side, rising across its width at the pitch; thickness below the top face
    const tan = Math.tan(THREE.MathUtils.degToRad(e.pitchDeg)), rise = e.width * tan, L = e.length / 2, Wd = e.width / 2;
    acc.thick([at(-L, e.thickness, -Wd), at(L, e.thickness, -Wd), at(L, e.thickness + rise, Wd), at(-L, e.thickness + rise, Wd)], e.thickness);
  }
  return acc.geometry();
}
export function elementDims(raw){
  const e = clampElement(raw), { ex, ez } = elFrame(e), o = [e.x, e.y, e.z];
  const at = (u, v, w) => [o[0] + ex[0] * u + ez[0] * w, o[1] + v, o[2] + ex[2] * u + ez[2] * w];
  const d = (key, a, b, hint, extra = {}) => ({ key, a, b, value: e[key], unit: "m", step: 0.1, min: ELEMENT_LIMITS[key][0], max: ELEMENT_LIMITS[key][1], hint, ...extra });
  const L = e.length / 2, out = [];
  if (e.kind === "wall") {
    const off = e.thickness / 2 + 0.5;
    out.push(d("length", at(-L, 0, off), at(L, 0, off), "Wall length"));
    out.push(d("height", at(L + 0.4, 0, off), at(L + 0.4, e.height, off), "Wall height"));
    out.push(d("thickness", at(-L, e.height + 0.3, -e.thickness / 2), at(-L, e.height + 0.3, e.thickness / 2), "Wall thickness", { step: 0.01 }));
  } else {
    const Wd = e.width / 2, rise = e.kind === "roof" ? e.width * Math.tan(THREE.MathUtils.degToRad(e.pitchDeg)) : 0, top = e.thickness;
    out.push(d("length", at(-L, top, -Wd - 0.5), at(L, top, -Wd - 0.5), e.kind === "roof" ? "Roof plane length (along the eave)" : "Slab length"));
    out.push(d("width", at(L + 0.5, top, -Wd), at(L + 0.5, top + rise, Wd), e.kind === "roof" ? "Roof plane width, measured on plan" : "Slab width"));
    out.push(d("thickness", at(-L - 0.4, 0, -Wd), at(-L - 0.4, top, -Wd), e.kind === "roof" ? "Roof thickness" : "Slab thickness", { step: 0.01 }));
    if (e.kind === "roof") out.push({ key: "pitchDeg", a: at(0, top + rise / 2 + 0.6, 0), value: e.pitchDeg, unit: "°", step: 1, min: 0, max: 75, point: true, hint: "Pitch" });
  }
  out.push({ key: "y", a: at(0, 0, 0), b: [o[0], 0, o[2]], value: e.y, unit: "m", step: 0.1, min: -50, max: 500, hint: "Height above the ground", offsetPx: [0, 0] });
  out.push({ key: "angleDeg", a: at(0, (e.kind === "wall" ? e.height : e.thickness) + 1.2, 0), value: e.angleDeg || 0, unit: "°", step: 15, min: -360, max: 360, point: true, hint: "Rotation" });
  return out;
}
/** Where a new element goes for a click: on the face that was hit, else on the ground plane. */
export function elementFromClick(kind, root, hit, ray, cameraRight){
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  let pw = hit ? hit.point.clone() : null, angle;
  if (!pw) {
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -new THREE.Vector3().setFromMatrixPosition(root.matrixWorld).y);
    pw = ray.intersectPlane(plane, new THREE.Vector3());
    if (!pw) return null;
  }
  const local = pw.clone().applyMatrix4(inv);
  let dir = cameraRight.clone();
  if (hit && hit.face) {
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    if (Math.abs(n.y) < 0.35) dir = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), n);   // on a wall: run along it
  }
  dir.transformDirection(inv); dir.y = 0;
  angle = Math.round(THREE.MathUtils.radToDeg(Math.atan2(-dir.z, dir.x)) / 15) * 15;   // snapped to 15°
  return clampElement({ kind, x: local.x, y: local.y, z: local.z, angleDeg: angle });
}

/* ---------------- Reading a description locally (no AI) ----------------
   Only what the words say is used. Everything it read is listed back, and anything it had to assume says so. */
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60 };
export function parseDescription(text){
  let t = " " + String(text || "").toLowerCase().replace(/[–—]/g, "-").replace(/,(\d)/g, ".$1") + " ";
  t = t.replace(/\b(single|one)[- ]stor(e?y|ies)\b/g, "1 storey").replace(/\bdouble[- ]stor(e?y|ies)\b/g, "2 storey");
  t = t.replace(new RegExp(`\\b(${Object.keys(WORDS).join("|")})\\b`, "g"), w => String(WORDS[w]));
  const P = {}, read = [], assumed = [];
  const NUM = "(\\d+(?:\\.\\d+)?)", U = "\\s*(mm|cm|m|metres?|meters?)?";
  const m2 = (v, u, mmIfBig) => { v = parseFloat(v); if (u === "mm") return v / 1000; if (u === "cm") return v / 100; if (!u && mmIfBig && v >= 20) return v / 1000; return v; };
  const find = re => t.match(re);
  const fmt = v => `${+v.toFixed(3)} m`;

  // "W x D" pairs: a window size if it sits next to "window", otherwise the footprint
  for (const m of t.matchAll(new RegExp(`${NUM}${U}\\s*(?:x|by|×|\\*)\\s*${NUM}${U}`, "g"))) {
    const near = t.slice(Math.max(0, m.index - 16), m.index + m[0].length + 12);
    const a = m2(m[1], m[2] || m[4]), b = m2(m[3], m[4] || m[2]);
    if (/window|opening|pane/.test(near)) { if (P.windowWidth == null) { P.windowWidth = a; P.windowHeight = b; read.push(`windows ${fmt(a)} wide × ${fmt(b)} high`); } }
    else if (P.width == null) { P.width = a; P.depth = b; read.push(`footprint ${fmt(a)} × ${fmt(b)}`); }
  }
  let m;
  if (P.width == null && (m = find(new RegExp(`${NUM}${U}\\s*(?:wide|in width|frontage)`)))) { P.width = m2(m[1], m[2]); read.push(`width ${fmt(P.width)}`); }
  if (P.depth == null && (m = find(new RegExp(`${NUM}${U}\\s*(?:deep|in depth)(?!\\s*(?:balcon|wing))`)))) { P.depth = m2(m[1], m[2]); read.push(`depth ${fmt(P.depth)}`); }
  if (P.width == null && (m = find(new RegExp(`${NUM}${U}\\s*long`)))) { P.width = m2(m[1], m[2]); read.push(`length ${fmt(P.width)} (as width)`); }
  if ((m = find(new RegExp(`(?:diameter(?: of)?\\s*${NUM}${U})|(?:${NUM}${U}\\s*(?:diameter|across))`)))) {
    const v = m[1] ? m2(m[1], m[2]) : m2(m[3], m[4]); P.width = P.depth = v; P.shape = "round"; read.push(`round, ${fmt(v)} across`);
  }

  if (/\bl[- ]?(shape|shaped|plan)\b/.test(t)) { P.shape = "L"; read.push("L-shaped plan"); }
  else if (/\bu[- ]?(shape|shaped|plan)\b/.test(t)) { P.shape = "U"; read.push("U-shaped plan"); }
  else if (/courtyard|atrium|perimeter block/.test(t)) { P.shape = "courtyard"; read.push("courtyard plan"); }
  else if (!P.shape && /\b(round|circular|cylind\w*|oval|ellip\w*|drum)\b/.test(t)) { P.shape = "round"; read.push("round plan"); }
  if ((m = find(new RegExp(`${NUM}${U}\\s*(?:deep\\s*|wide\\s*)?wings?`))) || (m = find(new RegExp(`wings?\\s*(?:of|are|is)?\\s*${NUM}${U}`)))) { P.wing = m2(m[1], m[2]); read.push(`wings ${fmt(P.wing)} deep`); }

  if ((m = find(/(\d+)\s*-?\s*(?:storey|story|stories|storeys|floors?|levels?)\b(?!\s*(?:-|\s)?to)/))) { P.storeys = parseInt(m[1], 10); read.push(`${P.storeys} storey${P.storeys > 1 ? "s" : ""}`); }
  if ((m = find(new RegExp(`${NUM}${U}\\s*(?:floor[- ]to[- ]floor|storey heights?|floor heights?|per (?:floor|storey|level))`))) || (m = find(new RegExp(`(?:floor[- ]to[- ]floor|storey height|floor height)\\s*(?:of|is|at)?\\s*${NUM}${U}`)))) {
    P.storeyHeight = m2(m[1], m[2]); read.push(`${fmt(P.storeyHeight)} floor to floor`);
  }
  if ((m = find(new RegExp(`${NUM}${U}\\s*(?:tall|high|in height)\\b`))) || (m = find(new RegExp(`height\\s*(?:of|is)?\\s*${NUM}${U}`)))) {
    const h = m2(m[1], m[2]), ts = P.slabThickness || DEFAULTS.slabThickness;
    if (P.storeys) { P.storeyHeight = (h - ts) / P.storeys; read.push(`${fmt(h)} tall, so ${fmt(P.storeyHeight)} per storey`); }
    else { const sh = P.storeyHeight || DEFAULTS.storeyHeight; P.storeys = Math.max(1, Math.round((h - ts) / sh)); read.push(`${fmt(h)} tall`); assumed.push(`${P.storeys} storeys from the height at ${fmt(sh)} each`); }
  }

  if (/curtain[- ]?wall|fully glazed|all[- ]glass|glass (?:facade|façade|box|skin)/.test(t)) { P.windowType = "curtain"; read.push("curtain wall glazing"); }
  else if (/ribbon|strip windows|band(?:ed)? windows|horizontal windows/.test(t)) { P.windowType = "ribbon"; read.push("ribbon windows"); }
  else if (/no windows|windowless|blank walls?|solid walls?/.test(t)) { P.windowType = "none"; read.push("no windows"); }
  else if (/punched|windows?\b/.test(t)) { P.windowType = "punched"; read.push("punched windows"); }
  if (P.windowWidth == null && (m = find(new RegExp(`${NUM}${U}\\s*wide\\s*windows?|windows?\\s*${NUM}${U}\\s*wide`)))) { P.windowWidth = m2(m[1] || m[3], m[2] || m[4]); read.push(`windows ${fmt(P.windowWidth)} wide`); }
  if ((m = find(new RegExp(`(?:sills?\\s*(?:height)?\\s*(?:of|at)?\\s*${NUM}${U})|(?:${NUM}${U}\\s*sills?)`)))) { P.sillHeight = m[1] ? m2(m[1], m[2], true) : m2(m[3], m[4], true); read.push(`sills at ${fmt(P.sillHeight)}`); }
  if ((m = find(new RegExp(`${NUM}${U}\\s*(?:centres|centers|c/c|apart|spacing)|spaced\\s*(?:at|every)?\\s*${NUM}${U}`)))) { P.windowPitch = m[1] ? m2(m[1], m[2], true) : m2(m[3], m[4], true); read.push(`windows at ${fmt(P.windowPitch)} centres`); }

  if ((m = find(new RegExp(`${NUM}${U}\\s*(?:deep\\s*)?(?:balcon\\w*|terrac\\w*|slab edges?|overhanging slabs?)`)))) { P.slabEdge = m2(m[1], m[2], true); read.push(`balconies ${fmt(P.slabEdge)} deep`); }
  else if (/balcon|wrap[- ]?around terrac/.test(t)) { P.slabEdge = 1.5; assumed.push("balconies 1.5 m deep (no depth given)"); }

  if ((m = find(/split[- ]?level\w*\s*(?:of|by)?\s*(\d+(?:\.\d+)?)\s*(mm|cm|m)\b/)) || (m = find(/(\d+(?:\.\d+)?)\s*(mm|cm|m)\s*split/))) { P.split = m2(m[1], m[2]); read.push(`split level, back half up ${fmt(P.split)}`); }
  else if (find(/split[- ]?level/)) { P.split = 1.6; assumed.push("split level: back half up 1.6 m (half a 3.2 m storey)"); }
  if ((m = find(/(-?\d+(?:\.\d+)?)\s*(?:°|deg\w*)\s*(?:twist\w*)?\s*(?:per|each|a|every)\s*(?:floor|storey|level)/)) || (m = find(/twist\w*\s*(?:by|of)?\s*(-?\d+(?:\.\d+)?)\s*(?:°|deg\w*)/))) { P.twistDeg = parseFloat(m[1]); read.push(`twist ${P.twistDeg}° per storey`); }
  else if (/twist|rotating floors|spiral/.test(t)) { P.twistDeg = 2; assumed.push("twist 2° per storey (no angle given)"); }
  if ((m = find(/taper\w*\s*(?:to|down to)?\s*(\d+)\s*%/))) { P.taper = parseFloat(m[1]); read.push(`tapers to ${P.taper}% at the top`); }
  else if (/taper|narrow\w* (?:to|towards) the top|pyramid/.test(t)) { P.taper = 70; assumed.push("tapers to 70% at the top (no figure given)"); }
  else if ((m = find(/(?:flare|widen)\w*\s*(?:to)?\s*(\d+)\s*%/))) { P.taper = parseFloat(m[1]); read.push(`widens to ${P.taper}% at the top`); }

  if (/\bhip(ped)?\b/.test(t)) { P.roofType = "hip"; read.push("hip roof"); }
  else if (/\bgable[ds]?\b|pitched roof|\bpitched\b/.test(t)) { P.roofType = "gable"; read.push("gable roof"); }
  else if (/\b(mono[- ]?pitch|skillion|shed roof|lean[- ]to|single[- ]pitch)\b/.test(t)) { P.roofType = "mono"; read.push("mono-pitch roof"); }
  else if (/flat roof|roof terrace|roof garden/.test(t)) { P.roofType = "flat"; read.push("flat roof"); }
  if ((m = find(/(\d+(?:\.\d+)?)\s*(?:°|deg\w*)\s*(?:roof\s*)?pitch/)) || (m = find(/pitch(?:ed)?\s*(?:of|at)?\s*(\d+(?:\.\d+)?)\s*(?:°|deg\w*)/))) { P.roofPitchDeg = parseFloat(m[1]); read.push(`roof pitch ${P.roofPitchDeg}°`); }
  if ((m = find(new RegExp(`${NUM}${U}\\s*(?:eaves?|overhangs?)`))) || (m = find(new RegExp(`(?:eaves?|overhangs?)\\s*(?:of)?\\s*${NUM}${U}`)))) { P.overhang = m2(m[1], m[2], true); read.push(`${fmt(P.overhang)} eaves`); if (!/parapet/.test(t)) P.parapet = 0; }
  if ((m = find(new RegExp(`${NUM}${U}\\s*(?:high\\s*)?parapets?`)))) { P.parapet = m2(m[1], m[2], true); read.push(`${fmt(P.parapet)} parapet`); }
  else if (/no parapet/.test(t)) { P.parapet = 0; read.push("no parapet"); }

  // thicknesses: "300mm walls", "walls 300 thick", "250mm slabs", "roof 200mm thick"
  const thick = (key, word, label) => {
    const r1 = new RegExp(`${NUM}${U}\\s*(?:thick\\s*)?(?:${word})`), r2 = new RegExp(`(?:${word})\\s*(?:are|is|of)?\\s*${NUM}${U}\\s*thick`);
    const mm = t.match(r1) || t.match(r2);
    if (mm) { P[key] = m2(mm[1], mm[2], true); read.push(`${label} ${Math.round(P[key] * 1000)} mm thick`); }
  };
  thick("wallThickness", "walls?", "walls"); thick("slabThickness", "slabs?|floor plates?|floors? slabs?", "slabs"); thick("roofThickness", "roof(?! terrace)", "roof");

  return { params: P, read, assumed };
}

/* ---------------- Reading a plan sketch ----------------
   Input is what Apple Vision found in the image (see Sketch.swift): closed outlines with their nesting, and the
   words with their positions. Outlines become blocks; a number inside one is its storeys; a length like "40m" next
   to an edge sets the scale; an outline inside another is a courtyard if it says so (or says nothing), or a block
   standing on it if it has storeys. Whatever had to be assumed is said so. */
const shoelace = q => q.reduce((s, a, i) => { const b = q[(i + 1) % q.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0) / 2;
const perim = q => q.reduce((s, a, i) => { const b = q[(i + 1) % q.length]; return s + Math.hypot(b[0] - a[0], b[1] - a[1]); }, 0);
function insidePoly(q, [x, y]){
  let c = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const [xi, yi] = q[i], [xj, yj] = q[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
// drop vertices that sit (within tol) on the line between their neighbours
function dropStraight(q, tol){
  const r = q.slice();
  for (let i = 0; i < r.length && r.length > 3; i++) {
    const A = r[(i - 1 + r.length) % r.length], P = r[i], B = r[(i + 1) % r.length], L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1e-9;
    const along = ((P[0] - A[0]) * (B[0] - A[0]) + (P[1] - A[1]) * (B[1] - A[1])) / (L * L);
    if (along > 0 && along < 1 && Math.abs((B[0] - A[0]) * (A[1] - P[1]) - (A[0] - P[0]) * (B[1] - A[1])) / L < tol) { r.splice(i, 1); i = -1; }
  }
  return r;
}
function dpSimplify(q, tol){   // Douglas–Peucker on a closed loop, split at the two farthest-apart points
  if (q.length < 5) return q.slice();
  let a = 0, b = 0, best = -1;
  for (let i = 0; i < q.length; i++) { const dd = Math.hypot(q[i][0] - q[0][0], q[i][1] - q[0][1]); if (dd > best) { best = dd; b = i; } }
  const run = pts => {
    if (pts.length < 3) return pts;
    const [A, B] = [pts[0], pts[pts.length - 1]], L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1e-9;
    let k = -1, m = -1;
    for (let i = 1; i < pts.length - 1; i++) {
      const dd = Math.abs((B[0] - A[0]) * (A[1] - pts[i][1]) - (A[0] - pts[i][0]) * (B[1] - A[1])) / L;
      if (dd > m) { m = dd; k = i; }
    }
    return m > tol ? [...run(pts.slice(0, k + 1)).slice(0, -1), ...run(pts.slice(k))] : [A, B];
  };
  const r1 = run(q.slice(a, b + 1)), r2 = run([...q.slice(b), q[0]]);
  let r = [...r1.slice(0, -1), ...r2.slice(0, -1)];
  // the two split points can land mid-edge: drop any vertex that sits on the line through its neighbours
  for (let changed = true; changed && r.length > 3;) {
    changed = false;
    for (let i = 0; i < r.length && r.length > 3; i++) {
      const A = r[(i - 1 + r.length) % r.length], P = r[i], B = r[(i + 1) % r.length], L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1e-9;
      if (Math.abs((B[0] - A[0]) * (A[1] - P[1]) - (A[0] - P[0]) * (B[1] - A[1])) / L < tol) { r.splice(i, 1); changed = true; i--; }
    }
  }
  return r;
}
// Square up a hand-drawn loop: edges within 8° of the plan axes become exactly orthogonal, others keep their line.
function squareUp(q, tol){
  const D = 8 * Math.PI / 180, lines = [];
  for (let i = 0; i < q.length; i++) {
    const A = q[i], B = q[(i + 1) % q.length], a = Math.atan2(B[1] - A[1], B[0] - A[0]), L = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const h = Math.abs(Math.sin(a)) < Math.sin(D), v = Math.abs(Math.cos(a)) < Math.sin(D);
    lines.push(h ? { t: "h", c: (A[1] + B[1]) / 2, L, A, B } : v ? { t: "v", c: (A[0] + B[0]) / 2, L, A, B } : { t: "f", L, A, B });
  }
  // a short slanted bit between two square edges is a pen overshoot or a rounded corner, not a chamfer
  const kept = lines.filter((l, i) => !(l.t === "f" && l.L < tol * 4 && lines.length > 4 && lines[(i + lines.length - 1) % lines.length].t !== "f" && lines[(i + 1) % lines.length].t !== "f"));
  // merge runs of collinear axis lines (a corner Vision rounded off, or a wobble)
  const M = [];
  for (const l of kept) {
    const p = M[M.length - 1];
    if (p && p.t !== "f" && p.t === l.t && Math.abs(p.c - l.c) < tol * 2) { p.c = (p.c * p.L + l.c * l.L) / (p.L + l.L); p.L += l.L; p.B = l.B; }
    else M.push({ ...l });
  }
  if (M.length > 2) { const f = M[0], l = M[M.length - 1]; if (f.t !== "f" && f.t === l.t && Math.abs(f.c - l.c) < tol * 2) { f.c = (f.c * f.L + l.c * l.L) / (f.L + l.L); f.L += l.L; f.A = l.A; M.pop(); } }
  const meet = (P, Q) => {
    const orig = Q.A;
    if (P.t === "h" && Q.t === "v") return [Q.c, P.c];
    if (P.t === "v" && Q.t === "h") return [P.c, Q.c];
    if (P.t === Q.t && P.t !== "f") return null;   // a jog between two parallel lines: bridge it square
    const ax = P.t !== "f" ? P : Q.t !== "f" ? Q : null, fr = ax === P ? Q : P;
    if (!ax) return orig;
    const dx = fr.B[0] - fr.A[0], dz = fr.B[1] - fr.A[1];
    if (ax.t === "h") return Math.abs(dz) < 0.25 * Math.hypot(dx, dz) ? [orig[0], ax.c] : [fr.A[0] + dx * (ax.c - fr.A[1]) / dz, ax.c];
    return Math.abs(dx) < 0.25 * Math.hypot(dx, dz) ? [ax.c, orig[1]] : [ax.c, fr.A[1] + dz * (ax.c - fr.A[0]) / dx];
  };
  const out = [];
  for (let i = 0; i < M.length; i++) {
    const P = M[(i - 1 + M.length) % M.length], Q = M[i], v = meet(P, Q);
    if (v) out.push(v);
    else if (P.t === "h") { const x = Q.A[0]; out.push([x, P.c], [x, Q.c]); }
    else { const z = Q.A[1]; out.push([P.c, z], [Q.c, z]); }
  }
  // tidy: drop repeats, tiny edges and straight-through vertices
  let r = out;
  for (let pass = 0; pass < 3; pass++) {
    r = r.filter((P, i) => { const Q = r[(i + 1) % r.length]; return Math.hypot(Q[0] - P[0], Q[1] - P[1]) > tol; });
    r = r.filter((P, i) => {
      const A = r[(i - 1 + r.length) % r.length], B = r[(i + 1) % r.length];
      const cr = (P[0] - A[0]) * (B[1] - P[1]) - (P[1] - A[1]) * (B[0] - P[0]);
      return Math.abs(cr) > 1e-6 * (1 + Math.hypot(B[0] - A[0], B[1] - A[1]) ** 2) * 50;
    });
  }
  return r.length >= 3 ? r : q;
}

const T_VOID = /\b(void|court(yard)?|open(\s*to\s*sky)?|atrium|light\s*well|lightwell|garden|yard|lawn|pool|cy)\b/i;
function readLabel(s){
  const t = String(s).toLowerCase().replace(/,/g, ".").replace(/[–—]/g, "-").trim(), r = {};
  if (T_VOID.test(t)) r.void = true;
  let m;
  if ((m = t.match(/(?:split|up|raised|lift)?\s*\+\s*(\d+(?:\.\d+)?)\s*m\b/))) r.lift = parseFloat(m[1]);
  else if ((m = t.match(/(?:down|lowered|sunken|-)\s*(\d+(?:\.\d+)?)\s*m\b/)) && /down|lower|sunk|^-/.test(t)) r.lift = -parseFloat(m[1]);
  else if (/\bsplit\b|½|\+\s*1\/2/.test(t)) r.liftHalf = true;
  if ((m = t.match(/(?:\bh(?:eight|t)?\s*[=:]?\s*(\d+(?:\.\d+)?)\s*m?\b)|(?:(\d+(?:\.\d+)?)\s*m\s*(?:h|ht|high|tall|height)\b)/))) r.height = parseFloat(m[1] || m[2]);
  else if (r.lift == null && (m = t.match(/^\+\s*(\d{1,3})(?![.\d]|\s*m\b)/))) r.addStoreys = +m[1];
  else if ((m = t.match(/(\d{1,3})\s*(?:st|sty|stys|storeys?|stor(?:ie|y)s?|stories|floors?|fl|levels?|lvls?|f|l)\b/)) || (m = t.match(/\b(?:l|lvl|level|levels)\s*(\d{1,3})\b/))) r.storeys = +m[1];
  else if ((m = t.match(/^(\d+(?:\.\d+)?)\s*(mm|m|metres?|meters?)$/))) r.length = parseFloat(m[1]) / (m[2] === "mm" ? 1000 : 1);
  else if ((m = t.match(/^(\d+(?:\.\d+)?)$/))) { const v = parseFloat(m[1]); if (v >= 1000) r.length = v / 1000; else r.bare = v; }
  return r;
}

/** Turn Vision's reading of a sketch into builder params: { params, read, assumed, overlay } or { error }. */
export function interpretSketch(vision, current = {}, opts = {}){
  if (!vision || !vision.ok) return { error: (vision && vision.error) || "The sketch couldn't be read." };
  const W = vision.w, H = vision.h, big = Math.max(W, H), C = vision.contours || [];
  const read = [], assumed = [];
  const touches = q => q.some(([x, y]) => x < W * 0.012 || y < H * 0.012 || x > W * 0.988 || y > H * 0.988);
  const bbox = q => { const xs = q.map(p => p[0]), ys = q.map(p => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
  const cs = C.map(c => ({ q: c.pts, A: Math.abs(shoelace(c.pts)), bb: bbox(c.pts) }))
    .filter(c => !touches(c.q) && c.A < W * H * 0.6).sort((a, b) => b.A - a.A);
  // A pen line is traced twice, along its outside and its inside. The inside edge is the building; whatever has
  // no inside edge close by is either filled in solid (a building) or a thin line (a dimension line, ignored).
  const used = new Set();
  let shapes = [];
  for (const Y of cs) {
    if (used.has(Y)) continue;
    used.add(Y);
    const gap = Math.max(big * 0.03, 0.3 * Math.sqrt(Y.A));
    const X = cs.find(X => !used.has(X) && X.A < Y.A && X.bb[0] >= Y.bb[0] && X.bb[1] >= Y.bb[1] && X.bb[2] <= Y.bb[2] && X.bb[3] <= Y.bb[3]
      && Math.sqrt(Y.A) - Math.sqrt(X.A) < gap && insidePoly(Y.q, X.q[0]));
    if (X) {
      // the inside edge of the drawn line, moved out to the middle of the line (half its measured thickness)
      used.add(X);
      const th = (Y.A - X.A) / ((perim(Y.q) + perim(X.q)) / 2), q = offsetLoop(dpSimplify(X.q, big * 0.003), th / 2, false);   // simplify first: widening a noisy trace makes spurs
      shapes.push({ q, A: Math.abs(shoelace(q)), th });
    }
    else if (2 * Y.A / perim(Y.q) > big * 0.012) shapes.push({ q: Y.q, A: Y.A, solid: true });
  }
  const largest = Math.max(0, ...shapes.map(s => s.A));
  shapes = shapes.filter(s => s.A > largest * 0.012).sort((a, b) => b.A - a.A);
  if (!shapes.length) return { error: "No closed outlines were found. Draw each building as a closed shape in dark pen on plain paper, and photograph it straight on." };

  // nesting: the smallest outline that holds another
  for (const s of shapes) {
    s.parent = null;
    for (const o of shapes) if (o !== s && o.A > s.A && s.q.every((P, i) => i % 3 || insidePoly(o.q, P)) && (s.parent == null || o.A < s.parent.A)) s.parent = o;
    s.labels = [];
  }
  const texts = (vision.texts || []).map(t => ({ s: t.s, box: t.box, c: [t.box[0] + t.box[2] / 2, t.box[1] + t.box[3] / 2], r: readLabel(t.s) }));
  const dims = [];
  for (const t of texts) {
    const holder = shapes.filter(s => insidePoly(s.q, t.c)).sort((a, b) => a.A - b.A)[0];
    if (t.r.length != null || (t.r.bare != null && !holder && t.r.bare >= 3)) dims.push({ ...t, m: t.r.length ?? t.r.bare });
    else if (holder) holder.labels.push(t);
  }

  // scale: each length matched to the nearest roughly parallel edge it sits beside
  const scales = [];
  for (const t of dims) {
    const horiz = t.box[2] >= t.box[3];
    let best = null;
    for (const s of shapes) {
      const q = dpSimplify(s.q, big * 0.01);
      for (let i = 0; i < q.length; i++) {
        const A = q[i], B = q[(i + 1) % q.length], dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy);
        if (L < big * 0.03 || (horiz ? Math.abs(dy) > 0.35 * L : Math.abs(dx) > 0.35 * L)) continue;
        const u = ((t.c[0] - A[0]) * dx + (t.c[1] - A[1]) * dy) / (L * L);
        if (u < 0.05 || u > 0.95) continue;
        const dist = Math.abs((t.c[0] - A[0]) * dy - (t.c[1] - A[1]) * dx) / L;
        if (dist < Math.max(4.5 * Math.min(t.box[2], t.box[3]), big * 0.09) && (!best || dist < best.dist)) best = { dist, L };
      }
    }
    if (best) { scales.push(t.m / best.L); read.push(`“${t.s.trim()}” as the length of the edge beside it`); }
    else assumed.push(`“${t.s.trim()}” wasn't next to a clear edge, so it was not used`);
  }
  scales.sort((a, b) => a - b);
  let k = scales.length ? scales[scales.length >> 1] : null;   // metres per pixel

  // blocks, parents first. An inner outline is a courtyard when it says so or says nothing; a block when it has storeys.
  const hs = current.storeyHeight || DEFAULTS.storeyHeight, blocks = [], bySh = new Map();
  for (const s of shapes.slice().sort((a, b) => depthOf(a) - depthOf(b) || b.A - a.A)) {
    const lab = Object.assign({}, ...s.labels.map(t => t.r)), words = s.labels.map(t => `“${t.s.trim()}”`).join(" ");
    let st = lab.storeys ?? lab.bare ?? (lab.height != null ? Math.max(1, Math.round(lab.height / hs)) : null);
    const pb = s.parent && bySh.get(s.parent);
    if (s.parent && (lab.void || (st == null && lab.addStoreys == null) || !pb)) {
      const host = pb || bySh.get(s.parent.parent);
      if (host) { host.holesPx.push(s.q); if (!lab.void) assumed.push(`the empty outline inside block ${blocks.indexOf(host) + 1} is a courtyard (write a number in it to make it a block on top)`); else read.push(`${words} as a courtyard`); }
      continue;
    }
    const b = { px: s.q, holesPx: [], parent: pb ? blocks.indexOf(pb) : null, storeys: null, th: s.th || big * 0.006 };
    if (pb) {
      const below = pb.storeys ?? current.storeys ?? DEFAULTS.storeys;
      if (lab.addStoreys != null) b.storeys = lab.addStoreys;
      else if (st > below) b.storeys = st - below;
      else { b.storeys = st; assumed.push(`${words} on block ${blocks.indexOf(pb) + 1} read as ${st} more storeys on top`); }
      if (lab.addStoreys != null || st > below) read.push(`${words} as block ${blocks.length + 1}, standing on block ${blocks.indexOf(pb) + 1}`);
    } else if (st != null) { b.storeys = st; read.push(`${words} as ${st} storeys` + (lab.height != null ? ` (${lab.height} m at ${hs} m floor to floor)` : "")); }
    else assumed.push(`block ${blocks.length + 1} has no storeys written, so it uses the Storeys field`);
    if (lab.lift != null) { b.lift = lab.lift; read.push(`block ${blocks.length + 1} ${lab.lift > 0 ? "raised" : "lowered"} ${Math.abs(lab.lift)} m (split level)`); }
    else if (lab.liftHalf) { b.lift = +(hs / 2).toFixed(2); assumed.push(`“split” on block ${blocks.length + 1} read as half a storey up (${b.lift} m)`); }
    bySh.set(s, b); blocks.push(b);
  }
  function depthOf(s){ let d = 0; for (let p = s.parent; p; p = p.parent) d++; return d; }

  // the plan in metres, squared to its main direction and centred
  const main = blocks[0], mq = dpSimplify(main.px, big * 0.012);
  let sx = 0, sy = 0, tot = 0;
  for (let i = 0; i < mq.length; i++) { const A = mq[i], B = mq[(i + 1) % mq.length], a = Math.atan2(B[1] - A[1], B[0] - A[0]), L = Math.hypot(B[0] - A[0], B[1] - A[1]); sx += L * Math.cos(4 * a); sy += L * Math.sin(4 * a); tot += L; }
  // how square the drawing is (1 = every wall on two perpendicular directions). A freehand, angled plan keeps its angles.
  const orth = tot ? Math.hypot(sx, sy) / tot : 0, square = orth > 0.55;
  const th = square ? Math.atan2(sy, sx) / 4 : 0, ct = Math.cos(-th), st_ = Math.sin(-th);
  if (Math.abs(th) > 0.01) read.push(`drawing turned ${Math.abs(th * 180 / Math.PI).toFixed(1)}° to square it up`);
  if (!square) read.push("walls kept at the angles drawn (it isn't a square plan)");
  let scaleAssumed = false;
  if (k == null) {
    const xs = main.px.map(([x, y]) => x * ct - y * st_), ys = main.px.map(([x, y]) => x * st_ + y * ct);
    const longest = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    k = (current.width || DEFAULTS.width) / longest;
    scaleAssumed = true;
    assumed.push(`no lengths written, so the drawing is taken as ${+(current.width || DEFAULTS.width).toFixed(2)} m on its longest side: click the width on the model to set the real size`);
  }
  const toM = q => q.map(([x, y]) => [(x * ct - y * st_) * k, (x * st_ + y * ct) * k]);
  const clean = q => {
    const raw = toM(q), A = Math.abs(shoelace(raw)), P = perim(raw), size = Math.sqrt(A);
    if (4 * Math.PI * A / (P * P) > 0.86 && dpSimplify(raw, size * 0.02).length > 6) {   // a drawn circle or oval: make it true
      const xs = raw.map(p => p[0]), zs = raw.map(p => p[1]), cx = (Math.max(...xs) + Math.min(...xs)) / 2, cz = (Math.max(...zs) + Math.min(...zs)) / 2;
      const rx = (Math.max(...xs) - Math.min(...xs)) / 2, rz = (Math.max(...zs) - Math.min(...zs)) / 2;
      return Array.from({ length: 48 }, (_, i) => [cx + rx * Math.cos(i / 48 * Math.PI * 2), cz + rz * Math.sin(i / 48 * Math.PI * 2)]);
    }
    const tol = Math.min(0.6, Math.max(0.1, big * 0.006 * k, size * 0.02));   // about a pen's wobble
    if (!square) {   // freehand: simplify firmly, drop little spurs where lines crossed, keep the angles
      let r = dropStraight(dpSimplify(raw, Math.max(tol, size * 0.035)), Math.max(tol, size * 0.035));
      for (let pass = 0; pass < 3; pass++) r = r.filter((P, i) => { const A = r[(i - 1 + r.length) % r.length], B = r[(i + 1) % r.length]; return r.length <= 3 || Math.min(Math.hypot(P[0] - A[0], P[1] - A[1]), Math.hypot(P[0] - B[0], P[1] - B[1])) > size * 0.06; });
      return r.length >= 3 ? r : raw;
    }
    return dropStraight(squareUp(dropStraight(squareUp(dpSimplify(raw, tol), tol), tol), tol), tol);
  };
  // a roof outline is nearly always a rectangle: if it's close to one (in the squared-up frame), make it exact
  const cleanRoof = q => {
    const c = clean(q), xs = c.map(v => v[0]), zs = c.map(v => v[1]), x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
    return Math.abs(shoelace(c)) > 0.85 * (x1 - x0) * (z1 - z0) ? [[x0, z0], [x1, z0], [x1, z1], [x0, z1]] : c;
  };
  for (const b of blocks) { b.outer = clean(b.px); b.holes = b.holesPx.map(clean); }
  // line weight: bold = solid wall, thin = glazing. Where a drawing uses both, each wall (or the part of it drawn
  // that way) gets its own: edges are split where the weight changes.
  const BM = vision.bold && vision.bold.data ? (() => { const bin = atob(vision.bold.data), a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return { ...vision.bold, a }; })() : null;
  const boldAt = ([X, Z]) => {   // metres (squared frame) -> is there bold ink near that point of the photo?
    const x = (X * ct + Z * st_) / k, y = (-X * st_ + Z * ct) / k, r = Math.max(1, Math.round(big * 0.012 / BM.scale));
    const cx = Math.round(x / BM.scale), cy = Math.round(y / BM.scale);
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) { const u = cx + i, v = cy + j; if (u >= 0 && v >= 0 && u < BM.w && v < BM.h && BM.a[v * BM.w + u]) return true; }
    return false;
  };
  if (BM) for (const b of blocks) {
    const q = b.outer, outQ = [], types = [];
    for (let i = 0; i < q.length; i++) {
      const A = q[i], Bq = q[(i + 1) % q.length], L = Math.hypot(Bq[0] - A[0], Bq[1] - A[1]), n = Math.max(4, Math.round(L / 0.25));
      const seq = []; for (let j = 0; j < n; j++) { const t = (j + 0.5) / n; seq.push(boldAt([A[0] + (Bq[0] - A[0]) * t, A[1] + (Bq[1] - A[1]) * t])); }
      // runs, ignoring flickers shorter than 0.8 m
      const runs = []; seq.forEach((v, j) => { const r = runs[runs.length - 1]; if (r && r.v === v) r.n++; else runs.push({ v, n: 1, j }); });
      const minN = Math.max(1, Math.round(0.8 / (L / n)));
      for (let m = 0; m < runs.length; m++) if (runs[m].n < minN && runs.length > 1) { const nb = runs[m - 1] || runs[m + 1]; nb.n += runs[m].n; if (nb === runs[m + 1]) nb.j = runs[m].j; runs.splice(m, 1); m = -1; }
      for (let m = 0; m + 1 < runs.length; m++) if (runs[m].v === runs[m + 1].v) { runs[m].n += runs[m + 1].n; runs.splice(m + 1, 1); m--; }
      runs.forEach((r, m) => { const t = r.j / n; outQ.push(m === 0 ? A : [A[0] + (Bq[0] - A[0]) * t, A[1] + (Bq[1] - A[1]) * t]); types.push(r.v ? "solid" : "glass"); });
    }
    b.outer = outQ; b.edgeTypes = types;
  }
  const mixed = blocks.some(b => b.edgeTypes && b.edgeTypes.includes("solid") && b.edgeTypes.includes("glass"));
  const facades = {};
  if (mixed) {
    blocks.forEach((b, bi) => (b.edgeTypes || []).forEach((t, ei) => { facades[`${bi}:0:${ei}`] = { windowType: t === "solid" ? "none" : "curtain" }; }));
    const ng = Object.values(facades).filter(f => f.windowType === "curtain").length;
    read.push(`bold lines as solid wall and thin lines as glazing (${ng} glazed wall${ng === 1 ? "" : "s"})`);
  } else assumed.push("no glazing drawn (thin lines between bold walls), so walls get the Windows setting");
  // Dashed lines show what's above: a roof, or upper floors that overhang or step back. Pieces of dashed line near
  // each other are one outline (a dash that touched a wall line may be missing, so gaps are fine). Inside it, a
  // dashed line along the middle is a ridge (gable), diagonals to the corners are hips.
  const DB = vision.dashBand || 0, facets = vision.dashFacets || [];
  const dc = (vision.dashed || []).map(c => ({ q: c.pts, A: Math.abs(shoelace(c.pts)), P: perim(c.pts), bb: bbox(c.pts) })).filter(c => !touches(c.q));
  const thin = dc.filter(c => 2 * c.A / c.P < 2.6 * (DB + big / 600));   // band pieces, not the blank slopes between them
  // each piece's direction and its two ends (along its main axis)
  for (const c of thin) {
    const n = c.q.length, mx = c.q.reduce((s, v) => s + v[0], 0) / n, my = c.q.reduce((s, v) => s + v[1], 0) / n;
    let sxx = 0, syy = 0, sxy = 0; for (const [x, y] of c.q) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
    const a = 0.5 * Math.atan2(2 * sxy, sxx - syy), d = [Math.cos(a), Math.sin(a)], pr = c.q.map(([x, y]) => (x - mx) * d[0] + (y - my) * d[1]);
    const lo = Math.min(...pr) + DB, hi = Math.max(...pr) - DB;
    Object.assign(c, { m: [mx, my], ang: Math.abs(a) * 180 / Math.PI, len: Math.max(0, hi - lo), ends: [[mx + d[0] * lo, my + d[1] * lo], [mx + d[0] * hi, my + d[1] * hi]] });
  }
  // The outline above each top block: look out from its walls in every direction for the nearest separate pen
  // line. That follows a dashed line however long or far apart the dashes are, and fills the gaps between them.
  const dec = m => { if (!m || !m.data) return null; const bin = atob(m.data), a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return { ...m, a }; };
  const INK = dec(vision.ink);
  const inkAt = (x, y) => { const u = Math.floor(x / INK.scale), v = Math.floor(y / INK.scale); return u >= 0 && v >= 0 && u < INK.w && v < INK.h && INK.a[v * INK.w + u] === 1; };
  const roofOverlay = [];
  const tops = blocks.filter(b => !blocks.some(c => c.parent === blocks.indexOf(b)));
  for (const host of INK ? tops : []) {
    const poly0 = host.px, c0 = centroid(poly0), size = Math.sqrt(Math.abs(shoelace(poly0)));
    const wallPad = Math.max(big * 0.005, host.th * 0.9), maxOut = size * 1.6, step = INK.scale * 0.75, N = 96;   // just clear of the drawn wall line
    const nearWall = p => segDistToLoop(poly0, p) < wallPad;
    const others = blocks.filter(b => b !== host && !insidePoly(b.px, c0) && !insidePoly(poly0, centroid(b.px)));
    const off = [], base = [];
    for (let i = 0; i < N; i++) {
      const a = i / N * Math.PI * 2, d = [Math.cos(a), Math.sin(a)];
      let r = 0; while (r < size * 3 && insidePoly(poly0, [c0[0] + d[0] * r, c0[1] + d[1] * r])) r += step;   // leave the walls
      base.push(r);
      // the outermost line within reach: the line showing what's above encloses everything else drawn
      let hit = null;
      for (let t = r; t < r + maxOut; t += step) {
        const q = [c0[0] + d[0] * t, c0[1] + d[1] * t];
        if (q[0] < 0 || q[1] < 0 || q[0] >= W || q[1] >= H) break;   // the photo ends: keep what was found
        if (others.some(o => insidePoly(o.px, q) || segDistToLoop(o.px, q) < wallPad)) break;   // another building: stop
        if (inkAt(q[0], q[1]) && !nearWall(q)) hit = t - r;
      }
      off.push(hit);
    }
    const got = off.filter(v => v != null);
    if (got.length < N * 0.45) continue;   // no outline drawn round this block
    // stray marks: drop hits far from the run of their neighbours, then fill gaps from either side
    const med = (arr) => { const s2 = arr.slice().sort((a, b) => a - b); return s2[s2.length >> 1]; };
    const clean1 = off.map((v, i) => { if (v == null) return null; const nb = []; for (let k2 = -4; k2 <= 4; k2++) { const w = off[(i + k2 + N) % N]; if (w != null) nb.push(w); } const m = med(nb); return Math.abs(v - m) > Math.max(wallPad, 0.25 * m) ? null : v; });
    const filled = clean1.map((v, i) => {
      if (v != null) return v;
      let a1 = 1, b1 = 1; while (a1 < N && clean1[(i - a1 + N) % N] == null) a1++; while (b1 < N && clean1[(i + b1) % N] == null) b1++;
      const va = clean1[(i - a1 + N) % N], vb = clean1[(i + b1) % N];
      return va == null || vb == null ? null : va + (vb - va) * a1 / (a1 + b1);
    });
    if (filled.some(v => v == null)) continue;
    const ring = filled.map((v, i) => { const a = i / N * Math.PI * 2; return [c0[0] + Math.cos(a) * (base[i] + v), c0[1] + Math.sin(a) * (base[i] + v)]; });
    const poly = dropStraight(dpSimplify(ring, big * 0.01), big * 0.01);
    if (poly.length < 3) continue;
    // lines inside it (not the walls): a long straight one through the middle is a ridge, diagonals are hips
    const inner = thin.filter(t => t.len > big * 0.02 && insidePoly(poly, t.m) && segDistToLoop(poly, t.m) > wallPad * 2 && !(segDistToLoop(poly0, t.m) < wallPad * 2));
    const span = poly.reduce((m, p) => Math.max(m, Math.hypot(p[0] - c0[0], p[1] - c0[1])), 0) * 2;
    const byDir = { h: 0, v: 0 }; let diag = 0, ridge = null;
    for (const t of inner) { if (t.ang > 25 && t.ang < 65) diag += t.len; else byDir[t.ang <= 25 ? "h" : "v"] += t.len; }
    if (byDir.h > span * 0.45 || byDir.v > span * 0.45) ridge = byDir.h >= byDir.v ? [1, 0] : [0, 1];
    diag = diag > span * 0.5 ? 2 : 0;
    const nf = facets.filter(f => insidePoly(poly, f.c)).length;
    const type = diag >= 2 || nf >= 3 ? "hip" : ridge || nf === 2 ? "gable" : null;
    const words = (vision.texts || []).filter(t => insidePoly(poly, [t.box[0] + t.box[2] / 2, t.box[1] + t.box[3] / 2])).map(t => t.s.toLowerCase()).join(" ");
    roofOverlay.push(poly);
    const hi = blocks.indexOf(host) + 1, outline = clean(poly), rm = ridge ? [ridge[0] * ct - ridge[1] * st_, ridge[0] * st_ + ridge[1] * ct] : null;
    const saysRoof = /roof|eave|canopy|awning/.test(words), floorsM = words.match(/(\d{1,3})\s*(?:st|storeys?|stories|floors?|levels?|lvls?)\b|\bl(?:evel)?\s*(\d{1,3})/);
    const upper = (opts.level || 0) > 0;   // a plan of an upper floor: dashes round it are its roof
    if (type || saysRoof || (!floorsM && (upper || (host.storeys != null && host.storeys <= 1 && false)))) {
      host.roof = { outline, type, ridge: rm };
      read.push(`dashed outline over block ${hi} as its roof` + (type ? ` (${type}${type === "gable" && !nf ? ", from the ridge line" : ""})` : ", no ridge drawn, so the Roof setting decides its shape"));
    } else {
      // floors above: the dashed outline from level 1 up (or as many storeys as written in it), the solid one below
      const below = host.storeys ?? 1, up = floorsM && floorsM[1] ? +floorsM[1] : 1;
      host.above = { outline, storeys: up };
      host.storeysBelow = below;
      read.push(`dashed outline over block ${hi} as the floor${up > 1 ? "s" : ""} above (${up} storey${up > 1 ? "s" : ""}) on ${below} storey${below > 1 ? "s" : ""} drawn solid`);
      if (!floorsM) assumed.push(`the dashed outline over block ${hi} is one floor above (write a number in it for more, or "roof" if it's the roof)`);
    }
  }

  const all = blocks.flatMap(b => [...b.outer, ...(b.above ? b.above.outline : []), ...(b.roof && b.roof.outline ? b.roof.outline : [])]), xs = all.map(p => p[0]), zs = all.map(p => p[1]);
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cz = (Math.max(...zs) + Math.min(...zs)) / 2;
  const w0 = Math.max(...xs) - Math.min(...xs), d0 = Math.max(...zs) - Math.min(...zs);
  const shift = q => q.map(([x, z]) => [+(x - cx).toFixed(3), +(z - cz).toFixed(3)]);
  // with no length written, the whole drawing (what's above included) is taken as the assumed size, not just the walls
  let widthOut = w0;
  if (scaleAssumed) { const want = current.width || DEFAULTS.width; widthOut = w0 * want / Math.max(w0, d0); }
  const out = blocks.map(b => ({ outer: shift(b.outer), holes: b.holes.map(shift), parent: b.parent, storeys: b.above ? b.storeysBelow : b.storeys, ...(b.lift ? { lift: b.lift } : {}),
    ...(b.roof ? { roof: { ...b.roof, outline: shift(b.roof.outline) } } : {}) }));
  blocks.forEach((b, i) => { if (b.above) out.push({ outer: shift(b.above.outline), holes: [], parent: i, storeys: b.above.storeys, fromAbove: true }); });
  const sk = { w0, d0, blocks: out };
  if (blocks.length > 1) read.push(`${blocks.length} blocks`);
  if (blocks.some(b => b.holes.length)) read.push(`${blocks.reduce((s, b) => s + b.holes.length, 0)} courtyard${blocks.reduce((s, b) => s + b.holes.length, 0) > 1 ? "s" : ""}`);
  read.push(`overall ${widthOut.toFixed(1)} m × ${(d0 * widthOut / w0).toFixed(1)} m`);
  const overlay = blocks.map((b, i) => ({ pts: b.px, holes: b.holesPx, label: `${i + 1}` }));
  return { params: { shape: "sketch", sketch: sk, width: widthOut, depth: d0 * widthOut / w0, facades }, read, assumed, overlay, roofOverlay, blocksPx: blocks.map(b => b.px), image: { w: W, h: H } };
}

/* ---------------- Interior: internal walls, doors, openings, stairs, cores, columns ----------------
   Stored with the building as p.interior (plan metres, the built group's own x/z), so it rebuilds with the shell.
   Every item has the floors it stands on: lv = [from, to] (absolute storey indices), or null for every floor of
   the block it sits in. Doors and openings live on a wall: host is an internal wall's id, or an outside wall
   given as { b: block, l: loop (0 outer, 1+ courtyards), e: edge } with u = distance along it to the door centre. */
export const INTERIOR_DEFAULTS = {
  wall: { t: 0.11 },
  door: { w: 0.92, h: 2.1, swing: 1 },
  opening: { w: 1.2, h: 2.4 },
  stair: { w: 1.1, type: "dogleg", ang: 0 },
  core: { w: 2.6, d: 2.4, t: 0.2, ang: 0 },
  column: { s: 0.4, round: false },
};
export const INTERIOR_LIMITS = { t: [0.05, 0.6], w: [0.5, 12], h: [1.8, 6], d: [1, 12], s: [0.15, 2] };
export const levelName = i => i === 0 ? "Ground floor" : `Level ${i}`;
export function clampItem(it){
  const out = { ...INTERIOR_DEFAULTS[it.kind], ...it };
  for (const [k, [lo, hi]] of Object.entries(INTERIOR_LIMITS)) if (k in out && typeof out[k] === "number") out[k] = Math.min(hi, Math.max(lo, out[k]));
  return out;
}
const ROT = a => { const r = THREE.MathUtils.degToRad(a || 0); return { e: [Math.cos(r), Math.sin(r)], n: [-Math.sin(r), Math.cos(r)] }; };
const segDist = (P, A, B) => {
  const dx = B[0] - A[0], dz = B[1] - A[1], L2 = dx * dx + dz * dz || 1e-12, t = Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dz) / L2));
  return { d: Math.hypot(P[0] - A[0] - dx * t, P[1] - A[1] - dz * t), t, q: [A[0] + dx * t, A[1] + dz * t] };
};

/** Storeys of the building: how many floors there are to draw on. */
export function floorCount(raw){ const p = clampParams(raw); return Math.max(...blocksFor(p).map(b => b.base + b.n)); }
export const floorY = (raw, L) => { const p = clampParams(raw); return L * p.storeyHeight + p.slabThickness; };
/** Highest floor lift among blocks on storey L (split levels), for where to cut a plan. */
export const levelLifts = (raw, L) => { const p = clampParams(raw); return blocksFor(p).filter(b => L >= b.base && L < b.base + b.n).map(b => b.lift); };

const liftAt = (blocks, pt, L) => { const b = blocksAtPoint(blocks, pt).find(b => L >= b.base && L < b.base + b.n); return b ? b.lift : 0; };
function blocksAtPoint(blocks, pt){ return blocks.filter(b => insidePoly(b.fp.outer, pt) && !b.fp.holes.some(h => insidePoly(h, pt))); }
const anchorOf = (it, items) => it.kind === "wall" ? [(it.a[0] + it.b[0]) / 2, (it.a[1] + it.b[1]) / 2] : [it.x, it.z];
function levelsOf(blocks, it, items){
  if (it.kind === "door" || it.kind === "opening") {
    if (typeof it.host === "string") { const h = items.find(w => w.id === it.host); return h ? levelsOf(blocks, h, items) : []; }
    const b = blocks[it.host.b]; if (!b) return [];
    const all = []; for (let i = b.base; i < b.base + b.n; i++) all.push(i);
    return Array.isArray(it.lv) ? all.filter(i => i >= it.lv[0] && i <= it.lv[1]) : all;
  }
  const set = new Set();
  for (const b of blocksAtPoint(blocks, anchorOf(it, items))) for (let i = b.base; i < b.base + b.n; i++) set.add(i);
  const all = [...set].sort((a, b) => a - b);
  return Array.isArray(it.lv) ? all.filter(i => i >= it.lv[0] && i <= it.lv[1]) : all;
}
export function onLevel(raw, it, L){ const p = clampParams(raw); return levelsOf(blocksFor(p), it, p.interior || []).includes(L); }

// A stair's plan size and treads, from the floor to floor: risers about 175 mm, goings 260 mm.
function stairPlan(it, H){
  if (it.rise) H = it.rise;   // a half flight between split levels
  const R = Math.max(2, Math.ceil(H / 0.18)), r = H / R, g = 0.26, W = it.w;
  if (it.type === "straight") { const T = R - 1, L = T * g; return { R, r, g, L, Wt: W, T1: T, T2: 0, void: [-L / 2, L / 2] }; }
  const R1 = Math.ceil(R / 2), R2 = R - R1, T1 = R1 - 1, T2 = R2 - 1, L = T1 * g + W, Wt = 2 * W + 0.1;
  return { R, r, g, L, Wt, T1, T2, R1, void: [L / 2 - W - T2 * g, L / 2] };
}
/** Plan outline of a stair / core / column (for drawing it, picking it and cutting slabs). */
export function itemOutline(raw, it){
  const p = clampParams(raw), { e, n } = ROT(it.ang), at = (u, w) => [it.x + e[0] * u + n[0] * w, it.z + e[1] * u + n[1] * w];
  if (it.kind === "stair") { const s = stairPlan(it, p.storeyHeight); return [at(-s.L / 2, -s.Wt / 2), at(s.L / 2, -s.Wt / 2), at(s.L / 2, s.Wt / 2), at(-s.L / 2, s.Wt / 2)]; }
  if (it.kind === "core") return [at(-it.w / 2, -it.d / 2), at(it.w / 2, -it.d / 2), at(it.w / 2, it.d / 2), at(-it.w / 2, it.d / 2)];
  if (it.kind === "column") {
    if (it.round) return Array.from({ length: 16 }, (_, i) => at(Math.cos(i / 16 * Math.PI * 2) * it.s / 2, Math.sin(i / 16 * Math.PI * 2) * it.s / 2));
    return [at(-it.s / 2, -it.s / 2), at(it.s / 2, -it.s / 2), at(it.s / 2, it.s / 2), at(-it.s / 2, it.s / 2)];
  }
  if (it.kind === "wall") {
    const dx = it.b[0] - it.a[0], dz = it.b[1] - it.a[1], L = Math.hypot(dx, dz) || 1e-9, ex = [dx / L, dz / L], nx = [-ex[1], ex[0]], h = it.t / 2;
    return [[it.a[0] - nx[0] * h, it.a[1] - nx[1] * h], [it.b[0] - nx[0] * h, it.b[1] - nx[1] * h], [it.b[0] + nx[0] * h, it.b[1] + nx[1] * h], [it.a[0] + nx[0] * h, it.a[1] + nx[1] * h]];
  }
  return [];
}
// Slab voids per storey: a stair opens the slab it climbs to, a core every slab it passes (not the roof).
function interiorVoids(p, blocks){
  const items = p.interior || [], out = new Map(), add = (L, loop) => { if (!out.has(L)) out.set(L, []); out.get(L).push(loop); };
  for (const it0 of items) {
    const it = clampItem(it0), lv = levelsOf(blocks, it, items);
    if (it.kind === "stair" && !it.rise) {
      const s = stairPlan(it, p.storeyHeight), { e, n } = ROT(it.ang), at = (u, w) => [it.x + e[0] * u + n[0] * w, it.z + e[1] * u + n[1] * w];
      const loop = [at(s.void[0], -s.Wt / 2), at(s.void[1], -s.Wt / 2), at(s.void[1], s.Wt / 2), at(s.void[0], s.Wt / 2)];
      for (const L of lv) add(L + 1, loop);
    } else if (it.kind === "core") {
      const { e, n } = ROT(it.ang), at = (u, w) => [it.x + e[0] * u + n[0] * w, it.z + e[1] * u + n[1] * w], a = it.w / 2 - it.t, b = it.d / 2 - it.t;
      const loop = [at(-a, -b), at(a, -b), at(a, b), at(-a, b)];
      for (const L of lv) if (lv.includes(L + 1)) add(L + 1, loop);
    }
  }
  return out;
}
const bboxOf = q => [Math.min(...q.map(v => v[0])), Math.min(...q.map(v => v[1])), Math.max(...q.map(v => v[0])), Math.max(...q.map(v => v[1]))];
const bbOverlap = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
/** Which voids can be cut in this slab: wholly inside it, clear of its courtyards and of each other. */
function voidsFor(outer, holes, cand, notes){
  const ok = [], boxes = holes.map(bboxOf);
  for (const v of cand) {
    const bb = bboxOf(v);
    if (!v.every(q => insidePoly(outer, q))) continue;
    if (boxes.some(h => bbOverlap(h, bb))) { notes.add("A stair or core overlaps a courtyard or another opening, so its slab opening was left out."); continue; }
    ok.push(v); boxes.push(bb);
  }
  return ok;
}

// Internal wall from a to b on one storey, with its doors and openings cut through, lintels over them.
function iwallInto(A, it, doors, y0, h){
  const dx = it.b[0] - it.a[0], dz = it.b[1] - it.a[1], L = Math.hypot(dx, dz);
  if (L < 0.05) return;
  const e = [dx / L, dz / L], n = [-e[1], e[0]], t = it.t, ex = [e[0], 0, e[1]], ez = [n[0], 0, n[1]], ey = [0, 1, 0];
  const P = (u, v) => [it.a[0] + e[0] * u, y0 + v, it.a[1] + e[1] * u];
  const gaps = doors.map(d => ({ d, u0: Math.max(0.05, d.u - d.w / 2), u1: Math.min(L - 0.05, d.u + d.w / 2), h: Math.min(d.h, h - 0.05) })).filter(g => g.u1 - g.u0 > 0.3).sort((a, b) => a.u0 - b.u0);
  let u = -t / 2;   // run half a thickness past each end so corners and tees close
  const solid = (u0, u1, v0, v1) => { if (u1 - u0 > 1e-3 && v1 - v0 > 1e-3) A.iwall.box(P((u0 + u1) / 2, (v0 + v1) / 2), ex, ey, ez, u1 - u0, v1 - v0, t); };
  // a glass partition: framed head and base, mullions about every 1.2 m, a single glass sheet between
  const glazed = (u0, u1, v0, v1) => {
    if (u1 - u0 < 1e-3 || v1 - v0 < 1e-3) return;
    const f = 0.05, k = Math.max(1, Math.round((u1 - u0) / 1.2));
    A.frame.box(P((u0 + u1) / 2, v0 + f / 2), ex, ey, ez, u1 - u0, f, 0.08);
    A.frame.box(P((u0 + u1) / 2, v1 - f / 2), ex, ey, ez, u1 - u0, f, 0.08);
    for (let j = 0; j <= k; j++) A.frame.box(P(u0 + (u1 - u0) * j / k, (v0 + v1) / 2), ex, ey, ez, f, v1 - v0, 0.08);
    A.glass.box(P((u0 + u1) / 2, (v0 + v1) / 2), ex, ey, ez, u1 - u0, v1 - v0 - 2 * f, 0.012);
  };
  const seg = it.glass ? (u0, u1, v0, v1) => glazed(Math.max(0, u0), Math.min(L, u1), v0, v1) : solid;
  for (const g of gaps) {
    if (g.u0 < u) continue;
    seg(u, g.u0, 0, h); seg(g.u0, g.u1, g.h, h); u = g.u1;
    if (g.d.kind === "door") {   // a leaf standing open at 80°, hinged at one jamb, and a slim frame
      const s = g.d.swing === -1 ? -1 : 1, lw = g.u1 - g.u0 - 0.06, a = THREE.MathUtils.degToRad(80);
      const hinge = [it.a[0] + e[0] * (g.u0 + 0.03) + n[0] * s * t / 2, it.a[1] + e[1] * (g.u0 + 0.03) + n[1] * s * t / 2];
      const dir = [e[0] * Math.cos(a) + n[0] * s * Math.sin(a), e[1] * Math.cos(a) + n[1] * s * Math.sin(a)];
      const c = [hinge[0] + dir[0] * lw / 2, y0 + (g.h - 0.01) / 2, hinge[1] + dir[1] * lw / 2];
      A.door.box(c, [dir[0], 0, dir[1]], ey, [-dir[1], 0, dir[0]], lw, g.h - 0.02, 0.04);
      for (const uu of [g.u0 + 0.015, g.u1 - 0.015]) A.frame.box(P(uu, g.h / 2), ex, ey, ez, 0.03, g.h, t + 0.02);
      A.frame.box(P((g.u0 + g.u1) / 2, g.h - 0.015), ex, ey, ez, g.u1 - g.u0, 0.03, t + 0.02);
    }
  }
  seg(u, L + t / 2, 0, h);
}
function stairInto(A, it, s, y0){
  const { e, n } = ROT(it.ang), ex = [e[0], 0, e[1]], ez = [n[0], 0, n[1]], ey = [0, 1, 0];
  const P = (u, w, y) => [it.x + e[0] * u + n[0] * w, y0 + y, it.z + e[1] * u + n[1] * w];
  const step = (u0, u1, w0, w1, top) => A.stair.box(P((u0 + u1) / 2, (w0 + w1) / 2, top / 2), ex, ey, ez, Math.abs(u1 - u0), top, Math.abs(w1 - w0));
  const L = s.L, W = it.w;
  if (it.type === "straight") { for (let j = 0; j < s.T1; j++) step(-L / 2 + j * s.g, -L / 2 + (j + 1) * s.g, -W / 2, W / 2, (j + 1) * s.r); return; }
  const w1 = [-s.Wt / 2, -s.Wt / 2 + W], w2 = [s.Wt / 2 - W, s.Wt / 2];
  for (let j = 0; j < s.T1; j++) step(-L / 2 + j * s.g, -L / 2 + (j + 1) * s.g, w1[0], w1[1], (j + 1) * s.r);
  step(L / 2 - W, L / 2, -s.Wt / 2, s.Wt / 2, s.R1 * s.r);   // half landing
  for (let j = 0; j < s.T2; j++) step(L / 2 - W - (j + 1) * s.g, L / 2 - W - j * s.g, w2[0], w2[1], (s.R1 + j + 1) * s.r);
  // a slim rail on the inside of each flight
  A.frame.box(P(-L / 2 + (L - W) / 2, 0, 0.9 + (s.R1 * s.r) / 2), ex, ey, ez, L - W, 0.04, 0.04);
}
function interiorInto(A, p, blocks, notes){
  const items = (p.interior || []).map(clampItem), H = p.storeyHeight, ts = p.slabThickness;
  const doorsOn = id => items.filter(d => (d.kind === "door" || d.kind === "opening") && d.host === id);
  for (const it of items) {
    const lv = levelsOf(blocks, it, items);
    for (const L of lv) {
      const y0 = L * H + ts + liftAt(blocks, anchorOf(it), L), h = H - ts;
      if (it.kind === "wall") iwallInto(A, it, doorsOn(it.id), y0, h);
      else if (it.kind === "stair") { if (it.rise || blocks.some(b => L + 1 < b.base + b.n && blocksAtPoint([b], [it.x, it.z]).length)) stairInto(A, it, stairPlan(it, H), y0); }   // none on the top floor: nowhere to go
      else if (it.kind === "core") {
        const { e, n } = ROT(it.ang), ex = [e[0], 0, e[1]], ez = [n[0], 0, n[1]], ey = [0, 1, 0], P = (u, w, v) => [it.x + e[0] * u + n[0] * w, y0 + v, it.z + e[1] * u + n[1] * w];
        const a = it.w / 2, b = it.d / 2, t = it.t, dw = Math.min(1.1, it.w - 2 * t - 0.2), dh = Math.min(2.1, h - 0.1);
        A.col.box(P(0, -b + t / 2, h / 2), ex, ey, ez, it.w, h, t);                         // back
        A.col.box(P(-a + t / 2, 0, h / 2), ex, ey, ez, t, h, it.d - 2 * t);                 // sides
        A.col.box(P(a - t / 2, 0, h / 2), ex, ey, ez, t, h, it.d - 2 * t);
        const side = (it.w - dw) / 2;                                                      // front, with the lift door
        A.col.box(P(-a + side / 2, b - t / 2, h / 2), ex, ey, ez, side, h, t);
        A.col.box(P(a - side / 2, b - t / 2, h / 2), ex, ey, ez, side, h, t);
        A.col.box(P(0, b - t / 2, (dh + h) / 2), ex, ey, ez, dw, h - dh, t);
        A.door.box(P(0, b - t / 2, dh / 2), ex, ey, ez, dw, dh, 0.04);
      } else if (it.kind === "column") {
        const q = itemOutline(p, it), top = q.map(([x, z]) => [x, y0 + h, z]), bot = q.map(([x, z]) => [x, y0, z]);
        for (let i = 1; i + 1 < q.length; i++) { A.col.tri(top[0], top[i + 1], top[i]); A.col.tri(bot[0], bot[i], bot[i + 1]); }
        for (let i = 0; i < q.length; i++) { const j = (i + 1) % q.length; A.col.quad(bot[i], bot[j], top[j], top[i]); }
      }
    }
  }
}
/** Outside-wall doors grouped by wall: "block:loop:edge" -> [{u, w, h, kind, levels}]. */
function facadeDoors(p, blocks){
  const items = (p.interior || []).map(clampItem), out = new Map();
  for (const d of items) if ((d.kind === "door" || d.kind === "opening") && d.host && typeof d.host === "object") {
    const k = `${d.host.b}:${d.host.l}:${d.host.e}`;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push({ ...d, levels: levelsOf(blocks, d, items) });
  }
  return out;
}

/* ---- drawing help for the Interior tool: snapping, picking and live dimensions, all in plan metres ---- */
// Surfaces a wall can run to on a storey: the inside faces of the outside walls, and both faces of internal walls.
function surfacesOn(p, blocks, L, skipId){
  const segs = [], pts = [], tw = p.wallThickness, items = (p.interior || []).map(clampItem);
  for (const b of blocks) {
    if (L < b.base || L >= b.base + b.n) continue;
    const bi = blocks.indexOf(b);
    [b.fp.outer, ...b.fp.holes].forEach((loop, li) => {
      const E = edges(loop, li !== 0), T = E.map((_, ei) => facadeParams(p, bi, li, ei).wallThickness);
      if (T.every(t => Math.abs(t - tw) < 1e-6)) { const inner = offsetLoop(loop, -tw, li !== 0); inner.forEach((A, i) => { segs.push({ A, B: inner[(i + 1) % inner.length], kind: "face" }); pts.push(A); }); return; }
      E.forEach((ed, ei) => { const t = T[ei], A = [ed.A[0] - ed.n[0] * t, ed.A[1] - ed.n[1] * t], B = [ed.B[0] - ed.n[0] * t, ed.B[1] - ed.n[1] * t]; segs.push({ A, B, kind: "face" }); pts.push(A, B); });
    });
  }
  for (const it of items) {
    if (it.id === skipId || !levelsOf(blocks, it, items).includes(L)) continue;
    if (it.kind === "wall") {
      const q = itemOutline(p, it);
      segs.push({ A: q[0], B: q[1], kind: "face", id: it.id }, { A: q[3], B: q[2], kind: "face", id: it.id }, { A: it.a, B: it.b, kind: "centre", id: it.id });
      pts.push(it.a, it.b);
    } else if (it.kind === "core" || it.kind === "stair" || it.kind === "column") {
      const q = itemOutline(p, it); q.forEach((A, i) => segs.push({ A, B: q[(i + 1) % q.length], kind: "face", id: it.id }));
    }
  }
  return { segs, pts };
}
/** Snap a pointer position on storey L. from: the previous point of a wall being drawn (angle snaps to 45°). */
export function snapPlan(raw, L, pt, tol, from, free){
  const p = clampParams(raw), { segs, pts } = surfacesOn(p, blocksFor(p), L);
  for (const q of pts) if (Math.hypot(q[0] - pt[0], q[1] - pt[1]) < tol) return { pt: q.slice(), kind: "end" };
  if (from && !free) {
    const a = Math.atan2(pt[1] - from[1], pt[0] - from[0]), sa = Math.round(a / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(pt[0] - from[0], pt[1] - from[1]);
    const dir = [Math.cos(sa), Math.sin(sa)], on = [from[0] + dir[0] * len, from[1] + dir[1] * len];
    let best = null;   // where the snapped direction meets a surface near the pointer
    for (const s of segs) {
      if (s.kind === "centre") continue;
      const dx = s.B[0] - s.A[0], dz = s.B[1] - s.A[1], den = dir[0] * dz - dir[1] * dx;
      if (Math.abs(den) < 1e-6) continue;
      const tt = ((s.A[0] - from[0]) * dz - (s.A[1] - from[1]) * dx) / den, uu = ((s.A[0] - from[0]) * dir[1] - (s.A[1] - from[1]) * dir[0]) / den;
      if (tt <= 0.05 || uu < -0.001 || uu > 1.001) continue;
      const q = [from[0] + dir[0] * tt, from[1] + dir[1] * tt], dd = Math.hypot(q[0] - on[0], q[1] - on[1]);
      if (dd < tol && (!best || dd < best.dd)) best = { dd, q };
    }
    if (best) return { pt: best.q, kind: "face" };
    return { pt: [from[0] + dir[0] * Math.round(len / 0.05) * 0.05, from[1] + dir[1] * Math.round(len / 0.05) * 0.05], kind: "angle" };
  }
  let best = null;
  for (const s of segs) { const r = segDist(pt, s.A, s.B); if (r.d < tol && (!best || r.d < best.d)) best = { d: r.d, q: r.q }; }
  if (best) return { pt: best.q, kind: "face" };
  return { pt: [Math.round(pt[0] / 0.05) * 0.05, Math.round(pt[1] / 0.05) * 0.05], kind: "free" };
}
/** The interior item under a pointer on storey L, or null. */
export function pickInterior(raw, L, pt, tol){
  const p = clampParams(raw), blocks = blocksFor(p), items = (p.interior || []).map(clampItem), on = items.filter(it => levelsOf(blocks, it, items).includes(L));
  for (const d of on) if (d.kind === "door" || d.kind === "opening") { const c = doorCentre(p, blocks, items, d); if (c && Math.hypot(c[0] - pt[0], c[1] - pt[1]) < d.w / 2 + tol) return d.id; }
  for (const it of on) if (it.kind === "column" || it.kind === "core" || it.kind === "stair") { if (insidePoly(itemOutline(p, it), pt) || segDistToLoop(itemOutline(p, it), pt) < tol) return it.id; }
  for (const w of on) if (w.kind === "wall" && segDist(pt, w.a, w.b).d < w.t / 2 + tol) return w.id;
  return null;
}
const segDistToLoop = (q, pt) => Math.min(...q.map((A, i) => segDist(pt, A, q[(i + 1) % q.length]).d));
// The wall a door sits on, as a line: start, direction, length, wall thickness, outward normal.
function hostLine(p, blocks, items, d){
  if (typeof d.host === "string") {
    const w = items.find(x => x.id === d.host); if (!w) return null;
    const dx = w.b[0] - w.a[0], dz = w.b[1] - w.a[1], L = Math.hypot(dx, dz) || 1e-9;
    return { A: w.a, e: [dx / L, dz / L], n: [-dz / L, dx / L], L, t: w.t, inset: 0 };
  }
  const b = blocks[d.host.b]; if (!b) return null;
  const loop = d.host.l === 0 ? b.fp.outer : b.fp.holes[d.host.l - 1]; if (!loop) return null;
  const ed = edges(loop, d.host.l !== 0)[d.host.e]; if (!ed) return null;
  return { A: ed.A, e: ed.e, n: ed.n, L: ed.L, t: p.wallThickness, inset: -p.wallThickness / 2, outside: true };
}
function doorCentre(p, blocks, items, d){
  const h = hostLine(p, blocks, items, d); if (!h) return null;
  return [h.A[0] + h.e[0] * d.u + h.n[0] * h.inset, h.A[1] + h.e[1] * d.u + h.n[1] * h.inset];
}
/** A door or opening for a click: on the nearest internal wall, or the nearest outside wall, on storey L. */
export function doorFromClick(raw, L, pt, tol, kind){
  const p = clampParams(raw), blocks = blocksFor(p), items = (p.interior || []).map(clampItem), base = INTERIOR_DEFAULTS[kind];
  let best = null;
  for (const w of items) if (w.kind === "wall" && levelsOf(blocks, w, items).includes(L)) {
    const r = segDist(pt, w.a, w.b), len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    if (r.d < w.t / 2 + tol && (!best || r.d < best.d)) best = { d: r.d, host: w.id, u: r.t * len, L: len };
  }
  blocks.forEach((b, bi) => {
    if (L < b.base || L >= b.base + b.n) return;
    [b.fp.outer, ...b.fp.holes].forEach((loop, li) => edges(loop, li !== 0).forEach((ed, ei) => {
      const r = segDist(pt, ed.A, ed.B);
      if (r.d < p.wallThickness + tol && (!best || r.d < best.d)) best = { d: r.d, host: { b: bi, l: li, e: ei }, u: r.t * ed.L, L: ed.L, outside: true };
    }));
  });
  if (!best) return null;
  const w = Math.min(base.w, best.L - 0.2);
  if (w < 0.5) return null;
  return { kind, host: best.host, u: Math.min(best.L - w / 2 - 0.05, Math.max(w / 2 + 0.05, Math.round(best.u / 0.05) * 0.05)), w, h: base.h, swing: 1,
    lv: best.outside ? [L, L] : null, outside: !!best.outside };
}
// Clear distance from a point along a direction to the nearest surface (face of a wall), or null.
function castClear(segs, from, dir, skipId, maxD = 200){
  let best = null;
  for (const s of segs) {
    if (s.kind === "centre" || (skipId && s.id === skipId)) continue;
    const dx = s.B[0] - s.A[0], dz = s.B[1] - s.A[1], den = dir[0] * dz - dir[1] * dx;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((s.A[0] - from[0]) * dz - (s.A[1] - from[1]) * dx) / den, u = ((s.A[0] - from[0]) * dir[1] - (s.A[1] - from[1]) * dir[0]) / den;
    if (t > 1e-4 && t < maxD && u >= -1e-6 && u <= 1 + 1e-6 && (best == null || t < best)) best = t;
  }
  return best;
}
/** Live dimensions for a selected interior item on storey L. Each one's set(v) returns the changed item. */
export function interiorDims(raw, L, id){
  const p = clampParams(raw), blocks = blocksFor(p), items = (p.interior || []).map(clampItem), it = items.find(x => x.id === id);
  if (!it) return [];
  const y = L * p.storeyHeight + p.slabThickness + 0.05 + liftAt(blocks, anchorOf(it), L), Y = q => [q[0], y, q[1]], out = [];
  const { segs } = surfacesOn(p, blocks, L, it.id);
  const d = (key, a, b, value, hint, set, extra = {}) => out.push({ key, a: Y(a), b: b && Y(b), value, unit: "m", step: 0.05, min: 0.05, max: 300, hint, set, ...extra });
  const clear = (from, dir, key, hint, move) => {   // a clear distance that moves the item when you type a new one
    const t = castClear(segs, from, dir, it.id); if (t == null || t > 60) return;
    d(key, from, [from[0] + dir[0] * t, from[1] + dir[1] * t], t, hint, v => move(t - v));
  };
  const shift = (o, k) => o.kind === "wall" ? { ...o, a: [o.a[0] + k[0], o.a[1] + k[1]], b: [o.b[0] + k[0], o.b[1] + k[1]] } : { ...o, x: o.x + k[0], z: o.z + k[1] };
  if (it.kind === "wall") {
    const dx = it.b[0] - it.a[0], dz = it.b[1] - it.a[1], len = Math.hypot(dx, dz) || 1e-9, e = [dx / len, dz / len], n = [-e[1], e[0]], m = [(it.a[0] + it.b[0]) / 2, (it.a[1] + it.b[1]) / 2], h = it.t / 2;
    d("length", [it.a[0] + n[0] * (h + 0.4), it.a[1] + n[1] * (h + 0.4)], [it.b[0] + n[0] * (h + 0.4), it.b[1] + n[1] * (h + 0.4)], len, "Wall length (centreline)", v => ({ ...it, b: [it.a[0] + e[0] * v, it.a[1] + e[1] * v] }));
    d("t", [it.a[0] + e[0] * len * 0.25 - n[0] * h, it.a[1] + e[1] * len * 0.25 - n[1] * h], [it.a[0] + e[0] * len * 0.25 + n[0] * h, it.a[1] + e[1] * len * 0.25 + n[1] * h], it.t, "Wall thickness", v => ({ ...it, t: v }), { step: 0.01, min: 0.05, max: 0.6 });
    clear([m[0] + n[0] * h, m[1] + n[1] * h], n, "clearA", "Clear distance to the next wall (this side)", k => shift(it, [n[0] * k, n[1] * k]));
    clear([m[0] - n[0] * h, m[1] - n[1] * h], [-n[0], -n[1]], "clearB", "Clear distance to the next wall (other side)", k => shift(it, [-n[0] * k, -n[1] * k]));
  } else if (it.kind === "door" || it.kind === "opening") {
    const hl = hostLine(p, blocks, items, it); if (!hl) return out;
    const P = (u, w) => [hl.A[0] + hl.e[0] * u + hl.n[0] * (hl.inset + w), hl.A[1] + hl.e[1] * u + hl.n[1] * (hl.inset + w)], off = (hl.t / 2 + 0.35) * (hl.outside ? -1 : 1);
    d("w", P(it.u - it.w / 2, off), P(it.u + it.w / 2, off), it.w, it.kind === "door" ? "Door width" : "Opening width", v => ({ ...it, w: v }), { min: 0.5, max: Math.max(0.6, hl.L - 0.1) });
    out.push({ key: "h", a: Y(P(it.u, 0)), value: it.h, unit: "m", step: 0.05, min: 1.8, max: 6, point: true, hint: (it.kind === "door" ? "Door" : "Opening") + " height", set: v => ({ ...it, h: v }) });
    const start = hl.outside ? p.wallThickness : 0, o = it.u - it.w / 2 - start;
    d("offset", P(start, off * 1.8), P(it.u - it.w / 2, off * 1.8), o, "Distance from the end of the wall", v => ({ ...it, u: start + v + it.w / 2 }));
  } else {
    const { e, n } = ROT(it.ang), q = itemOutline(p, it), bb = { u: 0, w: 0 };
    for (const v of q) { bb.u = Math.max(bb.u, (v[0] - it.x) * e[0] + (v[1] - it.z) * e[1]); bb.w = Math.max(bb.w, (v[0] - it.x) * n[0] + (v[1] - it.z) * n[1]); }
    const at = (u, w) => [it.x + e[0] * u + n[0] * w, it.z + e[1] * u + n[1] * w];
    if (it.kind === "stair") {
      d("w", at(-bb.u - 0.4, -bb.w), at(-bb.u - 0.4, it.type === "straight" ? bb.w : -bb.w + it.w), it.w, "Flight width", v => ({ ...it, w: v }), { min: 0.7, max: 4 });
      const s = stairPlan(it, p.storeyHeight);
      out.push({ key: "info", a: Y(at(0, 0)), value: s.R, unit: "risers", step: 1, min: s.R, max: s.R, point: true, readOnly: true, hint: `${s.R} risers of ${(s.r * 1000).toFixed(0)} mm, goings 260 mm, ${s.L.toFixed(2)} m long. T switches dog-leg / straight / half flight.` });
      if (it.rise) out.push({ key: "rise", a: Y(at(bb.u * 0.6, 0)), value: it.rise, unit: "m", step: 0.05, min: 0.3, max: p.storeyHeight, point: true, hint: "Half flight rise (match the split)", set: v => ({ ...it, rise: v }) });
    } else if (it.kind === "core") {
      d("w", at(-bb.u, -bb.w - 0.4), at(bb.u, -bb.w - 0.4), it.w, "Core width", v => ({ ...it, w: v }), { min: 1, max: 12 });
      d("d", at(bb.u + 0.4, -bb.w), at(bb.u + 0.4, bb.w), it.d, "Core depth", v => ({ ...it, d: v }), { min: 1, max: 12 });
    } else d("s", at(-bb.u, -bb.w - 0.3), at(bb.u, -bb.w - 0.3), it.s, it.round ? "Column diameter" : "Column size", v => ({ ...it, s: v }), { step: 0.05, min: 0.15, max: 2 });
    clear(at(-bb.u, 0), [-e[0], -e[1]], "clearU", "Clear distance to the wall", k => shift(it, [-e[0] * k, -e[1] * k]));
    clear(at(0, -bb.w), [-n[0], -n[1]], "clearW", "Clear distance to the wall", k => shift(it, [-n[0] * k, -n[1] * k]));
  }
  return out;
}

/** The outside wall under a click on storey L: its key and line, or null. */
export function facadeAt(raw, L, pt, tol){
  const p = clampParams(raw), blocks = blocksFor(p);
  let best = null;
  blocks.forEach((b, bi) => {
    if (L < b.base || L >= b.base + b.n) return;
    [b.fp.outer, ...b.fp.holes].forEach((loop, li) => edges(loop, li !== 0).forEach((ed, ei) => {
      const r = segDist(pt, ed.A, ed.B);
      if (r.d < facadeParams(p, bi, li, ei).wallThickness + tol && (!best || r.d < best.d)) best = { d: r.d, key: facadeKey(bi, li, ei), ed };
    }));
  });
  return best;
}
/** Live dimension for a selected outside wall: its own thickness. set(v) returns the new facades map. */
export function facadeDims(raw, L, key){
  const p = clampParams(raw), [bi, li, ei] = key.split(":").map(Number), b = blocksFor(p)[bi]; if (!b) return [];
  const loop = li === 0 ? b.fp.outer : b.fp.holes[li - 1], ed = loop && edges(loop, li !== 0)[ei]; if (!ed) return [];
  const fp = facadeParams(p, bi, li, ei), tw = fp.wallThickness, y = L * p.storeyHeight + p.slabThickness + 0.05 + b.lift, m = [ed.A[0] + ed.e[0] * ed.L / 2, ed.A[1] + ed.e[1] * ed.L / 2];
  const cur = { ...(p.facades || {}) }, set = patch => ({ ...cur, [key]: { ...(cur[key] || {}), ...patch } });
  return [
    { key: "ft", a: [m[0], y, m[1]], b: [m[0] - ed.n[0] * tw, y, m[1] - ed.n[1] * tw], value: tw, unit: "m", step: 0.01, min: LIMITS.wallThickness[0], max: LIMITS.wallThickness[1], hint: "This wall's thickness", set: v => set({ t: v }) },
    { key: "fl", a: [ed.A[0], y, ed.A[1]], b: [ed.B[0], y, ed.B[1]], value: ed.L, unit: "m", step: 0.1, min: ed.L, max: ed.L, readOnly: true, hint: `Wall length. Windows: ${fp.windowType === "curtain" ? "glass curtain wall" : fp.windowType}. G cycles windows / ribbon / curtain wall / solid.` },
  ];
}
export const cycleWindows = t => ({ punched: "ribbon", ribbon: "curtain", curtain: "none", none: "punched" })[t] || "punched";
export const facadeWindowType = (raw, key) => { const p = clampParams(raw), [b, l, e] = key.split(":").map(Number); return facadeParams(p, b, l, e).windowType; };

/** The building as sketch blocks (so a parametric building can take a different plan on its upper levels). */
export function asSketch(raw){
  const p = clampParams(raw);
  if (p.shape === "sketch") return { params: p, converted: false };
  const blocks = blocksFor(p);
  const sk = { w0: p.width, d0: p.depth, blocks: blocks.map(b => ({ outer: b.fp.outer.map(q => q.slice()), holes: b.fp.holes.map(h => h.map(q => q.slice())), parent: null, storeys: b.n, ...(b.lift ? { lift: b.lift } : {}) })) };
  return { params: { ...p, shape: "sketch", sketch: sk }, converted: true };
}
/** A plan read for one level: from that level up, the building follows it. Floors above it in the old plan are
    replaced; the new blocks sit centred on the building (shift them with their dimensions). */
export function mergeLevelSketch(raw, reading, level){
  const { params: p, converted } = asSketch(raw), notes = [];
  if (converted && (p.twistDeg || p.taper !== 100 || p.roofType !== "flat")) notes.push("The building below was turned into plain blocks so a new plan can sit on it.");
  const k = p.width / p.sketch.w0, bl = blocksFor(p), old = p.sketch.blocks;
  const top = Math.max(...bl.map(b => b.base + b.n));
  // keep what's below the level, cut at it
  const keep = [], remap = new Map();
  old.forEach((b, i) => {
    const base = bl[i].base, n = bl[i].n;
    if (base >= level) return;
    remap.set(i, keep.length);
    keep.push({ ...b, storeys: Math.min(n, level - base), ...(b.level == null && b.parent != null ? {} : { level: base }) });
  });
  keep.forEach(b => { if (b.parent != null) b.parent = remap.has(b.parent) ? remap.get(b.parent) : null; });
  const nb = reading.params.sketch.blocks, off = keep.length, untilTop = Math.max(1, top - level);
  // Where the plan below showed this floor dashed, fit the new plan onto that outline (size, turn and place): the
  // two photos then line up however they were taken. Otherwise it sits centred on the building.
  const target = old.find((b, i) => b.fromAbove && bl[i].base === level);
  const rk = (reading.params.width || reading.params.sketch.w0) / reading.params.sketch.w0;   // the reading's own scale
  let X = q => [q[0] * rk / k, q[1] * rk / k];
  if (target) {
    const src = nb.filter(b => b.parent == null).sort((a, b) => Math.abs(shoelace(b.outer)) - Math.abs(shoelace(a.outer)))[0].outer, tgt = target.outer;
    const cS = centroid(src), cT = centroid(tgt), sc = Math.sqrt(Math.abs(shoelace(tgt)) / Math.abs(shoelace(src)));
    const ring = (q, n = 64) => { const P = perim(q), out = []; let acc = 0, i = 0; for (let j = 0; j < n; j++) { const want = j / n * P; while (i < q.length) { const A = q[i], B = q[(i + 1) % q.length], L = Math.hypot(B[0] - A[0], B[1] - A[1]); if (acc + L >= want) { const t = (want - acc) / (L || 1); out.push([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t]); break; } acc += L; i++; } } return out; };
    const rs = ring(src), rt = ring(tgt);
    let best = null;
    for (let deg = 0; deg < 360; deg += 2) {
      const a = deg * Math.PI / 180, c = Math.cos(a), si = Math.sin(a);
      const f = ([x, z]) => { const u = (x - cS[0]) * sc, v = (z - cS[1]) * sc; return [cT[0] + u * c - v * si, cT[1] + u * si + v * c]; };
      const m = rs.map(f), score = m.reduce((s2, p2) => s2 + segDistToLoop(tgt, p2), 0) + rt.reduce((s2, p2) => s2 + segDistToLoop(m, p2), 0);
      if (!best || score < best.score) best = { score, f, deg };
    }
    X = q => best.f(q);   // (src and the fit are both in the reading's own units, so its scale is folded in)
    notes.push(`fitted onto the outline drawn dashed on the plan below (turned ${best.deg}°, scaled ×${sc.toFixed(2)})`);
  }
  const added = nb.map(b => ({ ...b, outer: b.outer.map(X), holes: (b.holes || []).map(h => h.map(X)),
    ...(b.roof ? { roof: { ...b.roof, outline: b.roof.outline ? b.roof.outline.map(X) : null, ...(b.roof.apex ? { apex: X(b.roof.apex) } : {}) } } : {}),
    parent: b.parent != null ? b.parent + off : null, ...(b.parent == null ? { level } : {}), storeys: b.storeys ?? (b.parent == null ? (target ? (bl[old.indexOf(target)].n) : untilTop) : null), grp: level }));
  // the new plan's walls (solid / glazed) come with it, renumbered; the old ones keep their numbers where they stay
  const facades = {};
  for (const [key, v] of Object.entries(p.facades || {})) { const [b0, ...rest] = key.split(":"); if (remap.has(+b0)) facades[[remap.get(+b0), ...rest].join(":")] = v; }
  for (const [key, v] of Object.entries(reading.params.facades || {})) { const [b0, ...rest] = key.split(":"); facades[[+b0 + off, ...rest].join(":")] = v; }
  if (nb.some(b => b.parent == null && b.storeys == null)) notes.push(`blocks with no storeys written run to the old roof (${untilTop} storey${untilTop > 1 ? "s" : ""})`);
  if (!reading.params.sketch.blocks.length) return { error: "Nothing to add." };
  return { params: { ...p, facades, sketch: { ...p.sketch, blocks: [...keep, ...added] } }, notes };
}
