// LocalRenderScreen.js — Monocular on-phone renderer.
//
// Renders an imported 3D model (.dae / .glb / .obj) entirely on the phone,
// with the same engine as Monocular Desktop's built-in renderer: the user's own
// geometry, the real sun for the site (when an address has been found), Clay or
// the model's own materials, and a progressive path tracer for Photoreal.
// Nothing is uploaded and no API key is needed.
//
// The renderer itself is a self-contained web page (localRenderHtml.js, built
// from local-render/ by `npm run build:local-render`) running in a WebView,
// because the path tracer needs full WebGL 2. Messages:
//   page -> RN: ready | pickModel | loaded | result { dataUrl } | saveDrawing { dataUrl, name } | error
//   RN -> page: window.__mono.setSite / modelBegin / modelChunk / modelEnd / drawingsBegin / drawingsChunk / drawingsEnd

import React, { useRef, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, Image, Modal, ScrollView, StyleSheet, Alert } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { readSketch, readDrawingSet } from "./modules/monocular-site";
import { WebView } from "react-native-webview";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import * as MediaLibrary from "expo-media-library";
import localRenderHtml from "./localRenderHtml";
import * as ModelBuilder from "./ai/modelbuilder";
import { loadKeys } from "./cloudApi";
import { geocodeAddress, satelliteFor, standardMapFor, fetchOsmText, fetchDem, SITE_METERS, RING_METERS } from "./site";

const MODEL_EXTS = ["glb", "gltf", "obj", "dae"];
const CHUNK = 1024 * 1024;          // base64 characters per injected chunk
const MAX_MODEL_BYTES = 80 * 1024 * 1024;

// `demo` is used only by screenshot builds (SCREENSHOT_MODE in App.js): { uri, name, hours, clay, orbitDeg, render, stayOpen }.
// `address` / `site` carry over from the main screen; a site found here is reported back through onSiteFound.
// startSketch: open straight onto "photograph a sketch" (the main screen's BUILD FROM A SKETCH button).
export default function LocalRenderScreen({ site, address = "", onSiteFound, onResult, onClose, demo = null, startSketch = false }) {
  const webRef = useRef(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [addr, setAddr] = useState(address);
  const [finding, setFinding] = useState(false);
  const [sketchHelp, setSketchHelp] = useState(demo && demo.showHelp ? demo.showHelp : false);
  const demoElevDone = useRef(false);

  const inject = js => webRef.current && webRef.current.injectJavaScript(js + "\ntrue;");

  async function sendModel(uri, name) {
    const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
    inject(`window.__mono.modelBegin(${JSON.stringify(name)});`);
    for (let i = 0; i < b64.length; i += CHUNK) {
      inject(`window.__mono.modelChunk(${JSON.stringify(b64.slice(i, i + CHUNK))});`);
    }
    inject("window.__mono.modelEnd();");
  }

  // Puts the model on the site: the real sun, and Apple Maps' satellite image as the ground.
  async function sendSite(loc) {
    if (!loc) { inject("window.__mono.setSite(null);"); return; }
    setFinding(true);
    try {
      const imageBase64 = await satelliteFor(loc);
      inject(`window.__mono.setSite(${JSON.stringify({ lat: loc.lat, lng: loc.lng, imageBase64, meters: SITE_METERS })});`);
    } finally {
      setFinding(false);
    }
    // The surroundings follow without holding anything up: the wider satellite rings and the real buildings.
    for (const m of RING_METERS) {
      satelliteFor(loc, m).then(b64 => b64 && inject(`window.__mono.setRing(${m}, ${JSON.stringify(b64)});`));
    }
    // Apple's standard map, traced into buildings where OpenStreetMap has few
    for (const m of [220, 1100]) {
      standardMapFor(loc, m).then(b64 => b64 && inject(`window.__mono.setMap(${m}, ${JSON.stringify(b64)});`));
    }
    // the terrain: the near 2 km first, then the hills out to 30 km
    fetchDem(loc, "near")
      .then(d => { inject(`window.__mono.setDem("near", ${JSON.stringify(d)});`); return fetchDem(loc, "far"); })
      .then(d => inject(`window.__mono.setDem("far", ${JSON.stringify(d)});`))
      .catch(e => inject(`window.__mono.demFailed(${JSON.stringify(e.message || String(e))});`));
    fetchOsmText(loc).then(text => {
      inject("window.__mono.osmBegin();");
      for (let i = 0; i < text.length; i += CHUNK) inject(`window.__mono.osmChunk(${JSON.stringify(text.slice(i, i + CHUNK))});`);
      inject("window.__mono.osmEnd();");
    }).catch(e => inject(`window.__mono.osmFailed(${JSON.stringify(e.message || String(e))});`));
  }

  async function findSite() {
    const a = addr.trim();
    if (!a) return;
    setError("");
    setFinding(true);
    try {
      const loc = await geocodeAddress(a);
      onSiteFound && onSiteFound(a, loc);
      await sendSite(loc);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setFinding(false);
    }
  }

  // Sketch -> model, all on the phone: Apple Vision reads the photo (the desktop's reader), the desktop's
  // builder in the renderer page turns the reading into the 3D model.
  async function buildSketch(uri, name, kind = "plan") {
    setSending(true);
    setError("");
    try {
      const json = await readSketch(uri);
      inject("window.__mono.sketchBegin();");
      for (let i = 0; i < json.length; i += CHUNK) inject(`window.__mono.sketchChunk(${JSON.stringify(json.slice(i, i + CHUNK))});`);
      inject(`window.__mono.sketchEnd(${JSON.stringify(name)}, ${JSON.stringify(kind)});`);
    } catch (e) {
      setError("Couldn't read the sketch: " + (e.message || e));
    } finally {
      setSending(false);
    }
  }
  async function photographSketch(useCamera, kind = "plan") {
    try {
      const perm = useCamera ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { setError(useCamera ? "Camera permission is needed to photograph a sketch." : "Photos permission is needed to pick a sketch."); return; }
      const opts = { mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1 };
      const r = useCamera ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
      if (r.canceled || !r.assets?.length) return;
      await buildSketch(r.assets[0].uri, useCamera ? "your sketch" : (r.assets[0].fileName || "your sketch"), kind);
    } catch (e) {
      setError("Couldn't get the sketch photo: " + (e.message || e));
    }
  }
  // The how-to-draw guide (an example sketch with what each mark means), then the camera or the photo library.
  function pickSketch(kind = "plan") { setSketchHelp(kind); }
  function sketchFrom(useCamera) { const kind = sketchHelp; setSketchHelp(false); setTimeout(() => photographSketch(useCamera, kind), 350); }

  // PDF drawing set -> model, all on the phone: the desktop's reader takes the plans' own line work and Apple Vision
  // reads the sheet titles, scales and levels; the renderer page builds the model from that.
  async function sendDrawings(uri, name) {
    setSending(true);
    try {
      inject(`window.__mono.drawingsBegin(${JSON.stringify(name)});`);
      const json = await readDrawingSet(uri);
      for (let i = 0; i < json.length; i += CHUNK) inject(`window.__mono.drawingsChunk(${JSON.stringify(json.slice(i, i + CHUNK))});`);
      inject(`window.__mono.drawingsEnd(${JSON.stringify(name)});`);
    } catch (e) {
      setError("Couldn't read the drawings: " + (e.message || e));
    } finally {
      setSending(false);
    }
  }

  // AI Model Builder, as on desktop: GPT reads every sheet into a building spec, Claude checks it against the drawings,
  // and plain code (ai/modelspec.js) writes the .dae, which opens here like any model. On request only, as it spends
  // the user's own OpenAI / Anthropic credit; the PDF goes from this phone straight to them.
  const AI_MAX_PDF = 24 * 1024 * 1024;   // both providers cap a request near 32 MB, and base64 adds a third
  const say = t => inject(`window.__mono.say(${JSON.stringify(t)});`);
  async function aiBuildFromPdf(uri, name, size) {
    const k = await loadKeys(), keys = { openai: (k.openAi || "").trim(), anthropic: (k.anthropic || "").trim() };
    try { ModelBuilder.pickModels(keys); } catch (e) { setError(e.message); return; }
    if (size && size > AI_MAX_PDF) { setError(`${name} is ${(size / 1048576).toFixed(0)} MB; the AI services take up to 24 MB. Save just the plans, elevations and sections as a smaller PDF.`); return; }
    setSending(true); setError("");
    const t0 = Date.now();
    try {
      say("Preparing the drawings…");
      const data = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      const http = async (url, headers, body) => { const r = await fetch(url, { method: "POST", headers, body }); return { ok: r.ok, status: r.status, body: await r.text() }; };
      const r = await ModelBuilder.runBuild({ files: [{ name, mime: "application/pdf", data }], keys, http,
        log: (stage, msg) => say(`AI Model Builder: ${msg}… (a minute or two — keep Monocular open)`) });
      const base = (r.spec.name || name.replace(/\.pdf$/i, "") || "AI model").replace(/[\\/:*?"<>|]/g, "").slice(0, 60) || "AI model";
      const out = FileSystem.cacheDirectory + base.replace(/\s+/g, "-") + ".dae";
      await FileSystem.writeAsStringAsync(out, r.dae);
      await sendModel(out, base + ".dae");
      const openings = r.spec.walls.reduce((n, w) => n + w.openings.length, 0);
      const who = r.models.interpret.provider === r.models.rationalise.provider
        ? (r.models.interpret.provider === "anthropic" ? "Claude" : "GPT") + " read and checked the drawings"
        : `${r.models.interpret.provider === "openai" ? "GPT" : "Claude"} read the drawings, ${r.models.rationalise.provider === "anthropic" ? "Claude" : "GPT"} checked them`;
      setTimeout(() => say(`${who} in ${Math.round((Date.now() - t0) / 1000)} s: ${r.spec.levels.length} level${r.spec.levels.length > 1 ? "s" : ""}, ${r.spec.walls.length} walls, ${openings} doors and windows. `
        + (r.report.ok ? "Every check passed." : `${r.report.errors.length} problem${r.report.errors.length > 1 ? "s" : ""} left: ${r.report.errors.map(e => e.msg).slice(0, 3).join(" · ")}.`)
        + ((r.spec.assumptions || []).length ? ` Assumed: ${r.spec.assumptions.slice(0, 3).join(" · ")}.` : "")), 1500);
    } catch (e) {
      setError("AI Model Builder couldn't build: " + (e.message || e));
    } finally {
      setSending(false);
    }
  }
  // A PDF can be read two ways: the phone's own vector reader (free, offline) or the AI Model Builder (own keys).
  function askPdf(asset, name) {
    Alert.alert("Drawing set", "How should Monocular read this PDF?", [
      { text: "Read on this phone", onPress: () => sendDrawings(asset.uri, name).catch(e => setError(String(e.message || e))) },
      { text: "Build with AI (your keys)", onPress: () => aiBuildFromPdf(asset.uri, name, asset.size) },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  async function pickModel() {
    setError("");
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        type: "*/*", // .dae/.glb/.obj have no reliable UTI — filter by extension below
      });
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];
      const name = asset.name || "model";
      const ext = name.split(".").pop().toLowerCase();
      if (ext === "pdf") { askPdf(asset, name); return; }
      if (!MODEL_EXTS.includes(ext)) { setError("Unsupported file. Use .dae, .glb, .obj or a PDF drawing set."); return; }
      if (asset.size && asset.size > MAX_MODEL_BYTES) { setError("That model is over 80 MB — too large to render on a phone."); return; }

      setSending(true);
      await sendModel(asset.uri, name);
    } catch (e) {
      setError("Couldn't open the model: " + (e.message || e));
    } finally {
      setSending(false);
    }
  }

  async function handleMessage(event) {
    let msg;
    try { msg = JSON.parse(event.nativeEvent.data); } catch { return; }
    if (msg.type === "ready") {
      if (site) sendSite(site).catch(e => setError(String(e.message || e)));
      if (demo && demo.sketch) buildSketch(demo.sketch, "the sketch");
      else if (demo && demo.uri) sendModel(demo.uri, demo.name || "model.dae").catch(e => setError(String(e.message || e)));
      else if (startSketch) pickSketch();
    } else if (msg.type === "loaded" && demo) {
      inject(`window.__mono.demo(${JSON.stringify(demo)});`);
    } else if (msg.type === "pickModel") {
      pickModel();
    } else if (msg.type === "pickSketch") {
      pickSketch();
    } else if (msg.type === "pickElevation") {
      pickSketch("elevation");
    } else if (msg.type === "sketchRead" && demo && !msg.error) {
      // screenshot builds: a plan, then its elevation if one is given, then the demo view
      if (demo.elevation && !demoElevDone.current) { demoElevDone.current = true; buildSketch(demo.elevation, "the elevation", "elevation"); }
      else inject(`window.__mono.demo(${JSON.stringify(demo)});`);
    } else if (msg.type === "result" && msg.dataUrl) {
      if (demo && demo.stayOpen) return;
      try {
        const base64 = msg.dataUrl.split(",")[1];
        const uri = FileSystem.cacheDirectory + "monocular-local-" + Date.now() + ".jpg";
        await FileSystem.writeAsStringAsync(uri, base64, { encoding: FileSystem.EncodingType.Base64 });
        onResult(uri, base64, msg);
      } catch (e) {
        setError("Couldn't keep the render: " + (e.message || e));
      }
    } else if (msg.type === "saveDrawing" && msg.dataUrl) {
      // a marked-up plan or section goes straight to Photos; the renderer stays open for the next one
      let note;
      try {
        const perm = await MediaLibrary.requestPermissionsAsync(true);
        if (!perm.granted) note = "Allow Monocular to add to Photos (Settings > Monocular > Photos) to save drawings.";
        else {
          const uri = FileSystem.cacheDirectory + "monocular-drawing-" + Date.now() + ".jpg";
          await FileSystem.writeAsStringAsync(uri, msg.dataUrl.split(",")[1], { encoding: FileSystem.EncodingType.Base64 });
          const asset = await MediaLibrary.createAssetAsync(uri);
          try { await MediaLibrary.createAlbumAsync("Monocular", asset, false); } catch {}
          note = `Saved to Photos: ${msg.name || "drawing"}.`;
        }
      } catch (e) { note = "Couldn't save the drawing: " + (e.message || e); }
      inject(`document.getElementById("shHint").textContent = ${JSON.stringify(note)};`);
    } else if (msg.type === "error") {
      setError(msg.error || "Render failed.");
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.closeButton} onPress={onClose}>
          <Text style={styles.closeText}>CLOSE</Text>
        </TouchableOpacity>
        <Text style={styles.title}>ON-PHONE RENDER</Text>
        <View style={styles.headerRight}>{sending && <ActivityIndicator color="#7FBF9A" />}</View>
      </View>
      <View style={styles.siteRow}>
        <TextInput
          style={styles.siteInput}
          placeholder="Site address — puts the model on the site"
          placeholderTextColor="#666"
          autoCapitalize="words"
          value={addr}
          onChangeText={setAddr}
          onSubmitEditing={findSite}
          returnKeyType="search"
        />
        <TouchableOpacity style={[styles.findButton, finding && styles.disabled]} onPress={findSite} disabled={finding}>
          {finding ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.closeText}>FIND</Text>}
        </TouchableOpacity>
      </View>
      {!!error && <Text style={styles.error}>{error}</Text>}
      <Modal visible={!!sketchHelp} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSketchHelp(false)}>
        <View style={styles.helpWrap}>
          <ScrollView contentContainerStyle={styles.helpBody}>
            <Text style={styles.helpTitle}>{sketchHelp === "elevation" ? "ADD AN ELEVATION" : "BUILD FROM A SKETCH"}</Text>
            {sketchHelp === "elevation" ? (<>
              <Text style={styles.helpText}>Draw the front of the building, ground line along the bottom, then photograph it. It sets the wall height, storeys, roof and windows of the model you built from the plan.</Text>
              <Image source={require("./assets/images/elevation-guide.jpg")} style={styles.helpImage} resizeMode="contain" />
              {[
                ["Outline", "The whole front as one closed shape, roof included: a peak is a gable, one side higher a skillion."],
                ["Windows", "A rectangle for each. Each row of windows is a storey."],
                ["Size", "Write the width under it (12m) or the wall height beside it (6m). Or it takes the plan's width."],
              ].map(([h, t]) => (<Text key={h} style={styles.helpText}><Text style={styles.helpHead}>{h}  </Text>{t}</Text>))}
            </>) : (<>
            <Text style={styles.helpText}>Draw the plan from above, like this, then photograph it. It's read on this phone.</Text>
            <Image source={require("./assets/images/sketch-guide.jpg")} style={styles.helpImage} resizeMode="contain" />
            {[
              ["Outline", "Each building is one closed shape. Separate buildings, separate shapes."],
              ["Walls & glass", "Thick line = solid wall. Thin line = glass."],
              ["Storeys", "Write them inside the shape: 2, 2 st, L3."],
              ["Size", "Write one length beside an edge: 24m."],
              ["Roof", "Write it beside the drawing: skillion roof, gable, hip or flat. A dashed line around a shape is its roof edge."],
              ["Courtyard", "A shape inside another that's empty or says court."],
              ["Photo", "Dark pen on plain paper. Straight on, whole page in view. Keep words off the lines."],
            ].map(([h, t]) => (
              <Text key={h} style={styles.helpText}><Text style={styles.helpHead}>{h}  </Text>{t}</Text>
            ))}
            <Text style={styles.helpNote}>After it's built you can change the storeys, roof, size and windows with the buttons under the model, and add an elevation for the heights and windows.</Text>
            </>)}
          </ScrollView>
          <View style={styles.helpButtons}>
            <TouchableOpacity style={styles.helpPrimary} onPress={() => sketchFrom(true)}><Text style={styles.closeText}>{sketchHelp === "elevation" ? "PHOTOGRAPH AN ELEVATION" : "PHOTOGRAPH A SKETCH"}</Text></TouchableOpacity>
            <TouchableOpacity style={styles.helpSecondary} onPress={() => sketchFrom(false)}><Text style={styles.closeText}>CHOOSE A PHOTO</Text></TouchableOpacity>
            <TouchableOpacity style={styles.helpCancel} onPress={() => setSketchHelp(false)}><Text style={styles.helpCancelText}>Cancel</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>
      <WebView
        ref={webRef}
        style={styles.web}
        originWhitelist={["*"]}
        source={{ html: localRenderHtml }}
        onMessage={handleMessage}
        javaScriptEnabled
        scrollEnabled={false}
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        bounces={false}
        allowsInlineMediaPlayback
        onContentProcessDidTerminate={() => {
          // iOS killed the web view (usually memory on a very large model) — reload rather than show a blank screen.
          setError("The renderer ran out of memory and restarted. Try a smaller model or a quick capture.");
          webRef.current && webRef.current.reload();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#111" },
  header: { flexDirection: "row", alignItems: "center", paddingTop: 54, paddingHorizontal: 14, paddingBottom: 10, backgroundColor: "#0b0b0b" },
  closeButton: { backgroundColor: "#222", borderRadius: 12, paddingVertical: 8, paddingHorizontal: 14 },
  closeText: { color: "#fff", fontWeight: "900", letterSpacing: 1, fontSize: 12 },
  title: { flex: 1, textAlign: "center", color: "#fff", fontWeight: "900", letterSpacing: 2, fontSize: 13 },
  headerRight: { width: 70, alignItems: "flex-end" },
  siteRow: { flexDirection: "row", gap: 8, paddingHorizontal: 14, paddingBottom: 10, backgroundColor: "#0b0b0b" },
  siteInput: { flex: 1, backgroundColor: "#050505", color: "#fff", borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: "#333", fontSize: 14 },
  findButton: { backgroundColor: "#2E4D3A", borderRadius: 12, paddingHorizontal: 16, alignItems: "center", justifyContent: "center" },
  disabled: { opacity: 0.6 },
  error: { color: "#ff8a80", fontSize: 12, paddingHorizontal: 14, paddingVertical: 6, backgroundColor: "#0b0b0b" },
  web: { flex: 1, backgroundColor: "#111" },
  helpWrap: { flex: 1, backgroundColor: "#0b0b0b" },
  helpBody: { padding: 20, paddingBottom: 12 },
  helpTitle: { color: "#fff", fontSize: 15, fontWeight: "800", letterSpacing: 1, marginBottom: 6 },
  helpText: { color: "#d6d6d6", fontSize: 14, lineHeight: 20, marginTop: 8 },
  helpHead: { color: "#7FBF9A", fontWeight: "800" },
  helpNote: { color: "#9a9a9a", fontSize: 13, lineHeight: 18, marginTop: 14 },
  helpImage: { width: "100%", aspectRatio: 1400 / 1016, borderRadius: 10, marginTop: 12, backgroundColor: "#faf9f4" },
  helpButtons: { padding: 16, paddingBottom: 30, borderTopWidth: 1, borderTopColor: "#262626", gap: 10 },
  helpPrimary: { backgroundColor: "#2E4D3A", borderRadius: 12, paddingVertical: 15, alignItems: "center" },
  helpSecondary: { backgroundColor: "#222", borderColor: "#333", borderWidth: 1, borderRadius: 12, paddingVertical: 15, alignItems: "center" },
  helpCancel: { paddingVertical: 8, alignItems: "center" },
  helpCancelText: { color: "#9a9a9a", fontSize: 14 },
});
