import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Image,
  ScrollView,
  StyleSheet,
  Alert,
} from "react-native";
import * as ImagePicker from "expo-image-picker";

const API_URL = "https://monocular-server.onrender.com";

export default function HomeScreen() {
  const [prompt, setPrompt] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState("");
  const [loading, setLoading] = useState(false);
  const [thinking, setThinking] = useState(false);

  async function pickImage() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission needed", "Please allow photo access.");
      return;
    }

    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
      base64: true,
    });

    if (!picked.canceled && picked.assets?.[0]?.base64) {
      setImage(`data:image/jpeg;base64,${picked.assets[0].base64}`);
      setResult(null);
      setAnalysis("");
    }
  }

  async function analyseImage() {
    if (!image) return Alert.alert("No image", "Import an image first.");

    try {
      setThinking(true);
      const res = await fetch(`${API_URL}/api/brain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, imageBase64: image }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.detail || data.error);

      setAnalysis(data.analysis || "");
    } catch (e: any) {
      Alert.alert("Server connection failed", e.message || "Analysis failed");
    } finally {
      setThinking(false);
    }
  }

  async function renderImage() {
    if (!image) return Alert.alert("No image", "Import an image first.");

    try {
      setLoading(true);
      const res = await fetch(`${API_URL}/api/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, imageBase64: image }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.detail || data.error);

      setResult(`data:image/png;base64,${data.imageBase64}`);
    } catch (e: any) {
      Alert.alert("Server connection failed", e.message || "Render failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <View style={styles.logoWrap}>
        <View style={styles.logoCircle}>
          <Text style={styles.logoIcon}>⌂</Text>
        </View>
        <Text style={styles.logoText}>MONOCULAR</Text>
        <Text style={styles.logoSub}>RATIONAL ARCHITECTURAL INTELLIGENCE</Text>
      </View>

      <View style={styles.card}>
        <TextInput
          style={styles.input}
          placeholder="Describe your architectural render..."
          placeholderTextColor="#9aa3b2"
          value={prompt}
          onChangeText={setPrompt}
          multiline
        />

        <TouchableOpacity style={styles.uploadButton} onPress={pickImage}>
          <Text style={styles.uploadText}>
            {image ? "IMAGE LOADED — CHANGE IMAGE" : "IMPORT IMAGE / DRAWING"}
          </Text>
        </TouchableOpacity>

        {image ? (
          <Image source={{ uri: image }} style={styles.preview} />
        ) : (
          <View style={styles.previewPlaceholder}>
            <Text style={styles.previewTitle}>IMAGE PREVIEW</Text>
            <Text style={styles.previewText}>
              Upload sketches, drawings, elevations or renders.
            </Text>
          </View>
        )}

        <TouchableOpacity style={styles.brainButton} onPress={analyseImage}>
          <Text style={styles.brainText}>
            {thinking ? "THINKING..." : "ANALYSE WITH MONOCULAR BRAIN"}
          </Text>
        </TouchableOpacity>

        {analysis ? (
          <View style={styles.analysisBox}>
            <Text style={styles.analysisTitle}>MONOCULAR BRAIN</Text>
            <Text style={styles.analysisText}>{analysis}</Text>
          </View>
        ) : null}

        <TouchableOpacity style={styles.renderButton} onPress={renderImage}>
          <Text style={styles.renderText}>
            {loading ? "RENDERING..." : "GENERATE AI RENDER"}
          </Text>
        </TouchableOpacity>

        {result ? (
          <View style={styles.resultWrap}>
            <Text style={styles.resultTitle}>RESULT</Text>
            <Image source={{ uri: result }} style={styles.resultImage} />
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#07090d" },
  content: { padding: 22, paddingBottom: 60 },

  logoWrap: { alignItems: "center", marginTop: 28, marginBottom: 24 },
  logoCircle: {
    width: 74,
    height: 74,
    borderRadius: 37,
    borderWidth: 2,
    borderColor: "#b9c99c",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#11151a",
  },
  logoIcon: { color: "white", fontSize: 42, fontWeight: "900" },
  logoText: {
    color: "white",
    fontSize: 34,
    fontWeight: "900",
    letterSpacing: 5,
    marginTop: 14,
  },
  logoSub: {
    color: "#b9c99c",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 2,
    marginTop: 6,
  },

  card: {
    borderWidth: 1,
    borderColor: "#283241",
    backgroundColor: "#0b0f16",
    borderRadius: 28,
    padding: 18,
  },
  input: {
    minHeight: 110,
    backgroundColor: "#0f1522",
    borderRadius: 22,
    padding: 18,
    color: "white",
    fontSize: 16,
    textAlignVertical: "top",
    marginBottom: 18,
  },
  uploadButton: {
    backgroundColor: "#1d2a3b",
    paddingVertical: 18,
    borderRadius: 22,
    alignItems: "center",
    marginBottom: 18,
  },
  uploadText: {
    color: "white",
    fontSize: 14,
    fontWeight: "900",
    letterSpacing: 1,
    textAlign: "center",
  },
  preview: {
    width: "100%",
    height: 220,
    borderRadius: 24,
    marginBottom: 20,
  },
  previewPlaceholder: {
    width: "100%",
    height: 160,
    borderRadius: 24,
    marginBottom: 20,
    backgroundColor: "#0f141a",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#303b47",
  },
  previewTitle: {
    color: "white",
    fontSize: 18,
    fontWeight: "900",
    letterSpacing: 2,
    marginBottom: 10,
  },
  previewText: { color: "#b8b8b8", fontSize: 15, textAlign: "center" },
  brainButton: {
    backgroundColor: "#101b10",
    paddingVertical: 20,
    borderRadius: 22,
    alignItems: "center",
    marginBottom: 18,
  },
  brainText: {
    color: "#c3d4aa",
    fontSize: 15,
    fontWeight: "900",
    letterSpacing: 1.5,
    textAlign: "center",
  },
  analysisBox: {
    backgroundColor: "#101522",
    borderRadius: 20,
    padding: 18,
    marginBottom: 18,
  },
  analysisTitle: {
    color: "white",
    fontSize: 18,
    fontWeight: "900",
    marginBottom: 10,
  },
  analysisText: { color: "#d8dde8", fontSize: 14, lineHeight: 21 },
  renderButton: {
    backgroundColor: "#3f604f",
    paddingVertical: 22,
    borderRadius: 24,
    alignItems: "center",
  },
  renderText: {
    color: "white",
    fontSize: 20,
    fontWeight: "900",
    letterSpacing: 2,
    textAlign: "center",
  },
  resultWrap: { marginTop: 24 },
  resultTitle: {
    color: "white",
    fontSize: 18,
    fontWeight: "900",
    textAlign: "center",
    marginBottom: 12,
  },
  resultImage: {
    width: "100%",
    height: 240,
    borderRadius: 24,
  },
});