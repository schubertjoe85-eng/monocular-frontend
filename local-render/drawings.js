// Copied from Monocular Desktop (src/drawings.js) - keep the two in step.
// drawings.js — turn a PDF drawing set's floor plan into a 3D model, all on this Mac.
//
// The line work comes straight out of the PDF (vectors, not a picture): walls are the dark filled shapes on the plan,
// windows and doors the lines drawn in their gaps. The sheet titles, scale and levels come from Apple Vision reading
// the sheets. Only what the drawings show is built. Anything they don't give (a wall height with no section, the
// roof until the roof plan is read) is said so, never made up.
import * as THREE from "three";

const PT_M = 0.0254 / 72;   // one PDF point, in metres on the paper

/* ---------------- Reading the sheets ---------------- */
/** Which sheet is which, and each one's scale, from what Vision read on them. The title block's own title decides
 *  when there is one (a drawing list or a cover names every other sheet in its text). */
export function classifySheets(ocrPages){
  const KINDS = [
    ["list", /DRAWING LIST|DRAWING REGISTER/], ["cover", /COVER ?PAGE|COVER SHEET/], ["windows", /WINDOW SCHEDULE/], ["doors", /DOOR SCHEDULE/],
    ["roof", /ROOF PLAN/], ["demolition", /DEMOLI/], ["shadow", /SHADOW/], ["survey", /SURVEY/], ["site", /SITE PLAN|SITE LOCATION/],
    ["plan", /FLOOR PLAN|GROUND FLOOR|FIRST FLOOR|UPPER FLOOR|LEVEL \d+ PLAN|^FLOOR PLAN/], ["section", /SECTION/], ["elevation", /ELEVATION/],
    ["electrical", /ELECTRICAL|LIGHTING PLAN/], ["details", /DETAIL|WET AREA/], ["3d", /\b3D\b|PERSPECTIVE/],
  ];
  return ocrPages.map(pg => {
    const text = pg.words.map(w => w.s).join(" "), up = text.toUpperCase();
    // the title block: the words just under "DRAWING TITLE"
    const tw = pg.words.find(w => /DRAWING\s*TITLE/i.test(w.s));
    const title = tw ? pg.words.filter(w => w !== tw && w.y < tw.y + 2 && w.y > tw.y - 45 && w.x > tw.x - 30 && w.x < tw.x + 260 && !/PROJECT|DRAWING NO/i.test(w.s)).sort((a, b) => b.h - a.h)[0]?.s || "" : "";
    const pick = t => (KINDS.find(([, re]) => re.test(t.toUpperCase())) || [null])[0];
    const kind = (title && (/^\s*ROOF\b/i.test(title) ? "roof" : pick(title))) || pick(up) || "other";
    const scales = [...text.matchAll(/1\s*:\s*(\d{2,4})\b/g)].map(m => +m[1]).filter(n => n >= 10 && n <= 2000);
    const levels = [...text.matchAll(/RL\s*(\d{2,4}[.,]\d{1,3})/gi)].map(m => parseFloat(m[1].replace(",", ".")));
    const most = a => { const c = new Map(); for (const v of a) c.set(v, (c.get(v) || 0) + 1); return [...c].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null; };
    const no = (text.match(/\b[A-Z]{1,3}\d{3,4}\b/) || [""])[0];
    return { page: pg.page, kind, title: title || null, number: no || null, scale: most(scales), levels };
  });
}

/* ---------------- Schedules ---------------- */
/** A window schedule: each ID and its nominal width x height (mm), paired by the column they share. */
export function readWindowSchedule(words){
  const ids = words.filter(w => /^W[-\s]?\d{2,3}$/i.test(w.s.trim()));
  const sizes = words.map(w => ({ w, m: w.s.replace(/[,\s]/g, "").match(/^(\d{3,5})[x×X](\d{3,5})$/) })).filter(o => o.m);
  const out = [];
  for (const id of ids) {
    const cx = id.x + id.w / 2;
    const s = sizes.filter(o => Math.abs(o.w.x + o.w.w / 2 - cx) < Math.max(25, id.w)).sort((a, b) => Math.abs(a.w.y - id.y) - Math.abs(b.w.y - id.y))[0];
    if (s && !out.some(o => o.id === id.s.trim())) out.push({ id: id.s.trim().toUpperCase().replace(/\s/, "-"), w: +s.m[1] / 1000, h: +s.m[2] / 1000 });
  }
  return out;
}

/* ---------------- Roof plan ---------------- */
/** Each roof labelled on a roof plan: whose it is (existing / new / carport), its shape and pitch, and its low side. */
export function readRoofPlan(page, scaleN){
  const words = page.words.filter(w => w.x < page.w * 0.8);   // the title block (right side) names the project, not a roof
  const labels = words.filter(w => /dwelling|house|carport|garage|extension|addition|studio|roof system/i.test(w.s));
  const roofs = [];
  const segs = (page.segs || []).map(s => ({ a: [s[0], s[1]], b: [s[2], s[3]] }));
  for (const l of labels) {
    const c = [l.x + l.w / 2, l.y + l.h / 2], who = /exist/i.test(l.s) ? "existing" : /carport|garage/i.test(l.s) ? "carport" : "new";
    if (roofs.some(r => Math.hypot(r.c[0] - c[0], r.c[1] - c[1]) < 60 && r.who === who)) continue;
    // the roof's own lines: those within about a building's reach of its label
    const R = 160, near = segs.filter(s => Math.hypot((s.a[0] + s.b[0]) / 2 - c[0], (s.a[1] + s.b[1]) / 2 - c[1]) < R);
    const diag = near.filter(s => { const dx = Math.abs(s.b[0] - s.a[0]), dy = Math.abs(s.b[1] - s.a[1]), L = Math.hypot(dx, dy); return L > 8 && dx / L > 0.45 && dx / L < 0.9; }).length;
    const txt = words.filter(w => Math.hypot(w.x + w.w / 2 - c[0], w.y + w.h / 2 - c[1]) < R).map(w => w.s).join(" ");
    const pm = txt.match(/(\d{1,2}(?:\.\d)?)\s*(?:°|deg|degrees?)/i);
    const mono = /pitch|skillion|mono|fall/i.test(txt) && pm && diag < 4;
    const type = mono ? "mono" : diag >= 4 ? "hip" : /flat/i.test(txt) ? "flat" : "gable";
    // the low side: towards the gutters and downpipes drawn for it
    const drains = words.filter(w => /gutter|pipe|\bdp\b/i.test(w.s) && Math.hypot(w.x - c[0], w.y - c[1]) < R * 1.4);
    const low = drains.length ? (() => { const d = [drains.reduce((s, w) => s + w.x, 0) / drains.length - c[0], drains.reduce((s, w) => s + w.y, 0) / drains.length - c[1]]; return Math.abs(d[0]) > Math.abs(d[1]) ? (d[0] > 0 ? "east" : "west") : (d[1] > 0 ? "north" : "south"); })() : null;
    roofs.push({ c, who, label: l.s, type, pitch: pm ? +pm[1] : null, low });
  }
  // hips drawn with no legible label near them: a roof all the same (on a renovation, the existing one)
  const diagSegs = segs.filter(s => { const dx = Math.abs(s.b[0] - s.a[0]), dy = Math.abs(s.b[1] - s.a[1]), L = Math.hypot(dx, dy); return L > 8 && dx / L > 0.45 && dx / L < 0.9 && s.a[0] < page.w * 0.8; });
  const loose = diagSegs.filter(s => !roofs.some(r => Math.hypot((s.a[0] + s.b[0]) / 2 - r.c[0], (s.a[1] + s.b[1]) / 2 - r.c[1]) < 160));
  if (loose.length >= 4) {
    const c = [loose.reduce((t, s) => t + (s.a[0] + s.b[0]) / 2, 0) / loose.length, loose.reduce((t, s) => t + (s.a[1] + s.b[1]) / 2, 0) / loose.length];
    roofs.push({ c, who: roofs.some(r => r.who === "existing") ? "new" : "existing", label: null, type: "hip", pitch: null, low: null, unlabelled: true });
  }
  return roofs;
}

/** The scale a plan is drawn at, checked against its own walls: of the scales written on the set (and the usual
 *  ones), the one that makes the outside walls a wall's thickness (about 200 to 400 mm). */
export function planScale(page, written){
  const ts = [];
  for (const poly of page.polys || []) {
    if (Math.max(...poly.rgb) > 0.25 || poly.pts.length < 4) continue;
    const r = asRect(dedupe(poly.pts));
    if (r && r.L > 3 * r.T && r.T > 1) ts.push(r.T);   // page points across a straight piece of wall
  }
  const freq = n => written.filter(v => v === n).length;
  const cands = [...new Set([...written, 100, 50, 200, 20, 250])];
  if (ts.length < 5) return { scale: cands.sort((a, b) => freq(b) - freq(a))[0] || 100, checked: false };
  ts.sort((a, b) => a - b);
  const outer = ts[Math.floor(ts.length * 0.9)];   // the thickest walls are the outside ones
  const fit = n => { const m = outer * PT_M * n; return m >= 0.15 && m <= 0.45 ? 0 : Math.min(Math.abs(m - 0.15), Math.abs(m - 0.45)); };
  // of the scales that make it a real wall, the one the set writes most often
  const best = cands.map((n, i) => ({ n, f: fit(n), c: freq(n), i })).sort((a, b) => a.f - b.f || b.c - a.c || a.i - b.i)[0];
  return { scale: best.n, checked: best.f === 0, wall: outer * PT_M * best.n };
}

/* ---------------- Plan geometry ---------------- */
const area = q => Math.abs(q.reduce((s, a, i) => { const b = q[(i + 1) % q.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0)) / 2;
const perim = q => q.reduce((s, a, i) => { const b = q[(i + 1) % q.length]; return s + Math.hypot(b[0] - a[0], b[1] - a[1]); }, 0);
const dedupe = q => q.filter((p, i) => { const r = q[(i + 1) % q.length]; return Math.hypot(r[0] - p[0], r[1] - p[1]) > 1e-4; });
// A filled shape as an oriented rectangle (centre, direction along, length, thickness), when it is one.
function asRect(q){
  let best = null;
  for (let i = 0; i < q.length; i++) {
    const a = q[i], b = q[(i + 1) % q.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) continue;
    const e = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], n = [-e[1], e[0]];
    const us = q.map(p => p[0] * e[0] + p[1] * e[1]), vs = q.map(p => p[0] * n[0] + p[1] * n[1]);
    const u0 = Math.min(...us), u1 = Math.max(...us), v0 = Math.min(...vs), v1 = Math.max(...vs), A = (u1 - u0) * (v1 - v0);
    if (!best || A < best.A) best = { A, e, n, u0, u1, v0, v1 };
  }
  if (!best || area(q) < 0.88 * best.A) return null;
  let { e, n, u0, u1, v0, v1 } = best;
  if (u1 - u0 < v1 - v0) { [e, n] = [n, [-e[0], -e[1]]]; [u0, u1, v0, v1] = [v0, v1, -u1, -u0]; }   // e runs the long way (n stays square to it)
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  return { c: [e[0] * cu + n[0] * cv, e[1] * cu + n[1] * cv], e, n, L: u1 - u0, T: v1 - v0 };
}
const segHitsRect = (s, r, pad) => {   // does a segment come within the rectangle (grown by pad)?
  for (let k = 0; k <= 8; k++) {
    const x = s[0] + (s[2] - s[0]) * k / 8, y = s[1] + (s[3] - s[1]) * k / 8, dx = x - r.c[0], dy = y - r.c[1];
    if (Math.abs(dx * r.e[0] + dy * r.e[1]) <= r.L / 2 + pad && Math.abs(dx * r.n[0] + dy * r.n[1]) <= r.T / 2 + pad) return true;
  }
  return false;
};

/**
 * One plan sheet's vectors (page points, y up) and its OCR words, at a scale (1:N), to walls and openings in metres.
 * x runs east on the sheet, z south (the sheet's up is north until the user sets the bearing).
 */
export function readPlan(page, words, scaleN){
  const m = PT_M * scaleN, read = [], assumed = [];
  const P = ([x, y]) => [x * m, -y * m];
  // walls: the dark filled shapes a wall's thickness across
  let walls = [];
  for (const poly of page.polys || []) {
    if (Math.max(...poly.rgb) > 0.25) continue;
    const q = dedupe(poly.pts.map(P)); if (q.length < 3) continue;
    const A = area(q), t = 2 * A / perim(q);
    if (A < 0.003 || t < 0.02 || t > 0.6) continue;   // specks, hairlines, or not wall-shaped (north arrows, posts, blobs)
    const rect = asRect(q);
    if (!rect && t < 0.05) continue;
    walls.push({ q, A, t, rect });
  }
  // a wall drawn as two thin skins (cladding and lining) with the gap left white: the pair is one wall
  const thin = walls.filter(w => w.rect && w.rect.T < 0.095 && w.rect.T > 0.015), used = new Set(), paired = [];   // a skin, not a hairline
  for (const a of thin) {
    if (used.has(a)) continue;
    let best = null;
    for (const b of thin) {
      if (b === a || used.has(b) || Math.abs(a.rect.e[0] * b.rect.e[0] + a.rect.e[1] * b.rect.e[1]) < 0.995) continue;
      const d = [b.rect.c[0] - a.rect.c[0], b.rect.c[1] - a.rect.c[1]], off = Math.abs(d[0] * a.rect.n[0] + d[1] * a.rect.n[1]), along = d[0] * a.rect.e[0] + d[1] * a.rect.e[1];
      const overlap = Math.min(a.rect.L, b.rect.L) / 2 + Math.max(a.rect.L, b.rect.L) / 2 - Math.abs(along);
      if (off > 0.06 && off < 0.4 && overlap > 0.6 * Math.min(a.rect.L, b.rect.L) && (!best || off < best.off)) best = { b, off };
    }
    if (!best) continue;
    used.add(a); used.add(best.b);
    const r = a.rect, pts = [...a.q, ...best.b.q], us = pts.map(p => p[0] * r.e[0] + p[1] * r.e[1]), vs = pts.map(p => p[0] * r.n[0] + p[1] * r.n[1]);
    const u0 = Math.max(Math.min(...a.q.map(p => p[0] * r.e[0] + p[1] * r.e[1])), Math.min(...best.b.q.map(p => p[0] * r.e[0] + p[1] * r.e[1]))) , u1 = Math.min(Math.max(...a.q.map(p => p[0] * r.e[0] + p[1] * r.e[1])), Math.max(...best.b.q.map(p => p[0] * r.e[0] + p[1] * r.e[1])));
    const lo = Math.min(...us), hi = Math.max(...us), v0 = Math.min(...vs), v1 = Math.max(...vs);
    const U0 = Math.abs(u0 - lo) < 0.15 ? lo : u0, U1 = Math.abs(hi - u1) < 0.15 ? hi : u1;   // skins ending together make square ends
    const at = (u, v) => [r.e[0] * u + r.n[0] * v, r.e[1] * u + r.n[1] * v], q = [at(U0, v0), at(U1, v0), at(U1, v1), at(U0, v1)];
    paired.push({ q, A: area(q), t: v1 - v0, rect: asRect(q), skins: true });
  }
  walls = walls.filter(w => !used.has(w) && !(w.rect && w.rect.T < 0.04)).concat(paired.filter(w => w.t > 0.05));
  if (paired.length) read.push(`${paired.length} walls drawn as two skins joined into one each`);
  // a filled shape that isn't a straight piece of wall only counts when it meets one (a corner or a junction);
  // on its own it's a symbol: a north point, a section marker, a level arrow
  const rectBB = walls.filter(w => w.rect).map(w => w.q), bbOf = q => [Math.min(...q.map(p => p[0])), Math.min(...q.map(p => p[1])), Math.max(...q.map(p => p[0])), Math.max(...q.map(p => p[1]))];
  const touch = (a, b) => a[0] - 0.05 < b[2] && b[0] - 0.05 < a[2] && a[1] - 0.05 < b[3] && b[1] - 0.05 < a[3];
  const before = walls.length;
  walls = walls.filter(w => w.rect || rectBB.some(q => touch(bbOf(q), bbOf(w.q))));
  // a small square on its own is a dimension tick or a grid marker, not a post: a post is at least 200 mm
  const tiny = w => w.rect && w.rect.L < 0.2;
  walls = walls.filter(w => !tiny(w) || walls.some(o => o !== w && !tiny(o) && touch(bbOf(o.q), bbOf(w.q))));
  if (before > walls.length) read.push(`${before - walls.length} filled symbol${before - walls.length > 1 ? "s" : ""} on the sheet left out (not part of any wall)`);
  if (!walls.length) return { error: "No walls were found on that sheet: walls are read as the solid filled shapes on a floor plan." };
  // line work in colour (not black or grey): windows and door swings on this kind of set
  const coloured = (page.segs || []).filter(s => { const [r, g, b] = s.slice(5, 8); return Math.max(r, g, b) - Math.min(r, g, b) > 0.25; })
    .map(s => [...P([s[0], s[1]]), ...P([s[2], s[3]])]);

  // openings: two wall pieces in line, end to end, with a gap between them that nothing else fills
  const withRect = walls.map((w, i) => i).filter(i => walls[i].rect), rects = withRect.map(i => walls[i].rect), openings = [];
  for (let i = 0; i < rects.length; i++) for (let j = 0; j < rects.length; j++) {
    if (i === j) continue;
    const a = rects[i], b = rects[j];
    // in line and the same thickness; a short post (a window mullion or a jamb) can be any thickness
    const post = Math.min(a.L, b.L) < 0.35;
    if (!post && Math.abs(a.e[0] * b.e[0] + a.e[1] * b.e[1]) < 0.995) continue;
    if (!post && (b.T / a.T > 1.5 || a.T / b.T > 1.5)) continue;
    const d = [b.c[0] - a.c[0], b.c[1] - a.c[1]], along = d[0] * a.e[0] + d[1] * a.e[1], across = d[0] * a.n[0] + d[1] * a.n[1];
    if (along <= 0 || Math.abs(across) > Math.max(a.T, b.T) * 0.6) continue;
    const gap = along - a.L / 2 - b.L / 2;
    if (gap < 0.45 || gap > 6.5 || Math.min(a.L, b.L) < 0.05) continue;
    const T = Math.max(a.T, b.T), gu = a.L / 2 + gap / 2, c = [a.c[0] + a.e[0] * gu + a.n[0] * across / 2, a.c[1] + a.e[1] * gu + a.n[1] * across / 2];
    const g = { c, e: a.e, n: a.n, L: gap, T };
    // the nearest piece on: nothing else of the wall in the gap, and it isn't just the far side of a room
    if (rects.some((r, k) => k !== i && k !== j && Math.abs(r.e[0] * g.e[0] + r.e[1] * g.e[1]) > 0.9 && Math.abs((r.c[0] - g.c[0]) * g.n[0] + (r.c[1] - g.c[1]) * g.n[1]) < T && Math.abs((r.c[0] - g.c[0]) * g.e[0] + (r.c[1] - g.c[1]) * g.e[1]) < g.L / 2 + r.L / 2 - 0.02)) continue;
    if (openings.some(o => Math.hypot(o.c[0] - c[0], o.c[1] - c[1]) < 0.05)) continue;
    const inGap = coloured.filter(s => segHitsRect(s, g, 0.05));
    const swing = coloured.filter(s => segHitsRect(s, { ...g, T: g.T + 2 * Math.min(gap, 1.2) }, 0.05) && !segHitsRect(s, g, 0.02));   // a door's leaf and arc beside the gap
    const parallel = inGap.filter(s => { const L = Math.hypot(s[2] - s[0], s[3] - s[1]); return L > gap * 0.4 && Math.abs(((s[2] - s[0]) * g.e[0] + (s[3] - s[1]) * g.e[1]) / L) > 0.97; });
    // a window has its lines drawn across the gap; a door its swing; a gap with nothing drawn is an opening, and only
    // a door's width: a long blank gap is just the space between two separate walls
    const kind = parallel.length >= 1 ? "window" : inGap.length || swing.length ? "door" : gap <= 1.2 ? "opening" : null;
    if (!kind || (kind === "door" && gap > 3.6)) continue;
    openings.push({ ...g, kind, ends: [withRect[i], withRect[j]] });
  }
  const nw = openings.filter(o => o.kind === "window").length, nd = openings.filter(o => o.kind === "door").length, no = openings.length - nw - nd;
  read.push(`${walls.length} wall pieces from the filled wall shapes at 1:${scaleN}`, `${nw} window${nw === 1 ? "" : "s"} (lines drawn across the gap), ${nd} door${nd === 1 ? "" : "s"} (a swing drawn in the gap) and ${no} opening${no === 1 ? "" : "s"}`);

  // buildings: wall pieces that touch, kept together; one labelled EXISTING is the existing building
  const parent = walls.map((_, i) => i), find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const bbox = q => [Math.min(...q.map(p => p[0])), Math.min(...q.map(p => p[1])), Math.max(...q.map(p => p[0])), Math.max(...q.map(p => p[1]))];
  const bbs = walls.map(w => bbox(w.q)), near = (a, b, p) => a[0] - p < b[2] && b[0] - p < a[2] && a[1] - p < b[3] && b[1] - p < a[3];
  for (let i = 0; i < walls.length; i++) for (let j = i + 1; j < walls.length; j++) if (near(bbs[i], bbs[j], 0.35)) parent[find(i)] = find(j);
  for (const o of openings) parent[find(o.ends[0])] = find(o.ends[1]);   // the wall either side of a window or door is the same building
  const groups = new Map(); walls.forEach((w, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); });
  const labels = words.map(w => ({ s: w.s, p: P([w.x + w.w / 2, w.y + w.h / 2]) }));
  const buildings = [...groups.values()].filter(ix => ix.length >= 3).map(ix => {
    const bb = ix.map(i => bbs[i]).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
    const inside = labels.filter(l => l.p[0] > bb[0] && l.p[0] < bb[2] && l.p[1] > bb[1] && l.p[1] < bb[3]).map(l => l.s).join(" ");
    const existing = /\bEXIST/i.test(inside), rl = inside.match(/RL\s*(\d{2,4}[.,]\d{1,3})/i);
    return { walls: ix, bb, existing, label: inside.slice(0, 120), rl: rl ? parseFloat(rl[1].replace(",", ".")) : null };
  });
  // labelled new work stays new; an unlabelled building against an existing one is part of it
  for (const b of buildings) b.isNew = /\b(POOL|NEW|PROPOSED|ADDITION|EXTENSION|ALTERATION)/i.test(b.label);
  for (let changed = true; changed;) {
    changed = false;
    // "against" means a wall of it within a doorway of a wall of the existing one, not just near its outline
    const touches = (o, b) => b.walls.some(i => o.walls.some(j => near(bbs[i], bbs[j], 0.95)));   // a doorway apart at most
    for (const b of buildings) if (!b.existing && !b.isNew && buildings.some(o => o.existing && touches(o, b))) { b.existing = true; b.byNeighbour = true; changed = true; }
  }
  for (const b of buildings) if (b.byNeighbour) assumed.push(`the building with ${b.label ? `“${b.label.slice(0, 40)}”` : "no label"} joins the existing one, so it's taken as existing`);
  for (const b of buildings) for (const i of b.walls) walls[i].existing = b.existing;
  const ne = buildings.filter(b => b.existing).length;
  read.push(`${buildings.length} building${buildings.length === 1 ? "" : "s"}` + (ne ? `, ${ne} labelled existing` : ""));
  return { walls, openings, buildings, read, assumed, scale: scaleN };
}

/* ---------------- The model ---------------- */
const MAT = {
  wallNew: () => new THREE.MeshStandardMaterial({ name: "Drawn wall (new)", color: 0xe9e5dc, roughness: 0.85 }),
  wallOld: () => new THREE.MeshStandardMaterial({ name: "Drawn wall (existing)", color: 0xa89a86, roughness: 0.9 }),   // warmer and darker: existing reads apart from new
  glass: () => new THREE.MeshStandardMaterial({ name: "Drawn window glazing", color: 0x6f8f94, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.4 }),
  frame: () => new THREE.MeshStandardMaterial({ name: "Drawn window frame", color: 0x3b3f42, roughness: 0.5, metalness: 0.3 }),
  floor: () => new THREE.MeshStandardMaterial({ name: "Drawn floor slab", color: 0xb9b4a8, roughness: 0.9 }),
  roofNew: () => new THREE.MeshStandardMaterial({ name: "Drawn roof (new)", color: 0x6d7377, roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide }),
  roofOld: () => new THREE.MeshStandardMaterial({ name: "Drawn roof (existing)", color: 0x8a6f5a, roughness: 0.8, side: THREE.DoubleSide }),
};
// a roof over a rectangle (x0..x1, z0..z1 in plan metres), its eaves at y; hip, gable, mono (low side given) or flat
function roofGeometry(type, x0, z0, x1, z1, y, pitchDeg, low){
  const t = Math.tan(pitchDeg * Math.PI / 180), P = [], tri = (a, b, c) => P.push(...a, ...b, ...c), quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };
  const W = x1 - x0, D = z1 - z0, alongX = W >= D, half = (alongX ? D : W) / 2, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, yr = y + half * t;
  if (type === "flat") quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]);
  else if (type === "mono") {
    const rise = (low === "east" || low === "west" ? W : D) * t, h = (x, z) => y + rise * (low === "north" ? (z - z0) / D : low === "south" ? (z1 - z) / D : low === "west" ? (x1 - x) / W : (x - x0) / W);
    quad([x0, h(x0, z0), z0], [x1, h(x1, z0), z0], [x1, h(x1, z1), z1], [x0, h(x0, z1), z1]);
  } else if (alongX) {
    const r = type === "hip" ? half : 0;
    quad([x0, y, z0], [x1, y, z0], [x1 - r, yr, cz], [x0 + r, yr, cz]); quad([x1, y, z1], [x0, y, z1], [x0 + r, yr, cz], [x1 - r, yr, cz]);
    if (type === "hip") { tri([x1, y, z0], [x1, y, z1], [x1 - r, yr, cz]); tri([x0, y, z1], [x0, y, z0], [x0 + r, yr, cz]); }
    else { tri([x0, y, z0], [x0, yr, cz], [x0, y, z1]); tri([x1, y, z1], [x1, yr, cz], [x1, y, z0]); }
  } else {
    const r = type === "hip" ? half : 0;
    quad([x1, y, z0], [x1, y, z1], [cx, yr, z1 - r], [cx, yr, z0 + r]); quad([x0, y, z1], [x0, y, z0], [cx, yr, z0 + r], [cx, yr, z1 - r]);
    if (type === "hip") { tri([x0, y, z0], [x1, y, z0], [cx, yr, z0 + r]); tri([x1, y, z1], [x0, y, z1], [cx, yr, z1 - r]); }
    else { tri([x0, y, z0], [cx, yr, z0], [x1, y, z0]); tri([x1, y, z1], [cx, yr, z1], [x0, y, z1]); }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3)); g.computeVertexNormals(); return g;
}
/** Window heights from the schedule, matched to the plan's windows by width (within 150 mm). */
export function applyWindowSchedule(plan, sched){
  if (!sched || !sched.length) return 0;
  let n = 0;
  for (const o of plan.openings) if (o.kind === "window") {
    const m = sched.filter(s => Math.abs(s.w - o.L) < 0.15).sort((a, b) => Math.abs(a.w - o.L) - Math.abs(b.w - o.L))[0];
    if (m) { o.h = m.h; o.id = m.id; n++; }
  }
  return n;
}
function prism(q, y0, y1){
  const s = new THREE.Shape(q.map(([x, z]) => new THREE.Vector2(x, -z)));
  const g = new THREE.ExtrudeGeometry(s, { depth: y1 - y0, bevelEnabled: false, curveSegments: 1 });
  g.rotateX(-Math.PI / 2); g.translate(0, y0, 0); return g;
}
function boxAt(c, e, n, L, T, y0, y1){
  const g = new THREE.BoxGeometry(L, y1 - y0, T);
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(e[0], 0, e[1]), new THREE.Vector3(0, 1, 0), new THREE.Vector3(n[0], 0, n[1]));
  m.setPosition(c[0], (y0 + y1) / 2, c[1]); g.applyMatrix4(m); return g;
}
const merge = gs => { if (!gs.length) return null; const all = gs.map(g => g.index ? g.toNonIndexed() : g); const n = all.reduce((s, g) => s + g.attributes.position.count, 0), pos = new Float32Array(n * 3); let o = 0; for (const g of all) { pos.set(g.attributes.position.array, o); o += g.attributes.position.array.length; } const out = new THREE.BufferGeometry(); out.setAttribute("position", new THREE.BufferAttribute(pos, 3)); out.computeVertexNormals(); return out; };

/** The plan as a model: walls to their height, lintels over doors and windows, sills and glass in the windows.
 *  Every wall piece is its own part, and each window or door is one unit, so any of them can be picked and changed. */
export function buildPlanModel(plan, h, opts = {}){
  const H = h.wall, sillDefault = h.sill, head = Math.min(h.head, H - 0.05);
  const M = Object.fromEntries(Object.entries(MAT).map(([k, f]) => [k, f()]));
  const group = new THREE.Group(); group.name = "Model from the drawings";
  const mesh = (g, mat, name) => { g.computeVertexNormals(); const m = new THREE.Mesh(g, mat); m.name = name; return m; };
  plan.walls.forEach((w, i) => group.add(mesh(prism(w.q, 0, H), w.existing ? M.wallOld : M.wallNew, `${w.existing ? "Existing" : "New"} wall ${i + 1}`)));
  plan.openings.forEach((o, i) => {
    const old = !!(plan.walls[o.ends[0]] && plan.walls[o.ends[0]].existing), W = old ? M.wallOld : M.wallNew;
    const unit = new THREE.Group(); unit.name = `${o.kind === "window" ? "Window" : o.kind === "door" ? "Door" : "Opening"} ${i + 1}`; unit.userData.unit = true;
    unit.add(mesh(boxAt(o.c, o.e, o.n, o.L, o.T, head, H), W, unit.name + " lintel"));                       // to the top of the wall
    if (o.id) unit.name = `Window ${o.id}`;
    const sill = o.kind === "window" && o.h ? Math.max(0, head - o.h) : sillDefault;
    if (o.kind === "window") {
      unit.add(mesh(boxAt(o.c, o.e, o.n, o.L, o.T, 0, sill), W, unit.name + " wall under the sill"));
      unit.add(mesh(boxAt(o.c, o.e, o.n, o.L - 0.1, 0.012, sill + 0.05, head - 0.05), M.glass, unit.name + " glass"));
      const fr = [boxAt(o.c, o.e, o.n, o.L, 0.06, sill, sill + 0.05), boxAt(o.c, o.e, o.n, o.L, 0.06, head - 0.05, head)];
      for (const du of [-(o.L / 2 - 0.025), o.L / 2 - 0.025]) fr.push(boxAt([o.c[0] + o.e[0] * du, o.c[1] + o.e[1] * du], o.e, o.n, 0.05, 0.06, sill, head));
      unit.add(mesh(merge(fr), M.frame, unit.name + " frame"));
    }
    group.add(unit);
  });
  // roofs from the roof plan: an existing roof over each existing building, the new roof over the new work
  for (const r of opts.roofs || []) {
    if (r.who === "carport") continue;
    // only buildings big enough to have a roof (not a post or a stub of wall), each group of them that sits together
    const big = b => (b.bb[2] - b.bb[0]) * (b.bb[3] - b.bb[1]) > 6 && b.walls.length >= 4;
    // an unlabelled roof is the existing one on a renovation; on a set with nothing existing, it's the building's own
    const anyOld = plan.buildings.some(b => b.existing && big(b)), who = r.unlabelled && !anyOld ? "new" : r.who;
    const bs = plan.buildings.filter(b => (who === "existing") === !!b.existing && big(b));
    if (!bs.length) continue;
    const gap = (a, b) => Math.max(a.bb[0] - b.bb[2], b.bb[0] - a.bb[2], a.bb[1] - b.bb[3], b.bb[1] - a.bb[3]);
    const groups = []; for (const b of bs) { const g = groups.find(g => g.some(o => gap(o, b) < 3)); if (g) g.push(b); else groups.push([b]); }
    const ov = 0.45, pitch = r.pitch || 22.5, sets = r.type === "mono" || r.type === "flat" ? groups : bs.map(b => [b]);
    for (const set of sets) {
      const bb = set.map(b => b.bb).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
      group.add(mesh(roofGeometry(r.type, bb[0] - ov, bb[1] - ov, bb[2] + ov, bb[3] + ov, H, pitch, r.low || "south"), who === "existing" ? M.roofOld : M.roofNew, `${who === "existing" ? "Existing" : "New"} ${r.type === "mono" ? "skillion" : r.type} roof`));
    }
  }
  plan.buildings.forEach((b, i) => group.add(mesh(prism([[b.bb[0], b.bb[1]], [b.bb[2], b.bb[1]], [b.bb[2], b.bb[3]], [b.bb[0], b.bb[3]]], -0.15, 0), M.floor, `Floor slab ${i + 1}`)));
  // centred on the new work (or everything when nothing is new)
  const focus = plan.walls.filter(w => !w.existing).length ? plan.walls.filter(w => !w.existing) : plan.walls;
  const xs = focus.flatMap(w => w.q.map(p => p[0])), zs = focus.flatMap(w => w.q.map(p => p[1]));
  group.position.set(-(Math.min(...xs) + Math.max(...xs)) / 2, 0, -(Math.min(...zs) + Math.max(...zs)) / 2);
  const wrap = new THREE.Group(); wrap.name = "Model from the drawings"; wrap.add(group);
  return wrap;
}

/** Heights from the sections and elevations: the floor and the levels above it. What isn't there is said so. */
export function readHeights(sheets, plan){
  const read = [], assumed = [];
  const plans = plan.buildings.map(b => b.rl).filter(v => v != null), ffl = plans.length ? Math.min(...plans) : null;
  const above = sheets.filter(s => s.kind === "section" || s.kind === "elevation").flatMap(s => s.levels).filter(v => ffl != null && v > ffl + 2.1 && v < ffl + 12);
  let wall = null;
  if (ffl != null && above.length) { wall = Math.min(...above) - ffl; read.push(`floor RL ${ffl.toFixed(3)} on the plan and RL ${Math.min(...above).toFixed(3)} on the sections: walls ${wall.toFixed(2)} m high`); }
  if (wall == null) { wall = 2.7; assumed.push("no levels above the floor were found on the sections, so walls are 2.7 m: set the real height"); }
  assumed.push("window heads 2100 mm above the floor; sills from each window's height in the schedule where it matched, otherwise 900 mm");
  return { wall, sill: 0.9, head: 2.1, ffl, read, assumed };
}
