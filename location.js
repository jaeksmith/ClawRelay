/**
 * Location tracking module for Claw Relay
 *
 * Receives location updates from the app (GPS + WiFi fingerprint + motion).
 * Stores history, infers current location against named places.
 * Exposes HTTP API for AI queries.
 */

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'location-state.json');
const HISTORY_FILE = path.join(__dirname, 'location-history.jsonl');

const MAX_HISTORY_LINES = 5000;       // cap on history file
const STATIONARY_THRESHOLD_M = 5;    // metres — don't log if barely moved
const STATIONARY_THRESHOLD_MS = 30000; // don't log more than once per 30s if stationary

const DEFAULT_STATE = {
  namedLocations: [],    // [{ id, name, lat, lng, radiusM, wifiFingerprint: [bssid,...], createdAt }]
  current: null,         // { lat, lng, accuracy, altitude, wifiScan, motion, inferredName, timestamp }
  tracking: true
};

let state = loadState();
let lastLoggedPoint = null; // for stationary dedup

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
    }
  } catch (e) { console.error('[location] Failed to load state:', e.message); }
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.error('[location] Failed to save state:', e.message); }
}

// Haversine distance in metres
function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Count matching BSSIDs between scan and fingerprint, weighted by RSSI similarity.
// fingerprintRssi: { bssid -> dBm } from saved location (optional)
// scanRssi:        { bssid -> dBm } from current update (optional)
// When RSSI data is available, networks with similar signal strength score higher.
// A network seen at -45dBm saved but now at -85dBm (you're far away) penalizes the score.
function wifiMatchScore(scanBssids, fingerprintBssids, scanRssi, fingerprintRssi) {
  if (!scanBssids?.length || !fingerprintBssids?.length) return 0;
  const fpSet = new Set(fingerprintBssids);
  const matches = scanBssids.filter(b => fpSet.has(b));
  if (!matches.length) return 0;

  const baseScore = matches.length / Math.max(scanBssids.length, fingerprintBssids.length);

  // RSSI similarity bonus/penalty (only when both sides have RSSI data)
  if (scanRssi && fingerprintRssi && Object.keys(scanRssi).length && Object.keys(fingerprintRssi).length) {
    let rssiScore = 0, rssiCount = 0;
    for (const bssid of matches) {
      const saved = fingerprintRssi[bssid];
      const now = scanRssi[bssid];
      if (saved != null && now != null) {
        // RSSI difference in dBm — ±10dBm is normal variation, >30dBm suggests different location
        const diff = Math.abs(saved - now);
        rssiScore += Math.max(0, 1 - diff / 30);
        rssiCount++;
      }
    }
    if (rssiCount > 0) {
      const rssiSimilarity = rssiScore / rssiCount; // 0–1
      // Blend: 70% presence match, 30% RSSI similarity
      return baseScore * 0.7 + baseScore * rssiSimilarity * 0.3;
    }
  }

  return baseScore;
}

// Infer current named location from GPS + WiFi, accounting for GPS accuracy radius.
//
// Scoring weights are dynamic:
//   - When GPS is good (accuracy < 30m): GPS 60%, WiFi 40%
//   - When GPS is poor (accuracy > 100m): GPS 20%, WiFi 80%
//   - Linearly interpolated between those extremes
//
// Match radius is expanded by the reported accuracy so a ±100m fix can still
// match a named location with a small radiusM.
function inferLocation(lat, lng, accuracy, wifiScan, wifiRssi) {
  let bestMatch = null;
  let bestScore = 0;

  // Clamp accuracy: treat null/0 as 50m (moderate uncertainty)
  const acc = (accuracy > 0) ? accuracy : 50;

  // Dynamic weight: GPS weight drops as accuracy worsens
  // acc=10 → gpsWeight≈0.6, acc=100 → gpsWeight≈0.2
  const GPS_GOOD = 30, GPS_POOR = 150;
  const t = Math.min(1, Math.max(0, (acc - GPS_GOOD) / (GPS_POOR - GPS_GOOD)));
  const gpsWeight = 0.6 - t * 0.4;   // 0.6 → 0.2
  const wifiWeight = 1 - gpsWeight;   // 0.4 → 0.8

  for (const loc of state.namedLocations) {
    let score = 0;

    // GPS proximity score — expand effective radius by reported accuracy
    if (lat != null && loc.lat != null) {
      const dist = distanceM(lat, lng, loc.lat, loc.lng);
      const effectiveRadius = (loc.radiusM || 20) + acc;   // shrinks score penalty for poor GPS
      const searchRadius = effectiveRadius * 3;
      if (dist <= searchRadius) {
        score += Math.max(0, 1 - dist / searchRadius) * gpsWeight;
      }
    }

    // WiFi fingerprint score (with RSSI similarity when available)
    if (wifiScan?.length && loc.wifiFingerprint?.length) {
      score += wifiMatchScore(wifiScan, loc.wifiFingerprint, wifiRssi, loc.wifiFingerprintRssi) * wifiWeight;
    }

    if (score > bestScore) { bestScore = score; bestMatch = loc.name; }
  }

  // Lower threshold when accuracy is poor (GPS alone can't hit 0.3 reliably at ±100m)
  const threshold = 0.3 - t * 0.1; // 0.3 → 0.2
  if (bestScore >= threshold) {
    return { name: bestMatch, confidence: Math.round(bestScore * 100) };
  }
  return { name: null, confidence: Math.round(bestScore * 100) };
}

// Append to history file (JSONL)
function appendHistory(point) {
  try {
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(point) + '\n');
    // Trim if too large (keep last MAX_HISTORY_LINES)
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
    if (lines.length > MAX_HISTORY_LINES) {
      fs.writeFileSync(HISTORY_FILE, lines.slice(-MAX_HISTORY_LINES).join('\n') + '\n');
    }
  } catch (e) { console.error('[location] History write failed:', e.message); }
}

// Process a location update from the app
function processUpdate(update) {
  const { lat, lng, accuracy, altitude, wifiScan, wifiRssi, motion, timestamp } = update;
  const now = timestamp || Date.now();

  // Deduplicate stationary points
  if (lastLoggedPoint && lat != null) {
    const dist = distanceM(lat, lng, lastLoggedPoint.lat, lastLoggedPoint.lng);
    const age = now - lastLoggedPoint.timestamp;
    if (dist < STATIONARY_THRESHOLD_M && age < STATIONARY_THRESHOLD_MS) {
      // Still stationary and recent — just update current without logging
      state.current = { ...state.current, timestamp: now, motion };
      return { ok: true, logged: false, reason: 'stationary' };
    }
  }

  const inferred = inferLocation(lat, lng, accuracy, wifiScan, wifiRssi);
  const inferredName = inferred.name;
  const locationConfidence = inferred.confidence;
  const point = { lat, lng, accuracy, altitude, wifiScan, wifiRssi, motion, inferredName, locationConfidence, timestamp: now };

  state.current = point;
  saveState();
  appendHistory(point);
  lastLoggedPoint = point;

  console.log(`[location] Update: ${lat?.toFixed(5)},${lng?.toFixed(5)} acc=${accuracy}m inferred="${inferredName}" confidence=${locationConfidence}%`);
  return { ok: true, logged: true, inferredName, locationConfidence };
}

// Named location management
function addNamedLocation(loc) {
  if (!loc.name) return { ok: false, error: 'name required' };

  // Upsert: if a location with this name already exists, update it instead of duplicating
  const existingIdx = state.namedLocations.findIndex(l => l.name.toLowerCase() === loc.name.toLowerCase());
  if (existingIdx !== -1) {
    const existing = state.namedLocations[existingIdx];
    // Merge wifi fingerprints (union of BSSIDs)
    const merged = existing;
    if (loc.lat != null) { merged.lat = loc.lat; merged.lng = loc.lng; }
    if (loc.radiusM != null) merged.radiusM = loc.radiusM;
    if (loc.wifiFingerprint?.length) {
      const bssidSet = new Set([...(existing.wifiFingerprint || []), ...loc.wifiFingerprint]);
      merged.wifiFingerprint = [...bssidSet];
    }
    if (loc.wifiFingerprintRssi) {
      merged.wifiFingerprintRssi = { ...(existing.wifiFingerprintRssi || {}), ...loc.wifiFingerprintRssi };
    }
    merged.updatedAt = Date.now();
    state.namedLocations[existingIdx] = merged;
    saveState();
    return { ok: true, location: merged, updated: true };
  }

  loc.id = loc.id || `loc-${Date.now()}`;
  loc.createdAt = Date.now();
  state.namedLocations.push(loc);
  saveState();
  return { ok: true, location: loc };
}

function updateNamedLocation(id, patch) {
  const idx = state.namedLocations.findIndex(l => l.id === id);
  if (idx === -1) return { ok: false, error: 'not found' };
  state.namedLocations[idx] = { ...state.namedLocations[idx], ...patch };
  saveState();
  return { ok: true, location: state.namedLocations[idx] };
}

function removeNamedLocation(id) {
  const idx = state.namedLocations.findIndex(l => l.id === id);
  if (idx === -1) return { ok: false, error: 'not found' };
  state.namedLocations.splice(idx, 1);
  saveState();
  return { ok: true };
}

function getHistory(limitLines = 100) {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limitLines).map(l => JSON.parse(l));
  } catch (e) { return []; }
}

// Manually override the inferred location (user says "I'm here")
function setManualLocation(name) {
  if (state.current) {
    state.current = { ...state.current, inferredName: name, locationConfidence: 100, manualOverride: true };
  } else {
    state.current = { inferredName: name, locationConfidence: 100, manualOverride: true, timestamp: Date.now() };
  }
  saveState();
}

module.exports = {
  processUpdate,
  addNamedLocation,
  updateNamedLocation,
  removeNamedLocation,
  setManualLocation,
  getCurrent: () => state.current,
  getNamedLocations: () => state.namedLocations,
  getHistory,
  setTracking: (enabled) => { state.tracking = enabled; saveState(); },
  isTracking: () => state.tracking
};
