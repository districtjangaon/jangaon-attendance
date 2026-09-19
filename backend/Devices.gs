/**
 * Devices.gs — asking for a phone to be approved, and approving it.
 *
 * Committee finding (point 5): "additional user logins are not getting
 * activated to enable Anganwadi Teachers to record the attendance of
 * Anganwadi Helpers through the Teachers' phones."
 *
 * The binding rules themselves were right and are unchanged: one active phone
 * per field worker, at most one Teacher and one Helper per phone. What was
 * missing was the way back. A Helper whose account had bound to some other
 * handset — a supervisor's phone during training, her own phone before the
 * centre phone arrived, a factory reset that changed the device id — was told
 * "ask the district office", and that was the end of the road. There was no
 * request to make, nothing for the office to see, and no queue anyone could
 * work through. 695 centres generate a steady trickle of these, and a trickle
 * with no drain is a backlog.
 *
 * This is the drain: the worker asks from the login screen, the office sees
 * every pending ask in one list with the reason and who currently holds the
 * phone, and one tap frees the account.
 *
 * THE ASK IS PIN-AUTHENTICATED. It has to be reachable without a token — the
 * whole point is that she cannot get one — so it re-checks the PIN itself and
 * carries the same lockout and the same per-phone rate limit as login. It is
 * not a way to find out whether a PIN is right without paying for the guess.
 */

const DEVREQ_H = ['req_id', 'user_id', 'name', 'cadre', 'phone', 'sector_code', 'awc_id',
  'device_id', 'reason', 'requested_at', 'status', 'decided_by', 'decided_at'];

function devReqSheet_() {
  const ss = masterSS_();
  let sh = ss.getSheetByName('DeviceRequests');
  if (!sh) {
    sh = ss.insertSheet('DeviceRequests');
    sh.getRange(1, 1, 1, DEVREQ_H.length).setValues([DEVREQ_H]);
    sh.getRange(1, 1, sh.getMaxRows(), DEVREQ_H.length).setNumberFormat('@');
    return sh;
  }
  if (sh.getMaxColumns() < DEVREQ_H.length) {
    sh.insertColumnsAfter(sh.getMaxColumns(), DEVREQ_H.length - sh.getMaxColumns());
  }
  if (String(sh.getRange(1, DEVREQ_H.length).getValue()) !== DEVREQ_H[DEVREQ_H.length - 1]) {
    sh.getRange(1, 1, 1, DEVREQ_H.length).setValues([DEVREQ_H]);
  }
  return sh;
}

/** Reasons the app may send. Anything else is recorded as OTHER. */
const DEVREQ_REASONS = ['DEVICE_MISMATCH', 'DEVICE_FULL', 'DEVICE_CADRE'];

/**
 * "This phone is not letting me in — please approve it."
 *
 * Unauthenticated by necessity; PIN-checked, lockout-respecting and
 * rate-limited exactly as login is. One open request per user: asking twice
 * updates the existing row rather than filling the queue with duplicates, so
 * a worker tapping the button three times costs the office one line, not three.
 */
function apiDeviceRequest_(req) {
  const phone = String(req.phone || '').trim();
  const deviceId = String(req.deviceId || '').trim();
  const userId = String(req.userId || '').trim();
  if (!/^\d{10}$/.test(phone)) return { ok: false, code: 'BAD_PHONE' };
  if (!deviceId) return { ok: false, code: 'NO_DEVICE' };

  const rlKey = 'lg_' + phone;
  const attempts = Number(CACHE.get(rlKey) || '0');
  if (attempts >= 20) return { ok: false, code: 'RATE_LIMIT' };
  CACHE.put(rlKey, String(attempts + 1), 3600);

  const candidates = getUsersByPhone_(phone).filter(u => u.status === 'ACTIVE');
  const user = candidates.length === 1 && !userId
    ? candidates[0]
    : candidates.find(u => String(u.user_id) === userId);
  if (!user) return { ok: false, code: 'NO_USER' };

  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    return { ok: false, code: 'LOCKED', until: String(user.locked_until) };
  }
  // A wrong PIN costs a failed attempt here too. Without that, this route
  // would be an unlimited oracle sitting beside a limited one.
  if (!user.pin_hash) return { ok: false, code: 'SET_PIN_REQUIRED', userId: String(user.user_id) };
  if (hashPin_(String(req.pin || ''), String(user.pin_salt)) !== String(user.pin_hash)) {
    const fails = (Number(user.failed_attempts) || 0) + 1;
    if (fails >= LOCKOUT_AFTER) {
      const until = fmtIso_(Date.now() + LOCKOUT_MIN * 60000);
      updateUser_(user, { failed_attempts: '0', locked_until: until });
      return { ok: false, code: 'LOCKED', until: until };
    }
    updateUser_(user, { failed_attempts: String(fails) });
    return { ok: false, code: 'WRONG_PIN', left: LOCKOUT_AFTER - fails };
  }

  const reason = DEVREQ_REASONS.indexOf(String(req.reason)) >= 0 ? String(req.reason) : 'OTHER';
  const sh = devReqSheet_();
  const lock = LockService.getScriptLock();
  let locked = false;
  try { lock.waitLock(5000); locked = true; } catch (e) { /* these are rare; write anyway */ }
  try {
    const open = findOpenRequestRow_(sh, String(user.user_id));
    const row = [
      open ? String(sh.getRange(open, 1).getValue()) : Utilities.getUuid(),
      String(user.user_id), String(user.name), String(user.cadre), phone,
      primarySector_(user), String(user.awc_id || ''), deviceId, reason,
      nowIso_(), 'PENDING', '', ''
    ];
    sh.getRange(open || sh.getLastRow() + 1, 1, 1, DEVREQ_H.length).setValues([row]);
  } finally {
    if (locked) lock.releaseLock();
  }
  audit_(user.user_id, 'DEVICE_REQUEST', user.user_id, String(user.device_id || ''), deviceId);
  return { ok: true, userId: String(user.user_id) };
}

/** Row number of this user's open request, or 0. Scans the tail only. */
function findOpenRequestRow_(sh, userId) {
  if (sh.getLastRow() < 2) return 0;
  const start = Math.max(2, sh.getLastRow() - 400);
  const vals = sh.getRange(start, 1, sh.getLastRow() - start + 1, DEVREQ_H.length).getValues();
  for (let i = vals.length - 1; i >= 0; i--) {
    const o = rowToObj_(DEVREQ_H, vals[i]);
    if (String(o.user_id) === userId && String(o.status) === 'PENDING') return start + i;
  }
  return 0;
}

/**
 * The office's queue. Each entry carries WHO CURRENTLY HOLDS the phone she is
 * asking for, because for DEVICE_FULL and DEVICE_CADRE that is the whole
 * decision — approving her account alone would leave her blocked by the same
 * two occupants she was blocked by before.
 */
function apiDeviceRequestList_(auth, req) {
  if (!isConsoleRole_(auth.user)) return deny_();
  const sh = devReqSheet_();
  if (sh.getLastRow() < 2) return { ok: true, requests: [] };
  const scope = sectorScope_(auth.user);
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, DEVREQ_H.length).getValues();
  const users = getUsersAll_();
  const out = [];
  for (let i = vals.length - 1; i >= 0 && out.length < 200; i--) {
    const o = rowToObj_(DEVREQ_H, vals[i]);
    if (String(o.status) !== 'PENDING') continue;
    if (scope && scope.indexOf(String(o.sector_code)) < 0) continue;
    out.push({
      id: String(o.req_id), userId: String(o.user_id), name: String(o.name),
      cadre: String(o.cadre), phone: String(o.phone), sector: String(o.sector_code),
      awcId: String(o.awc_id), reason: String(o.reason), at: String(o.requested_at),
      // Names, not ids: whoever reads this queue is deciding about people.
      holders: users.filter(u => String(u.device_id) === String(o.device_id) &&
          String(u.role) === 'FIELD' && String(u.user_id) !== String(o.user_id))
        .map(u => ({ userId: String(u.user_id), name: String(u.name),
          cadre: String(u.cadre), awcId: String(u.awc_id || ''),
          boundAt: String(u.device_bound_at || '') }))
    });
  }
  return { ok: true, requests: out };
}

/**
 * Approve: clear the requester's binding so her next login binds the phone she
 * is actually holding. Reject: close the request, change nothing.
 *
 * Approving does NOT bind the new device here. Binding on the next successful
 * login means the phone that gets bound is the one she signs in from, which is
 * the phone that will do the marking — not whichever handset happened to send
 * the request.
 */
function apiDeviceRequestDecide_(auth, req) {
  if (!isConsoleRole_(auth.user)) return deny_();
  const id = String(req.id || '');
  const decision = String(req.decision || '');
  if (['APPROVED', 'REJECTED'].indexOf(decision) < 0) return { ok: false, code: 'BAD_DECISION' };
  const sh = devReqSheet_();
  const row = findRowByValue_(sh, 1, id);
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  const o = rowToObj_(DEVREQ_H, sh.getRange(row, 1, 1, DEVREQ_H.length).getValues()[0]);
  if (String(o.status) !== 'PENDING') return { ok: false, code: 'ALREADY_DECIDED' };

  const target = getUserById_(String(o.user_id));
  if (!target || !inScope_(auth.user, target)) return deny_();

  if (decision === 'APPROVED') {
    const old = String(target.device_id || '');
    updateUser_(target, { device_id: '', device_bound_at: '' });
    revokeUserSessions_(target.user_id);
    audit_(auth.userId, 'DEVICE_REBIND_APPROVED', target.user_id, old, '');
  } else {
    audit_(auth.userId, 'DEVICE_REBIND_REJECTED', target.user_id, String(o.device_id), '');
  }
  // Columns 11..13 are status / decided_by / decided_at — the tail of DEVREQ_H.
  sh.getRange(row, 11, 1, 3).setValues([[decision, String(auth.userId), nowIso_()]]);
  return { ok: true, id: id, decision: decision };
}

/** A queue longer than this is a data problem, not an afternoon's work. */
const DEVREQ_BULK_MAX = 200;

/**
 * Decide a whole selection in one call - the way through a backlog.
 *
 * Every guard the single decision applies is applied here to every request in
 * the list: console role, the requester inside the actor's scope, and the row
 * still PENDING. The only thing taken from the client is which ids to look
 * at. A request that fails a guard is skipped WITH ITS REASON rather than
 * failing the call - an officer sweeping a queue needs to know which lines
 * did not move, not to lose the fifty that did.
 *
 * The Sheets cost is fixed, not per request: one read and one write for the
 * queue, one read and one write for the Users device columns, one pass over
 * Sessions, one append to Audit. Sixty single decisions would instead hold
 * the script lock through some three hundred Sheets calls while every phone
 * syncing that minute waits behind it.
 */
function apiDeviceRequestDecideBulk_(auth, req) {
  if (!isConsoleRole_(auth.user)) return deny_();
  const decision = String(req.decision || '').toUpperCase();
  if (['APPROVED', 'REJECTED'].indexOf(decision) < 0) return { ok: false, code: 'BAD_DECISION' };
  const ids = (Array.isArray(req.ids) ? req.ids : String(req.ids || '').split(','))
    .map(function (x) { return String(x).trim(); }).filter(Boolean);
  if (!ids.length) return { ok: false, code: 'NOTHING_SELECTED' };
  if (ids.length > DEVREQ_BULK_MAX) return { ok: false, code: 'TOO_MANY', max: DEVREQ_BULK_MAX };

  const sh = devReqSheet_();
  const last = sh.getLastRow();
  if (last < 2) return { ok: false, code: 'NOT_FOUND' };

  const ts = nowIso_();
  const skipped = [];
  const targets = [];
  let cleared = [];
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const vals = sh.getRange(2, 1, last - 1, DEVREQ_H.length).getValues();
    // A repeat ask reuses the same req_id on the same row, so an id is one
    // row; where an older build left a decided twin, the PENDING one wins.
    const byId = {};
    vals.forEach(function (v, i) {
      const o = rowToObj_(DEVREQ_H, v);
      o._row = i + 2;
      const id = String(o.req_id);
      if (!byId[id] || String(byId[id].status) !== 'PENDING') byId[id] = o;
    });

    ids.forEach(function (id) {
      const o = byId[id];
      if (!o) { skipped.push({ id: id, why: 'NOT_FOUND' }); return; }
      if (String(o.status) !== 'PENDING') { skipped.push({ id: id, why: 'ALREADY_DECIDED' }); return; }
      const t = getUserById_(String(o.user_id));
      if (!t || !inScope_(auth.user, t)) { skipped.push({ id: id, why: 'OUT_OF_SCOPE' }); return; }
      o._user = t;
      targets.push(o);
    });
    if (!targets.length) return { ok: true, changed: 0, skipped: skipped };

    const rng = sh.getRange(2, 11, last - 1, 3);
    const block = rng.getValues();
    targets.forEach(function (o) {
      const i = o._row - 2;
      block[i][0] = decision;
      block[i][1] = String(auth.userId);
      block[i][2] = ts;
    });
    rng.setValues(block);

    if (decision === 'APPROVED') {
      cleared = clearDeviceBindings_(targets.map(function (o) { return o._user; }), ts);
      revokeSessionsForUsers_(targets.map(function (o) { return String(o.user_id); }));
    }
  } finally {
    lock.releaseLock();
  }

  // One audit row per decision, naming the phone that was released - the same
  // trail a single decision writes, written in one append.
  const wasBound = {};
  cleared.forEach(function (c) { wasBound[c.userId] = c.deviceId; });
  auditMany_(targets.map(function (o) {
    return { actor: auth.userId, action: 'DEVICE_REBIND_' + decision,
      target: String(o.user_id),
      oldValue: decision === 'APPROVED' ? (wasBound[String(o.user_id)] || '') : String(o.device_id),
      newValue: '' };
  }));

  return { ok: true, changed: targets.length, skipped: skipped,
    decision: decision, by: String(auth.userId), at: ts };
}

/**
 * Clear the phone binding of several users in one read and one write, and
 * report what each was bound to so the audit trail can name it.
 *
 * device_id, device_bound_at, created_at and updated_at are columns 15..18 of
 * USERS_H - contiguous, so one block covers everything that has to change.
 * created_at is read and written straight back, which is the price of the
 * single setValues and cheaper than the two writes per user it replaces.
 */
function clearDeviceBindings_(users, ts) {
  const out = [];
  if (!users || !users.length) return out;
  const sh = masterSS_().getSheetByName('Users');
  const last = sh.getLastRow();
  if (last < 2) return out;
  const first = U_.device_id + 1;
  const width = U_.updated_at - U_.device_id + 1;
  const rng = sh.getRange(2, first, last - 1, width);
  const block = rng.getValues();
  users.forEach(function (u) {
    const i = Number(u._row) - 2;
    if (!(i >= 0 && i < block.length)) return;   // user row moved under us
    out.push({ userId: String(u.user_id), deviceId: String(block[i][0] || '') });
    block[i][0] = '';
    block[i][1] = '';
    block[i][width - 1] = ts;
    CACHE.remove('uid_' + String(u.user_id));
  });
  rng.setValues(block);
  return out;
}
