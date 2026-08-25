/**
 * Leaves.gs — leave application and management.
 *
 * Applications come from the field app (online only — a leave request is not
 * time-critical the way a mark is). Policy of 2026-08-18: every application
 * is PENDING until the Collector/District Admin decides it from the console
 * (set script property LEAVE_AUTO_APPROVE=1 to restore auto-approval).
 * Rejecting an APPROVED leave retroactively returns those days to absent.
 *
 * Four leave types only (district order 2026-08-22): OPTIONAL holiday 5/yr,
 * CASUAL 6/yr, EARNED 30/yr, SICK (medical) with NO annual day limit.
 * Balances are derived from the Leaves sheet — no separate balance store to
 * drift. PENDING applications hold their days (can't over-apply); a REJECTED
 * application returns them automatically. Only days falling inside the
 * calendar year are counted, so a leave spanning 31-Dec splits correctly.
 *
 * SICK is uncapped per year but MUST carry a government medical certificate:
 * issuing institution + certificate number + a photograph of the certificate
 * (stored in the same Drive tree as attendance photos, so the existing
 * token-checked photo proxy serves it and no Drive link is ever public).
 * Per-application span caps: 31 days for CASUAL/EARNED/OPTIONAL is form
 * sanity. For SICK it is the rule itself - medical leave carries no yearly
 * limit, but no single application may run beyond 15 days (district order
 * 2026-08-25); a longer spell is filed as consecutive applications, each
 * with its own certificate and its own decision.
 *
 * Approved leave days show as ON_LEAVE on the dashboard (instead of "not
 * marked"), grey-blue in the monthly grid, and fill leaveId/leaveType in the
 * register.
 */

const LEAVE_TYPES = ['OPTIONAL', 'CASUAL', 'EARNED', 'SICK'];
// Standing entitlement per calendar year; SICK is uncapped.
const LEAVE_ENT = { CASUAL: 6, EARNED: 30, OPTIONAL: 5 };
// Optional holidays are fixed by the annual GO, so the count is a property of
// the YEAR, not a standing figure. Overriding per year (rather than editing
// LEAVE_ENT) keeps last year's register truthful about last year's rule.
// 2026: cut from 5 to 3 by district order of 2026-08-24.
const LEAVE_ENT_YEAR = {
  '2026': { CASUAL: 6, EARNED: 30, OPTIONAL: 3 }
};

/** The entitlement in force for a calendar year. */
function leaveEnt_(year) {
  return LEAVE_ENT_YEAR[String(year)] || LEAVE_ENT;
}
// Per-application span cap. For CASUAL/EARNED/OPTIONAL this is form sanity.
// For SICK it is the rule: medical leave has no yearly ceiling, but one
// application may not run beyond 15 days (district order 2026-08-25), so a
// long spell arrives in parts and each part is judged on its own certificate.
const LEAVE_MAX_SPAN = { SICK: 15 };
const LEAVE_MAX_SPAN_DEFAULT = 31;
// How far back an application may reach. A government certificate is often
// issued/collected weeks after the illness, so SICK reaches back further.
const LEAVE_BACKDATE_DAYS = { SICK: 90 };
const LEAVE_BACKDATE_DEFAULT = 31;
// An application with no stated reason cannot be judged, so it is refused at
// entry rather than reaching the Collector blank. Three characters is enough
// for "flu" and short enough to keep no legitimate reason out; it only stops
// a full stop or a single keystroke.
const LEAVE_MIN_REASON = 3;
// How many applications one bulk decision may carry. The whole selection is
// written in a single range write, so the cost is the read of the sheet, not
// the count; the cap exists so a runaway click cannot decide a whole year.
const LEAVE_BULK_MAX = 300;
const LEAVE_TYPE_LABEL = { OPTIONAL: 'Optional Holiday', CASUAL: 'Casual Leave',
  EARNED: 'Earned Leave', SICK: 'Medical Leave' };

// Optional Holidays 2026 — G.O.Rt.No.1715 Annexure-II. An employee may take
// at most 5 of these per calendar year, single-day, ONLY on these dates.
const OPTIONAL_HOLIDAYS = {
  '2026-01-01': 'New Year Day',
  '2026-01-03': 'Birthday of Hazrath Ali (R.A)',
  '2026-01-16': 'Kanumu',
  '2026-01-17': 'Shab-e-Meraj',
  '2026-01-23': 'Sri Panchami',
  '2026-02-04': 'Shab-e-Barat',
  '2026-03-10': 'Shahadat Hzt Ali (R.A.)',
  '2026-03-13': 'Jumuatul Wada',
  '2026-03-17': 'Shab-e-Qader',
  '2026-03-31': 'Mahaveer Jayanthi',
  '2026-04-14': "Tamil New Year's Day",
  '2026-04-20': 'Basava Jayanthi',
  '2026-05-01': 'Buddha Purnima',
  '2026-06-04': 'Eid-e-Ghadeer',
  '2026-06-25': '9th Moharram',
  '2026-07-16': 'Ratha Yathra',
  '2026-08-04': 'Arbayeen',
  '2026-08-15': "Parsi New Year's Day",
  '2026-08-21': 'Varalakshmi Vratham',
  '2026-08-28': 'Sravana Purnima / Rakhi Purnima',
  '2026-09-23': 'Yaz Dahum Shareef',
  '2026-10-19': 'Maharnavami',
  '2026-10-26': "Birthday of Hzt. Syed Mohammed Juvanpuri Mahdi Ma'ud (A.S.)",
  '2026-11-08': 'Naraka Chaturdhi',
  '2026-12-24': 'Christmas Eve',
  '2026-12-26': 'Birthday of Hazrath Ali'
};

/**
 * May this user decide leave applications?
 *
 * ADMIN is the approving role, but the right is separable from the role: a
 * district officer can keep full console access and still have leave sanction
 * withdrawn (Users & Admin -> Leave approval). Blank means the role default,
 * so no existing row had to be touched to introduce this.
 */
function canApproveLeave_(u) {
  if (!u || String(u.role) !== 'ADMIN') return false;
  return String(u.can_approve_leave == null ? '' : u.can_approve_leave).trim() !== '0';
}

/** user_id -> display name, for the "decided by" trail. Cheap: one pass. */
function deciderNames_(ids) {
  const out = {};
  ids.forEach(function (id) {
    const key = String(id || '');
    if (!key || out[key] !== undefined) return;
    if (key === 'AUTO') { out[key] = 'auto-approved'; return; }
    const u = getUserById_(key);
    out[key] = u ? String(u.name) : key;
  });
  return out;
}

/**
 * Calendar days of one leave row that fall inside `year` (yyyy). A spell
 * crossing 31-Dec is charged to each year for the part that lies in it —
 * the single place this arithmetic lives, so the app's balance chips, the
 * apply-time check and the console register can never disagree.
 */
function leaveDaysInYear_(l, year) {
  const a = String(l.from_date) < year + '-01-01' ? year + '-01-01' : String(l.from_date);
  const b = String(l.to_date) > year + '-12-31' ? year + '-12-31' : String(l.to_date);
  if (a > b) return 0;
  return (new Date(b).getTime() - new Date(a).getTime()) / 86400000 + 1;
}

/** Per-type leave days used this calendar year (PENDING + APPROVED). */
function leaveBalances_(userId) {
  const year = String(new Date().getFullYear());
  const ent = leaveEnt_(year);
  const used = {};
  getLeavesAll_().forEach(function (l) {
    if (String(l.user_id) !== String(userId)) return;
    if (String(l.status) === 'REJECTED') return;
    const days = leaveDaysInYear_(l, year);
    if (!days) return;
    const t = String(l.type);
    used[t] = (used[t] || 0) + days;
  });
  return {
    year: year,
    casual: { ent: ent.CASUAL, used: used.CASUAL || 0,
      left: Math.max(0, ent.CASUAL - (used.CASUAL || 0)) },
    earned: { ent: ent.EARNED, used: used.EARNED || 0,
      left: Math.max(0, ent.EARNED - (used.EARNED || 0)) },
    optional: { ent: ent.OPTIONAL, used: used.OPTIONAL || 0,
      left: Math.max(0, ent.OPTIONAL - (used.OPTIONAL || 0)) },
    medical: { used: used.SICK || 0 }
  };
}

// action: "leaveBalance"
function apiLeaveBalance_(auth, req) {
  return { ok: true, balances: leaveBalances_(auth.userId) };
}

function leavesSheet_() {
  const ss = masterSS_();
  let sh = ss.getSheetByName('Leaves');
  if (!sh) {
    sh = ss.insertSheet('Leaves');
    sh.getRange(1, 1, 1, LEAVE_H.length).setValues([LEAVE_H]);
    sh.getRange(1, 1, sh.getMaxRows(), LEAVE_H.length).setNumberFormat('@');
  } else if (String(sh.getRange(1, LEAVE_H.length).getValue()) !== LEAVE_H[LEAVE_H.length - 1]) {
    // Sheet written by a build before the medical-certificate columns: heal
    // the header. Columns were only ever APPENDED, so old rows stay aligned.
    sh.getRange(1, 1, 1, LEAVE_H.length).setValues([LEAVE_H]);
    sh.getRange(1, 1, sh.getMaxRows(), LEAVE_H.length).setNumberFormat('@');
  }
  return sh;
}

function getLeavesAll_() {
  const c = CACHE.get('leaves');
  if (c) return JSON.parse(c);
  const sh = leavesSheet_();
  const last = sh.getLastRow();
  const out = last < 2 ? [] : sh.getRange(2, 1, last - 1, LEAVE_H.length).getValues()
    .map((r, i) => {
      const o = rowToObj_(LEAVE_H, r);
      o._row = i + 2;
      return o;
    });
  CACHE.put('leaves', JSON.stringify(out), 300);
  return out;
}

/** APPROVED leaves overlapping [fromStr..toStr] (yyyy-MM-dd, inclusive). */
function leavesOverlapping_(fromStr, toStr) {
  return getLeavesAll_().filter(l =>
    String(l.status) === 'APPROVED' &&
    String(l.from_date) <= toStr && String(l.to_date) >= fromStr);
}

// action: "leaveApply"
// req: { token, from, to, type, reason,
//        medInstitution, medCertNo, medPhotoB64 }   <- SICK only, all three required
function apiLeaveApply_(auth, req) {
  const from = String(req.from || '').trim();
  const to = String(req.to || '').trim();
  const type = String(req.type || '').trim().toUpperCase();
  const reason = String(req.reason || '').trim().slice(0, 200);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return { ok: false, code: 'BAD_DATE' };
  }
  if (from > to) return { ok: false, code: 'FROM_AFTER_TO' };
  // Type is validated BEFORE the span/backdate caps because both are per-type.
  if (LEAVE_TYPES.indexOf(type) < 0) return { ok: false, code: 'BAD_TYPE', types: LEAVE_TYPES };
  // The reason is what the Collector actually decides on. Refusing here is
  // correct: it is a required field on the application, not a data-quality flag.
  if (reason.length < LEAVE_MIN_REASON) {
    return { ok: false, code: 'REASON_REQUIRED', minChars: LEAVE_MIN_REASON };
  }
  const spanDays = (new Date(to).getTime() - new Date(from).getTime()) / 86400000 + 1;
  const maxSpan = LEAVE_MAX_SPAN[type] || LEAVE_MAX_SPAN_DEFAULT;
  if (spanDays > maxSpan) {
    return { ok: false, code: 'TOO_LONG', maxDays: maxSpan, type: type };
  }
  const backDays = LEAVE_BACKDATE_DAYS[type] || LEAVE_BACKDATE_DEFAULT;
  if (to < fmtDay_(Date.now() - backDays * 86400000)) {
    return { ok: false, code: 'TOO_OLD', maxBackDays: backDays };
  }

  const mine = getLeavesAll_().filter(l => String(l.user_id) === String(auth.userId) &&
    String(l.status) !== 'REJECTED' && String(l.from_date) <= to && String(l.to_date) >= from);
  if (mine.length) return { ok: false, code: 'OVERLAPS_EXISTING' };

  // Optional Holiday: single day, only on an Annexure-II date, max 5/year.
  if (type === 'OPTIONAL') {
    if (from !== to) return { ok: false, code: 'OPT_SINGLE_DAY' };
    if (!OPTIONAL_HOLIDAYS[from]) return { ok: false, code: 'BAD_OPT_DATE' };
  }

  // Medical leave: uncapped in days, but the district accepts it ONLY against
  // a certificate issued by a government institution. All three parts are
  // mandatory — refusing here is correct: this is a document requirement, not
  // a data-quality flag.
  let medInst = '', medCert = '', medB64 = '';
  if (type === 'SICK') {
    medInst = String(req.medInstitution || '').trim().slice(0, 120);
    medCert = String(req.medCertNo || '').trim().slice(0, 60);
    medB64 = String(req.medPhotoB64 || '');
    if (!medInst) return { ok: false, code: 'MED_INSTITUTION_REQUIRED' };
    if (!medCert) return { ok: false, code: 'MED_CERT_NO_REQUIRED' };
    if (!medB64) return { ok: false, code: 'MED_PHOTO_REQUIRED' };
  }

  const bal = leaveBalances_(auth.userId);
  if (type === 'CASUAL' && spanDays > bal.casual.left) {
    return { ok: false, code: 'NO_BALANCE', type: 'CASUAL', left: bal.casual.left };
  }
  if (type === 'EARNED' && spanDays > bal.earned.left) {
    return { ok: false, code: 'NO_BALANCE', type: 'EARNED', left: bal.earned.left };
  }
  if (type === 'OPTIONAL' && spanDays > bal.optional.left) {
    return { ok: false, code: 'NO_BALANCE', type: 'OPTIONAL', left: bal.optional.left };
  }

  const status = PROPS.getProperty('LEAVE_AUTO_APPROVE') === '1' ? 'APPROVED' : 'PENDING';
  const leaveId = 'LV-' + Utilities.getUuid().slice(0, 8);

  // Drive write happens BEFORE the lock (Drive doesn't contend, and holding a
  // script lock across an upload is what serialises 400 phones). The file name
  // starts with the user_id because apiPhoto_ authorises on that prefix.
  let medPhotoId = '';
  if (medB64) {
    try {
      medPhotoId = storePhoto_(fmtDay_(Date.now()).replace(/-/g, ''),
        String(auth.userId) + '_LVCERT_' + leaveId, medB64);
    } catch (e) {
      // The certificate IS the application — no silent half-saved row.
      return { ok: false, code: 'MED_UPLOAD_FAILED' };
    }
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    leavesSheet_().appendRow([leaveId, String(auth.userId), from, to, type, reason,
      status, nowIso_(), status === 'APPROVED' ? 'AUTO' : '', status === 'APPROVED' ? nowIso_() : '',
      medInst, medCert, medPhotoId]);
  } finally {
    lock.releaseLock();
  }
  CACHE.remove('leaves');
  audit_(auth.userId, 'LEAVE_APPLY', leaveId, '', { from: from, to: to, type: type, status: status });
  return { ok: true, leaveId: leaveId, status: status, balances: leaveBalances_(auth.userId) };
}

// action: "myLeaves"
function apiMyLeaves_(auth, req) {
  const rows = getLeavesAll_().filter(l => String(l.user_id) === String(auth.userId))
    .slice(-20).reverse();
  // Resolved server-side: the field app has no name map, and a worker is
  // entitled to see WHO decided her leave, not a bare user id.
  const who = deciderNames_(rows.map(l => l.decided_by));
  const mine = rows
    .map(l => ({ id: String(l.leave_id), from: String(l.from_date), to: String(l.to_date),
      type: String(l.type), reason: String(l.reason), status: String(l.status),
      mi: String(l.med_institution || ''), mc: String(l.med_cert_no || ''),
      mp: String(l.med_photo_id || ''),
      by: String(l.decided_by || ''), byName: who[String(l.decided_by || '')] || '',
      byAt: String(l.decided_at || '') }));
  const optionalDays = Object.keys(OPTIONAL_HOLIDAYS).sort()
    .map(function (d) { return { d: d, n: OPTIONAL_HOLIDAYS[d] }; });
  return { ok: true, leaves: mine, balances: leaveBalances_(auth.userId),
    optionalDays: optionalDays };
}

// action: "leaveList" (console roles; scoped like everything else)
function apiLeaveList_(auth, req) {
  if (!isConsoleRole_(auth.user)) return deny_();
  const scope = sectorScope_(auth.user);
  const users = {};
  getUsersAll_().forEach(u => { users[String(u.user_id)] = u; });
  const picked = getLeavesAll_().filter(l => {
    const u = users[String(l.user_id)];
    return u && (!scope || scope.indexOf(String(u.sector_code)) >= 0);
  }).slice(-300).reverse();
  // Deciders are ADMINs with no sector, so a supervisor's scoped name map
  // cannot resolve them — the name has to come from the server.
  const who = deciderNames_(picked.map(l => l.decided_by));
  const rows = picked.map(l => ({
    id: String(l.leave_id), u: String(l.user_id), from: String(l.from_date),
    to: String(l.to_date), type: String(l.type), reason: String(l.reason),
    status: String(l.status), at: String(l.applied_at),
    mi: String(l.med_institution || ''), mc: String(l.med_cert_no || ''),
    mp: String(l.med_photo_id || ''),
    by: String(l.decided_by || ''), byName: who[String(l.decided_by || '')] || '',
    byAt: String(l.decided_at || '')
  }));
  return { ok: true, leaves: rows };
}

// action: "leaveRegister"  req: { token, year? }
// The annual leave register: entitlement / taken / balance per type for every
// user in the viewer's scope, plus that year's applications. Entitlements and
// day arithmetic are computed HERE, never in the console — one source of truth
// so the field app's balance chips and the register always agree.
function apiLeaveRegister_(auth, req) {
  if (!isConsoleRole_(auth.user)) return deny_();
  const year = /^\d{4}$/.test(String(req.year || ''))
    ? String(req.year) : String(new Date().getFullYear());
  const scope = sectorScope_(auth.user);
  const users = {};
  getUsersAll_().forEach(function (u) {
    if (scope && scope.indexOf(String(u.sector_code)) < 0) return;
    users[String(u.user_id)] = u;
  });

  // Only users with activity carry a row; the console fills everyone else in
  // from its own name map at full balance. That keeps this response small
  // (~1,400 in-scope users would otherwise be ~200 KB of mostly zeroes).
  const stat = {};
  const apps = [];
  const who = deciderNames_(getLeavesAll_().map(function (l) { return l.decided_by; }));
  getLeavesAll_().forEach(function (l) {
    const uid = String(l.user_id);
    if (!users[uid]) return;
    const days = leaveDaysInYear_(l, year);
    if (!days) return;
    const st = String(l.status);
    const t = String(l.type);
    const row = stat[uid] || (stat[uid] = { u: uid, taken: {}, pend: {}, rej: {} });
    const bucket = st === 'APPROVED' ? row.taken : st === 'REJECTED' ? row.rej : row.pend;
    bucket[t] = (bucket[t] || 0) + days;
    apps.push({
      id: String(l.leave_id), u: uid, from: String(l.from_date), to: String(l.to_date),
      days: days, type: t, reason: String(l.reason), status: st,
      at: String(l.applied_at), by: String(l.decided_by || ''),
      byName: who[String(l.decided_by || '')] || '', byAt: String(l.decided_at || ''),
      mi: String(l.med_institution || ''), mc: String(l.med_cert_no || ''),
      mp: String(l.med_photo_id || '')
    });
  });
  apps.sort(function (a, b) { return a.from < b.from ? 1 : a.from > b.from ? -1 : 0; });

  return {
    ok: true, year: year, ent: leaveEnt_(year), types: LEAVE_TYPES,
    labels: LEAVE_TYPE_LABEL, uncapped: ['SICK'],
    rows: Object.keys(stat).map(function (k) { return stat[k]; }),
    apps: apps
  };
}

// action: "leaveDecide"  req: { token, leaveId, decision: APPROVED|REJECTED, reason? }
// Collector / District Admin only — supervisors see leaves but cannot decide.
function apiLeaveDecide_(auth, req) {
  if (String(auth.user.role) !== 'ADMIN') return deny_();
  // Separable from the role: an ADMIN whose leave sanction has been withdrawn
  // keeps every other power and is told plainly why this one is refused.
  if (!canApproveLeave_(auth.user)) return { ok: false, code: 'NOT_LEAVE_APPROVER' };
  const decision = String(req.decision || '').toUpperCase();
  if (decision !== 'APPROVED' && decision !== 'REJECTED') return { ok: false, code: 'BAD_DECISION' };
  const leave = getLeavesAll_().find(l => String(l.leave_id) === String(req.leaveId || ''));
  if (!leave) return { ok: false, code: 'NOT_FOUND' };
  const target = getUserById_(String(leave.user_id));
  if (!target || !inScope_(auth.user, target)) return deny_();
  const sh = leavesSheet_();
  sh.getRange(leave._row, 7).setValue(decision);                    // status
  sh.getRange(leave._row, 9, 1, 2).setValues([[String(auth.userId), nowIso_()]]); // decided_by, decided_at
  CACHE.remove('leaves');
  audit_(auth.userId, 'LEAVE_' + decision, String(leave.leave_id),
    String(leave.status), String(req.reason || ''));
  return { ok: true, by: String(auth.userId), byName: String(auth.user.name) };
}

// action: "leaveDecideBulk"
// req: { token, leaveIds: [..] or "id,id,id", decision: APPROVED|REJECTED, reason? }
//
// One decision over a whole selection. Every guard from apiLeaveDecide_ is
// re-applied PER LEAVE - a list is not a way to reach outside your scope - and
// each leave still gets its own audit row with its own prior value.
function apiLeaveDecideBulk_(auth, req) {
  if (String(auth.user.role) !== 'ADMIN') return deny_();
  if (!canApproveLeave_(auth.user)) return { ok: false, code: 'NOT_LEAVE_APPROVER' };
  const decision = String(req.decision || '').toUpperCase();
  if (decision !== 'APPROVED' && decision !== 'REJECTED') return { ok: false, code: 'BAD_DECISION' };
  const ids = (Array.isArray(req.leaveIds) ? req.leaveIds : String(req.leaveIds || '').split(','))
    .map(function (x) { return String(x).trim(); }).filter(Boolean);
  if (!ids.length) return { ok: false, code: 'NOTHING_SELECTED' };
  if (ids.length > LEAVE_BULK_MAX) return { ok: false, code: 'TOO_MANY', max: LEAVE_BULK_MAX };

  const byId = {};
  getLeavesAll_().forEach(function (l) { byId[String(l.leave_id)] = l; });

  const targets = [], skipped = [];
  ids.forEach(function (id) {
    const l = byId[id];
    if (!l) { skipped.push({ id: id, why: 'NOT_FOUND' }); return; }
    const t = getUserById_(String(l.user_id));
    if (!t || !inScope_(auth.user, t)) { skipped.push({ id: id, why: 'OUT_OF_SCOPE' }); return; }
    if (String(l.status) === decision) { skipped.push({ id: id, why: 'ALREADY' }); return; }
    targets.push(l);
  });
  if (!targets.length) return { ok: true, changed: 0, skipped: skipped };

  const ts = nowIso_();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let changed = 0;
  try {
    const sh = leavesSheet_();
    const last = sh.getLastRow();
    if (last < 2) return { ok: false, code: 'NOT_FOUND' };
    // One read and one write for the entire selection. 300 individual
    // setValue calls would hold the script lock for ~15 s and stall every
    // phone syncing behind it; this holds it for two Sheets round trips.
    const rng = sh.getRange(2, 7, last - 1, 4);      // status, applied_at, decided_by, decided_at
    const block = rng.getValues();
    targets.forEach(function (l) {
      const i = l._row - 2;
      if (i < 0 || i >= block.length) {              // cache older than the sheet
        skipped.push({ id: String(l.leave_id), why: 'MOVED' });
        return;
      }
      block[i][0] = decision;
      block[i][2] = String(auth.userId);
      block[i][3] = ts;
      changed++;
    });
    rng.setValues(block);
  } finally {
    lock.releaseLock();
  }
  CACHE.remove('leaves');

  // One audit row per leave, written in one append: the trail must name each
  // application and the status it held before, exactly as a single decision does.
  auditMany_(targets.map(function (l) {
    return { actor: auth.userId, action: 'LEAVE_' + decision, target: String(l.leave_id),
      oldValue: String(l.status), newValue: String(req.reason || 'bulk decision') };
  }));

  return { ok: true, changed: changed, skipped: skipped,
    by: String(auth.userId), byName: String(auth.user.name), at: ts };
}
