// ModelViewerScreen.js — Monocular (v7)
// 3D model import + orbit viewer + view capture.
//
// Changes from v6:
//   1. NEW: Collada (.dae) support. ArchiCAD exports .dae natively
//      (File → Save As → Collada), so no GLB conversion step is needed.
//      ColladaLoader reads the file's own <up_axis> tag, so orientation
//      is handled automatically; the ROTATE button covers stragglers.
//
// Carried from v6: OBJ auto-uprighting + ROTATE button; v5: zoom buttons;
// v4: pinch capture-phase fix + adaptive clip planes;
// three@0.166.1 / expo-three@8.0.0.
//
// Flow: import a .glb / .obj exported from ArchiCAD, orbit/pinch to frame the
// shot, tap CAPTURE VIEW. onCapture(uri) receives a local JPEG URI — treat it
// exactly like an image picker result. Zero server changes.
//
// Dependencies:
//   npx expo install expo-gl expo-file-system expo-document-picker
//   npm install three@0.166.1 expo-three

import React, { useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  PanResponder,
  StyleSheet,
} from "react-native";
import { GLView } from "expo-gl";
import { Renderer } from "expo-three";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js";

// ---------------------------------------------------------------------------
// base64 -> ArrayBuffer (GLB files arrive as base64 from expo-file-system)
// Lookup-table decoder: O(1) per character instead of indexOf's O(64).
// ---------------------------------------------------------------------------
const B64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const B64_LOOKUP = new Uint8Array(256);
for (let i = 0; i < B64_CHARS.length; i++) {
  B64_LOOKUP[B64_CHARS.charCodeAt(i)] = i;
}

function base64ToArrayBuffer(base64) {
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, "");
  const len = clean.length;
  const padding =
    base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const byteLength = (len * 3) / 4 - padding;
  const bytes = new Uint8Array(byteLength);
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const a = B64_LOOKUP[clean.charCodeAt(i)];
    const b = B64_LOOKUP[clean.charCodeAt(i + 1)];
    const c = B64_LOOKUP[clean.charCodeAt(i + 2)];
    const d = B64_LOOKUP[clean.charCodeAt(i + 3)];
    bytes[p++] = (a << 2) | (b >> 4);
    if (p < byteLength) bytes[p++] = ((b & 15) << 4) | (c >> 2);
    if (p < byteLength) bytes[p++] = ((c & 3) << 6) | (d & 63);
  }
  return bytes.buffer;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function ModelViewerScreen({ onCapture, onClose, capturedCount = 0 }) {
  const [modelName, setModelName] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [clayMode, setClayMode] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [glReady, setGlReady] = useState(false);

  // Three.js refs — kept outside React state (mutated every frame)
  const glRef = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const modelGroupRef = useRef(null);
  const frameRef = useRef(null);

  // Orbit state (spherical coordinates around a target point)
  const orbit = useRef({
    theta: Math.PI / 4,
    phi: Math.PI / 2.4,
    radius: 10,
    target: new THREE.Vector3(0, 0, 0),
    minRadius: 0.5,
    maxRadius: 100,
  });

  const gesture = useRef({
    lastX: 0,
    lastY: 0,
    lastDist: 0,
    lastMidX: 0,
    lastMidY: 0,
    touches: 0,
  });

  const updateCamera = useCallback(() => {
    const cam = cameraRef.current;
    if (!cam) return;
    const { theta, phi, radius, target } = orbit.current;
    cam.position.set(
      target.x + radius * Math.sin(phi) * Math.sin(theta),
      target.y + radius * Math.cos(phi),
      target.z + radius * Math.sin(phi) * Math.cos(theta)
    );
    cam.lookAt(target);
  }, []);

  // Deterministic zoom used by the on-screen buttons. factor < 1 zooms in,
  // factor > 1 zooms out. Same clamping as pinch.
  const zoomBy = useCallback(
    (factor) => {
      const o = orbit.current;
      o.radius = Math.max(o.minRadius, Math.min(o.maxRadius, o.radius * factor));
      updateCamera();
    },
    [updateCamera]
  );

  // -------------------------------------------------------------------------
  // Touch gestures: 1 finger orbit, 2 fingers pinch-zoom + pan
  // -------------------------------------------------------------------------

  // Re-baseline whenever the number of fingers changes. Prevents both the
  // "pinch does nothing" case (stale baseline) and the orbit jump when
  // lifting one finger after a pinch.
  const syncGesture = useCallback((t) => {
    const g = gesture.current;
    g.touches = t.length;
    if (t.length === 1) {
      g.lastX = t[0].pageX;
      g.lastY = t[0].pageY;
    } else if (t.length >= 2) {
      const dx = t[0].pageX - t[1].pageX;
      const dy = t[0].pageY - t[1].pageY;
      g.lastDist = Math.sqrt(dx * dx + dy * dy);
      g.lastMidX = (t[0].pageX + t[1].pageX) / 2;
      g.lastMidY = (t[0].pageY + t[1].pageY) / 2;
    }
  }, []);

  const panResponder = useRef(
    PanResponder.create({
      // Claim in the capture phase so multi-touch can't be intercepted
      // by children (the GLView) before it reaches this handler.
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      // Never surrender the gesture mid-interaction.
      onPanResponderTerminationRequest: () => false,

      onPanResponderGrant: (evt) => syncGesture(evt.nativeEvent.touches),
      // Fires when additional fingers land / lift while we hold the responder.
      onPanResponderStart: (evt) => syncGesture(evt.nativeEvent.touches),
      onPanResponderEnd: (evt) => syncGesture(evt.nativeEvent.touches),

      onPanResponderMove: (evt) => {
        const t = evt.nativeEvent.touches;
        const g = gesture.current;
        const o = orbit.current;

        // Finger count changed since last event: reset baselines, apply
        // nothing this frame.
        if (t.length !== g.touches) {
          syncGesture(t);
          return;
        }

        if (t.length === 1) {
          const dx = t[0].pageX - g.lastX;
          const dy = t[0].pageY - g.lastY;
          g.lastX = t[0].pageX;
          g.lastY = t[0].pageY;
          o.theta -= dx * 0.008;
          o.phi -= dy * 0.008;
          o.phi = Math.max(0.15, Math.min(Math.PI - 0.15, o.phi));
        } else if (t.length >= 2) {
          const dxT = t[0].pageX - t[1].pageX;
          const dyT = t[0].pageY - t[1].pageY;
          const dist = Math.sqrt(dxT * dxT + dyT * dyT);
          const midX = (t[0].pageX + t[1].pageX) / 2;
          const midY = (t[0].pageY + t[1].pageY) / 2;

          const scale = g.lastDist > 0 ? dist / g.lastDist : 1;
          o.radius = Math.max(
            o.minRadius,
            Math.min(o.maxRadius, o.radius / scale)
          );
          const cam = cameraRef.current;
          if (cam) {
            const panScale = o.radius * 0.0015;
            const right = new THREE.Vector3();
            const up = new THREE.Vector3();
            cam.matrix.extractBasis(right, up, new THREE.Vector3());
            o.target.addScaledVector(right, -(midX - g.lastMidX) * panScale);
            o.target.addScaledVector(up, (midY - g.lastMidY) * panScale);
          }
          g.lastDist = dist;
          g.lastMidX = midX;
          g.lastMidY = midY;
        }
        updateCamera();
      },

      onPanResponderRelease: () => {
        gesture.current.touches = 0;
      },
    })
  ).current;

  // -------------------------------------------------------------------------
  // GL context setup — light "studio" canvas, deliberately not dark:
  // this pixel output is the AI input, and a clean neutral backdrop
  // gives the image model the best massing read.
  // -------------------------------------------------------------------------
  const onContextCreate = useCallback(
    (gl) => {
      glRef.current = gl;

      const renderer = new Renderer({ gl });
      renderer.setSize(gl.drawingBufferWidth, gl.drawingBufferHeight);
      renderer.setClearColor(0xf1f0ee, 1);
      rendererRef.current = renderer;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0xf1f0ee);
      sceneRef.current = scene;

      const camera = new THREE.PerspectiveCamera(
        45,
        gl.drawingBufferWidth / gl.drawingBufferHeight,
        0.01,
        2000
      );
      cameraRef.current = camera;

      const hemi = new THREE.HemisphereLight(0xffffff, 0xb0aca6, 0.9);
      scene.add(hemi);
      const key = new THREE.DirectionalLight(0xffffff, 1.6);
      key.position.set(5, 10, 7);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0xffffff, 0.5);
      rim.position.set(-6, 4, -8);
      scene.add(rim);

      updateCamera();

      const renderLoop = () => {
        frameRef.current = requestAnimationFrame(renderLoop);
        renderer.render(scene, camera);
        gl.endFrameEXP();
      };
      renderLoop();
      setGlReady(true);
    },
    [updateCamera]
  );

  // -------------------------------------------------------------------------
  // Model loading
  // -------------------------------------------------------------------------
  const applyClay = useCallback((group, enabled) => {
    const clay = new THREE.MeshStandardMaterial({
      color: 0xd9d5cf,
      roughness: 0.85,
      metalness: 0.0,
    });
    group.traverse((child) => {
      if (child.isMesh) {
        if (!child.userData._origMaterial) {
          child.userData._origMaterial = child.material;
        }
        child.material = enabled ? clay : child.userData._origMaterial;
      }
    });
  }, []);

  const frameModel = useCallback(
    (group) => {
      const box = new THREE.Box3().setFromObject(group);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;

      group.position.sub(center);
      group.position.y += size.y / 2 - (center.y - box.min.y);

      const o = orbit.current;
      o.target.set(0, size.y * 0.35, 0);
      o.radius = maxDim * 1.8;
      o.minRadius = maxDim * 0.2;
      o.maxRadius = maxDim * 8;
      o.theta = Math.PI / 4;
      o.phi = Math.PI / 2.4;

      // Adapt clip planes to the model's scale. ArchiCAD exports are often
      // in millimetres (a house ≈ 15,000 units) — a fixed far plane of 2000
      // clipped the model out of view the moment you zoomed out.
      const cam = cameraRef.current;
      if (cam) {
        cam.near = Math.max(maxDim / 1000, 0.01);
        cam.far = maxDim * 25;
        cam.updateProjectionMatrix();
      }

      updateCamera();
    },
    [updateCamera]
  );

  const setModel = useCallback(
    (object3d, name) => {
      const scene = sceneRef.current;
      if (!scene) return;
      if (modelGroupRef.current) {
        scene.remove(modelGroupRef.current);
      }
      const group = new THREE.Group();
      group.add(object3d);
      scene.add(group);
      modelGroupRef.current = group;
      applyClay(group, clayMode);
      frameModel(group);
      setModelName(name);
    },
    [applyClay, clayMode, frameModel]
  );

  const importModel = useCallback(async () => {
    setError(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        type: "*/*", // .glb/.obj have no reliable UTI — filter by extension below
      });
      if (result.canceled || !result.assets?.length) return;

      const asset = result.assets[0];
      const name = asset.name || "model";
      const ext = name.split(".").pop().toLowerCase();

      if (!["glb", "gltf", "obj", "dae"].includes(ext)) {
        setError("Unsupported file. Use .glb, .dae, or .obj.");
        return;
      }

      setLoading(true);

      if (ext === "obj") {
        const text = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: FileSystem.EncodingType.UTF8,
        });
        const obj = new OBJLoader().parse(text);
        // ArchiCAD/CAD exports are Z-up; three.js is Y-up. Stand it upright.
        obj.rotation.x = -Math.PI / 2;
        setModel(obj, name);
      } else if (ext === "dae") {
        // Collada — XML text. ArchiCAD exports this natively.
        // ColladaLoader honours the file's <up_axis>, so no manual rotation.
        const text = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: FileSystem.EncodingType.UTF8,
        });
        const collada = new ColladaLoader().parse(text, "");
        setModel(collada.scene, name);
      } else {
        // .glb / .gltf — read binary, parse with GLTFLoader.
        // Notes:
        //   - .gltf with external .bin/textures won't resolve on device;
        //     .glb (self-contained) is the recommended format.
        //   - Embedded textures may fail to decode in RN (no browser image
        //     APIs). If a textured GLB fails here, export geometry-only —
        //     clay mode replaces materials anyway.
        const base64 = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const buffer = base64ToArrayBuffer(base64);
        const loader = new GLTFLoader();
        await new Promise((resolve, reject) => {
          loader.parse(
            buffer,
            "",
            (gltf) => {
              setModel(gltf.scene, name);
              resolve();
            },
            (err) => reject(err)
          );
        });
      }
    } catch (e) {
      console.warn("Model import failed:", e);
      setError(
        "Could not load that model. Export as .glb (geometry only, no textures) and try again."
      );
    } finally {
      setLoading(false);
    }
  }, [setModel]);

  const toggleClay = useCallback(() => {
    setClayMode((prev) => {
      const next = !prev;
      if (modelGroupRef.current) applyClay(modelGroupRef.current, next);
      return next;
    });
  }, [applyClay]);

  // Manual 90° step for models whose exporter used a different up-axis.
  const rotateModel = useCallback(() => {
    const group = modelGroupRef.current;
    if (!group) return;
    group.rotation.x -= Math.PI / 2;
    group.updateMatrixWorld(true);
    frameModel(group);
  }, [frameModel]);

  // -------------------------------------------------------------------------
  // Capture the framed view -> snapshot URI -> hand off to render flow
  // -------------------------------------------------------------------------
  const captureView = useCallback(async () => {
    if (!glRef.current || capturing) return;
    setCapturing(true);
    try {
      const snapshot = await GLView.takeSnapshotAsync(glRef.current, {
        format: "jpeg",
        compress: 0.92,
      });
      if (onCapture) onCapture(snapshot.uri, snapshot);
    } catch (e) {
      console.warn("Capture failed:", e);
      setError("Capture failed. Try again.");
    } finally {
      setCapturing(false);
    }
  }, [capturing, onCapture]);

  // -------------------------------------------------------------------------
  // UI — dark chrome, light canvas
  // -------------------------------------------------------------------------
  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={onClose} style={styles.closeButton}>
          <Text style={styles.closeButtonText}>{capturedCount > 0 ? "DONE" : "CLOSE"}</Text>
        </TouchableOpacity>
        <Text style={styles.topBarTitle} numberOfLines={1}>
          {modelName || "3D MODEL"}
        </Text>
        <View style={styles.closeButton} />
      </View>

      <View style={styles.viewerArea}>
        <View style={styles.viewerWrap} {...panResponder.panHandlers}>
          <GLView style={styles.glView} onContextCreate={onContextCreate} />

          {!modelName && !loading && (
            <View style={styles.emptyState} pointerEvents="none">
              <Text style={styles.emptyTitle}>No model loaded</Text>
              <Text style={styles.emptyBody}>
                Import a .glb, .dae, or .obj exported from ArchiCAD.{"\n"}
                One finger to orbit, pinch to zoom, two fingers to pan.
              </Text>
            </View>
          )}

          {loading && (
            <View style={styles.loadingOverlay} pointerEvents="none">
              <ActivityIndicator size="large" color="#1c1c1e" />
              <Text style={styles.loadingText}>Loading model…</Text>
            </View>
          )}
        </View>

        {/* Zoom buttons live OUTSIDE the gesture view — the capture-phase
            PanResponder would otherwise swallow their taps. */}
        {modelName && (
          <View style={styles.zoomControls}>
            <TouchableOpacity
              style={styles.zoomButton}
              onPress={() => zoomBy(0.82)}
            >
              <Text style={styles.zoomButtonText}>＋</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.zoomButton}
              onPress={() => zoomBy(1.22)}
            >
              <Text style={styles.zoomButtonText}>－</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {error && (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <View style={styles.toolbar}>
        <TouchableOpacity style={styles.toolButton} onPress={importModel}>
          <Text style={styles.toolButtonText}>
            {modelName ? "REPLACE" : "IMPORT"}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.toolButton, !modelName && styles.disabled]}
          onPress={rotateModel}
          disabled={!modelName}
        >
          <Text style={styles.toolButtonText}>ROTATE</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.toolButton, !modelName && styles.disabled]}
          onPress={toggleClay}
          disabled={!modelName}
        >
          <Text style={styles.toolButtonText}>
            {clayMode ? "CLAY: ON" : "CLAY: OFF"}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.captureButton,
            (!modelName || !glReady || capturing || capturedCount >= 3) && styles.disabled,
          ]}
          onPress={captureView}
          disabled={!modelName || !glReady || capturing || capturedCount >= 3}
        >
          <Text style={styles.captureButtonText}>
            {capturing
              ? "CAPTURING..."
              : capturedCount >= 3
              ? "3 VIEWS CAPTURED"
              : `CAPTURE VIEW ${capturedCount + 1}/3`}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#050505",
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 58,
    paddingBottom: 12,
    paddingHorizontal: 16,
    backgroundColor: "#050505",
  },
  closeButton: {
    width: 64,
  },
  closeButtonText: {
    color: "#888",
    fontWeight: "900",
    letterSpacing: 1,
    fontSize: 12,
  },
  topBarTitle: {
    flex: 1,
    color: "#fff",
    fontWeight: "900",
    letterSpacing: 2,
    fontSize: 13,
    textAlign: "center",
  },
  viewerArea: {
    flex: 1,
  },
  viewerWrap: {
    flex: 1,
  },
  glView: {
    flex: 1,
  },
  emptyState: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: "#1c1c1e",
    marginBottom: 8,
  },
  emptyBody: {
    fontSize: 14,
    lineHeight: 20,
    color: "#6e6e73",
    textAlign: "center",
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(241,240,238,0.7)",
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: "#1c1c1e",
  },
  zoomControls: {
    position: "absolute",
    right: 14,
    top: "50%",
    marginTop: -56,
    gap: 10,
  },
  zoomButton: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: "rgba(17,17,17,0.85)",
    borderWidth: 1,
    borderColor: "#2a2a2a",
    alignItems: "center",
    justifyContent: "center",
  },
  zoomButtonText: {
    color: "#fff",
    fontSize: 20,
    fontWeight: "900",
    lineHeight: 24,
  },
  errorBar: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: "#3a1512",
  },
  errorText: {
    color: "#f2b8b5",
    fontSize: 13,
  },
  toolbar: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 34,
    backgroundColor: "#111",
    borderTopWidth: 1,
    borderTopColor: "#2a2a2a",
  },
  toolButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: "#222",
    alignItems: "center",
  },
  toolButtonText: {
    color: "#fff",
    fontWeight: "900",
    letterSpacing: 0.5,
    fontSize: 11,
  },
  captureButton: {
    flex: 1.5,
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: "#2E4D3A",
    alignItems: "center",
  },
  captureButtonText: {
    color: "#fff",
    fontWeight: "900",
    letterSpacing: 1,
    fontSize: 12,
  },
  disabled: {
    opacity: 0.5,
  },
});
