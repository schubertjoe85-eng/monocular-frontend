import React, { useState } from "react";
import {
  ActivityIndicator,
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

const API_URL = "https://monocular-server.onrender.com";

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [selectedImage, setSelectedImage] = useState(null);
  const [imageBase64, setImageBase64] = useState(null);
  const [resultImage, setResultImage] = useState(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function pickImage() {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.75,
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
      setMessage("Add a project brief or upload an image first.");
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
          selectedImage,
          platform: Platform.OS,
        }),
      });

      const data = await response.json();

      if (data.image) {
        setResultImage(data.image);
        setMessage("Render complete.");
      } else {
        setMessage(data.error || data.detail || "Render failed.");
      }
    } catch (error) {
      setMessage("Server connection failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Text style={styles.brand}>MONOCULAR</Text>
      <Text style={styles.subtitle}>AI Architectural Rendering</Text>

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
            style={styles.preview}
            resizeMode="cover"
          />
        ) : null}

        <Text style={styles.label}>PROJECT BRIEF</Text>

        <TextInput
          style={styles.input}
          placeholder="Describe the building, materials, landscape, light, mood..."
          placeholderTextColor="#888"
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
              <ActivityIndicator color="#ffffff" />
              <Text style={styles.buttonText}> RENDERING...</Text>
            </View>
          ) : (
            <Text style={styles.buttonText}>RENDER</Text>
          )}
        </TouchableOpacity>

        {message ? <Text style={styles.message}>{message}</Text> : null}
      </View>

      {resultImage ? (
        <View style={styles.resultCard}>
          <Text style={styles.resultTitle}>RESULT</Text>
          <Image
            source={{ uri: resultImage }}
            style={styles.resultImage}
            resizeMode="cover"
          />
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: "#10110F",
  },
  content: {
    minHeight: "100vh",
    padding: 24,
    paddingTop: 56,
    paddingBottom: 60,
  },
  brand: {
    color: "#FFFFFF",
    fontSize: 42,
    fontWeight: "900",
    textAlign: "center",
    letterSpacing: 2,
  },
  subtitle: {
    color: "#C9894B",
    fontSize: 17,
    fontWeight: "800",
    textAlign: "center",
    marginTop: 10,
    marginBottom: 30,
  },
  card: {
    backgroundColor: "#171B16",
    borderColor: "#6E8B3D",
    borderWidth: 1,
    borderRadius: 24,
    padding: 20,
  },
  label: {
    color: "#C9894B",
    fontSize: 13,
    fontWeight: "900",
    marginBottom: 10,
    marginTop: 8,
    letterSpacing: 1,
  },
  uploadButton: {
    backgroundColor: "#6E8B3D",
    borderRadius: 18,
    padding: 18,
    marginBottom: 18,
  },
  preview: {
    width: "100%",
    height: 260,
    borderRadius: 20,
    backgroundColor: "#10110F",
    marginBottom: 18,
  },
  input: {
    minHeight: 150,
    color: "#FFFFFF",
    backgroundColor: "#10110F",
    borderRadius: 18,
    padding: 16,
    fontSize: 16,
    textAlignVertical: "top",
  },
  renderButton: {
    backgroundColor: "#C9894B",
    borderRadius: 18,
    padding: 18,
    marginTop: 18,
  },
  disabled: {
    opacity: 0.65,
  },
  loadingRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
  },
  buttonText: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "900",
    textAlign: "center",
    letterSpacing: 1,
  },
  message: {
    color: "#FFFFFF",
    textAlign: "center",
    marginTop: 14,
    fontSize: 14,
  },
  resultCard: {
    marginTop: 26,
  },
  resultTitle: {
    color: "#C9894B",
    textAlign: "center",
    fontWeight: "900",
    marginBottom: 12,
  },
  resultImage: {
    width: "100%",
    height: 380,
    borderRadius: 24,
    backgroundColor: "#171B16",
  },
});