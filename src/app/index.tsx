import React, { useState } from "react";
import {
  Alert,
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

export default function HomeScreen() {
  const [prompt, setPrompt] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);

  async function pickImage() {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permission.granted) {
        Alert.alert("Permission needed", "Please allow photo access.");
        return;
      }

      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        base64: true,
        quality: 0.7,
      });

      if (picked.canceled) return;

      const asset = picked.assets[0];

      if (!asset.base64) {
        Alert.alert("Image error", "Could not read image.");
        return;
      }

      const base64Image = `data:image/jpeg;base64,${asset.base64}`;
      setImage(base64Image);
      setResult(null);
    } catch (err: any) {
      Alert.alert("Image failed", err.message || "Could not import image.");
    }
  }

  async function renderImage() {
    if (!image) {
      Alert.alert("No image", "Import an image first.");
      return;
    }

    try {
      setRendering(true);
      setResult(null);

      const res = await fetch(`${API_URL}/api/render`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: prompt || "Refined architectural render with natural light.",
          imageBase64: image,
          image: image,
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.detail || data.error || "Render failed");
      }

      const output =
        data.image ||
        data.imageBase64 ||
        data.url ||
        data.result ||
        null;

      if (!output) {
        throw new Error("No image returned from server.");
      }

      setResult(output.startsWith("data:") ? output : `data:image/png;base64,${output}`);
    } catch (err: any) {
      Alert.alert("Render failed", err.message || "Server error");
    } finally {
      setRendering(false);
    }
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Text style={styles.logo}>◐</Text>
      <Text style={styles.title}>Monocular</Text>
      <Text style={styles.subtitle}>
        Refined architectural rendering from drawings and site images.
      </Text>

      <TouchableOpacity style={styles.uploadButton} onPress={pickImage}>
        <Text style={styles.buttonText}>Import image</Text>
      </TouchableOpacity>

      {image && (
        <>
          <Text style={styles.label}>Input</Text>
          <Image source={{ uri: image }} style={styles.image} />
        </>
      )}

      <TextInput
        style={styles.input}
        placeholder="Describe the render..."
        placeholderTextColor="#b8b8a8"
        value={prompt}
        onChangeText={setPrompt}
        multiline
      />

      <TouchableOpacity
        style={[styles.renderButton, rendering && styles.disabledButton]}
        onPress={renderImage}
        disabled={rendering}
      >
        <Text style={styles.buttonText}>
          {rendering ? "Rendering..." : "Render"}
        </Text>
      </TouchableOpacity>

      {result && (
        <>
          <Text style={styles.label}>Result</Text>
          <Image source={{ uri: result }} style={styles.resultImage} />
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: "#101710",
  },
  content: {
    padding: 22,
    paddingTop: 60,
  },
  logo: {
    color: "#d7a356",
    fontSize: 54,
    fontWeight: "900",
    textAlign: "center",
  },
  title: {
    color: "white",
    fontSize: 34,
    fontWeight: "900",
    textAlign: "center",
    marginTop: 8,
  },
  subtitle: {
    color: "#d8d8c8",
    fontSize: 15,
    textAlign: "center",
    lineHeight: 22,
    marginTop: 10,
    marginBottom: 26,
  },
  uploadButton: {
    backgroundColor: "#2f3f25",
    borderRadius: 24,
    paddingVertical: 17,
    alignItems: "center",
    marginBottom: 18,
  },
  renderButton: {
    backgroundColor: "#d7a356",
    borderRadius: 24,
    paddingVertical: 18,
    alignItems: "center",
    marginTop: 18,
    marginBottom: 24,
  },
  disabledButton: {
    opacity: 0.55,
  },
  buttonText: {
    color: "white",
    fontSize: 16,
    fontWeight: "900",
  },
  label: {
    color: "#d7a356",
    fontSize: 14,
    fontWeight: "900",
    marginBottom: 8,
    marginTop: 10,
  },
  image: {
    width: "100%",
    height: 260,
    borderRadius: 24,
    backgroundColor: "#1b2418",
    marginBottom: 18,
  },
  resultImage: {
    width: "100%",
    height: 360,
    borderRadius: 24,
    backgroundColor: "#1b2418",
    marginBottom: 30,
  },
  input: {
    minHeight: 120,
    backgroundColor: "#172216",
    borderColor: "#425235",
    borderWidth: 1,
    borderRadius: 24,
    color: "white",
    padding: 18,
    fontSize: 16,
    textAlignVertical: "top",
  },
});