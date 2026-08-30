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
  const bindErr = bindDevice_(user, deviceId);
  if (bindErr) return bindErr;

  CACHE.remove(rlKey);
  const token = issueToken_(user, deviceId);
  return { ok: true, token: token, config: getConfigFor_(user) };
}

/**
 * Bind a field worker to this handset, or explain why not. Returns null when
 * the login may proceed, and an error object when it may not.
 *
 * Extracted so that every route which issues a token enforces the SAME rules.
 * Duplicating them for a second sign-in path is how a device policy quietly
 * develops a hole.
 *
 * Console roles (ADMIN/CDPO/SUPERVISOR) are exempt: they legitimately sign in
 * from an office PC, a laptop and a phone browser.
 */
function bindDevice_(user, deviceId) {
  if (String(user.role) !== 'FIELD') return null;
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
  return null;
}

/**
 * Who else works at this centre.
 *
 * Committee finding 5, measured 2026-08-30: of 500 Helper accounts, 254 are
 * registered on their own mobile number rather than the centre's. Sign-in
 * resolves a PHONE to its candidates, so typing the centre number on the
 * Teacher's handset does not offer those Helpers at all — their names simply
 * are not in the list, which reads exactly like an account that was never
 * activated. It is not a fault in their records; a Helper may perfectly well
 * have her own number. It is the sign-in screen asking the wrong question.
 *
 * So this asks the right one. Names and cadre only, never phone numbers, and
 * only for the caller's OWN centre — the same information the phone-based
 * picker already shows to anyone holding the centre's number.
 */
function apiCentreUsers_(auth, req) {
  const awcId = String(auth.user.awc_id || '');
  if (!awcId) return { ok: true, users: [] };
  const users = getUsersAll_().filter(u =>
    String(u.awc_id) === awcId && String(u.status) === 'ACTIVE' &&
    String(u.role) === 'FIELD' && String(u.user_id) !== String(auth.userId));
  return { ok: true, users: users.map(u => ({
    id: String(u.user_id), name: String(u.name), cadre: String(u.cadre),
    // So the picker can say "she has not set a PIN yet" instead of failing
    // at the next step with nothing to explain it.
    registered: !!u.pin_hash
  })) };
}

/**
 * Sign a colleague in on this handset, by name and PIN, with no phone number
 * typed at all.
 *
 * WHAT THIS DOES NOT WEAKEN. It needs a live session of someone already at
 * the same centre, and then the colleague's own PIN — strictly more than the
 * phone-number path, which needs only a number that the whole centre knows.
 * It carries the same lockout, the same failure counter and the same device
 * binding rules, through the same functions. It cannot reach a worker at
 * another centre: the target is filtered by the caller's own awc_id before
 * anything is checked.
 */
function apiCentreLogin_(auth, req) {
  const awcId = String(auth.user.awc_id || '');
  const targetId = String(req.userId || '');
  const deviceId = String(req.deviceId || '').trim();
  if (!awcId || !targetId) return { ok: false, code: 'NO_USER' };
  if (!deviceId) return { ok: false, code: 'NO_DEVICE' };

  const user = getUserById_(targetId);
  if (!user || String(user.status) !== 'ACTIVE' || String(user.role) !== 'FIELD' ||
      String(user.awc_id) !== awcId) {
    return { ok: false, code: 'NO_USER' };
  }
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    return { ok: false, code: 'LOCKED', until: String(user.locked_until) };
  }

  if (!user.pin_hash) {
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
    if (Number(user.failed_attempts) > 0) {
      updateUser_(user, { failed_attempts: '0', locked_until: '' });
    }
  }

  const bindErr = bindDevice_(user, deviceId);
  if (bindErr) return bindErr;

  audit_(user.user_id, 'CENTRE_LOGIN', user.user_id, String(auth.userId), deviceId);
  return { ok: true, token: issueToken_(user, deviceId), config: getConfigFor_(user) };
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
      awcId: String(user.awc_id), awcName: awc ? awc.name : '', role: String(user.role),
      // The console hides the Approve/Reject buttons on this, but the server
      // enforces it again in apiLeaveDecide_ — a hidden button is not a rule.
      canApproveLeave: canApproveLeave_(user)
    },
    locations: geofenceCandidatesFor_(user).map(a => ({
      awc_id: a.awc_id, name: a.name, lat: a.lat, lng: a.lng, radius_m: a.radius_m
    })),
    schedule: scheduleFor_(String(user.project_code), String(user.cadre)),
    sync: { jitterMaxSec: Number(PROPS.getProperty('JITTER_MAX_SEC') || 90), batchMax: BATCH_MAX },
    photoMaxKB: 60,
    privacyVersion: 1,
    // The app compares its own build against this and updates itself when it
    // is behind. Enforced on the handset rather than by refusing records: a
    // stale app must be replaced, but its attendance must still arrive.
    minAppBuild: minAppBuild_(),
    serverTs: nowIso_()
  };
}

function apiConfig_(auth, req) {
  return { ok: true, config: getConfigFor_(auth.user) };
}
