// App.js — Monocular Build 141
// Changes from Build 134:
//   1. Added ViewerErrorBoundary: catches render-time errors inside the
//      3D viewer (not just require-time errors) and shows an error screen
//      with the real message instead of crashing the app.
//   2. Companion to ModelViewerScreen v4 (pinch-zoom capture-phase fix,
//      adaptive camera clip planes) and three@0.166.1 / expo-three@8.0.0.

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
import * as FileSystem from "expo-file-system";
import Purchases from "react-native-purchases";
import OnboardingScreen, { shouldShowOnboarding } from "./OnboardingScreen";
// NOTE: ModelViewerScreen is deliberately NOT imported here. Importing it at
// the top level loads expo-gl/expo-three/three at app launch, and any
// import-time error in that stack kills the app on the splash screen.
// It is lazy-require()d inside the 3D viewer modal instead.

const API_URL = "https://monocular-server.onrender.com";
const RC_API_KEY = "appl_jJKgQZQIYePcVeZnnwpGtHacrrB";
const ENTITLEMENT_ID = "Monocular Pro";

// Render job polling
const RENDER_POLL_INTERVAL_MS = 3000; // check status every 3s
const RENDER_MAX_POLLS = 100;         // ~5 minutes, then give up with a clear error

const MODES = [
  { key: "render", label: "EXTERIOR" },
  { key: "interior", label: "INTERIOR" },
];

// Catches errors thrown while the 3D viewer renders (not just at require
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

// Lazy-loads the 3D viewer only when the modal is open. If the 3D stack
// fails to load, this renders an error screen (with the real error message)
// instead of crashing the app.
function LazyModelViewer({ onCapture, onClose }) {
  let ModelViewerScreen = null;
  let loadError = null;
  try {
    ModelViewerScreen = require("./ModelViewerScreen").default;
  } catch (e) {
    loadError = e;
  }
  if (loadError || !ModelViewerScreen) {
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
      <ModelViewerScreen onCapture={onCapture} onClose={onClose} />
    </ViewerErrorBoundary>
  );
}

export default function App() {
  const [tab, setTab] = useState("image");
  const [mode, setMode] = useState("render");
  const [prompt, setPrompt] = useState("");
  const [selectedImage, setSelectedImage] = useState(null);
  const [imageBase64, setImageBase64] = useState(null);
  const [extraImages, setExtraImages] = useState([]);
  const [resultImage, setResultImage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoStatus, setVideoStatus] = useState("");
  const [resultVideoUrl, setResultVideoUrl] = useState(null);
  const [savingVideo, setSavingVideo] = useState(false);
  const [message, setMessage] = useState("");
  const pollRef = useRef(null);        // video polling
  const renderPollRef = useRef(null);  // image render polling
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [showPaywall, setShowPaywall] = useState(false);
  const [purchasing, setPurchasing] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [rcUserId, setRcUserId] = useState(null);
  const [fullscreenImage, setFullscreenImage] = useState(null);
  const [showModelViewer, setShowModelViewer] = useState(false);

  useEffect(() => {
    async function initRevenueCat() {
      try {
        Purchases.configure({ apiKey: RC_API_KEY });
        const info = await Purchases.getCustomerInfo();
        setIsSubscribed(!!info.entitlements.active[ENTITLEMENT_ID]);
        const id = await Purchases.getAppUserID();
        setRcUserId(id || null);
      } catch (error) {
        console.log("RevenueCat init error:", error);
      }
    }
    initRevenueCat();
    shouldShowOnboarding().then(setShowOnboarding);

    // Clean up any running polls if the app unmounts.
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (renderPollRef.current) clearInterval(renderPollRef.current);
    };
  }, []);

  // Stable per-install identity sent to the server so the free-render
  // guard tracks users instead of IPs, and subscribers are never blocked.
  function identityFields() {
    return {
      email: rcUserId || null,
      subscriptionActive: isSubscribed,
      platform: "ios",
    };
  }

  async function buySubscription() {
    try {
      setPurchasing(true);
      const offerings = await Purchases.getOfferings();
      const pkg = offerings.current && offerings.current.availablePackages.length > 0
        ? offerings.current.availablePackages[0] : null;
      if (!pkg) { setMessage("No subscription available right now."); return; }
      const { customerInfo } = await Purchases.purchasePackage(pkg);
      if (customerInfo.entitlements.active[ENTITLEMENT_ID]) {
        setIsSubscribed(true);
        setShowPaywall(false);
        setMessage("Subscription active. Thank you!");
      }
    } catch (error) {
      setMessage(error.userCancelled ? "Purchase cancelled." : "Purchase failed.");
    } finally {
      setPurchasing(false);
    }
  }

  async function restorePurchases() {
    try {
      setPurchasing(true);
      const info = await Purchases.restorePurchases();
      if (info.entitlements.active[ENTITLEMENT_ID]) {
        setIsSubscribed(true);
        setShowPaywall(false);
        setMessage("Purchases restored.");
      } else {
        setMessage("No active subscription found.");
      }
    } catch (error) {
      setMessage("Restore failed.");
    } finally {
      setPurchasing(false);
    }
  }

  async function pickImage() {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.9,
        base64: true,
      });
      if (!result.canceled && result.assets?.length > 0) {
        const asset = result.assets[0];
        setSelectedImage(asset.uri);
        setImageBase64(asset.base64 || null);
        setResultImage(null);
        setResultVideoUrl(null);
        setMessage("Image loaded.");
      }
    } catch (error) {
      setMessage("Image upload failed.");
    }
  }

  // Captured 3D model view -> same pipeline as a picked photo.
  async function handleModelCapture(uri) {
    try {
      const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      setSelectedImage(uri);
      setImageBase64(base64);
      setResultImage(null);
      setResultVideoUrl(null);
      setShowModelViewer(false);
      setMessage("Model view captured. Add a brief and render.");
    } catch (error) {
      setMessage("Could not use the captured view.");
    }
  }

  async function pickExtraImage() {
    if (extraImages.length >= 2) { setMessage("Up to 3 images total."); return; }
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.9,
        base64: true,
      });
      if (!result.canceled && result.assets?.length > 0) {
        const asset = result.assets[0];
        setExtraImages([...extraImages, { uri: asset.uri, base64: asset.base64 || null }]);
        setMessage("Added angle " + (extraImages.length + 2) + ".");
      }
    } catch (error) {
      setMessage("Could not add image.");
    }
  }

  // Returns true when the server's response means the free render is used up.
  function isFreeLimitError(status, errorText) {
    if (status === 402 || status === 403 || status === 429) return true;
    if (!errorText) return false;
    return /free|limit|credit|subscri/i.test(errorText);
  }

  function stopRenderPolling() {
    if (renderPollRef.current) {
      clearInterval(renderPollRef.current);
      renderPollRef.current = null;
    }
  }

  // ---- RENDER: job pattern (start + poll) ----
  // POST /render/start returns { ok, jobId } immediately (402 = free render used).
  // GET /render/status/:jobId returns:
  //   { ok: true,  status: "pending" }
  //   { ok: true,  status: "done", image }
  //   { ok: false, status: "failed" | "not_found", error }
  async function renderImage() {
    // Non-subscribers get one free render — the server enforces it.
    if (!prompt.trim() && !imageBase64) { setMessage("Add a brief or upload an image first."); return; }
    stopRenderPolling();
    try {
      setLoading(true);
      setMessage(isSubscribed ? "Starting render..." : "Starting your free render...");
      setResultImage(null);
      const response = await fetch(API_URL + "/render/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, imageBase64, mode, ...identityFields() }),
      });
      const data = await response.json();
      if (!data.ok || !data.jobId) {
        if (!isSubscribed && isFreeLimitError(response.status, data.error)) {
          setShowPaywall(true);
          setMessage("Your free render has been used. Subscribe for unlimited rendering.");
        } else {
          setMessage(data.error || "Render failed to start.");
        }
        setLoading(false);
        return;
      }
      setMessage("Rendering... high-fidelity renders can take a minute or two.");
      pollRender(data.jobId);
    } catch (error) {
      setMessage("Server connection failed.");
      setLoading(false);
    }
  }

  function pollRender(jobId) {
    let polls = 0;
    renderPollRef.current = setInterval(async () => {
      polls += 1;
      if (polls > RENDER_MAX_POLLS) {
        stopRenderPolling();
        setLoading(false);
        setMessage("Render timed out. Please try again.");
        return;
      }
      try {
        const response = await fetch(API_URL + "/render/status/" + jobId);
        const data = await response.json();
        if (data.status === "done" && data.image) {
          stopRenderPolling();
          setResultImage(data.image);
          setLoading(false);
          setMessage("Render complete. Tap the image to view full screen.");
        } else if (data.status === "failed" || data.status === "not_found" || data.ok === false) {
          // "not_found" means the server restarted mid-render — the user can
          // simply retry (the free-render map reset too, so nothing is lost).
          stopRenderPolling();
          setLoading(false);
          setMessage(data.error || "Render failed. Please try again.");
        }
        // status === "pending": keep polling silently.
      } catch (error) {
        // Transient network blip — keep polling until MAX_POLLS.
      }
    }, RENDER_POLL_INTERVAL_MS);
  }

  async function saveImage() {
    if (!resultImage) { setMessage("No image to save."); return; }
    try {
      setSaving(true);
      const permission = await MediaLibrary.requestPermissionsAsync();
      if (!permission.granted) { setMessage("Photos permission required."); return; }
      let fileUri = resultImage;
      if (resultImage.startsWith("data:image")) {
        const base64 = resultImage.split(",")[1];
        fileUri = FileSystem.cacheDirectory + "monocular-render-" + Date.now() + ".png";
        await FileSystem.writeAsStringAsync(fileUri, base64, { encoding: FileSystem.EncodingType.Base64 });
      }
      const asset = await MediaLibrary.createAssetAsync(fileUri);
      await MediaLibrary.createAlbumAsync("Monocular", asset, false);
      setMessage("Saved to Photos.");
    } catch (error) {
      setMessage("Could not save image.");
    } finally {
      setSaving(false);
    }
  }

  async function renderVideo() {
    // Video remains Pro-only.
    if (!isSubscribed) { setShowPaywall(true); return; }
    if (!prompt.trim() && !imageBase64) { setMessage("Add a brief or upload an image first."); return; }
    try {
      setVideoLoading(true);
      setResultVideoUrl(null);
      setVideoStatus("Submitting video job...");
      setMessage("");
      const images = [imageBase64, ...extraImages.map(x => x.base64)].filter(Boolean);
      const response = await fetch(API_URL + "/api/video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, imageBase64, images, mode, ...identityFields() }),
      });
      const data = await response.json();
      if (!data.ok || !data.video?.id) {
        setVideoStatus("");
        setMessage(data.error || "Video request failed.");
        setVideoLoading(false);
        return;
      }
      pollVideo(data.video.id);
    } catch (error) {
      setMessage("Server connection failed.");
      setVideoLoading(false);
    }
  }

  function pollVideo(videoId) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const response = await fetch(API_URL + "/api/video/" + videoId);
        const data = await response.json();
        if (!data.ok) {
          clearInterval(pollRef.current);
          setVideoLoading(false);
          setVideoStatus("");
          setMessage(data.error || "Video status check failed.");
          return;
        }
        const status = data.video?.status;
        setVideoStatus("Status: " + (status || "processing") + "...");
        if (status === "completed" || status === "succeeded") {
          clearInterval(pollRef.current);
          setVideoLoading(false);
          setVideoStatus("");
          setMessage("Finalising video...");
          setTimeout(async () => {
            try {
              const ur = await fetch(API_URL + "/api/video/" + videoId + "/url");
              const ud = await ur.json();
              if (ud.ok && ud.url) {
                setResultVideoUrl(ud.url);
                setMessage("Video render complete.");
              } else {
                setResultVideoUrl(API_URL + "/api/video/" + videoId + "/content");
                setMessage("Video render complete.");
              }
            } catch (e) {
              setResultVideoUrl(API_URL + "/api/video/" + videoId + "/content");
              setMessage("Video render complete.");
            }
          }, 3000);
        } else if (status === "failed" || status === "error") {
          clearInterval(pollRef.current);
          setVideoLoading(false);
          setVideoStatus("");
          setMessage("Video generation failed.");
        }
      } catch (error) {}
    }, 4000);
  }

  async function saveVideo() {
    if (!resultVideoUrl) { setMessage("No video to save."); return; }
    try {
      setSavingVideo(true);
      setMessage("Saving video...");
      const permission = await MediaLibrary.requestPermissionsAsync();
      if (!permission.granted) { setMessage("Photos permission required."); return; }
      const fileUri = FileSystem.cacheDirectory + "monocular-video-" + Date.now() + ".mp4";
      const download = await FileSystem.downloadAsync(resultVideoUrl, fileUri);
      const asset = await MediaLibrary.createAssetAsync(download.uri);
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
        onTryFree={() => setShowOnboarding(false)}
        onSeePro={() => { setShowOnboarding(false); setShowPaywall(true); }}
      />
    );
  }

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
        <Image source={require("./assets/logo.png")} style={styles.logoMark} />
        <Text style={styles.subtitle}>Rational Architectural Visualisation</Text>

        <Modal visible={showPaywall} transparent animationType="slide">
          <View style={styles.paywallOverlay}>
            <View style={styles.paywallCard}>
              <Text style={styles.paywallTitle}>MONOCULAR PRO</Text>
              <Text style={styles.paywallPrice}>$19.99 / month — auto-renewing</Text>
              <Text style={styles.paywallBody}>Your first render is free. Subscribe to unlock unlimited photorealistic architectural renders and 3D walkthrough videos.</Text>
              <TouchableOpacity style={[styles.buttonLight, purchasing && styles.disabled]} onPress={buySubscription} disabled={purchasing}>
                {purchasing ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonLightText}>SUBSCRIBE — $19.99/MONTH</Text>}
              </TouchableOpacity>
              <TouchableOpacity onPress={restorePurchases} disabled={purchasing}>
                <Text style={styles.paywallLink}>Restore purchases</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setShowPaywall(false)}>
                <Text style={styles.paywallLink}>Not now</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => Linking.openURL("https://monocular-opal.vercel.app/privacy.html")}>
                <Text style={styles.paywallLink}>Privacy Policy</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => Linking.openURL("https://monocular-opal.vercel.app/terms.html")}>
                <Text style={styles.paywallLink}>Terms of Use</Text>
              </TouchableOpacity>
              <Text style={styles.paywallSmall}>Payment charged to Apple ID at confirmation. Subscription renews automatically unless cancelled at least 24 hours before the renewal date.</Text>
            </View>
          </View>
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

        {/* 3D model viewer: lazy-loaded so the GL stack only loads on demand */}
        <Modal visible={showModelViewer} transparent={false} animationType="slide">
          {showModelViewer && (
            <LazyModelViewer
              onCapture={handleModelCapture}
              onClose={() => setShowModelViewer(false)}
            />
          )}
        </Modal>

        <View style={styles.tabRow}>
          <TouchableOpacity style={[styles.tabButton, tab === "image" && styles.tabButtonActive]} onPress={() => setTab("image")}>
            <Text style={[styles.tabText, tab === "image" && styles.tabTextActive]}>IMAGE</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.tabButton, tab === "video" && styles.tabButtonActive]} onPress={() => setTab("video")}>
            <Text style={[styles.tabText, tab === "video" && styles.tabTextActive]}>3D VIDEO</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.card}>
          <TouchableOpacity style={styles.buttonDark} onPress={pickImage}>
            <Text style={styles.buttonDarkText}>{selectedImage ? "CHANGE IMAGE" : "IMPORT IMAGE"}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.buttonDark} onPress={() => setShowModelViewer(true)}>
            <Text style={styles.buttonDarkText}>IMPORT 3D MODEL</Text>
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
            placeholder="Describe the render direction..."
            placeholderTextColor="#777"
            multiline
            scrollEnabled={false}
            value={prompt}
            onChangeText={setPrompt}
          />

          {tab === "image" ? (
            <>
              <TouchableOpacity style={[styles.buttonLight, loading && styles.disabled]} onPress={renderImage} disabled={loading}>
                {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonLightText}>{isSubscribed ? "RENDER" : "RENDER — 1 FREE"}</Text>}
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
              <TouchableOpacity style={styles.buttonDark} onPress={pickExtraImage}>
                <Text style={styles.buttonDarkText}>ADD ANGLE (UP TO 3)</Text>
              </TouchableOpacity>
              {extraImages.length > 0 && (
                <View style={styles.thumbRow}>
                  {extraImages.map((img, i) => <Image key={i} source={{ uri: img.uri }} style={styles.thumb} />)}
                </View>
              )}
              <TouchableOpacity style={[styles.buttonLight, videoLoading && styles.disabled]} onPress={renderVideo} disabled={videoLoading}>
                {videoLoading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonLightText}>GENERATE VIDEO — PRO</Text>}
              </TouchableOpacity>
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
  logoMark: { width: 120, height: 120, borderRadius: 24, alignSelf: "center", marginBottom: 10, resizeMode: "contain" },
  subtitle: { color: "#aaa", fontSize: 14, marginBottom: 20, textAlign: "center" },
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
  preview: { width: "100%", height: 260, borderRadius: 18, resizeMode: "cover", marginBottom: 16 },
  result: { width: "100%", height: 480, borderRadius: 18, marginTop: 18, marginBottom: 16, resizeMode: "cover" },
  thumbRow: { flexDirection: "row", flexWrap: "wrap", marginBottom: 16 },
  thumb: { width: 80, height: 80, borderRadius: 10, marginRight: 8, marginBottom: 8 },
  message: { color: "#ddd", textAlign: "center", marginTop: 14 },
  disabled: { opacity: 0.6 },
  paywallOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.88)", justifyContent: "center", alignItems: "center", padding: 24 },
  paywallCard: { width: "100%", maxWidth: 420, backgroundColor: "#111", borderRadius: 24, padding: 26, borderWidth: 1, borderColor: "#2a2a2a", alignItems: "center" },
  paywallTitle: { color: "#fff", fontSize: 24, fontWeight: "900", letterSpacing: 3, marginBottom: 6 },
  paywallPrice: { color: "#fff", fontSize: 18, fontWeight: "700", marginBottom: 16 },
  paywallBody: { color: "#aaa", fontSize: 14, textAlign: "center", marginBottom: 22, lineHeight: 20 },
  paywallLink: { color: "#888", fontSize: 13, marginTop: 16, textAlign: "center" },
  paywallSmall: { color: "#555", fontSize: 11, textAlign: "center", marginTop: 16, lineHeight: 16 },
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
