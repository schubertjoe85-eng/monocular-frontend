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

export default function HomeScreen() {
  const [prompt, setPrompt] = useState("");
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [resultImage, setResultImage] = useState<string | null>(null);
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

      if (!picked.canceled && picked.assets?.[0]) {
        const asset = picked.assets[0];

        if (!asset.base64) {
          Alert.alert("Image error", "Could not read image.");
          return;
        }

        const mimeType = asset.mimeType || "image/jpeg";
        const base64Image = `data:${mimeType};base64,${asset.base64}`;

        setSelectedImage(base64Image);
        setResultImage(null);
      }
    } catch (error: any) {
      Alert.alert("Image failed", error.message || "Could not import image.");
    }
  }

  async function renderImage() {
    if (!selectedImage) {
      Alert.alert("No image", "Import a drawing or photo first.");
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
          imageBase64: selectedImage,
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.error || data.detail || "Render failed");
      }

      const output =
        data.image ||
        data.url ||
        data.result ||
        (data.imageBase64
          ? `data:image/png;base64,${data.imageBase64}`
          : null);

      if (!output) {
        throw new Error("No image returned.");
      }

      setResultImage(output);
    } catch (error: any) {
      Alert.alert("Render failed", error.message || "Could not render image.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Image
        source={require("../../assets/monocular-logo.jpeg")}
        style={styles.logo}
      />

      <Text style={styles.tagline}>Architectural Intelligence</Text>

      <View style={styles.card}>
        <TouchableOpacity style={styles.importButton} onPress={pickImage}>
          <Text style={styles.importText}>
            {selectedImage ? "CHANGE IMAGE / DRAWING" : "IMPORT IMAGE / DRAWING"}
          </Text>
        </TouchableOpacity>

        {selectedImage ? (
          <Image source={{ uri: selectedImage }} style={styles.previewImage} />
        ) : (
          <View style={styles.previewPlaceholder}>
            <Text style={styles.previewText}>IMAGE PREVIEW</Text>
          </View>
        )}

        <TextInput
          style={styles.input}
          placeholder="Describe the render: materials, light, landscape, mood..."
          placeholderTextColor="#8f9489"
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
              <ActivityIndicator />
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
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: "#0D0F0D",
  },
  content: {
    padding: 22,
    paddingBottom: 70,
  },
  logo: {
    width: 240,
    height: 150,
    resizeMode: "contain",
    alignSelf: "center",
    marginTop: 36,
    marginBottom: 6,
  },
  tagline: {
    color: "#C9894B",
    textAlign: "center",
    fontSize: 17,
    fontWeight: "800",
    letterSpacing: 0.8,
    marginBottom: 24,
  },
  card: {
    backgroundColor: "#121611",
    borderRadius: 28,
    padding: 16,
    borderWidth: 1,
    borderColor: "#2F3A2A",
  },
  importButton: {
    backgroundColor: "#252D20",
    borderRadius: 22,
    paddingVertical: 17,
    paddingHorizontal: 14,
    alignItems: "center",
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#6E8B3D",
  },
  importText: {
    color: "#F4F4F4",
    fontSize: 14,
    fontWeight: "900",
    letterSpacing: 1,
    textAlign: "center",
  },
  previewPlaceholder: {
    height: 210,
    borderRadius: 24,
    backgroundColor: "#171B16",
    borderWidth: 1,
    borderColor: "#2F3A2A",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  previewText: {
    color: "#8f9489",
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: 1.5,
  },
  previewImage: {
    width: "100%",
    height: 240,
    borderRadius: 24,
    backgroundColor: "#171B16",
    marginBottom: 16,
  },
  input: {
    minHeight: 125,
    backgroundColor: "#171B16",
    color: "#F4F4F4",
    borderRadius: 24,
    padding: 18,
    fontSize: 16,
    borderWidth: 1,
    borderColor: "#2F3A2A",
    textAlignVertical: "top",
    marginBottom: 18,
  },
  renderButton: {
    backgroundColor: "#6E8B3D",
    borderRadius: 24,
    paddingVertical: 20,
    alignItems: "center",
  },
  disabledButton: {
    opacity: 0.7,
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  renderText: {
    color: "#F4F4F4",
    fontSize: 19,
    fontWeight: "900",
    letterSpacing: 1.7,
    textAlign: "center",
  },
  resultWrap: {
    marginTop: 24,
  },
  resultTitle: {
    color: "#C9894B",
    textAlign: "center",
    fontSize: 15,
    fontWeight: "900",
    letterSpacing: 1.5,
    marginBottom: 12,
  },
  resultImage: {
    width: "100%",
    height: 360,
    borderRadius: 24,
    backgroundColor: "#171B16",
  },
});