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

  async function post(body) {
    if (window.CONSOLE_CONFIG.DEMO) return demoPost(body);
    // Alternate between the two live deployments of the same script, up to 5
    // attempts with jittered backoff (Google serving degradation 2026-08-19).
    const eps = window.CONSOLE_CONFIG.ENDPOINTS || [window.CONSOLE_CONFIG.ENDPOINT];
    let lastErr;
    for (let i = 0; i < 5; i++) {
      if (i) await new Promise(r => setTimeout(r, 400 + i * 300 + Math.random() * 600));
      try {
        const res = await fetch(eps[i % eps.length], {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();
        try { return JSON.parse(text); }
        catch (e) { throw new Error('SERVER_HTML'); }
      } catch (e) { lastErr = e; }
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
      U9001: { n: 'Demo Admin', p: '9000000001', c: 'OTHER', pj: '', sc: '', a: '', r: 'ADMIN', s: 'ACTIVE' },
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
      users: rows, exceptions: exceptions
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
            user: { id: uid, name: u.n, cadre: u.c, project: u.pj, sector: u.sc, awcId: u.a, awcName: '', role: u.r },
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
      case 'leaveList':
        return {
          ok: true,
          leaves: [
            { id: 'LV-demo1', u: 'U9107', from: dToday(), to: dToday(), type: 'CASUAL',
              reason: 'Family function', status: 'APPROVED', at: new Date().toISOString() },
            { id: 'LV-demo2', u: 'U9103', from: dYm() + '-02', to: dYm() + '-03', type: 'SICK',
              reason: 'Fever', status: 'APPROVED', at: new Date().toISOString() }
          ]
        };
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
