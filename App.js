import React, { useEffect, useState } from "react";
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
import * as ImagePicker from "expo-image-picker";
import * as MediaLibrary from "expo-media-library";
import * as FileSystem from "expo-file-system";
import { useIAP } from "expo-iap";

const API_URL = "https://monocular-server.onrender.com";
const PRODUCT_ID = "monocular_pro_monthly";

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [selectedImage, setSelectedImage] = useState(null);
  const [imageBase64, setImageBase64] = useState(null);
  const [resultImage, setResultImage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [subscribed, setSubscribed] = useState(false);
  const [checkingSub, setCheckingSub] = useState(true);
  const [buying, setBuying] = useState(false);

  const {
    connected,
    products,
    currentPurchase,
    currentPurchaseError,
    fetchProducts,
    requestPurchase,
    finishTransaction,
  } = useIAP();

  useEffect(() => {
    setCheckingSub(false);
  }, []);

  useEffect(() => {
    async function completePurchase() {
      if (!currentPurchase) return;

      try {
        await finishTransaction({
          purchase: currentPurchase,
          isConsumable: false,
        });

        setSubscribed(true);
        setMessage("Subscription active.");
      } catch (error) {
        console.log("Finish transaction error:", error);
        setSubscribed(true);
        setMessage("Subscription active.");
      } finally {
        setBuying(false);
      }
    }

    completePurchase();
  }, [currentPurchase]);

  useEffect(() => {
    if (currentPurchaseError) {
      console.log("Purchase error:", currentPurchaseError);
      setBuying(false);
      setMessage("Purchase cancelled or failed.");
    }
  }, [currentPurchaseError]);

  async function buySubscription() {
    try {
      setBuying(true);
      setMessage("Opening Apple subscription...");

      if (!connected) {
        setBuying(false);
        setMessage("Store connection not ready. Try again in a moment.");
        return;
      }

      await fetchProducts({
        skus: [PRODUCT_ID],
        type: "subs",
      });

      await requestPurchase({
        type: "subs",
        request: {
          ios: {
            sku: PRODUCT_ID,
          },
        },
      });
    } catch (error) {
      console.log("Purchase start error:", error);
      setBuying(false);
      setMessage(error?.message || "Could not start subscription.");
    }
  }

  async function restoreSubscription() {
    setMessage("Restore purchase will activate after Apple confirms the subscription.");
  }

  async function pickImage() {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.8,
        base64: true,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const asset = result.assets[0];
        setSelectedImage(asset.uri);
        setImageBase64(asset.base64 || null);
        setResultImage(null);
        setMessage("Image loaded.");
      }
    } catch (error) {
      console.log("Image picker error:", error);
      setMessage("Image upload failed.");
    }
  }

  async function renderImage() {
    if (!subscribed) {
      setMessage("Subscribe to render.");
      return;
    }

    if (!prompt.trim() && !imageBase64) {
      setMessage("Add a brief or upload an image first.");
      return;
    }

    try {
      setLoading(true);
      setMessage("Rendering...");
      setResultImage(null);

      const response = await fetch(`${API_URL}/render`, {