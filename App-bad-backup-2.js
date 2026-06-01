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
    hasActiveSubscriptions,
  } = useIAP();

  useEffect(() => {
    async function setupIap() {
      try {
        if (!connected) {
          setCheckingSub(false);
          return;
        }

        await fetchProducts({
          skus: [PRODUCT_ID],
          type: "subs",
        });

        const active = await hasActiveSubscriptions([PRODUCT_ID]);
        setSubscribed(Boolean(active));
      } catch (error) {
        console.log("IAP setup error:", error);
      } finally {
        setCheckingSub(false);
      }
    }

    setupIap();
  }, [connected]);

  useEffect(() => {
    async function completePurchase() {
      if (!currentPurchase) return;

      try {
        await finishTransaction({
          purchase: currentPurchase,
          isConsumable: false,
        });

        const active = await hasActiveSubscriptions([PRODUCT_ID]);
        setSubscribed(Boolean(active));
        setMessage(active ? "Subscription active." : "Purchase completed.");
      } catch (error) {
        console.log("Finish transaction error:", error);
        setMessage("Purchase completed, but verification failed.");
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
        setMessage("Store connection not ready. Try again in a moment.");
        setBuying(false);
        return;
      }

      await fetchProducts({
        skus: [PRODUCT_ID],
        type: "subs",
      });

      await requestPurchase({
        request: {
          ios: {
            sku: PRODUCT_ID,
          },
        },
        type: "subs",
      });
    } catch (error) {
      console.log("Purchase start error:", error);
      setBuying(false);
      setMessage(error?.message || "Could not start subscription.");
    }
  }

  async function restoreSubscription() {
    try {
      setCheckingSub(true);
      setMessage("Checking subscription...");

      const active = await hasActiveSubscriptions([PRODUCT_ID]);
      setSubscribed(Boolean(active));
      setMessage(active ? "Subscription restored." : "No active subscription found.");
    } catch (error) {
      console.log("Restore error:", error);
      setMessage("Restore failed.");
    } finally {
      setCheckingSub(false);
    }
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
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
          imageBase64,
          mode: "render",
          subscriptionActive: true,
        }),
      });

      const data = await response.json();

      if (data.image) {
        setResultImage(data.image);
        setMessage("Render complete.");
      } else {
        setMessage(data.error || "Render failed.");
      }
    } catch (error) {
      console.log("Render error:", error);
      setMessage("Server connection failed.");
    } finally {
      setLoading(false);
    }
  }

  async function saveImage() {
    if (!resultImage) {
      setMessage("No image to save.");
      return;
    }

    try {
      const permission = await MediaLibrary.requestPermissionsAsync();

      if (!permission.granted) {
        setMessage("Photos permission required.");
        return;
      }

      let fileUri = resultImage;

      if (resultImage.startsWith("data:image")) {
        const base64 = resultImage.split(",")[1];
        fileUri = `${FileSystem.cacheDirectory}monocular-render-${Date.now()}.png`;

        await FileSystem.writeAsStringAsync(fileUri, base64, {
          encoding: FileSystem.EncodingType.Base64,
        });
      }

      const asset = await MediaLibrary.createAssetAsync(fileUri);
      await MediaLibrary.createAlbumAsync("Monocular", asset, false);

      setMessage("Saved to Photos.");
    } catch (error) {
      console.log("Save image error:", error);
      setMessage("Failed to save image.");
    }
  }

  if (checkingSub) {
    return (
      <View style={styles.pageCenter}>
        <LogoMark />
        <ActivityIndicator color="#FFFFFF" />
        <Text style={styles.message}>Checking subscription...</Text>
      </View>
    );
  }

  if (!subscribed) {
    const product = products && products.length > 0 ? products[0] : null;
    const price = product?.localizedPrice || "$19.99/month";

    return (
      <ScrollView style={styles.page} contentContainerStyle={styles.content}>
        <LogoMark />

        <Text numberOfLines={1} adjustsFontSizeToFit style={styles.title}>
          MONOCULAR
        </Text>

        <Text style={styles.subtitle}>AI Architectural Rendering</Text>

        <View style={styles.card}>
          <Text style={styles.paywallTitle}>Monocular Monthly</Text>

          <Text style={styles.paywallText}>
            Subscribe to generate architectural visualisations from sketches,
            drawings and photos.
          </Text>

          <Text style={styles.price}>{price}</Text>

         
            <TouchableOpacity
  style={[styles.renderButton, buying ? styles.disabled : null]}
  onPress={buySubscription}
  disabled={buying}
>{buying ? (
  <View style={styles.loadingRow}>
    <ActivityIndicator color="#FFFFFF" />
    <Text style={styles.buttonText}> OPENING...</Text>
  </View>
) : (
  <Text style={styles.buttonText}>SUBSCRIBE</Text>
)}
</TouchableOpacity>
