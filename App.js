import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  Image,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
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

      if (!result.canceled) {
        const asset = result.assets[0];

        setSelectedImage(asset.uri);
        setImageBase64(asset.base64);
        setResultImage(null);
        setMessage("Image loaded");
      }
    } catch (err) {
      setMessage("Image upload failed");
    }
  }

  async function renderImage() {
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
        }),
      });

      const data = await response.json();

      if (data.image) {
        setResultImage(data.image);
        setMessage("Render complete");
      } else {
        setMessage(data.error || "Render failed");
      }
    } catch (err) {
      setMessage("Server connection failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.content}
    >
      <Text style={styles.logo}>MONOCULAR</Text>

      <Text style={styles.subtitle}>
        Rational Architectural Visualisation
      </Text>

      <View style={styles.card}>

        <TouchableOpacity
          style={styles.uploadButton}
          onPress={pickImage}
        >
          <Text style={styles.buttonText}>
            {selectedImage ? "CHANGE IMAGE" : "IMPORT IMAGE"}
          </Text>
        </TouchableOpacity>

        {selectedImage && (
          <Image
            source={{ uri: selectedImage }}
            style={styles.preview}
          />
        )}

        <TextInput
          style={styles.input}
          placeholder="Describe materials, light, landscape, atmosphere..."
          placeholderTextColor="#777"
          multiline
          value={prompt}
          onChangeText={setPrompt}
        />

        <TouchableOpacity
          style={styles.renderButton}
          onPress={renderImage}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>
              RENDER
            </Text>
          )}
        </TouchableOpacity>

        {message ? (
          <Text style={styles.message}>
            {message}
          </Text>
        ) : null}
      </View>

      {resultImage && (
        <View style={styles.resultContainer}>
          <Text style={styles.resultTitle}>
            RESULT
          </Text>

          <Image
            source={{ uri: resultImage }}
            style={styles.resultImage}
          />
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: "#10110F",
  },

  content: {
    padding: 24,
    paddingTop: 60,
    paddingBottom: 80,
  },

  logo: {
    color: "#FFFFFF",
    fontSize: 46,
    fontWeight: "900",
    textAlign: "center",
    letterSpacing: 3,
    marginBottom: 8,
  },

  subtitle: {
    color: "#C9894B",
    textAlign: "center",
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 30,
  },

  card: {
    backgroundColor: "#171B16",
    borderRadius: 24,
    padding: 20,
    borderWidth: 1,
    borderColor: "#6E8B3D",
  },

  uploadButton: {
    backgroundColor: "#6E8B3D",
    borderRadius: 18,
    padding: 18,
    marginBottom: 20,
  },

  preview: {
    width: "100%",
    height: 280,
    borderRadius: 20,
    marginBottom: 20,
  },

  input: {
    backgroundColor: "#10110F",
    color: "#FFFFFF",
    minHeight: 160,
    borderRadius: 18,
    padding: 16,
    fontSize: 16,
    textAlignVertical: "top",
  },

  renderButton: {
    backgroundColor: "#C9894B",
    borderRadius: 18,
    padding: 18,
    marginTop: 20,
  },

  buttonText: {
    color: "#FFFFFF",
    fontWeight: "900",
    textAlign: "center",
    fontSize: 18,
  },

  message: {
    color: "#FFFFFF",
    textAlign: "center",
    marginTop: 14,
  },

  resultContainer: {
    marginTop: 30,
  },

  resultTitle: {
    color: "#C9894B",
    textAlign: "center",
    fontWeight: "900",
    marginBottom: 12,
  },

  resultImage: {
    width: "100%",
    height: 420,
    borderRadius: 24,
  },
});