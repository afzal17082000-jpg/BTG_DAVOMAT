// ============================================================
// src/utils/geo.js
// GPS geofencing helpers. ALL distance checks happen server-side —
// the client (Mini App) also checks locally for fast UX feedback,
// but that check is never trusted on its own, since a modified
// client could lie. The server is the source of truth.
// ============================================================
const config = require('../config');

const EARTH_RADIUS_M = 6371000; // mean radius of the Earth, in meters

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * Haversine formula — great-circle distance between two lat/lng points, in meters.
 */
function distanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

/**
 * Validates a reported GPS fix against the company geofence.
 * Returns { ok: boolean, reason?: string, distanceM?: number }
 *
 * Anti-spoofing notes (see README "GPS anti-spoofing" section for full discussion):
 *  - We reject readings with poor accuracy (accuracy > MAX_GPS_ACCURACY_M) because
 *    mocked/spoofed coordinates on many fake-GPS apps report unrealistically
 *    perfect OR unrealistically poor accuracy values, and low accuracy alone
 *    makes the distance check unreliable regardless of spoofing.
 *  - We reject impossible values (accuracy <= 0, lat/lng out of range).
 *  - The Mini App additionally prefers Telegram's native LocationManager
 *    (Bot API 8.0+) over raw browser geolocation when available, since it is
 *    harder to spoof from inside the Telegram client sandbox than an
 *    arbitrary browser tab.
 */
function validateGeofence({ lat, lng, accuracy }) {
  if (typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) {
    return { ok: false, reason: 'invalid_coordinates' };
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { ok: false, reason: 'invalid_coordinates' };
  }
  if (typeof accuracy !== 'number' || Number.isNaN(accuracy) || accuracy <= 0) {
    return { ok: false, reason: 'missing_accuracy' };
  }
  if (accuracy > config.geofence.maxAccuracyM) {
    return { ok: false, reason: 'low_accuracy', accuracy };
  }

  const distanceM = distanceMeters(lat, lng, config.geofence.lat, config.geofence.lng);
  if (distanceM > config.geofence.radiusM) {
    return { ok: false, reason: 'out_of_range', distanceM: Math.round(distanceM) };
  }

  return { ok: true, distanceM: Math.round(distanceM) };
}

module.exports = { distanceMeters, validateGeofence };
