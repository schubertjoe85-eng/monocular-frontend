import { requireOptionalNativeModule } from "expo-modules-core";

// null in builds made before this module existed (or on a platform without MapKit).
const Native = requireOptionalNativeModule("MonocularSite");

export const siteImagesAvailable = !!Native;

// Base64 JPEG of the real satellite image around the site (Apple Maps), north up.
export function satellite(lat, lng, meters = 220, size = 1024) {
  if (!Native) return Promise.reject(new Error("Satellite images need the latest Monocular build."));
  return Native.snapshot(lat, lng, meters, size, "satellite");
}

// Base64 PNG of Apple's standard map (no labels, light style): buildings are flat grey shapes to trace.
export function standardMap(lat, lng, meters = 220, size = 768) {
  if (!Native) return Promise.reject(new Error("Map images need the latest Monocular build."));
  return Native.snapshot(lat, lng, meters, size, "map");
}

// Reads a photographed plan sketch with Apple Vision on the phone (the desktop's reader). Returns its JSON text.
export function readSketch(uri) {
  if (!Native) return Promise.reject(new Error("Reading sketches needs the latest Monocular build."));
  return Native.readSketch(uri);
}
