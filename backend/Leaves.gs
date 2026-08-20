/**
 * Leaves.gs — leave application and management.
 *
 * Applications come from the field app (online only — a leave request is not
 * time-critical the way a mark is). Policy of 2026-08-18: every application
 * is PENDING until the Collector/District Admin decides it from the console
 * (set script property LEAVE_AUTO_APPROVE=1 to restore auto-approval).
 * Rejecting an APPROVED leave retroactively returns those days to absent.
 *
 * Annual entitlements (calendar year, calendar days): CASUAL 6, EARNED 30,
 * SICK/medical uncapped. Balances are derived from the Leaves sheet — no
 * separate balance store to drift. PENDING applications hold their days
 * (can't over-apply); a REJECTED application returns them automatically.
 *
 * Approved leave days show as ON_LEAVE on the dashboard (instead of "not
 * marked"), grey-blue in the monthly grid, and fill leaveId/leaveType in the
 * register.
 */

const LEAVE_TYPES = ['CASUAL', 'SICK', 'EARNED', 'MATERNITY', 'OTHER', 'OPTIONAL'];
const LEAVE_ENT = { CASUAL: 6, EARNED: 30, OPTIONAL: 5 }; // per calendar year; SICK uncapped

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

/** Per-type leave days used this calendar year (PENDING + APPROVED). */
function leaveBalances_(userId) {
  const year = String(new Date().getFullYear());
  const used = {};
  getLeavesAll_().forEach(function (l) {
    if (String(l.user_id) !== String(userId)) return;
    if (String(l.status) === 'REJECTED') return;
    const a = String(l.from_date) < year + '-01-01' ? year + '-01-01' : String(l.from_date);
    const b = String(l.to_date) > year + '-12-31' ? year + '-12-31' : String(l.to_date);
    if (a > b) return;
    const days = (new Date(b).getTime() - new Date(a).getTime()) / 86400000 + 1;
    const t = String(l.type);
    used[t] = (used[t] || 0) + days;
  });
  return {
    year: year,
    casual: { ent: LEAVE_ENT.CASUAL, used: used.CASUAL || 0,
      left: Math.max(0, LEAVE_ENT.CASUAL - (used.CASUAL || 0)) },
    earned: { ent: LEAVE_ENT.EARNED, used: used.EARNED || 0,
      left: Math.max(0, LEAVE_ENT.EARNED - (used.EARNED || 0)) },
    optional: { ent: LEAVE_ENT.OPTIONAL, used: used.OPTIONAL || 0,
      left: Math.max(0, LEAVE_ENT.OPTIONAL - (used.OPTIONAL || 0)) },
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

// action: "leaveApply"  req: { token, from, to, type, reason }
function apiLeaveApply_(auth, req) {
  const from = String(req.from || '').trim();
  const to = String(req.to || '').trim();
  const type = String(req.type || '').trim().toUpperCase();
  const reason = String(req.reason || '').trim().slice(0, 200);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return { ok: false, code: 'BAD_DATE' };
  }
  if (from > to) return { ok: false, code: 'FROM_AFTER_TO' };
  const spanDays = (new Date(to).getTime() - new Date(from).getTime()) / 86400000 + 1;
  if (spanDays > 31) return { ok: false, code: 'TOO_LONG', maxDays: 31 };
  if (to < fmtDay_(Date.now() - 31 * 86400000)) return { ok: false, code: 'TOO_OLD' };
  if (LEAVE_TYPES.indexOf(type) < 0) return { ok: false, code: 'BAD_TYPE', types: LEAVE_TYPES };

  const mine = getLeavesAll_().filter(l => String(l.user_id) === String(auth.userId) &&
    String(l.status) !== 'REJECTED' && String(l.from_date) <= to && String(l.to_date) >= from);
  if (mine.length) return { ok: false, code: 'OVERLAPS_EXISTING' };

  // Optional Holiday: single day, only on an Annexure-II date, max 5/year.
  if (type === 'OPTIONAL') {
    if (from !== to) return { ok: false, code: 'OPT_SINGLE_DAY' };
    if (!OPTIONAL_HOLIDAYS[from]) return { ok: false, code: 'BAD_OPT_DATE' };
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
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    leavesSheet_().appendRow([leaveId, String(auth.userId), from, to, type, reason,
      status, nowIso_(), status === 'APPROVED' ? 'AUTO' : '', status === 'APPROVED' ? nowIso_() : '']);
  } finally {
    lock.releaseLock();
  }
  CACHE.remove('leaves');
  audit_(auth.userId, 'LEAVE_APPLY', leaveId, '', { from: from, to: to, type: type, status: status });
  return { ok: true, leaveId: leaveId, status: status, balances: leaveBalances_(auth.userId) };
}

// action: "myLeaves"
function apiMyLeaves_(auth, req) {
  const mine = getLeavesAll_().filter(l => String(l.user_id) === String(auth.userId))
    .slice(-20).reverse()
    .map(l => ({ id: String(l.leave_id), from: String(l.from_date), to: String(l.to_date),
      type: String(l.type), reason: String(l.reason), status: String(l.status) }));
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
  const rows = getLeavesAll_().filter(l => {
    const u = users[String(l.user_id)];
    return u && (!scope || scope.indexOf(String(u.sector_code)) >= 0);
  }).slice(-300).reverse().map(l => ({
    id: String(l.leave_id), u: String(l.user_id), from: String(l.from_date),
    to: String(l.to_date), type: String(l.type), reason: String(l.reason),
    status: String(l.status), at: String(l.applied_at)
  }));
  return { ok: true, leaves: rows };
}

// action: "leaveDecide"  req: { token, leaveId, decision: APPROVED|REJECTED, reason? }
// Collector / District Admin only — supervisors see leaves but cannot decide.
function apiLeaveDecide_(auth, req) {
  if (String(auth.user.role) !== 'ADMIN') return deny_();
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
  return { ok: true };
}
