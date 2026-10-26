// site.js — finds a site from a typed address, Apple only (as on desktop):
// Apple's geocoder through expo-location (CLGeocoder on iOS) and Apple Maps
// satellite imagery through the local MonocularSite module (MKMapSnapshotter).
// No third-party mapping service and no API key.

import * as Location from "expo-location";
import { satellite, standardMap } from "./modules/monocular-site";

export const SITE_METERS = 220;            // same near ground span as desktop
export const RING_METERS = [1100, 5500];   // desktop's wider satellite rings (the 30 km horizon ring is desktop-only)

// Returns { lat, lng, locality, region, roadName } or throws an Error with a message for the user.
export async function geocodeAddress(address) {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== "granted") throw new Error("Location permission needed to look up an address.");
  const first = (await Location.geocodeAsync(address))[0];
  if (!first) throw new Error("Address not found — check the spelling and include the suburb and state.");
  const [place] = await Location.reverseGeocodeAsync({ latitude: first.latitude, longitude: first.longitude });
  return {
    lat: first.latitude, lng: first.longitude,
    locality: place?.city || place?.subregion || null,
    region: place?.region || null,
    roadName: place?.street || null,
  };
}

// The site's satellite image as base64 JPEG, or null if Apple Maps didn't return one (it fails now and then,
// more often in rural areas - one pause and retry, as on desktop).
export async function satelliteFor(site, meters = SITE_METERS) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await satellite(site.lat, site.lng, meters, 1024); }
    catch (e) { if (attempt === 0) await new Promise(r => setTimeout(r, 1500)); }
  }
  return null;
}

// Apple's standard map around the site, traced into buildings where OpenStreetMap has few (as on desktop):
// 220 m at 768 px and 1100 m at 1536 px. Returns base64 PNG or null.
export async function standardMapFor(site, meters) {
  try { return await standardMap(site.lat, site.lng, meters, meters > 300 ? 1536 : 768); } catch { return null; }
}

// Real buildings around the site from OpenStreetMap (Overpass), the same query as desktop: everything within
// 650 m, plus the skyline (30 m+ or 9+ storeys) out to 2 km. One of the user-approved outside-data exceptions
// (building heights). Returns the raw Overpass JSON text; the renderer page turns it into massing.
export async function fetchOsmText(site, radius = 650) {
  const { lat, lng } = site;
  const A = `(around:${radius},${lat},${lng})`;
  const F = `(around:2000,${lat},${lng})(if: number(t["height"]) >= 30 || number(t["building:levels"]) >= 9)`;
  const q = `[out:json][timeout:90];(way["building"]${A};relation["building"]["type"="multipolygon"]${A};way["building:part"]${A};relation["building:part"]["type"="multipolygon"]${A};way["building"]${F};relation["building"]["type"="multipolygon"]${F};way["building:part"]${F};relation["building:part"]["type"="multipolygon"]${F};);out geom tags;`;
  // Both public servers at once, first good answer wins, each with a time limit: the main one often stalls for
  // minutes under load, and waiting it out before trying the other left the site bare for far too long.
  const ask = async host => {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 60000);
    try {
      const res = await fetch(host, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": "Monocular/1.1 (iOS)" },
        body: "data=" + encodeURIComponent(q),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error("status " + res.status);
      const text = await res.text();
      if (!text.trim().startsWith("{")) throw new Error("unexpected reply");
      return text;
    } finally { clearTimeout(timer); }
  };
  let lastErr = "no response";
  try {
    return await firstOk(["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"].map(ask));
  } catch (e) {
    lastErr = (e.errors && e.errors[0] && e.errors[0].message) || e.message || "no response";
  }
  if (radius > 350) return fetchOsmText(site, 350);   // a very dense downtown: try a smaller area
  throw new Error(lastErr);
}

// Real terrain, as on desktop: Copernicus DEM via Open-Meteo (no key) - the other user-approved outside-data
// exception. near: 21 x 21 over 2 km (100 m cells); far: 25 x 25 over 30 km for the hills around the site.
// Returns { n, half, step, z: number[] } in metres relative to the site's own ground.
export async function fetchDem(site, which = "near", onWait) {
  const { lat, lng } = site;
  const n = which === "far" ? 25 : 21, half = which === "far" ? 15000 : 1000, step = 2 * half / (n - 1);
  const kx = 111320 * Math.cos(lat * Math.PI / 180), kz = 110540, las = [], los = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) { las.push((lat - (-half + r * step) / kz).toFixed(5)); los.push((lng + (-half + c * step) / kx).toFixed(5)); }
  const el = [];
  for (let i = 0; i < las.length; i += 100) {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${las.slice(i, i + 100).join(",")}&longitude=${los.slice(i, i + 100).join(",")}`);
      if (r.ok) { el.push(...(await r.json()).elevation); break; }
      // the free elevation service limits points per minute: wait it out and carry on
      if (r.status !== 429 || attempt >= 3) throw new Error("elevation " + r.status);
      onWait && onWait();
      await new Promise(res => setTimeout(res, 65000));
    }
  }
  if (el.length !== n * n) throw new Error("elevation grid incomplete");
  const c0 = el[Math.floor(n / 2) * n + Math.floor(n / 2)];
  return { n, half, step, z: el.map(v => v - c0) };
}

// The first promise to resolve; rejects (with every error) only if they all fail. (Promise.any, without relying on
// the JS engine having it.)
function firstOk(promises) {
  return new Promise((resolve, reject) => {
    const errors = []; let left = promises.length;
    promises.forEach((p, i) => p.then(resolve, e => { errors[i] = e; if (--left === 0) { const err = new Error("all failed"); err.errors = errors; reject(err); } }));
  });
}
