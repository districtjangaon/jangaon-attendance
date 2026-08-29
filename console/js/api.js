'use strict';
/**
 * Console server API + summary-file reader.
 *  - Api.post(body): Apps Script doPost (JSON as text/plain — CORS simple request).
 *  - Api.fetchJson(path): static summary JSON, relative to the published site
 *    root (the Apps Script summariser commits summary/*.json into this repo).
 *  - Api.photo(id, token): token-checked photo proxy (doGet), returns base64.
 *
 * DEMO mode fakes all three with deterministic fixture data so the console
 * runs with zero setup: any 10-digit phone, pick the demo admin/supervisor,
 * set a PIN on first login.
 */
const Api = (() => {

  /** Per-attempt outcome counters for the Performance tab (one key per day). */
  function perfLog_(ok, ms, attempt) {
    try {
      const k = 'apiPerf_' + new Date().toISOString().slice(0, 10);
      const o = JSON.parse(localStorage.getItem(k) || '{"a":0,"ok":0,"f":0,"rt":0,"ms":0}');
      o.a++;
      if (ok) { o.ok++; o.ms += Math.round(ms); if (attempt > 0) o.rt++; } else o.f++;
      localStorage.setItem(k, JSON.stringify(o));
    } catch (e) { /* storage blocked: fine */ }
  }

  async function post(body) {
    if (window.CONSOLE_CONFIG.DEMO) return demoPost(body);
    // Alternate between the two live deployments of the same script, up to 5
    // attempts with jittered backoff (Google serving degradation 2026-08-19).
    const eps = window.CONSOLE_CONFIG.ENDPOINTS || [window.CONSOLE_CONFIG.ENDPOINT];
    let lastErr;
    for (let i = 0; i < 5; i++) {
      if (i) await new Promise(r => setTimeout(r, 400 + i * 300 + Math.random() * 600));
      const t0 = performance.now();
      try {
        const res = await fetch(eps[i % eps.length], {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();
        let parsed;
        try { parsed = JSON.parse(text); }
        catch (e) { throw new Error('SERVER_HTML'); }
        perfLog_(true, performance.now() - t0, i);
        return parsed;
      } catch (e) { perfLog_(false, performance.now() - t0, i); lastErr = e; }
    }
    throw lastErr;
  }

  async function fetchJson(path) {
    if (window.CONSOLE_CONFIG.DEMO) return demoJson(path);
    const res = await fetch(window.CONSOLE_CONFIG.SUMMARY_BASE + path + '?t=' + Date.now());
    if (!res.ok) return null;
    return res.json();
  }

  async function photo(id, token) {
    if (window.CONSOLE_CONFIG.DEMO) return demoPhoto();
    const res = await fetch(window.CONSOLE_CONFIG.ENDPOINT + '?action=photo&id=' +
      encodeURIComponent(id) + '&token=' + encodeURIComponent(token));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // ======================= DEMO fixtures =======================
  const D = {
    users: {
      U9001: { n: 'Demo Admin', p: '9000000001', c: 'OTHER', pj: '', sc: '', a: '', r: 'ADMIN', s: 'ACTIVE', la: 1 },
      // Second admin with leave sanction WITHDRAWN — full console access, no
      // Approve/Reject buttons. Demo mode has to show both states.
      U9003: { n: 'Demo Officer (no leave power)', p: '9000000003', c: 'OTHER', pj: '', sc: '', a: '', r: 'ADMIN', s: 'ACTIVE', la: 0 },
      U9002: { n: 'Demo Supervisor', p: '9000000002', c: 'SUPERVISOR', pj: 'JGN', sc: 'S01', a: '', r: 'SUPERVISOR', s: 'ACTIVE' },
      U9101: { n: 'K. Padma', p: '9000000011', c: 'AWT', pj: 'JGN', sc: 'S01', a: 'A0001', r: 'FIELD', s: 'ACTIVE' },
      U9102: { n: 'B. Swapna', p: '9000000011', c: 'AWH', pj: 'JGN', sc: 'S01', a: 'A0001', r: 'FIELD', s: 'ACTIVE' },
      U9103: { n: 'M. Lalitha', p: '9000000013', c: 'AWT', pj: 'JGN', sc: 'S01', a: 'A0002', r: 'FIELD', s: 'ACTIVE' },
      U9104: { n: 'G. Radha', p: '9000000014', c: 'AWT', pj: 'JGN', sc: 'S02', a: 'A0003', r: 'FIELD', s: 'ACTIVE' },
      U9105: { n: 'P. Sujatha', p: '9000000015', c: 'AWH', pj: 'JGN', sc: 'S02', a: 'A0003', r: 'FIELD', s: 'ACTIVE' },
      U9106: { n: 'T. Anitha', p: '9000000016', c: 'AWT', pj: 'KDK', sc: 'S11', a: 'A0101', r: 'FIELD', s: 'ACTIVE' },
      U9107: { n: 'S. Kavitha', p: '9000000017', c: 'AWT', pj: 'KDK', sc: 'S11', a: 'A0102', r: 'FIELD', s: 'ACTIVE' },
      U9108: { n: 'V. Bhavani', p: '9000000018', c: 'AWT', pj: 'SGN', sc: 'S21', a: 'A0201', r: 'FIELD', s: 'ACTIVE' }
    },
    awcs: {
      A0001: { n: 'Alipur-I', sc: 'S01', pj: 'JGN', lat: 17.8274, lng: 79.0162, r: 200 },
      A0002: { n: 'Alipur-II', sc: 'S01', pj: 'JGN', lat: 17.8301, lng: 79.0159, r: 200 },
      A0003: { n: 'Bommakur-I', sc: 'S02', pj: 'JGN', lat: 17.75, lng: 79.1, r: 200 },
      A0101: { n: 'Kodakandla-I', sc: 'S11', pj: 'KDK', lat: 17.6, lng: 79.2, r: 200 },
      A0102: { n: 'Kodakandla-II', sc: 'S11', pj: 'KDK', lat: null, lng: null, r: 200 },
      A0201: { n: 'Chilpur-I', sc: 'S21', pj: 'SGN', lat: 17.9, lng: 79.35, r: 200 }
    },
    projects: [
      { code: 'JGN', name: 'Jangaon' }, { code: 'KDK', name: 'Kodakandla' }, { code: 'SGN', name: 'Stn. Ghanpur' }
    ],
    sectors: [
      { code: 'S01', project: 'JGN', name: 'Bachannapeta' },
      { code: 'S02', project: 'JGN', name: 'Bommakur' },
      { code: 'S11', project: 'KDK', name: 'Kodakandla' },
      { code: 'S21', project: 'SGN', name: 'Chilpur' }
    ],
    pins: {} // uid -> pin set during demo session
  };

  const dToday = () => new Date().toISOString().slice(0, 10);
  const dYm = () => dToday().slice(0, 7);
  const dCompact = () => dToday().replace(/-/g, '');

  function demoTodayJson() {
    const agg = () => ({ expected: 0, in: 0, late: 0, out: 0, notMarked: 0, onLeave: 0, outside: 0, unverified: 0 });
    const rows = [
      { id: 'U9101', st: 'PRESENT', in: '09:02', out: null, gf: 'INSIDE', fl: '' },
      { id: 'U9102', st: 'LATE', in: '09:48', out: null, gf: 'INSIDE', fl: '' },
      { id: 'U9103', st: 'PRESENT', in: '08:55', out: null, gf: 'OUTSIDE', fl: '' },
      { id: 'U9104', st: 'NOT_MARKED', in: null, out: null, gf: null, fl: '' },
      { id: 'U9105', st: 'PRESENT', in: '09:10', out: null, gf: 'UNVERIFIED', fl: 'NO_PHOTO' },
      { id: 'U9106', st: 'PRESENT', in: '09:00', out: '15:45', gf: 'INSIDE', fl: '' },
      { id: 'U9107', st: 'ON_LEAVE', lv: 'CASUAL', in: null, out: null, gf: null, fl: '' },
      { id: 'U9108', st: 'PRESENT', in: '08:59', out: null, gf: 'INSIDE', fl: 'CLOCK_SKEW,FAKE_GPS_SUSPECT' },
      { id: 'U9002', st: 'PRESENT', in: '09:20', out: null, gf: 'INSIDE', fl: '' }
    ];
    const sectors = {}, projects = {}, district = agg();
    const exceptions = [];
    rows.forEach(e => {
      const u = D.users[e.id];
      e.s = u.sc || 'S01';
      e.a = u.a;
      e.ph = e.in ? 'demo-photo' : null;
      const s = sectors[e.s] = sectors[e.s] || agg();
      const p = projects[u.pj || 'JGN'] = projects[u.pj || 'JGN'] || agg();
      [s, p, district].forEach(g => {
        g.expected++;
        if (e.st === 'PRESENT') g.in++;
        if (e.st === 'LATE') g.late++;
        if (e.st === 'NOT_MARKED') g.notMarked++;
        if (e.st === 'ON_LEAVE') g.onLeave++;
        if (e.out) g.out++;
        if (e.gf === 'OUTSIDE') g.outside++;
        if (e.gf === 'UNVERIFIED') g.unverified++;
      });
      if (e.in && (e.gf !== 'INSIDE' || e.fl)) {
        exceptions.push({ key: e.id + '_' + dCompact() + '_IN', u: e.id, s: e.s, t: 'IN', at: e.in, gf: e.gf, fl: e.fl, ph: e.ph });
      }
    });
    return {
      generatedAt: new Date(Date.now() - 7 * 60000).toISOString(), date: dToday(), district: district,
      projects: Object.keys(projects).sort().map(c => Object.assign({ code: c }, projects[c])),
      sectors: Object.keys(sectors).sort().map(c => {
        const meta = D.sectors.find(s => s.code === c) || {};
        return Object.assign({ code: c, project: meta.project || '' }, sectors[c]);
      }),
      users: rows, exceptions: exceptions,
      rpt: demoRptAgg(), rpts: demoRptRows()
    };
  }

  /** Today's filed AWC reports — which centre, who filed, and what. */
  function demoRptRows() {
    const filed = [
      { a: 'A0001', u: 'U9101', at: '11:20', c: 24, p: 4, o: 2, f: '' },
      { a: 'A0002', u: 'U9103', at: '11:35', c: 19, p: 3, o: 1, f: 'NO_PHOTO_MEAL' },
      { a: 'A0003', u: 'U9104', at: '12:05', c: 31, p: 5, o: 3, f: '' },
      { a: 'A0101', u: 'U9106', at: '10:58', c: 22, p: 2, o: 2, f: '' }
    ];
    return filed.map(r => {
      const used = [r.c, Math.round(r.c * 0.12 * 10) / 10, Math.round(r.c * 0.03 * 10) / 10,
        r.c * 5, r.p * 5, Math.round(r.c * 0.15 * 10) / 10];
      return {
        a: r.a, u: r.u, s: (D.awcs[r.a] || {}).sc || 'S01', at: r.at,
        c: r.c, p: r.p, o: r.o, m: r.c + r.p, f: r.f,
        eg: used[0], rk: used[1], pk: used[2],
        st: used.map(v => [100, v, Math.round(v * 1.05 * 10) / 10,
          Math.round((100 + v * 1.05 - v) * 10) / 10]),
        ph1: 'demo-photo', ph2: 'demo-photo', ph3: 'demo-photo', ph4: 'demo-photo'
      };
    });
  }

  function demoRptAgg() {
    const rows = demoRptRows();
    const stock = {};
    ['eggs', 'rice', 'pulses', 'bal', 'balp', 'milk'].forEach((k, i) => {
      stock[k] = { ob: 0, used: 0, recd: 0, cb: 0 };
      rows.forEach(r => {
        stock[k].ob += r.st[i][0]; stock[k].used += r.st[i][1];
        stock[k].recd += r.st[i][2]; stock[k].cb += r.st[i][3];
      });
      ['ob', 'used', 'recd', 'cb'].forEach(f => { stock[k][f] = Math.round(stock[k][f] * 10) / 10; });
    });
    return {
      awcs: rows.length,
      children: rows.reduce((s, r) => s + r.c, 0),
      pregnant: rows.reduce((s, r) => s + r.p, 0),
      others: rows.reduce((s, r) => s + r.o, 0),
      meals: rows.reduce((s, r) => s + r.m, 0),
      eggs: rows.reduce((s, r) => s + r.eg, 0),
      riceKg: Math.round(rows.reduce((s, r) => s + r.rk, 0) * 10) / 10,
      pulsesKg: Math.round(rows.reduce((s, r) => s + r.pk, 0) * 10) / 10,
      stock: stock
    };
  }

  function demoMonthJson(sc) {
    const users = {};
    Object.keys(D.users).forEach(uid => {
      if (D.users[uid].sc !== sc || D.users[uid].r !== 'FIELD') return;
      const days = {};
      for (let d = 1; d <= Math.min(new Date().getDate(), 28); d++) {
        if (d % 7 === 0) continue; // weekly off
        const dd = String(d).padStart(2, '0');
        days[dd] = {
          IN: { t: d % 5 === 0 ? '09:41' : '09:0' + (d % 10), gf: d % 6 === 0 ? 'OUTSIDE' : 'INSIDE', d: 40, fl: '', ph: null, x: d % 9 === 0 ? 'ACC' : '' },
          OUT: { t: '15:3' + (d % 10), gf: 'INSIDE', d: 35, fl: '', ph: null, x: '' }
        };
      }
      users[uid] = days;
    });
    const leaves = sc === 'S01' ? { U9103: { '02': 'SICK', '03': 'SICK' } } : {};
    return { ym: dYm(), generatedAt: new Date().toISOString(), sector: sc, leaves: leaves, users: users };
  }

  const demoReviews = {};   // verdicts recorded during a demo session

  function demoJson(path) {
    if (path === 'summary/meta.json') {
      return { generatedAt: new Date(Date.now() - 7 * 60000).toISOString(),
        checkedAt: new Date(Date.now() - 2 * 60000).toISOString(), month: dYm(), date: dToday() };
    }
    if (path === 'summary/today.json') return demoTodayJson();
    if (path === 'summary/org.json') {
      const awcs = {};
      Object.keys(D.awcs).forEach(id => { awcs[id] = { n: D.awcs[id].n, sc: D.awcs[id].sc }; });
      return {
        generatedAt: new Date().toISOString(), projects: D.projects, sectors: D.sectors,
        schedules: [{ project_code: 'ALL', cadre: 'ALL', in_start: '08:30', in_end: '10:30',
          late_after: '09:30', out_start: '15:30', out_end: '17:30' }],
        awcs: awcs
      };
    }
    if (path === 'summary/exceptions.json') {
      return {
        ym: dYm(), generatedAt: new Date().toISOString(),
        open: [{ key: 'ANOM_U9103_' + dYm(), u: 'U9103', s: 'S01', d: dCompact(), t: 'ANOMALY', at: null, gf: 'STATIC_COORDS', fl: 'REPEAT_COORDS_5D', ph: null }]
      };
    }
    const vm2 = path.match(/^summary\/verify\/(\d{4}-\d{2})\.json$/);
    if (vm2) return demoVerifyMonth(vm2[1]);
    const rm = path.match(/^summary\/reports\/(\d{4}-\d{2})\.json$/);
    if (rm) {
      // A real district has no archive from before the system existed, and the
      // console has to render that case without implying a job is pending —
      // so the demo stops four months back rather than inventing history.
      const [ry, rmo] = rm[1].split('-').map(Number);
      const now = new Date();
      const back = (now.getFullYear() - ry) * 12 + (now.getMonth() + 1 - rmo);
      if (back > 3) return null;
      return demoReportMonth(rm[1]);
    }
    const m = path.match(/^summary\/month\/(S\d+)\.json$/) || path.match(/^summary\/archive\/[\d-]+\/(S\d+)\.json$/);
    if (m) return demoMonthJson(m[1]);
    return null;
  }

  async function demoPost(body) {
    await new Promise(r => setTimeout(r, 250));
    switch (body.action) {
      case 'login': {
        if (!/^\d{10}$/.test(String(body.phone || ''))) return { ok: false, code: 'BAD_PHONE' };
        const cands = Object.keys(D.users).filter(id =>
          ['ADMIN', 'SUPERVISOR', 'CDPO'].indexOf(D.users[id].r) >= 0);
        const uid = String(body.userId || '');
        if (cands.indexOf(uid) < 0) {
          return {
            ok: false, code: 'CHOOSE_USER',
            users: cands.map(id => ({ id: id, name: D.users[id].n, cadre: D.users[id].c }))
          };
        }
        if (body.newPin) {
          if (!/^\d{4}$/.test(String(body.newPin))) return { ok: false, code: 'BAD_PIN_FORMAT' };
          D.pins[uid] = String(body.newPin);
        } else if (!D.pins[uid]) {
          return { ok: false, code: 'SET_PIN_REQUIRED', userId: uid };
        } else if (!body.pin) {
          return { ok: false, code: 'PIN_REQUIRED' };
        } else if (String(body.pin) !== D.pins[uid]) {
          return { ok: false, code: 'WRONG_PIN', left: 4 };
        }
        const u = D.users[uid];
        return {
          ok: true, token: 'demo-' + uid,
          config: {
            user: { id: uid, name: u.n, cadre: u.c, project: u.pj, sector: u.sc, awcId: u.a,
              awcName: '', role: u.r, canApproveLeave: u.r === 'ADMIN' },
            serverTs: new Date().toISOString()
          }
        };
      }
      case 'nameMap': {
        const uid = String(body.token || '').replace('demo-', '');
        const me = D.users[uid];
        if (!me || me.r === 'FIELD') return { ok: false, code: 'FORBIDDEN' };
        const scoped = me.r === 'ADMIN' ? null : me.r === 'CDPO'
          ? D.sectors.filter(s => s.project === me.pj).map(s => s.code)
          : [me.sc];
        const users = {}, awcs = {};
        Object.keys(D.users).forEach(id => {
          if (scoped && scoped.indexOf(D.users[id].sc) < 0 && id !== uid) return;
          users[id] = D.users[id];
        });
        Object.keys(D.awcs).forEach(id => {
          if (scoped && scoped.indexOf(D.awcs[id].sc) < 0) return;
          awcs[id] = D.awcs[id];
        });
        return {
          ok: true, users: users, awcs: awcs, projects: D.projects,
          sectors: scoped ? D.sectors.filter(s => scoped.indexOf(s.code) >= 0) : D.sectors
        };
      }
      case 'mapDay':
        return demoMapDay();
      case 'reviewList':
        return { ok: true, ym: body.ym, reviews: demoReviews };
      case 'reviewFinding': {
        demoReviews[body.awcId + '|' + body.date] =
          { v: body.verdict, n: body.note || '', by: 'Demo Admin', at: new Date().toISOString() };
        return { ok: true, by: 'Demo Admin', at: new Date().toISOString() };
      }
      case 'leaveList':
        return { ok: true, leaves: demoLeaveApps() };
      case 'leaveRegister': {
        const apps = demoLeaveApps().map(l => Object.assign({ days: 1, by: 'ADMIN' }, l,
          { days: Math.round((new Date(l.to) - new Date(l.from)) / 86400000) + 1 }));
        const rows = {};
        apps.forEach(a => {
          const r = rows[a.u] || (rows[a.u] = { u: a.u, taken: {}, pend: {}, rej: {} });
          const b = a.status === 'APPROVED' ? r.taken : a.status === 'REJECTED' ? r.rej : r.pend;
          b[a.type] = (b[a.type] || 0) + a.days;
        });
        return {
          ok: true, year: String(new Date().getFullYear()),
          ent: { CASUAL: 6, EARNED: 30, OPTIONAL: 3 },   // 2026 rule
          types: ['OPTIONAL', 'CASUAL', 'EARNED', 'SICK'], uncapped: ['SICK'],
          labels: { OPTIONAL: 'Optional Holiday', CASUAL: 'Casual Leave',
            EARNED: 'Earned Leave', SICK: 'Medical Leave' },
          rows: Object.keys(rows).map(k => rows[k]), apps: apps
        };
      }
      case 'leaveDecideBulk': {
        // Demo mode has no store to mutate; it reports what a real bulk
        // decision would have changed so the bar behaves the same.
        const n = String(body.leaveIds || '').split(',').filter(Boolean).length;
        return { ok: true, changed: n, skipped: [] };
      }
      case 'leaveDedupe': {
        const extras = demoDupes();
        const who = {};
        extras.forEach(l => { who[l.u] = 1; });
        const out = {
          ok: true, duplicates: extras.length, workers: Object.keys(who).length,
          sample: extras.slice(0, 6).map(l => ({
            name: (D.users[l.u] || {}).n || l.u, from: l.from, type: l.type
          }))
        };
        if (body.commit === true || String(body.commit) === 'true') {
          extras.forEach(l => { demoSuperseded[l.id] = 1; });
          out.committed = extras.length;
        }
        return out;
      }
      case 'correction':
      case 'pinReset':
      case 'deviceUnbind':
      case 'setAwcCoords':
      case 'userUpsert':
      case 'setSchedules':
      case 'leaveDecide':
      case 'logout':
        return { ok: true, userId: body.userId, awcId: body.awcId };
      default:
        return { ok: true };
    }
  }

  /** Demo leave applications — shared by leaveList and leaveRegister so the
   *  Leaves tab and the register never show different data in demo mode. */
  function demoLeaveApps() {
    return [
      { id: 'LV-demo1', u: 'U9107', from: dToday(), to: dToday(), type: 'CASUAL',
        reason: 'Family function', status: 'APPROVED', at: new Date().toISOString(),
        mi: '', mc: '', mp: '', by: 'U9001', byName: 'Demo Admin',
        byAt: new Date().toISOString() },
      { id: 'LV-demo2', u: 'U9103', from: dYm() + '-02', to: dYm() + '-03', type: 'SICK',
        reason: 'Fever', status: 'APPROVED', at: new Date().toISOString(),
        mi: 'Area Hospital, Jangaon', mc: 'MC/2026/4417', mp: 'demo-photo',
        by: 'AUTO', byName: 'auto-approved', byAt: new Date().toISOString() },
      { id: 'LV-demo3', u: 'U9103', from: dYm() + '-10', to: dYm() + '-10', type: 'OPTIONAL',
        reason: 'Optional holiday', status: 'PENDING', at: new Date().toISOString(),
        mi: '', mc: '', mp: '', by: '', byName: '', byAt: '' }
    ].concat(
      // Four optional holidays already sanctioned against an entitlement of
      // three. The 2026 order cut the count mid-year, so this state exists in
      // the real district and demo mode has to be able to show it.
      ['01-01', '01-16', '03-10', '08-04'].map((d, i) => ({
        id: 'LV-demo-opt' + i, u: 'U9101',
        from: '2026-' + d, to: '2026-' + d, type: 'OPTIONAL',
        reason: 'Optional holiday', status: 'APPROVED', at: '2026-' + d + 'T09:00:00+05:30',
        mi: '', mc: '', mp: '', by: 'U9001', byName: 'Demo Admin',
        byAt: '2026-' + d + 'T10:00:00+05:30'
      }))).concat(
      // The same application recorded three times - one worker tapping SUBMIT
      // again on a slow network. The server guard that should have stopped it
      // was blind until 2026-08-25, so this state exists in the real district
      // and the console has to be able to show it and clear it.
      ['09:00', '09:01', '09:02'].map((t, i) => ({
        id: 'LV-demo-dup' + i, u: 'U9107',
        from: dYm() + '-20', to: dYm() + '-20', type: 'CASUAL',
        reason: 'Hospital', status: 'PENDING', at: dYm() + '-20T' + t + ':00+05:30',
        mi: '', mc: '', mp: '', by: '', byName: '', byAt: ''
      }))).map(l => demoSuperseded[l.id]
        ? Object.assign({}, l, { status: 'SUPERSEDED', by: 'U9001', byName: 'Demo Admin' })
        : l);
  }

  // Which demo applications the duplicate sweep has collapsed. Demo mode has
  // no store, so the one piece of state the sweep produces is kept here.
  const demoSuperseded = {};

  /** Extra copies of an identical application - all but the earliest. */
  function demoDupes() {
    const seen = {}, extras = [];
    demoLeaveApps().slice()
      .sort((a, b) => String(a.at) < String(b.at) ? -1 : 1)
      .forEach(l => {
        if (l.status === 'REJECTED' || l.status === 'SUPERSEDED') return;
        const k = [l.u, l.from, l.to, l.type].join('|');
        if (seen[k]) extras.push(l); else seen[k] = true;
      });
    return extras;
  }

  /** Demo map payload: one of every marker state, so the vocabulary can be
   *  checked without a live district behind it. */
  function demoMapDay() {
    const uids = Object.keys(D.users).filter(id => D.users[id].r === 'FIELD');
    const at = (i) => [17.60 + (i % 9) * 0.045, 79.00 + (i % 7) * 0.055];
    const present = [], absent = [], onLeave = [], filed = [];
    uids.forEach((id, i) => {
      const u = D.users[id];
      const c = at(i);
      // Deterministic spread so every marker state is present in demo mode,
      // whatever the demo roster size happens to be.
      const bucket = i % 6;
      if (bucket === 0) {
        absent.push({ id: id, role: u.r, unit: u.a, s: u.sc, lat: c[0], lng: c[1],
          acc: 40, seenAt: i % 12 === 0 ? '09:14' : '',
          lastDate: i % 12 === 0 ? '' : dYm() + '-11' });
      } else if (bucket === 1) {
        onLeave.push({ id: id, role: u.r, unit: u.a, s: u.sc, lat: c[0], lng: c[1],
          acc: 60, lv: 'CASUAL', seenAt: '', lastDate: dYm() + '-09' });
      } else {
        const doubtful = bucket === 2;
        const coarse = bucket === 3;
        present.push({ id: id, role: u.r, unit: u.a, s: u.sc, at: '09:0' + (i % 9),
          lat: c[0], lng: c[1], acc: doubtful ? 900 : coarse ? 400 : 18,
          verified: !doubtful && !coarse, tz: 'Asia/Kolkata', gf: 'INSIDE', fl: '',
          marks: i % 3 === 0 ? 2 : 1,
          doubts: doubtful ? ['accuracy is 900 m, worse than the 250 m limit'] : [] });
      }
    });
    Object.keys(D.awcs).slice(0, 6).forEach((aid, i) => {
      const a = D.awcs[aid], c = at(i + 2);
      filed.push({ id: 'RPT' + i, unit: aid, s: a.sc, lat: c[0], lng: c[1], at: '11:2' + i,
        children: 20 + i, meals: 18 + i, flag: i === 1 ? 'NO_PHOTO_MEAL' : '',
        grade: i === 1 ? 'FLAGGED' : 'COMPLETE', date: dToday() });
    });
    return { ok: true, generatedAt: new Date().toISOString(), date: dToday(),
      box: { minLat: 17.45, maxLat: 18.06, minLng: 78.67, maxLng: 79.60 },
      centre: { lat: 17.7566, lng: 79.1361, zoom: 10 }, accLimit: 250,
      present: present, onLeave: onLeave, absent: absent, filed: filed };
  }

  /**
   * Demo daily-report archive. Deterministic from (awc, day) so the numbers
   * stay put across redraws — a demo whose figures jiggle on every render is
   * useless for checking a table.
   */
  function demoReportMonth(ym) {
    const STOCK = ['eggs', 'rice', 'pulses', 'bal', 'balp', 'milk'];
    const y = Number(ym.slice(0, 4)), mo = Number(ym.slice(5, 7));
    const dim = new Date(y, mo, 0).getDate();
    const today = new Date();
    const isCur = ym === dYm();
    const lastDay = isCur ? today.getDate() : dim;
    // Only months at or before the current one have any data at all.
    if (new Date(y, mo - 1, 1) > new Date(today.getFullYear(), today.getMonth(), 1)) {
      return { ym: ym, generatedAt: new Date().toISOString(), days: {}, awcs: {} };
    }
    const ids = Object.keys(D.awcs);
    const days = {}, awcs = {};
    const blank = () => { const o = {}; STOCK.forEach(k => { o[k] = [0, 0, 0, 0]; }); return o; };
    // Sum the whole id: indexing past its length yields NaN, which poisons
    // every number downstream.
    const seed = (a, d) => {
      let h = d * 13;
      for (let i = 0; i < a.length; i++) h += a.charCodeAt(i) * (i + 3);
      return h % 17;
    };
    for (let d = 1; d <= lastDay; d++) {
      const dow = new Date(y, mo - 1, d).getDay();
      if (dow === 0) continue;                       // no Sunday reports
      const dd = String(d).padStart(2, '0');
      const day = { awcs: 0, c: 0, p: 0, o: 0, m: 0, st: blank() };
      ids.forEach(aid => {
        if (seed(aid, d) % 5 === 0) return;          // that centre missed the day
        const c = 16 + seed(aid, d), p = 2 + (seed(aid, d) % 4);
        const ot = 1 + (seed(aid, d) % 3), m = c + p;
        const a = awcs[aid] || (awcs[aid] = { s: D.awcs[aid].sc, d: {}, st: blank() });
        const used = [c, Math.round(c * 0.12 * 10) / 10, Math.round(c * 0.03 * 10) / 10,
          c * 5, p * 5, Math.round(c * 0.15 * 10) / 10];
        a.d[dd] = [c, p, ot, m].concat(used);
        STOCK.forEach((k, i) => {
          a.st[k][1] = Math.round((a.st[k][1] + used[i]) * 10) / 10;
          a.st[k][2] = Math.round((a.st[k][2] + used[i] * 1.05) * 10) / 10;
          a.st[k][0] = 100; a.st[k][3] = Math.round((100 + a.st[k][2] - a.st[k][1]) * 10) / 10;
          day.st[k][1] = Math.round((day.st[k][1] + used[i]) * 10) / 10;
        });
        day.awcs++; day.c += c; day.p += p; day.o += ot; day.m += m;
      });
      days[dd] = day;
    }
    return { ym: ym, generatedAt: new Date().toISOString(),
      fields: ['children', 'pregnant', 'others', 'meals'].concat(STOCK.map(k => k + '_used')),
      items: STOCK, days: days, awcs: awcs };
  }

  /** A demo verification run: the reported case plus a couple of others. */
  function demoVerifyMonth(ym) {
    if (ym !== dYm()) return null;   // only the current month has a run in demo
    const ids = Object.keys(D.awcs);
    const dd = String(new Date().getDate() - 1).padStart(2, '0');
    const mk = (a, d, score, reasons, n) => ({
      a: a, s: D.awcs[a].sc, d: d, score: score, r: reasons, n: n,
      ph: { c: 'demo-photo', m: 'demo-photo', p: 'demo-photo', o: 'demo-photo' }
    });
    return {
      ym: ym, generatedAt: new Date().toISOString(),
      items: ['eggs', 'rice', 'pulses', 'bal', 'balp', 'milk'],
      // The district's fitted expectation per beneficiary: [per child, per
      // pregnant woman, per other]. The real file carries one of these per
      // day; without it the verification cards have nothing to compare a
      // centre against and fall back to bare text.
      medians: (function () {
        const fit = {
          eggs: { b: [0.66, 0.88, 2.41], n: 1036, r2: 0.62 },
          rice: { b: [0.11, 0.14, 0.30], n: 1036, r2: 0.55 },
          meals: { b: [1.07, 0.65, 0.26], n: 1036, r2: 0.91 },
          pulses: null, bal: null, balp: null, milk: null
        };
        const out = {};
        for (let d = 1; d <= 31; d++) out[String(d).padStart(2, '0')] = fit;
        return out;
      })(),
      findings: [
        mk(ids[0], dd, 84, [
          { code: 'MEALS_SHORT', w: 40,
            t: '10 children, 2 pregnant women and 1 other were reported present, but only 3 meals were prepared.' },
          { code: 'PERHEAD_LOW', w: 22,
            t: 'For 10 children, only 2 eggs were used. Centres across the district used about 10 eggs for that many children today.' },
          { code: 'PERHEAD_LOW', w: 22,
            t: 'For 10 children, only 0.2 kg of rice was used. Centres across the district used about 1 kg of rice for that many children today.' }
        ], { c: 10, p: 2, o: 1, m: 3, u: [2, 0.2, 0.1, 10, 5, 0.3] }),
        mk(ids[1], dd, 30, [
          { code: 'LEDGER_OFF', w: 30,
            t: 'The eggs register does not balance: closing is 40 more than opening plus received minus used.' }
        ], { c: 21, p: 3, o: 2, m: 26, u: [21, 2.1, 0.6, 105, 15, 3.2] }),
        mk(ids[2], String(Math.max(1, new Date().getDate() - 3)).padStart(2, '0'), 25, [
          { code: 'MEALS_EXCESS', w: 25,
            t: '60 meals were prepared for 22 people reported present.' }
        ], { c: 18, p: 3, o: 1, m: 60, u: [18, 1.8, 0.5, 90, 15, 2.7] })
      ],
      centres: [
        { a: ids[3], s: D.awcs[ids[3]].sc, days: 14, mean: 10, score: 32, r: [
          { code: 'FLAT_COUNT', w: 18,
            t: 'Exactly 10 children were reported on all 14 days filed this month. Real attendance varies.' },
          { code: 'PEER_OUTLIER', w: 14,
            t: 'This centre reports about 10 children a day; the middle centre in its sector reports about 22.' }
        ] }
      ]
    };
  }

  function demoPhoto() {
    // 1x1 grey JPEG placeholder.
    const c = document.createElement('canvas');
    c.width = 320; c.height = 320;
    const x = c.getContext('2d');
    x.fillStyle = '#888'; x.fillRect(0, 0, 320, 320);
    x.fillStyle = '#fff'; x.font = 'bold 20px sans-serif';
    x.fillText('DEMO PHOTO', 90, 165);
    return { ok: true, mime: 'image/jpeg', b64: c.toDataURL('image/jpeg').split(',')[1] };
  }

  return { post: post, fetchJson: fetchJson, photo: photo };
})();
