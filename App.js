import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Image,
} from "react-native";

const API_URL = "https://monocular-server.onrender.com";

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [resultImage, setResultImage] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  async function renderImage() {
    if (!prompt.trim()) {
      setMessage("Enter a prompt first.");
      return;
    }

    try {
      setLoading(true);
      setMessage("Rendering...");
      setResultImage("");

      const response = await fetch(`${API_URL}/render`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ prompt })
      });

      const data = await response.json();

      if (data.image) {
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

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Text style={styles.brand}>MONOCULAR</Text>
      <Text style={styles.subtitle}>AI Architectural Rendering</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Project brief</Text>

        <TextInput
          style={styles.input}
          placeholder="Describe the building, mood, materials, light, landscape..."
          placeholderTextColor="#8B8B8B"
          value={prompt}
          onChangeText={setPrompt}
          multiline
        />

        <TouchableOpacity
          style={[styles.button, loading ? styles.buttonDisabled : null]}
          onPress={renderImage}
          disabled={loading}
        >
          <Text style={styles.buttonText}>
            {loading ? "RENDERING..." : "RENDER"}
          </Text>
        </TouchableOpacity>

        {message ? <Text style={styles.message}>{message}</Text> : null}
      </View>

      {resultImage ? (
        <View style={styles.resultCard}>
          <Text style={styles.resultTitle}>RESULT</Text>
          <Image source={{ uri: resultImage }} style={styles.resultImage} />
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: "#10110F"
  },
  content: {
    minHeight: "100vh",
    padding: 24,
    paddingTop: 60,
    paddingBottom: 60
  },
  brand: {
    color: "#FFFFFF",
    fontSize: 42,
    fontWeight: "900",
    textAlign: "center",
    letterSpacing: 2
  },
  subtitle: {
    color: "#C9894B",
    fontSize: 17,
    fontWeight: "800",
    textAlign: "center",
    marginTop: 10,
    marginBottom: 32
  },
  card: {
    backgroundColor: "#171B16",
    borderColor: "#6E8B3D",
    borderWidth: 1,
    borderRadius: 24,
    padding: 20
  },
  label: {
    color: "#C9894B",
    fontSize: 14,
    fontWeight: "900",
    marginBottom: 10,
    letterSpacing: 1
  },
  input: {
    minHeight: 150,
    color: "#FFFFFF",
    backgroundColor: "#10110F",
    borderRadius: 18,
    padding: 16,
    fontSize: 16,
    textAlignVertical: "top"
  },
  button: {
    backgroundColor: "#6E8B3D",
    borderRadius: 18,
    padding: 18,
    marginTop: 18
  },
  buttonDisabled: {
    opacity: 0.65
  },
  buttonText: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "900",
    textAlign: "center",
    letterSpacing: 1
  },
  message: {
    color: "#FFFFFF",
    textAlign: "center",
    marginTop: 14,
    fontSize: 14
  },
  resultCard: {
    marginTop: 26
  },
  resultTitle: {
    color: "#C9894B",
    textAlign: "center",
    fontWeight: "900",
    marginBottom: 12
  },
  resultImage: {
    width: "100%",
    height: 380,
    borderRadius: 24,
    backgroundColor: "#171B16"
  }
});
