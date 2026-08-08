'use strict';
/**
 * Geolocation capture. NEVER blocks a mark: resolves null on any failure or
 * timeout — the server records the mark as UNVERIFIED and a supervisor
 * adjudicates. A blocked mark is a field worker standing in the sun.
 */
const Geo = {
  /** Haversine distance in metres. */
  distM(lat1, lng1, lat2, lng2) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(a)));
  },

  capture(timeoutMs) {
    const limit = timeoutMs || 12000;
    return new Promise(resolve => {
      if (!('geolocation' in navigator)) return resolve(null);
      let done = false;
      const finish = (val) => { if (!done) { done = true; clearTimeout(t); resolve(val); } };
      const t = setTimeout(() => finish(null), limit);
      navigator.geolocation.getCurrentPosition(
        pos => finish({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        }),
        () => finish(null),
        { enableHighAccuracy: true, timeout: limit, maximumAge: 30000 }
      );
    });
  }
};
