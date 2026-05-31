import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
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

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [selectedImage, setSelectedImage] = useState(null);
  const [imageBase64, setImageBase64] = useState(null);
  const [resultImage, setResultImage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  async function pickImage() {
    try {
      const permission =
        await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permission.granted) {
        setMessage("Photo permission required.");
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.8,
        base64: true,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const asset = result.assets[0];

        setSelectedImage(asset.uri);
        setImageBase64(asset.base64 || null);
        setResultImage(null);
        setMessage("Image loaded.");
      }
    } catch (error) {
      setMessage("Image upload failed.");
    }
  }

  async function renderImage() {
    if (!prompt.trim() && !imageBase64) {
      setMessage("Add a brief or upload an image first.");
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

      let data = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }

      if (!response.ok) {
        setMessage(data.error || "Render failed.");
        return;
      }

      if (data.image) {
        const imageUri = data.image.startsWith("data:image")
          ? data.image
          : `data:image/png;base64,${data.image}`;

        setResultImage(imageUri);
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
    if (!resultImage) {
      setMessage("No image to save.");
      return;
    }

    try {
      const permission = await MediaLibrary.requestPermissionsAsync();

      if (!permission.granted) {
        setMessage("Photos permission required.");
        return;
      }

      let fileUri = resultImage;

      if (resultImage.startsWith("data:image")) {
        const base64 = resultImage.split(",")[1];

        if (!base64) {
          setMessage("Image save failed.");
          return;
        }

        fileUri = `${FileSystem.cacheDirectory}monocular-${Date.now()}.png`;

        await FileSystem.writeAsStringAsync(fileUri, base64, {
          encoding: FileSystem.EncodingType.Base64,
        });
      }

      const asset = await MediaLibrary.createAssetAsync(fileUri);

      try {
        await MediaLibrary.createAlbumAsync("Monocular", asset, false);
      } catch {
        // If album already exists or cannot be created, image is still saved.
      }

      setMessage("Saved to Photos.");

      if (Platform.OS === "ios") {
        Alert.alert("Saved", "Image saved to Photos.");
      }
    } catch (error) {
      setMessage("Failed to save image.");
    }
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
          <Image
            source={{ uri: selectedImage }}
            style={styles.previewImage}
            resizeMode="cover"
          />
        ) : null}

        <Text style={styles.label}>PROJECT BRIEF</Text>

        <TextInput
          style={styles.input}
          placeholder="Describe materials, light, landscape, atmosphere..."
          placeholderTextColor="#8FA08A"
          multiline
          value={prompt}
          onChangeText={setPrompt}
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

        {message ? <Text style={styles.message}>{message}</Text> : null}
      </View>

      {resultImage ? (
        <View style={styles.resultContainer}>
          <Text style={styles.resultTitle}>RESULT</Text>

          <Image
            source={{ uri: resultImage }}
            style={styles.resultImage}
            resizeMode="cover"
          />

          <TouchableOpacity style={styles.saveButton} onPress={saveImage}>
            <Text style={styles.buttonText}>SAVE IMAGE</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </ScrollView>
  );
}

function LogoMark() {
  return (
    <View style={styles.logoBox}>
      <View style={styles.logoCircleOuter} />
      <View style={styles.logoCircleInner} />
      <View style={styles.logoVertical} />
      <View style={styles.logoHorizontal} />
      <View style={styles.logoDiagonalOne} />
      <View style={styles.logoDiagonalTwo} />
    </View>
  );
}

const GREEN = "#6FA342";
const GREEN_LIGHT = "#79A94A";
const GREEN_BUTTON = "#6F933D";
const DARK = "#07110B";
const CARD = "#0D1A10";

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: DARK,
  },
  content: {
    paddingHorizontal: 24,
    paddingTop: 54,
    paddingBottom: 90,
  },
  logoBox: {
    width: 104,
    height: 104,
    borderWidth: 2,
    borderColor: GREEN,
    borderRadius: 28,
    alignSelf: "center",
    marginBottom: 26,
    overflow: "hidden",
  },
  logoCircleOuter: {
    position: "absolute",
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 2,
    borderColor: GREEN,
    top: 16,
    left: 16,
  },
  logoCircleInner: {
    position: "absolute",
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 2,
    borderColor: GREEN,
    top: 31,
    left: 31,
  },
  logoVertical: {
    position: "absolute",
    width: 2,
    height: "100%",
    backgroundColor: GREEN,
    left: 51,
  },
  logoHorizontal: {
    position: "absolute",
    height: 2,
    width: "100%",
    backgroundColor: GREEN,
    top: 51,
  },
  logoDiagonalOne: {
    position: "absolute",
    width: 150,
    height: 2,
    backgroundColor: GREEN,
    transform: [{ rotate: "45deg" }],
    top: 51,
    left: -24,
  },
  logoDiagonalTwo: {
    position: "absolute",
    width: 150,
    height: 2,
    backgroundColor: GREEN,
    transform: [{ rotate: "-45deg" }],
    top: 51,
    left: -24,
  },
  title: {
    color: "#FFFFFF",
    textAlign: "center",
    fontSize: 42,
    fontWeight: "900",
    letterSpacing: 1,
    marginBottom: 20,
    includeFontPadding: false,
  },
  subtitle: {
    color: GREEN_LIGHT,
    textAlign: "center",
    fontSize: 22,
    lineHeight: 30,
    fontWeight: "900",
    marginBottom: 34,
  },
  card: {
    backgroundColor: CARD,
    borderRadius: 28,
    padding: 22,
    borderWidth: 2,
    borderColor: GREEN,
  },
  label: {
    color: GREEN_LIGHT,
    fontSize: 15,
    fontWeight: "900",
    letterSpacing: 2,
    marginBottom: 12,
    marginTop: 6,
  },
  uploadButton: {
    backgroundColor: GREEN_BUTTON,
    borderRadius: 22,
    paddingVertical: 20,
    paddingHorizontal: 16,
    marginBottom: 24,
  },
  previewImage: {
    width: "100%",
    height: 300,
    borderRadius: 22,
    marginBottom: 24,
    backgroundColor: DARK,
  },
  input: {
    backgroundColor: DARK,
    color: "#FFFFFF",
    minHeight: 170,
    borderRadius: 22,
    padding: 18,
    fontSize: 18,
    textAlignVertical: "top",
    borderWidth: 1,
    borderColor: "#2E4426",
  },
  renderButton: {
    backgroundColor: GREEN_BUTTON,
    borderRadius: 22,
    paddingVertical: 20,
    paddingHorizontal: 16,
    marginTop: 24,
  },
  saveButton: {
    backgroundColor: GREEN_BUTTON,
    borderRadius: 22,
    paddingVertical: 18,
    paddingHorizontal: 16,
    marginTop: 16,
  },
  disabled: {
    opacity: 0.6,
  },
  loadingRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
  },
  buttonText: {
    color: "#FFFFFF",
    fontWeight: "900",
    textAlign: "center",
    fontSize: 20,
    letterSpacing: 1,
  },
  message: {
    color: "#FFFFFF",
    textAlign: "center",
    marginTop: 16,
    fontSize: 16,
  },
  resultContainer: {
    marginTop: 32,
  },
  resultTitle: {
    color: GREEN_LIGHT,
    textAlign: "center",
    fontWeight: "900",
    marginBottom: 14,
    letterSpacing: 2,
  },
  resultImage: {
    width: "100%",
    height: 430,
    borderRadius: 24,
    backgroundColor: CARD,
  },
});
