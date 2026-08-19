'use strict';
/**
 * Server API. POST body is JSON sent as text/plain — a CORS "simple request",
 * so the browser never preflights (Apps Script cannot answer OPTIONS).
 * DEMO mode fakes the whole backend locally so the app can be exercised
 * end-to-end (offline queue, shared-phone user picker included) with no
 * server at all.
 */
const Api = (() => {

  async function post(body) {
    if (window.APP_CONFIG.DEMO) return demo(body);
    // Google's Apps Script serving degrades sometimes (HTML error pages /
    // 404s with sticky per-connection routing, seen 2026-08-19). Two live
    // deployments of the same script exist; alternate between them, up to 5
    // attempts with jittered backoff. All writes are idempotent-or-guarded
    // server-side, so a retry never duplicates.
    const eps = window.APP_CONFIG.ENDPOINTS || [window.APP_CONFIG.ENDPOINT];
    let lastErr;
    for (let i = 0; i < 5; i++) {
      if (i) await new Promise(r => setTimeout(r, 400 + i * 300 + Math.random() * 600));
      try {
        const res = await fetch(eps[i % eps.length], {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();
        try { return JSON.parse(text); }
        catch (e) { throw new Error('SERVER_HTML'); }
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  // ---------- demo backend ----------
  // One shared centre phone with two workers, like ~190 real AWCs.
  const demoUsers = {
    U0001: { name: 'Demo Teacher', cadre: 'AWT', pin: null },
    U0002: { name: 'Demo Helper', cadre: 'AWH', pin: null }
  };
  const demoLeaves = {};

  async function demo(body) {
    await new Promise(r => setTimeout(r, 350)); // simulate network
    switch (body.action) {
      case 'login': {
        if (!/^\d{10}$/.test(String(body.phone || ''))) return { ok: false, code: 'BAD_PHONE' };
        const uid = String(body.userId || '');
        if (!demoUsers[uid]) {
          return {
            ok: false, code: 'CHOOSE_USER',
            users: Object.keys(demoUsers).map(id =>
              ({ id: id, name: demoUsers[id].name, cadre: demoUsers[id].cadre }))
          };
        }
        const u = demoUsers[uid];
        if (body.newPin) {
          if (!/^\d{4}$/.test(String(body.newPin))) return { ok: false, code: 'BAD_PIN_FORMAT' };
          u.pin = String(body.newPin);
        } else if (u.pin == null) {
          return { ok: false, code: 'SET_PIN_REQUIRED', userId: uid };
        } else if (!body.pin) {
          return { ok: false, code: 'PIN_REQUIRED' };
        } else if (String(body.pin) !== u.pin) {
          return { ok: false, code: 'WRONG_PIN', left: 4 };
        }
        return { ok: true, token: 'demo-token-' + uid, config: demoConfig(uid) };
      }
      case 'sync':
        return {
          ok: true,
          serverTs: new Date().toISOString(),
          acks: (body.records || []).map(r => ({ key: r.key, status: 'OK' }))
        };
      case 'config': {
        const uid = String(body.token || '').replace('demo-token-', '');
        return { ok: true, config: demoConfig(demoUsers[uid] ? uid : 'U0001') };
      }
      case 'myHistory':
        return { ok: true, marks: [] };
      case 'leaveApply': {
        const uid2 = String(body.token || '').replace('demo-token-', '');
        (demoLeaves[uid2] = demoLeaves[uid2] || []).unshift({
          id: 'LV-demo' + Math.random().toString(36).slice(2, 6),
          from: body.from, to: body.to, type: body.type, reason: body.reason, status: 'APPROVED'
        });
        return { ok: true, leaveId: 'LV-demo', status: 'APPROVED' };
      }
      case 'myLeaves': {
        const uid3 = String(body.token || '').replace('demo-token-', '');
        return { ok: true, leaves: demoLeaves[uid3] || [] };
      }
      default:
        return { ok: true };
    }
  }

  function demoConfig(uid) {
    const u = demoUsers[uid];
    return {
      user: { id: uid, name: u.name, cadre: u.cadre, project: 'JGN', sector: 'S01',
        awcId: 'A0001', awcName: 'Demo AWC Alipur-I', role: 'FIELD' },
      locations: [{ awc_id: 'A0001', name: 'Demo AWC Alipur-I', lat: null, lng: null, radius_m: 200 }],
      schedule: { project_code: 'ALL', cadre: 'ALL', in_start: '08:30', in_end: '10:30',
        late_after: '09:30', out_start: '15:30', out_end: '17:30' },
      sync: { jitterMaxSec: 5, batchMax: 10 }, // short jitter so demo feels snappy
      photoMaxKB: 60,
      privacyVersion: 1,
      serverTs: new Date().toISOString()
    };
  }

  return { post };
})();
