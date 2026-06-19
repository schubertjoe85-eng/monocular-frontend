import React, { useState, useRef } from "react";
import {
  ActivityIndicator,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Video } from "expo-av";
import * as ImagePicker from "expo-image-picker";
import * as MediaLibrary from "expo-media-library";
import * as FileSystem from "expo-file-system";

const API_URL = "https://monocular-server.onrender.com";

export default function App() {
  const [tab, setTab] = useState("image"); // "image" | "video"

  const [prompt, setPrompt] = useState("");
  const [selectedImage, setSelectedImage] = useState(null);
  const [imageBase64, setImageBase64] = useState(null);

  const [resultImage, setResultImage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const [videoLoading, setVideoLoading] = useState(false);
  const [videoStatus, setVideoStatus] = useState("");
  const [resultVideoUrl, setResultVideoUrl] = useState(null);

  const [message, setMessage] = useState("");
  const pollRef = useRef(null);

  async function pickImage() {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.9,
        base64: true,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const asset = result.assets[0];
        setSelectedImage(asset.uri);
        setImageBase64(asset.base64 || null);
        setResultImage(null);
        setResultVideoUrl(null);
        setMessage("Image loaded.");
      }
    } catch (error) {
      console.log("Image picker error:", error);
      setMessage("Image upload failed.");
    }
  }

  async function renderImage() {
    if (!prompt.trim() && !imageBase64) {
      setMessage("Add a

