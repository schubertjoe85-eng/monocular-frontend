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

const API_URL = "https://monocular-server.onrender.com";

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [selectedImage, setSelectedImage] = useState(null);
  const [imageBase64, setImageBase64] = useState(null);
  const [resultImage, setResultImage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  async function pickImage() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
      base64: true,
    });

    if (!result.canceled && result.assets?.length) {
      const asset = result.assets[0];
      setSelectedImage(asset.uri);
      setImageBase64(asset.base64 || null);
      setResultImage(null);
      setMessage("Image loaded.");
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

      const res = await fetch(`${API_URL}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, imageBase64, mode: "render" }),
      });

      const data = await res.json();

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
          <Image source={{ uri: selectedImage }} style={styles.previewImage} />
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
          style={[styles.renderButton, loading && styles.disabled]}
          onPress={renderImage}
          disabled={loading}
        >
          {loading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color="#fff" />
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
          <Image source={{ uri: resultImage }} style={styles.resultImage} />
        </View>
      ) : null}
    </ScrollView>
  );
}

function LogoMark() {
  return (
    <View style={styles.logoBox}>
      <View style={styles.logoCircle} />
      <View style={styles.logoLineVertical} />
      <View style={styles.logoLineHorizontal} />
      <View style={styles.logoDiagOne} />
      <View style={styles.logoDiagTwo} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: "#07110B",
  },
  content: {
    padding: 24,
    paddingTop: 54,
    paddingBottom: 90,
  },
  logoBox: {
    width: 104,
    height: 104,
    borderWidth: 2,
    borderColor: "#6FA342",
    borderRadius: 28,
    alignSelf: "center",
    marginBottom: 26,
    overflow: "hidden",
  },
  logoCircle: {
    position: "absolute",
    width: 62,
    height: 62,
    borderRadius: 31,
    borderWidth: 2,
    borderColor: "#6FA342",
    top: 20,
    left: 20,
  },
  logoLineVertical: {
    position: "absolute",
    width: 2,
    height: "100%",
    backgroundColor: "#6FA342",
    left: 51,
  },
  logoLineHorizontal: {
    position: "absolute",
    height: 2,
    width: "100%",
    backgroundColor: "#6FA342",
    top: 51,
  },
  logoDiagOne: {
    position: "absolute",
    width: 150,
    height: 2,
    backgroundColor: "#6FA342",
    transform: [{ rotate: "45deg" }],
    top: 51,
    left: -24,
  },
  logoDiagTwo: {
    position: "absolute",
    width: 150,
    height: 2,
    backgroundColor: "#6FA342",
    transform: [{ rotate: "-45deg" }],
    top: 51,
    left: -24,
  },
  title: {
    color: "#FFFFFF",
    textAlign: "center",
    fontSize: 48,
    fontWeight: "900",
    letterSpacing: 1,
    marginBottom: 20,
  },
  subtitle: {
    color: "#79A94A",
    textAlign: "center",
    fontSize: 24,
    fontWeight: "900",
    marginBottom: 34,
  },
  card: {
    backgroundColor: "#0D1A10",
    borderRadius: 28,
    padding: 22,
    borderWidth: 2,
    borderColor: "#6FA342",
  },
  label: {
    color: "#79A94A",
    fontSize: 15,
    fontWeight: "900",
    letterSpacing: 2,
    marginBottom: 12,
    marginTop: 6,
  },
  uploadButton: {
    backgroundColor: "#6F933D",
    borderRadius: 22,
    padding: 20,
    marginBottom: 24,
  },
  previewImage: {
    width: "100%",
    height: 300,
    borderRadius: 22,
    marginBottom: 24,
    backgroundColor: "#07110B",
  },
  input: {
    backgroundColor: "#07110B",
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
    backgroundColor: "#6F933D",
    borderRadius: 22,
    padding: 20,
    marginTop: 24,
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
    color: "#79A94A",
    textAlign: "center",
    fontWeight: "900",
    marginBottom: 14,
    letterSpacing: 2,
  },
  resultImage: {
    width: "100%",
    height: 430,
    borderRadius: 24,
    backgroundColor: "#0D1A10",
  },
});