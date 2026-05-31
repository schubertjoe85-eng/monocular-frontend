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

const API_URL = "https://monocular-server.onrender.com";

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [selectedImage, setSelectedImage] = useState(null);
  const [imageBase64, setImageBase64] = useState(null);
  const [resultImage, setResultImage] = useState(null);
  const [loading, setLoading] = useState(false);

  async function pickImage() {
    try {
      if (Platform.OS !== "web") {
        const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

        if (!permission.granted) {
          Alert.alert("Permission needed", "Please allow photo access.");
          return;
        }
      }

      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.75,
        base64: true,
      });

      if (!picked.canceled && picked.assets && picked.assets.length > 0) {
        const asset = picked.assets[0];
        setSelectedImage(asset.uri);
        setImageBase64(asset.base64 || null);
        setResultImage(null);
      }
    } catch (error) {
      Alert.alert("Image error", "Could not pick image.");
    }
  }

  async function renderImage() {
    if (!prompt.trim() && !imageBase64) {
      Alert.alert("Missing input", "Add a prompt or upload an image first.");
      return;
    }

    try {
      setLoading(true);
      setResultImage(null);

      const res = await fetch(`${API_URL}/render`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
          selectedImage,
          imageBase64,
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.error || data.detail || "Render failed");
      }

      if (data.image) {
        setResultImage(data.image);
      } else {
        Alert.alert("Render failed", "No image returned.");
      }
    } catch (error) {
      Alert.alert("Render failed", error.message || "Server error.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Image
        source={require("./assets/images/icon.png")}
        style={styles.logo}
        resizeMode="contain"
      />

      <Text style={styles.title}>MONOCULAR</Text>

      <Text style={styles.subtitle}>AI Architectural Rendering</Text>

      <TouchableOpacity style={styles.uploadButton} onPress={pickImage}>
        <Text style={styles.uploadText}>
          {selectedImage ? "CHANGE IMAGE / DRAWING" : "IMPORT IMAGE / DRAWING"}
        </Text>
      </TouchableOpacity>

      {selectedImage ? (
        <Image source={{ uri: selectedImage }} style={styles.previewImage} />
      ) : null}

      <TextInput
        style={styles.input}
        placeholder="Describe your project..."
        placeholderTextColor="#9A9A9A"
        value={prompt}
        onChangeText={setPrompt}
        multiline
      />

      <TouchableOpacity
        style={[styles.renderButton, loading && styles.disabledButton]}
        onPress={renderImage}
        disabled={loading}
      >
        {loading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color="#ffffff" />
            <Text style={styles.renderText}> RENDERING...</Text>
          </View>
        ) : (
          <Text style={styles.renderText}>RENDER</Text>
        )}
      </TouchableOpacity>

      {resultImage ? (
        <View style={styles.resultWrap}>
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
    backgroundColor: "#10110F",
  },
  content: {
    padding: 22,
    paddingTop: 52,
    paddingBottom: 60,
  },
  logo: {
    width: 120,
    height: 120,
    alignSelf: "center",
    marginBottom: 12,
  },
  title: {
    color: "#FFFFFF",
    fontSize: 34,
    fontWeight: "900",
    textAlign: "center",
    letterSpacing: 2,
  },
  subtitle: {
    color: "#C9894B",
    textAlign: "center",
    fontSize: 16,
    fontWeight: "800",
    marginTop: 8,
    marginBottom: 28,
  },
  uploadButton: {
    backgroundColor: "#22251F",
    borderColor: "#6E8B3D",
    borderWidth: 2,
    borderRadius: 22,
    padding: 16,
    marginBottom: 16,
  },
  uploadText: {
    color: "#F4F4F4",
    textAlign: "center",
    fontWeight: "900",
    letterSpacing: 1,
  },
  previewImage: {
    width: "100%",
    height: 260,
    borderRadius: 24,
    backgroundColor: "#171B16",
    marginBottom: 18,
  },
  input: {
    minHeight: 130,
    backgroundColor: "#1B1D1A",
    color: "#FFFFFF",
    borderRadius: 24,
    padding: 18,
    fontSize: 17,
    textAlignVertical: "top",
    marginBottom: 18,
  },
  renderButton: {
    backgroundColor: "#6E8B3D",
    borderRadius: 24,
    padding: 20,
  },
  disabledButton: {
    opacity: 0.7,
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  renderText: {
    color: "#FFFFFF",
    fontSize: 19,
    fontWeight: "900",
    textAlign: "center",
    letterSpacing: 1.5,
  },
  resultWrap: {
    marginTop: 26,
  },
  resultTitle: {
    color: "#C9894B",
    textAlign: "center",
    fontSize: 15,
    fontWeight: "900",
    marginBottom: 12,
  },
    resultImage: {
    width: "100%",
    height: 360,
    borderRadius: 24,
    backgroundColor: "#171B16",
  },
});