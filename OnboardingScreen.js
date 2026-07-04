// OnboardingScreen.js — Monocular Build 129
// First-launch screen: makes free-vs-Pro clearly discoverable (Guideline 2.1(b)).
// Shown once. Self-contained — App.js only needs the two helpers + component below.
//
// Requires: @react-native-async-storage/async-storage
// If not already installed:  npx expo install @react-native-async-storage/async-storage

import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  StatusBar,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const ONBOARDING_KEY = 'monocular_onboarding_seen_v1';

// ---- Helpers (import these in App.js) --------------------------------------

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

// ---- Component --------------------------------------------------------------
// Props:
//   onTryFree()  — dismiss and go to the main screen (free render available)
//   onSeePro()   — dismiss and open your existing RevenueCat paywall

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
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" />
      <View style={styles.content}>
        <Text style={styles.wordmark}>MONOCULAR</Text>
        <Text style={styles.tagline}>
          Your sketch, made real.{'\n'}Photorealistic renders from any image.
        </Text>

        <View style={styles.tiers}>
          <View style={styles.tier}>
            <Text style={styles.tierLabel}>FREE</Text>
            <Text style={styles.tierLine}>1 photorealistic render</Text>
            <Text style={styles.tierSub}>No payment required</Text>
          </View>

          <View style={[styles.tier, styles.tierPro]}>
            <Text style={[styles.tierLabel, styles.tierLabelPro]}>PRO</Text>
            <Text style={styles.tierLine}>Unlimited rendering</Text>
            <Text style={styles.tierLine}>Video generation</Text>
            <Text style={styles.tierSub}>Auto-renewing subscription</Text>
          </View>
        </View>

        <View style={styles.actions}>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={handleTryFree}
            activeOpacity={0.85}
          >
            <Text style={styles.primaryBtnText}>Try your free render</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={handleSeePro}
            activeOpacity={0.85}
          >
            <Text style={styles.secondaryBtnText}>See Pro plans</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

// ---- Styles ------------------------------------------------------------------

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0E0F10',
  },
  content: {
    flex: 1,
    paddingHorizontal: 28,
    paddingTop: 64,
    paddingBottom: 24,
    justifyContent: 'space-between',
  },
  wordmark: {
    color: '#F2F0EC',
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: 6,
  },
  tagline: {
    color: '#9A9891',
    fontSize: 17,
    lineHeight: 25,
    marginTop: 14,
  },
  tiers: {
    gap: 14,
  },
  tier: {
    borderWidth: 1,
    borderColor: '#26282A',
    borderRadius: 14,
    padding: 20,
    backgroundColor: '#141516',
  },
  tierPro: {
    borderColor: '#C8B08A',
  },
  tierLabel: {
    color: '#9A9891',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 3,
    marginBottom: 10,
  },
  tierLabelPro: {
    color: '#C8B08A',
  },
  tierLine: {
    color: '#F2F0EC',
    fontSize: 16,
    lineHeight: 24,
  },
  tierSub: {
    color: '#6E6C66',
    fontSize: 13,
    marginTop: 8,
  },
  actions: {
    gap: 12,
  },
  primaryBtn: {
    backgroundColor: '#F2F0EC',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#0E0F10',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: '#3A3C3E',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  secondaryBtnText: {
    color: '#F2F0EC',
    fontSize: 16,
    fontWeight: '500',
  },
});
