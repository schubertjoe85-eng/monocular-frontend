// cloudApi.js — Monocular "own keys" AI renders, ported from Monocular Desktop's
// Monocular Eye. Stills go straight from this phone to OpenAI (GPT Image 2.5) and
// videos to Runway (gen4_turbo), using keys the user pasted into Settings. There
// is no Monocular server in between, and the keys never leave the phone except
// in the Authorization header to OpenAI / Runway themselves.

import * as SecureStore from "expo-secure-store";
import * as FileSystem from "expo-file-system";
import * as ImageManipulator from "expo-image-manipulator";

const KEY_NAMES = { openAi: "monocular.openAiKey", runway: "monocular.runwayKey", anthropic: "monocular.anthropicKey", director: "monocular.director" };

// Keys are stored in the iOS Keychain (expo-secure-store), never in plain storage.
export async function loadKeys() {
  const [openAi, runway, anthropic, director] = await Promise.all(
    [KEY_NAMES.openAi, KEY_NAMES.runway, KEY_NAMES.anthropic, KEY_NAMES.director].map(n => SecureStore.getItemAsync(n).catch(() => null)));
  return { openAi: openAi || "", runway: runway || "", anthropic: anthropic || "", director: director === "builtin" ? "builtin" : "claude" };
}
export async function saveKeys({ openAi, runway, anthropic, director }) {
  await SecureStore.setItemAsync(KEY_NAMES.director, director === "builtin" ? "builtin" : "claude");
  for (const [name, value] of [[KEY_NAMES.openAi, openAi], [KEY_NAMES.runway, runway], [KEY_NAMES.anthropic, anthropic]]) {
    const v = (value || "").trim();
    if (v) await SecureStore.setItemAsync(name, v);
    else await SecureStore.deleteItemAsync(name);
  }
}

// Shrinks a photo / capture to at most 1536 px on its long side as a JPEG: well inside both APIs' upload
// limits (Runway rejects large data URIs) and much faster to send from a phone.
export async function prepareImage(uri) {
  const out = await ImageManipulator.manipulateAsync(uri, [], { compress: 1, format: ImageManipulator.SaveFormat.JPEG });
  const long = Math.max(out.width, out.height);
  const resized = long > 1536
    ? await ImageManipulator.manipulateAsync(uri, [{ resize: out.width >= out.height ? { width: 1536 } : { height: 1536 } }], { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG, base64: true })
    : await ImageManipulator.manipulateAsync(uri, [], { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG, base64: true });
  return { uri: resized.uri, base64: resized.base64, width: resized.width, height: resized.height };
}

/* ---------------- Claude as the director (same as desktop 0.1.54) ---------------- */
// Claude looks at the capture and writes the image prompt that goes to OpenAI, in place of the built-in template.
// The template, with every fact from the model and the site, is its brief, so nothing it knew is lost. Same rules as
// desktop: the capture is the geometry authority, fidelity before beauty, no invented features, real scale.
const CLAUDE_DIRECTOR_MODEL = "claude-sonnet-5-5";
const CLAUDE_DIRECTOR_RULES = [
  "You are the director for an architectural visualisation. You will see a capture of a 3D model and a brief. Write the prompt that an image-editing model will receive together with this exact capture, to turn it into a photograph of the building as built.",
  "",
  "DIRECTOR RULES — how you must write the prompt:",
  "1. GEOMETRY AUTHORITY: the capture is the authority on geometry. Describe what you actually see: the storey count, roof form and pitch, wall planes, the number and position of windows and doors, balconies, balustrades, columns, and the camera viewpoint. Tell the image model to keep every one of them exactly as shown.",
  "2. FIDELITY FIRST: this is a rendering conversion, not a redesign. Photographic quality comes from light, materials and lens, never from changing the design.",
  "3. BANNED INVENTIONS: no added or removed windows, doors, storeys, wings, roof features, dormers, chimneys, balconies, pools, fences, people, vehicles or furniture that aren't in the capture or named in the brief. No cartoon style, no oversaturated colour, no fisheye.",
  "4. SCALE DATUM: state the building's real-world size in plain words from its own geometry and any dimensions in the brief (for example 'a two-storey house about 7 m tall and 14 m wide, with a standard 2.1 m entry door'). Name at least one standard-sized element as a ruler.",
  "5. PROPORTION LOCK: the building renders at that scale. Its height-to-width ratio, storey heights and opening sizes do not change.",
  "6. MATERIALS: use only the materials the brief gives. Where the brief says a material is unspecified, or gives none, describe that surface as plain neutral and never invent a finish.",
  "7. SITE: the setting comes only from the brief (a real address, site facts or the owner's words). Without one, keep the surroundings exactly as shown.",
  "",
  "Reply with the prompt only: plain prose, under 220 words, no heading, no quotes, no list markers."
].join("\n");
// image: from prepareImage (JPEG, at most 1536 px — inside Anthropic's 5 MB / 1568 px guidance).
async function directWithClaude(key, image, brief) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: CLAUDE_DIRECTOR_MODEL, max_tokens: 4000, system: CLAUDE_DIRECTOR_RULES,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image.base64 } },
        { type: "text", text: "Brief, with the facts measured from the model and found for the site (these are authoritative):\n\n" + brief },
      ] }],
    }),
  });
  let j = null; try { j = await res.json(); } catch {}
  if (!res.ok) throw new Error((j && j.error && j.error.message) || `Anthropic request failed (${res.status}).`);
  const text = ((j && j.content) || []).filter(b => b.type === "text").map(b => b.text).join(" ")
    .replace(/^["'`\s]+|["'`\s]+$/g, "").replace(/\s+/g, " ").trim();
  if (text.length < 40) throw new Error("Claude returned no usable prompt.");
  return text.slice(0, 4000);
}
// The prompt a still goes with: Claude's when there's an Anthropic key and Claude is on, otherwise the built-in one.
// If Claude fails, the render still goes ahead on the built-in prompt and the note says why.
export async function directStill(keys, image, builtin) {
  if (keys.director === "builtin" || !(keys.anthropic || "").trim()) return { prompt: builtin, note: "" };
  try { return { prompt: await directWithClaude(keys.anthropic.trim(), image, builtin), note: ", directed by Claude" }; }
  catch (e) { return { prompt: builtin, note: ` (Claude couldn't direct: ${e.message} — the built-in prompt was used)` }; }
}

/* ---------------- prompts (same wording as desktop) ---------------- */
const PROMPT_BUDGET = 1000;
function fitRules(prefix, rules, facts) {
  let text = prefix;
  for (const r of rules) if ((text + " " + r + " " + facts).length <= PROMPT_BUDGET) text += " " + r;
  return (text + " " + facts).trim().slice(0, PROMPT_BUDGET);
}
function siteFact(site, address) {
  if (!site || !address) return "";
  const where = [site.locality, site.region].filter(Boolean).join(", ");
  return `Site: ${address}${where ? ` (${where})` : ""}.`;
}
// Converts the image into a photograph without reinterpreting it: the owner's words may only identify and
// finish what is already in the image, never add anything.
export function buildStillPrompt(ownerWords, { interior = false, site = null, address = "" } = {}) {
  const prefix = (interior
    ? "Convert this exact interior image into a photorealistic interior photograph — a pure style/rendering conversion, not a reinterpretation."
    : "Convert this exact image into a photorealistic architectural photograph — a pure style/rendering conversion, not a reinterpretation.")
    + (ownerWords ? ` The owner describes the proposed design as: "${ownerWords}". Use that description only to identify and finish elements already present in the image (for example which surfaces are glass, planting or cladding, and their colours) — never to add anything that isn't modelled.` : "");
  const rules = [
    "Keep every wall, window, door, roofline, structural element, neighbouring building, tree and terrain contour in exactly its position, size and count as shown in the source image.",
    "No people, vehicles, furniture or any other object not already visible in the source image. No cartoon style, no oversaturated colours, no fisheye distortion.",
    "The geometry and composition do not change — only the rendering becomes photographic, with the materials the owner describes.",
  ];
  return fitRules(prefix, rules, siteFact(site, address));
}
const CAMERA_MOVES = {
  orbit: "Camera: a smooth, steady orbit to the right around the building, moving clearly and continuously from the first frame, keeping the building centred and upright.",
  push: "Camera: a steady dolly forward toward the building, moving clearly and continuously from the first frame, keeping it centred and upright.",
  crane: "Camera: a smooth crane rising steadily up the building's height, moving clearly and continuously from the first frame, keeping it centred and upright.",
};
const GENTLE_MOVES = {
  orbit: "Camera: a slow, gentle orbit to the right around the building, keeping it centred and upright.",
  push: "Camera: a slow, gentle push in toward the building, keeping it centred and upright.",
  crane: "Camera: a slow, gentle rise up the building, keeping it centred and upright.",
};
export function buildVideoPrompt(ownerWords, { cam = "orbit", gentle = false, site = null, address = "" } = {}) {
  const prefix = "Photorealistic cinematic architectural video. " + (gentle ? GENTLE_MOVES : CAMERA_MOVES)[cam];
  const rules = [
    "Keep the building, terrain, neighbouring buildings and trees exactly as shown — same silhouette, position, size, count and materials as the source image, not a generic or imagined site.",
    "Do not add, remove, resize or move any window, door, storey, roofline or structural element. No cartoon style, no oversaturated colours, no fisheye distortion, no people or planting obscuring the building.",
    "Hold the building's geometry and materials exactly as shown throughout — the camera moves, the building never changes shape. No cuts.",
  ];
  return fitRules(prefix, rules, [ownerWords, siteFact(site, address)].filter(Boolean).join(" "));
}

/* ---------------- OpenAI ---------------- */
async function readError(res, fallback) {
  try {
    const j = await res.json();
    if (j && j.error && j.error.message) return j.error.message;
    if (Array.isArray(j.issues) && j.issues.length) return j.issues.map(i => `${(i.path || []).join(".") || "body"}: ${i.message}`).join("; ");
    if (j && j.error) return typeof j.error === "string" ? j.error : JSON.stringify(j.error);
  } catch {}
  return fallback;
}
// OpenAI image edit. Returns a local PNG file URI. gpt-image-1 was shut down on 2026-10-23: GPT Image 2.5 Sunburst
// is its replacement, with gpt-image-2 behind it for keys that can't use 2.5 yet. input_fidelity ("stay close to the
// input") is sent where the model takes it, and dropped when a model says it doesn't.
const OPENAI_IMAGE_MODELS = ["gpt-image-2.5-sunburst", "gpt-image-2"];
export async function openAiStill(key, image, prompt) {
  if (!key) throw new Error("Add your OpenAI API key in Settings first.");
  let res, fidelity = true, lastErr = null;
  for (let i = 0; i < OPENAI_IMAGE_MODELS.length; i++) {
    const form = new FormData();
    form.append("model", OPENAI_IMAGE_MODELS[i]);
    form.append("prompt", prompt);
    if (fidelity) form.append("input_fidelity", "high");
    form.append("size", image.width >= image.height ? "1536x1024" : "1024x1536");
    form.append("image", { uri: image.uri, name: "capture.jpg", type: "image/jpeg" });
    try {
      res = await fetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
    } catch (e) {
      throw new Error("Couldn't reach OpenAI — check your connection.");
    }
    if (res.ok) break;
    lastErr = await readError(res, `OpenAI request failed (${res.status}).`);
    if (fidelity && /input_fidelity/i.test(lastErr)) { fidelity = false; i--; continue; }   // same model, without it
    if (!/model|does not exist|not found|access/i.test(lastErr)) break;                     // a real error: say it
  }
  if (!res.ok) throw new Error(lastErr || `OpenAI request failed (${res.status}).`);
  const j = await res.json();
  const b64 = j && j.data && j.data[0] && j.data[0].b64_json;
  if (!b64) throw new Error("OpenAI returned no image.");
  const uri = FileSystem.cacheDirectory + "monocular-render-" + Date.now() + ".png";
  await FileSystem.writeAsStringAsync(uri, b64, { encoding: FileSystem.EncodingType.Base64 });
  return uri;
}

/* ---------------- Runway ---------------- */
const RUNWAY_API = "https://api.dev.runwayml.com/v1";
const RUNWAY_VERSION = "2024-11-06";
const wait = ms => new Promise(r => setTimeout(r, ms));
function runwayRatio(w, h) {
  const a = w / h;
  if (a > 1.2) return "1280:720";
  if (a < 0.83) return "720:1280";
  return "960:960";
}
async function submitRunway(key, image, prompt, seconds) {
  const res = await fetch(`${RUNWAY_API}/image_to_video`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "X-Runway-Version": RUNWAY_VERSION, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gen4_turbo",
      promptImage: `data:image/jpeg;base64,${image.base64}`,
      promptText: prompt,
      ratio: runwayRatio(image.width, image.height),
      duration: seconds === 10 ? 10 : 5,
    }),
  });
  if (!res.ok) throw new Error("Runway request failed: " + await readError(res, `status ${res.status}`));
  const { id } = await res.json();
  if (!id) throw new Error("Runway returned no task id.");
  return id;
}
// Returns { url } on success, { retry, detail } for a Runway-side INTERNAL.* failure worth one retry.
async function pollRunway(key, id, onStatus, isStopped) {
  const headers = { Authorization: `Bearer ${key}`, "X-Runway-Version": RUNWAY_VERSION };
  for (let i = 0; i < 120; i++) {               // ~6 minutes
    await wait(3000);
    if (isStopped && isStopped()) {               // cancel on Runway's side too, so it stops costing credits
      fetch(`${RUNWAY_API}/tasks/${id}`, { method: "DELETE", headers }).catch(() => {});
      throw new Error("Video cancelled.");
    }
    let t;
    try {
      const res = await fetch(`${RUNWAY_API}/tasks/${id}`, { headers });
      if (!res.ok) continue;
      t = await res.json();
    } catch { continue; }
    if (t.status === "SUCCEEDED") {
      const url = t.output && t.output[0];
      if (!url) throw new Error("Runway finished but returned no video.");
      return { url };
    }
    if (t.status === "FAILED" || t.status === "CANCELLED") {
      const code = t.failureCode || "";
      const detail = [t.failure || t.error || t.status.toLowerCase(), code && `[${code}]`].filter(Boolean).join(" ");
      if (/^INTERNAL\./.test(code)) return { retry: true, detail };
      throw new Error("Runway video generation failed: " + detail);
    }
    onStatus && onStatus(`Rendering video via Runway… (${(t.status || "processing").toLowerCase()})`);
  }
  throw new Error("Runway video timed out.");
}
// Image-to-video. `promptFor(gentle)` builds the prompt; the one retry after a Runway-side quality rejection
// uses the gentler camera wording rather than an identical resubmission. Returns a local MP4 file URI.
export async function runwayVideo(key, image, promptFor, seconds, onStatus, isStopped) {
  if (!key) throw new Error("Add your Runway API key in Settings first.");
  let last = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    onStatus && onStatus(attempt === 1 ? "Sending to Runway…" : `Runway rejected the clip (${last}) — retrying with a gentler camera move…`);
    const id = await submitRunway(key, image, promptFor(attempt > 1), seconds);
    const r = await pollRunway(key, id, onStatus, isStopped);
    if (r.url) {
      onStatus && onStatus("Downloading video…");
      const dl = await FileSystem.downloadAsync(r.url, FileSystem.cacheDirectory + "monocular-video-" + Date.now() + ".mp4");
      return dl.uri;
    }
    last = r.detail;
  }
  throw new Error("Runway video generation failed after 2 attempts: " + last);
}
