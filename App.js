import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  Image,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from "react-native";
import * as ImagePicker from "expo-image-picker";

const API_URL = "https://monocular-server.onrender.com";

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [selectedImage, setSelectedImage] = useState(null);
  const [resultImage, setResultImage] = useState(null);
  const [loading, setLoading] = useState(false);

  const pickImage = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 1,
    });

    if (!result.canceled) {
      setSelectedImage(result.assets[0].uri);
    }
  };

  const renderImage = async () => {
    try {
      setLoading(true);

      const res = await fetch(`${API_URL}/render`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
          image: selectedImage,
        }),
      });

      const data = await res.json();

      if (data.image) {
        setResultImage(data.image);
      } else {
        Alert.alert("Render Failed");
      }
    } catch (err) {
      Alert.alert("Server Error");
    }

    setLoading(false);
  };

  return (
    <ScrollView style={styles.container}>
      <View style={styles.content}>
        <Image
          source={require("./assets/images/icon.png")}
          style={styles.logo}
        />

        <Text style={styles.title}>MONOCULAR</Text>

        <Text style={styles.subtitle}>
          AI Architectural Rendering
        </Text>

        <TouchableOpacity
          style={styles.button}
          onPress={pickImage}
        >
          <Text style={styles.buttonText}>
            Import Drawing / Image
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
          placeholder="Describe your project..."
          placeholderTextColor="#888"
          value={prompt}
          onChangeText={setPrompt}
          multiline
        />

        <TouchableOpacity
          style={styles.renderButton}
          onPress={renderImage}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>RENDER</Text>
          )}
        </TouchableOpacity>

        {resultImage && (
          <>
            <Text style={styles.resultTitle}>
              RESULT
            </Text>

            <Image
              source={{ uri: resultImage }}
              style={styles.result}
            />
          </>
        )}
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
    padding: 20,
    paddingTop: 50,
  },
  logo: {
    width: 120,
    height: 120,
    alignSelf: "center",
    marginBottom: 20,
  },
  title: {
    color: "#FFFFFF",
    fontSize: 34,
    fontWeight: "900",
    textAlign: "center",
  },
  subtitle: {
    color: "#C9894B",
    fontSize: 16,
    textAlign: "center",
    marginBottom: 30,
  },
  button: {
    backgroundColor: "#6E8B3D",
    padding: 16,
    borderRadius: 16,
    marginBottom: 16,
  },
  renderButton: {
    backgroundColor: "#C9894B",
    padding: 16,
    borderRadius: 16,
    marginTop: 10,
  },
  buttonText: {
    color: "#FFFFFF",
    fontWeight: "bold",
    textAlign: "center",
  },
  preview: {
    width: "100%",
    height: 250,
    borderRadius: 16,
    marginBottom: 16,
  },
  input: {
    backgroundColor: "#1B1D1A",
    color: "#FFFFFF",
    borderRadius: 16,
    padding: 16,
    minHeight: 120,
  },
  resultTitle: {
    color: "#C9894B",
    fontSize: 18,
    fontWeight: "bold",
    textAlign: "center",
    marginTop: 24,
    marginBottom: 12,
  },
  result: {
    width: "100%",
    height: 400,
    borderRadius: 16,
  },
});