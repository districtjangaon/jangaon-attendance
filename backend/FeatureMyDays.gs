/**
 * FeatureMyDays.gs — a worker's own last fortnight, for her own phone.
 *
 * Ported from the SJGP register (16.10.2026). Fourteen cells under the Today
 * card, one a day: marked, marked late, on sanctioned leave, a Sunday or a
 * holiday, or not marked. The district draws it off its own reading of every
 * day and the app only lays it out.
 *
 * IT IS HER OWN RECORD AND NOBODY ELSE'S. The answer is for the user the
 * token names; there is no user parameter. The phone may already hold a mark
 * the district has not received, and the app draws that day from its own
 * queue as "held on this phone", never from this answer, because the receipt
 * is the phone's.
 *
 * THE DISTRICT'S READING OF EVERY DAY. The IN that counts is the EARLIEST IN
 * of the day (a retry is not a second mark); it is late when it falls after
 * the schedule's late_after, the same reading the summary makes. Sanctioned
 * leave is read off the Leaves sheet. A Sunday or a holiday is off, never
 * unmarked. TODAY IS NEVER COUNTED AS UNMARKED: the day is still running.
 *
 * IT ACCUSES NOBODY. Nothing here writes a row or raises anything; a day
 * shown as not marked is the fact the register already holds, drawn for the
 * person it concerns.
 *
 * BOUNDED AND CACHED. The month workbook is searched for this one user's rows
 * (a TextFinder over the user_id column, the way apiMyHistory_ does it), at
 * most two months, and the answer is cached ten minutes per user per day.
 * The app asks for it fresh the moment one of its marks is acknowledged.
 */
var MYDAYS_SPAN = 14;
var MYDAYS_CACHE_SEC = 600;
var MYDAYS_MAX_ROWS = 90;     // ~3 rows a day over a fortnight, with room for retries

function feature_mydays() {
  return {
    title: 'A worker’s own last fortnight: the attendance calendar on her home screen',
    actions: {
      // action: "myDays"  req: { token, fresh? }
      myDays: function (auth, req) {
        const uid = String(auth.userId);
        const today = fmtDay_(Date.now());
        const ck = 'mydays_' + uid + '_' + today;
        const fresh = !!(req && String(req.fresh || '') === '1');
        if (!fresh) {
          const hit = CACHE.get(ck);
          if (hit) { try { return JSON.parse(hit); } catch (e) { /* re-read below */ } }
        }
        const out = myDays_(auth.user, today);
        try { CACHE.put(ck, JSON.stringify(out), MYDAYS_CACHE_SEC); } catch (e) { /* uncached is still an answer */ }
        return out;
      }
    }
  };
}

function myDays_(user, today) {
  const uid = String(user.user_id);
  const t1 = new Date(today + 'T12:00:00+05:30').getTime();
  const t0 = t1 - (MYDAYS_SPAN - 1) * 86400000;
  const from = fmtDay_(t0);

  // ---- the marks, off the month workbook(s) the fortnight spans ----
  const inAt = {}, outAt = {};
  const yms = {};
  yms[from.slice(0, 7)] = true;
  yms[today.slice(0, 7)] = true;
  Object.keys(yms).sort().forEach(function (ym) {
    const ss = getMonthSS_(ym, true);
    if (!ss) return;
    const sh = ss.getSheetByName('Marks');
    if (!sh) return;
    findRowsByValue_(sh, 2, uid).slice(-MYDAYS_MAX_ROWS).forEach(function (r) {
      const o = rowToObj_(MARKS_H, sh.getRange(r, 1, 1, MARKS_H.length).getValues()[0]);
      const p = String(o.key).split('_');
      if (p.length < 3 || p[1].length !== 8) return;
      const dk = p[1].slice(0, 4) + '-' + p[1].slice(4, 6) + '-' + p[1].slice(6, 8);
      if (dk < from || dk > today) return;
      const hm = String(o.client_ts || '').slice(11, 16);
      if (!/^\d\d:\d\d$/.test(hm)) return;
      if (p[2] === 'IN') { if (!inAt[dk] || hm < inAt[dk]) inAt[dk] = hm; }
      else if (p[2] === 'OUT') { if (!outAt[dk] || hm > outAt[dk]) outAt[dk] = hm; }
    });
  });

  // ---- sanctioned leave, day by day ----
  const leave = {};
  leavesOverlapping_(from, today).forEach(function (l) {
    if (String(l.user_id) !== uid) return;
    const f = String(l.from_date), to = String(l.to_date) || f;
    const label = LEAVE_TYPE_LABEL[String(l.type)] || String(l.type) || 'Leave';
    for (let t = t0; t <= t1; t += 86400000) {
      const dk = fmtDay_(t);
      if (dk >= f && dk <= to) leave[dk] = label;
    }
  });

  // ---- the reading of "late", the schedule's own ----
  let lateAfter = '';
  try {
    const sch = scheduleFor_(String(user.project_code), String(user.cadre));
    lateAfter = (sch && sch.late_after) || '';
  } catch (e) { lateAfter = ''; }

  // ---- the fortnight, oldest first ----
  const days = [], T = { working: 0, marked: 0, full: 0, late: 0, leaveDays: 0, notMarked: 0 };
  for (let t = t0; t <= t1; t += 86400000) {
    const dk = fmtDay_(t);
    const off = holidayFor_(dk);
    const hin = inAt[dk] || '', hout = outAt[dk] || '';
    const late = !!(hin && lateAfter && hin > lateAfter);
    const day = { date: dk, off: off, in: hin, out: hout, late: late, leave: leave[dk] || '' };
    days.push(day);
    if (day.leave) { T.leaveDays++; continue; }
    if (off) continue;
    T.working++;
    if (hin) { T.marked++; if (hout) T.full++; if (late) T.late++; }
    else if (dk < today) T.notMarked++;   // today is a running day and is never counted as unmarked
  }
  return { ok: true, today: today, from: from, to: today, cutoff: lateAfter, days: days, totals: T,
    at: nowIso_(),
    note: 'What the district holds for you, day by day. A day on sanctioned leave is leave, not absence; a late mark is never a miss; today is still running.' };
}
