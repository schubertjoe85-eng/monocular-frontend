// Copied from Monocular Desktop (src/autodim.js) - keep the two in step.
/* Automatic dimensions for plans, sections and elevations, read from the model's own geometry.
   Shared by Monocular Desktop and Monocular 1 (copied to local-render/autodim.js - keep the two in step).

   Everything is measured in world space and handed back as dimension lines in world space; drawDims() projects them
   with the drawing's own orthographic camera and draws them onto the finished drawing.
   - Plan: the cut through the model at the plan height. Exterior strings on two sides: the wall faces and openings
     (where the cut wall line breaks), then the overall length. Aligned to the building's main direction.
   - Section: the cut through the model at the knife. Overall width, and a level string up the side: ground, each
     floor, and the top of the cut.
   - Elevation: the whole model seen side on. Overall width, and the same level string. */
import * as THREE from "three";

// every visible triangle of root, in world space
function eachTri(root, fn){
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse(m => {
    if (!m.isMesh || !m.visible || !m.geometry || !m.geometry.attributes.position) return;
    for (let o = m.parent; o; o = o.parent) if (!o.visible) return;
    const P = m.geometry.attributes.position, I = m.geometry.index, n = I ? I.count : P.count;
    for (let i = 0; i + 2 < n; i += 3) {
      a.fromBufferAttribute(P, I ? I.getX(i) : i).applyMatrix4(m.matrixWorld);
      b.fromBufferAttribute(P, I ? I.getX(i + 1) : i + 1).applyMatrix4(m.matrixWorld);
      c.fromBufferAttribute(P, I ? I.getX(i + 2) : i + 2).applyMatrix4(m.matrixWorld);
      fn(a, b, c);
    }
  });
}
// where a triangle crosses a plane (signed distance f), as a segment of two points, or null
function cross(a, b, c, f){
  const fa = f(a), fb = f(b), fc = f(c), out = [];
  const edge = (p, q, fp, fq) => { if ((fp > 0) !== (fq > 0)) out.push(p.clone().lerp(q, fp / (fp - fq))); };
  edge(a, b, fa, fb); edge(b, c, fb, fc); edge(c, a, fc, fa);
  return out.length === 2 ? out : null;
}
const cluster = (vals, tol) => { const s = [...vals].sort((x, y) => x - y), out = []; for (const v of s) if (!out.length || v - out[out.length - 1] > tol) out.push(v); return out; };

// Floor levels: heights with a lot of flat, upward-facing surface (slab tops, decks, ground platforms).
function levelsOf(root, keep){
  const bins = new Map(), ab = new THREE.Vector3(), ac = new THREE.Vector3();
  eachTri(root, (a, b, c) => {
    if (keep && !keep(a, b, c)) return;
    const n = ab.subVectors(b, a).cross(ac.subVectors(c, a)), area = n.length() / 2;
    if (area < 1e-4 || n.y / (2 * area) < 0.995) return;
    const k = Math.round((a.y + b.y + c.y) / 3 / 0.02);
    bins.set(k, (bins.get(k) || 0) + area);
  });
  const list = [...bins].map(([k, area]) => ({ y: k * 0.02, area })).sort((p, q) => q.area - p.area);
  if (!list.length) return [];
  const min = Math.max(1.5, list[0].area * 0.12), out = [];
  for (const L of list) { if (L.area < min) break; if (!out.some(o => Math.abs(o.y - L.y) < 0.25)) out.push(L); }
  return out.map(o => o.y).sort((p, q) => p - q);
}

// ---- plan
export function planDims(root, cutY, opts = {}){
  const segs = [];
  eachTri(root, (a, b, c) => { const s = cross(a, b, c, p => p.y - cutY); if (s) segs.push(s); });
  if (!segs.length) return [];
  // the building's main direction: length-weighted angles, folded into 90°
  const hist = new Float64Array(90);
  for (const [p, q] of segs) { const dx = q.x - p.x, dz = q.z - p.z, l = Math.hypot(dx, dz); if (l < 1e-4) continue; let d = Math.round(((Math.atan2(dz, dx) * 180 / Math.PI) % 90 + 90) % 90) % 90; hist[d] += l; }
  let best = 0; for (let i = 0; i < 90; i++) { const s = hist[i] + 0.5 * (hist[(i + 1) % 90] + hist[(i + 89) % 90]); if (s > best) { best = s; opts.angle = i; } }
  const th = (opts.angle || 0) * Math.PI / 180, U = new THREE.Vector3(Math.cos(th), 0, Math.sin(th)), V = new THREE.Vector3(-Math.sin(th), 0, Math.cos(th));
  const S = segs.map(([p, q]) => [p.dot(U), p.dot(V), q.dot(U), q.dot(V)]);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const s of S) { u0 = Math.min(u0, s[0], s[2]); u1 = Math.max(u1, s[0], s[2]); v0 = Math.min(v0, s[1], s[3]); v1 = Math.max(v1, s[1], s[3]); }
  const span = Math.max(u1 - u0, v1 - v0), room = opts.room ?? span * 0.3;
  const off1 = Math.min(Math.max(0.6, span * 0.05), room * 0.45), off2 = Math.min(off1 * 1.9, room * 0.85);
  const at = (u, v) => U.clone().multiplyScalar(u).addScaledVector(V, v).setY(cutY);
  const dims = [];
  // one side: the wall line within `band` of it, where it runs and where it breaks
  const side = (axis, edge, out) => {
    const band = 0.6, along = axis === 0 ? 0 : 1, across = 1 - along, iv = [];
    for (const s of S) {
      const a0 = s[along], a1 = s[along + 2], c0 = s[across], c1 = s[across + 2];
      if (Math.abs(c0 - edge) > band || Math.abs(c1 - edge) > band) continue;
      if (Math.abs(a1 - a0) < Math.abs(c1 - c0)) continue;   // runs across the side: a return, not the wall line
      iv.push([Math.min(a0, a1), Math.max(a0, a1)]);
    }
    iv.sort((p, q) => p[0] - q[0]);
    const runs = [];
    for (const r of iv) { if (runs.length && r[0] <= runs[runs.length - 1][1] + 0.03) runs[runs.length - 1][1] = Math.max(runs[runs.length - 1][1], r[1]); else runs.push([...r]); }
    const lo = axis === 0 ? u0 : v0, hi = axis === 0 ? u1 : v1;
    let pts = cluster([lo, hi, ...runs.filter(r => r[1] - r[0] > 0.05).flat()], 0.08).filter(x => x >= lo - 1e-6 && x <= hi + 1e-6);
    const P = (a, d) => axis === 0 ? at(a, edge + d) : at(edge + d, a), o = (axis === 0 ? V : U).clone().multiplyScalar(out);
    if (pts.length > 2 && pts.length <= 24) for (let i = 0; i + 1 < pts.length; i++) dims.push({ a: P(pts[i], 0), b: P(pts[i + 1], 0), o, off: off1 });
    dims.push({ a: P(lo, 0), b: P(hi, 0), o, off: pts.length > 2 && pts.length <= 24 ? off2 : off1 });
  };
  side(0, v0, -1);   // along U, on the -V side
  side(1, u0, -1);   // along V, on the -U side
  return dims;
}

// ---- section (plane given) and elevation (plane null): t is the drawing's horizontal axis (world, unit, y = 0)
export function sideDims(root, t, plane, opts = {}){
  let lo = Infinity, hi = -Infinity, yLo = Infinity, yHi = -Infinity, depth = 0, nd = 0;
  const n = plane ? plane.normal : null;
  const take = p => { const u = p.dot(t); lo = Math.min(lo, u); hi = Math.max(hi, u); yLo = Math.min(yLo, p.y); yHi = Math.max(yHi, p.y); };
  if (plane) eachTri(root, (a, b, c) => { const s = cross(a, b, c, p => plane.distanceToPoint(p)); if (s) { take(s[0]); take(s[1]); depth += s[0].dot(n); nd++; } });
  else eachTri(root, (a, b, c) => { take(a); take(b); take(c); });
  if (!Number.isFinite(lo)) return [];
  // levels: in a section, the floors the cut passes through (flat faces within 1 m of the cut); else the whole model's
  const keep = plane ? (a, b, c) => Math.abs(plane.distanceToPoint(a.clone().add(b).add(c).divideScalar(3))) < 1 : null;
  const base = opts.ground ?? yLo;
  let ys = levelsOf(root, keep).filter(y => y > base + 0.05 && y < yHi - 0.3);
  ys = cluster([base, ...ys, yHi], 0.05);
  const wide = hi - lo, room = opts.room ?? wide * 0.3, off1 = Math.min(Math.max(0.6, wide * 0.05), room * 0.45), off2 = Math.min(off1 * 1.9, room * 0.85);
  const dn = plane ? depth / Math.max(1, nd) : 0, N = n ? n.clone() : new THREE.Vector3().crossVectors(t, new THREE.Vector3(0, 1, 0));
  const at = (u, y) => t.clone().multiplyScalar(u).addScaledVector(N, dn).setY(y);
  const dims = [], left = t.clone().multiplyScalar(-1);
  if (ys.length > 2) for (let i = 0; i + 1 < ys.length; i++) dims.push({ a: at(lo, ys[i]), b: at(lo, ys[i + 1]), o: left, off: off1 });
  dims.push({ a: at(lo, ys[0]), b: at(lo, ys[ys.length - 1]), o: left, off: ys.length > 2 ? off2 : off1 });
  dims.push({ a: at(lo, base), b: at(hi, base), o: new THREE.Vector3(0, -1, 0), off: off1 });
  // level marks on the right: height above the lowest level
  for (const y of ys) dims.push({ level: true, p: at(hi, y), o: t.clone(), off: off1 * 0.6, text: (y - ys[0] < 0.0005 ? "±" : "+") + (y - ys[0]).toFixed(3) });
  return dims;
}

// Draw dimensions onto a 2D canvas. project(worldVec) -> [x, y] in canvas pixels; k: canvas pixels per metre.
export function drawDims(g, dims, project, k, opts = {}){
  const W = g.canvas.width, fs = opts.fontPx || Math.max(11, W * 0.0085), col = opts.colour || "#1d2a33";
  g.save(); g.strokeStyle = col; g.fillStyle = col; g.lineWidth = Math.max(1, W / 1600); g.lineCap = "butt";
  g.font = `600 ${fs}px Helvetica, Arial, sans-serif`;
  const line = (p, q) => { g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.stroke(); };
  for (const d of dims) {
    if (d.level) {
      const p = project(d.p), q = project(d.p.clone().addScaledVector(d.o, d.off)), r = fs * 0.45;
      line(p, q);
      g.beginPath(); g.moveTo(q[0], q[1]); g.lineTo(q[0] + r, q[1] - r); g.lineTo(q[0] - r, q[1] - r); g.closePath(); g.stroke();
      g.textAlign = "left"; g.textBaseline = "bottom"; g.fillText(d.text, q[0] + r * 1.4, q[1] - 1);
      continue;
    }
    const gap = Math.min(0.25, d.off * 0.25), ext = Math.min(0.25, d.off * 0.2);
    const A = d.a.clone().addScaledVector(d.o, d.off), B = d.b.clone().addScaledVector(d.o, d.off);
    const pa = project(A), pb = project(B), mm = Math.round(d.a.distanceTo(d.b) * 1000);
    if (Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) < 3) continue;
    line(project(d.a.clone().addScaledVector(d.o, gap)), project(d.a.clone().addScaledVector(d.o, d.off + ext)));
    line(project(d.b.clone().addScaledVector(d.o, gap)), project(d.b.clone().addScaledVector(d.o, d.off + ext)));
    line(pa, pb);
    const dx = pb[0] - pa[0], dy = pb[1] - pa[1], L = Math.hypot(dx, dy), ux = dx / L, uy = dy / L, t = fs * 0.45;
    for (const p of [pa, pb]) line([p[0] - (ux - uy) * t, p[1] - (uy + ux) * t], [p[0] + (ux - uy) * t, p[1] + (uy + ux) * t]);   // 45° ticks
    let ang = Math.atan2(dy, dx); if (ang > Math.PI / 2) ang -= Math.PI; if (ang <= -Math.PI / 2) ang += Math.PI;
    const txt = String(mm), tw = g.measureText(txt).width;
    if (tw > L * 1.05 && L < fs * 2) continue;   // too short to label
    // text on the outer side of the line
    const op = project(A.clone().addScaledVector(d.o, 1)), side = Math.sign((op[0] - pa[0]) * -Math.sin(ang) + (op[1] - pa[1]) * Math.cos(ang)) || -1;
    g.save(); g.translate((pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2); g.rotate(ang);
    g.textAlign = "center"; g.textBaseline = side < 0 ? "bottom" : "top"; g.fillText(txt, 0, side < 0 ? -fs * 0.25 : fs * 0.25);
    g.restore();
  }
  g.restore();
}

// The ground along a drawing: sample heights across the frame by casting down onto `grounds`, or flat at `y0`.
// Returns [[u, y]] for u across [uLo, uHi] along t, on the line through `through`.
export function groundProfile(grounds, t, through, uLo, uHi, y0, n = 160){
  const rc = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0), out = [], c = through.dot(t);
  for (let i = 0; i <= n; i++) {
    const u = uLo + (uHi - uLo) * i / n, p = through.clone().addScaledVector(t, u - c);
    let y = y0;
    if (grounds.length) {
      rc.set(new THREE.Vector3(p.x, 10000, p.z), down); rc.far = 20000;
      const h = rc.intersectObjects(grounds, true)[0];
      if (h) y = h.point.y;
    }
    out.push([u, y]);
  }
  return out;
}
// Earth below the ground line: a pale fill, diagonal hatch, and a heavy line on top. pts: canvas pixels, left to right.
export function drawGround(g, pts, opts = {}){
  if (pts.length < 2) return;
  const W = g.canvas.width, H = g.canvas.height;
  g.save();
  g.beginPath(); g.moveTo(pts[0][0], H); pts.forEach(p => g.lineTo(p[0], p[1])); g.lineTo(pts[pts.length - 1][0], H); g.closePath();
  g.fillStyle = opts.fill || "#ebe6dc"; g.fill();
  g.clip();
  g.strokeStyle = opts.hatch || "rgba(90,80,62,.35)"; g.lineWidth = Math.max(1, W / 2400);
  const s = Math.max(6, W / 160);
  for (let x = -H; x < W + H; x += s) { g.beginPath(); g.moveTo(x, H); g.lineTo(x + H, 0); g.stroke(); }
  g.restore();
  g.save(); g.strokeStyle = opts.line || "#1c1c1c"; g.lineWidth = Math.max(2, W / 600); g.lineJoin = "round";
  g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.stroke();
  g.restore();
}
