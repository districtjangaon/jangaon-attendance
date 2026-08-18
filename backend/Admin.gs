/**
 * Admin.gs — master-data management, adjudication, PIN/device resets.
 * Every mutation is audit-logged. Authorisation is enforced HERE, server-side,
 * from the token's user — never from anything the client sends.
 *
 * Scopes: SUPERVISOR = own sector (FIELD users only). CDPO = own project
 * (FIELD + SUPERVISOR users). ADMIN = everything.
 */

function isConsoleRole_(u) { return u.role === 'SUPERVISOR' || u.role === 'CDPO' || u.role === 'ADMIN'; }
function deny_() { return { ok: false, code: 'FORBIDDEN' }; }

function inScope_(actor, target) {
  if (actor.role === 'ADMIN') return true;
  if (actor.role === 'CDPO') {
    return String(target.project_code) === String(actor.project_code) &&
      (String(target.role) === 'FIELD' || String(target.role) === 'SUPERVISOR');
  }
  if (actor.role === 'SUPERVISOR') {
    return String(target.sector_code) === String(actor.sector_code) && String(target.role) === 'FIELD';
  }
  return false;
}

/** Sectors the actor may see; null = all. A supervisor may hold charge of
 *  several sectors (comma-separated in sector_code) — dual charge is the
 *  norm in the real register: 20 supervisors cover 27 sectors. */
function sectorScope_(actor) {
  if (actor.role === 'ADMIN') return null;
  if (actor.role === 'CDPO') {
    return getSectors_().filter(s => s.project === String(actor.project_code)).map(s => s.code);
  }
  return String(actor.sector_code).split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * action: raiseIssue — a supervisor (or any console role) flags an issue
 * about a worker in their scope. Stored in the master 'Issues' sheet
 * (created lazily) and audit-logged; the district admin reviews the tab.
 */
function apiRaiseIssue_(auth, req) {
  if (!isConsoleRole_(auth.user)) return deny_();
  const about = getUserById_(String(req.aboutUid || ''));
  if (!about) return { ok: false, code: 'NO_USER' };
  const scope = sectorScope_(auth.user);
  if (scope && scope.indexOf(primarySector_(about)) < 0) return deny_();
  const text = String(req.text || '').trim().slice(0, 300);
  if (!text) return { ok: false, code: 'EMPTY' };
  let sh = masterSS_().getSheetByName('Issues');
  if (!sh) {
    sh = masterSS_().insertSheet('Issues');
    sh.getRange(1, 1, 1, ISSUE_H.length).setValues([ISSUE_H]);
    sh.getRange('A:F').setNumberFormat('@');
  }
  sh.appendRow([nowIso_(), String(auth.userId), primarySector_(about),
    String(about.user_id), text, 'OPEN']);
  audit_(auth.userId, 'ISSUE_RAISED', String(about.user_id), '', text);
  return { ok: true };
}

// ---- console bootstrap: users + org, scoped to the viewer ----
function apiNameMap_(auth, req) {
  if (!isConsoleRole_(auth.user)) return deny_();
  const scope = sectorScope_(auth.user);
  const map = {};
  getUsersAll_().forEach(u => {
    if (scope && scope.indexOf(String(u.sector_code)) < 0 && String(u.user_id) !== String(auth.userId)) return;
    map[String(u.user_id)] = {
      n: String(u.name), p: String(u.phone), c: String(u.cadre),
      pj: String(u.project_code), sc: String(u.sector_code), a: String(u.awc_id),
      r: String(u.role), s: String(u.status)
    };
  });
  const awcs = {};
  masterSheetRows_('AWCs', AWC_H).forEach(r => {
    const a = awcFromRow_(r);
    if (scope && scope.indexOf(a.sector) < 0) return;
    awcs[a.awc_id] = { n: a.name, sc: a.sector, pj: a.project, lat: a.lat, lng: a.lng, r: a.radius_m };
  });
  return {
    ok: true, users: map, awcs: awcs,
    projects: getProjects_(),
    sectors: scope ? getSectors_().filter(s => scope.indexOf(s.code) >= 0) : getSectors_()
  };
}

function masterSheetRows_(name, headers) {
  const sh = masterSS_().getSheetByName(name);
  const last = sh.getLastRow();
  return last < 2 ? [] : sh.getRange(2, 1, last - 1, headers.length).getValues();
}

// ---- adjudication: corrections are APPENDED, Marks rows are never touched ----
function apiCorrection_(auth, req) {
  if (!isConsoleRole_(auth.user)) return deny_();
  const origKey = String(req.origKey || '');
  const action = String(req.act || '');
  const reason = String(req.reason || '').slice(0, 300);
  if (['ACCEPT_OUTSIDE', 'REJECT_MARK', 'MANUAL_MARK'].indexOf(action) < 0) {
    return { ok: false, code: 'BAD_ACTION' };
  }
  const m = origKey.match(/^(U\d+)_(\d{8})_(IN|OUT)$/);
  if (!m) return { ok: false, code: 'BAD_KEY' };
  if (!reason) return { ok: false, code: 'REASON_REQUIRED' };

  const target = getUserById_(m[1]);
  if (!target || !inScope_(auth.user, target)) return deny_();

  const ym = m[2].slice(0, 4) + '-' + m[2].slice(4, 6);
  const ss = getMonthSS_(ym, true);
  if (!ss) return { ok: false, code: 'NO_MONTH' };
  ss.getSheetByName('Corrections').appendRow([
    Utilities.getUuid(), origKey, String(auth.userId), action, reason, nowIso_()
  ]);
  audit_(auth.userId, 'MARK_' + action, origKey, '', reason);
  return { ok: true };
}

// ---- supervisor-mediated resets (the no-SMS forgot-PIN flow) ----
// Targets are user_id, never phone — phones are shared between AWT/AWH pairs.
function apiPinReset_(auth, req) {
  if (!isConsoleRole_(auth.user)) return deny_();
  const target = getUserById_(String(req.userId || ''));
  if (!target || !inScope_(auth.user, target)) return deny_();
  updateUser_(target, { pin_hash: '', pin_salt: '', failed_attempts: '0', locked_until: '' });
  revokeUserSessions_(target.user_id);
  audit_(auth.userId, 'PIN_RESET', target.user_id, '', '');
  return { ok: true, userId: String(target.user_id) };
}

function apiDeviceUnbind_(auth, req) {
  if (!isConsoleRole_(auth.user)) return deny_();
  const target = getUserById_(String(req.userId || ''));
  if (!target || !inScope_(auth.user, target)) return deny_();
  const old = String(target.device_id);
  updateUser_(target, { device_id: '', device_bound_at: '' });
  revokeUserSessions_(target.user_id);
  audit_(auth.userId, 'DEVICE_REBIND_APPROVED', target.user_id, old, '');
  return { ok: true, userId: String(target.user_id) };
}

// ---- geofence re-capture in the field (supervisor stands at the AWC) ----
// This is how the coords blanked at import (out-of-district errors) get fixed.
function apiSetAwcCoords_(auth, req) {
  if (!isConsoleRole_(auth.user)) return deny_();
  const awcId = String(req.awcId || '');
  const sh = masterSS_().getSheetByName('AWCs');
  const row = findRowByValue_(sh, 1, awcId);
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  const awc = awcFromRow_(sh.getRange(row, 1, 1, AWC_H.length).getValues()[0]);
  const scope = sectorScope_(auth.user);
  if (scope && scope.indexOf(awc.sector) < 0) return deny_();
  const lat = Number(req.lat), lng = Number(req.lng);
  if (!isFinite(lat) || !isFinite(lng)) return { ok: false, code: 'BAD_COORDS' };
  const old = { lat: awc.lat, lng: awc.lng, radius_m: awc.radius_m };
  sh.getRange(row, 5, 1, 3).setValues([[lat, lng, Number(req.radius) || awc.radius_m || 200]]);
  CACHE.remove('awc_' + awcId);
  CACHE.remove('sawcs_' + awc.sector);
  audit_(auth.userId, 'AWC_COORDS_SET', awcId, old, { lat: lat, lng: lng, radius_m: Number(req.radius) || awc.radius_m });
  return { ok: true, awcId: awcId };
}

// ---- admin-only master data ----
function apiUserUpsert_(auth, req) {
  if (auth.user.role !== 'ADMIN') return deny_();
  const r = upsertUser_(req.user || {}, auth.userId);
  return r.error ? { ok: false, code: r.error } : { ok: true, userId: r.userId };
}

function apiImportUsers_(auth, req) {
  if (auth.user.role !== 'ADMIN') return deny_();
  const rows = req.rows || [];
  if (rows.length > 200) return { ok: false, code: 'CHUNK_TOO_BIG', max: 200 };
  const results = [];
  rows.forEach(row => {
    const r = upsertUser_(row, auth.userId);
    results.push(r.error ? { name: row.name, error: r.error } : { name: row.name, userId: r.userId });
  });
  return { ok: true, results: results };
}

function apiSetSchedules_(auth, req) {
  if (auth.user.role !== 'ADMIN') return deny_();
  const rows = (req.rows || []).map(r => [
    String(r.project_code || 'ALL'), String(r.cadre || 'ALL'),
    hmStr_(r.in_start), hmStr_(r.in_end), hmStr_(r.late_after),
    hmStr_(r.out_start), hmStr_(r.out_end)
  ]);
  if (!rows.length) return { ok: false, code: 'EMPTY' };
  const sh = masterSS_().getSheetByName('Schedules');
  const old = sh.getLastRow() >= 2 ? sh.getRange(2, 1, sh.getLastRow() - 1, SCH_H.length).getValues() : [];
  if (sh.getLastRow() >= 2) sh.getRange(2, 1, sh.getLastRow() - 1, SCH_H.length).clearContent();
  sh.getRange(2, 1, rows.length, SCH_H.length).setValues(rows);
  CACHE.remove('schedules');
  audit_(auth.userId, 'SCHEDULES_SET', 'Schedules', old, rows);
  return { ok: true, count: rows.length };
}

/**
 * action: "testReset" — ADMIN only, own marks, today only. Deletes the
 * admin's own IN/OUT rows for today so features can be demonstrated
 * repeatedly. The append-only rule protects real attendance; an admin's
 * test marks are exactly what it does not need to protect. Audit-logged.
 */
function apiTestReset_(auth, req) {
  if (auth.user.role !== 'ADMIN') return deny_();
  const today = fmtDay_(Date.now());
  const compact = today.replace(/-/g, '');
  const ss = getMonthSS_(today.slice(0, 7), true);
  if (!ss) return { ok: true, removed: 0 };
  const sh = ss.getSheetByName('Marks');
  const prefix = String(auth.userId) + '_' + compact + '_';
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let removed = 0;
  try {
    const rows = findRowsByValue_(sh, 2, auth.userId)
      .filter(r => String(sh.getRange(r, 1).getValue()).indexOf(prefix) === 0)
      .sort((a, b) => b - a); // delete bottom-up so row numbers stay valid
    rows.forEach(r => { sh.deleteRow(r); removed++; });
  } finally {
    lock.releaseLock();
  }
  CACHE.remove('mk_' + prefix + 'IN');
  CACHE.remove('mk_' + prefix + 'OUT');
  CACHE.remove('lastm_' + auth.userId);
  CACHE.remove('sumMarker');
  audit_(auth.userId, 'TEST_RESET', prefix + '*', removed + ' rows', '');
  return { ok: true, removed: removed };
}

/**
 * action: "diag" — read-only system doctor, gated by the DIAG_KEY script
 * property (unset = disabled). Lets the maintainer check master-data health
 * and pipeline liveness remotely without Sheet access. Reports misconfigured
 * rows (with name/phone so they can be fixed) but never dumps bulk data.
 */
function apiDiag_(req) {
  const key = PROPS.getProperty('DIAG_KEY');
  if (!key || String(req.key || '') !== key) return { ok: false, code: 'FORBIDDEN' };

  const sectors = {};
  getSectors_().forEach(s => { sectors[s.code] = 1; });
  const awcs = {};
  masterSheetRows_('AWCs', AWC_H).forEach(r => { awcs[String(r[0])] = 1; });

  const roles = {};
  const issues = [];
  let active = 0;
  getUsersAll_().forEach(u => {
    const role = String(u.role);
    roles[role] = (roles[role] || 0) + 1;
    if (String(u.status) !== 'ACTIVE') return;
    active++;
    const base = { id: String(u.user_id), name: String(u.name), phone: String(u.phone),
      role: role, sector: String(u.sector_code), awc: String(u.awc_id) };
    if (role === 'FIELD') {
      if (!sectors[base.sector]) issues.push(Object.assign({ type: 'FIELD_INVALID_SECTOR' }, base));
      else if (!awcs[base.awc]) issues.push(Object.assign({ type: 'FIELD_INVALID_AWC' }, base));
      if (!/^\d{10}$/.test(base.phone)) issues.push(Object.assign({ type: 'NO_VALID_PHONE' }, base));
    }
  });

  const today = fmtDay_(Date.now());
  const ss = getMonthSS_(today.slice(0, 7), true);
  const marksRows = ss ? ss.getSheetByName('Marks').getLastRow() - 1 : 0;

  return {
    ok: true, ts: nowIso_(),
    users: { activeTotal: active, byRole: roles },
    sectors: Object.keys(sectors).length, awcs: Object.keys(awcs).length,
    leavesRows: leavesSheet_().getLastRow() - 1,
    monthMarksRows: marksRows,
    lastSummaryGen: PROPS.getProperty('LAST_GEN') || null,
    holidayToday: holidayFor_(today) || null,
    issues: issues.slice(0, 50), issueCount: issues.length
  };
}

function apiRevoke_(auth, req) {
  if (auth.user.role !== 'ADMIN') return deny_();
  const sh = masterSS_().getSheetByName('Sessions');
  const row = findRowByValue_(sh, 1, String(req.tokenId || ''));
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  sh.getRange(row, 6).setValue('TRUE');
  CACHE.remove('sessok_' + String(req.tokenId));
  audit_(auth.userId, 'TOKEN_REVOKE', String(req.tokenId), '', '');
  return { ok: true };
}

// ---- shared internals (also used by Maintenance.importFromSheets) ----
/**
 * Create or update a user. Update targets `user_id` when given, otherwise a
 * new id is issued. Phone may be blank (7 staff in the source file have no
 * valid mobile — they exist in reports but cannot login until it is fixed).
 */
function upsertUser_(f, actor) {
  const phone = String(f.phone || '').replace(/\D/g, '');
  if (phone && !/^\d{10}$/.test(phone)) return { error: 'BAD_PHONE' };
  const cadre = String(f.cadre || '').trim().toUpperCase();
  if (CADRES.indexOf(cadre) < 0) return { error: 'BAD_CADRE' };
  const role = (String(f.role || 'FIELD').trim().toUpperCase()) || 'FIELD';
  if (ROLES.indexOf(role) < 0) return { error: 'BAD_ROLE' };
  const project = String(f.project_code || '').trim();
  const sector = String(f.sector_code || '').trim();
  const awcId = String(f.awc_id || '').trim();
  if (role === 'FIELD' && !awcId) return { error: 'NO_AWC' };
  if (role === 'SUPERVISOR' && !sector) return { error: 'NO_SECTOR' };
  if (role === 'CDPO' && !project) return { error: 'NO_PROJECT' };

  const givenId = String(f.user_id || '').trim();
  const existing = givenId ? getUserById_(givenId) : null;
  if (givenId && !existing && !f.allowCreateWithId) return { error: 'NO_SUCH_USER' };

  if (existing) {
    const old = { name: existing.name, phone: existing.phone, cadre: existing.cadre,
      project_code: existing.project_code, sector_code: existing.sector_code,
      awc_id: existing.awc_id, role: existing.role, status: existing.status };
    updateUser_(existing, {
      phone: phone, name: String(f.name || existing.name), cadre: cadre,
      project_code: project, sector_code: sector, awc_id: awcId, role: role,
      status: String(f.status || existing.status || 'ACTIVE')
    });
    audit_(actor, 'USER_UPDATE', existing.user_id, old, f);
    return { userId: String(existing.user_id) };
  }

  const userId = givenId || ('U' + pad_(nextSeq_('USER_SEQ'), 4));
  masterSS_().getSheetByName('Users').appendRow([
    userId, phone, String(f.name || ''), cadre, project, sector, awcId, role, 'ACTIVE',
    '', '', '', '0', '', '', '', nowIso_(), nowIso_()
  ]);
  audit_(actor, 'USER_ADD', userId, '', { phone: phone, name: f.name, awc: awcId, sector: sector, role: role });
  return { userId: userId };
}
