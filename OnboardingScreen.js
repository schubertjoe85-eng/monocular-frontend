// OnboardingScreen.js — Monocular Build 130
// First-launch screen: makes free-vs-Pro clearly discoverable (Guideline 2.1(b)).
// Restyled to match the main app: logo, #050505/#111 palette, green accent,
// heavy letter-spaced button typography.

import React from 'react';
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  StatusBar,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const ONBOARDING_KEY = 'monocular_onboarding_seen_v1';

// ---- Helpers (imported by App.js) -------------------------------------------

export async function shouldShowOnboarding() {
  try {
    const seen = await AsyncStorage.getItem(ONBOARDING_KEY);
    return seen !== 'true';
  } catch (e) {
    return false; // storage failed — never block the app
  }
}

export async function markOnboardingSeen() {
  try {
    await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
  } catch (e) {
    // non-fatal
  }
}

// ---- Component ---------------------------------------------------------------
// Props:
//   onTryFree()  — dismiss and go to the main screen (free render available)
//   onSeePro()   — dismiss and open the subscription paywall

export default function OnboardingScreen({ onTryFree, onSeePro }) {
  const handleTryFree = async () => {
    await markOnboardingSeen();
    onTryFree();
  };

  const handleSeePro = async () => {
    await markOnboardingSeen();
    onSeePro();
  };

  return (
    <SafeAreaView style={styles.page}>
      <StatusBar barStyle="light-content" />
      <View style={styles.content}>
        <View style={styles.top}>
          <Image source={require('./assets/logo.png')} style={styles.logoMark} />
          <Text style={styles.subtitle}>Rational Architectural Visualisation</Text>
        </View>

        <View style={styles.tiers}>
          <View style={styles.card}>
            <Text style={styles.tierLabel}>FREE</Text>
            <Text style={styles.tierLine}>1 photorealistic render</Text>
            <Text style={styles.tierSub}>No payment required</Text>
          </View>

          <View style={[styles.card, styles.cardPro]}>
            <Text style={[styles.tierLabel, styles.tierLabelPro]}>PRO</Text>
            <Text style={styles.tierLine}>Unlimited rendering</Text>
            <Text style={styles.tierLine}>3D walkthrough videos</Text>
            <Text style={styles.tierSub}>Auto-renewing subscription</Text>
          </View>
        </View>

        <View style={styles.actions}>
          <TouchableOpacity style={styles.buttonLight} onPress={handleTryFree} activeOpacity={0.85}>
            <Text style={styles.buttonLightText}>TRY YOUR FREE RENDER</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.buttonDark} onPress={handleSeePro} activeOpacity={0.85}>
            <Text style={styles.buttonDarkText}>SEE PRO PLANS</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

// ---- Styles (matched to App.js) ------------------------------------------------

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#050505' },
  content: {
    flex: 1,
    padding: 22,
    paddingTop: 40,
    paddingBottom: 24,
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  top: { alignItems: 'center' },
  logoMark: {
    width: 120,
    height: 120,
    borderRadius: 24,
    marginBottom: 10,
    resizeMode: 'contain',
  },
  subtitle: { color: '#aaa', fontSize: 14, textAlign: 'center' },
  tiers: { width: '100%', maxWidth: 540, gap: 14 },
  card: {
    width: '100%',
    backgroundColor: '#111',
    borderRadius: 24,
    padding: 20,
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  cardPro: { borderColor: '#2E4D3A' },
  tierLabel: {
    color: '#888',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 3,
    marginBottom: 10,
  },
  tierLabelPro: { color: '#7FBF9A' },
  tierLine: { color: '#fff', fontSize: 16, lineHeight: 24 },
  tierSub: { color: '#666', fontSize: 13, marginTop: 8 },
  actions: { width: '100%', maxWidth: 540 },
  buttonLight: {
    backgroundColor: '#2E4D3A',
    padding: 16,
    borderRadius: 16,
    alignItems: 'center',
  },
  buttonLightText: { color: '#fff', fontWeight: '900', letterSpacing: 1 },
  buttonDark: {
    backgroundColor: '#222',
    padding: 16,
    borderRadius: 16,
    alignItems: 'center',
    marginTop: 12,
  },
  buttonDarkText: { color: '#fff', fontWeight: '900', letterSpacing: 1 },
});
