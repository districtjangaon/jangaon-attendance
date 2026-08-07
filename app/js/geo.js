'use strict';
/**
 * Geolocation capture. NEVER blocks a mark: resolves null on any failure or
 * timeout — the server records the mark as UNVERIFIED and a supervisor
 * adjudicates. A blocked mark is a field worker standing in the sun.
 */
const Geo = {
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
