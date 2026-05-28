import React, { useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Image,
  ScrollView,
  StyleSheet,
} from "react-native";

const API_URL = "http://localhost:4242";

export default function HomeScreen() {
  const [prompt, setPrompt] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState("");
  const [loading, setLoading] = useState(false);
  const [thinking, setThinking] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function pickImage() {
    fileInputRef.current?.click();
  }

  function handleFileChange(event: any) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();

    reader.onload = () => {
      setImage(String(reader.result));
      setResult(null);
      setAnalysis("");
    };

    reader.readAsDataURL(file);
  }

  async function analyseImage() {
    if (!image) {
      alert("Import an image first");
      return;
    }

    setThinking(true);

    try {
      const response = await fetch(`${API_URL}/api/brain`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
          imageBase64: image,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        alert(data.detail || data.error || "Brain failed");
        return;
      }

      setAnalysis(data.analysis || "");
    } catch (error: any) {
      alert("Server connection failed: " + error.message);
    } finally {
      setThinking(false);
    }
  }

  async function renderImage() {
    if (!image) {
      alert("Import an image first");
      return;
    }

    setLoading(true);
    setResult(null);

    try {
      const response = await fetch(`${API_URL}/api/render`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
          imageBase64: image,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.imageBase64) {
        alert(data.detail || data.error || "Render failed");
        return;
      }

      setResult(`data:image/png;base64,${data.imageBase64}`);
    } catch (error: any) {
      alert("Server connection failed: " + error.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/jpg,image/webp"
        onChange={handleFileChange}
        style={{ display: "none" }}
      />

      <View style={styles.header}>
        <TouchableOpacity onPress={renderImage}>
          <View style={styles.logoCircle}>
            <Text style={styles.logoSymbol}>⌂</Text>
          </View>
        </TouchableOpacity>

        <Text style={styles.title}>MONOCULAR</Text>
        <Text style={styles.subtitle}>
          RATIONAL ARCHITECTURAL INTELLIGENCE
        </Text>
      </View>

      <View style={styles.panel}>
        <TextInput
          placeholder="Describe your architectural render..."
          placeholderTextColor="#8b949e"
          value={prompt}
          onChangeText={setPrompt}
          multiline
          style={styles.input}
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
  container: {
    flex: 1,
    backgroundColor: "#090d0f",
  },

  content: {
    paddingBottom: 80,
  },

  header: {
    alignItems: "center",
    paddingTop: 70,
    paddingBottom: 30,
  },

  logoCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: "#111816",
    borderWidth: 3,
    borderColor: "#a9bc82",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },

  logoSymbol: {
    color: "white",
    fontSize: 48,
    fontWeight: "900",
  },

  title: {
    color: "white",
    fontSize: 42,
    fontWeight: "900",
    letterSpacing: 4,
  },

  subtitle: {
    color: "#aab2bd",
    marginTop: 8,
    fontSize: 13,
    letterSpacing: 2,
  },

  panel: {
    marginHorizontal: 24,
    backgroundColor: "#161b22",
    borderRadius: 28,
    padding: 24,
    marginBottom: 40,
    borderWidth: 1,
    borderColor: "rgba(185, 201, 156, 0.22)",
  },

  input: {
    backgroundColor: "#0f141a",
    color: "white",
    borderRadius: 20,
    padding: 20,
    minHeight: 140,
    fontSize: 18,
    marginBottom: 20,
  },

  uploadButton: {
    backgroundColor: "#28343f",
    borderRadius: 18,
    paddingVertical: 18,
    alignItems: "center",
    marginBottom: 20,
  },

  uploadText: {
    color: "white",
    fontWeight: "800",
    letterSpacing: 1,
  },

  preview: {
    width: "100%",
    height: 320,
    borderRadius: 24,
    marginBottom: 20,
  },

  previewPlaceholder: {
    width: "100%",
    height: 320,
    borderRadius: 24,
    marginBottom: 20,
    backgroundColor: "#0f141a",
    alignItems: "center",
    justifyContent: "center",
  },

  previewTitle: {
    color: "white",
    fontSize: 22,
    fontWeight: "900",
    marginBottom: 10,
  },

  previewText: {
    color: "#8b949e",
    textAlign: "center",
    fontSize: 16,
  },

  brainButton: {
    backgroundColor: "#20291f",
    borderRadius: 18,
    paddingVertical: 18,
    alignItems: "center",
    marginBottom: 18,
  },

  brainText: {
    color: "#d7e6bd",
    fontWeight: "900",
    letterSpacing: 1,
  },

  analysisBox: {
    backgroundColor: "#0f141a",
    borderRadius: 20,
    padding: 18,
    marginBottom: 20,
  },

  analysisTitle: {
    color: "#d7e6bd",
    fontWeight: "900",
    marginBottom: 10,
  },

  analysisText: {
    color: "#dce3d8",
    lineHeight: 24,
  },

  renderButton: {
    backgroundColor: "#4b8b73",
    borderRadius: 20,
    paddingVertical: 20,
    alignItems: "center",
  },

  renderText: {
    color: "white",
    fontSize: 18,
    fontWeight: "900",
    letterSpacing: 1,
  },

  resultWrap: {
    marginTop: 24,
  },

  resultTitle: {
    color: "white",
    fontSize: 20,
    fontWeight: "900",
    marginBottom: 12,
    textAlign: "center",
  },

  resultImage: {
    width: "100%",
    height: 420,
    borderRadius: 24,
  },
});