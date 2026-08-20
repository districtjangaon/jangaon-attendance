'use strict';
/**
 * Monitoring console. Reads pre-computed summary JSON (never the raw Marks
 * sheet); names and phones come only from the authenticated nameMap call, so
 * the public JSON stays pseudonymous. Server enforces scope — this UI only
 * decides what to draw.
 */
const App = (() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let token = sessionStorage.getItem('cons_token') || null;
  let me = JSON.parse(sessionStorage.getItem('cons_me') || 'null');
  let names = null;        // nameMap result: users, awcs, projects, sectors
  let today = null, meta = null, nightlyExc = [];
  let orgData = null;      // org.json (sector/project names, schedules)
  let drill = { level: 'district', code: null };
  let monthData = null;
  let loginSel = null;
  let reportRows = null, reportHead = null;
  let refreshTimer = null;

  // ---------------- login ----------------
  function resetLogin() {
    loginSel = null;
    $('whoami-block').hidden = true;
    $('newpin-block').hidden = true;
    $('pin-block').hidden = false;
    $('login-msg').textContent = '';
  }

  function renderWhoami(users) {
    const list = $('whoami-list');
    list.innerHTML = '';
    users.forEach(u => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = loginSel === u.id ? 'sel' : '';
      b.textContent = u.name + ' (' + u.cadre + ')';
      b.onclick = () => { loginSel = u.id; renderWhoami(users); };
      list.appendChild(b);
    });
    $('whoami-block').hidden = false;
  }

  async function doLogin() {
    const phone = $('in-phone').value.trim();
    const msg = $('login-msg');
    msg.textContent = '';
    if (!/^\d{10}$/.test(phone)) { msg.textContent = 'Enter the 10-digit mobile number.'; return; }

    const body = { action: 'login', phone: phone, deviceId: 'console-' + phone };
    if (loginSel) body.userId = loginSel;
    if (!$('newpin-block').hidden) {
      const p1 = $('in-newpin').value.trim(), p2 = $('in-newpin2').value.trim();
      if (!/^\d{4}$/.test(p1)) { msg.textContent = 'PIN must be exactly 4 digits.'; return; }
      if (p1 !== p2) { msg.textContent = 'The two PINs do not match.'; return; }
      body.newPin = p1;
    } else {
      const pin = $('in-pin').value.trim();
      if (pin && !/^\d{4}$/.test(pin)) { msg.textContent = 'PIN must be exactly 4 digits.'; return; }
      if (pin) body.pin = pin;
      // Empty PIN still submits: the server decides between CHOOSE_USER,
      // SET_PIN_REQUIRED (first login) and PIN_REQUIRED.
    }

    $('btn-login').disabled = true;
    try {
      const res = await Api.post(body);
      if (res.ok) {
        if (res.config.user.role === 'FIELD') {
          msg.textContent = 'This console is for supervisors and admin. Please use the attendance app.';
          return;
        }
        token = res.token;
        me = res.config.user;
        sessionStorage.setItem('cons_token', token);
        sessionStorage.setItem('cons_me', JSON.stringify(me));
        resetLogin();
        await boot();
        return;
      }
      if (res.code === 'CHOOSE_USER') {
        renderWhoami(res.users || []);
        msg.textContent = 'Choose your account above, then sign in.';
      } else if (res.code === 'SET_PIN_REQUIRED') {
        if (res.userId) loginSel = res.userId;
        $('newpin-block').hidden = false;
        $('pin-block').hidden = true;
        msg.textContent = 'First login: set your PIN.';
      } else {
        msg.textContent = {
          NO_USER: 'Number not registered.', PIN_REQUIRED: 'Enter your 4-digit PIN.',
          WRONG_PIN: 'Wrong PIN.' + (res.left ? ' Attempts left: ' + res.left : ''),
          LOCKED: 'Locked after failed attempts. Try again in 15 minutes.',
          RATE_LIMIT: 'Too many attempts, wait an hour.', INACTIVE: 'Account deactivated.',
          DEVICE_MISMATCH: 'Account bound to another device — ask admin to unbind.'
        }[res.code] || ('Login failed (' + res.code + ').');
      }
    } catch (e) {
      msg.textContent = 'Cannot reach the server. Check connection.';
    } finally {
      $('btn-login').disabled = false;
    }
  }

  function doLogout() {
    if (token) Api.post({ action: 'logout', token: token }).catch(() => {});
    token = null; me = null; names = null;
    sessionStorage.removeItem('cons_token');
    sessionStorage.removeItem('cons_me');
    $('main').hidden = true;
    $('btn-logout').hidden = true;
    $('head-user').textContent = '';
    $('screen-login').hidden = false;
  }

  function authLost() {
    doLogout();
    $('login-msg').textContent = 'Session expired — sign in again.';
  }

  // ---------------- boot & data ----------------
  async function boot() {
    // District decision 2026-08-18: supervisors work ONLY in the mobile app
    // (sector counts + issue flagging live there). The console is for the
    // district admin team and CDPOs.
    if (me && me.role === 'SUPERVISOR') {
      doLogout();
      $('login-msg').textContent =
        'Supervisors use the mobile app — your sector view and issue flagging are on your phone.';
      return;
    }
    const nm = await Api.post({ action: 'nameMap', token: token });
    if (!nm.ok) { authLost(); return; }
    names = nm;
    $('screen-login').hidden = true;
    $('main').hidden = false;
    $('btn-logout').hidden = false;
    $('head-user').textContent = me.name + ' (' + me.role + ')';
    $('tab-admin').hidden = false; // server scopes what each role can actually do
    // Performance tab: district admin's own number only (demo shows it too).
    const myRow = names.users[me.id];
    $('tab-perf').hidden = !((myRow && String(myRow.p) === '9625701988') ||
      window.CONSOLE_CONFIG.DEMO);
    fillMonthControls();
    fillReportControls();
    fillAnalyticsControls();
    fillAwcPicker();
    await refreshAll();
    // The published data regenerates every ~5 min; the screen re-reads it
    // every 30 s so nobody ever presses Refresh.
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (!document.hidden && token) refreshAll();
    }, 30000);
  }

  async function refreshAll() {
    [meta, today, orgData] = await Promise.all([
      Api.fetchJson('summary/meta.json'),
      Api.fetchJson('summary/today.json'),
      orgData ? Promise.resolve(orgData) : Api.fetchJson('summary/org.json')
    ]);
    const exc = await Api.fetchJson('summary/exceptions.json');
    nightlyExc = (exc && exc.open) || [];
    renderStale();
    renderToday();
    renderExceptions();
    renderRpts();
  }

  function renderStale() {
    const b = $('stale-banner');
    if (!today || !today.generatedAt) {
      b.hidden = false;
      b.className = 'banner err';
      b.textContent = 'No summary data published yet — check the Apps Script triggers and GitHub token.';
      return;
    }
    // Liveness (checkedAt heartbeat) and data age (generatedAt) are
    // different things: idle-but-healthy must not look like a failure.
    const dataTime = new Date(today.generatedAt);
    const checked = (meta && meta.checkedAt) ? new Date(meta.checkedAt) : dataTime;
    const aliveMin = Math.round((Date.now() - checked.getTime()) / 60000);
    const hhmm = d => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    b.hidden = false;
    const dataMin = Math.round((Date.now() - dataTime.getTime()) / 60000);
    if (aliveMin <= 40) {
      b.className = 'banner ok';
      b.textContent = '✓ System live. Attendance as of ' + hhmm(dataTime) +
        ' (' + (dataMin < 1 ? 'just now' : dataMin + ' min ago') +
        ') — nothing new since then; updates land within ~5 minutes of any mark.';
    } else if (aliveMin <= 90) {
      b.className = 'banner warn';
      b.textContent = 'Updates delayed — last server check ' + aliveMin +
        ' min ago (data as of ' + hhmm(dataTime) + ').';
    } else {
      b.className = 'banner err';
      b.textContent = 'Not updating — last server check ' + aliveMin + ' min ago. ' +
        'Check the Apps Script triggers and GitHub token. Data shown is from ' + hhmm(dataTime) + '.';
    }
  }

  // ---------------- helpers ----------------
  const userName = uid => (names.users[uid] && names.users[uid].n) || uid;
  const awcName = a => (names.awcs[a] && names.awcs[a].n) ||
    (window._org && window._org.awcs[a] && window._org.awcs[a].n) || a || '';
  const sectorName = sc => {
    const s = (names.sectors || []).find(x => x.code === sc);
    return s ? s.name : sc;
  };
  /** Multi-sector charge lists render compactly, never as a wall of codes. */
  const sectorDisplay = sc => {
    const parts = String(sc || '').split(',').map(x => x.trim()).filter(Boolean);
    if (parts.length <= 1) return sectorName(sc);
    if (parts.length >= 27) return 'All sectors (27)';
    return sectorName(parts[0]) + ' +' + (parts.length - 1) + ' more';
  };
  const projectName = pc => {
    const p = (names.projects || []).find(x => x.code === pc);
    return p ? p.name : pc;
  };
  const inScopeUid = uid => !!names.users[uid];

  function statusTag(st) { return '<span class="tag ' + esc(st) + '">' + esc(st.replace('_', ' ')) + '</span>'; }
  function gfTag(gf) { return gf ? '<span class="tag ' + esc(gf) + '">' + esc(gf) + '</span>' : ''; }
  function ratePill(pct) {
    return '<span class="pill-rate ' +
      (pct >= 85 ? 'pr-good' : pct >= 70 ? 'pr-mid' : 'pr-bad') + '">' + pct + '%</span>';
  }

  function downloadCsv(name, rows) {
    const csv = rows.map(r => r.map(c => {
      const s = String(c == null ? '' : c);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------------- Today / Dashboard ----------------
  const PALETTE = ['#4f5ce5', '#0ca38a', '#e8a020', '#e4572e', '#d13438', '#8b5cf6'];

  function bigcard(cls, k, v, sub) {
    return '<div class="bigcard ' + cls + '"><div class="k">' + esc(k) + '</div>' +
      '<div class="v">' + esc(v) + '</div>' + (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + '</div>';
  }

  function donutSVG(parts) {
    const total = parts.reduce((s, p) => s + p.value, 0);
    if (!total) return '<p class="info">No IN marks yet today.</p>';
    const R = 45, C = 2 * Math.PI * R;
    let off = 0, segs = '';
    parts.forEach((p, i) => {
      if (!p.value) return;
      const frac = p.value / total;
      segs += '<circle r="' + R + '" cx="60" cy="60" fill="none" stroke="' + PALETTE[i % 6] +
        '" stroke-width="22" stroke-dasharray="' + (frac * C).toFixed(2) + ' ' + C.toFixed(2) +
        '" stroke-dashoffset="' + (-off * C).toFixed(2) + '" transform="rotate(-90 60 60)"></circle>';
      off += frac;
    });
    const legend = parts.map((p, i) => '<div><i style="background:' + PALETTE[i % 6] + '"></i>' +
      esc(p.label) + ' — ' + p.value + '</div>').join('');
    return '<svg width="130" height="130" viewBox="0 0 120 120">' + segs +
      '<text x="60" y="66" text-anchor="middle" font-size="20" font-weight="700">' + total + '</text></svg>' +
      '<div class="legend">' + legend + '</div>';
  }

  function trendSVG(inTimes, opts) {
    opts = opts || {};
    const word = opts.word || 'IN';
    const col = opts.color || '#4f5ce5';
    const fill = opts.fill || 'rgba(79,92,229,.14)';
    if (!inTimes.length) return '<p class="info">No ' + word + ' marks yet today.</p>';
    const mins = inTimes.map(t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))).sort((a, b) => a - b);
    const start = (opts.startH || 6) * 60, end = (opts.endH || 18) * 60, W = 340, H = 130, PB = 22, PL = 30;
    const x = m => PL + Math.min(1, Math.max(0, (m - start) / (end - start))) * (W - PL - 8);
    const y = c => (H - PB) - (c / mins.length) * (H - PB - 12);
    let path = 'M' + PL + ',' + (H - PB);
    mins.forEach((m, i) => { path += ' L' + x(m).toFixed(1) + ',' + y(i + 1).toFixed(1); });
    const area = path + ' L' + x(mins[mins.length - 1]).toFixed(1) + ',' + (H - PB) + ' Z';
    let labels = '';
    for (let h = start / 60; h <= end / 60; h += 3) {
      labels += '<text x="' + x(h * 60).toFixed(0) + '" y="' + (H - 6) +
        '" font-size="10" fill="#888" text-anchor="middle">' + h + ':00</text>';
    }
    return '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' +
      '<line x1="' + PL + '" y1="' + (H - PB) + '" x2="' + (W - 6) + '" y2="' + (H - PB) + '" stroke="#ddd"/>' +
      '<path d="' + area + '" fill="' + fill + '"/>' +
      '<path d="' + path + '" fill="none" stroke="' + col + '" stroke-width="2"/>' +
      '<text x="' + PL + '" y="12" font-size="11" fill="#555">' + mins.length + ' marked ' + word + ' (cumulative)</text>' +
      labels + '</svg>';
  }

  function renderCharts(rows) {
    const inTimes = rows.map(e => e.in).filter(Boolean);
    const buckets = [
      { label: 'Before 9:00', value: 0 }, { label: '9:00–9:30', value: 0 },
      { label: '9:30–10:00', value: 0 }, { label: '10:00–11:00', value: 0 },
      { label: 'After 11:00', value: 0 }
    ];
    inTimes.forEach(t => {
      const m = Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
      buckets[m < 540 ? 0 : m < 570 ? 1 : m < 600 ? 2 : m < 660 ? 3 : 4].value++;
    });
    $('chart-intime').innerHTML = donutSVG(buckets);
    $('chart-trend').innerHTML = trendSVG(inTimes);

    // OUT mirrors of the two charts above; buckets follow the OUT window
    // (out_start 15:30 · out_end 17:30 in the default schedule).
    const outTimes = rows.map(e => e.out).filter(Boolean);
    const outBuckets = [
      { label: 'Before 15:30', value: 0 }, { label: '15:30–16:30', value: 0 },
      { label: '16:30–17:30', value: 0 }, { label: 'After 17:30', value: 0 }
    ];
    outTimes.forEach(t => {
      const m = Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
      outBuckets[m < 930 ? 0 : m < 990 ? 1 : m < 1050 ? 2 : 3].value++;
    });
    $('chart-outtime').innerHTML = outTimes.length
      ? donutSVG(outBuckets) : '<p class="info">No OUT marks yet today.</p>';
    $('chart-outtrend').innerHTML = trendSVG(outTimes,
      { word: 'OUT', startH: 12, endH: 21, color: '#0ca38a', fill: 'rgba(12,163,138,.14)' });

    // Sector Top-10 (horizontal — sector names stay readable) and project
    // bars, per the district's BI sample. The '?' bucket (users with no
    // sector — a master-data error) never charts.
    const secBars = today.sectors.filter(s => s.code && s.code !== '?').map(s => ({
      label: sectorName(s.code),
      title: sectorName(s.code) + ': ' + (s.in + s.late) + '/' + s.expected + ' marked',
      value: s.expected ? Math.round(100 * (s.in + s.late) / s.expected) : 0,
      color: Charts.PAL[3]
    })).sort((a, b) => b.value - a.value).slice(0, 10);
    $('chart-sector').innerHTML = secBars.some(b => b.value > 0)
      ? Charts.hbar(secBars, { pct: true })
      : '<p class="info">No sector has marks yet today.</p>';

    const projBars = today.projects.filter(p => p.code && p.code !== '?').map((p, i) => ({
      label: projectName(p.code),
      title: projectName(p.code) + ': ' + (p.in + p.late) + ' of ' + p.expected + ' marked IN',
      value: p.in + p.late,
      color: Charts.PAL[(i + 4) % 8]
    }));
    $('chart-project').innerHTML = projBars.some(b => b.value > 0)
      ? Charts.hbar(projBars)
      : '<p class="info">No marks yet today.</p>';

    // Geofence verification and status donuts fill the remaining grid cells.
    const gf = { INSIDE: 0, OUTSIDE: 0, UNVERIFIED: 0 };
    rows.forEach(e => { if (e.gf && gf[e.gf] != null) gf[e.gf]++; });
    $('chart-verify').innerHTML = Charts.donut([
      { label: 'Inside fence', value: gf.INSIDE, color: '#178a4c' },
      { label: 'Outside fence', value: gf.OUTSIDE, color: '#d97706' },
      { label: 'GPS unverified', value: gf.UNVERIFIED, color: '#9aa1b8' }
    ]);

    const st = { PRESENT: 0, LATE: 0, ON_LEAVE: 0, NOT_MARKED: 0 };
    rows.forEach(e => { if (!e.x && st[e.st] != null) st[e.st]++; });
    $('chart-status').innerHTML = Charts.donut([
      { label: 'On time', value: st.PRESENT, color: '#178a4c' },
      { label: 'Late', value: st.LATE, color: '#d97706' },
      { label: 'On leave', value: st.ON_LEAVE, color: '#4f5ce5' },
      { label: 'Not marked', value: st.NOT_MARKED, color: '#d13438' }
    ]);

    // ---- second-row fillers: reports, beneficiaries, stock, OUT, adoption,
    // bottom sectors — all from today.json, no extra requests.
    const rpt = today.rpt || {};
    const totalAwcs = names && names.awcs ? Object.keys(names.awcs).length : 0;
    $('chart-rptprog').innerHTML = totalAwcs
      ? Charts.donut([
          { label: 'Reported', value: rpt.awcs || 0, color: '#178a4c' },
          { label: 'Pending', value: Math.max(0, totalAwcs - (rpt.awcs || 0)), color: '#d13438' }
        ])
      : '<p class="info">No AWC list loaded.</p>';

    $('chart-benef').innerHTML = (rpt.awcs || 0)
      ? Charts.bar([
          { label: 'Children', value: rpt.children || 0, color: Charts.PAL[0] },
          { label: 'Pregnant', value: rpt.pregnant || 0, color: Charts.PAL[5] },
          { label: 'Others', value: rpt.others || 0, color: Charts.PAL[6] },
          { label: 'Meals', value: rpt.meals || 0, color: Charts.PAL[1] }
        ])
      : '<p class="info">No reports yet today.</p>';

    const stk = rpt.stock || {};
    const stkDef = [['eggs', 'Eggs', ''], ['rice', 'Rice', ' kg'], ['pulses', 'Pulses', ' kg'],
      ['bal', 'Balamrutham', ' ml'], ['balp', 'Balamrutham+', ' ml'], ['milk', 'Milk', ' L']];
    $('chart-stockused').innerHTML = stkDef.some(d => stk[d[0]] && stk[d[0]].used)
      ? Charts.bar(stkDef.map((d, i) => ({
          label: d[1].slice(0, 6), value: (stk[d[0]] && stk[d[0]].used) || 0,
          title: d[1] + ' used: ' + ((stk[d[0]] && stk[d[0]].used) || 0) + d[2],
          color: Charts.PAL[i % 8]
        })))
      : '<p class="info">No stock usage reported yet.</p>';

    const outDone = rows.filter(e => e.out).length;
    const stillIn = rows.filter(e => (e.st === 'PRESENT' || e.st === 'LATE') && !e.out).length;
    $('chart-outdone').innerHTML = (outDone + stillIn)
      ? Charts.donut([
          { label: 'Marked OUT', value: outDone, color: '#4f5ce5' },
          { label: 'IN, not yet OUT', value: stillIn, color: '#d97706' }
        ])
      : '<p class="info">Nobody has marked yet.</p>';

    $('chart-adopt').innerHTML = (today.adopt && today.adopt.staff)
      ? Charts.donut([
          { label: 'Installed app', value: today.adopt.app || 0, color: '#178a4c' },
          { label: 'Chrome only', value: today.adopt.chrome || 0, color: '#d97706' },
          { label: 'Never logged in', value: Math.max(0, today.adopt.staff - today.adopt.onboarded), color: '#d13438' }
        ])
      : '<p class="info">No adoption data yet.</p>';

    const lowBars = today.sectors.filter(s => s.code && s.code !== '?' && s.expected > 0).map(s => ({
      label: sectorName(s.code),
      title: sectorName(s.code) + ': ' + (s.in + s.late) + '/' + s.expected + ' marked',
      value: s.expected ? Math.round(100 * (s.in + s.late) / s.expected) : 0,
      color: '#d13438'
    })).sort((a, b) => a.value - b.value).slice(0, 10);
    $('chart-sector-low').innerHTML = lowBars.length
      ? Charts.hbar(lowBars, { pct: true })
      : '<p class="info">No sectors to show.</p>';
  }

  function renderToday() {
    if (!today) { $('today-table').innerHTML = '<p class="info">No data.</p>'; return; }

    // Supervisors land on their own sector; CDPOs on their project.
    if (drill.level === 'district' && me.role === 'SUPERVISOR') drill = { level: 'sector', code: me.sector };
    if (drill.level === 'district' && me.role === 'CDPO') drill = { level: 'project', code: me.project };

    let agg = today.district;
    if (drill.level === 'project') {
      agg = (today.projects.find(p => p.code === drill.code)) || agg;
    } else if (drill.level === 'sector') {
      agg = (today.sectors.find(s => s.code === drill.code)) || agg;
    }

    const scopeRows = today.users.filter(e => inScopeUid(e.id));
    const staffCount = Object.keys(names.users).filter(id => names.users[id].r === 'FIELD').length;
    const awcCount = Object.keys(names.awcs || {}).length;
    const onLeave = agg.onLeave || 0;
    const note = $('holiday-note');
    if (today.holiday) {
      note.hidden = false;
      note.textContent = '🎉 Today is ' + today.holiday + ' — a holiday. Attendance is not expected; ' +
        'marks below are voluntary duty.';
      $('today-cards').innerHTML =
        bigcard('bc-teal', 'Voluntary marks today', agg.in + agg.late, 'IN marks on this holiday') +
        bigcard('bc-blue', 'On approved leave', onLeave, '') +
        bigcard('bc-maroon', 'Registered employees', staffCount, 'AWT + AWH on the rolls') +
        bigcard('bc-grey', 'Registered AWCs', awcCount, 'centres in scope');
    } else {
      note.hidden = true;
      $('today-cards').innerHTML =
        bigcard('bc-teal', 'Present today', agg.in + agg.late, 'on time ' + agg.in + ' · late ' + agg.late) +
        bigcard('bc-red', 'Not marked', agg.notMarked, 'of ' + agg.expected + ' expected') +
        bigcard('bc-blue', 'On leave', onLeave, 'approved applications') +
        bigcard('bc-olive', 'Marked OUT', agg.out, 'day complete') +
        bigcard('bc-maroon', 'Registered employees', staffCount, 'AWT + AWH on the rolls') +
        bigcard('bc-grey', 'Flagged marks', agg.outside + agg.unverified,
          'outside fence ' + agg.outside + ' · GPS unverified ' + agg.unverified);
    }
    // Launch adoption: staff who completed first login + device-bound phones.
    if (today.adopt && drill.level === 'district') {
      $('today-cards').innerHTML +=
        bigcard('bc-blue', 'App adoption — logged in', today.adopt.onboarded,
          'field staff & supervisors with first login done · ' + today.adopt.devices + ' devices bound' +
          (today.adopt.app != null
            ? ' · installed app ' + today.adopt.app + ' · Chrome only ' + today.adopt.chrome : ''));
    }
    // AWC daily reports (children / pregnant / others / meals) — district-wide
    // totals from today.json; present only after the reporting backend ships.
    if (today.rpt && drill.level === 'district') {
      $('today-cards').innerHTML +=
        bigcard('bc-teal', 'Children present', today.rpt.children,
          'reported by ' + today.rpt.awcs + ' of ' + awcCount + ' AWCs') +
        bigcard('bc-maroon', 'Pregnant women', today.rpt.pregnant,
          'other beneficiaries ' + today.rpt.others) +
        bigcard('bc-olive', 'Meals prepared', today.rpt.meals, 'as reported by centres') +
        bigcard('bc-blue', 'Eggs in stock', today.rpt.eggs || 0,
          'rice ' + (today.rpt.riceKg || 0) + ' kg · pulses ' + (today.rpt.pulsesKg || 0) + ' kg');
    }
    renderCharts(scopeRows);

    const crumb = [];
    if (me.role === 'ADMIN' || me.role === 'CDPO') {
      crumb.push(drill.level === 'district' ? 'District'
        : '<a data-lvl="district">District</a>');
    }
    if (drill.level !== 'district') {
      const pc = drill.level === 'project' ? drill.code
        : ((today.sectors.find(s => s.code === drill.code) || {}).project || '');
      if (drill.level === 'sector' && me.role !== 'SUPERVISOR') {
        crumb.push('<a data-lvl="project" data-code="' + esc(pc) + '">' + esc(projectName(pc)) + '</a>');
      } else if (drill.level === 'project') {
        crumb.push(esc(projectName(drill.code)));
      }
      if (drill.level === 'sector') crumb.push(esc(sectorName(drill.code)));
    }
    $('today-crumb').innerHTML = crumb.join(' › ');
    $('today-crumb').querySelectorAll('a').forEach(a => {
      a.onclick = () => {
        drill = { level: a.dataset.lvl, code: a.dataset.code || null };
        renderToday();
      };
    });

    const q = $('today-search').value.trim().toLowerCase();
    const stF = $('today-filter').value;

    let html;
    if (!q && drill.level === 'district') {
      html = '<table><tr><th>Project</th><th>Expected</th><th>Attendance</th><th>Marked IN</th><th>Late</th>' +
        '<th>Not marked</th><th>Outside</th><th>Unverified</th></tr>' +
        today.projects.map(p =>
          '<tr class="click" data-code="' + esc(p.code) + '"><td>' + esc(projectName(p.code)) + '</td><td>' +
          p.expected + '</td><td>' + ratePill(p.expected ? Math.round(100 * (p.in + p.late) / p.expected) : 0) +
          '</td><td>' + (p.in + p.late) + '</td><td>' + p.late + '</td><td>' +
          p.notMarked + '</td><td>' + p.outside + '</td><td>' + p.unverified + '</td></tr>').join('') +
        '</table>';
      // Admin/office test marks: visible with photos, never in the counts.
      const office = today.users.filter(e => e.x && inScopeUid(e.id));
      if (office.length) {
        html += '<h3>Office / test marks today (not counted)</h3>' +
          '<table><tr><th>Name</th><th>IN</th><th>OUT</th><th>Geofence</th><th>Flags</th><th>Photo</th></tr>' +
          office.map(e =>
            '<tr><td>' + esc(userName(e.id)) + '</td><td>' + esc(e.in || '–') + '</td><td>' +
            esc(e.out || '–') + '</td><td>' + gfTag(e.gf) + '</td><td class="flags">' + esc(e.fl || '') +
            '</td><td>' + (e.ph ? '<button class="btn btn-plain btn-inline" data-ph="' +
              esc(e.ph) + '">view</button>' : '') + '</td></tr>').join('') + '</table>';
      }
      $('today-table').innerHTML = html;
      bindPhotoButtons($('today-table'));
      $('today-table').querySelectorAll('tr.click').forEach(tr => {
        tr.onclick = () => { drill = { level: 'project', code: tr.dataset.code }; renderToday(); };
      });
      return;
    }
    if (!q && drill.level === 'project') {
      const secs = today.sectors.filter(s => s.project === drill.code);
      html = '<table><tr><th>Sector</th><th>Expected</th><th>Attendance</th><th>Marked IN</th><th>Late</th>' +
        '<th>Not marked</th><th>Outside</th><th>Unverified</th></tr>' +
        secs.map(s =>
          '<tr class="click" data-code="' + esc(s.code) + '"><td>' + esc(sectorName(s.code)) + '</td><td>' +
          s.expected + '</td><td>' + ratePill(s.expected ? Math.round(100 * (s.in + s.late) / s.expected) : 0) +
          '</td><td>' + (s.in + s.late) + '</td><td>' + s.late + '</td><td>' +
          s.notMarked + '</td><td>' + s.outside + '</td><td>' + s.unverified + '</td></tr>').join('') +
        '</table>';
      $('today-table').innerHTML = html;
      $('today-table').querySelectorAll('tr.click').forEach(tr => {
        tr.onclick = () => { drill = { level: 'sector', code: tr.dataset.code }; renderToday(); };
      });
      return;
    }

    // user-level rows: one sector, or a name/AWC search across the whole scope
    let rows = today.users.filter(e => inScopeUid(e.id));
    if (!q) rows = rows.filter(e => e.s === drill.code);
    if (q) rows = rows.filter(e =>
      userName(e.id).toLowerCase().includes(q) || awcName(e.a).toLowerCase().includes(q));
    if (stF) rows = rows.filter(e => e.st === stF || e.gf === stF);
    rows.sort((a, b) => userName(a.id) < userName(b.id) ? -1 : 1);

    html = '<table><tr><th>Name</th><th>Cadre</th><th>AWC</th><th>Status</th><th>IN</th>' +
      '<th>OUT</th><th>Geofence</th><th>Flags</th><th>Photo</th></tr>' +
      rows.map(e => {
        const u = names.users[e.id] || {};
        return '<tr><td>' + esc(userName(e.id)) + '</td><td>' + esc(u.c || '') + '</td><td>' +
          esc(awcName(e.a)) + '</td><td>' + statusTag(e.st) + '</td><td>' + esc(e.in || '–') +
          '</td><td>' + esc(e.out || '–') + '</td><td>' + gfTag(e.gf) + '</td>' +
          '<td class="flags">' + esc(e.fl || '') + '</td><td>' +
          (e.ph ? '<button class="btn btn-plain btn-inline" data-ph="' + esc(e.ph) + '">view</button>' : '') +
          '</td></tr>';
      }).join('') + '</table>';
    $('today-table').innerHTML = rows.length ? html : '<p class="info">No matching users.</p>';
    bindPhotoButtons($('today-table'));
  }

  function todayCsv() {
    const rows = [['User ID', 'Name', 'Cadre', 'Sector', 'AWC', 'Status', 'IN', 'OUT', 'Geofence', 'Flags']];
    today.users.filter(e => inScopeUid(e.id)).forEach(e => {
      const u = names.users[e.id] || {};
      rows.push([e.id, userName(e.id), u.c || '', sectorName(e.s), awcName(e.a),
        e.st, e.in || '', e.out || '', e.gf || '', e.fl || '']);
    });
    downloadCsv('attendance-today-' + (today.date || '') + '.csv', rows);
  }

  // ---------------- Exceptions ----------------
  let lastExc = []; // last rendered flagged list, so the tab click can mark it seen

  const rptKey = r => ((today && today.date) || '') + '_' + r.u + '_' + r.at;
  function rptSeenMap() {
    try { return JSON.parse(localStorage.getItem('rptSeen') || '{}'); } catch (e) { return {}; }
  }
  function markRptsSeen() {
    const seen = rptSeenMap();
    const pref = (today && today.date) || '';
    Object.keys(seen).forEach(k => { if (pref && k.indexOf(pref) !== 0) delete seen[k]; }); // prune old days
    ((today && today.rpts) || []).forEach(r => { seen[rptKey(r)] = 1; });
    localStorage.setItem('rptSeen', JSON.stringify(seen));
    $('rpts-count').hidden = true;
  }

  function excSeenMap() {
    try { return JSON.parse(localStorage.getItem('excSeen') || '{}'); } catch (e) { return {}; }
  }

  /** Badge counts only UNSEEN flagged marks; opening the tab clears it. */
  function markExcSeen() {
    const seen = excSeenMap();
    lastExc.forEach(e => { seen[e.key] = Date.now(); });
    const cut = Date.now() - 30 * 86400000; // keep the map bounded
    Object.keys(seen).forEach(k => { if (seen[k] < cut) delete seen[k]; });
    localStorage.setItem('excSeen', JSON.stringify(seen));
    $('exc-count').hidden = true;
  }

  // Plain-language remark for each flagged mark; raw codes stay in the tooltip.
  const FLAG_TEXT = {
    NO_PHOTO: 'no photo captured',
    NO_GPS: 'no GPS captured',
    LATE_SYNC: 'synced more than a day late',
    CLOCK_SKEW: 'phone clock wrong by 5+ minutes',
    PERFECT_ACCURACY: 'GPS accuracy suspiciously perfect',
    AT_CENTER_EXACT: 'exactly on the stored centre point',
    REPEAT_COORDS: 'same coordinates as the previous mark',
    REPEAT_COORDS_5D: 'identical coordinates 5 days in a row',
    IMPOSSIBLE_VELOCITY: 'impossible travel speed between marks',
    FAKE_GPS_SUSPECT: 'possible fake-GPS app',
    OFFLINE_SYNC: 'marked offline, sent later'
  };

  function excRemark(e) {
    const parts = [];
    if (e.gf === 'OUTSIDE') parts.push('marked outside the centre geofence');
    else if (e.gf === 'UNVERIFIED') parts.push('location could not be verified');
    else if (e.gf === 'STATIC_COORDS') parts.push('coordinates never change');
    String(e.fl || '').split(',').forEach(f => {
      f = f.trim();
      if (f) parts.push(FLAG_TEXT[f] || f.toLowerCase().replace(/_/g, ' '));
    });
    if (!parts.length) return '—';
    const s = parts.join('; ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function renderExceptions() {
    const merged = [];
    const seen = {};
    ((today && today.exceptions) || []).concat(nightlyExc).forEach(e => {
      if (!inScopeUid(e.u) || seen[e.key]) return;
      seen[e.key] = 1;
      merged.push(e);
    });
    lastExc = merged;

    const seenMap = excSeenMap();
    const unseen = merged.filter(e => !seenMap[e.key]).length;
    // Viewing the tab right now? Then everything on screen counts as seen.
    if (unseen && !$('view-exceptions').hidden) markExcSeen();
    else {
      $('exc-count').hidden = !unseen;
      $('exc-count').textContent = unseen;
    }

    // Pending-leave badge from the published summary — an application must
    // never sit invisible until someone happens to open the Leaves tab.
    const pl = (today && today.pendingLeaves) || 0;
    $('leaves-count').hidden = !pl;
    $('leaves-count').textContent = pl;

    // New-reports badge: reports that arrived since this browser last opened
    // the Daily Reports tab (same seen-map pattern as Flagged).
    const rSeen = rptSeenMap();
    const rUnseen = ((today && today.rpts) || []).filter(r => !rSeen[rptKey(r)]).length;
    if (rUnseen && !$('view-rpts').hidden) markRptsSeen();
    else {
      $('rpts-count').hidden = !rUnseen;
      $('rpts-count').textContent = rUnseen;
    }

    if (!merged.length) {
      $('exc-list').innerHTML = '<p class="info">Nothing to review. All marks inside geofence, no flags.</p>';
      return;
    }
    $('exc-list').innerHTML = '<table><tr><th>Name</th><th>Sector</th><th>Date</th><th>Type</th>' +
      '<th>Time</th><th>Geofence</th><th>Remark</th><th>Photo</th></tr>' +
      merged.map(e =>
        '<tr><td>' + esc(userName(e.u)) + '</td><td>' + esc(sectorName(e.s)) + '</td><td>' +
        esc(e.d || (today && today.date) || '') + '</td><td>' + esc(e.t) + '</td><td>' + esc(e.at || '–') +
        '</td><td>' + gfTag(e.gf) + '</td><td class="remark" title="' + esc(e.fl || '') + '">' +
        esc(excRemark(e)) + '</td><td>' +
        (e.ph ? '<button class="btn btn-plain btn-inline" data-ph="' + esc(e.ph) + '">view</button>' : '') +
        '</td></tr>').join('') + '</table>';

    bindPhotoButtons($('exc-list'));
  }

  // ---------------- Daily Reports (AWC diary: children / pregnant / others / meals) ----------------
  function rptRowsFiltered() {
    const q = ($('rpts-search').value || '').trim().toLowerCase();
    return ((today && today.rpts) || []).filter(r => {
      if (!inScopeUid(r.u)) return false;
      if (!q) return true;
      return (awcName(r.a) + ' ' + sectorName(r.s) + ' ' + userName(r.u)).toLowerCase().indexOf(q) >= 0;
    });
  }

  function renderRpts() {
    const wrap = $('rpts-table'), info = $('rpts-summary');
    const agg = today && today.rpt;
    const awcTotal = Object.keys(names.awcs || {}).length;
    if (!agg) {
      info.textContent = '';
      wrap.innerHTML = '<p class="info">No report data published yet. AWC daily reports appear here ' +
        'within ~5 minutes of centres submitting them from the app (backend v2.3+).</p>';
      return;
    }
    const stk = agg.stock;
    info.innerHTML = '<b>' + agg.awcs + '</b> of ' + awcTotal + ' AWCs reported today &middot; ' +
      'children <b>' + agg.children + '</b> &middot; pregnant women <b>' + agg.pregnant + '</b> &middot; ' +
      'other beneficiaries <b>' + agg.others + '</b> &middot; meals <b>' + agg.meals + '</b>' +
      (stk
        ? ' &middot; closing stock: eggs <b>' + stk.eggs.cb + '</b>, rice <b>' + stk.rice.cb +
          ' kg</b>, pulses <b>' + stk.pulses.cb + ' kg</b>, Balamrutham <b>' + stk.bal.cb +
          ' ml</b>, Balamrutham+ <b>' + stk.balp.cb + ' ml</b>, milk <b>' + stk.milk.cb + ' L</b>'
        : ' &middot; stock: eggs <b>' + (agg.eggs || 0) + '</b>, rice <b>' + (agg.riceKg || 0) +
          ' kg</b>, pulses <b>' + (agg.pulsesKg || 0) + ' kg</b>');

    const rows = rptRowsFiltered();
    if (!rows.length) {
      wrap.innerHTML = '<p class="info">' + (agg.awcs ? 'No reports match the search.'
        : 'No centre has submitted today\'s report yet.') + '</p>';
      return;
    }
    const phBtn = (id, label) => id
      ? '<button class="btn btn-plain btn-inline" data-ph="' + esc(id) + '">' + label + '</button> ' : '';
    // stock cells show the CLOSING balance; hover reveals open/used/received
    const stCell = v => '<td title="opening ' + v[0] + ' · used ' + v[1] +
      ' · received ' + v[2] + '"><b>' + v[3] + '</b></td>';
    const stCells = r => r.st
      ? r.st.map(stCell).join('')
      : '<td>' + (r.eg || 0) + '</td><td>' + (r.rk || 0) + '</td><td>' + (r.pk || 0) +
        '</td><td>–</td><td>–</td><td>–</td>';
    wrap.innerHTML = '<table><tr><th>Sector</th><th>AWC</th><th>Reported by</th><th>Time</th>' +
      '<th>Children</th><th>Pregnant</th><th>Others</th><th>Meals</th>' +
      '<th>Eggs</th><th>Rice kg</th><th>Pulses kg</th><th>Balam. ml</th><th>Balam+ ml</th><th>Milk L</th>' +
      '<th>Flags</th><th>Photos</th></tr>' +
      rows.map(r =>
        '<tr><td>' + esc(sectorName(r.s)) + '</td><td>' + esc(awcName(r.a)) + '</td><td>' +
        esc(userName(r.u)) + '</td><td>' + esc(r.at || '–') + '</td><td><b>' + r.c + '</b></td><td>' +
        r.p + '</td><td>' + r.o + '</td><td><b>' + r.m + '</b></td>' + stCells(r) +
        '<td class="flags">' + esc(r.f || '') + '</td><td>' +
        phBtn(r.ph1, 'children') + phBtn(r.ph3, 'pregnant') +
        phBtn(r.ph4, 'others') + phBtn(r.ph2, 'meal') +
        '</td></tr>').join('') + '</table>';
    bindPhotoButtons(wrap);
  }

  function rptsCsv() {
    const SKEYS = ['eggs', 'rice', 'pulses', 'balamrutham', 'balamrutham_plus', 'milk'];
    const head = ['sector', 'awc', 'reported_by', 'time', 'children', 'pregnant', 'others', 'meals'];
    SKEYS.forEach(k => head.push(k + '_open', k + '_used', k + '_received', k + '_closing'));
    head.push('flags');
    const rows = [head];
    rptRowsFiltered().forEach(r => {
      const base = [sectorName(r.s), awcName(r.a), userName(r.u), r.at || '', r.c, r.p, r.o, r.m];
      const st = r.st || SKEYS.map(() => ['', '', '', '']);
      st.forEach(v => base.push(v[0], v[1], v[2], v[3]));
      base.push(r.f || '');
      rows.push(base);
    });
    downloadCsv('daily-reports-' + ((today && today.date) || '') + '.csv', rows);
  }

  function rptsMissingCsv() {
    const reported = {};
    ((today && today.rpts) || []).forEach(r => { reported[r.a] = 1; });
    const rows = [['awc_id', 'awc_name', 'sector']];
    Object.keys(names.awcs || {}).forEach(id => {
      if (!reported[id]) rows.push([id, awcName(id), sectorName(names.awcs[id].sc)]);
    });
    downloadCsv('awcs-not-reported-' + ((today && today.date) || '') + '.csv', rows);
  }

  function bindPhotoButtons(root) {
    root.querySelectorAll('button[data-ph]').forEach(b => {
      b.onclick = async () => {
        b.disabled = true;
        try {
          const res = await Api.photo(b.dataset.ph, token);
          if (res.ok) {
            $('lightbox-img').src = 'data:' + (res.mime || 'image/jpeg') + ';base64,' + res.b64;
            $('lightbox').hidden = false;
          } else alert('Photo unavailable: ' + res.code);
        } catch (e) { alert('Photo fetch failed.'); }
        b.disabled = false;
      };
    });
  }

  // ---------------- Monthly ----------------
  function fillMonthControls() {
    const sel = $('month-sector');
    sel.innerHTML = (names.sectors || []).map(s =>
      '<option value="' + esc(s.code) + '">' + esc(s.name) + ' (' + esc(s.code) + ')</option>').join('');
    $('month-ym').value = new Date().toISOString().slice(0, 7);
  }

  async function loadMonth() {
    const sc = $('month-sector').value;
    const ym = $('month-ym').value;
    if (!sc || !ym) return;
    const cur = (meta && meta.month) || new Date().toISOString().slice(0, 7);
    const path = ym === cur ? 'summary/month/' + sc + '.json' : 'summary/archive/' + ym + '/' + sc + '.json';
    monthData = await Api.fetchJson(path);
    if (!monthData) {
      $('month-table').innerHTML = '<p class="info">No data published for ' + esc(sectorName(sc)) +
        ' in ' + esc(ym) + '. Current-month files appear after the first nightly run.</p>';
      return;
    }
    const dim = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
    // Holidays from the summary (server list incl. Sundays); Sundays computed
    // locally as a fallback for files published before the holiday feature.
    const hols = {};
    for (let d = 1; d <= dim; d++) {
      const dd = String(d).padStart(2, '0');
      const h = (monthData.holidays && monthData.holidays[dd]) ||
        (new Date(ym + '-' + dd + 'T12:00:00').getDay() === 0 ? 'Sunday' : '');
      if (h) hols[dd] = h;
    }
    const uids = Object.keys(monthData.users).sort((a, b) => userName(a) < userName(b) ? -1 : 1);
    let html = '<table class="mgrid"><tr><th class="name-col">Name</th>';
    for (let d = 1; d <= dim; d++) {
      const dd = String(d).padStart(2, '0');
      html += hols[dd] ? '<th class="hol" title="' + esc(hols[dd]) + '">' + d + '</th>' : '<th>' + d + '</th>';
    }
    html += '</tr>';
    for (const uid of uids) {
      html += '<tr><td class="name-col">' + esc(userName(uid)) + '</td>';
      for (let d = 1; d <= dim; d++) {
        const dd = String(d).padStart(2, '0');
        const cell = monthData.users[uid][dd];
        if (!cell || (!cell.IN && !cell.OUT)) {
          const lv = monthData.leaves && monthData.leaves[uid] && monthData.leaves[uid][dd];
          html += lv ? '<td class="d-leave" title="' + esc(lv) + ' leave">L</td>'
            : hols[dd] ? '<td class="d-hol" title="' + esc(hols[dd]) + '"></td>' : '<td></td>';
          continue;
        }
        const inC = cell.IN, outC = cell.OUT;
        const rej = (inC && inC.x === 'REJ') || (outC && outC.x === 'REJ');
        const bad = (inC && inC.gf === 'OUTSIDE') || (outC && outC.gf === 'OUTSIDE');
        const cor = (inC && inC.x) || (outC && outC.x);
        const cls = rej ? 'd-err' : bad ? 'd-warn' : 'd-ok';
        html += '<td class="' + cls + (cor ? ' d-cor' : '') + '" title="' +
          esc('IN ' + (inC ? inC.t || 'manual' : '–') + '  OUT ' + (outC ? outC.t || 'manual' : '–') +
            (cor ? '  [' + cor + ']' : '')) + '">' +
          (inC ? (inC.t || 'M').slice(0, 5) : '–') + '<br>' + (outC ? (outC.t || 'M').slice(0, 5) : '–') + '</td>';
      }
      html += '</tr>';
    }
    html += '</table><p class="info">Cell: IN time over OUT time. Green = inside fence, orange = outside, ' +
      'red = rejected, blue L = approved leave. Grey columns = Sundays and holidays ' +
      '(hover for the occasion) — attendance not expected.</p>';
    $('month-table').innerHTML = html;
  }

  function monthCsv() {
    if (!monthData) { alert('Load a month first.'); return; }
    const ym = monthData.ym;
    const dim = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
    const head = ['User ID', 'Name'];
    for (let d = 1; d <= dim; d++) head.push(ym + '-' + String(d).padStart(2, '0') + ' IN', ym + '-' + String(d).padStart(2, '0') + ' OUT');
    const rows = [head];
    Object.keys(monthData.users).forEach(uid => {
      const r = [uid, userName(uid)];
      for (let d = 1; d <= dim; d++) {
        const cell = monthData.users[uid][String(d).padStart(2, '0')] || {};
        r.push(cell.IN ? (cell.IN.t || 'MANUAL') + (cell.IN.x ? ' [' + cell.IN.x + ']' : '') : '');
        r.push(cell.OUT ? (cell.OUT.t || 'MANUAL') + (cell.OUT.x ? ' [' + cell.OUT.x + ']' : '') : '');
      }
      rows.push(r);
    });
    downloadCsv('attendance-' + monthData.sector + '-' + ym + '.csv', rows);
  }

  // ---------------- Leaves ----------------
  async function renderLeaves() {
    const res = await Api.post({ action: 'leaveList', token: token });
    if (!res.ok) {
      if (['AUTH', 'EXPIRED', 'REVOKED'].indexOf(res.code) >= 0) { authLost(); return; }
      $('leaves-table').innerHTML = '<p class="info">Could not load leaves (' + esc(res.code) + ').</p>';
      return;
    }
    const rows = (res.leaves || []).slice()
      .sort((a, b) => (a.status === 'PENDING' ? 0 : 1) - (b.status === 'PENDING' ? 0 : 1));
    // Live badge refresh: the summary-based count can lag decisions by ~5 min.
    const pending = rows.filter(l => l.status === 'PENDING').length;
    $('leaves-count').hidden = !pending;
    $('leaves-count').textContent = pending;
    if (!rows.length) {
      $('leaves-table').innerHTML = '<p class="info">No leave applications yet. Workers apply from the app menu.</p>';
      return;
    }
    // Only Collector / District Admin decide; PENDING rows get both buttons.
    const canDecide = me.role === 'ADMIN';
    const actionsFor = (l, i) => {
      if (!canDecide) return '—';
      const btn = (dec, label) =>
        '<button class="btn btn-plain btn-inline" data-dec="' + dec + '" data-i="' + i + '">' + label + '</button>';
      if (l.status === 'PENDING') return btn('APPROVED', 'Approve') + ' ' + btn('REJECTED', 'Reject');
      if (l.status === 'APPROVED') return btn('REJECTED', 'Reject');
      return btn('APPROVED', 'Approve');
    };
    const dayCount = l => Math.round((new Date(l.to) - new Date(l.from)) / 86400000) + 1;
    $('leaves-table').innerHTML = '<table><tr><th>Name</th><th>From</th><th>To</th><th>Days</th>' +
      '<th>Type</th><th>Reason</th><th>Status</th><th>Applied</th><th>Action</th></tr>' +
      rows.map((l, i) =>
        '<tr><td>' + esc(userName(l.u)) + '</td><td>' + esc(l.from) + '</td><td>' + esc(l.to) +
        '</td><td>' + dayCount(l) + '</td><td>' + esc(l.type) + '</td><td>' + esc(l.reason || '') +
        '</td><td><span class="tag ' + (l.status === 'APPROVED' ? 'OK' : l.status === 'REJECTED' ? 'ERR' : 'WARN') +
        '">' + esc(l.status) + '</span></td><td>' + esc(String(l.at).slice(0, 10)) + '</td><td>' +
        actionsFor(l, i) + '</td></tr>').join('') + '</table>';
    $('leaves-table').querySelectorAll('button[data-dec]').forEach(b => {
      b.onclick = async () => {
        const l = rows[Number(b.dataset.i)];
        if (!confirm((b.dataset.dec === 'REJECTED' ? 'Reject' : 'Approve') + ' leave of ' +
          userName(l.u) + ' (' + l.from + ' → ' + l.to + ')?')) return;
        const r = await Api.post({ action: 'leaveDecide', token: token, leaveId: l.id, decision: b.dataset.dec });
        if (r.ok) renderLeaves(); else alert('Failed: ' + r.code);
      };
    });
  }

  // ---------------- Reports ----------------
  function fillReportControls() {
    $('report-ym').value = new Date().toISOString().slice(0, 7);
    const secs = (names.sectors || []);
    const all = (me.role === 'ADMIN' || me.role === 'CDPO')
      ? '<option value="ALL">Whole ' + (me.role === 'ADMIN' ? 'district' : 'project') + '</option>' : '';
    $('report-scope').innerHTML = all + secs.map(s =>
      '<option value="' + esc(s.code) + '">' + esc(s.name) + ' (' + esc(s.code) + ')</option>').join('');
  }

  function lateAfterFor(uid) {
    const u = names.users[uid] || {};
    const scheds = (orgData && orgData.schedules) || [];
    let best = null, bestScore = -1;
    for (const r of scheds) {
      const pOK = r.project_code === u.pj, pAll = r.project_code === 'ALL';
      const cOK = r.cadre === u.c, cAll = r.cadre === 'ALL';
      if (!(pOK || pAll) || !(cOK || cAll)) continue;
      const score = (pOK ? 2 : 0) + (cOK ? 1 : 0);
      if (score > bestScore) { best = r; bestScore = score; }
    }
    return (best && best.late_after) || '09:30';
  }

  async function buildReport() {
    const ym = $('report-ym').value;
    const scope = $('report-scope').value;
    if (!ym || !scope) return;
    $('report-table').innerHTML = '<p class="info">Building…</p>';
    const cur = (meta && meta.month) || new Date().toISOString().slice(0, 7);
    const path = sc => ym === cur ? 'summary/month/' + sc + '.json' : 'summary/archive/' + ym + '/' + sc + '.json';
    const secList = scope === 'ALL' ? (names.sectors || []).map(s => s.code) : [scope];
    const files = await Promise.all(secList.map(sc => Api.fetchJson(path(sc))));

    const dim = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
    const anyFile = files.find(Boolean);
    if (!anyFile) {
      $('report-table').innerHTML = '<p class="info">No published data for ' + esc(ym) +
        ' yet. Month files appear after the first nightly run.</p>';
      reportRows = null;
      return;
    }
    const hols = {};
    for (let d = 1; d <= dim; d++) {
      const dd = String(d).padStart(2, '0');
      if ((anyFile.holidays && anyFile.holidays[dd]) ||
        new Date(ym + '-' + dd + 'T12:00:00').getDay() === 0) hols[dd] = 1;
    }
    const daysSoFar = ym === cur ? Math.min(dim, new Date().getDate()) : dim;
    let workingDays = 0;
    for (let d = 1; d <= daysSoFar; d++) {
      if (!hols[String(d).padStart(2, '0')]) workingDays++;
    }

    const perUser = [];
    const perSector = {};
    files.forEach((f, i) => {
      if (!f) return;
      const sc = secList[i];
      const stats = perSector[sc] = { staff: 0, present: 0, late: 0, outside: 0, leave: 0 };
      const uids = new Set(Object.keys(f.users || {}).concat(Object.keys(f.leaves || {})));
      uids.forEach(uid => {
        if (!names.users[uid]) return;
        const lateAt = lateAfterFor(uid);
        let present = 0, late = 0, outside = 0;
        const days = (f.users || {})[uid] || {};
        Object.keys(days).forEach(dd => {
          const c = days[dd];
          if (!c.IN || c.IN.x === 'REJ') return;
          present++;
          if (c.IN.t && c.IN.t > lateAt) late++;
          if (c.IN.gf === 'OUTSIDE') outside++;
        });
        const leave = Object.keys((f.leaves || {})[uid] || {}).length;
        const absent = Math.max(0, workingDays - present - leave);
        stats.staff++; stats.present += present; stats.late += late;
        stats.outside += outside; stats.leave += leave;
        perUser.push([userName(uid), (names.users[uid] || {}).c || '', sectorName(sc),
          present, late, outside, leave, absent,
          workingDays ? Math.round(100 * present / workingDays) + '%' : '–']);
      });
    });

    if (scope === 'ALL') {
      reportHead = ['Sector', 'Staff', 'Working days', 'Present-days', 'Avg %', 'Late', 'Outside', 'Leave days'];
      reportRows = secList.filter(sc => perSector[sc] && perSector[sc].staff).map(sc => {
        const s = perSector[sc];
        return [sectorName(sc), s.staff, workingDays, s.present,
          Math.round(100 * s.present / (s.staff * workingDays || 1)) + '%', s.late, s.outside, s.leave];
      });
    } else {
      reportHead = ['Name', 'Cadre', 'Sector', 'Present days', 'Late', 'Outside', 'Leave days', 'Absent', 'Attendance %'];
      reportRows = perUser.sort((a, b) => a[0] < b[0] ? -1 : 1);
    }
    $('report-table').innerHTML = '<p class="info">' + esc(ym) + ' — ' + workingDays +
      ' working days counted' + (ym === cur ? ' so far (month in progress)' : '') +
      '. Absent = working days − present − leave.</p>' +
      '<table><tr>' + reportHead.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr>' +
      reportRows.map(r => '<tr>' + r.map(c => '<td>' + esc(c) + '</td>').join('') + '</tr>').join('') +
      '</table>';
  }

  function reportCsv() {
    if (!reportRows) { alert('Build a report first.'); return; }
    downloadCsv('attendance-report-' + $('report-ym').value + '-' + $('report-scope').value + '.csv',
      [reportHead].concat(reportRows));
  }

  // ---------------- Analytics ----------------
  const anCache = {}; // ym|scope -> sector files

  function fillAnalyticsControls() {
    $('an-ym').value = new Date().toISOString().slice(0, 7);
    const secs = names.sectors || [];
    const all = (me.role === 'ADMIN' || me.role === 'CDPO')
      ? '<option value="ALL">Whole ' + (me.role === 'ADMIN' ? 'district' : 'project') + '</option>' : '';
    $('an-scope').innerHTML = all + secs.map(s =>
      '<option value="' + esc(s.code) + '">' + esc(s.name) + '</option>').join('');
  }

  async function runAnalytics() {
    const ym = $('an-ym').value, scope = $('an-scope').value;
    if (!ym || !scope) return;
    const status = $('an-status');
    const cur = (meta && meta.month) || new Date().toISOString().slice(0, 7);
    const path = sc => ym === cur ? 'summary/month/' + sc + '.json' : 'summary/archive/' + ym + '/' + sc + '.json';
    const secList = scope === 'ALL' ? (names.sectors || []).map(s => s.code) : [scope];
    status.textContent = 'Loading ' + secList.length + ' sector file(s)…';
    const key = ym + '|' + scope;
    if (!anCache[key]) {
      const files = await Promise.all(secList.map(sc => Api.fetchJson(path(sc))));
      anCache[key] = {};
      files.forEach((f, i) => { if (f) anCache[key][secList[i]] = f; });
      setTimeout(() => { delete anCache[key]; }, 120000); // keep it fresh-ish
    }
    status.textContent = '';
    renderAnalytics(ym, scope, secList, anCache[key]);
  }

  /**
   * Attendance % per month over the last 6 months for the chosen scope
   * (like the district's "Attendance Timeline" BI sample). Months with no
   * published data are skipped silently.
   */
  async function loadTimeline() {
    const endYm = $('an-ym').value, scope = $('an-scope').value;
    if (!endYm || !scope) return;
    const status = $('an-status');
    status.textContent = 'Building timeline…';
    const secList = scope === 'ALL' ? (names.sectors || []).map(s => s.code) : [scope];
    const cur = (meta && meta.month) || new Date().toISOString().slice(0, 7);
    const months = [];
    let y = Number(endYm.slice(0, 4)), m = Number(endYm.slice(5, 7));
    for (let i = 0; i < 6; i++) {
      months.unshift(y + '-' + String(m).padStart(2, '0'));
      m--; if (m === 0) { m = 12; y--; }
    }
    const staff = Object.keys(names.users).filter(uid =>
      names.users[uid].r === 'FIELD' && secList.indexOf(names.users[uid].sc) >= 0).length || 1;
    const points = [];
    for (const mm of months) {
      const path = sc => mm === cur ? 'summary/month/' + sc + '.json' : 'summary/archive/' + mm + '/' + sc + '.json';
      const files = await Promise.all(secList.map(sc => Api.fetchJson(path(sc))));
      const got = files.filter(Boolean);
      if (!got.length) { points.push(null); continue; }
      const dim = new Date(Number(mm.slice(0, 4)), Number(mm.slice(5, 7)), 0).getDate();
      const anyF = got[0];
      let work = 0;
      const lastDay = mm === cur ? Math.min(dim, new Date().getDate()) : dim;
      for (let d = 1; d <= lastDay; d++) {
        const dd = String(d).padStart(2, '0');
        const hol = (anyF.holidays && anyF.holidays[dd]) ||
          new Date(mm + '-' + dd + 'T12:00:00').getDay() === 0;
        if (!hol) work++;
      }
      let present = 0;
      got.forEach(f => Object.keys(f.users || {}).forEach(uid => {
        if (!names.users[uid] || names.users[uid].r !== 'FIELD') return;
        Object.keys(f.users[uid]).forEach(dd => {
          const c = f.users[uid][dd];
          if (c.IN && c.IN.x !== 'REJ') present++;
        });
      }));
      points.push(work ? Math.round(100 * present / (staff * work)) : null);
    }
    status.textContent = '';
    $('an-timeline').innerHTML = points.some(p => p != null)
      ? '<div class="chartbox"><h3>Attendance timeline — last 6 months (' +
        esc(scope === 'ALL' ? 'whole scope' : sectorName(scope)) + ')</h3>' +
        Charts.line(months, [{ name: 'Attendance %', color: Charts.PAL[1], area: true,
          values: points }], { pct: true }) + '</div>'
      : '<p class="info">No published months in this range yet — the timeline grows as months accumulate.</p>';
  }

  function renderAnalytics(ym, scope, secList, files) {
    const got = secList.filter(sc => files[sc]);
    if (!got.length) {
      $('an-content').innerHTML = '<p class="info">No published data for ' + esc(ym) +
        ' yet — month files appear after the first nightly run. Today\'s live picture is on the Dashboard tab.</p>';
      return;
    }
    const dim = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
    const anyF = files[got[0]];
    const hols = {};
    for (let d = 1; d <= dim; d++) {
      const dd = String(d).padStart(2, '0');
      if ((anyF.holidays && anyF.holidays[dd]) ||
        new Date(ym + '-' + dd + 'T12:00:00').getDay() === 0) {
        hols[dd] = (anyF.holidays && anyF.holidays[dd]) || 'Sunday';
      }
    }
    const cur = (meta && meta.month) || new Date().toISOString().slice(0, 7);
    const lastDay = ym === cur ? Math.min(dim, new Date().getDate()) : dim;
    let workDds = [];
    for (let d = 1; d <= lastDay; d++) {
      const dd = String(d).padStart(2, '0');
      if (!hols[dd]) workDds.push(dd);
    }
    const wk = $('an-week').value;
    if (wk) workDds = workDds.filter(dd => Math.ceil(Number(dd) / 7) === Number(wk));
    if (!workDds.length) {
      $('an-content').innerHTML = '<p class="info">No working days in that week of ' + esc(ym) + '.</p>';
      return;
    }

    // ---- assemble ----
    const staffOf = {};   // sc -> uid list (in scope)
    const perDay = {};    // dd -> {present, late, outside}
    const flagCount = {};
    const inBuckets = [0, 0, 0, 0, 0];
    let totOut = 0; // present days that also have a valid OUT mark
    const secStats = {};  // sc -> {staff, presentDays, late, outside, unverified, leave, series}
    const userStats = {}; // uid -> {present, late, absentSet, leave, sc, streak}
    workDds.forEach(dd => { perDay[dd] = { present: 0, late: 0, outside: 0 }; });

    got.forEach(sc => {
      const f = files[sc];
      const uids = Object.keys(names.users).filter(uid =>
        names.users[uid].sc === sc && names.users[uid].r === 'FIELD');
      staffOf[sc] = uids;
      const st = secStats[sc] = { staff: uids.length, presentDays: 0, late: 0, outside: 0,
        unverified: 0, leave: 0, series: workDds.map(() => 0) };
      uids.forEach(uid => {
        const days = (f.users || {})[uid] || {};
        const lvs = (f.leaves || {})[uid] || {};
        const lateAt = lateAfterFor(uid);
        const us = userStats[uid] = { present: 0, late: 0, leave: Object.keys(lvs).length,
          absent: 0, sc: sc, maxStreak: 0 };
        let streak = 0;
        workDds.forEach((dd, di) => {
          const c = days[dd];
          const inOk = c && c.IN && c.IN.x !== 'REJ';
          if (inOk) {
            us.present++; st.presentDays++; perDay[dd].present++; st.series[di]++;
            streak = 0;
            const t = c.IN.t || '';
            if (t && t > lateAt) { us.late++; st.late++; perDay[dd].late++; }
            if (c.IN.gf === 'OUTSIDE') { st.outside++; perDay[dd].outside++; }
            if (c.IN.gf === 'UNVERIFIED') st.unverified++;
            if (c.OUT && c.OUT.x !== 'REJ') totOut++;
            if (t) {
              const m = Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
              inBuckets[m < 540 ? 0 : m < 570 ? 1 : m < 600 ? 2 : m < 660 ? 3 : 4]++;
            }
            ['IN', 'OUT'].forEach(ty => {
              if (c[ty] && c[ty].fl) c[ty].fl.split(',').forEach(fl => {
                if (fl) flagCount[fl] = (flagCount[fl] || 0) + 1;
              });
            });
          } else if (lvs[dd]) {
            st.leave++; streak = 0;
          } else {
            us.absent++; streak++;
            if (streak > us.maxStreak) us.maxStreak = streak;
          }
        });
      });
    });

    const totStaff = got.reduce((s, sc) => s + secStats[sc].staff, 0);
    const totPresent = got.reduce((s, sc) => s + secStats[sc].presentDays, 0);
    const totLate = got.reduce((s, sc) => s + secStats[sc].late, 0);
    const totOutside = got.reduce((s, sc) => s + secStats[sc].outside, 0);
    const totUnv = got.reduce((s, sc) => s + secStats[sc].unverified, 0);
    const totLeave = got.reduce((s, sc) => s + secStats[sc].leave, 0);
    const possible = totStaff * workDds.length || 1;
    const attPct = Math.round(100 * totPresent / possible);
    const onTimePct = totPresent ? Math.round(100 * (totPresent - totLate) / totPresent) : 0;
    const verifPct = totPresent ? Math.round(100 * (totPresent - totOutside - totUnv) / totPresent) : 0;

    // ---- KPI strip ----
    let html = '<div class="bigcards">' +
      bigcard('bc-teal', 'Attendance', attPct + '%', totPresent + ' present-days of ' + possible) +
      bigcard('bc-blue', 'On time', onTimePct + '%', totLate + ' late marks') +
      bigcard('bc-olive', 'GPS verified', verifPct + '%', totOutside + ' outside · ' + totUnv + ' unverified') +
      bigcard('bc-maroon', 'Leave days', totLeave, 'approved this month') +
      bigcard('bc-grey', 'Working days', workDds.length, (ym === cur ? 'so far · ' : '') +
        Object.keys(hols).length + ' holidays/Sundays') +
      '</div>';

    // ---- chart grid: daily trend + composition + quality + patterns ----
    const labels = workDds.map(dd => Number(dd) + '');
    const wd = [[], [], [], [], [], []]; // Mon..Sat
    workDds.forEach(dd => {
      const day = new Date(ym + '-' + dd + 'T12:00:00').getDay();
      if (day >= 1 && day <= 6) wd[day - 1].push(100 * perDay[dd].present / (totStaff || 1));
    });
    const wdNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const totAbsent = Math.max(0, possible - totPresent - totLeave);
    html += '<div class="charts">' +
      '<div class="chartbox span2"><h3>Daily attendance — ' + esc(ym) + '</h3>' +
      Charts.line(labels, [
        { name: 'Present', color: Charts.PAL[0], area: true, values: workDds.map(dd => perDay[dd].present) },
        { name: 'Late (of present)', color: Charts.PAL[3], values: workDds.map(dd => perDay[dd].late) },
        { name: 'Outside fence', color: Charts.PAL[4], values: workDds.map(dd => perDay[dd].outside) }
      ]) + '</div>' +
      '<div class="chartbox"><h3>Month composition (person-days)</h3>' +
      Charts.donut([
        { label: 'Present', value: totPresent, color: '#0ca38a' },
        { label: 'On leave', value: totLeave, color: '#2aa7d8' },
        { label: 'Absent', value: totAbsent, color: '#d13438' }
      ], { center: attPct + '%' }) + '</div>' +
      '<div class="chartbox"><h3>GPS verification (IN marks)</h3>' +
      Charts.donut([
        { label: 'Inside fence', value: Math.max(0, totPresent - totOutside - totUnv), color: '#0ca38a' },
        { label: 'Outside fence', value: totOutside, color: '#e4572e' },
        { label: 'Unverified', value: totUnv, color: '#e8a020' }
      ], { center: verifPct + '%' }) + '</div>' +
      '<div class="chartbox"><h3>Day closure (OUT marked)</h3>' +
      Charts.donut([
        { label: 'IN + OUT', value: totOut, color: '#4f5ce5' },
        { label: 'IN only', value: Math.max(0, totPresent - totOut), color: '#e8a020' }
      ], { center: (totPresent ? Math.round(100 * totOut / totPresent) : 0) + '%' }) + '</div>' +
      '<div class="chartbox"><h3>Attendance rate by day (%)</h3>' +
      Charts.line(labels, [
        { name: '% of staff present', color: Charts.PAL[1], area: true,
          values: workDds.map(dd => Math.round(100 * perDay[dd].present / (totStaff || 1))) }
      ], { pct: true }) + '</div>' +
      '<div class="chartbox"><h3>Attendance by weekday</h3>' +
      Charts.bar(wdNames.map((n, i) => ({
        label: n, color: Charts.PAL[1],
        value: wd[i].length ? Math.round(wd[i].reduce((a, b) => a + b, 0) / wd[i].length) : 0
      })), { pct: true }) + '</div>' +
      '<div class="chartbox"><h3>Punctuality (all IN marks)</h3>' +
      Charts.donut([
        { label: 'Before 9:00', value: inBuckets[0] }, { label: '9:00–9:30', value: inBuckets[1] },
        { label: '9:30–10:00', value: inBuckets[2] }, { label: '10:00–11:00', value: inBuckets[3] },
        { label: 'After 11:00', value: inBuckets[4] }
      ]) + '</div>' +
      '<div class="chartbox"><h3>Data-quality flags</h3>' +
      (Object.keys(flagCount).length
        ? Charts.bar(Object.keys(flagCount).sort((a, b) => flagCount[b] - flagCount[a]).slice(0, 6)
            .map((fl, i) => ({ label: fl.slice(0, 12), title: fl + ': ' + flagCount[fl],
              value: flagCount[fl], color: Charts.PAL[(i + 2) % 8] })))
        : '<p class="info">No flags this month — clean data.</p>') + '</div></div>';

    // ---- sector league (ALL) or coverage heatmap rows ----
    if (scope === 'ALL') {
      const rows = got.map(sc => {
        const s = secStats[sc];
        const poss = s.staff * workDds.length || 1;
        return { sc: sc, name: sectorName(sc), staff: s.staff,
          pct: Math.round(100 * s.presentDays / poss),
          late: s.late, outside: s.outside, leave: s.leave, series: s.series };
      }).sort((a, b) => b.pct - a.pct);
      // Rate pill + trend arrow: second half of the period vs the first.
      const trendArrow = series => {
        const half = Math.floor(series.length / 2);
        if (half < 1) return '<span class="trend-flat">=</span>';
        const a = series.slice(0, half).reduce((x, y) => x + y, 0) / half;
        const rest = series.slice(half);
        const b = rest.reduce((x, y) => x + y, 0) / rest.length;
        return b > a * 1.05 ? '<span class="trend-up">▲</span>'
          : b < a * 0.95 ? '<span class="trend-down">▼</span>'
          : '<span class="trend-flat">=</span>';
      };
      const pill = ratePill;
      html += '<div class="chartbox"><h3>Sector league table</h3><div class="tablewrap"><table>' +
        '<tr><th>#</th><th>Sector</th><th>Staff</th><th>Attendance</th><th>Trend</th><th>Late</th>' +
        '<th>Outside</th><th>Leave</th><th>Daily</th></tr>' +
        rows.map((r, i) =>
          '<tr><td>' + (i + 1) + '</td><td>' + esc(r.name) + '</td><td>' + r.staff + '</td>' +
          '<td>' + pill(r.pct) + '</td><td>' + trendArrow(r.series) + '</td>' +
          '<td>' + r.late + '</td><td>' + r.outside + '</td><td>' + r.leave +
          '</td><td>' + Charts.spark(r.series) + '</td></tr>').join('') + '</table></div></div>';

      html += '<div class="chartbox"><h3>Coverage heatmap — sector × day (greener = fuller attendance)</h3>' +
        Charts.heatmap(rows.map(r => ({
          label: r.name,
          cells: workDds.map((dd, di) => ({
            v: r.staff ? secStats[r.sc].series[di] / r.staff : null,
            title: r.name + ' ' + ym + '-' + dd + ': ' + secStats[r.sc].series[di] + '/' + r.staff
          }))
        })), workDds.map(dd => Number(dd) + '')) + '</div>';
    } else {
      const sc = scope;
      html += '<div class="chartbox"><h3>Worker × day heatmap — ' + esc(sectorName(sc)) + '</h3>' +
        Charts.heatmap((staffOf[sc] || []).slice(0, 60).map(uid => {
          const f = files[sc];
          const days = (f.users || {})[uid] || {};
          const lvs = (f.leaves || {})[uid] || {};
          return { label: userName(uid),
            cells: workDds.map(dd => {
              const c = days[dd];
              const inOk = c && c.IN && c.IN.x !== 'REJ';
              return { v: inOk ? 1 : lvs[dd] ? -1 : 0,
                title: userName(uid) + ' ' + ym + '-' + dd + ': ' +
                  (inOk ? 'present ' + (c.IN.t || '') : lvs[dd] ? lvs[dd] + ' leave' : 'absent') };
            }) };
        }), workDds.map(dd => Number(dd) + '')) + '</div>';
    }

    // ---- attention list (decision-making) ----
    const worst = Object.keys(userStats)
      .map(uid => Object.assign({ uid: uid }, userStats[uid]))
      .filter(u => u.absent > 0)
      .sort((a, b) => b.absent - a.absent || b.maxStreak - a.maxStreak).slice(0, 15);
    html += '<div class="chartbox"><h3>Needs attention — most absences</h3>' +
      (worst.length ? '<div class="tablewrap"><table><tr><th>Name</th><th>Sector</th><th>Absent days</th>' +
        '<th>Longest streak</th><th>Present</th><th>Late</th><th>Leave</th></tr>' +
        worst.map(u =>
          '<tr><td>' + esc(userName(u.uid)) + '</td><td>' + esc(sectorName(u.sc)) + '</td>' +
          '<td><b style="color:#d13438">' + u.absent + '</b></td><td>' + u.maxStreak +
          '</td><td>' + u.present + '</td><td>' + u.late + '</td><td>' + u.leave + '</td></tr>').join('') +
        '</table></div>' : '<p class="info">Nobody with unexplained absences. Excellent.</p>') + '</div>';

    // ---- auto insights ----
    const insights = [];
    if (scope === 'ALL' && got.length > 1) {
      const league = got.map(sc => ({ sc: sc,
        pct: Math.round(100 * secStats[sc].presentDays / (secStats[sc].staff * workDds.length || 1)) }))
        .sort((a, b) => b.pct - a.pct);
      insights.push('Best sector: <b>' + esc(sectorName(league[0].sc)) + '</b> (' + league[0].pct +
        '%); weakest: <b>' + esc(sectorName(league[league.length - 1].sc)) + '</b> (' +
        league[league.length - 1].pct + '%).');
    }
    let worstDay = null;
    workDds.forEach(dd => {
      const pct = 100 * perDay[dd].present / (totStaff || 1);
      if (!worstDay || pct < worstDay.pct) worstDay = { dd: dd, pct: Math.round(pct) };
    });
    if (worstDay) insights.push('Lowest-attendance day: <b>' + esc(ym + '-' + worstDay.dd) +
      '</b> (' + worstDay.pct + '%).');
    if (totLate) insights.push('<b>' + totLate + '</b> late marks; ' + (inBuckets[4] || 0) +
      ' IN marks after 11:00.');
    if (flagCount.FAKE_GPS_SUSPECT) insights.push('<b style="color:#d13438">' +
      flagCount.FAKE_GPS_SUSPECT + ' fake-GPS-suspect marks</b> — check the Flagged tab.');
    const streaky = worst.filter(u => u.maxStreak >= 3).length;
    if (streaky) insights.push('<b>' + streaky + '</b> worker(s) with 3+ consecutive unexplained absences.');
    html = '<div class="chartbox insights"><h3>Key insights — ' + esc(ym) + '</h3><ul>' +
      insights.map(i => '<li>' + i + '</li>').join('') + '</ul></div>' + html;

    $('an-content').innerHTML = html;
  }

  // ---------------- Admin ----------------
  function renderAdmin() {
    if (!names) return;
    const q = $('admin-search').value.trim().toLowerCase();
    const lf = $('admin-filter').value; // '' | 'REG' | 'NOT'
    const matches = Object.keys(names.users).filter(uid => {
      const u = names.users[uid];
      if (lf === 'REG' && !u.pn) return false;
      if (lf === 'NOT' && u.pn) return false;
      if (!q) return true;
      return u.n.toLowerCase().includes(q) || String(u.p).includes(q) ||
        awcName(u.a).toLowerCase().includes(q) || uid.toLowerCase() === q;
    }).sort((a, b) => names.users[a].n < names.users[b].n ? -1 : 1);
    const uids = matches.slice(0, 200);

    // Accurate totals over the FULL user list — the table itself renders at
    // most 200 rows, so counting tags in it under-reports.
    const all = Object.keys(names.users);
    const reg = all.filter(uid => names.users[uid].pn).length;
    $('admin-stats').textContent = all.length + ' users total · ' + reg +
      ' registered & logged · ' + (all.length - reg) + ' not registered' +
      (matches.length > uids.length
        ? ' — showing first ' + uids.length + ' of ' + matches.length + ' matches (search to narrow)'
        : ' — ' + matches.length + ' match' + (matches.length === 1 ? '' : 'es') + ' shown');

    const isAdmin = me.role === 'ADMIN';
    $('admin-table').innerHTML = '<table><tr><th>ID</th><th>Name</th><th>Cadre</th><th>Phone</th>' +
      '<th>AWC / Sector</th><th>Role</th><th>Status</th><th>Login Status</th><th>Actions</th></tr>' +
      uids.map(uid => {
        const u = names.users[uid];
        return '<tr><td>' + esc(uid) + '</td><td>' + esc(u.n) + '</td><td>' + esc(u.c) + '</td><td>' +
          esc(u.p || 'NO PHONE') + '</td><td>' + esc(u.a ? awcName(u.a) : sectorDisplay(u.sc)) + '</td><td>' +
          esc(u.r) + '</td><td>' + esc(u.s) + '</td><td>' +
          (u.pn ? '<span class="tag OK">REGISTERED &amp; LOGGED</span>'
                : '<span class="tag ERR">NOT REGISTERED</span>') + '</td><td>' +
          '<button class="btn btn-plain btn-inline" data-do="pinReset" data-uid="' + esc(uid) + '">Reset PIN</button> ' +
          '<button class="btn btn-plain btn-inline" data-do="deviceUnbind" data-uid="' + esc(uid) + '">Unbind phone</button>' +
          (isAdmin ? ' <button class="btn btn-plain btn-inline" data-do="toggle" data-uid="' + esc(uid) + '">' +
            (u.s === 'ACTIVE' ? 'Deactivate' : 'Activate') + '</button>' : '') +
          '</td></tr>';
      }).join('') + '</table>';

    $('admin-table').querySelectorAll('button[data-do]').forEach(b => {
      b.onclick = () => adminAction(b.dataset.do, b.dataset.uid);
    });
  }

  async function adminAction(what, uid) {
    const u = names.users[uid];
    if (what === 'pinReset') {
      if (!confirm('Reset PIN for ' + u.n + '? They set a new PIN at next login.')) return;
      const res = await Api.post({ action: 'pinReset', token: token, userId: uid });
      alert(res.ok ? 'PIN cleared. ' + u.n + ' sets a new one at next login.' : 'Failed: ' + res.code);
    } else if (what === 'deviceUnbind') {
      if (!confirm('Unbind ' + u.n + '\'s phone? Their next login binds the new phone.')) return;
      const res = await Api.post({ action: 'deviceUnbind', token: token, userId: uid });
      alert(res.ok ? 'Device unbound.' : 'Failed: ' + res.code);
    } else if (what === 'toggle') {
      const to = u.s === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
      if (!confirm((to === 'INACTIVE' ? 'Deactivate ' : 'Activate ') + u.n + '?')) return;
      const res = await Api.post({
        action: 'userUpsert', token: token,
        user: { user_id: uid, phone: u.p, name: u.n, cadre: u.c, role: u.r,
          project_code: u.pj, sector_code: u.sc, awc_id: u.a, status: to }
      });
      if (res.ok) { u.s = to; renderAdmin(); } else alert('Failed: ' + res.code);
    }
  }

  function fillAwcPicker() {
    const ids = Object.keys(names.awcs || {});
    // AWCs with no coordinates first — those are the ones to fix.
    ids.sort((a, b) => {
      const am = names.awcs[a].lat == null ? 0 : 1, bm = names.awcs[b].lat == null ? 0 : 1;
      return am !== bm ? am - bm : (names.awcs[a].n < names.awcs[b].n ? -1 : 1);
    });
    $('awc-pick').innerHTML = ids.map(id =>
      '<option value="' + esc(id) + '">' + esc(names.awcs[id].n) + ' (' + esc(id) + ')' +
      (names.awcs[id].lat == null ? ' — NO GPS SET' : '') + '</option>').join('');
  }

  function captureAwc() {
    const awcId = $('awc-pick').value;
    const msg = $('awc-msg');
    if (!awcId) return;
    if (!('geolocation' in navigator)) { msg.textContent = 'No GPS in this browser.'; return; }
    msg.textContent = 'Getting GPS fix…';
    navigator.geolocation.getCurrentPosition(async pos => {
      if (pos.coords.accuracy > 100) {
        msg.textContent = 'GPS accuracy ±' + Math.round(pos.coords.accuracy) +
          ' m is too poor (need ≤100 m). Move to open sky and retry.';
        return;
      }
      const res = await Api.post({
        action: 'setAwcCoords', token: token, awcId: awcId,
        lat: pos.coords.latitude, lng: pos.coords.longitude
      });
      if (res.ok) {
        msg.textContent = 'Saved: ' + pos.coords.latitude.toFixed(6) + ', ' + pos.coords.longitude.toFixed(6) +
          ' (±' + Math.round(pos.coords.accuracy) + ' m) for ' + awcName(awcId) + '.';
        if (names.awcs[awcId]) { names.awcs[awcId].lat = pos.coords.latitude; names.awcs[awcId].lng = pos.coords.longitude; }
        fillAwcPicker();
      } else msg.textContent = 'Failed: ' + res.code;
    }, () => { msg.textContent = 'Could not get GPS. Allow location access and retry.'; },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  }

  // ---------------- Performance / SLA (district admin only) ----------------
  /**
   * Live diagnostics run on demand: timed probes to both API deployments,
   * static-hosting latency + data freshness, field sync-delay percentiles
   * (today.json perf block), this browser's own API reliability counters
   * (recorded by api.js), and page-load timing. Nothing is stored server-side.
   */
  async function renderPerf() {
    const el = $('perf-content');
    el.innerHTML = '<p class="info">Running live checks (a few seconds)…</p>';
    $('perf-when').textContent = '';
    const pill = st => '<span class="tag ' + (st === 'OK' ? 'OK' : st === 'WARN' ? 'WARN' : 'ERR') +
      '">' + st + '</span>';
    const fmtS = v => v == null ? '—' : v < 90 ? v + ' s' : Math.round(v / 60) + ' min';

    // 1. Both API deployments: 3 timed probes each.
    const eps = (window.CONSOLE_CONFIG.ENDPOINTS ||
      [window.CONSOLE_CONFIG.ENDPOINT]).filter(Boolean);
    const epRows = [];
    for (let e = 0; e < eps.length; e++) {
      const times = [];
      let okc = 0;
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        try {
          const res = await fetch(eps[e], { method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: '{"action":"perf-probe"}' });
          const txt = await res.text();
          if (res.ok && txt.trim().charAt(0) === '{') {
            okc++; times.push(Math.round(performance.now() - t0));
          }
        } catch (err) { /* counted as failure */ }
      }
      times.sort((a, b) => a - b);
      epRows.push({ name: 'Server ' + (e + 1) + (e ? ' (backup)' : ' (primary)'),
        ok: okc, med: times.length ? times[Math.floor((times.length - 1) / 2)] : null,
        best: times.length ? times[0] : null });
    }

    // 2. Static hosting (GitHub Pages): timed meta.json + data freshness.
    let staticMs = null, freshMin = null;
    try {
      const t0 = performance.now();
      const meta2 = await Api.fetchJson('summary/meta.json');
      staticMs = Math.round(performance.now() - t0);
      if (meta2 && meta2.generatedAt) {
        freshMin = Math.round((Date.now() - new Date(meta2.generatedAt)) / 60000);
      }
    } catch (err) { /* shown as — */ }

    // 3. This browser's API reliability today (api.js counters).
    let sess = null;
    try {
      sess = JSON.parse(localStorage.getItem(
        'apiPerf_' + new Date().toISOString().slice(0, 10)) || 'null');
    } catch (err) { /* fine */ }

    // 4. Page load timing.
    const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    const dclMs = nav ? Math.round(nav.domContentLoadedEventEnd) : null;

    const pf = (today && today.perf) || null;
    const probesTotal = eps.length * 3;
    const probesOk = epRows.reduce((s, r) => s + r.ok, 0);
    const priMed = epRows.length ? epRows[0].med : null;

    // ---- SLA table ----
    const slas = [];
    slas.push(['API availability (live probes)', '100%',
      probesTotal ? Math.round(100 * probesOk / probesTotal) + '% (' + probesOk + '/' + probesTotal + ')' : '—',
      !probesTotal ? 'WARN' : probesOk === probesTotal ? 'OK' : probesOk >= probesTotal / 2 ? 'WARN' : 'BREACH',
      'every probe must return JSON, not an error page']);
    slas.push(['API response time (median)', '≤ 3.0 s',
      priMed == null ? '—' : (priMed / 1000).toFixed(1) + ' s',
      priMed == null ? 'WARN' : priMed <= 3000 ? 'OK' : priMed <= 6000 ? 'WARN' : 'BREACH',
      'Apps Script cold starts can add ~5 s to the first call']);
    slas.push(['Dashboard data freshness', '≤ 6 min',
      freshMin == null ? '—' : freshMin + ' min',
      freshMin == null ? 'WARN' : freshMin <= 6 ? 'OK' : freshMin <= 15 ? 'WARN' : 'BREACH',
      'summary regenerates every 5 min during working hours']);
    slas.push(['Static site response', '≤ 1.5 s',
      staticMs == null ? '—' : (staticMs / 1000).toFixed(2) + ' s',
      staticMs == null ? 'WARN' : staticMs <= 1500 ? 'OK' : staticMs <= 4000 ? 'WARN' : 'BREACH',
      'GitHub Pages CDN serving the dashboard data']);
    const pfOn = pf && (pf.on || (pf.sdP95 != null ? { n: pf.marks, med: pf.sdMed, p95: pf.sdP95 } : null));
    slas.push(['Mark sync delay — online marks (p95)', '≤ 5 min',
      pfOn && pfOn.n ? fmtS(pfOn.p95) : '—',
      !pfOn || !pfOn.n ? 'WARN' : pfOn.p95 <= 300 ? 'OK' : pfOn.p95 <= 900 ? 'WARN' : 'BREACH',
      'marks made WITH network; offline-queued marks are excluded (they wait by design)']);
    slas.push(['Console API success (this browser, today)', '≥ 99%',
      sess && sess.a ? Math.round(100 * sess.ok / sess.a) + '% of ' + sess.a + ' attempts' : 'no data yet',
      !sess || !sess.a ? 'WARN' : sess.ok / sess.a >= 0.99 ? 'OK' : sess.ok / sess.a >= 0.95 ? 'WARN' : 'BREACH',
      'includes retried attempts; failover masks most failures']);
    slas.push(['Console page load (DOM ready)', '≤ 3.0 s',
      dclMs == null ? '—' : (dclMs / 1000).toFixed(1) + ' s',
      dclMs == null ? 'WARN' : dclMs <= 3000 ? 'OK' : dclMs <= 6000 ? 'WARN' : 'BREACH',
      'this page, this device, this network']);

    let html = '<div class="chartbox"><h3>Service levels — checked live just now</h3>' +
      '<div class="tablewrap"><table><tr><th>Metric</th><th>Target</th><th>Now</th>' +
      '<th>Status</th><th>Notes</th></tr>' +
      slas.map(s => '<tr><td>' + s[0] + '</td><td>' + s[1] + '</td><td>' + esc(s[2]) +
        '</td><td>' + pill(s[3]) + '</td><td class="info">' + s[4] + '</td></tr>').join('') +
      '</table></div></div>';

    html += '<div class="charts">' +
      '<div class="chartbox"><h3>API deployments</h3>' +
      (epRows.length ? '<div class="tablewrap"><table><tr><th>Deployment</th><th>Probes OK</th>' +
        '<th>Median</th><th>Best</th></tr>' +
        epRows.map(r => '<tr><td>' + r.name + '</td><td>' + r.ok + '/3</td><td>' +
          (r.med == null ? '—' : r.med + ' ms') + '</td><td>' +
          (r.best == null ? '—' : r.best + ' ms') + '</td></tr>').join('') + '</table></div>' +
        '<p class="info">Clients try both automatically — one healthy deployment keeps everyone working.</p>'
        : '<p class="info">No endpoints configured (demo mode).</p>') + '</div>' +
      '<div class="chartbox"><h3>Field sync today</h3>' +
      (pf && pf.on ? '<div class="tablewrap"><table>' +
        '<tr><th></th><th>Online marks</th><th>Offline (queued)</th></tr>' +
        '<tr><td>Count</td><td><b>' + pf.on.n + '</b></td><td><b>' + pf.off.n + '</b></td></tr>' +
        '<tr><td>Median capture→server</td><td><b>' + fmtS(pf.on.med) + '</b></td><td><b>' +
        fmtS(pf.off.med) + '</b></td></tr>' +
        '<tr><td>95th percentile</td><td><b>' + fmtS(pf.on.p95) + '</b></td><td><b>' +
        fmtS(pf.off.p95) + '</b></td></tr>' +
        '<tr><td>Late syncs (&gt;24 h)</td><td colspan="2"><b>' + pf.lateSync + '</b></td></tr></table></div>' +
        '<p class="info">Offline marks waiting for network is the offline-first design working — ' +
        'only the online column is a service-level signal.</p>'
        : pf ? '<p class="info">Sync split appears after the next summary regeneration (~5 min).</p>'
        : '<p class="info">No sync stats in today\'s summary yet (regenerates every 5 min).</p>') + '</div>' +
      '<div class="chartbox"><h3>This browser session</h3>' +
      (sess && sess.a ? '<div class="tablewrap"><table>' +
        '<tr><td>API attempts today</td><td><b>' + sess.a + '</b></td></tr>' +
        '<tr><td>Succeeded</td><td><b>' + sess.ok + '</b></td></tr>' +
        '<tr><td>Failed attempts</td><td><b>' + sess.f + '</b></td></tr>' +
        '<tr><td>Saved by retry/failover</td><td><b>' + sess.rt + '</b></td></tr>' +
        '<tr><td>Average latency</td><td><b>' +
        (sess.ok ? Math.round(sess.ms / sess.ok) + ' ms' : '—') + '</b></td></tr></table></div>'
        : '<p class="info">Counters build up as this browser uses the console.</p>') + '</div></div>';

    el.innerHTML = html;
    $('perf-when').textContent = 'Checked at ' + new Date().toLocaleTimeString() +
      ' — use Re-run checks to measure again.';
  }

  // ---------------- tabs & events ----------------
  function switchTab(name) {
    ['today', 'analytics', 'exceptions', 'rpts', 'monthly', 'reports', 'leaves', 'admin', 'perf'].forEach(t => {
      $('tab-' + t).classList.toggle('sel', t === name);
      $('view-' + t).hidden = t !== name;
    });
    if (name === 'admin') renderAdmin();
    if (name === 'leaves') renderLeaves();
    if (name === 'perf') renderPerf();
    if (name === 'analytics' && $('an-content').querySelector('p')) runAnalytics();
  }

  function bind() {
    $('btn-login').onclick = doLogin;
    ['in-phone', 'in-pin', 'in-newpin2'].forEach(id => {
      $(id).addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
    });
    $('btn-logout').onclick = doLogout;
    $('btn-refresh').onclick = refreshAll;
    $('btn-today-csv').onclick = todayCsv;
    $('today-search').oninput = renderToday;
    $('today-filter').onchange = renderToday;
    $('tab-today').onclick = () => switchTab('today');
    $('tab-analytics').onclick = () => switchTab('analytics');
    $('btn-an-load').onclick = runAnalytics;
    $('an-week').onchange = runAnalytics;
    $('btn-an-timeline').onclick = loadTimeline;
    $('btn-theme').onclick = () => {
      const dark = document.body.classList.toggle('dark');
      localStorage.setItem('consoleTheme', dark ? 'dark' : 'light');
      $('btn-theme').textContent = dark ? '☀️' : '🌙';
    };
    if (document.body.classList.contains('dark')) $('btn-theme').textContent = '☀️';
    $('tab-exceptions').onclick = () => { switchTab('exceptions'); markExcSeen(); };
    $('tab-rpts').onclick = () => { switchTab('rpts'); markRptsSeen(); };
    $('rpts-search').oninput = renderRpts;
    $('btn-rpts-csv').onclick = rptsCsv;
    $('btn-rpts-missing-csv').onclick = rptsMissingCsv;
    $('tab-monthly').onclick = () => switchTab('monthly');
    $('tab-reports').onclick = () => switchTab('reports');
    $('tab-leaves').onclick = () => switchTab('leaves');
    $('tab-admin').onclick = () => switchTab('admin');
    $('tab-perf').onclick = () => switchTab('perf');
    $('btn-perf-run').onclick = () => renderPerf();
    $('btn-month-load').onclick = loadMonth;
    $('btn-month-csv').onclick = monthCsv;
    $('btn-report-load').onclick = buildReport;
    $('btn-report-csv').onclick = reportCsv;
    $('admin-search').oninput = renderAdmin;
    $('admin-filter').onchange = renderAdmin;
    $('btn-awc-capture').onclick = captureAwc;
    $('lightbox-close').onclick = () => { $('lightbox').hidden = true; };
    $('lightbox').onclick = e => { if (e.target === $('lightbox')) $('lightbox').hidden = true; };
  }

  async function init() {
    if (localStorage.getItem('consoleTheme') === 'dark') document.body.classList.add('dark');
    bind();
    if (token && me) {
      try { await boot(); return; } catch (e) { /* fall through to login */ }
    }
    doLogoutUiOnly();
  }

  function doLogoutUiOnly() {
    $('main').hidden = true;
    $('screen-login').hidden = false;
  }

  document.addEventListener('DOMContentLoaded', init);
  return {};
})();
