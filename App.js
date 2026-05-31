import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Image,
  Alert,
} from "react-native";

const API_URL = "https://monocular-server.onrender.com";

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [resultImage, setResultImage] = useState("");
  const [loading, setLoading] = useState(false);

  async function renderImage() {
    if (!prompt.trim()) {
      Alert.alert("Please enter a prompt");
      return;
    }

    try {
      setLoading(true);

      const response = await fetch(`${API_URL}/render`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
        }),
      });

      const data = await response.json();

      if (data.image) {
        setResultImage(data.image);
      } else {
        Alert.alert("Render failed");
      }
    } catch (error) {
      Alert.alert("Server connection failed");
    }

    setLoading(false);
  }

  return (
    <ScrollView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.logo}>MONOCULAR</Text>

        <Text style={styles.subtitle}>
          AI Architectural Rendering
        </Text>

        <TextInput
          style={styles.input}
          placeholder="Describe your project..."
          placeholderTextColor="#999"
          value={prompt}
          onChangeText={setPrompt}
          multiline
        />

        <TouchableOpacity
          style={styles.button}
          onPress={renderImage}
        >
          <Text style={styles.buttonText}>
            {loading ? "RENDERING..." : "RENDER"}
          </Text>
        </TouchableOpacity>

        {resultImage ? (
          <Image
            source={{ uri: resultImage }}
            style={styles.image}
            resizeMode="cover"
          />
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#10110F",
  },
  content: {
    padding: 24,
    paddingTop: 60,
  },
  logo: {
    color: "#FFFFFF",
    fontSize: 40,
    fontWeight: "900",
    textAlign: "center",
  },
  subtitle: {
    color: "#C9894B",
    textAlign: "center",
    marginTop: 10,
    marginBottom: 30,
    fontSize: 16,
  },
  input: {
    backgroundColor: "#1B1D1A",
    color: "#FFFFFF",
    minHeight: 140,
    borderRadius: 20,
    padding: 20,
    fontSize: 16,
  },
  button: {
    backgroundColor: "#6E8B3D",
    borderRadius: 20,
    padding: 18,
    marginTop: 20,
    marginBottom: 20,
  },
  buttonText: {
    color: "#FFFFFF",
    fontWeight: "700",
    textAlign: "center",
    fontSize: 18,
  },
  image: {
    width: "100%",
    height: 350,
    borderRadius: 20,
    marginTop: 20,
  },
});