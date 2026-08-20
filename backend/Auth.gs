/**
 * Auth.gs — login, PIN handling, lockout, device binding, session tokens.
 *
 * Phone is NOT unique: an AWT+AWH pair usually shares the centre's phone.
 * Login therefore resolves phone -> candidate list; when more than one active
 * user matches, the client is told CHOOSE_USER and retries with userId.
 * Each user has their own PIN and their own device binding; two users bound
 * to the same physical phone is the normal case, not an error.
 *
 * Token format: base64url(tokenId|userId|deviceId|expiryMs) + '.' + hmacHex.
 * Verification is stateless (signature + expiry); the Sessions sheet exists
 * only for revocation, and revocation checks are cached for 6 hours.
 */

function apiLogin_(req) {
  const phone = String(req.phone || '').trim();
  const deviceId = String(req.deviceId || '').trim();
  if (!/^\d{10}$/.test(phone)) return { ok: false, code: 'BAD_PHONE' };
  if (!deviceId) return { ok: false, code: 'NO_DEVICE' };

  // Cheap brute-force damper in front of the per-user lockout.
  const rlKey = 'lg_' + phone;
  const attempts = Number(CACHE.get(rlKey) || '0');
  if (attempts >= 20) return { ok: false, code: 'RATE_LIMIT' };
  CACHE.put(rlKey, String(attempts + 1), 3600);

  const candidates = getUsersByPhone_(phone).filter(u => u.status === 'ACTIVE');
  if (!candidates.length) return { ok: false, code: 'NO_USER' };

  let user;
  if (candidates.length === 1) {
    user = candidates[0];
  } else {
    const wantId = String(req.userId || '');
    user = candidates.find(u => String(u.user_id) === wantId);
    if (!user) {
      // Names shown pre-PIN, but only to someone holding the centre's own
      // number, and rate-limited above. Nothing beyond name + cadre leaks.
      return {
        ok: false, code: 'CHOOSE_USER',
        users: candidates.map(u => ({ id: String(u.user_id), name: String(u.name), cadre: String(u.cadre) }))
      };
    }
  }

  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    return { ok: false, code: 'LOCKED', until: String(user.locked_until) };
  }

  if (!user.pin_hash) {
    // First login (or after supervisor PIN reset): user sets their own PIN.
    const newPin = String(req.newPin || '');
    if (!newPin) return { ok: false, code: 'SET_PIN_REQUIRED', userId: String(user.user_id) };
    if (!/^\d{4}$/.test(newPin)) return { ok: false, code: 'BAD_PIN_FORMAT' };
    const salt = Utilities.getUuid();
    updateUser_(user, {
      pin_hash: hashPin_(newPin, salt), pin_salt: salt, pin_set_at: nowIso_(),
      failed_attempts: '0', locked_until: ''
    });
    audit_(user.user_id, 'PIN_SET', user.user_id, '', '');
  } else {
    const pin = String(req.pin || '');
    if (!pin) return { ok: false, code: 'PIN_REQUIRED' };
    if (hashPin_(pin, String(user.pin_salt)) !== String(user.pin_hash)) {
      const fails = (Number(user.failed_attempts) || 0) + 1;
      if (fails >= LOCKOUT_AFTER) {
        const until = fmtIso_(Date.now() + LOCKOUT_MIN * 60000);
        updateUser_(user, { failed_attempts: '0', locked_until: until });
        audit_(user.user_id, 'PIN_LOCKOUT', user.user_id, '', until);
        return { ok: false, code: 'LOCKED', until: until };
      }
      updateUser_(user, { failed_attempts: String(fails) });
      return { ok: false, code: 'WRONG_PIN', left: LOCKOUT_AFTER - fails };
    }
    if (Number(user.failed_attempts) > 0) updateUser_(user, { failed_attempts: '0', locked_until: '' });
  }

  // Device binding — one active device per FIELD user (anti-buddy-punching),
  // rebinds only via admin. The same deviceId bound to several users (shared
  // centre phone) is fine. Console roles (ADMIN/CDPO/SUPERVISOR) are exempt:
  // they legitimately sign in from office PC, laptop and phone browser.
  if (String(user.role) === 'FIELD') {
    if (user.device_id && user.device_id !== deviceId) {
      return { ok: false, code: 'DEVICE_MISMATCH' };
    }
    if (!user.device_id) {
      // Device pair policy: a centre phone carries at most one AWT + one AWH.
      // Enforced HERE, before binding, so a refused login leaves the account
      // free to bind to the right phone later (client-side-only enforcement
      // would strand the account: the bind would already have happened).
      const bound = getUsersAll_().filter(u =>
        String(u.device_id) === deviceId && String(u.role) === 'FIELD' &&
        String(u.status) === 'ACTIVE' && String(u.user_id) !== String(user.user_id));
      if (bound.length >= 2) return { ok: false, code: 'DEVICE_FULL' };
      if (bound.some(u => String(u.cadre) === String(user.cadre))) {
        return { ok: false, code: 'DEVICE_CADRE', cadre: String(user.cadre) };
      }
      updateUser_(user, { device_id: deviceId, device_bound_at: nowIso_() });
      audit_(user.user_id, 'DEVICE_BIND', user.user_id, '', deviceId);
    }
  }

  CACHE.remove(rlKey);
  const token = issueToken_(user, deviceId);
  return { ok: true, token: token, config: getConfigFor_(user) };
}

function issueToken_(user, deviceId) {
  const tokenId = Utilities.getUuid();
  const exp = Date.now() + TOKEN_DAYS * 86400000;
  const payload = [tokenId, user.user_id, deviceId, exp].join('|');
  const token = Utilities.base64EncodeWebSafe(payload) + '.' + hmac_(payload);
  const lock = LockService.getScriptLock();
  let locked = false;
  try { lock.waitLock(5000); locked = true; } catch (e) { /* still append; logins are rare */ }
  try {
    masterSS_().getSheetByName('Sessions')
      .appendRow([tokenId, user.user_id, deviceId, nowIso_(), fmtIso_(exp), '']);
  } finally {
    if (locked) lock.releaseLock();
  }
  CACHE.put('sessok_' + tokenId, '1', 21600);
  return token;
}

function verifyToken_(token) {
  if (!token) return { ok: false, code: 'AUTH' };
  const parts = String(token).split('.');
  if (parts.length !== 2) return { ok: false, code: 'AUTH' };
  let payload;
  try {
    payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
  } catch (e) {
    return { ok: false, code: 'AUTH' };
  }
  if (hmac_(payload) !== parts[1]) return { ok: false, code: 'AUTH' };
  const seg = payload.split('|');
  if (seg.length !== 4) return { ok: false, code: 'AUTH' };
  const tokenId = seg[0], userId = seg[1], deviceId = seg[2], exp = Number(seg[3]);
  if (!(exp > Date.now())) return { ok: false, code: 'EXPIRED' };

  if (!CACHE.get('sessok_' + tokenId)) {
    const sh = masterSS_().getSheetByName('Sessions');
    const row = findRowByValue_(sh, 1, tokenId);
    if (!row) return { ok: false, code: 'AUTH' };
    if (String(sh.getRange(row, 6).getValue()) === 'TRUE') return { ok: false, code: 'REVOKED' };
    CACHE.put('sessok_' + tokenId, '1', 21600);
  }

  const user = getUserById_(userId);
  if (!user || user.status !== 'ACTIVE') return { ok: false, code: 'AUTH' };
  if (String(user.role) === 'FIELD' && user.device_id && user.device_id !== deviceId) {
    return { ok: false, code: 'DEVICE_MISMATCH' };
  }
  return { ok: true, tokenId: tokenId, userId: userId, deviceId: deviceId, user: user };
}

function revokeUserSessions_(userId) {
  const sh = masterSS_().getSheetByName('Sessions');
  findRowsByValue_(sh, 2, userId).forEach(row => {
    sh.getRange(row, 6).setValue('TRUE');
    CACHE.remove('sessok_' + String(sh.getRange(row, 1).getValue()));
  });
}

// ---------------------------------------------------------------------------
// App-mode telemetry: is this account using the INSTALLED app or a Chrome
// tab? The app pings once a day; one upsert row per user in 'AppModes'.
// Powers the console's adoption split (installed vs browser).

const MODE_H = ['user_id', 'mode', 'app_version', 'updated_at'];

function modesSheet_() {
  const ss = masterSS_();
  let sh = ss.getSheetByName('AppModes');
  if (!sh) {
    sh = ss.insertSheet('AppModes');
    sh.getRange(1, 1, 1, MODE_H.length).setValues([MODE_H]);
    sh.getRange(1, 1, sh.getMaxRows(), MODE_H.length).setNumberFormat('@');
  } else if (String(sh.getRange(1, MODE_H.length).getValue()) !== MODE_H[MODE_H.length - 1]) {
    sh.getRange(1, 1, 1, MODE_H.length).setValues([MODE_H]); // header heal (v column added)
  }
  return sh;
}

// action: "appMode"  req: { token, dm: 'APP'|'BROWSER', v: build tag }
function apiAppMode_(auth, req) {
  const mode = String(req.dm) === 'APP' ? 'APP' : 'BROWSER';
  const ver = String(req.v || '').slice(0, 40);
  const sh = modesSheet_();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const last = sh.getLastRow();
    let row = 0;
    if (last >= 2) {
      const ids = sh.getRange(2, 1, last - 1, 1).getValues();
      for (let i = 0; i < ids.length; i++) {
        if (String(ids[i][0]) === String(auth.userId)) { row = i + 2; break; }
      }
    }
    if (row) sh.getRange(row, 2, 1, 3).setValues([[mode, ver, nowIso_()]]);
    else sh.appendRow([String(auth.userId), mode, ver, nowIso_()]);
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

function apiLogout_(auth, req) {
  const sh = masterSS_().getSheetByName('Sessions');
  const row = findRowByValue_(sh, 1, auth.tokenId);
  if (row) sh.getRange(row, 6).setValue('TRUE');
  CACHE.remove('sessok_' + auth.tokenId);
  return { ok: true };
}

function getConfigFor_(user) {
  const awc = getAwc_(String(user.awc_id));
  return {
    user: {
      id: String(user.user_id), name: String(user.name), cadre: String(user.cadre),
      project: String(user.project_code), sector: String(user.sector_code),
      awcId: String(user.awc_id), awcName: awc ? awc.name : '', role: String(user.role)
    },
    locations: geofenceCandidatesFor_(user).map(a => ({
      awc_id: a.awc_id, name: a.name, lat: a.lat, lng: a.lng, radius_m: a.radius_m
    })),
    schedule: scheduleFor_(String(user.project_code), String(user.cadre)),
    sync: { jitterMaxSec: Number(PROPS.getProperty('JITTER_MAX_SEC') || 90), batchMax: BATCH_MAX },
    photoMaxKB: 60,
    privacyVersion: 1,
    serverTs: nowIso_()
  };
}

function apiConfig_(auth, req) {
  return { ok: true, config: getConfigFor_(auth.user) };
}
