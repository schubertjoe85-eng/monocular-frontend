cd ~/monocular-new
cat > App.jsimport React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as MediaLibrary from "expo-media-library";
import * as FileSystem from "expo-file-system";

const API_URL = "https://monocular-server.onrender.com";

function LogoMark() {
  return (
    <View style={styles.logo}>
      <Text style={styles.logoText}>M</Text>
    </View>
  );
}

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [selectedImage, setSelectedImage] = useState(null);
  const [imageBase64, setImageBase64] = useState(null);
  const [resultImage, setResultImage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [subscribed, setSubscribed] = useState(true);

  async function buySubscription() {
    Alert.alert(
      "Subscribe",
      "Monocular Monthly is managed through the Apple App Store."
    );
  }

  async function restoreSubscription() {
    Alert.alert(
      "Restore Purchase",
      "Restore purchases through your Apple ID subscription settings."
    );
  }

  async function pickImage() {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permission.granted) {
        setMessage("Photo permission required.");
        return;
      }

      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.85,
        base64: true,
      });

      if (picked.canceled) return;

      const asset = picked.assets[0];
      setSelectedImage(asset.uri);
      setImageBase64(asset.base64 || null);
      setResultImage(null);
      setMessage("Image imported.");
    } catch {
      setMessage("Could not import image.");
    }
  }

  async function renderImage() {
    if (!selectedImage || !imageBase64) {
      setMessage("Import an image or drawing first.");
      return;
    }

    try {
      setLoading(true);
      setMessage("Rendering...");
      setResultImage(null);

      const response = await fetch(`${API_URL}/render`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
          imageBase64,
          mode: "render",
        }),
      });

      const data = await response.json();

      if (data.image) {
        setResultImage(data.image);
        setMessage("Render complete.");
      } else {
        setMessage(data.error || "Render failed.");
      }
    } catch {
      setMessage("Server connection failed.");
    } finally {
      setLoading(false);
    }
  }

  async function saveImage() {
    if (!resultImage) {
      setMessage("No image to save.");
      return;
    }

    if (Platform.OS === "web") {
      setMessage("Save is available on iPhone.");
      return;
    }

    try {
      setSaving(true);

      const permission = await MediaLibrary.requestPermissionsAsync();
      if (!permission.granted) {
        setMessage("Photos permission required.");
        return;
      }

      let fileUri = resultImage;

      if (resultImage.startsWith("data:image")) {
        const base64 = resultImage.split(",")[1];
        fileUri = `${FileSystem.cacheDirectory}monocular-render-${Date.now()}.png`;
        await FileSystem.writeAsStringAsync(fileUri, base64, {
          encoding: FileSystem.EncodingType.Base64,
        });
      } else if (resultImage.startsWith("http")) {
        const download = await FileSystem.downloadAsync(
          resultImage,
          `${FileSystem.cacheDirectory}monocular-render-${Date.now()}.png`
        );
        fileUri = download.uri;
      }

      const asset = await MediaLibrary.createAssetAsync(fileUri);
      await MediaLibrary.createAlbumAsync("Monocular", asset, false);

      setMessage("Saved to Photos.");
    } catch {
      setMessage("Failed to save image.");
    } finally {
      setSaving(false);
    }
  }

  if (!subscribed) {
    return (
      <ScrollView style={styles.page} contentContainerStyle={styles.content}>
        <LogoMark />

        <Text numberOfLines={1} adjustsFontSizeToFit style={styles.title}>
          MONOCULAR
        </Text>

        <Text style={styles.subtitle}>AI Architectural Rendering</Text>

        <View style={styles.card}>
          <Text style={styles.paywallTitle}>Monocular Monthly</Text>

          <Text style={styles.paywallText}>
            Subscribe to generate architectural visualisations from sketches,
            drawings and photos.
          </Text>

          <Text style={styles.price}>$29 / month</Text>

          <Text style={styles.paywallText}>
            Auto-renewing monthly subscription.
          </Text>

          <Text style={styles.paywallText}>
            Terms of Use: https://www.apple.com/legal/internet-services/itunes/dev/stdeula/
          </Text>

          <TouchableOpacity style={styles.renderButton} onPress={buySubscription}>
            <Text style={styles.buttonText}>SUBSCRIBE</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.restoreButton} onPress={restoreSubscription}>
            <Text style={styles.restoreText}>RESTORE PURCHASE</Text>
          </TouchableOpacity>

          {message ? <Text style={styles.message}>{message}</Text> : null}
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <LogoMark />

      <Text numberOfLines={1} adjustsFontSizeToFit style={styles.title}>
        MONOCULAR
      </Text>

      <Text style={styles.subtitle}>Rational Architectural Visualisation</Text>

      <View style={styles.card}>
        <Text style={styles.label}>IMAGE / DRAWING</Text>

        <TouchableOpacity style={styles.uploadButton} onPress={pickImage}>
          <Text style={styles.buttonText}>
            {selectedImage ? "CHANGE IMAGE" : "IMPORT IMAGE"}
          </Text>
        </TouchableOpacity>

        {selectedImage ? (
          <Image source={{ uri: selectedImage }} style={styles.preview} />
        ) : null}

        <Text style={styles.label}>DIRECTION</Text>

        <TextInput
          style={styles.input}
          placeholder="Example: realistic Australian architectural render, keep all openings and roof form accurate"
          placeholderTextColor="#777"
          value={prompt}
          onChangeText={setPrompt}
          multiline
        />

        <TouchableOpacity
          style={[styles.renderButton, loading ? styles.disabled : null]}
          onPress={renderImage}
          disabled={loading}
        >
          {loading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color="#FFFFFF" />
              <Text style={styles.buttonText}> RENDERING...</Text>
            </View>
          ) : (
            <Text style={styles.buttonText}>RENDER</Text>
          )}
        </TouchableOpacity>

        {resultImage ? (
          <>
            <Image source={{ uri: resultImage }} style={styles.result} />
            <TouchableOpacity
              style={[styles.saveButton, saving ? styles.disabled : null]}
              onPress={saveImage}
              disabled={saving}
            >
              <Text style={styles.buttonText}>
                {saving ? "SAVING..." : "SAVE IMAGE"}
              </Text>
            </TouchableOpacity>
          </>
        ) : null}

        {message ? <Text style={styles.message}>{message}</Text> : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: "#050505",
  },
  content: {
    padding: 22,
    paddingTop: 70,
    alignItems: "center",
  },
  logo: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 1,
    borderColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 18,
  },
  logoText: {
    color: "#FFFFFF",
    fontSize: 34,
    fontWeight: "800",
    letterSpacing: 2,
  },
  title: {
    color: "#FFFFFF",
    fontSize: 36,
    fontWeight: "900",
    letterSpacing: 5,
    textAlign: "center",
  },
  subtitle: {
    color: "#BDBDBD",
    fontSize: 14,
    marginTop: 8,
    marginBottom: 26,
    textAlign: "center",
  },
  card: {
    width: "100%",
    maxWidth: 520,
    backgroundColor: "#111111",
    borderRadius: 24,
    padding: 18,
    borderWidth: 1,
    borderColor: "#2A2A2A",
  },
  label: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1.5,
    marginBottom: 10,
    marginTop: 8,
  },
  uploadButton: {
    backgroundColor: "#222222",
    borderRadius: 16,
    padding: 16,
    alignItems: "center",
    marginBottom: 18,
  },
  renderButton: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 16,
    alignItems: "center",
    marginTop: 16,
  },
  saveButton: {
    backgroundColor: "#333333",
    borderRadius: 16,
    padding: 16,
    alignItems: "center",
    marginTop: 14,
  },
  restoreButton: {
    padding: 14,
    alignItems: "center",
    marginTop: 8,
  },
  buttonText: {
    color: "#000000",
    fontSize: 14,
    fontWeight: "900",
    letterSpacing: 1,
  },
  restoreText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "700",
  },
  input: {
    minHeight: 110,
    backgroundColor: "#050505",
    color: "#FFFFFF",
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: "#333333",
    textAlignVertical: "top",
    marginBottom: 8,
  },
  preview: {
    width: "100%",
    height: 260,
    borderRadius: 18,
    resizeMode: "cover",
    marginBottom: 18,
  },
  result: {
    width: "100%",
    height: 360,
    borderRadius: 18,
    resizeMode: "cover",
    marginTop: 18,
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  disabled: {
    opacity: 0.6,
  },
  message: {
    color: "#DADADA",
    fontSize: 13,
    textAlign: "center",
    marginTop: 16,
  },
  paywallTitle: {
    color: "#FFFFFF",
    fontSize: 24,
    fontWeight: "900",
    textAlign: "center",
    marginBottom: 12,
  },
  paywallText: {
    color: "#CFCFCF",
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    marginBottom: 12,
  },
  price: {
    color: "#FFFFFF",
    fontSize: 28,
    fontWeight: "900",
    textAlign: "center",
    marginVertical: 10,
  },
});npx expo export --platform ios
npx expo export --platform ios
npx eas-cli@latest build --platform ios --auto-submit
