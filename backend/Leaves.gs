/**
 * Leaves.gs — leave application and management.
 *
 * Applications come from the field app (online only — a leave request is not
 * time-critical the way a mark is). Script property LEAVE_AUTO_APPROVE
 * (default on) approves applications immediately per district policy of
 * 2026-08-08 ("no one to approve"); admins can still REJECT one later from
 * the console, which retroactively returns those days to absent.
 *
 * Approved leave days show as ON_LEAVE on the dashboard (instead of "not
 * marked"), grey-blue in the monthly grid, and fill leaveId/leaveType in the
 * register.
 */

const LEAVE_TYPES = ['CASUAL', 'SICK', 'EARNED', 'MATERNITY', 'OTHER'];

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

  const status = PROPS.getProperty('LEAVE_AUTO_APPROVE') === '0' ? 'PENDING' : 'APPROVED';
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
  return { ok: true, leaveId: leaveId, status: status };
}

// action: "myLeaves"
function apiMyLeaves_(auth, req) {
  const mine = getLeavesAll_().filter(l => String(l.user_id) === String(auth.userId))
    .slice(-20).reverse()
    .map(l => ({ id: String(l.leave_id), from: String(l.from_date), to: String(l.to_date),
      type: String(l.type), reason: String(l.reason), status: String(l.status) }));
  return { ok: true, leaves: mine };
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
function apiLeaveDecide_(auth, req) {
  if (!isConsoleRole_(auth.user)) return deny_();
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
