/**
 * Summary.gs — the read path. Pre-computes static JSON and commits it to the
 * GitHub Pages repo, so console dashboard reads cost ZERO Apps Script
 * executions and ZERO Sheet reads.
 *
 *  - summaryTick(): every 10 min (peak windows; hourly off-peak) -> today.json
 *  - nightlyJob(): 22:00 -> month/S##.json + exceptions.json + org.json
 *    (+ archive on the 1st)
 *
 * Published JSON is pseudonymous: user ids and AWC/sector codes only, never
 * names or phones. The console resolves names via the authenticated nameMap
 * call. org.json carries org-unit names (public facility names, no coords).
 */

function summaryTick() {
  const now = new Date();
  const h = Number(Utilities.formatDate(now, TZ, 'H'));
  const min = Number(Utilities.formatDate(now, TZ, 'm'));
  const hm = h * 60 + min;
  if (hm < 360 || hm > 1200) { // night 20:00–06:00: hourly heartbeat only
    if (min >= 5) return;
    buildToday_();
    return;
  }
  // Working day: every 5 minutes — affordable because a tick that finds no
  // new marks/leaves since the last build exits in seconds without reading
  // or publishing anything.
  const ym = Utilities.formatDate(now, TZ, 'yyyy-MM');
  const ss = getMonthSS_(ym, true);
  if (!ss) return;
  const rptSh = ss.getSheetByName('Reports');
  const marker = fmtDay_(Date.now()) + '|' + ss.getSheetByName('Marks').getLastRow() +
    '|' + leavesSheet_().getLastRow() + '|' + (rptSh ? rptSh.getLastRow() : 0);
  if (CACHE.get('sumMarker') === marker) {
    // Nothing new — but prove we are alive: heartbeat meta.json at most
    // every 30 min so the console can tell "idle" apart from "dead".
    if (!CACHE.get('hb')) {
      CACHE.put('hb', '1', 1800);
      ghCommit_([{ path: 'summary/meta.json', content: JSON.stringify({
        generatedAt: PROPS.getProperty('LAST_GEN') || '', checkedAt: nowIso_(),
        month: ym, date: fmtDay_(Date.now())
      }) }], 'heartbeat ' + nowIso_());
    }
    return;
  }
  buildToday_();
  CACHE.put('sumMarker', marker, 21600);
  // Something changed: also keep the Register tab reasonably fresh (at most
  // once an hour — a full-month rebuild is too heavy for every tick; the
  // nightly run remains the complete, authoritative build).
  if (!CACHE.get('regBuilt')) {
    CACHE.put('regBuilt', '1', 3600);
    try {
      buildRegister(ym);
    } catch (err) {
      console.error('hourly register rebuild failed: ' + err);
    }
  }
}

function buildToday_() {
  const nowMs = Date.now();
  const today = fmtDay_(nowMs);
  const todayCompact = today.replace(/-/g, '');
  const ym = today.slice(0, 7);
  const ss = getMonthSS_(ym, true);
  if (!ss) return;

  const sh = ss.getSheetByName('Marks');
  const startRow = todayStartRow_(ss, sh, today);
  const last = sh.getLastRow();

  // Index today's marks by user. Only rows received today are read (<= ~2,500),
  // which is what keeps this run inside the trigger-minutes budget all month.
  const marksByUser = {};
  const perfSd = []; // capture-to-server delays (sync_delay_sec) of today's marks
  let perfLate = 0;
  if (last >= startRow) {
    const vals = sh.getRange(startRow, 1, last - startRow + 1, MARKS_H.length).getValues();
    for (const v of vals) {
      const o = rowToObj_(MARKS_H, v);
      const p = String(o.key).split('_');
      if (p[1] !== todayCompact) continue; // late-synced older marks: nightly job covers them
      (marksByUser[String(o.user_id)] = marksByUser[String(o.user_id)] || {})[p[2]] = o;
      const sd = Number(o.sync_delay_sec);
      if (o.sync_delay_sec !== '' && !isNaN(sd)) perfSd.push(sd);
      if (String(o.flags || '').indexOf('LATE_SYNC') >= 0) perfLate++;
    }
  }

  const sectorProject = {};
  getSectors_().forEach(s => { sectorProject[s.code] = s.project; });

  // Sundays and state holidays: marks still recorded (voluntary duty), but
  // nobody is LATE and the console shows "attendance not expected".
  const holidayName = holidayFor_(today);

  // Approved leaves covering today: those users count ON_LEAVE, not absent.
  const leaveByUid = {};
  leavesOverlapping_(today, today).forEach(l => {
    if (!leaveByUid[String(l.user_id)]) leaveByUid[String(l.user_id)] = String(l.type);
  });

  // FIELD staff and sector SUPERVISORS owe attendance (policy 2026-08-18);
  // admins/Collector do not. A multi-sector supervisor counts once, under
  // her primary (first-listed) sector.
  const users = getUsersAll_().filter(u => String(u.status) === 'ACTIVE' &&
    (String(u.role) === 'FIELD' || String(u.role) === 'SUPERVISOR'));
  const blank = () => ({ expected: 0, in: 0, late: 0, out: 0, notMarked: 0,
    onLeave: 0, outside: 0, unverified: 0 });
  const sectors = {};
  const userEntries = [];
  const exceptions = [];

  for (const u of users) {
    const uid = String(u.user_id), sc = primarySector_(u);
    const agg = sectors[sc] = sectors[sc] || blank();
    agg.expected++;

    const recs = marksByUser[uid] || {};
    const sch = scheduleFor_(String(u.project_code), String(u.cadre));
    const lateMin = holidayName ? null : (sch ? hmToMin_(sch.late_after) : null);

    let st = 'NOT_MARKED';
    const entry = { id: uid, s: sc, a: String(u.awc_id), st: st, in: null, out: null, gf: null, fl: '', ph: null };
    let worstGf = null;

    ['IN', 'OUT'].forEach(type => {
      const o = recs[type];
      if (!o) return;
      const t = String(o.client_ts).slice(11, 16);
      const gf = String(o.geofence);
      const fl = String(o.flags);
      if (type === 'IN') {
        entry.in = t;
        entry.ph = String(o.photo_id) || null;
        st = (lateMin != null && hmToMin_(t) != null && hmToMin_(t) > lateMin) ? 'LATE' : 'PRESENT';
        if (st === 'LATE') agg.late++; else agg.in++; // "in" = on time; late counted separately
      } else {
        entry.out = t;
        agg.out++;
      }
      if (gf === 'OUTSIDE' || (gf === 'UNVERIFIED' && worstGf !== 'OUTSIDE')) worstGf = gf;
      else if (!worstGf) worstGf = gf;
      if (fl) entry.fl = entry.fl ? entry.fl + ',' + fl : fl;
      if (gf !== 'INSIDE' || fl) {
        exceptions.push({
          key: String(o.key), u: uid, s: sc, t: type, at: t,
          gf: gf, fl: fl, ph: String(o.photo_id) || null
        });
      }
    });

    if (st === 'NOT_MARKED' && leaveByUid[uid]) {
      st = 'ON_LEAVE';
      entry.lv = leaveByUid[uid];
      agg.onLeave++;
    }
    entry.st = st;
    entry.gf = worstGf;
    if (st === 'NOT_MARKED') agg.notMarked++;
    if (worstGf === 'OUTSIDE') agg.outside++;
    if (worstGf === 'UNVERIFIED') agg.unverified++;
    userEntries.push(entry);
  }

  // Marks by non-FIELD users (admin test marks, voluntary duty): visible in
  // the tables and the flagged list — with photos — but never counted in the
  // district numbers, which stay FIELD-only.
  const fieldSet = {};
  users.forEach(u => { fieldSet[String(u.user_id)] = 1; });
  Object.keys(marksByUser).forEach(uid => {
    if (fieldSet[uid]) return;
    const u = getUserById_(uid);
    if (!u) return;
    const entry = { id: uid, s: String(u.sector_code), a: String(u.awc_id),
      st: 'PRESENT', in: null, out: null, gf: null, fl: '', ph: null, x: 1 };
    ['IN', 'OUT'].forEach(type => {
      const o = marksByUser[uid][type];
      if (!o) return;
      const t = String(o.client_ts).slice(11, 16);
      if (type === 'IN') { entry.in = t; entry.ph = String(o.photo_id) || null; }
      else entry.out = t;
      const gf = String(o.geofence), fl = String(o.flags);
      if (gf === 'OUTSIDE' || (gf === 'UNVERIFIED' && entry.gf !== 'OUTSIDE')) entry.gf = gf;
      else if (!entry.gf) entry.gf = gf;
      if (fl) entry.fl = entry.fl ? entry.fl + ',' + fl : fl;
      if (gf !== 'INSIDE' || fl) {
        exceptions.push({ key: String(o.key), u: uid, s: String(u.sector_code), t: type,
          at: t, gf: gf, fl: fl, ph: String(o.photo_id) || null });
      }
    });
    userEntries.push(entry);
  });

  const district = blank();
  const projects = {};
  Object.keys(sectors).forEach(sc => {
    const pc = sectorProject[sc] || '?';
    const p = projects[pc] = projects[pc] || blank();
    Object.keys(district).forEach(k => {
      district[k] += sectors[sc][k];
      p[k] += sectors[sc][k];
    });
  });

  // Today's AWC daily reports (children / pregnant women / others / meals).
  // One report per AWC counts — if both workers of a centre submitted, the
  // first row wins. Only the sheet tail is read (≤ ~800 rows), same budget
  // philosophy as the marks read above.
  const rpt = { awcs: 0, children: 0, pregnant: 0, others: 0, meals: 0,
    eggs: 0, riceKg: 0, pulsesKg: 0, stock: {} };
  STOCK_KEYS.forEach(k => { rpt.stock[k] = { ob: 0, used: 0, recd: 0, cb: 0 }; });
  const r1_ = v => Math.round(v * 10) / 10;
  const rptRows = []; // per-AWC detail for the console's Daily Reports tab
  const rsh = ss.getSheetByName('Reports');
  if (rsh && rsh.getLastRow() >= 2) {
    const rStart = Math.max(2, rsh.getLastRow() - 800);
    const rvals = rsh.getRange(rStart, 1, rsh.getLastRow() - rStart + 1, RPT_H.length).getValues();
    const rptByAwc = {};
    for (const v of rvals) {
      const o = rowToObj_(RPT_H, v);
      if (String(o.date) !== todayCompact) continue;
      const aid = String(o.awc_id) || String(o.user_id);
      if (rptByAwc[aid]) continue;
      rptByAwc[aid] = 1;
      rpt.awcs++;
      rpt.children += Number(o.children) || 0;
      rpt.pregnant += Number(o.pregnant) || 0;
      rpt.others += Number(o.others) || 0;
      rpt.meals += Number(o.meals) || 0;
      rpt.eggs += Number(o.eggs) || 0;
      rpt.riceKg = Math.round((rpt.riceKg + (Number(o.rice_kg) || 0)) * 10) / 10;
      rpt.pulsesKg = Math.round((rpt.pulsesKg + (Number(o.pulses_kg) || 0)) * 10) / 10;
      // stock register: per-row [ob,used,recd,cb] per item + district totals
      const st = STOCK_KEYS.map(k => ['ob', 'used', 'recd', 'cb'].map(c =>
        Number(o[k + '_' + c]) || 0));
      st.forEach((vals, i) => {
        const t = rpt.stock[STOCK_KEYS[i]];
        t.ob = r1_(t.ob + vals[0]); t.used = r1_(t.used + vals[1]);
        t.recd = r1_(t.recd + vals[2]); t.cb = r1_(t.cb + vals[3]);
      });
      rptRows.push({
        st: st,
        u: String(o.user_id), s: String(o.sector_code), a: aid,
        at: String(o.client_ts).slice(11, 16),
        c: Number(o.children) || 0, p: Number(o.pregnant) || 0,
        o: Number(o.others) || 0, m: Number(o.meals) || 0,
        eg: Number(o.eggs) || 0, rk: Number(o.rice_kg) || 0, pk: Number(o.pulses_kg) || 0,
        f: String(o.flags || ''),
        ph1: String(o.photo_child_id) || null, ph2: String(o.photo_meal_id) || null,
        ph3: String(o.photo_pregnant_id) || null, ph4: String(o.photo_others_id) || null
      });
    }
  }

  // App adoption since launch: how many of the attendance-owing staff have
  // completed a first login (PIN set) and how many phones are device-bound.
  const adopt = { staff: users.length, onboarded: 0, devices: 0, app: 0, chrome: 0 };
  const staffIds = {};
  users.forEach(function (u) {
    staffIds[String(u.user_id)] = 1;
    if (String(u.pin_hash || '')) adopt.onboarded++;
    if (String(u.device_id || '')) adopt.devices++;
  });
  // Installed-app vs Chrome-tab split (AppModes sheet, daily self-report).
  try {
    const msh = masterSS_().getSheetByName('AppModes');
    if (msh && msh.getLastRow() >= 2) {
      msh.getRange(2, 1, msh.getLastRow() - 1, 2).getValues().forEach(function (r) {
        if (!staffIds[String(r[0])]) return;
        if (String(r[1]) === 'APP') adopt.app++; else adopt.chrome++;
      });
    }
  } catch (e) { /* telemetry only — never block the summary */ }

  // Pending leave applications: powers the console's Leaves-tab badge so an
  // application is never invisible until someone opens the tab.
  let pendingLeaves = 0;
  try {
    pendingLeaves = getLeavesAll_().filter(function (l) {
      return String(l.status) === 'PENDING';
    }).length;
  } catch (e) { /* badge only — never block the summary */ }

  // Field-sync performance stats for the admin Performance tab.
  perfSd.sort(function (a, b) { return a - b; });
  const pq_ = function (f) {
    return perfSd.length ? perfSd[Math.max(0, Math.ceil(f * perfSd.length) - 1)] : null;
  };
  const perfStats = { marks: perfSd.length, sdMed: pq_(0.5), sdP95: pq_(0.95), lateSync: perfLate };

  const generatedAt = nowIso_();
  const todayJson = {
    generatedAt: generatedAt, date: today, holiday: holidayName || null, district: district,
    adopt: adopt, pendingLeaves: pendingLeaves, perf: perfStats,
    rpt: rpt, rpts: rptRows,
    projects: Object.keys(projects).sort().map(pc => Object.assign({ code: pc }, projects[pc])),
    sectors: Object.keys(sectors).sort().map(sc =>
      Object.assign({ code: sc, project: sectorProject[sc] || '' }, sectors[sc])),
    users: userEntries, exceptions: exceptions
  };
  PROPS.setProperty('LAST_GEN', generatedAt);
  ghCommit_([
    { path: 'summary/today.json', content: JSON.stringify(todayJson) },
    { path: 'summary/meta.json', content: JSON.stringify({ generatedAt: generatedAt,
      checkedAt: generatedAt, month: ym, date: today }) }
  ], 'today ' + generatedAt);
}

/** First Marks row received today; persisted in Meta so each tick is incremental. */
function todayStartRow_(ss, sh, today) {
  const meta = ss.getSheetByName('Meta');
  const kv = meta.getRange(1, 1, 2, 2).getValues();
  if (String(kv[0][1]) === today) return Number(kv[1][1]) || 2;

  const last = sh.getLastRow();
  let found = last + 1;
  const from = Math.max(2, last - 4000); // bounded tail scan on day change
  if (last >= 2) {
    const ts = sh.getRange(from, 7, last - from + 1, 1).getValues(); // server_ts column
    for (let i = 0; i < ts.length; i++) {
      if (String(ts[i][0]).slice(0, 10) === today) { found = from + i; break; }
    }
  }
  meta.getRange(1, 2).setValue(today);
  meta.getRange(2, 2).setValue(String(found));
  return found;
}

// ---- org structure for the console (names of org units, no coords, no people) ----
function buildOrgFile_() {
  const awcs = {};
  masterSheetRows_('AWCs', AWC_H).forEach(r => {
    const a = awcFromRow_(r);
    awcs[a.awc_id] = { n: a.name, sc: a.sector };
  });
  return {
    path: 'summary/org.json',
    content: JSON.stringify({
      generatedAt: nowIso_(),
      projects: getProjects_(),
      sectors: getSectors_().map(s => ({ code: s.code, project: s.project, name: s.name })),
      schedules: getSchedules_(), // console reports use late_after for late counting
      awcs: awcs
    })
  };
}

/**
 * Public gazetteer: name + coordinates of every active AWC (government
 * facilities — public locations, no people). The app uses it to write a
 * place name into the photo stamp ("Near Alipur-I · 210 m") even for users
 * with no assigned centre — coordinates alone mean nothing to an auditor.
 */
function buildPlacesFile_() {
  const awcs = {};
  masterSheetRows_('AWCs', AWC_H).forEach(r => {
    const a = awcFromRow_(r);
    if (a.active && a.lat != null && a.lng != null) {
      awcs[a.awc_id] = { n: a.name, lat: a.lat, lng: a.lng };
    }
  });
  return { path: 'summary/places.json',
    content: JSON.stringify({ generatedAt: nowIso_(), awcs: awcs }) };
}

/** Owner-run after importFromSheets so the console has org names immediately. */
function publishOrg() {
  ghCommit_([buildOrgFile_(), buildPlacesFile_()], 'org ' + nowIso_());
}

/**
 * Owner-run: force an immediate today.json publish, bypassing summaryTick's
 * off-peak gate (which otherwise defers to the first 10 minutes of the hour).
 */
function publishToday() {
  buildToday_();
}

// ---- nightly full build ----
function nightlyJob() {
  const now = new Date();
  const ym = Utilities.formatDate(now, TZ, 'yyyy-MM');
  let files = buildMonthFiles_(ym, 'summary/month/', true);
  files.push(buildOrgFile_());
  files.push(buildPlacesFile_());
  const firstOfMonth = Utilities.formatDate(now, TZ, 'd') === '1';
  if (firstOfMonth) {
    // Freeze last month under summary/archive/ before it goes cold.
    const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
    const prevYm = m === 1 ? (y - 1) + '-12' : y + '-' + pad_(m - 1, 2);
    files = files.concat(buildMonthFiles_(prevYm, 'summary/archive/' + prevYm + '/', false));
  }
  if (files.length) ghCommit_(files, 'nightly ' + nowIso_());

  // Keep the Register tab current without anyone running buildRegister by
  // hand: rebuilt every night (and last month finalised on the 1st). A
  // register failure must never cost the summary publish above.
  try {
    buildRegister(ym);
    if (firstOfMonth) {
      const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
      buildRegister(m === 1 ? (y - 1) + '-12' : y + '-' + pad_(m - 1, 2));
    }
  } catch (err) {
    console.error('register rebuild failed: ' + err);
  }
}

/**
 * Reads the full month once (the only full read of the day), applies
 * corrections, detects cross-day anomalies, and emits one JSON per sector
 * plus (optionally) the open exception queue.
 */
function buildMonthFiles_(ym, basePath, withExceptions) {
  const ss = getMonthSS_(ym, true);
  if (!ss) return [];
  const sh = ss.getSheetByName('Marks');
  const last = sh.getLastRow();
  const marks = last < 2 ? [] :
    sh.getRange(2, 1, last - 1, MARKS_H.length).getValues().map(v => rowToObj_(MARKS_H, v));

  const cs = ss.getSheetByName('Corrections');
  const cLast = cs.getLastRow();
  const corrByKey = {};
  if (cLast >= 2) {
    cs.getRange(2, 1, cLast - 1, CORR_H.length).getValues().forEach(v => {
      const c = rowToObj_(CORR_H, v);
      corrByKey[String(c.orig_key)] = c; // later rows win: latest correction is authoritative
    });
  }

  const generatedAt = nowIso_();
  const bySector = {};   // sc -> uid -> dd -> {IN:{...}, OUT:{...}}
  const coordTrail = {}; // uid -> [{dd, coords}] for the static-coordinates anomaly
  const exceptions = [];

  for (const o of marks) {
    const key = String(o.key);
    const p = key.split('_');
    const uid = String(o.user_id), sc = String(o.sector_code);
    const dd = p[1].slice(6, 8), type = p[2];
    const corr = corrByKey[key];

    const cell = {
      t: String(o.client_ts).slice(11, 16),
      gf: String(o.geofence),
      d: o.distance_m === '' ? null : Number(o.distance_m),
      fl: String(o.flags),
      ph: String(o.photo_id) || null,
      x: corr ? (corr.action === 'REJECT_MARK' ? 'REJ' : corr.action === 'ACCEPT_OUTSIDE' ? 'ACC' : 'COR') : ''
    };
    const sb = bySector[sc] = bySector[sc] || {};
    const ub = sb[uid] = sb[uid] || {};
    (ub[dd] = ub[dd] || {})[type] = cell;

    if (type === 'IN' && cell.gf !== 'UNVERIFIED' && o.lat !== '' && o.lng !== '') {
      (coordTrail[uid] = coordTrail[uid] || []).push({ dd: dd, c: o.lat + ',' + o.lng, sc: sc });
    }
    if (withExceptions && !corr && (cell.gf !== 'INSIDE' || cell.fl)) {
      exceptions.push({ key: key, u: uid, s: sc, d: p[1], t: type, at: cell.t, gf: cell.gf, fl: cell.fl, ph: cell.ph });
    }
  }

  // Manual marks adjudicated in by a supervisor (orig_key that has no Marks row).
  Object.keys(corrByKey).forEach(key => {
    const c = corrByKey[key];
    if (String(c.action) !== 'MANUAL_MARK') return;
    const p = key.split('_');
    if (p.length !== 3 || p[1].slice(0, 6) !== ym.replace('-', '')) return;
    const target = getUserById_(p[0]);
    if (!target) return;
    const sc = String(target.sector_code);
    const sb = bySector[sc] = bySector[sc] || {};
    const ub = sb[p[0]] = sb[p[0]] || {};
    const dd = p[1].slice(6, 8);
    if (!(ub[dd] && ub[dd][p[2]])) {
      (ub[dd] = ub[dd] || {})[p[2]] = { t: null, gf: 'MANUAL', d: null, fl: '', ph: null, x: 'MAN' };
    }
  });

  // Anomaly: IN coordinates identical to 6 dp across >= 5 consecutive marked days.
  if (withExceptions) {
    Object.keys(coordTrail).forEach(uid => {
      const trail = coordTrail[uid].sort((a, b) => a.dd < b.dd ? -1 : 1);
      let run = 1;
      for (let i = 1; i < trail.length; i++) {
        run = trail[i].c === trail[i - 1].c ? run + 1 : 1;
        if (run === 5) {
          exceptions.push({
            key: 'ANOM_' + uid + '_' + ym, u: uid, s: trail[i].sc, d: ym.replace('-', '') + trail[i].dd,
            t: 'ANOMALY', at: null, gf: 'STATIC_COORDS', fl: 'REPEAT_COORDS_5D', ph: null
          });
          break;
        }
      }
    });
  }

  // Holiday map for the month (incl. Sundays) — the console greys these days.
  const dim = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
  const monthHolidays = {};
  for (let d = 1; d <= dim; d++) {
    const h = holidayFor_(ym + '-' + pad_(d, 2));
    if (h) monthHolidays[pad_(d, 2)] = h;
  }

  // Approved leave days per sector/user for the grid and console reports.
  const monthEnd = ym + '-' + pad_(dim, 2);
  const userSector = {};
  getUsersAll_().forEach(u => { userSector[String(u.user_id)] = String(u.sector_code); });
  const leavesBySector = {}; // sc -> uid -> dd -> type
  leavesOverlapping_(ym + '-01', monthEnd).forEach(l => {
    const uid = String(l.user_id);
    const sc = userSector[uid];
    if (!sc) return;
    const from = String(l.from_date) > ym + '-01' ? String(l.from_date) : ym + '-01';
    const to = String(l.to_date) < monthEnd ? String(l.to_date) : monthEnd;
    for (let d = Number(from.slice(8)); d <= Number(to.slice(8)); d++) {
      const dd = pad_(d, 2);
      if (monthHolidays[dd]) continue; // leave on a holiday is meaningless
      const sb = leavesBySector[sc] = leavesBySector[sc] || {};
      (sb[uid] = sb[uid] || {})[dd] = String(l.type);
    }
  });

  const allSectors = {};
  Object.keys(bySector).forEach(sc => { allSectors[sc] = 1; });
  Object.keys(leavesBySector).forEach(sc => { allSectors[sc] = 1; });
  const files = Object.keys(allSectors).sort().map(sc => ({
    path: basePath + sc + '.json',
    content: JSON.stringify({ ym: ym, generatedAt: generatedAt, sector: sc,
      holidays: monthHolidays, leaves: leavesBySector[sc] || {}, users: bySector[sc] || {} })
  }));
  if (withExceptions) {
    files.push({
      path: 'summary/exceptions.json',
      content: JSON.stringify({ ym: ym, generatedAt: generatedAt, open: exceptions })
    });
  }
  return files;
}

// ---- GitHub commit (git data API: one commit for all changed files) ----
function ghCommit_(files, msg) {
  const tok = PROPS.getProperty('GH_TOKEN');
  const repo = PROPS.getProperty('GH_REPO');
  if (!tok || !repo) {
    console.warn('GH_TOKEN / GH_REPO not set — summary not published');
    return;
  }
  const branch = PROPS.getProperty('GH_BRANCH') || 'main';
  const api = 'https://api.github.com/repos/' + repo;
  const gh = (path, method, payload) => {
    const opts = {
      method: method || 'get',
      muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json' }
    };
    if (payload) {
      opts.contentType = 'application/json';
      opts.payload = JSON.stringify(payload);
    }
    const res = UrlFetchApp.fetch(api + path, opts);
    if (res.getResponseCode() >= 300) {
      throw new Error('GitHub ' + res.getResponseCode() + ' on ' + path + ': ' +
        res.getContentText().slice(0, 200));
    }
    return JSON.parse(res.getContentText());
  };

  const head = gh('/git/ref/heads/' + branch).object.sha;
  const baseTree = gh('/git/commits/' + head).tree.sha;
  const tree = gh('/git/trees', 'post', {
    base_tree: baseTree,
    tree: files.map(f => ({ path: f.path, mode: '100644', type: 'blob', content: f.content }))
  });
  const commit = gh('/git/commits', 'post', { message: msg, tree: tree.sha, parents: [head] });
  gh('/git/refs/heads/' + branch, 'patch', { sha: commit.sha });
}
