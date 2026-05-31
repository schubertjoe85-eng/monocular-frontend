import React from "react";
import { View, Text, StyleSheet } from "react-native";

export default function App() {
  return (
    <View style={styles.page}>
      <Text style={styles.title}>MONOCULAR</Text>
      <Text style={styles.subtitle}>AI Architectural Rendering</Text>
      <Text style={styles.note}>App is live.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    minHeight: "100vh",
    backgroundColor: "#10110F",
    alignItems: "center",
    justifyContent: "center",
    padding: 30
  },
  title: {
    color: "#FFFFFF",
    fontSize: 42,
    fontWeight: "900",
    letterSpacing: 2
  },
  subtitle: {
    color: "#C9894B",
    fontSize: 18,
    marginTop: 14,
    fontWeight: "800",
    textAlign: "center"
  },
  note: {
    color: "#6E8B3D",
    fontSize: 16,
    marginTop: 28,
    fontWeight: "700"
  }
});
