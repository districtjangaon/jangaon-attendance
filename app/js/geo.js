'use strict';
/**
 * Geolocation capture.
 *
 * The slow satellite. A cold GPS needs a minute or two of open sky — longer
 * than any single attempt can politely wait — so the phone answers early with
 * a ±2000 m network guess and an honest worker gets filed "unverified". So we
 * do not ask once and accept the answer: we ask, then keep watching while she
 * does the rest of the flow (photo, form), and KEEP ONLY THE BETTER FIX. A
 * worse reading is never taken. The watch stops at 50 m or after 150 s.
 *
 * Two-stage first ask: high accuracy, then one coarse retry. A network fix
 * beats no fix so long as it is labelled coarse — which it is, everywhere it
 * is shown and in the record.
 *
 * Geolocation needs HTTPS. Over plain http:// the browser refuses silently,
 * so isSecure() lets the screen say that instead of showing a dead button.
 */
const Geo = {
  _watchId: null,
  _best: null,
  _timer: null,
  _onUpdate: null,
  _denied: false,

  /** Haversine distance in metres. */
  distM(lat1, lng1, lat2, lng2) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(a)));
  },

  /** false when the page is served over plain HTTP — geolocation is dead there. */
  isSecure() {
    return !!(window.isSecureContext && 'geolocation' in navigator);
  },

  tz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }
    catch (e) { return ''; }
  },

  ACCEPT_M: 50,     // good enough — stop watching
  COARSE_M: 250,    // the line between a place and an area
  WATCH_MS: 150000,

  _fix(pos, coarse) {
    return {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy == null ? null : pos.coords.accuracy,
      coarse: !!coarse || pos.coords.accuracy == null ||
        pos.coords.accuracy > Geo.COARSE_M,
      ts: Date.now()
    };
  },

  /** Keep the better of the two. A worse reading is never taken. */
  _offer(fix) {
    if (!fix) return;
    const b = this._best;
    const better = !b ||
      (fix.accuracy != null && (b.accuracy == null || fix.accuracy < b.accuracy));
    if (!better) return;
    this._best = fix;
    if (this._onUpdate) this._onUpdate(fix, null);
    if (fix.accuracy != null && fix.accuracy <= this.ACCEPT_M) this.stop();
  },

  /**
   * Begin acquiring. onUpdate(fix, err) fires on every improvement, and once
   * with (null, reason) if nothing can be had — 'INSECURE', 'DENIED',
   * 'UNAVAILABLE'. Safe to call repeatedly; each call starts a fresh hunt.
   */
  start(onUpdate) {
    this.stop();
    this._best = null;
    this._denied = false;
    this._onUpdate = onUpdate || null;

    if (!this.isSecure()) {
      if (this._onUpdate) this._onUpdate(null, 'INSECURE');
      return;
    }

    const fine = { enableHighAccuracy: true, timeout: 18000, maximumAge: 0 };
    // A coarse network fix beats no fix — it is recorded, and labelled coarse.
    const coarse = { enableHighAccuracy: false, timeout: 15000, maximumAge: 120000 };

    navigator.geolocation.getCurrentPosition(
      pos => this._offer(this._fix(pos, false)),
      err => {
        if (err && err.code === 1) {           // PERMISSION_DENIED
          this._denied = true;
          this.stop();
          if (this._onUpdate) this._onUpdate(null, 'DENIED');
          return;
        }
        navigator.geolocation.getCurrentPosition(
          pos => this._offer(this._fix(pos, true)),
          e2 => {
            if (e2 && e2.code === 1) { this._denied = true; this.stop(); }
            if (this._onUpdate && !this._best) {
              this._onUpdate(null, this._denied ? 'DENIED' : 'UNAVAILABLE');
            }
          },
          coarse
        );
      },
      fine
    );

    // The improver. Runs alongside the asks above; whichever produces the
    // tighter reading wins.
    try {
      this._watchId = navigator.geolocation.watchPosition(
        pos => this._offer(this._fix(pos, false)),
        err => { if (err && err.code === 1) { this._denied = true; this.stop(); } },
        fine
      );
    } catch (e) { /* some browsers throw when permission is already denied */ }

    this._timer = setTimeout(() => this.stop(), this.WATCH_MS);
  },

  /** Always call this when the screen closes — a live watch drains the battery. */
  stop() {
    if (this._watchId != null) {
      try { navigator.geolocation.clearWatch(this._watchId); } catch (e) { /* gone */ }
      this._watchId = null;
    }
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  },

  best() { return this._best; },
  denied() { return this._denied; },

  /** Resolves with the best fix available within ms (or null). Never rejects. */
  settle(ms) {
    return new Promise(resolve => {
      const deadline = Date.now() + (ms || 15000);
      const tick = () => {
        if (this._best && this._best.accuracy != null &&
            this._best.accuracy <= this.ACCEPT_M) return resolve(this._best);
        if (this._denied || Date.now() >= deadline) return resolve(this._best);
        setTimeout(tick, 300);
      };
      tick();
    });
  },

  /**
   * One-shot fix for the seen ping: cheap, coarse is fine, never blocks
   * anything. Resolves null rather than rejecting.
   */
  once(ms) {
    return new Promise(resolve => {
      if (!this.isSecure()) return resolve(null);
      let done = false;
      const finish = v => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
      const t = setTimeout(() => finish(null), ms || 12000);
      navigator.geolocation.getCurrentPosition(
        pos => finish(Geo._fix(pos, false)),
        () => finish(null),
        { enableHighAccuracy: false, timeout: ms || 12000, maximumAge: 120000 }
      );
    });
  }
};
