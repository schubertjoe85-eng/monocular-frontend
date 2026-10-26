// App.js — Monocular 1.1
// Changes from 1.0.4 (Build 149):
//   1. No subscription. Monocular is a one-off purchase; RevenueCat, the
//      paywall and the free-render limit are gone.
//   2. On-phone rendering (LocalRenderScreen): an imported 3D model is
//      rendered on the phone with Monocular Desktop's own engine — real sun,
//      Clay or Photoreal, nothing uploaded, no key needed.
//   3. AI renders use the user's own OpenAI (stills) and Runway (video) keys,
//      straight from the phone (cloudApi.js), like desktop's Monocular Eye.
//      The Monocular server is no longer used.
//   4. Address lookup with Apple's own geocoder only; the site goes into the
//      prompt and gives the on-phone renderer its real sun.

import React, { useState, useRef, useEffect } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Video, ResizeMode } from "expo-av";
import * as ImagePicker from "expo-image-picker";
import * as MediaLibrary from "expo-media-library";
import { geocodeAddress } from "./site";
import * as FileSystem from "expo-file-system";
import OnboardingScreen, { shouldShowOnboarding } from "./OnboardingScreen";
import { loadKeys, saveKeys, prepareImage, buildStillPrompt, buildVideoPrompt, openAiStill, runwayVideo } from "./cloudApi";
// NOTE: ModelViewerScreen and LocalRenderScreen are deliberately NOT imported
// here. Importing them at the top level loads their GL / WebView stacks at app
// launch, and any import-time error there kills the app on the splash screen.
// They are lazy-require()d inside their modals instead.

const PRIVACY_URL = "https://monocular-opal.vercel.app/privacy.html";
const TERMS_URL = "https://monocular-opal.vercel.app/terms.html";

// App Store screenshot builds only (eas.json "screenshots" profile sets this at build time; it is undefined in
// the App Store build, so none of the screenshot code below can run there). Reads Documents/screenshot.json to
// put the real app into a given state: which screen, the site, and the on-phone render to show.
const SCREENSHOT_MODE = process.env.EXPO_PUBLIC_SCREENSHOT_MODE === "1";

const MODES = [
  { key: "render", label: "EXTERIOR" },
  { key: "interior", label: "INTERIOR" },
];
const CAMS = [
  { key: "orbit", label: "ORBIT" },
  { key: "push", label: "PUSH IN" },
  { key: "crane", label: "CRANE UP" },
];

// Catches errors thrown while a lazy screen renders (not just at require
// time). A render-time failure shows an error screen instead of killing
// the app.
class ViewerErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <View style={styles.viewerErrorContainer}>
          <Text style={styles.viewerErrorTitle}>3D VIEWER ERROR</Text>
          <Text style={styles.viewerErrorBody}>
            {String(this.state.error.message || this.state.error)}
          </Text>
          <TouchableOpacity style={styles.buttonDark} onPress={this.props.onClose}>
            <Text style={styles.buttonDarkText}>CLOSE</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

// Lazy-loads a screen module only when its modal is open. If it fails to
// load, this renders an error screen (with the real error message) instead of
// crashing the app.
function LazyScreen({ load, onClose, ...props }) {
  let Screen = null;
  let loadError = null;
  try {
    Screen = load();
  } catch (e) {
    loadError = e;
  }
  if (loadError || !Screen) {
    return (
      <View style={styles.viewerErrorContainer}>
        <Text style={styles.viewerErrorTitle}>3D VIEWER UNAVAILABLE</Text>
        <Text style={styles.viewerErrorBody}>
          {loadError ? String(loadError.message || loadError) : "Component failed to load."}
        </Text>
        <TouchableOpacity style={styles.buttonDark} onPress={onClose}>
          <Text style={styles.buttonDarkText}>CLOSE</Text>
        </TouchableOpacity>
      </View>
    );
  }
  return (
    <ViewerErrorBoundary onClose={onClose}>
      <Screen onClose={onClose} {...props} />
    </ViewerErrorBoundary>
  );
}
const loadModelViewer = () => require("./ModelViewerScreen").default;
const loadLocalRender = () => require("./LocalRenderScreen").default;

export default function App() {
  const [tab, setTab] = useState("image");
  const [mode, setMode] = useState("render");
  const [prompt, setPrompt] = useState("");
  const [siteAddress, setSiteAddress] = useState("");
  const [siteLookupLoading, setSiteLookupLoading] = useState(false);
  const [siteStatus, setSiteStatus] = useState("");
  const [siteLocation, setSiteLocation] = useState(null); // { lat, lng, locality, region, roadName }
  const [selectedImage, setSelectedImage] = useState(null);
  const [resultImage, setResultImage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoStatus, setVideoStatus] = useState("");
  const [videoSeconds, setVideoSeconds] = useState(5);
  const [videoCam, setVideoCam] = useState("orbit");
  const [resultVideoUrl, setResultVideoUrl] = useState(null);
  const [savingVideo, setSavingVideo] = useState(false);
  const [message, setMessage] = useState("");
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [fullscreenImage, setFullscreenImage] = useState(null);
  const [showModelViewer, setShowModelViewer] = useState(false);
  const [showLocalRender, setShowLocalRender] = useState(false);
  const [startSketch, setStartSketch] = useState(false);   // open the renderer straight onto "photograph a sketch"
  const [showSettings, setShowSettings] = useState(false);
  const [keys, setKeys] = useState({ openAi: "", runway: "" });
  const [keyDraft, setKeyDraft] = useState({ openAi: "", runway: "" });
  const [showKeys, setShowKeys] = useState(false);
  const videoStopRef = useRef(false);
  const [shotDemo, setShotDemo] = useState(null);
  const siteAddressRef = useRef("");
  siteAddressRef.current = siteAddress;

  useEffect(() => {
    loadKeys().then(setKeys).catch(() => {});
    if (SCREENSHOT_MODE) { applyScreenshotState(); return; }
    shouldShowOnboarding().then(setShowOnboarding);
  }, []);

  async function applyScreenshotState() {
    try {
      const dir = FileSystem.documentDirectory;
      const shot = JSON.parse(await FileSystem.readAsStringAsync(dir + "screenshot.json"));
      if (shot.onboarding) { setShowOnboarding(true); return; }
      if (shot.prompt) setPrompt(shot.prompt);
      if (shot.tab) setTab(shot.tab);
      if (shot.keys) setKeys(shot.keys);
      if (shot.image) setSelectedImage(dir + shot.image);
      if (shot.result) { setResultImage(dir + shot.result); setMessage(shot.message || ""); }
      if (shot.address) { setSiteAddress(shot.address); siteAddressRef.current = shot.address; await handleFindAddress(); }
      if (shot.screen === "settings") { openSettings(); if (shot.keys) setKeyDraft(shot.keys); }
      if (shot.screen === "local") {
        setShotDemo({ ...(shot.local || {}), ...(shot.sketch ? { sketch: dir + shot.sketch } : { uri: dir + shot.model, name: shot.model }) });
        setShowLocalRender(true);
      }
    } catch (e) {
      setMessage("Screenshot setup failed: " + (e.message || e));
    }
  }

  function openSettings(note) {
    setKeyDraft(keys);
    setShowKeys(false);
    setShowSettings(true);
    if (note) setMessage(note);
  }

  async function handleSaveKeys() {
    try {
      await saveKeys(keyDraft);
      const stored = await loadKeys();
      setKeys(stored);
      setShowSettings(false);
      setMessage(stored.openAi || stored.runway ? "Keys saved on this phone." : "Keys removed.");
    } catch (e) {
      setMessage("Couldn't save the keys: " + (e.message || e));
    }
  }

  // Address -> real site, Apple only (site.js): the site goes into the AI
  // prompts and puts the model on its satellite ground with the real sun in
  // the on-phone renderer.
  async function handleFindAddress() {
    const address = siteAddressRef.current.trim();
    if (!address) { setSiteStatus(""); setSiteLocation(null); return; }

    setSiteLookupLoading(true);
    setSiteStatus("Looking up address...");
    setSiteLocation(null);

    try {
      const location = await geocodeAddress(address);
      setSiteLocation(location);
      const locBits = [location.locality, location.region].filter(Boolean).join(", ");
      setSiteStatus(`Found — ${locBits || "site located"}. Real sun and satellite ground on, site added to AI prompts.`);
    } catch (e) {
      setSiteStatus(e.message || "Lookup failed — try again.");
    } finally {
      setSiteLookupLoading(false);
    }
  }

  async function pickImage() {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 1,
      });
      if (!result.canceled && result.assets?.length > 0) {
        setSelectedImage(result.assets[0].uri);
        setResultImage(null);
        setResultVideoUrl(null);
        setMessage("Image loaded.");
      }
    } catch (error) {
      setMessage("Image upload failed.");
    }
  }

  // A captured 3D model view is used exactly like a picked photo.
  function handleModelCapture(uri) {
    setSelectedImage(uri);
    setResultImage(null);
    setResultVideoUrl(null);
    setShowModelViewer(false);
    setMessage("View captured.");
  }

  // A finished on-phone render: show it as the result, and make it the image
  // for an AI still or video too.
  function handleLocalResult(uri, _base64, info) {
    setShowLocalRender(false);
    setResultImage(uri);
    setSelectedImage(uri);
    setResultVideoUrl(null);
    setTab("image");
    setMessage(info && info.quick
      ? "Captured on this phone."
      : `Rendered on this phone${info && info.realSun ? " with the real sun for your site" : ""}.`);
  }

  // ---- AI still: straight to OpenAI with the user's own key ----
  async function renderImage() {
    if (!selectedImage) { setMessage("Import an image or capture a 3D view first."); return; }
    if (!keys.openAi) { openSettings("AI renders use your own OpenAI key — add it in Settings."); return; }
    try {
      setLoading(true);
      setResultImage(null);
      setMessage("Preparing image...");
      const image = await prepareImage(selectedImage);
      setMessage("Rendering via OpenAI... this usually takes under a minute.");
      const still = buildStillPrompt(prompt.trim(), { interior: mode === "interior", site: siteLocation, address: siteAddress.trim() });
      const uri = await openAiStill(keys.openAi, image, still);
      setResultImage(uri);
      setMessage("Render complete. Tap the image to view full screen.");
    } catch (error) {
      setMessage(error.message || "Render failed.");
    } finally {
      setLoading(false);
    }
  }

  async function saveImage() {
    if (!resultImage) { setMessage("No image to save."); return; }
    try {
      setSaving(true);
      const permission = await MediaLibrary.requestPermissionsAsync();
      if (!permission.granted) { setMessage("Photos permission required."); return; }
      const asset = await MediaLibrary.createAssetAsync(resultImage);
      await MediaLibrary.createAlbumAsync("Monocular", asset, false);
      setMessage("Saved to Photos.");
    } catch (error) {
      setMessage("Could not save image.");
    } finally {
      setSaving(false);
    }
  }

  // ---- Video: Runway with the user's own key. As on desktop, the image is
  // first polished into a photograph by OpenAI when that key is there too —
  // Runway rejects far fewer clips made from photographic stills. ----
  async function renderVideo() {
    if (!selectedImage) { setMessage("Import an image or capture a 3D view first."); return; }
    if (!keys.runway) { openSettings("Videos use your own Runway key — add it in Settings."); return; }
    videoStopRef.current = false;
    try {
      setVideoLoading(true);
      setResultVideoUrl(null);
      setMessage("");
      setVideoStatus("Preparing image...");
      let image = await prepareImage(selectedImage);
      const site = { site: siteLocation, address: siteAddress.trim() };
      if (keys.openAi) {
        setVideoStatus("Making the still photographic via OpenAI...");
        const polished = await openAiStill(keys.openAi, image, buildStillPrompt(prompt.trim(), { interior: mode === "interior", ...site }));
        if (videoStopRef.current) throw new Error("Video cancelled.");
        image = await prepareImage(polished);
      }
      const uri = await runwayVideo(
        keys.runway, image,
        gentle => buildVideoPrompt(prompt.trim(), { cam: videoCam, gentle, ...site }),
        videoSeconds, setVideoStatus, () => videoStopRef.current
      );
      setResultVideoUrl(uri);
      setMessage("Video render complete.");
    } catch (error) {
      setMessage(error.message || "Video generation failed.");
    } finally {
      setVideoStatus("");
      setVideoLoading(false);
    }
  }

  async function saveVideo() {
    if (!resultVideoUrl) { setMessage("No video to save."); return; }
    try {
      setSavingVideo(true);
      setMessage("Saving video...");
      const permission = await MediaLibrary.requestPermissionsAsync();
      if (!permission.granted) { setMessage("Photos permission required."); return; }
      const asset = await MediaLibrary.createAssetAsync(resultVideoUrl);
      await MediaLibrary.createAlbumAsync("Monocular", asset, false);
      setMessage("Video saved to Photos.");
    } catch (error) {
      setMessage("Save failed: " + error.message);
    } finally {
      setSavingVideo(false);
    }
  }

  if (showOnboarding) {
    return (
      <OnboardingScreen
        onStart={() => setShowOnboarding(false)}
        onAddKeys={() => { setShowOnboarding(false); openSettings(); }}
      />
    );
  }

  const keyField = (label, field, placeholder, url) => (
    <View style={styles.keyBlock}>
      <View style={styles.keyLabelRow}>
        <Text style={styles.keyLabel}>{label}</Text>
        <TouchableOpacity onPress={() => Linking.openURL(url)}>
          <Text style={styles.keyLink}>Get a key</Text>
        </TouchableOpacity>
      </View>
      <TextInput
        style={styles.addressInput}
        placeholder={placeholder}
        placeholderTextColor="#555"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={!showKeys}
        value={keyDraft[field]}
        onChangeText={v => setKeyDraft({ ...keyDraft, [field]: v })}
      />
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={styles.page}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        style={styles.page}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <TouchableOpacity style={styles.settingsButton} onPress={() => openSettings()}>
          <Text style={styles.settingsButtonText}>SETTINGS</Text>
        </TouchableOpacity>
        <Image source={require("./assets/logo.png")} style={styles.logoMark} />
        <Text style={styles.subtitle}>Rational Architectural Visualisation</Text>

        {/* Settings: the user's own AI keys, kept in the iOS Keychain */}
        <Modal visible={showSettings} transparent animationType="slide">
          <KeyboardAvoidingView style={styles.paywallOverlay} behavior={Platform.OS === "ios" ? "padding" : undefined}>
            <View style={styles.paywallCard}>
              <Text style={styles.paywallTitle}>SETTINGS</Text>
              <Text style={styles.paywallBody}>
                On-phone renders need no key. AI stills use your OpenAI account and videos use your Runway account — you pay them directly for what you use. Keys are stored only in this phone's Keychain and are sent only to OpenAI or Runway.
              </Text>
              {keyField("OPENAI API KEY", "openAi", "sk-...", "https://platform.openai.com/api-keys")}
              {keyField("RUNWAY API KEY", "runway", "key_...", "https://dev.runwayml.com/")}
              <TouchableOpacity onPress={() => setShowKeys(!showKeys)}>
                <Text style={styles.paywallLink}>{showKeys ? "Hide keys" : "Show keys"}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.buttonLight, styles.fullWidth]} onPress={handleSaveKeys}>
                <Text style={styles.buttonLightText}>SAVE</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setShowSettings(false)}>
                <Text style={styles.paywallLink}>Cancel</Text>
              </TouchableOpacity>
              <View style={styles.linkRow}>
                <TouchableOpacity onPress={() => Linking.openURL(PRIVACY_URL)}>
                  <Text style={styles.paywallLink}>Privacy Policy</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => Linking.openURL(TERMS_URL)}>
                  <Text style={styles.paywallLink}>Terms of Use</Text>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>

        {/* Fullscreen viewer: tap a render to inspect, pinch to zoom */}
        <Modal visible={!!fullscreenImage} transparent={false} animationType="fade">
          <View style={styles.fullscreenContainer}>
            <ScrollView
              style={styles.fullscreenScroll}
              contentContainerStyle={styles.fullscreenScrollContent}
              maximumZoomScale={5}
              minimumZoomScale={1}
              bouncesZoom
              centerContent
              showsVerticalScrollIndicator={false}
              showsHorizontalScrollIndicator={false}
            >
              {fullscreenImage && (
                <Image
                  source={{ uri: fullscreenImage }}
                  style={styles.fullscreenImage}
                  resizeMode="contain"
                />
              )}
            </ScrollView>
            <TouchableOpacity style={styles.fullscreenClose} onPress={() => setFullscreenImage(null)}>
              <Text style={styles.fullscreenCloseText}>CLOSE</Text>
            </TouchableOpacity>
          </View>
        </Modal>

        {/* 3D model viewer (capture a view for an AI render): lazy-loaded */}
        <Modal visible={showModelViewer} transparent={false} animationType="slide">
          {showModelViewer && (
            <LazyScreen
              load={loadModelViewer}
              onCapture={handleModelCapture}
              onClose={() => setShowModelViewer(false)}
              capturedCount={0}
            />
          )}
        </Modal>

        {/* On-phone renderer: lazy-loaded */}
        <Modal visible={showLocalRender} transparent={false} animationType="slide">
          {showLocalRender && (
            <LazyScreen
              load={loadLocalRender}
              site={siteLocation}
              address={siteAddress}
              onSiteFound={(a, loc) => {
                setSiteAddress(a); setSiteLocation(loc);
                setSiteStatus(`Found — ${[loc.locality, loc.region].filter(Boolean).join(", ") || "site located"}. Real sun and satellite ground on, site added to AI prompts.`);
              }}
              demo={shotDemo}
              startSketch={startSketch}
              onResult={handleLocalResult}
              onClose={() => setShowLocalRender(false)}
            />
          )}
        </Modal>

        <View style={styles.card}>
          <Text style={styles.sectionLabel}>RENDER ON THIS PHONE</Text>
          <Text style={styles.sectionNote}>Your 3D model (.dae, .glb, .obj), or one built from a photo of your sketch, on the real site — Apple Maps satellite ground and the real sun. Clay or Photoreal. Your model is never uploaded and no key is needed.</Text>
          <TouchableOpacity style={[styles.buttonLight, styles.noTopMargin]} onPress={() => { setStartSketch(false); setShowLocalRender(true); }}>
            <Text style={styles.buttonLightText}>OPEN 3D MODEL</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.buttonDark, styles.sketchButton]} onPress={() => { setStartSketch(true); setShowLocalRender(true); }}>
            <Text style={styles.buttonDarkText}>BUILD FROM A SKETCH</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.addressCard}>
          <Text style={styles.sectionLabel}>SITE</Text>
          <View style={styles.addressRowTop}>
            <TextInput
              style={styles.addressInput}
              placeholder="Street address (optional)"
              placeholderTextColor="#777"
              autoCapitalize="words"
              value={siteAddress}
              onChangeText={setSiteAddress}
              onSubmitEditing={handleFindAddress}
              returnKeyType="search"
            />
            <TouchableOpacity
              style={[styles.findButton, siteLookupLoading && styles.disabled]}
              onPress={handleFindAddress}
              disabled={siteLookupLoading}
            >
              {siteLookupLoading
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={styles.findButtonText}>FIND</Text>}
            </TouchableOpacity>
          </View>
          {!!siteStatus && <Text style={styles.siteStatus}>{siteStatus}</Text>}
        </View>

        <Text style={styles.sectionHeading}>AI RENDERS · YOUR OWN KEYS</Text>
        <View style={styles.tabRow}>
          <TouchableOpacity style={[styles.tabButton, tab === "image" && styles.tabButtonActive]} onPress={() => setTab("image")}>
            <Text style={[styles.tabText, tab === "image" && styles.tabTextActive]}>IMAGE</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.tabButton, tab === "video" && styles.tabButtonActive]} onPress={() => setTab("video")}>
            <Text style={[styles.tabText, tab === "video" && styles.tabTextActive]}>VIDEO</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.card}>
          <TouchableOpacity style={styles.buttonDark} onPress={pickImage}>
            <Text style={styles.buttonDarkText}>{selectedImage ? "CHANGE IMAGE" : "IMPORT IMAGE"}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.buttonDark} onPress={() => setShowModelViewer(true)}>
            <Text style={styles.buttonDarkText}>CAPTURE A 3D VIEW</Text>
          </TouchableOpacity>

          {selectedImage && (
            <TouchableOpacity activeOpacity={0.9} onPress={() => setFullscreenImage(selectedImage)}>
              <Image source={{ uri: selectedImage }} style={styles.preview} />
            </TouchableOpacity>
          )}

          <View style={styles.modeRow}>
            {MODES.map(m => (
              <TouchableOpacity
                key={m.key}
                style={[styles.modeButton, mode === m.key && styles.modeButtonActive]}
                onPress={() => setMode(m.key)}
              >
                <Text style={[styles.modeText, mode === m.key && styles.modeTextActive]}>{m.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <TextInput
            style={styles.input}
            placeholder="Describe the design — materials, colours, glazing..."
            placeholderTextColor="#777"
            multiline
            scrollEnabled={false}
            value={prompt}
            onChangeText={setPrompt}
          />

          {tab === "image" ? (
            <>
              <TouchableOpacity style={[styles.buttonLight, loading && styles.disabled]} onPress={renderImage} disabled={loading}>
                {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonLightText}>AI RENDER{keys.openAi ? "" : " — ADD OPENAI KEY"}</Text>}
              </TouchableOpacity>
              {resultImage && (
                <>
                  <TouchableOpacity activeOpacity={0.9} onPress={() => setFullscreenImage(resultImage)}>
                    <Image source={{ uri: resultImage }} style={styles.result} />
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.buttonDark, saving && styles.disabled]} onPress={saveImage} disabled={saving}>
                    <Text style={styles.buttonDarkText}>{saving ? "SAVING..." : "SAVE IMAGE"}</Text>
                  </TouchableOpacity>
                </>
              )}
            </>
          ) : (
            <>
              <View style={[styles.modeRow, styles.optionRowTop]}>
                {[5, 10].map(s => (
                  <TouchableOpacity key={s} style={[styles.modeButton, videoSeconds === s && styles.modeButtonActive]} onPress={() => setVideoSeconds(s)}>
                    <Text style={[styles.modeText, videoSeconds === s && styles.modeTextActive]}>{s} SEC</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={styles.modeRow}>
                {CAMS.map(c => (
                  <TouchableOpacity key={c.key} style={[styles.modeButton, videoCam === c.key && styles.modeButtonActive]} onPress={() => setVideoCam(c.key)}>
                    <Text style={[styles.modeText, videoCam === c.key && styles.modeTextActive]}>{c.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TouchableOpacity style={[styles.buttonLight, videoLoading && styles.disabled]} onPress={renderVideo} disabled={videoLoading}>
                {videoLoading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonLightText}>GENERATE VIDEO{keys.runway ? "" : " — ADD RUNWAY KEY"}</Text>}
              </TouchableOpacity>
              {videoLoading && (
                <TouchableOpacity onPress={() => { videoStopRef.current = true; setVideoStatus("Cancelling..."); }}>
                  <Text style={styles.paywallLink}>Cancel video</Text>
                </TouchableOpacity>
              )}
              {videoStatus ? <Text style={styles.message}>{videoStatus}</Text> : null}
              {resultVideoUrl && (
                <>
                  <Video
                    source={{ uri: resultVideoUrl }}
                    style={styles.result}
                    useNativeControls
                    resizeMode={ResizeMode.CONTAIN}
                    shouldPlay
                    isLooping
                  />
                  <TouchableOpacity style={[styles.buttonDark, savingVideo && styles.disabled]} onPress={saveVideo} disabled={savingVideo}>
                    <Text style={styles.buttonDarkText}>{savingVideo ? "SAVING..." : "SAVE VIDEO"}</Text>
                  </TouchableOpacity>
                </>
              )}
            </>
          )}

          {message ? <Text style={styles.message}>{message}</Text> : null}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#050505" },
  content: { padding: 22, paddingTop: 70, paddingBottom: 120, alignItems: "center" },
  settingsButton: { position: "absolute", top: 62, right: 22, backgroundColor: "#151515", borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12, borderWidth: 1, borderColor: "#2a2a2a", zIndex: 2 },
  settingsButtonText: { color: "#aaa", fontWeight: "900", letterSpacing: 1, fontSize: 10 },
  logoMark: { width: 120, height: 120, borderRadius: 24, alignSelf: "center", marginBottom: 10, resizeMode: "contain" },
  subtitle: { color: "#aaa", fontSize: 14, marginBottom: 20, textAlign: "center" },
  sectionLabel: { color: "#7FBF9A", fontWeight: "900", letterSpacing: 2, fontSize: 11, marginBottom: 6 },
  sectionNote: { color: "#999", fontSize: 13, lineHeight: 18, marginBottom: 14 },
  sectionHeading: { color: "#7FBF9A", fontWeight: "900", letterSpacing: 2, fontSize: 11, marginTop: 26, marginBottom: 10 },
  addressCard: { width: "100%", maxWidth: 540, backgroundColor: "#111", borderRadius: 24, padding: 18, borderWidth: 1, borderColor: "#2a2a2a", marginTop: 14 },
  addressRowTop: { flexDirection: "row", gap: 8 },
  noTopMargin: { marginTop: 0 },
  sketchButton: { marginTop: 10, marginBottom: 0 },
  fullWidth: { alignSelf: "stretch" },
  optionRowTop: { marginTop: 14 },
  tabRow: { flexDirection: "row", backgroundColor: "#111", borderRadius: 14, padding: 4, marginBottom: 18, borderWidth: 1, borderColor: "#2a2a2a" },
  tabButton: { paddingVertical: 10, paddingHorizontal: 22, borderRadius: 10 },
  tabButtonActive: { backgroundColor: "#2E4D3A" },
  tabText: { color: "#888", fontWeight: "900", letterSpacing: 1, fontSize: 12 },
  tabTextActive: { color: "#fff" },
  modeRow: { flexDirection: "row", marginBottom: 14, gap: 8 },
  modeButton: { flex: 1, paddingVertical: 10, borderRadius: 10, backgroundColor: "#1a1a1a", borderWidth: 1, borderColor: "#333", alignItems: "center" },
  modeButtonActive: { backgroundColor: "#2E4D3A", borderColor: "#2E4D3A" },
  modeText: { color: "#888", fontWeight: "900", letterSpacing: 1, fontSize: 11 },
  modeTextActive: { color: "#fff" },
  card: { width: "100%", maxWidth: 540, backgroundColor: "#111", borderRadius: 24, padding: 18, borderWidth: 1, borderColor: "#2a2a2a" },
  buttonDark: { backgroundColor: "#222", padding: 16, borderRadius: 16, alignItems: "center", marginBottom: 16 },
  buttonDarkText: { color: "#fff", fontWeight: "900", letterSpacing: 1 },
  buttonLight: { backgroundColor: "#2E4D3A", padding: 16, borderRadius: 16, alignItems: "center", marginTop: 16 },
  buttonLightText: { color: "#fff", fontWeight: "900", letterSpacing: 1 },
  input: { minHeight: 110, backgroundColor: "#050505", color: "#fff", borderRadius: 16, padding: 14, borderWidth: 1, borderColor: "#333", textAlignVertical: "top", fontSize: 15, lineHeight: 21 },
  addressInput: { flex: 1, backgroundColor: "#050505", color: "#fff", borderRadius: 12, padding: 12, borderWidth: 1, borderColor: "#333", fontSize: 14 },
  findButton: { backgroundColor: "#222", borderRadius: 12, paddingHorizontal: 18, alignItems: "center", justifyContent: "center" },
  findButtonText: { color: "#fff", fontWeight: "900", letterSpacing: 1, fontSize: 12 },
  siteStatus: { color: "#7FBF9A", fontSize: 12, marginTop: 8 },
  keyBlock: { alignSelf: "stretch", marginBottom: 12 },
  keyLabelRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 6 },
  keyLabel: { color: "#aaa", fontWeight: "900", letterSpacing: 1, fontSize: 11 },
  keyLink: { color: "#7FBF9A", fontSize: 12 },
  linkRow: { flexDirection: "row", gap: 24 },
  preview: { width: "100%", height: 260, borderRadius: 18, resizeMode: "cover", marginBottom: 16 },
  result: { width: "100%", height: 480, borderRadius: 18, marginTop: 18, marginBottom: 16, resizeMode: "cover" },
  message: { color: "#ddd", textAlign: "center", marginTop: 14 },
  disabled: { opacity: 0.6 },
  paywallOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.88)", justifyContent: "center", alignItems: "center", padding: 24 },
  paywallCard: { width: "100%", maxWidth: 420, backgroundColor: "#111", borderRadius: 24, padding: 26, borderWidth: 1, borderColor: "#2a2a2a", alignItems: "center" },
  paywallTitle: { color: "#fff", fontSize: 24, fontWeight: "900", letterSpacing: 3, marginBottom: 6 },
  paywallBody: { color: "#aaa", fontSize: 13, textAlign: "center", marginBottom: 18, lineHeight: 19 },
  paywallLink: { color: "#888", fontSize: 13, marginTop: 16, textAlign: "center" },
  fullscreenContainer: { flex: 1, backgroundColor: "#000" },
  fullscreenScroll: { flex: 1 },
  fullscreenScrollContent: { flexGrow: 1, justifyContent: "center" },
  fullscreenImage: { width: "100%", height: "100%", minHeight: 400 },
  fullscreenClose: { position: "absolute", top: 60, right: 24, backgroundColor: "rgba(17,17,17,0.9)", paddingVertical: 10, paddingHorizontal: 18, borderRadius: 12, borderWidth: 1, borderColor: "#2a2a2a" },
  fullscreenCloseText: { color: "#fff", fontWeight: "900", letterSpacing: 1, fontSize: 12 },
  viewerErrorContainer: { flex: 1, backgroundColor: "#050505", justifyContent: "center", alignItems: "center", padding: 24 },
  viewerErrorTitle: { color: "#fff", fontSize: 18, fontWeight: "900", letterSpacing: 2, marginBottom: 12 },
  viewerErrorBody: { color: "#aaa", fontSize: 13, textAlign: "center", marginBottom: 24, lineHeight: 19 },
});
