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
//   page -> RN: ready | pickModel | loaded | result { dataUrl } | error
//   RN -> page: window.__mono.setSite / modelBegin / modelChunk / modelEnd

import React, { useRef, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, ActionSheetIOS, Alert, Platform, StyleSheet } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { readSketch } from "./modules/monocular-site";
import { WebView } from "react-native-webview";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import localRenderHtml from "./localRenderHtml";
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
  async function buildSketch(uri, name) {
    setSending(true);
    setError("");
    try {
      const json = await readSketch(uri);
      inject("window.__mono.sketchBegin();");
      for (let i = 0; i < json.length; i += CHUNK) inject(`window.__mono.sketchChunk(${JSON.stringify(json.slice(i, i + CHUNK))});`);
      inject(`window.__mono.sketchEnd(${JSON.stringify(name)});`);
    } catch (e) {
      setError("Couldn't read the sketch: " + (e.message || e));
    } finally {
      setSending(false);
    }
  }
  async function photographSketch(useCamera) {
    try {
      const perm = useCamera ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { setError(useCamera ? "Camera permission is needed to photograph a sketch." : "Photos permission is needed to pick a sketch."); return; }
      const opts = { mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1 };
      const r = useCamera ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
      if (r.canceled || !r.assets?.length) return;
      await buildSketch(r.assets[0].uri, useCamera ? "your sketch" : (r.assets[0].fileName || "your sketch"));
    } catch (e) {
      setError("Couldn't get the sketch photo: " + (e.message || e));
    }
  }
  function pickSketch() {
    const tips = "Draw each building as a closed shape in dark pen on plain paper: bold lines for walls, thin lines for glass, a dashed outline for upper floors that overhang. Write the storeys inside each shape and one length beside an edge (e.g. 24m). Photograph it straight on.";
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ["Photograph a sketch", "Choose a sketch photo", "Cancel"], cancelButtonIndex: 2, title: "Build from a sketch", message: tips },
        i => { if (i === 0) photographSketch(true); else if (i === 1) photographSketch(false); }
      );
    } else {
      Alert.alert("Build from a sketch", tips, [
        { text: "Photograph", onPress: () => photographSketch(true) },
        { text: "Choose photo", onPress: () => photographSketch(false) },
        { text: "Cancel", style: "cancel" },
      ]);
    }
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
      if (!MODEL_EXTS.includes(ext)) { setError("Unsupported file. Use .dae, .glb or .obj."); return; }
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
    } else if (msg.type === "sketchRead" && demo && !msg.error) {
      inject(`window.__mono.demo(${JSON.stringify(demo)});`);
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
});
