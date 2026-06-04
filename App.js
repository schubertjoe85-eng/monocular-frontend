import React, { useEffect, useState } from "react";
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
import * as MediaLibrary from "expo-media-library";
import * as FileSystem from "expo-file-system";
import {
  useIAP,
  fetchProducts,
  requestPurchase,
  finishTransaction,
} from "expo-iap";

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
    getActiveSubscriptions,
    hasActiveSubscriptions,
  } = useIAP();

  useEffect(() => {
    async function setupIap() {
      try {
        if (!connected) return;

        await fetchProducts({
          skus: [PRODUCT_ID],
          type: "subs",
        });

        const active = await hasActiveSubscriptions([PRODUCT_ID]);
        setSubscribed(Boolean(active));
      } catch (error) {
        setMessage("Subscription check failed.");
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

        if (active) {
          setMessage("Subscription active.");
        }
      } catch (error) {
        setMessage("Purchase completed, but verification failed.");
      } finally {
        setBuying(false);
      }
    }

    completePurchase();
  }, [currentPurchase]);

  useEffect(() => {
    if (currentPurchaseError) {
      setBuying(false);
      setMessage("Purchase cancelled or failed.");
    }
  }, [currentPurchaseError]);

  async function buySubscription() {
    try {
      setBuying(true);
      setMessage("Opening Apple subscription...");

      await requestPurchase({
        request: {
          ios: {
            sku: PRODUCT_ID,
          },
        },
        type: "subs",
      });
    } catch (error) {
      setBuying(false);
      setMessage("Could not start subscription.");
    }
  }

  async function restoreSubscription() {
    try {
      setCheckingSub(true);
      const active = await hasActiveSubscriptions([PRODUCT_ID]);
      setSubscribed(Boolean(active));
      setMessage(active ? "Subscription restored." : "No active subscription found.");
    } catch {
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
    } catch {
      setMessage("Image upload failed.");
    }
  }

  async function renderImage() {

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
        }),
      });

      const data = await response.json();

      if (data.image) {
        setResultImage(data.image);
        setMessage("Render complete.");
      } else {
        setMessage(data.error || "Render failed.");
      }
    } catch {
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
    } catch {
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
          >
            {buying ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator color="#FFFFFF" />
                <Text style={styles.buttonText}> OPENING...</Text>
              </View>
            ) : (
              <Text style={styles.buttonText}>SUBSCRIBE</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity style={styles.restoreButton} onPress={restoreSubscription}>
            <Text style={styles.restoreText}>RESTORE PURCHASE</Text>
          </TouchableOpacity>

          <Text style={styles.smallText}>
            Payment is charged to your Apple ID. Subscription renews automatically
            unless cancelled at least 24 hours before renewal.
          </Text>

          {message ? <Text style={styles.message}>{message}</Text> : null}
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <LogoMark />

      <Text numberOfLines={1} adjustsFontSizeToFit style={styles.title}>
        MONOCULAR
      </Text>

      <Text style={styles.subtitle}>Rational Architectural Visualisation</Text>

      <View style={styles.card}>
        <Text style={styles.label}>IMAGE / DRAWING</Text>

        <TouchableOpacity style={styles.uploadButton} onPress={pickImage}>
          <Text style={styles.buttonText}>
            {selectedImage ? "CHANGE IMAGE" : "IMPORT IMAGE"}
          </Text>
        </TouchableOpacity>

        {selectedImage ? (
          <Image
            source={{ uri: selectedImage }}
            style={styles.previewImage}
            resizeMode="cover"
          />
        ) : null}

        <Text style={styles.label}>PROJECT BRIEF</Text>

        <TextInput
          style={styles.input}
          placeholder="Describe materials, light, landscape, atmosphere..."
          placeholderTextColor="#8FA08A"
          multiline
          value={prompt}
          onChangeText={setPrompt}
        />

        <TouchableOpacity
          style={[styles.renderButton, loading ? styles.disabled : null]}
          onPress={renderImage}
          disabled={loading}
        >
          {loading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color="#FFFFFF" />
              <Text style={styles.buttonText}> RENDERING...</Text>
            </View>
          ) : (
            <Text style={styles.buttonText}>RENDER</Text>
          )}
        </TouchableOpacity>

        {message ? <Text style={styles.message}>{message}</Text> : null}
      </View>

      {resultImage ? (
        <View style={styles.resultContainer}>
          <Text style={styles.resultTitle}>RESULT</Text>

          <Image
            source={{ uri: resultImage }}
            style={styles.resultImage}
            resizeMode="cover"
          />

          <TouchableOpacity style={styles.saveButton} onPress={saveImage}>
            <Text style={styles.buttonText}>SAVE IMAGE</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </ScrollView>
  );
}

function LogoMark() {
  return (
    <View style={styles.logoBox}>
      <View style={styles.logoCircleOuter} />
      <View style={styles.logoCircleInner} />
      <View style={styles.logoVertical} />
      <View style={styles.logoHorizontal} />
      <View style={styles.logoDiagonalOne} />
      <View style={styles.logoDiagonalTwo} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: "#07110B",
  },
  pageCenter: {
    flex: 1,
    backgroundColor: "#07110B",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  content: {
    padding: 24,
    paddingTop: 54,
    paddingBottom: 90,
  },
  logoBox: {
    width: 104,
    height: 104,
    borderWidth: 2,
    borderColor: "#6FA342",
    borderRadius: 28,
    alignSelf: "center",
    marginBottom: 26,
    overflow: "hidden",
  },
  logoCircleOuter: {
    position: "absolute",
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 2,
    borderColor: "#6FA342",
    top: 16,
    left: 16,
  },
  logoCircleInner: {
    position: "absolute",
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 2,
    borderColor: "#6FA342",
    top: 31,
    left: 31,
  },
  logoVertical: {
    position: "absolute",
    width: 2,
    height: "100%",
    backgroundColor: "#6FA342",
    left: 51,
  },
  logoHorizontal: {
    position: "absolute",
    height: 2,
    width: "100%",
    backgroundColor: "#6FA342",
    top: 51,
  },
  logoDiagonalOne: {
    position: "absolute",
    width: 150,
    height: 2,
    backgroundColor: "#6FA342",
    transform: [{ rotate: "45deg" }],
    top: 51,
    left: -24,
  },
  logoDiagonalTwo: {
    position: "absolute",
    width: 150,
    height: 2,
    backgroundColor: "#6FA342",
    transform: [{ rotate: "-45deg" }],
    top: 51,
    left: -24,
  },
  title: {
    color: "#FFFFFF",
    textAlign: "center",
    fontSize: 44,
    fontWeight: "900",
    letterSpacing: 1,
    marginBottom: 20,
  },
  subtitle: {
    color: "#79A94A",
    textAlign: "center",
    fontSize: 24,
    fontWeight: "900",
    marginBottom: 34,
  },
  card: {
    backgroundColor: "#0D1A10",
    borderRadius: 28,
    padding: 22,
    borderWidth: 2,
    borderColor: "#6FA342",
  },
  label: {
    color: "#79A94A",
    fontSize: 15,
    fontWeight: "900",
    letterSpacing: 2,
    marginBottom: 12,
    marginTop: 6,
  },
  uploadButton: {
    backgroundColor: "#6F933D",
    borderRadius: 22,
    padding: 20,
    marginBottom: 24,
  },
  previewImage: {
    width: "100%",
    height: 300,
    borderRadius: 22,
    marginBottom: 24,
    backgroundColor: "#07110B",
  },
  input: {
    backgroundColor: "#07110B",
    color: "#FFFFFF",
    minHeight: 170,
    borderRadius: 22,
    padding: 18,
    fontSize: 18,
    textAlignVertical: "top",
    borderWidth: 1,
    borderColor: "#2E4426",
  },
  renderButton: {
    backgroundColor: "#6F933D",
    borderRadius: 22,
    padding: 20,
    marginTop: 24,
  },
  saveButton: {
    backgroundColor: "#6F933D",
    borderRadius: 22,
    padding: 18,
    marginTop: 16,
  },
  restoreButton: {
    padding: 18,
    marginTop: 12,
  },
  restoreText: {
    color: "#79A94A",
    fontWeight: "900",
    textAlign: "center",
    fontSize: 15,
    letterSpacing: 1,
  },
  disabled: {
    opacity: 0.6,
  },
  loadingRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
  },
  buttonText: {
    color: "#FFFFFF",
    fontWeight: "900",
    textAlign: "center",
    fontSize: 20,
    letterSpacing: 1,
  },
  message: {
    color: "#FFFFFF",
    textAlign: "center",
    marginTop: 16,
    fontSize: 16,
  },
  paywallTitle: {
    color: "#FFFFFF",
    textAlign: "center",
    fontSize: 30,
    fontWeight: "900",
    marginBottom: 16,
  },
  paywallText: {
    color: "#FFFFFF",
    textAlign: "center",
    fontSize: 17,
    lineHeight: 25,
    marginBottom: 20,
  },
  price: {
    color: "#79A94A",
    textAlign: "center",
    fontSize: 26,
    fontWeight: "900",
    marginBottom: 4,
  },
  smallText: {
    color: "#8FA08A",
    textAlign: "center",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 10,
  },
  resultContainer: {
    marginTop: 32,
  },
  resultTitle: {
    color: "#79A94A",
    textAlign: "center",
    fontWeight: "900",
    marginBottom: 14,
    letterSpacing: 2,
  },
  resultImage: {
    width: "100%",
    height: 430,
    borderRadius: 24,
    backgroundColor: "#0D1A10",
  },
});