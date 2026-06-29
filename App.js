import React, { useState, useRef, useEffect } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Modal,
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

const API_URL = "https://monocular-server.onrender.com";
const RC_API_KEY = "appl_jJKgQZQIYePcVeZnnwpGtHacrrB";
const ENTITLEMENT_ID = "Monocular Pro";

const MODES = [
  { key: "render", label: "EXTERIOR" },
  { key: "interior", label: "INTERIOR" },
];

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
  const pollRef = useRef(null);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [showPaywall, setShowPaywall] = useState(false);
  const [purchasing, setPurchasing] = useState(false);

  useEffect(() => {
    async function initRevenueCat() {
      try {
        Purchases.configure({ apiKey: RC_API_KEY });
        const info = await Purchases.getCustomerInfo();
        setIsSubscribed(!!info.entitlements.active[ENTITLEMENT_ID]);
      } catch (error) {
        console.log("RevenueCat init error:", error);
      }
    }
    initRevenueCat();
  }, []);

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

  async function renderImage() {
    if (!isSubscribed) { setShowPaywall(true); return; }
    if (!prompt.trim() && !imageBase64) { setMessage("Add a brief or upload an image first."); return; }
    try {
      setLoading(true);
      setMessage("Rendering...");
      setResultImage(null);
      const response = await fetch(API_URL + "/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, imageBase64, mode, subscriptionActive: isSubscribed }),
      });
      const data = await response.json();
      if (data.ok && data.image) {
        setResultImage(data.image);
        setMessage("Render complete.");
      } else {
        setMessage(data.error || "Render failed.");
      }
    } catch (error) {
      setMessage("Server connection failed.");
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
        body: JSON.stringify({ prompt, imageBase64, images, mode }),
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

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Image source={require("./assets/logo.png")} style={styles.logoMark} />
      <Text style={styles.subtitle}>Rational Architectural Visualisation</Text>

      <Modal visible={showPaywall} transparent animationType="slide">
        <View style={styles.paywallOverlay}>
          <View style={styles.paywallCard}>
            <Text style={styles.paywallTitle}>MONOCULAR PRO</Text>
            <Text style={styles.paywallPrice}>$19.99 / month — auto-renewing</Text>
            <Text style={styles.paywallBody}>Subscribe to unlock unlimited photorealistic architectural renders and 3D walkthrough videos. Subscription required to access all features.</Text>
            <TouchableOpacity style={[styles.buttonLight, purchasing && styles.disabled]} onPress={buySubscription} disabled={purchasing}>
              {purchasing ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonLightText}>SUBSCRIBE — $19.99/MONTH</Text>}
            </TouchableOpacity>
            <TouchableOpacity onPress={restorePurchases} disabled={purchasing}>
              <Text style={styles.paywallLink}>Restore purchases</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowPaywall(false)}>
              <Text style={styles.paywallLink}>Not now</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => Linking.openURL("https://monocular-opal.vercel.app/privacy.html")}

              <Text style={styles.paywallLink}>Privacy Policy</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => Linking.openURL("https://monocular-opal.vercel.app/terms.html")}

              <Text style={styles.paywallLink}>Terms of Use</Text>
            </TouchableOpacity>
            <Text style={styles.paywallSmall}>Payment charged to Apple ID at confirmation. Subscription renews automatically unless cancelled at least 24 hours before the renewal date.</Text>
          </View>
        </View>
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

        {selectedImage && <Image source={{ uri: selectedImage }} style={styles.preview} />}

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
          value={prompt}
          onChangeText={setPrompt}
        />

        {tab === "image" ? (
          <>
            <TouchableOpacity style={[styles.buttonLight, loading && styles.disabled]} onPress={renderImage} disabled={loading}>
              {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonLightText}>RENDER</Text>}
            </TouchableOpacity>
            {resultImage && (
              <>
                <Image source={{ uri: resultImage }} style={styles.result} />
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
              {videoLoading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonLightText}>GENERATE VIDEO</Text>}
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
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#050505" },
  content: { padding: 22, paddingTop: 70, alignItems: "center" },
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
  input: { minHeight: 110, backgroundColor: "#050505", color: "#fff", borderRadius: 16, padding: 14, borderWidth: 1, borderColor: "#333", textAlignVertical: "top" },
  preview: { width: "100%", height: 260, borderRadius: 18, resizeMode: "cover", marginBottom: 16 },
  result: { width: "100%", height: 360, borderRadius: 18, marginTop: 18, marginBottom: 16 },
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
});
