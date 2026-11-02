// Synced from Monocular Desktop (src/modelbuilder.js). Keep the two in step.
// modelbuilder.js — the AI Model Builder (adapted from the model-builder package, modelBuilder.js)
//
// Drawings in (a PDF set, plus any sketches or photos) -> a checked BuildingSpec -> a .dae model.
//   1. READ        a vision model reads every sheet and writes a BuildingSpec (walls, openings, levels, roofs)
//   2. CHECK       validateSpec, plain code: openings past wall ends, free wall ends, mm read as m, bad pitches
//   3. CORRECT     a second model, as checking architect, cross-checks plan against elevations and the report
//                  and returns a corrected spec; repeated while errors remain (2 rounds at most)
//   4. BUILD       specToCollada writes the model in code. The AI never writes geometry, so the model is exactly
//                  the spec's dimensions.
// Runs in the app on the user's own keys (OpenAI reads, Claude checks; either one alone does both). The drawings
// go from this Mac straight to OpenAI / Anthropic, never through our server. The caller supplies `http`, which
// sends a POST and returns the {ok, status, body} envelope (nativeHttp in index.html).

import { validateSpec, specToCollada, normaliseSpec } from "./modelspec.js";

const SPEC_SCHEMA = `BuildingSpec JSON (metres, X east, Y north, Z up, origin at the bottom-left external corner of the ground floor plan):
{
  "name": string,
  "levels": [{ "id": "L0", "name": "Ground", "elevation": 0, "height": 2.7 }],      // elevation = finished floor level (FFL), height = floor-to-ceiling/wall plate
  "walls": [{
    "id": "W1", "level": "L0",
    "start": [x, y], "end": [x, y],               // wall CENTRELINE
    "thickness": 0.25,
    "height": 2.7,                                // optional, defaults to level height
    "material": "wall_external" | "wall_internal" | any name,
    "freeEnd": false,                             // true only for a wall that genuinely stops in space (e.g. a fin wall)
    "openings": [{
      "id": "W1-O1",
      "type": "window" | "door" | "opening",
      "style": "e.g. awning, sliding, stacker, hinged, glazed sliding, garage",
      "offset": 1.2,                              // metres from wall START to the near edge of the opening
      "width": 1.8, "height": 1.2,
      "sill": 0.9                                 // 0 for doors
    }]
  }],
  "slabs": [{ "id": "S1", "level": "L0", "outline": [[x,y],...], "thickness": 0.2, "material": "slab" }],   // top of slab = level elevation
  "roofs": [{
    "id": "R1",
    "type": "gable" | "hip" | "skillion" | "flat",
    "pitch": 22.5,                                // degrees
    "overhang": 0.45,
    "ridgeAxis": "x" | "y",                       // direction the ridge runs (gable/hip) or the level eave edge runs (skillion)
    "highSide": "start" | "end",                  // skillion only: which side is high across the ridgeAxis ("end" = larger coordinate)
    "outline": [[x,y],...],                       // optional; wall-line footprint the roof sits over (defaults to all walls)
    "baseElevation": 2.7,                         // optional; wall plate height, defaults to top of walls
    "parapet": 0.0,                               // flat roofs only
    "material": "roof"
  }],
  "blocks": [{ "name": "deck", "min": [x,y,z], "max": [x,y,z], "rotation": 0, "material": "deck" | "concrete" | "pool_water" | any }],  // decks, steps, posts, pools, retaining walls, joinery
  "materials": { "name": { "color": "#rrggbb", "opacity": 1 } },  // optional overrides, e.g. colours read off a perspective
  "assumptions": [string],                        // every guess you made
  "confidence": 0.0-1.0
}`;

const INTERPRET_SYSTEM = `You are the drawing-reading stage of Monocular's model builder. You read architectural drawings like an experienced building designer and convert them into a precise 3D building specification.

Inputs may be any mix of: a PDF drawing set, floor plans, elevations, sections, perspectives/renders, sketches or photos.

Method:
1. Identify every sheet/view: plan, elevation (which face: N/S/E/W or front/rear/side), section, perspective, site plan. Read the title block, scale bar, north point and level/RL annotations.
2. Establish scale. Priority: written dimensions > RL/FFL annotations > scale bar with stated scale > standard elements (doors 2.04-2.1 m high, 820 mm leaf, benches 900 mm, ceilings 2.4-2.7 m, steps 175 mm). Never guess units: Australian drawings are dimensioned in millimetres - convert to metres.
3. From the PLAN: wall centrelines, thicknesses, opening positions along each wall (measure offset from the wall's start point), door vs window, internal walls.
4. From the ELEVATIONS and SECTIONS: floor levels, wall plate heights, sill and head heights of every opening, roof form, pitch, overhang, ridge direction.
5. From PERSPECTIVES: roof form, materials and colours, and - if no plan exists - proportions, using a 2.1 m door head and 2.7 m ceilings as the scale datum. State every inferred number in "assumptions".
6. Openings on an elevation must be matched to the correct wall on the plan, with the elevation's left-to-right direction correctly mapped to the wall's start-to-end direction.
7. Keep geometry exact: walls must meet at shared centreline points; external walls should form closed loops.

Be faithful to the drawings. Do not invent features that are not drawn. Where information is missing, choose the most ordinary Australian residential default and record it in "assumptions". Never invent materials or colours: only add a "materials" colour when the drawings or a perspective show it.

Return ONLY the JSON object, no prose, no markdown fences.

${SPEC_SCHEMA}`;

const RATIONALISE_SYSTEM = `You are the checking architect in Monocular's model builder. A first pass has turned architectural drawings into a BuildingSpec. Your job is to make it correct, consistent and buildable - rationalise it - without adding anything that is not in the drawings.

Check, in order:
1. Every validator ERROR must be fixed. Treat WARNINGS seriously; fix them unless the drawings show the condition is intended.
2. Cross-check views: every opening on each elevation exists on the matching plan wall at the right position, width, sill and head; heights agree between elevations and sections; roof form, pitch and ridge direction agree across every view.
3. Geometry: wall centrelines join at corners; external walls close; thicknesses consistent by wall type; openings fit inside their walls and do not overlap; levels stack correctly.
4. Scale sanity: overall dimensions agree with written dimensions; doors about 2.1 m high; nothing absurd.
5. Dimensions should be clean numbers as drawn (e.g. 2.4 not 2.3871) unless the drawing really says otherwise.

Return ONLY the corrected, COMPLETE BuildingSpec JSON (same schema) plus a "changes" array of short strings describing what you changed and why. No prose, no markdown fences.

${SPEC_SCHEMA}`;

const EDIT_SYSTEM = `You edit a BuildingSpec for Monocular's model builder. Apply the user's instruction precisely and change nothing else. Keep wall joins, opening fits and levels consistent after the change (e.g. if you raise the wall height, keep openings and roof base consistent). Return ONLY the complete updated BuildingSpec JSON with a "changes" array. No prose, no markdown fences.

${SPEC_SCHEMA}`;

export const OPENAI_READ_MODEL = "gpt-5.6-terra";
export const CLAUDE_CHECK_MODEL = "claude-opus-5-5";

// OpenAI reads and Claude checks when both keys are there; with one key, that provider does both passes.
export function pickModels(keys){
  const openai = !!(keys.openai || "").trim(), anthropic = !!(keys.anthropic || "").trim();
  if (!openai && !anthropic) throw new Error("The AI Model Builder needs an OpenAI or an Anthropic key (Settings ⚙︎).");
  const gpt = { provider: "openai", model: OPENAI_READ_MODEL }, claude = { provider: "anthropic", model: CLAUDE_CHECK_MODEL };
  return { interpret: openai ? gpt : claude, rationalise: anthropic ? claude : gpt };
}

// A key never appears in an error, even if a provider echoes part of it back.
function redact(text, keys){
  let t = String(text || "");
  for (const k of Object.values(keys)) if (k && k.length > 8) t = t.split(k).join("***");
  return t.replace(/\b(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_*-]{8,}/g, "$1***");
}

function providerError(name, env, keys){
  if (!env.status) return new Error(`Couldn't reach ${name} (${env.body === "timeout" ? "it took more than 6 minutes" : "check your connection"}).`);
  let m = ""; try { const j = JSON.parse(env.body); m = (j.error && (j.error.message || j.error)) || j.message || ""; } catch {}
  return new Error(`${name} said no (${env.status})${m ? ": " + redact(m, keys).slice(0, 300) : ""}.`);
}

// files: [{ name, mime, data }], data is base64 without the data: prefix
async function callLLM({ provider, model }, { system, text, files = [], maxTokens = 32000 }, { keys, http }){
  if (provider === "anthropic") {
    const content = files.map(f => f.mime === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data }, title: f.name }
      : { type: "image", source: { type: "base64", media_type: f.mime, data: f.data } });
    content.push({ type: "text", text });
    const env = await http("https://api.anthropic.com/v1/messages",
      { "content-type": "application/json", "x-api-key": keys.anthropic.trim(), "anthropic-version": "2023-06-01" },
      JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content }] }));
    if (!(env.ok && env.status >= 200 && env.status < 300)) throw providerError("Anthropic", env, keys);
    const j = JSON.parse(env.body);
    if (j.stop_reason === "max_tokens") throw new Error("Claude ran out of room writing the model: try a drawing set with just the plans, elevations and sections.");
    return (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  }
  // OpenAI Responses API, the same one the server's renders use; PDFs go as input_file, images as input_image
  const content = [{ type: "input_text", text }];
  for (const f of files) {
    const url = `data:${f.mime};base64,${f.data}`;
    content.push(f.mime === "application/pdf" ? { type: "input_file", filename: f.name || "drawings.pdf", file_data: url } : { type: "input_image", image_url: url, detail: "high" });
  }
  const env = await http("https://api.openai.com/v1/responses",
    { "Content-Type": "application/json", Authorization: `Bearer ${keys.openai.trim()}` },
    JSON.stringify({ model, instructions: system, input: [{ role: "user", content }], max_output_tokens: maxTokens * 2 }));   // reasoning counts against this
  if (!(env.ok && env.status >= 200 && env.status < 300)) throw providerError("OpenAI", env, keys);
  const j = JSON.parse(env.body);
  if (j.status === "incomplete") throw new Error("OpenAI stopped before it finished reading (" + ((j.incomplete_details && j.incomplete_details.reason) || "incomplete") + ").");
  return (j.output || []).filter(o => o.type === "message").flatMap(o => o.content || []).filter(c => c.type === "output_text").map(c => c.text).join("");
}

export function extractJSON(text){
  const t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("The model didn't return a building spec.");
  return JSON.parse(t.slice(a, b + 1));
}

function reportText(report){
  const lines = [...report.errors.map(e => `ERROR [${e.id}] ${e.msg}`), ...report.warnings.map(w => `WARNING [${w.id}] ${w.msg}`)];
  return lines.length ? lines.join("\n") : "No validator issues.";
}

function hintsText(h = {}){
  const out = [];
  if (h.width || h.depth || h.height) out.push(`Known overall size: width ${h.width || "?"} m, depth ${h.depth || "?"} m, height ${h.height || "?"} m. Treat these as authoritative.`);
  if (h.storeys) out.push(`Storeys: ${h.storeys}.`);
  if (h.roof) out.push(`Roof: ${h.roof}.`);
  if (h.notes) out.push(`User notes: ${h.notes}`);
  return out.join("\n");
}

const label = m => m.provider === "anthropic" ? "Claude" : "GPT";

export async function runBuild({ files, hints = {}, keys, http, log = () => {}, maxRounds = 2 }){
  const models = pickModels(keys), io = { keys, http };
  log("read", `${label(models.interpret)} is reading ${files.length > 1 ? files.length + " files" : "the drawings"}`);
  const raw = await callLLM(models.interpret, { system: INTERPRET_SYSTEM, text: `Build the BuildingSpec from these drawings.\n${hintsText(hints)}`, files }, io);
  let spec = normaliseSpec(extractJSON(raw));
  let report = validateSpec(spec);
  const changes = [];
  // always one checking pass; a second only while errors remain
  for (let round = 1; round <= maxRounds; round++) {
    if (round > 1 && report.ok) break;
    log("check", `${label(models.rationalise)} is checking it against the drawings${round > 1 ? " again" : ""} (${report.errors.length} error${report.errors.length === 1 ? "" : "s"}, ${report.warnings.length} warning${report.warnings.length === 1 ? "" : "s"})`);
    const out = extractJSON(await callLLM(models.rationalise, {
      system: RATIONALISE_SYSTEM,
      text: `Validator report:\n${reportText(report)}\n\n${hintsText(hints)}\n\nCurrent BuildingSpec:\n${JSON.stringify(spec)}`,
      files }, io));
    if (Array.isArray(out.changes)) changes.push(...out.changes.map(String));
    delete out.changes;
    spec = normaliseSpec(out);
    report = validateSpec(spec);
  }
  log("build", "Building the model");
  const { dae, triangles } = specToCollada(spec);
  return { spec, report, changes, dae, triangles, models };
}

export async function runEdit({ spec, instruction, files = [], keys, http, log = () => {} }){
  const models = pickModels(keys);
  log("edit", `${label(models.rationalise)} is making the change`);
  const out = extractJSON(await callLLM(models.rationalise, { system: EDIT_SYSTEM, text: `Instruction: ${instruction}\n\nCurrent BuildingSpec:\n${JSON.stringify(spec)}`, files }, { keys, http }));
  const changes = Array.isArray(out.changes) ? out.changes.map(String) : [];
  delete out.changes;
  const next = normaliseSpec(out);
  const report = validateSpec(next);
  const { dae, triangles } = specToCollada(next);
  return { spec: next, report, changes, dae, triangles, models };
}

// ---- Developing a model in the Build panel: the AI edits the app's own building description (builder.js params),
// so its changes and the user's own panel and Modify edits build on each other. It returns only the keys it changes.
const BUILDER_SCHEMA = `The building, as JSON. Metres. Plan points are [x, z]: x east, z SOUTH, centred on the building. y is up.
Top level:
  storeyHeight (floor to floor), slabThickness, wallThickness, storeys (storeys of the main blocks),
  windowType: "drawn" (each wall keeps its own windows from facades[..].windows) | "punched" | "ribbon" | "curtain" | "none",
  windowWidth, windowHeight, sillHeight, windowPitch (centre to centre)  -- used by punched/ribbon/curtain,
  roofType: "flat" | "gable" | "hip" | "mono", roofPitchDeg, overhang (eaves), parapet (flat roofs), roofThickness,
  slabEdge: floor slabs projecting past the walls on every upper storey as balconies (0 = none; 0.5 or more adds glass balustrades),
  width: the building's plan scale; keep width equal to sketch.w0.
sketch: { w0, d0, blocks: [ { outer: [[x,z],...] outside face of the walls, holes: [], storeys, parent: index of the block it stands on (omit for one on the ground), level: first storey of a block standing alone above ground, roof: { type } } ] }
  A block whose outline differs from the one below is a new block with parent set to it (setbacks, podium and tower).
facades: { "b:0:e": { windowType, t (wall thickness), windows: { "storey within the block": [ { u0, u1, v0, v1 } ] } } }
  b = block index, e = edge index: the edge runs from outer[e] to outer[e+1]; u is metres along it from outer[e]; v is metres up from the floor.
interior: [ items, each with a unique id and lv: [first storey, last storey] (storeys count from 0 at the ground floor):
  { kind: "wall", a: [x,z], b: [x,z], t }
  { kind: "door" | "opening", host: { b, l: 0, e } (an outside wall) or the id of an inside wall, u: centre along that wall, w, h, swing: 1 | -1,
    style: "single" | "double" | "entry" | "glass" | "sliding" | "bifold" | "garage" }
  { kind: "stair", x, z, w, type: "straight" | "dogleg" | "L" | "spiral", ang }
  { kind: "core", x, z, w, d, t, ang, style: "lift" | "glass" | "services" }
  { kind: "column", x, z, s, round } ]
extras: [ { name, kind: "glass" | "slab" | "wall" | "core" | "timber" | "frame", c: [x, y, z] centre, sx (length), sy (height), sz (depth), ang: degrees anticlockwise seen from above, 0 = sx runs east } ]  -- balconies, balustrades, decks, paths, pools, canopies`;

const BUILDER_EDIT_SYSTEM = `You develop a building model in Monocular, an architectural visualisation app. You get the model as JSON and one instruction from the architect. Make exactly that change, well: keep it consistent (a new storey keeps the windows pattern of the one below; doors fit within their wall; a balcony sits at a floor level and has a balustrade if it is above the ground). Change nothing else. If drawings are attached they are the authority: when the instruction refers to them, match them.

Reply with ONLY a JSON object: { "set": { ...only the top-level keys you change, each with its COMPLETE new value... }, "changes": [ short strings saying what you changed ] }. No prose, no markdown fences. If the instruction can't be done in this model, return { "set": {}, "changes": ["why not"] }.

${BUILDER_SCHEMA}`;

export async function developModel({ params, instruction, files = [], keys, http, log = () => {} }){
  const models = pickModels(keys), m = models.rationalise;
  log("develop", `${label(m)} is making the change`);
  const { sketch, ...rest } = params;
  const text = `Instruction: ${instruction}\n\nThe model now:\n${JSON.stringify({ ...rest, sketch })}`;
  const out = extractJSON(await callLLM(m, { system: BUILDER_EDIT_SYSTEM, text, files, maxTokens: 32000 }, { keys, http }));
  const set = out.set && typeof out.set === "object" ? out.set : {};
  // a changed outline: keep the plan at true size (the builder scales a sketch by width / w0)
  if (set.sketch && Array.isArray(set.sketch.blocks) && set.sketch.blocks.length) {
    const pts = set.sketch.blocks.flatMap(b => b.outer || []), xs = pts.map(p => p[0]), zs = pts.map(p => p[1]);
    set.sketch = { ...set.sketch, w0: Math.max(...xs) - Math.min(...xs), d0: Math.max(...zs) - Math.min(...zs) };
    set.width = set.sketch.w0;
  }
  return { set, changes: Array.isArray(out.changes) ? out.changes.map(String) : [], model: m };
}

// No AI: the spec as it stands, rebuilt (used after the user edits numbers by hand)
export function rebuild(spec){
  const s = normaliseSpec(spec);
  return { spec: s, report: validateSpec(s), ...specToCollada(s) };
}
