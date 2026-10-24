/**
 * FeatureMockLocation.gs — who is standing where the phone says, read off a
 * month of morning fixes rather than one mark at a time.
 *
 * Ported from the SJGP register. Marks.gs already flags a single mark
 * (PERFECT_ACCURACY, AT_CENTER_EXACT, REPEAT_COORDS, IMPOSSIBLE_VELOCITY,
 * FAKE_GPS_SUSPECT) as it arrives. This reads the SERIES: a real phone,
 * standing in the same yard every morning, scatters by tens of metres from
 * day to day and reports an accuracy of 5–30 m; a mock-location app hands
 * back the same six decimals every day and claims 0–1 m.
 *
 * THREE READINGS, each with its own evidence, none of them a verdict:
 *   finding  the same coordinate, to six decimals, on two or more mornings,
 *            with the phone claiming 15 m or better each time. GPS does not
 *            do this by itself.
 *   lead     a claimed accuracy of 0 or 1 m on any morning, from a phone not
 *            already in the findings. Rare but possible from a cached fix.
 *   shared   one fine point (≤15 m) under two people of DIFFERENT centres on
 *            the same morning. An AWT and her AWH share the centre phone and
 *            legitimately stand in one spot, so the same centre is not read.
 *
 * NOT JUDGED: fewer than three located mornings in the window says nothing
 * either way, and is counted rather than listed.
 *
 * It is a reading for the district's ADMIN only, over the IN marks of the
 * window (7–90 days, 30 by default), cached twenty minutes. Nothing here
 * writes anything, blocks anyone or changes a flag: the officer takes the
 * list to the Map and the photographs.
 */
var MOCK_DEFAULT_DAYS = 30;
var MOCK_FINE_M = 15;          // "fine": the phone claimed this or better
var MOCK_PERFECT_M = 1;        // "perfect": 0–1 m, which a handset GPS does not deliver
var MOCK_MIN_DAYS = 3;         // fewer located mornings than this: not judged
var MOCK_CACHE_SEC = 1200;

function feature_mockloc() {
  return {
    title: 'Mock-location reading: pinned coordinates, perfect accuracy and shared points over a month of mornings',
    actions: {
      // action: "mockloc"  req: { token, days (7–90, default 30), fresh }
      mockloc: function (auth, req) {
        if (String(auth.user.role) !== 'ADMIN') return deny_();
        let days = Math.round(Number(req.days) || MOCK_DEFAULT_DAYS);
        if (!(days >= 7)) days = 7;
        if (days > 90) days = 90;
        const key = 'mockloc_' + days + '_' + fmtDay_(Date.now());
        if (String(req.fresh || '') !== '1') {
          const hit = cacheGetBig_(key);
          if (hit) { try { return JSON.parse(hit); } catch (e) { /* re-read */ } }
        }
        const out = mockReading_(days);
        try { cachePutBig_(key, JSON.stringify(out), MOCK_CACHE_SEC); } catch (e) { /* an uncached answer is still an answer */ }
        return out;
      }
    }
  };
}

/** Every IN mark with a fix in the window, off the month workbook(s) it spans. */
function mockFixes_(from, to) {
  const yms = {};
  yms[from.slice(0, 7)] = true;
  yms[to.slice(0, 7)] = true;
  // a 90-day window can span a third month
  const mid = new Date(from + 'T12:00:00+05:30');
  mid.setMonth(mid.getMonth() + 1);
  yms[fmtDay_(mid.getTime()).slice(0, 7)] = true;
  const fixes = [];
  let marks = 0;
  Object.keys(yms).sort().forEach(function (ym) {
    if (ym > to.slice(0, 7)) return;
    const ss = getMonthSS_(ym, true);
    if (!ss) return;
    const sh = ss.getSheetByName('Marks');
    const last = sh ? sh.getLastRow() : 0;
    if (last < 2) return;
    sh.getRange(2, 1, last - 1, MARKS_H.length).getValues().forEach(function (v) {
      const o = rowToObj_(MARKS_H, v);
      if (String(o.type) !== 'IN') return;
      const p = String(o.key).split('_');
      if (p.length < 3 || p[1].length !== 8) return;
      const date = p[1].slice(0, 4) + '-' + p[1].slice(4, 6) + '-' + p[1].slice(6, 8);
      if (date < from || date > to) return;
      marks++;
      if (o.lat === '' || o.lng === '' || o.lat == null || o.lng == null) return;
      const lat = Number(o.lat), lng = Number(o.lng);
      if (!isFinite(lat) || !isFinite(lng)) return;
      fixes.push({
        uid: String(o.user_id), date: date, at: String(o.client_ts || '').slice(11, 16),
        lat: lat, lng: lng, coord: lat.toFixed(6) + ',' + lng.toFixed(6),
        acc: o.accuracy_m === '' || o.accuracy_m == null ? null : Number(o.accuracy_m),
        awc: String(o.awc_id || ''), gf: String(o.geofence || '')
      });
    });
  });
  return { fixes: fixes, marks: marks };
}

function mockMedian_(a) {
  if (!a.length) return null;
  const s = a.slice().sort(function (x, y) { return x - y; });
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mockReading_(days) {
  const to = fmtDay_(Date.now());
  const from = fmtDay_(new Date(to + 'T12:00:00+05:30').getTime() - (days - 1) * 86400000);
  const read = mockFixes_(from, to);

  const roll = {};
  getUsersAll_().forEach(function (u) { roll[String(u.user_id)] = u; });
  const who = function (uid) {
    const u = roll[uid] || {};
    const a = u.awc_id ? getAwc_(String(u.awc_id)) : null;
    return { uid: uid, name: String(u.name || uid), cadre: String(u.cadre || ''), sector: String(u.sector_code || ''),
      awc: String(u.awc_id || ''), awcName: a ? a.name : '' , status: String(u.status || '') };
  };

  // one morning per person per day: the earliest located IN
  const byUser = {};
  read.fixes.forEach(function (f) {
    const d = byUser[f.uid] = byUser[f.uid] || {};
    if (!d[f.date] || f.at < d[f.date].at) d[f.date] = f;
  });

  const findings = [], leads = [];
  let notJudged = 0, judged = 0;
  const pinned = {};
  Object.keys(byUser).forEach(function (uid) {
    const dates = Object.keys(byUser[uid]).sort();
    const morn = dates.map(function (d) { return byUser[uid][d]; });
    if (morn.length < MOCK_MIN_DAYS) { notJudged++; return; }
    judged++;

    // the series' own scatter: median distance of each morning from the centroid
    const cla = morn.reduce(function (s, f) { return s + f.lat; }, 0) / morn.length;
    const cln = morn.reduce(function (s, f) { return s + f.lng; }, 0) / morn.length;
    const scatter = mockMedian_(morn.map(function (f) { return distM_(cla, cln, f.lat, f.lng); }));
    const accs = morn.filter(function (f) { return f.acc != null; }).map(function (f) { return f.acc; });
    const accMedian = mockMedian_(accs);

    // a fine coordinate repeated to six decimals on two or more mornings
    const byCoord = {};
    morn.forEach(function (f) {
      if (f.acc == null || f.acc > MOCK_FINE_M) return;
      (byCoord[f.coord] = byCoord[f.coord] || []).push(f.date);
    });
    let worst = null;
    Object.keys(byCoord).forEach(function (c) {
      if (byCoord[c].length >= 2 && (!worst || byCoord[c].length > worst.days.length)) worst = { coord: c, days: byCoord[c] };
    });
    if (worst) {
      pinned[uid] = true;
      findings.push(Object.assign(who(uid), {
        located: morn.length, pinnedDays: worst.days.length, coord: worst.coord,
        dates: worst.days, scatterM: Math.round(scatter), accMedian: accMedian,
        accMin: accs.length ? Math.min.apply(null, accs) : null
      }));
      return;
    }
    // a claim of perfect accuracy, from a phone that is not pinned
    const perfect = morn.filter(function (f) { return f.acc != null && f.acc <= MOCK_PERFECT_M; });
    if (perfect.length) {
      leads.push(Object.assign(who(uid), {
        located: morn.length, perfectDays: perfect.length, dates: perfect.map(function (f) { return f.date; }),
        scatterM: Math.round(scatter), accMedian: accMedian, accMin: Math.min.apply(null, perfect.map(function (f) { return f.acc; }))
      }));
    }
  });

  // one fine point under two people of different centres on one morning
  const byDayCoord = {};
  read.fixes.forEach(function (f) {
    if (f.acc == null || f.acc > MOCK_FINE_M) return;
    const k = f.date + '|' + f.coord;
    const g = byDayCoord[k] = byDayCoord[k] || {};
    g[f.uid] = f;
  });
  const shared = [];
  Object.keys(byDayCoord).sort().forEach(function (k) {
    const uids = Object.keys(byDayCoord[k]);
    if (uids.length < 2) return;
    const centres = {};
    uids.forEach(function (uid) { const u = roll[uid]; centres[String((u && u.awc_id) || ('?' + uid))] = true; });
    if (Object.keys(centres).length < 2) return;   // the centre phone, shared by its own pair
    const p = k.split('|');
    shared.push({ date: p[0], coord: p[1], users: uids.map(function (uid) {
      const w = who(uid); w.at = byDayCoord[k][uid].at; w.acc = byDayCoord[k][uid].acc; return w;
    }) });
  });

  const byDays = function (a, b) { return (b.pinnedDays || b.perfectDays || 0) - (a.pinnedDays || a.perfectDays || 0); };
  findings.sort(byDays);
  leads.sort(byDays);
  return {
    ok: true, at: nowIso_(), from: from, to: to, days: days,
    scanned: { marks: read.marks, located: read.fixes.length, users: Object.keys(byUser).length, judged: judged, notJudged: notJudged },
    thresholds: { fineM: MOCK_FINE_M, perfectM: MOCK_PERFECT_M, minDays: MOCK_MIN_DAYS },
    findings: findings, leads: leads, shared: shared.slice(0, 200),
    note: 'A reading, not a verdict. A finding is the same six-decimal point on two or more mornings at a claimed 15 m or better; ' +
      'a lead is a claimed 0–1 m; a shared point is one fine fix under two people of different centres on one morning. ' +
      'Nothing here blocks a mark or changes a flag.'
  };
}
