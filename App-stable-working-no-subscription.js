import React, { useState } from "react";
import {
  ActivityIndicator,
  Image,
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
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  async function pickImage() {
    try {
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
      console.log("Image picker error:", error);
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

      const data = await response.json();

      if (data.image) {
        setResultImage(data.image);
        setMessage("Render complete.");
      } else {
        setMessage(data.error || "Render failed.");
      }
    } catch (error) {
      console.log("Render error:", error);
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
      }

      const asset = await MediaLibrary.createAssetAsync(fileUri);
      await MediaLibrary.createAlbumAsync("Monocular", asset, false);

      setMessage("Saved to Photos.");
    } catch (error) {
      console.log("Save image error:", error);
      setMessage("Could not save image.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Text style={styles.logo}>MONOCULAR</Text>
      <Text style={styles.subtitle}>Rational Architectural Visualisation</Text>

      <View style={styles.card}>
        <TouchableOpacity style={styles.buttonDark} onPress={pickImage}>
          <Text style={styles.buttonDarkText}>
            {selectedImage ? "CHANGE IMAGE" : "IMPORT IMAGE"}
          </Text>
        </TouchableOpacity>

        {selectedImage ? (
          <Image source={{ uri: selectedImage }} style={styles.preview} />
        ) : null}

        <TextInput
          style={styles.input}
          placeholder="Describe the render direction..."
          placeholderTextColor="#777"
          multiline
          value={prompt}
          onChangeText={setPrompt}
        />

        <TouchableOpacity
          style={[styles.buttonLight, loading ? styles.disabled : null]}
          onPress={renderImage}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#000" />
          ) : (
            <Text style={styles.buttonLightText}>RENDER</Text>
          )}
        </TouchableOpacity>

        {resultImage ? (
          <>
            <Image source={{ uri: resultImage }} style={styles.result} />

            <TouchableOpacity
              style={[styles.buttonDark, saving ? styles.disabled : null]}
              onPress={saveImage}
              disabled={saving}
            >
              <Text style={styles.buttonDarkText}>
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
    color: "#fff",
    fontSize: 34,
    fontWeight: "900",
    letterSpacing: 5,
    marginBottom: 8,
  },
  subtitle: {
    color: "#aaa",
    fontSize: 14,
    marginBottom: 28,
    textAlign: "center",
  },
  card: {
    width: "100%",
    maxWidth: 540,
    backgroundColor: "#111",
    borderRadius: 24,
    padding: 18,
    borderWidth: 1,
    borderColor: "#2a2a2a",
  },
  buttonDark: {
    backgroundColor: "#222",
    padding: 16,
    borderRadius: 16,
    alignItems: "center",
    marginBottom: 16,
  },
  buttonDarkText: {
    color: "#fff",
    fontWeight: "900",
    letterSpacing: 1,
  },
  buttonLight: {
    backgroundColor: "#fff",
    padding: 16,
    borderRadius: 16,
    alignItems: "center",
    marginTop: 16,
  },
  buttonLightText: {
    color: "#000",
    fontWeight: "900",
    letterSpacing: 1,
  },
  input: {
    minHeight: 110,
    backgroundColor: "#050505",
    color: "#fff",
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: "#333",
    textAlignVertical: "top",
  },
  preview: {
    width: "100%",
    height: 260,
    borderRadius: 18,
    resizeMode: "cover",
    marginBottom: 16,
  },
  result: {
    width: "100%",
    height: 360,
    borderRadius: 18,
    resizeMode: "cover",
    marginTop: 18,
    marginBottom: 16,
  },
  message: {
    color: "#ddd",
    textAlign: "center",
    marginTop: 14,
  },
  disabled: {
    opacity: 0.6,
  },
});