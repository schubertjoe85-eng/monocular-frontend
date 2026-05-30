import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Image,
  ScrollView,
  Alert,
  StyleSheet,
} from "react-native";

const API_URL = "https://monocular-server.onrender.com";

export default function HomeScreen() {
  const [prompt, setPrompt] = useState("");
  const [imageUrl, setImageUrl] = useState("");

  async function renderImage() {
    try {
      const res = await fetch(`${API_URL}/render`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
        }),
      });

      const data = await res.json();

      if (data.image) {
        setImageUrl(data.image);
      } else {
        Alert.alert("Render Failed", "No image returned.");
      }
    } catch (err) {
      Alert.alert("Server Error", "Could not connect to Monocular server.");
    }
  }

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.logo}>MONOCULAR</Text>

      <Text style={styles.subtitle}>
        AI Architectural Rendering
      </Text>

      <TextInput
        style={styles.input}
        placeholder="Describe your project..."
        placeholderTextColor="#888"
        value={prompt}
        onChangeText={setPrompt}
        multiline
      />

      <TouchableOpacity
        style={styles.button}
        onPress={renderImage}
      >
        <Text style={styles.buttonText}>RENDER</Text>
      </TouchableOpacity>

      {imageUrl ? (
        <Image
          source={{ uri: imageUrl }}
          style={styles.image}
          resizeMode="cover"
        />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#111",
    padding: 20,
  },
  logo: {
    color: "white",
    fontSize: 42,
    fontWeight: "900",
    textAlign: "center",
    marginTop: 60,
  },
  subtitle: {
    color: "#556B2F",
    textAlign: "center",
    marginTop: 10,
    marginBottom: 30,
    fontSize: 16,
  },
  input: {
    backgroundColor: "#1f1f1f",
    color: "white",
    minHeight: 140,
    borderRadius: 20,
    padding: 20,
    fontSize: 16,
  },
  button: {
    backgroundColor: "#556B2F",
    borderRadius: 20,
    padding: 18,
    marginTop: 20,
    marginBottom: 20,
  },
  buttonText: {
    color: "white",
    fontWeight: "700",
    textAlign: "center",
    fontSize: 18,
  },
  image: {
    width: "100%",
    height: 350,
    borderRadius: 20,
    marginBottom: 40,
  },
});