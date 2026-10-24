/**
 * FeatureNotices.gs — the notice ladder: a reminder on the first and second
 * unmarked day of the month, a PROPOSED show-cause notice from the third,
 * served by the district from the console and acknowledged on the phone.
 *
 * Ported from the SJGP register, reduced. OFF BY DEFAULT: the module is in
 * FEATURE_DEFAULT_OFF (Features.gs) and carries nothing until the script
 * property FEATURE_ON names it ("notices"). The district switches it on by
 * an order, not by a deploy; the Health screen says which state it is in.
 *
 * THE LADDER, day by day. The daily round (featureDaily, ~07:00) reads the
 * PREVIOUS WORKING DAY, once: a row already on the register for that person
 * and that day is left alone, so a re-fired trigger adds nothing.
 *   - on sanctioned leave, or a holiday, or a Sunday: nothing;
 *   - an IN mark on the day: nothing, however late (late is the console's
 *     business, not the ladder's);
 *   - no IN mark: the month's unmarked working days are counted off the
 *     record itself, that day included. Fewer than NTC_SCN_FROM_MISS →
 *     a REMINDER row, which the phone shows as a card and nothing more.
 *     NTC_SCN_FROM_MISS or more → a SHOWCAUSE row, PROPOSED.
 *
 * NOTHING IS SERVED BY A MACHINE. A proposal waits for the district's ADMIN
 * in the console. Serving re-reads attendance for that day first: anyone
 * whose phone reached the district in the meantime is DROPPED by the
 * register itself. A served notice is numbered (SCN/yyyy/n), locks the app
 * on that phone except for marking attendance — which is the cure and is
 * never blocked — and lifts the moment it is acknowledged there; the
 * acknowledgement travels when the signal returns, as a mark does.
 *
 * NO CASUAL LEAVE IS DEBITED. The SJGP register debits a day of CL from the
 * third miss; this register does not, by design: leave here is applied for
 * and sanctioned on its own ledger, and a debit by rule is a sanction this
 * district has not ordered. If it ever does, it is a separate change.
 *
 * Everything is one sheet, 'Notices', one row per person per day, kind
 * REMINDER (status SENT) or SHOWCAUSE (PROPOSED → SERVED → ACK, or DROPPED).
 * Serving, dropping and acknowledging are audited.
 */
var NTC_H = ['notice_id', 'user_id', 'date', 'kind', 'seq', 'status', 'issued_at',
  'served_at', 'served_by', 'notice_no', 'ack_at', 'ack_note', 'ack_received_at', 'dropped_at', 'dropped_by'];
var NTC_SCN_FROM_MISS = 3;     // misses 1 and 2 remind; the 3rd proposes a notice
var NTC_MINE_DAYS = 45;        // how far back the phone is shown its reminders
var NTC_MAX_DECIDE = 200;

function feature_notices() {
  return {
    title: 'The notice ladder: two reminders, then a show-cause proposed for the district to serve (no leave is debited)',
    actions: {
      // action: "notices"  req: { token }
      notices: function (auth, req) {
        const role = String(auth.user.role);
        if (role === 'ADMIN' || role === 'CDPO') return ntcRegister_(auth.user);
        if (role === 'SUPERVISOR') return deny_();
        return ntcMine_(auth.user);
      },
      // action: "noticeDecide"  req: { token, serve:[ids], drop:[ids] }  (ADMIN)
      noticeDecide: function (auth, req) {
        if (String(auth.user.role) !== 'ADMIN') return deny_();
        return ntcDecide_(auth, req || {});
      },
      // action: "noticeAck"  req: { token, acks:[{id, at, note}] }  (the phone)
      noticeAck: function (auth, req) {
        if (String(auth.user.role) !== 'FIELD') return deny_();
        return ntcAck_(auth, req || {});
      }
    },
    daily: function () { return ntcDailyPass_(); }
  };
}

function ntcSheet_() {
  const ss = masterSS_();
  let sh = ss.getSheetByName('Notices');
  if (!sh) {
    sh = ss.insertSheet('Notices');
    sh.getRange(1, 1, 1, NTC_H.length).setValues([NTC_H]);
    sh.getRange('A:O').setNumberFormat('@');
  }
  return sh;
}
function ntcAll_() {
  const sh = ntcSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, NTC_H.length).getValues().map(function (r, i) {
    const o = rowToObj_(NTC_H, r);
    Object.keys(o).forEach(function (k) { o[k] = o[k] == null ? '' : String(o[k]); });
    o._row = i + 2;
    return o;
  });
}

/** The working day before `today`: back over Sundays and holidays. */
function ntcPrevWorkingDay_(today) {
  let t = new Date(today + 'T12:00:00+05:30').getTime();
  for (let i = 0; i < 14; i++) {
    t -= 86400000;
    const d = fmtDay_(t);
    if (!holidayFor_(d)) return d;
  }
  return null;
}

/** uid|date → true for every IN mark of the month workbook that holds `ym`. */
function ntcInMarks_(ym) {
  const out = {};
  const ss = getMonthSS_(ym, true);
  if (!ss) return out;
  const sh = ss.getSheetByName('Marks');
  const last = sh ? sh.getLastRow() : 0;
  if (last < 2) return out;
  // key, user_id and type are the first five columns; nothing else is needed
  sh.getRange(2, 1, last - 1, 5).getValues().forEach(function (v) {
    if (String(v[4]) !== 'IN') return;
    const p = String(v[0]).split('_');
    if (p.length < 3 || p[1].length !== 8) return;
    out[String(v[1]) + '|' + p[1].slice(0, 4) + '-' + p[1].slice(4, 6) + '-' + p[1].slice(6, 8)] = true;
  });
  return out;
}

/** uid|date → true for every day of [from..to] under an APPROVED leave. */
function ntcLeaveDays_(from, to) {
  const out = {};
  leavesOverlapping_(from, to).forEach(function (l) {
    const f = String(l.from_date), t = String(l.to_date) || f;
    for (let ms = new Date(from + 'T12:00:00+05:30').getTime(); fmtDay_(ms) <= to; ms += 86400000) {
      const d = fmtDay_(ms);
      if (d >= f && d <= t) out[String(l.user_id) + '|' + d] = true;
    }
  });
  return out;
}

/**
 * The daily pass, for the previous working day. Idempotent per person per
 * day. Returns one line for the featureDaily log.
 */
function ntcDailyPass_(dayOpt) {
  const today = fmtDay_(Date.now());
  const day = dayOpt || ntcPrevWorkingDay_(today);
  if (!day) return 'no working day to read';
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const have = {};
    ntcAll_().forEach(function (n) { if (n.date === day) have[n.user_id] = true; });
    const monthStart = day.slice(0, 8) + '01';
    const marks = ntcInMarks_(day.slice(0, 7));
    const leave = ntcLeaveDays_(monthStart, day);
    // the month's working days up to and including the day
    const workdays = [];
    for (let ms = new Date(monthStart + 'T12:00:00+05:30').getTime(); fmtDay_(ms) <= day; ms += 86400000) {
      const d = fmtDay_(ms);
      if (!holidayFor_(d)) workdays.push(d);
    }
    const sh = ntcSheet_();
    const now = nowIso_();
    let reminders = 0, proposed = 0;
    getUsersAll_().forEach(function (u) {
      const uid = String(u.user_id);
      if (String(u.role) !== 'FIELD' || String(u.status) !== 'ACTIVE') return;
      if (have[uid]) return;                                  // already read for this day
      if (leave[uid + '|' + day] || marks[uid + '|' + day]) return;
      let miss = 0;
      workdays.forEach(function (d) { if (!leave[uid + '|' + d] && !marks[uid + '|' + d]) miss++; });
      if (miss < NTC_SCN_FROM_MISS) {
        sh.appendRow(['REM-' + day + '-' + uid, uid, day, 'REMINDER', miss, 'SENT', now, '', '', '', '', '', '', '', '']);
        reminders++;
      } else {
        sh.appendRow(['NTC-' + day + '-' + uid, uid, day, 'SHOWCAUSE', miss, 'PROPOSED', now, '', '', '', '', '', '', '', '']);
        proposed++;
      }
    });
    return day + ': ' + reminders + ' reminder(s), ' + proposed + ' notice(s) proposed';
  } finally {
    lock.releaseLock();
  }
}

/** What the phone is shown: recent reminders, and every notice on her file. */
function ntcMine_(u) {
  const uid = String(u.user_id);
  const since = fmtDay_(Date.now() - NTC_MINE_DAYS * 86400000);
  const reminders = [], notices = [];
  ntcAll_().forEach(function (n) {
    if (n.user_id !== uid) return;
    if (n.kind === 'REMINDER') { if (n.date >= since) reminders.push({ id: n.notice_id, date: n.date, seq: Number(n.seq) || 0 }); return; }
    if (n.status === 'PROPOSED' || n.status === 'DROPPED') return;   // nothing is shown until it is served
    notices.push({ id: n.notice_id, date: n.date, seq: Number(n.seq) || 0, status: n.status, no: n.notice_no,
      servedAt: n.served_at, ackAt: n.ack_at, ackNote: n.ack_note, text: ntcText_(u, n) });
  });
  reminders.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  notices.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  return { ok: true, at: nowIso_(), reminders: reminders.slice(0, 10), notices: notices,
    pending: notices.filter(function (n) { return n.status === 'SERVED'; }).length, scnFrom: NTC_SCN_FROM_MISS };
}

/** The notice as served, in words. The signatory is a script property so the order reads as the district's. */
function ntcText_(u, n) {
  const dmy = String(n.date).split('-').reverse().join('.');
  const signatory = PROPS.getProperty('NOTICE_SIGNATORY') || 'District Welfare Officer, Women Development & Child Welfare, Jangaon District';
  const a = u.awc_id ? getAwc_(String(u.awc_id)) : null;
  return 'GOVERNMENT OF TELANGANA\nWOMEN DEVELOPMENT & CHILD WELFARE DEPARTMENT :: JANGAON DISTRICT\n' +
    (n.notice_no ? 'Notice No. ' + n.notice_no + '    ' : '') + 'Dated: ' + String(n.served_at || '').slice(0, 10).split('-').reverse().join('.') + '\n\nSHOW CAUSE NOTICE\n\n' +
    'Sub: Sisu Mahila Samridhi – Daily attendance in the attendance app – Failure to mark attendance on ' + dmy +
    ' – Explanation called for within 48 hours – Regarding.\n\nTo\n' + String(u.name) + ', ' + String(u.cadre) + (a ? ', ' + a.name : '') + '.\n\n' +
    '1. Every functionary is required to mark daily attendance in the app, with photograph and location, from the centre, in terms of the standing instructions.\n' +
    '2. On verification of the attendance record for ' + dmy + ', it is noticed that you did not mark attendance on that date. This is the ' + n.seq +
    (n.seq === '1' ? 'st' : n.seq === '2' ? 'nd' : n.seq === '3' ? 'rd' : 'th') + ' unmarked working day of the calendar month; reminders were shown in the app on the earlier ones.\n' +
    '3. Non-marking of attendance as mandated amounts to unauthorised absence from assigned duty and prima facie constitutes dereliction of duty.\n' +
    '4. You are directed to acknowledge this notice in the app and to submit your written explanation within 48 (forty-eight) hours as to why disciplinary action should not be initiated. If sanctioned leave, prior permission, or a verifiable technical difficulty is claimed, documentary proof shall be enclosed.\n' +
    '5. The app remains locked, except for marking attendance, until this notice is acknowledged in it.\n\n' + signatory + '.';
}

/** The register: proposals waiting, notices served and acknowledged, reminders of the week. A CDPO sees her project. */
function ntcRegister_(u) {
  const project = String(u.role) === 'CDPO' ? String(u.project_code) : null;
  const roll = {};
  getUsersAll_().forEach(function (x) { roll[String(x.user_id)] = x; });
  const who = function (uid) {
    const x = roll[uid] || {};
    const a = x.awc_id ? getAwc_(String(x.awc_id)) : null;
    return { uid: uid, name: String(x.name || uid), cadre: String(x.cadre || ''), sector: String(x.sector_code || ''), awc: a ? a.name : '', project: String(x.project_code || '') };
  };
  const weekAgo = fmtDay_(Date.now() - 7 * 86400000);
  const out = { ok: true, at: nowIso_(), proposed: [], served: [], acked: [], dropped: 0, remindersWeek: 0, scnFrom: NTC_SCN_FROM_MISS };
  ntcAll_().forEach(function (n) {
    const w = who(n.user_id);
    if (project && w.project !== project) return;
    if (n.kind === 'REMINDER') { if (n.date >= weekAgo) out.remindersWeek++; return; }
    const row = Object.assign(w, { id: n.notice_id, date: n.date, seq: Number(n.seq) || 0, status: n.status, no: n.notice_no,
      issuedAt: n.issued_at, servedAt: n.served_at, servedBy: n.served_by, ackAt: n.ack_at, ackNote: n.ack_note, ackReceivedAt: n.ack_received_at });
    if (n.status === 'PROPOSED') out.proposed.push(row);
    else if (n.status === 'SERVED') out.served.push(row);
    else if (n.status === 'ACK') out.acked.push(row);
    else if (n.status === 'DROPPED') out.dropped++;
  });
  const newest = function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; };
  out.proposed.sort(newest); out.served.sort(newest); out.acked.sort(newest);
  out.acked = out.acked.slice(0, 200);
  return out;
}

/** Serve or drop, by id. Serving re-reads attendance for the day first. */
function ntcDecide_(auth, b) {
  const serve = Array.isArray(b.serve) ? b.serve.slice(0, NTC_MAX_DECIDE).map(String) : [];
  const drop = Array.isArray(b.drop) ? b.drop.slice(0, NTC_MAX_DECIDE).map(String) : [];
  if (!serve.length && !drop.length) return { ok: false, code: 'NOTHING_TO_DECIDE' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = ntcSheet_();
    const byId = {};
    ntcAll_().forEach(function (n) { byId[n.notice_id] = n; });
    const marksByYm = {};
    const marked = function (uid, date) {
      const ym = date.slice(0, 7);
      if (!marksByYm[ym]) marksByYm[ym] = ntcInMarks_(ym);
      return !!marksByYm[ym][uid + '|' + date];
    };
    const now = nowIso_(), by = String(auth.user.name) + ' (' + String(auth.user.user_id) + ')';
    const res = { ok: true, served: [], dropped: [], skipped: [] };
    const col = function (k) { return NTC_H.indexOf(k) + 1; };
    drop.forEach(function (id) {
      const n = byId[id];
      if (!n || n.kind !== 'SHOWCAUSE' || n.status !== 'PROPOSED') { res.skipped.push({ id: id, why: n ? 'is ' + n.status : 'no such notice' }); return; }
      sh.getRange(n._row, col('status')).setValue('DROPPED');
      sh.getRange(n._row, col('dropped_at'), 1, 2).setValues([[now, by]]);
      audit_(String(auth.user.user_id), 'NOTICE_DROPPED', id, 'PROPOSED', 'dropped by the district');
      res.dropped.push(id);
    });
    serve.forEach(function (id) {
      const n = byId[id];
      if (!n || n.kind !== 'SHOWCAUSE' || n.status !== 'PROPOSED') { res.skipped.push({ id: id, why: n ? 'is ' + n.status : 'no such notice' }); return; }
      if (marked(n.user_id, n.date)) {
        // her phone reached the district since the proposal: the register drops it, not the officer
        sh.getRange(n._row, col('status')).setValue('DROPPED');
        sh.getRange(n._row, col('dropped_at'), 1, 2).setValues([[now, 'SYSTEM (attendance received meanwhile)']]);
        audit_(String(auth.user.user_id), 'NOTICE_DROPPED', id, 'PROPOSED', 'attendance for ' + n.date + ' was received before serving');
        res.dropped.push(id);
        return;
      }
      const no = 'SCN/' + now.slice(0, 4) + '/' + pad_(nextSeq_('NOTICE_SEQ'), 4);
      sh.getRange(n._row, col('status')).setValue('SERVED');
      sh.getRange(n._row, col('served_at'), 1, 3).setValues([[now, by, no]]);
      audit_(String(auth.user.user_id), 'NOTICE_SERVED', id, 'PROPOSED', no + ' to ' + n.user_id + ' for ' + n.date);
      res.served.push({ id: id, no: no });
    });
    return res;
  } finally {
    lock.releaseLock();
  }
}

/** The phone's acknowledgement: once per notice, her own only; a re-send after a lost reply is the same receipt. */
function ntcAck_(auth, b) {
  const uid = String(auth.userId);
  const acks = Array.isArray(b.acks) ? b.acks.slice(0, 40) : [];
  if (!acks.length) return { ok: false, code: 'NO_ACKS' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = ntcSheet_();
    const byId = {};
    ntcAll_().forEach(function (n) { byId[n.notice_id] = n; });
    const col = function (k) { return NTC_H.indexOf(k) + 1; };
    const now = nowIso_();
    const res = { ok: true, acked: [], already: [], skipped: [] };
    acks.forEach(function (a) {
      const id = String((a && a.id) || '');
      const n = byId[id];
      if (!n || n.user_id !== uid || n.kind !== 'SHOWCAUSE') { res.skipped.push(id); return; }
      if (n.status === 'ACK') { res.already.push(id); return; }
      if (n.status !== 'SERVED') { res.skipped.push(id); return; }
      sh.getRange(n._row, col('status')).setValue('ACK');
      sh.getRange(n._row, col('ack_at'), 1, 3).setValues([[String((a && a.at) || now), String((a && a.note) || '').slice(0, 1000), now]]);
      audit_(uid, 'NOTICE_ACKNOWLEDGED', id, 'SERVED', 'acknowledged on the phone at ' + String((a && a.at) || now));
      res.acked.push(id);
    });
    return res;
  } finally {
    lock.releaseLock();
  }
}
