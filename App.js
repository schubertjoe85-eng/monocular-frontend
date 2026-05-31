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
    } catch (err) {
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
    } catch (err) {
      setMessage("Server connection failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Image
        source={require("./assets/monocular-logo.png")}
        style={styles.logoImage}
      />

      <Text style={styles.subtitle}>
        Rational Architectural Visualisation
      </Text>

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
          placeholderTextColor="#777"
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
    backgroundColor: "#0F120D",
  },
  content: {
    padding: 24,
    paddingTop: 44,
    paddingBottom: 80,
  },
  logoImage: {
    width: 280,
    height: 190,
    alignSelf: "center",
    resizeMode: "contain",
    marginBottom: 8,
  },
  subtitle: {
    color: "#D8A04D",
    textAlign: "center",
    fontSize: 18,
    fontWeight: "800",
    marginBottom: 30,
  },
  card: {
    backgroundColor: "#171B16",
    borderRadius: 24,
    padding: 20,
    borderWidth: 1,
    borderColor: "#7A8F4A",
  },
  label: {
    color: "#D8A04D",
    fontSize: 13,
    fontWeight: "900",
    letterSpacing: 1,
    marginBottom: 10,
    marginTop: 6,
  },
  uploadButton: {
    backgroundColor: "#6E8B3D",
    borderRadius: 18,
    padding: 18,
    marginBottom: 20,
  },
  previewImage: {
    width: "100%",
    height: 300,
    borderRadius: 20,
    marginBottom: 20,
    backgroundColor: "#0F120D",
  },
  input: {
    backgroundColor: "#10110F",
    color: "#FFFFFF",
    minHeight: 160,
    borderRadius: 18,
    padding: 16,
    fontSize: 16,
    textAlignVertical: "top",
    borderWidth: 1,
    borderColor: "#2B3323",
  },
  renderButton: {
    backgroundColor: "#C9894B",
    borderRadius: 18,
    padding: 18,
    marginTop: 20,
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
    fontWeight: "900",
    textAlign: "center",
    fontSize: 18,
    letterSpacing: 1,
  },
  message: {
    color: "#FFFFFF",
    textAlign: "center",
    marginTop: 14,
    fontSize: 14,
  },
  resultContainer: {
    marginTop: 30,
  },
  resultTitle: {
    color: "#D8A04D",
    textAlign: "center",
    fontWeight: "900",
    marginBottom: 12,
    letterSpacing: 1,
  },
  resultImage: {
    width: "100%",
    height: 420,
    borderRadius: 24,
    backgroundColor: "#171B16",
  },
});