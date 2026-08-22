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
    fillRegisterControls();
    fillRptControls();
    initNewUserForm();
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
    // Daily reports render on first open of their tab — the archive is up to
    // six month files and nobody should pay for it just by logging in.
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

  function bigcard(cls, k, v, sub) {
    return '<div class="bigcard ' + cls + '"><div class="k">' + esc(k) + '</div>' +
      '<div class="v">' + esc(v) + '</div>' + (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + '</div>';
  }

  /**
   * Arrival/departure time bands are an ORDERED scale, not a set of identities:
   * "before 9:00" and "after 11:00" are the two ends of one axis. A donut in
   * five unrelated hues said they were five separate things and hid the shape.
   * Columns on a single-hue ramp show the distribution at a glance.
   */
  function bandsChart(buckets, emptyMsg) {
    if (!buckets.some(b => b.value > 0)) return Charts.empty(emptyMsg);
    return Charts.bar(buckets.map((b, i) => ({
      label: b.label, value: b.value,
      title: (b.full || b.label) + ': ' + b.value,
      color: Charts.ORD[Math.min(i, Charts.ORD.length - 1)]
    })));
  }

  function trendSVG(inTimes, opts) {
    opts = opts || {};
    const word = opts.word || 'IN';
    const col = opts.color || Charts.PAL[0];
    if (!inTimes.length) return '<p class="info">No ' + word + ' marks yet today.</p>';
    const mins = inTimes.map(t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))).sort((a, b) => a - b);
    const start = (opts.startH || 6) * 60, end = (opts.endH || 18) * 60, W = 340, H = 130, PB = 22, PL = 30;
    const x = m => PL + Math.min(1, Math.max(0, (m - start) / (end - start))) * (W - PL - 8);
    const y = c => (H - PB) - (c / mins.length) * (H - PB - 12);
    // A cumulative curve needs a run to be a curve. With one or two marks the
    // line would sweep up from the window's start hour, implying arrivals that
    // never happened — so start the path at the first actual mark.
    let path = 'M' + x(mins[0]).toFixed(1) + ',' + (H - PB);
    mins.forEach((m, i) => { path += ' L' + x(m).toFixed(1) + ',' + y(i + 1).toFixed(1); });
    const area = path + ' L' + x(mins[mins.length - 1]).toFixed(1) + ',' + (H - PB) + ' Z';
    const cumLabel = mins.length + ' marked ' + word;
    let labels = '';
    for (let h = start / 60; h <= end / 60; h += 3) {
      const tx = x(h * 60);
      // The last tick would otherwise be clipped by the viewBox edge.
      const anchor = tx > W - 24 ? 'end' : (tx < PL + 12 ? 'start' : 'middle');
      labels += '<text class="c-tick" x="' + tx.toFixed(0) + '" y="' + (H - 6) +
        '" text-anchor="' + anchor + '">' + h + ':00</text>';
    }
    // Single-hue wash under the curve, fading to nothing at the baseline —
    // decoration that cannot imply a value the data does not hold.
    const gid = 'tg' + (trendSeq++);
    const lastX = x(mins[mins.length - 1]), lastY = y(mins.length);
    return '<svg class="c-line" viewBox="0 0 ' + W + ' ' + H + '" role="img">' +
      '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" style="stop-color:' + col + ';stop-opacity:.34"/>' +
        '<stop offset="100%" style="stop-color:' + col + ';stop-opacity:0"/></linearGradient></defs>' +
      '<line class="c-grid" x1="' + PL + '" y1="' + (H - PB) + '" x2="' + (W - 6) +
        '" y2="' + (H - PB) + '"/>' +
      '<path d="' + area + '" fill="url(#' + gid + ')"/>' +
      '<path d="' + path + '" fill="none" style="stroke:' + col +
        '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<circle class="c-enddot" cx="' + lastX.toFixed(1) + '" cy="' + lastY.toFixed(1) +
        '" r="4.5" style="fill:' + col + '"/>' +
      '<text class="c-endlab" x="' + Math.min(W - 8, lastX + 10).toFixed(1) + '" y="' +
        // Above the dot normally; below it when the curve has run to the top,
        // where the label would otherwise sit outside the viewBox.
        (lastY - 10 < 14 ? lastY + 16 : lastY - 10).toFixed(1) +
        '" text-anchor="' + (lastX > W - 90 ? 'end' : 'start') + '">' +
        esc(cumLabel) + '</text>' +
      labels + '</svg>';
  }
  let trendSeq = 0;

  function renderCharts(rows) {
    const inTimes = rows.map(e => e.in).filter(Boolean);
    // Short axis labels, full range in the tooltip: five long labels across one
    // card overlap each other into an unreadable smear.
    const buckets = [
      { label: '<9:00', full: 'Before 9:00', value: 0 },
      { label: '9–9:30', full: '9:00–9:30', value: 0 },
      { label: '9:30–10', full: '9:30–10:00', value: 0 },
      { label: '10–11', full: '10:00–11:00', value: 0 },
      { label: '>11:00', full: 'After 11:00', value: 0 }
    ];
    inTimes.forEach(t => {
      const m = Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
      buckets[m < 540 ? 0 : m < 570 ? 1 : m < 600 ? 2 : m < 660 ? 3 : 4].value++;
    });
    $('chart-intime').innerHTML = bandsChart(buckets, 'No IN marks yet today.');
    $('chart-trend').innerHTML = trendSVG(inTimes);

    // OUT mirrors of the two charts above; buckets follow the OUT window
    // (out_start 15:30 · out_end 17:30 in the default schedule).
    const outTimes = rows.map(e => e.out).filter(Boolean);
    const outBuckets = [
      { label: '<15:30', full: 'Before 15:30', value: 0 },
      { label: '15:30–16:30', full: '15:30–16:30', value: 0 },
      { label: '16:30–17:30', full: '16:30–17:30', value: 0 },
      { label: '>17:30', full: 'After 17:30', value: 0 }
    ];
    outTimes.forEach(t => {
      const m = Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
      outBuckets[m < 930 ? 0 : m < 990 ? 1 : m < 1050 ? 2 : 3].value++;
    });
    $('chart-outtime').innerHTML = bandsChart(outBuckets, 'No OUT marks yet today.');
    $('chart-outtrend').innerHTML = trendSVG(outTimes,
      { word: 'OUT', startH: 12, endH: 21, color: Charts.PAL[1] });

    // Sector Top-10 (horizontal — sector names stay readable) and project
    // bars, per the district's BI sample. The '?' bucket (users with no
    // sector — a master-data error) never charts.
    const secBars = today.sectors.filter(s => s.code && s.code !== '?').map(s => ({
      label: sectorName(s.code),
      title: sectorName(s.code) + ': ' + (s.in + s.late) + '/' + s.expected + ' marked',
      value: s.expected ? Math.round(100 * (s.in + s.late) / s.expected) : 0
    })).sort((a, b) => b.value - a.value).slice(0, 10);
    // One series, one colour. Giving each bar its own hue would encode length
    // twice and spend the only free channel saying nothing new.
    $('chart-sector').innerHTML = secBars.some(b => b.value > 0)
      ? Charts.hbar(secBars, { pct: true, color: Charts.PAL[0] })
      : Charts.empty('No sector has marks yet today.');

    const projBars = today.projects.filter(p => p.code && p.code !== '?').map(p => ({
      label: projectName(p.code),
      title: projectName(p.code) + ': ' + (p.in + p.late) + ' of ' + p.expected + ' marked IN',
      value: p.in + p.late
    }));
    $('chart-project').innerHTML = projBars.some(b => b.value > 0)
      ? Charts.hbar(projBars, { color: Charts.PAL[1] })
      : Charts.empty('No marks yet today.');

    // Geofence verification and status donuts fill the remaining grid cells.
    const gf = { INSIDE: 0, OUTSIDE: 0, UNVERIFIED: 0 };
    rows.forEach(e => { if (e.gf && gf[e.gf] != null) gf[e.gf]++; });
    $('chart-verify').innerHTML = Charts.donut([
      { label: 'Inside fence', value: gf.INSIDE, color: Charts.STATUS.ok },
      { label: 'Outside fence', value: gf.OUTSIDE, color: Charts.STATUS.warn },
      { label: 'GPS unverified', value: gf.UNVERIFIED, color: Charts.STATUS.idle }
    ], { centerLabel: 'marked', emptyMsg: 'No marks yet today.' });

    const st = { PRESENT: 0, LATE: 0, ON_LEAVE: 0, NOT_MARKED: 0 };
    rows.forEach(e => { if (!e.x && st[e.st] != null) st[e.st]++; });
    // Part-to-whole across the whole roll: one bar reads the split faster than
    // a ring, and the four shares stay comparable when three of them are small.
    $('chart-status').innerHTML = Charts.stack([
      { label: 'On time', value: st.PRESENT, color: Charts.STATUS.ok },
      { label: 'Late', value: st.LATE, color: Charts.STATUS.warn },
      { label: 'On leave', value: st.ON_LEAVE, color: Charts.STATUS.idle },
      { label: 'Not marked', value: st.NOT_MARKED, color: Charts.STATUS.bad }
    ], { center: st.PRESENT + st.LATE + st.ON_LEAVE + st.NOT_MARKED,
      centerLabel: 'on the rolls', emptyMsg: 'No staff in view.' });

    // ---- second-row fillers: reports, beneficiaries, stock, OUT, adoption,
    // bottom sectors — all from today.json, no extra requests.
    const rpt = today.rpt || {};
    const totalAwcs = names && names.awcs ? Object.keys(names.awcs).length : 0;
    // A two-slice ring is a stat tile in a costume — show the ratio itself.
    $('chart-rptprog').innerHTML = totalAwcs
      ? Charts.meter(rpt.awcs || 0, totalAwcs, { color: Charts.STATUS.ok, unit: 'centres',
          foot: Math.max(0, totalAwcs - (rpt.awcs || 0)) + ' centres still to report today' })
      : Charts.empty('No AWC list loaded.');

    $('chart-benef').innerHTML = (rpt.awcs || 0)
      ? Charts.bar([
          { label: 'Children', value: rpt.children || 0 },
          { label: 'Pregnant', value: rpt.pregnant || 0 },
          { label: 'Others', value: rpt.others || 0 },
          { label: 'Meals', value: rpt.meals || 0 }
        ], { color: Charts.PAL[0] })
      : Charts.empty('No reports yet today.');

    const stk = rpt.stock || {};
    const stkDef = [['eggs', 'Eggs', ''], ['rice', 'Rice', ' kg'], ['pulses', 'Pulses', ' kg'],
      ['bal', 'Balamrutham', ' ml'], ['balp', 'Balamrutham+', ' ml'], ['milk', 'Milk', ' L']];
    $('chart-stockused').innerHTML = stkDef.some(d => stk[d[0]] && stk[d[0]].used)
      ? Charts.bar(stkDef.map(d => ({
          label: d[1].slice(0, 6), value: (stk[d[0]] && stk[d[0]].used) || 0,
          title: d[1] + ' used: ' + ((stk[d[0]] && stk[d[0]].used) || 0) + d[2]
        })), { color: Charts.PAL[1] })
      : Charts.empty('No stock usage reported yet.');

    const outDone = rows.filter(e => e.out).length;
    const stillIn = rows.filter(e => (e.st === 'PRESENT' || e.st === 'LATE') && !e.out).length;
    $('chart-outdone').innerHTML = (outDone + stillIn)
      ? Charts.meter(outDone, outDone + stillIn, { color: Charts.PAL[0], unit: 'staff',
          foot: stillIn + ' still to mark OUT' })
      : Charts.empty('Nobody has marked yet.');

    $('chart-adopt').innerHTML = (today.adopt && today.adopt.staff)
      ? Charts.stack([
          { label: 'Installed app', value: today.adopt.app || 0, color: Charts.STATUS.ok },
          { label: 'Chrome only', value: today.adopt.chrome || 0, color: Charts.STATUS.warn },
          { label: 'Never logged in',
            value: Math.max(0, today.adopt.staff - today.adopt.onboarded), color: Charts.STATUS.bad }
        ], { center: today.adopt.staff, centerLabel: 'staff', emptyMsg: 'No adoption data yet.' })
      : Charts.empty('No adoption data yet.');

    const lowBars = today.sectors.filter(s => s.code && s.code !== '?' && s.expected > 0).map(s => ({
      label: sectorName(s.code),
      title: sectorName(s.code) + ': ' + (s.in + s.late) + '/' + s.expected + ' marked',
      value: s.expected ? Math.round(100 * (s.in + s.late) / s.expected) : 0
    })).sort((a, b) => a.value - b.value).slice(0, 10);
    // Red is a status colour here and means it: these are the sectors to chase.
    $('chart-sector-low').innerHTML = lowBars.length
      ? Charts.hbar(lowBars, { pct: true, color: Charts.STATUS.bad })
      : Charts.empty('No sectors to show.');
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
    if (stF === 'NO_OUT') {
      rows = rows.filter(e => (e.st === 'PRESENT' || e.st === 'LATE') && !e.out);
    } else if (stF) {
      rows = rows.filter(e => e.st === stF || e.gf === stF);
    }
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
  // ---------------- Daily reports: today, plus six months of history --------
  // The archive files (summary/reports/<ym>.json) are district-wide static
  // JSON, so scope is enforced the same way every other summary file does it:
  // the viewer's name map only contains their own centres, and anything not in
  // it is dropped before a single number is counted.
  const RPT_ITEMS = [
    { k: 'eggs', n: 'Eggs', u: '' }, { k: 'rice', n: 'Rice', u: 'kg' },
    { k: 'pulses', n: 'Pulses', u: 'kg' }, { k: 'bal', n: 'Balamrutham', u: 'ml' },
    { k: 'balp', n: 'Balamrutham+', u: 'ml' }, { k: 'milk', n: 'Milk', u: 'L' }
  ];
  const rptArchive = {};   // ym -> parsed file (cached for the session)
  let rptDays = [];        // [{ ym, dd, iso }] oldest -> newest, across the range
  let rptLoadedFor = null; // the range currently in memory

  const r1 = v => Math.round(v * 10) / 10;
  const isoDay = (ym, dd) => ym + '-' + dd;
  const prettyDay = iso => iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4);

  function rptMonthsBack(n) {
    const out = [];
    const now = new Date();
    for (let i = 0; i < n; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      out.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
    }
    return out.reverse();   // oldest first, so the slider runs left to right
  }

  async function loadRpts() {
    const months = Number($('rpts-range').value) || 1;
    const want = rptMonthsBack(months);
    const key = want.join(',');
    if (rptLoadedFor === key) { renderRpts(); return; }
    $('rpts-loading').textContent = 'Loading ' + months + ' month' + (months > 1 ? 's' : '') + '…';
    const missing = want.filter(ym => !rptArchive[ym]);
    const got = await Promise.all(missing.map(ym => Api.fetchJson('summary/reports/' + ym + '.json')));
    missing.forEach((ym, i) => {
      // A month with no archive yet is cached as empty so we do not re-fetch a
      // 404 on every redraw; the nightly job fills it in.
      rptArchive[ym] = got[i] || { ym: ym, days: {}, awcs: {}, missing: true };
    });
    rptDays = [];
    want.forEach(ym => {
      Object.keys(rptArchive[ym].days || {}).sort()
        .forEach(dd => rptDays.push({ ym: ym, dd: dd, iso: isoDay(ym, dd) }));
    });
    rptLoadedFor = key;
    $('rpts-loading').textContent = '';
    const slider = $('rpts-day');
    slider.max = String(Math.max(0, rptDays.length - 1));
    slider.value = String(Math.max(0, rptDays.length - 1));
    renderRpts();
  }

  /** The centres this viewer may see, optionally narrowed to one sector. */
  function rptScopeAwcs() {
    const sc = $('rpts-scope').value;
    return Object.keys(names.awcs || {}).filter(a => sc === 'ALL' || names.awcs[a].sc === sc);
  }

  /** Days currently selected: the whole range, or the one the slider points at. */
  function rptSelectedDays() {
    if ($('rpts-allday').checked || !rptDays.length) return rptDays;
    const i = Math.min(rptDays.length - 1, Math.max(0, Number($('rpts-day').value) || 0));
    return [rptDays[i]];
  }

  /**
   * Roll the selected days up per centre and per day. One pass produces both
   * tables, the cards and the charts, so they can never disagree.
   */
  function rptAggregate() {
    const inScope = {};
    rptScopeAwcs().forEach(a => { inScope[a] = 1; });
    const days = rptSelectedDays();
    const perAwc = {};    // aid -> { days, c, p, o, m, used{}, st{} }
    const perDay = [];    // [{ iso, awcs, c, p, o, m, used{} }]
    const blankUsed = () => { const u = {}; RPT_ITEMS.forEach(it => { u[it.k] = 0; }); return u; };
    const tot = { awcs: 0, days: days.length, c: 0, p: 0, o: 0, m: 0, used: blankUsed() };

    days.forEach(d => {
      const file = rptArchive[d.ym];
      const dayRow = { iso: d.iso, awcs: 0, c: 0, p: 0, o: 0, m: 0, used: blankUsed() };
      Object.keys(file.awcs || {}).forEach(aid => {
        if (!inScope[aid]) return;
        const row = file.awcs[aid].d[d.dd];
        if (!row) return;
        const a = perAwc[aid] || (perAwc[aid] = { days: 0, c: 0, p: 0, o: 0, m: 0,
          used: blankUsed(), st: null });
        a.days++;
        a.c += row[0]; a.p += row[1]; a.o += row[2]; a.m += row[3];
        dayRow.awcs++; dayRow.c += row[0]; dayRow.p += row[1]; dayRow.o += row[2]; dayRow.m += row[3];
        RPT_ITEMS.forEach((it, i) => {
          const v = row[4 + i] || 0;
          a.used[it.k] = r1(a.used[it.k] + v);
          dayRow.used[it.k] = r1(dayRow.used[it.k] + v);
        });
      });
      tot.c += dayRow.c; tot.p += dayRow.p; tot.o += dayRow.o; tot.m += dayRow.m;
      RPT_ITEMS.forEach(it => { tot.used[it.k] = r1(tot.used[it.k] + dayRow.used[it.k]); });
      perDay.push(dayRow);
    });
    tot.awcs = Object.keys(perAwc).length;

    // Stock balances are month-level in the archive: opening from the first
    // month in view, closing from the last. Summing openings across months
    // would count the same sack of rice six times.
    const months = [...new Set(days.map(d => d.ym))].sort();
    const stock = {};
    RPT_ITEMS.forEach(it => { stock[it.k] = { ob: 0, used: 0, recd: 0, cb: 0 }; });
    if (months.length) {
      const first = rptArchive[months[0]], last = rptArchive[months[months.length - 1]];
      Object.keys(first.awcs || {}).forEach(aid => {
        if (!inScope[aid]) return;
        RPT_ITEMS.forEach(it => {
          const v = (first.awcs[aid].st || {})[it.k];
          if (v) stock[it.k].ob = r1(stock[it.k].ob + v[0]);
        });
      });
      Object.keys(last.awcs || {}).forEach(aid => {
        if (!inScope[aid]) return;
        RPT_ITEMS.forEach(it => {
          const v = (last.awcs[aid].st || {})[it.k];
          if (v) stock[it.k].cb = r1(stock[it.k].cb + v[3]);
        });
      });
      months.forEach(ym => {
        Object.keys(rptArchive[ym].awcs || {}).forEach(aid => {
          if (!inScope[aid]) return;
          RPT_ITEMS.forEach(it => {
            const v = (rptArchive[ym].awcs[aid].st || {})[it.k];
            if (!v) return;
            stock[it.k].used = r1(stock[it.k].used + v[1]);
            stock[it.k].recd = r1(stock[it.k].recd + v[2]);
          });
        });
      });
    }
    return { tot: tot, perAwc: perAwc, perDay: perDay, stock: stock, days: days };
  }

  function renderRpts() {
    if (!rptLoadedFor) { loadRpts(); return; }
    const A = rptAggregate();
    const single = !$('rpts-allday').checked && rptDays.length;
    const label = !rptDays.length ? 'no reported days yet'
      : single ? prettyDay(A.days[0].iso)
        : prettyDay(rptDays[0].iso) + ' – ' + prettyDay(rptDays[rptDays.length - 1].iso);
    $('rpts-rangelabel').textContent = label;
    $('rpts-daylabel').textContent = rptDays.length
      ? prettyDay(rptDays[Math.min(rptDays.length - 1, Number($('rpts-day').value) || 0)].iso) : '—';

    const totalAwcs = rptScopeAwcs().length;
    const missing = Object.keys(rptArchive).filter(ym => rptArchive[ym].missing);
    $('rpts-summary').innerHTML = !rptDays.length
      ? 'No report archive published for this range yet. The nightly job builds it; ' +
        'run <b>buildReportHistory</b> once in the Apps Script editor to backfill older months.'
      : '<b>' + A.tot.awcs + '</b> of ' + totalAwcs + ' centres reported over <b>' +
        A.tot.days + '</b> reported day' + (A.tot.days === 1 ? '' : 's') + ' (' + esc(label) + ')' +
        (missing.length ? ' &middot; no archive yet for ' + esc(missing.join(', ')) : '');

    // Same count row as the Dashboard: every headline number on the daily
    // report gets its own tile, beneficiaries and resources alike, so the tab
    // answers "how much of what" without anyone reading a table first.
    const covered = totalAwcs * A.tot.days;
    const filed = Object.keys(A.perAwc).reduce((s, a) => s + A.perAwc[a].days, 0);
    const when = single ? 'on this day' : 'across the range';
    const notFiled = Math.max(0, covered - filed);
    const CARD_COLS = ['bc-blue', 'bc-teal', 'bc-olive', 'bc-grey', 'bc-maroon', 'bc-blue'];
    $('rpts-cards').innerHTML =
      bigcard('bc-teal', 'Centre-days filed', filed,
        covered ? Math.round(100 * filed / covered) + '% of ' + covered + ' expected' : '') +
      bigcard('bc-red', 'Centre-days missed', notFiled,
        covered ? Math.round(100 * notFiled / covered) + '% of ' + covered + ' expected' : '') +
      bigcard('bc-blue', 'Children present', A.tot.c, when) +
      bigcard('bc-grey', 'Pregnant women', A.tot.p, when) +
      bigcard('bc-maroon', 'Other beneficiaries', A.tot.o, when) +
      bigcard('bc-olive', 'Meals prepared', A.tot.m, when) +
      RPT_ITEMS.map((it, i) => bigcard(CARD_COLS[i % CARD_COLS.length],
        it.n + ' used', (A.tot.used[it.k] || 0) + (it.u ? ' ' + it.u : ''), when)).join('');

    // The trend always spans the whole range — a one-day chart is a dot — but
    // 150 daily points in one card is a zigzag nobody can read, so long ranges
    // are bucketed and the heading says so rather than quietly implying days.
    const all = rptAggregateAllDays();
    const b = rptBucket(all);
    const word = (b.size === 1 ? 'per day' : b.size === 7 ? 'per week' : 'per ' + b.size + ' days') +
      (b.partial ? ' (part-finished ' + (b.size === 7 ? 'week' : 'period') + ' not plotted)' : '');
    $('rpts-trend-h').textContent = 'Beneficiaries reported ' + word;
    $('rpts-meals-h').textContent = 'Meals served ' + word;
    $('rpts-trend').innerHTML = b.rows.length
      ? Charts.line(b.labels, [
          { name: 'Children', color: Charts.PAL[0], area: true, values: b.rows.map(d => d.c) },
          { name: 'Pregnant', color: Charts.PAL[1], values: b.rows.map(d => d.p) },
          { name: 'Others', color: Charts.PAL[5], values: b.rows.map(d => d.o) }
        ])
      : Charts.empty('No reported days in this range.');
    $('rpts-meals').innerHTML = b.rows.length
      ? Charts.line(b.labels, [{ name: 'Meals', color: Charts.PAL[1], area: true,
          values: b.rows.map(d => d.m) }])
      : Charts.empty('No reported days in this range.');

    renderRptStock(A);
    renderRptTable(A);
  }

  /**
   * Collapse a long daily series into readable buckets. Whole weeks once the
   * range passes six weeks, so the x-axis stays a date the reader recognises.
   */
  function rptBucket(rows) {
    if (rows.length <= 45) {
      return { size: 1, rows: rows, labels: rows.map(d => prettyDay(d.iso).slice(0, 5)) };
    }
    const size = rows.length <= 220 ? 7 : 14;
    const out = [], labels = [];
    let partial = false;
    for (let i = 0; i < rows.length; i += size) {
      const chunk = rows.slice(i, i + size);
      // A part-finished final bucket plots as a cliff and reads as a collapse
      // in service when it is only a short week. Leave it out and say so; the
      // days are still in every table and export.
      if (chunk.length < size) { partial = true; break; }
      out.push(chunk.reduce((a, d) => ({ c: a.c + d.c, p: a.p + d.p, o: a.o + d.o, m: a.m + d.m }),
        { c: 0, p: 0, o: 0, m: 0 }));
      labels.push(prettyDay(chunk[0].iso).slice(0, 5));
    }
    return { size: size, rows: out, labels: labels, partial: partial };
  }

  /** The per-day series for the charts: the whole range regardless of the slider. */
  function rptAggregateAllDays() {
    const inScope = {};
    rptScopeAwcs().forEach(a => { inScope[a] = 1; });
    return rptDays.map(d => {
      const file = rptArchive[d.ym];
      const row = { iso: d.iso, c: 0, p: 0, o: 0, m: 0 };
      Object.keys(file.awcs || {}).forEach(aid => {
        if (!inScope[aid]) return;
        const r = file.awcs[aid].d[d.dd];
        if (!r) return;
        row.c += r[0]; row.p += r[1]; row.o += r[2]; row.m += r[3];
      });
      return row;
    });
  }

  /** The resource register: what came in, what went out, what is left. */
  function renderRptStock(A) {
    if (!rptDays.length) { $('rpts-stock').innerHTML = ''; return; }
    const rows = RPT_ITEMS.map(it => {
      const s = A.stock[it.k];
      const expected = r1(s.ob + s.recd - s.used);
      const drift = r1(s.cb - expected);
      return '<tr><td>' + esc(it.n) + (it.u ? ' <span class="reg-sub">' + esc(it.u) + '</span>' : '') +
        '</td><td>' + s.ob + '</td><td>' + s.recd + '</td><td>' + s.used + '</td><td><b>' + s.cb +
        '</b></td><td>' + expected + '</td><td' + (Math.abs(drift) > 0.05 ? ' class="reg-zero"' : '') +
        ' title="closing minus (opening + received − used)">' + (drift > 0 ? '+' : '') + drift +
        '</td><td>' + (A.tot.used[it.k] || 0) + '</td></tr>';
    }).join('');
    $('rpts-stock').innerHTML = '<table><tr><th>Item</th><th>Opening</th><th>Received</th>' +
      '<th>Used</th><th>Closing</th><th>Expected closing</th><th>Difference</th>' +
      '<th>Used in view</th></tr>' + rows + '</table>' +
      '<p class="info">Opening is the first balance in the range and closing the last, so a ' +
      'multi-month view is not double counted. <b>Difference</b> is closing minus ' +
      '(opening + received − used): anything other than zero is a register that does not ' +
      'balance, and is worth a call to the sector.</p>';
  }

  /** One row per centre for the selected range — the summary of all the data. */
  function renderRptTable(A) {
    const q = ($('rpts-search').value || '').trim().toLowerCase();
    const rows = rptScopeAwcs().filter(aid => {
      if (!q) return true;
      return (awcName(aid) + ' ' + sectorName(names.awcs[aid].sc)).toLowerCase().indexOf(q) >= 0;
    }).map(aid => {
      const a = A.perAwc[aid] || { days: 0, c: 0, p: 0, o: 0, m: 0,
        used: RPT_ITEMS.reduce((u, it) => { u[it.k] = 0; return u; }, {}) };
      return { aid: aid, sc: names.awcs[aid].sc, a: a };
    }).sort((x, y) => x.a.days === y.a.days
      ? awcName(x.aid).localeCompare(awcName(y.aid)) : x.a.days - y.a.days);

    if (!rows.length) { $('rpts-table').innerHTML = Charts.empty('No centres match.'); return; }
    const avg = (v, d) => d ? Math.round(v / d) : 0;
    $('rpts-table').innerHTML = '<table><tr><th>Sector</th><th>AWC</th><th>Days filed</th>' +
      '<th>Days missed</th><th>Children total</th><th>Avg/day</th><th>Pregnant</th>' +
      '<th>Others</th><th>Meals total</th><th>Avg/day</th>' +
      RPT_ITEMS.map(it => '<th>' + esc(it.n) + ' used' +
        (it.u ? ' <span class="reg-sub">' + esc(it.u) + '</span>' : '') + '</th>').join('') +
      '</tr>' + rows.map(r => {
        const missed = Math.max(0, A.tot.days - r.a.days);
        return '<tr><td>' + esc(sectorName(r.sc)) + '</td><td>' + esc(awcName(r.aid)) +
          '</td><td>' + r.a.days + '</td><td' + (missed ? ' class="reg-zero"' : '') + '>' + missed +
          '</td><td>' + r.a.c + '</td><td>' + avg(r.a.c, r.a.days) + '</td><td>' + r.a.p +
          '</td><td>' + r.a.o + '</td><td>' + r.a.m + '</td><td>' + avg(r.a.m, r.a.days) + '</td>' +
          RPT_ITEMS.map(it => '<td>' + (r.a.used[it.k] || 0) + '</td>').join('') + '</tr>';
      }).join('') + '</table>';
  }

  // ---- exports -------------------------------------------------------------
  function rptRangeTag() {
    if (!rptDays.length) return 'empty';
    return rptDays[0].iso + '_to_' + rptDays[rptDays.length - 1].iso;
  }

  /** One row per centre — the summary table, as filed. */
  function rptsCsv() {
    const A = rptAggregate();
    const head = ['sector_code', 'sector', 'awc_id', 'awc', 'days_filed', 'days_missed',
      'children_total', 'children_avg', 'pregnant_total', 'others_total',
      'meals_total', 'meals_avg'];
    RPT_ITEMS.forEach(it => head.push(it.k + '_used' + (it.u ? '_' + it.u : '')));
    const rows = [head];
    rptScopeAwcs().forEach(aid => {
      const a = A.perAwc[aid];
      const d = a ? a.days : 0;
      const line = [names.awcs[aid].sc, sectorName(names.awcs[aid].sc), aid, awcName(aid),
        d, Math.max(0, A.tot.days - d),
        a ? a.c : 0, d ? Math.round(a.c / d) : 0, a ? a.p : 0, a ? a.o : 0,
        a ? a.m : 0, d ? Math.round(a.m / d) : 0];
      RPT_ITEMS.forEach(it => line.push(a ? (a.used[it.k] || 0) : 0));
      rows.push(line);
    });
    downloadCsv('daily-reports-summary-' + rptRangeTag() + '.csv', rows);
  }

  /** One row per day — the district (or sector) totals, for the date-wise view. */
  function rptsDayCsv() {
    const inScope = {};
    rptScopeAwcs().forEach(a => { inScope[a] = 1; });
    const head = ['date', 'centres_reported', 'children', 'pregnant', 'others', 'meals'];
    RPT_ITEMS.forEach(it => head.push(it.k + '_used' + (it.u ? '_' + it.u : '')));
    const rows = [head];
    rptDays.forEach(d => {
      const file = rptArchive[d.ym];
      const line = [d.iso, 0, 0, 0, 0, 0];
      const used = RPT_ITEMS.map(() => 0);
      Object.keys(file.awcs || {}).forEach(aid => {
        if (!inScope[aid]) return;
        const r = file.awcs[aid].d[d.dd];
        if (!r) return;
        line[1]++; line[2] += r[0]; line[3] += r[1]; line[4] += r[2]; line[5] += r[3];
        RPT_ITEMS.forEach((it, i) => { used[i] = r1(used[i] + (r[4 + i] || 0)); });
      });
      rows.push(line.concat(used));
    });
    downloadCsv('daily-reports-daywise-' + rptRangeTag() + '.csv', rows);
  }

  /** Every filed report in the range, one row each — the full record. */
  function rptsDetailCsv() {
    const inScope = {};
    rptScopeAwcs().forEach(a => { inScope[a] = 1; });
    const head = ['date', 'sector_code', 'sector', 'awc_id', 'awc',
      'children', 'pregnant', 'others', 'meals'];
    RPT_ITEMS.forEach(it => head.push(it.k + '_used' + (it.u ? '_' + it.u : '')));
    const rows = [head];
    rptDays.forEach(d => {
      const file = rptArchive[d.ym];
      Object.keys(file.awcs || {}).sort().forEach(aid => {
        if (!inScope[aid]) return;
        const r = file.awcs[aid].d[d.dd];
        if (!r) return;
        rows.push([d.iso, names.awcs[aid].sc, sectorName(names.awcs[aid].sc), aid, awcName(aid),
          r[0], r[1], r[2], r[3]].concat(RPT_ITEMS.map((it, i) => r[4 + i] || 0)));
      });
    });
    downloadCsv('daily-reports-detail-' + rptRangeTag() + '.csv', rows);
  }

  /** Centres that filed nothing on the selected day (or nothing at all in the range). */
  function rptsMissingCsv() {
    const A = rptAggregate();
    const rows = [['awc_id', 'awc_name', 'sector', 'days_filed', 'days_missed']];
    rptScopeAwcs().forEach(aid => {
      const d = A.perAwc[aid] ? A.perAwc[aid].days : 0;
      if (d >= A.tot.days && A.tot.days > 0) return;
      rows.push([aid, awcName(aid), sectorName(names.awcs[aid].sc), d,
        Math.max(0, A.tot.days - d)]);
    });
    downloadCsv('awcs-not-reported-' + rptRangeTag() + '.csv', rows);
  }

  function fillRptControls() {
    $('rpts-scope').innerHTML = '<option value="ALL">All centres in my scope</option>' +
      (names.sectors || []).map(sc =>
        '<option value="' + esc(sc.code) + '">' + esc(sc.name) + ' (' + esc(sc.code) + ')</option>').join('');
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
  // The four types the district recognises. Older rows may still carry a
  // retired type (MATERNITY/OTHER) — those fall through to the raw code
  // rather than being hidden, because the register must show what was filed.
  const LEAVE_LABEL = { OPTIONAL: 'Optional Holiday', CASUAL: 'Casual Leave',
    EARNED: 'Earned Leave', SICK: 'Medical Leave' };
  const LEAVE_ORDER = ['OPTIONAL', 'CASUAL', 'EARNED', 'SICK'];

  /**
   * Who sanctioned it. Applications decided before this was recorded carry no
   * name and say so plainly — they are NOT relabelled with whoever holds the
   * post today. 'AUTO' is the old auto-approval policy, not a person.
   */
  function decidedBy(l) {
    if (l.status === 'PENDING') return '<span class="tag WARN">awaiting decision</span>';
    if (!l.by) return '<span title="decided before the approver was recorded">not recorded</span>';
    if (l.by === 'AUTO') return 'auto-approved (old policy)';
    return esc(l.byName || l.by) +
      (l.byAt ? '<br><span class="reg-sub">' + esc(String(l.byAt).slice(0, 10)) + '</span>' : '');
  }

  /** Certificate cell: medical leave carries a Government certificate; every
   *  other type does not need one, so it reads '—' rather than looking wrong. */
  function certCell(l) {
    if (l.type !== 'SICK') return '—';
    if (!l.mp) return '<span class="tag ERR">missing</span>';
    return esc(l.mi || '') + (l.mc ? ' · ' + esc(l.mc) : '') +
      ' <button class="btn btn-plain btn-inline" data-ph="' + esc(l.mp) + '">View</button>';
  }

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
    // Only Collector / District Admin decide, and only while they still hold
    // the right. `!== false` keeps an already-open session working: the server
    // is the authority either way, this only decides whether to draw buttons.
    const canDecide = me.role === 'ADMIN' && me.canApproveLeave !== false;
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
      '<th>Type</th><th>Reason</th><th>Govt. certificate</th><th>Status</th><th>Applied</th>' +
      '<th>Decided by</th><th>Action</th></tr>' +
      rows.map((l, i) =>
        '<tr><td>' + esc(userName(l.u)) + '</td><td>' + esc(l.from) + '</td><td>' + esc(l.to) +
        '</td><td>' + dayCount(l) + '</td><td>' + esc(LEAVE_LABEL[l.type] || l.type) +
        '</td><td>' + esc(l.reason || '') + '</td><td>' + certCell(l) +
        '</td><td><span class="tag ' + (l.status === 'APPROVED' ? 'OK' : l.status === 'REJECTED' ? 'ERR' : 'WARN') +
        '">' + esc(l.status) + '</span></td><td>' + esc(String(l.at).slice(0, 10)) + '</td><td>' +
        decidedBy(l) + '</td><td>' + actionsFor(l, i) + '</td></tr>').join('') + '</table>';
    bindPhotoButtons($('leaves-table'));
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

  // ---------------- Map ----------------
  // The payload is pre-computed by the summary trigger and served through an
  // authorised call — it holds precise GPS of identifiable staff and so is
  // deliberately NOT among the public summary files the rest of this console
  // reads. Scope filtering happens server-side.
  let mapLoaded = false;

  const MAP_CHIPS = [
    { k: 'all', label: 'Everything', c: 'all' },
    { k: 'present', label: 'Present', c: 'present' },
    { k: 'doubt', label: 'Not trustworthy', c: 'doubt' },
    { k: 'nofix', label: 'No fix', c: 'nofix' },
    { k: 'unmarked', label: 'Not marked', c: 'unmarked' },
    { k: 'filed', label: 'Filed', c: 'filed' }
  ];

  function renderMapChips() {
    const n = DistrictMap.counts();
    const cur = DistrictMap.getFilter();
    $('map-chips').innerHTML = MAP_CHIPS.map(ch =>
      '<button class="map-chip' + (ch.k === cur ? ' sel' : '') + '" data-f="' + ch.k + '">' +
      esc(ch.label) + '<b>' + (n[ch.c] || 0) + '</b></button>').join('');
    $('map-chips').querySelectorAll('button[data-f]').forEach(b => {
      b.onclick = () => {
        DistrictMap.setFilter(b.dataset.f, mapNameOf, mapUnitOf);
        renderMapChips();
      };
    });
  }

  const mapNameOf = uid => (names.users[uid] && names.users[uid].n) || uid;
  const mapUnitOf = aid => (names.awcs[aid] && names.awcs[aid].n) || aid;

  async function loadMap() {
    $('map-when').textContent = 'Loading…';
    const res = await Api.post({ action: 'mapDay', token: token });
    if (!res.ok) {
      if (['AUTH', 'EXPIRED', 'REVOKED'].indexOf(res.code) >= 0) { authLost(); return; }
      $('map-when').textContent = res.code === 'NOT_BUILT'
        ? 'The map has not been built yet today — it is produced by the same job that refreshes the dashboard.'
        : 'Could not load the map (' + res.code + ').';
      return;
    }
    mapLoaded = true;
    DistrictMap.render($('map-canvas'), res, mapNameOf, mapUnitOf);
    renderMapChips();
    const n = DistrictMap.counts();
    $('map-when').textContent = 'As of ' + String(res.generatedAt || '').slice(11, 16) +
      ' · ' + n.present + ' marked, ' + n.unmarked + ' not marked, ' + n.filed + ' reports' +
      ' · positions shown for ' + n.all + ' of them';
  }

  // ---------------- Leave Register ----------------
  // One tabular view of the whole annual register: entitlement, days taken,
  // days pending a decision, and balance for every person in scope. All the
  // arithmetic that decides a balance is done SERVER-side (apiLeaveRegister_)
  // and shipped here as numbers, so this tab can never disagree with the
  // balance the worker sees in the app.
  let regData = null;

  function fillRegisterControls() {
    const y = new Date().getFullYear();
    $('reg-year').innerHTML = [y, y - 1, y - 2]
      .map(v => '<option value="' + v + '">' + v + '</option>').join('');
    $('reg-sector').innerHTML = '<option value="ALL">All sectors in my scope</option>' +
      (names.sectors || []).map(sc =>
        '<option value="' + esc(sc.code) + '">' + esc(sc.name) + ' (' + esc(sc.code) + ')</option>').join('');
  }

  async function loadRegister() {
    $('reg-table').innerHTML = '<p class="info">Loading register&hellip;</p>';
    const res = await Api.post({ action: 'leaveRegister', token: token, year: $('reg-year').value });
    if (!res.ok) {
      if (['AUTH', 'EXPIRED', 'REVOKED'].indexOf(res.code) >= 0) { authLost(); return; }
      $('reg-table').innerHTML = '<p class="info">Could not load the register (' + esc(res.code) + ').</p>';
      return;
    }
    regData = res;
    renderRegister();
  }

  /** Rows for the current filters: every in-scope person, zero-filled. */
  function registerRows() {
    if (!regData) return [];
    const stat = {};
    (regData.rows || []).forEach(r => { stat[r.u] = r; });
    const sec = $('reg-sector').value;
    const q = $('reg-search').value.trim().toLowerCase();
    const only = $('reg-only').value;
    const ent = regData.ent || {};
    const out = [];
    Object.keys(names.users || {}).forEach(uid => {
      const u = names.users[uid];
      if (u.s && u.s !== 'ACTIVE') return;   // retired/blocked staff hold no live balance
      if (sec !== 'ALL' && u.sc !== sec) return;
      if (q && (u.n || '').toLowerCase().indexOf(q) < 0 && uid.toLowerCase().indexOf(q) < 0) return;
      const st = stat[uid] || { taken: {}, pend: {} };
      const per = {};
      let totTaken = 0, totPend = 0, exhausted = false;
      LEAVE_ORDER.forEach(t => {
        const taken = st.taken[t] || 0;
        const pend = st.pend[t] || 0;
        const cap = ent[t];                  // undefined for SICK = uncapped
        const bal = cap == null ? null : Math.max(0, cap - taken - pend);
        per[t] = { ent: cap == null ? null : cap, taken: taken, pend: pend, bal: bal };
        totTaken += taken;
        totPend += pend;
        if (bal === 0) exhausted = true;
      });
      if (only === 'active' && !totTaken && !totPend) return;
      if (only === 'exhausted' && !exhausted) return;
      out.push({ uid: uid, name: u.n || uid, cadre: u.c || '', sc: u.sc || '',
        role: u.r || '', per: per, totTaken: totTaken, totPend: totPend });
    });
    out.sort((a, b) => a.sc === b.sc ? a.name.localeCompare(b.name) : a.sc.localeCompare(b.sc));
    return out;
  }

  /** Column set: all four types, or just the one the type filter selects. */
  function registerTypes() {
    const t = $('reg-type').value;
    return t ? [t] : LEAVE_ORDER.slice();
  }

  function renderRegister() {
    if (!regData) return;
    const rows = registerRows();
    const types = registerTypes();

    const sum = { taken: 0, pend: 0, people: 0, med: 0 };
    rows.forEach(r => {
      types.forEach(t => { sum.taken += r.per[t].taken; sum.pend += r.per[t].pend; });
      sum.med += r.per.SICK.taken;
      if (types.some(t => r.per[t].taken || r.per[t].pend)) sum.people++;
    });
    $('reg-cards').innerHTML =
      bigcard('bc-grey', 'Staff in register', rows.length, 'active staff in scope') +
      bigcard('bc-teal', 'Staff who took leave', sum.people, String(regData.year)) +
      bigcard('bc-olive', 'Days taken', sum.taken, 'approved days') +
      bigcard('bc-maroon', 'Days awaiting decision', sum.pend, 'held against balance') +
      bigcard('bc-blue', 'Medical days', sum.med, 'no annual limit');

    if (!rows.length) {
      $('reg-table').innerHTML = '<p class="info">No staff match these filters.</p>';
      $('reg-apps-head').hidden = true;
      $('reg-apps').innerHTML = '';
      return;
    }

    const head = '<table><tr><th>Name</th><th>User ID</th><th>Cadre</th><th>Sector</th>' +
      types.map(t => '<th>' + esc(LEAVE_LABEL[t]) +
        (regData.ent[t] != null ? ' (' + regData.ent[t] + ')' : ' (no limit)') +
        '<br><span class="reg-sub">taken &middot; pending &middot; balance</span></th>').join('') +
      '<th>Total taken</th></tr>';
    const body = rows.map(r => '<tr><td>' + esc(r.name) + '</td><td>' + esc(r.uid) +
      '</td><td>' + esc(r.cadre) + '</td><td>' + esc(sectorName(r.sc)) + '</td>' +
      types.map(t => {
        const c = r.per[t];
        const bal = c.bal == null ? '&infin;' : c.bal;
        const cls = c.bal === 0 ? ' class="reg-zero"' : '';
        return '<td' + cls + '>' + c.taken + ' &middot; ' + c.pend + ' &middot; <b>' + bal + '</b></td>';
      }).join('') +
      '<td>' + r.totTaken + (r.totPend ? ' (+' + r.totPend + ')' : '') + '</td></tr>').join('');
    $('reg-table').innerHTML = head + body + '</table>';

    renderRegisterApps();
  }

  function registerApps() {
    if (!regData) return [];
    const sec = $('reg-sector').value;
    const q = $('reg-search').value.trim().toLowerCase();
    const type = $('reg-type').value;
    return (regData.apps || []).filter(a => {
      const u = names.users[a.u];
      if (!u) return false;
      if (type && a.type !== type) return false;
      if (sec !== 'ALL' && u.sc !== sec) return false;
      if (q && (u.n || '').toLowerCase().indexOf(q) < 0 && a.u.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }

  function renderRegisterApps() {
    const apps = registerApps();
    $('reg-apps-head').hidden = !apps.length;
    if (!apps.length) { $('reg-apps').innerHTML = ''; return; }
    $('reg-apps').innerHTML = '<table><tr><th>Name</th><th>Sector</th><th>From</th><th>To</th>' +
      '<th>Days</th><th>Type</th><th>Reason</th><th>Govt. certificate</th>' +
      '<th>Status</th><th>Applied</th><th>Decided by</th></tr>' +
      apps.map(a => {
        const u = names.users[a.u] || {};
        return '<tr><td>' + esc(u.n || a.u) + '</td><td>' + esc(sectorName(u.sc)) +
          '</td><td>' + esc(a.from) + '</td><td>' + esc(a.to) + '</td><td>' + a.days +
          '</td><td>' + esc(LEAVE_LABEL[a.type] || a.type) + '</td><td>' + esc(a.reason || '') +
          '</td><td>' + certCell(a) + '</td><td><span class="tag ' +
          (a.status === 'APPROVED' ? 'OK' : a.status === 'REJECTED' ? 'ERR' : 'WARN') + '">' +
          esc(a.status) + '</span></td><td>' + esc(String(a.at).slice(0, 10)) + '</td><td>' +
          decidedBy(a) + '</td></tr>';
      }).join('') + '</table>';
    bindPhotoButtons($('reg-apps'));
  }

  function registerCsv() {
    if (!regData) return;
    const types = registerTypes();
    const head = ['user_id', 'name', 'cadre', 'sector_code', 'sector'];
    types.forEach(t => head.push(t + '_entitled', t + '_taken', t + '_pending', t + '_balance'));
    head.push('total_taken', 'total_pending');
    const rows = [head];
    registerRows().forEach(r => {
      const line = [r.uid, r.name, r.cadre, r.sc, sectorName(r.sc)];
      types.forEach(t => {
        const c = r.per[t];
        line.push(c.ent == null ? 'NO LIMIT' : c.ent, c.taken, c.pend,
          c.bal == null ? 'NO LIMIT' : c.bal);
      });
      line.push(r.totTaken, r.totPend);
      rows.push(line);
    });
    downloadCsv('leave-register-' + regData.year + '.csv', rows);
  }

  function registerAppsCsv() {
    if (!regData) return;
    const rows = [['leave_id', 'user_id', 'name', 'sector', 'from', 'to', 'days', 'type',
      'reason', 'status', 'applied_at', 'decided_by', 'decided_by_name', 'decided_at',
      'govt_institution', 'certificate_no', 'certificate_photo_id']];
    registerApps().forEach(a => {
      const u = names.users[a.u] || {};
      rows.push([a.id, a.u, u.n || '', sectorName(u.sc), a.from, a.to, a.days,
        LEAVE_LABEL[a.type] || a.type, a.reason || '', a.status, a.at, a.by || '',
        a.byName || '', a.byAt || '', a.mi || '', a.mc || '', a.mp || '']);
    });
    downloadCsv('leave-applications-' + regData.year + '.csv', rows);
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
        { label: 'Present', value: totPresent, color: Charts.STATUS.ok },
        { label: 'On leave', value: totLeave, color: Charts.STATUS.idle },
        { label: 'Absent', value: totAbsent, color: Charts.STATUS.bad }
      ], { center: attPct + '%', centerLabel: 'attendance' }) + '</div>' +
      '<div class="chartbox"><h3>GPS verification (IN marks)</h3>' +
      Charts.donut([
        { label: 'Inside fence', value: Math.max(0, totPresent - totOutside - totUnv), color: Charts.STATUS.ok },
        { label: 'Outside fence', value: totOutside, color: Charts.STATUS.warn },
        { label: 'Unverified', value: totUnv, color: Charts.STATUS.idle }
      ], { center: verifPct + '%', centerLabel: 'verified' }) + '</div>' +
      '<div class="chartbox"><h3>Day closure (OUT marked)</h3>' +
      Charts.meter(totOut, totPresent, { color: Charts.PAL[0], unit: 'person-days',
        foot: Math.max(0, totPresent - totOut) + ' person-days closed without an OUT mark' }) + '</div>' +
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
      bandsChart([
        { label: 'Before 9:00', value: inBuckets[0] }, { label: '9:00–9:30', value: inBuckets[1] },
        { label: '9:30–10:00', value: inBuckets[2] }, { label: '10:00–11:00', value: inBuckets[3] },
        { label: 'After 11:00', value: inBuckets[4] }
      ], 'No IN marks this month.') + '</div>' +
      '<div class="chartbox"><h3>Data-quality flags</h3>' +
      (Object.keys(flagCount).length
        ? Charts.bar(Object.keys(flagCount).sort((a, b) => flagCount[b] - flagCount[a]).slice(0, 6)
            .map(fl => ({ label: fl.slice(0, 12), title: fl + ': ' + flagCount[fl],
              value: flagCount[fl] })), { color: Charts.STATUS.warn })
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
      '<th>AWC / Sector</th><th>Role</th><th>Status</th><th>Leave approval</th>' +
      '<th>Login Status</th><th>Actions</th></tr>' +
      uids.map(uid => {
        const u = names.users[uid];
        return '<tr><td>' + esc(uid) + '</td><td>' + esc(u.n) + '</td><td>' + esc(u.c) + '</td><td>' +
          esc(u.p || 'NO PHONE') + '</td><td>' + esc(u.a ? awcName(u.a) : sectorDisplay(u.sc)) + '</td><td>' +
          esc(u.r) + '</td><td>' + esc(u.s) + '</td><td>' + leaveApprovalCell(uid, u, isAdmin) + '</td><td>' +
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

  /**
   * Leave sanction is separable from the ADMIN role: an officer can keep full
   * console access with this right withdrawn. Only ADMINs can hold it at all,
   * so everyone else reads '—' rather than an off switch that means nothing.
   */
  function leaveApprovalCell(uid, u, isAdmin) {
    if (u.r !== 'ADMIN') return '—';
    const on = u.la !== 0;
    const tag = on ? '<span class="tag OK">CAN APPROVE</span>'
                   : '<span class="tag ERR">WITHDRAWN</span>';
    if (!isAdmin || uid === me.id) return tag;   // nobody withdraws their own
    return tag + ' <button class="btn btn-plain btn-inline" data-do="leaveApprover" data-uid="' +
      esc(uid) + '">' + (on ? 'Withdraw' : 'Grant') + '</button>';
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
    } else if (what === 'leaveApprover') {
      const on = u.la !== 0;
      if (!confirm((on ? 'Withdraw leave-sanction power from ' : 'Grant leave-sanction power to ') +
        u.n + '?\n\nTheir other console access is unchanged.')) return;
      const res = await Api.post({ action: 'setLeaveApprover', token: token,
        userId: uid, canApprove: !on });
      if (res.ok) { u.la = on ? 0 : 1; renderAdmin(); } else alert('Failed: ' + res.code);
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

  /** Create a console account. ADMIN only; the server checks that again. */
  function initNewUserForm() {
    const isAdmin = me.role === 'ADMIN';
    $('admin-newuser').hidden = !isAdmin;
    if (!isAdmin) return;
    $('nu-project').innerHTML = (names.projects || []).map(pr =>
      '<option value="' + esc(pr.code) + '">' + esc(pr.name) + ' (' + esc(pr.code) + ')</option>').join('');
    $('nu-sector').innerHTML = (names.sectors || []).map(sc =>
      '<option value="' + esc(sc.code) + '">' + esc(sc.name) + ' (' + esc(sc.code) + ')</option>').join('');
    const sync = () => {
      const r = $('nu-role').value;
      $('nu-project').hidden = r !== 'CDPO';
      $('nu-sector').hidden = r !== 'SUPERVISOR';
    };
    $('nu-role').onchange = sync;
    sync();
    $('btn-nu-add').onclick = createConsoleUser;
  }

  async function createConsoleUser() {
    const msg = $('nu-msg');
    msg.textContent = '';
    const name = $('nu-name').value.trim();
    const phone = $('nu-phone').value.replace(/\D/g, '');
    const role = $('nu-role').value;
    if (!name) { msg.textContent = 'Enter the officer\'s name or designation.'; return; }
    if (!/^\d{10}$/.test(phone)) { msg.textContent = 'Enter a 10-digit mobile number.'; return; }

    // A shared phone is normal for AWT+AWH pairs but never for a console
    // officer — say so before creating a second account on the same number.
    const clash = Object.keys(names.users).filter(id => names.users[id].p === phone);
    if (clash.length && !confirm('This number already belongs to ' +
      clash.map(id => names.users[id].n).join(', ') +
      '.\n\nCreate a SEPARATE account on the same number?')) return;

    const user = { name: name, phone: phone, role: role,
      cadre: role === 'ADMIN' ? 'OTHER' : role,
      project_code: role === 'CDPO' ? $('nu-project').value : '',
      sector_code: role === 'SUPERVISOR' ? $('nu-sector').value : '', awc_id: '' };
    $('btn-nu-add').disabled = true;
    try {
      const res = await Api.post({ action: 'userUpsert', token: token, user: user });
      if (!res.ok) { msg.textContent = 'Failed: ' + res.code; return; }
      msg.textContent = 'Created ' + name + ' as ' + role + ' (' + res.userId +
        '). They log in with ' + phone + ' and set their own PIN.';
      $('nu-name').value = '';
      $('nu-phone').value = '';
      await refreshNames();
      renderAdmin();
    } catch (e) {
      msg.textContent = 'Could not reach the server — try again.';
    } finally {
      $('btn-nu-add').disabled = false;
    }
  }

  /** Re-pull the name map so a new account appears without a full reload. */
  async function refreshNames() {
    const res = await Api.post({ action: 'nameMap', token: token });
    if (res.ok) names = res;
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

    // 2. Static hosting (GitHub Pages): timed meta.json + pipeline heartbeat.
    // checkedAt = the summariser's alive-signal (committed every ≤30 min even
    // when idle); generatedAt = last actual data change (only moves when new
    // marks arrived — old is normal on a quiet afternoon).
    let staticMs = null, beatMin = null, dataMin = null;
    try {
      const t0 = performance.now();
      const meta2 = await Api.fetchJson('summary/meta.json');
      staticMs = Math.round(performance.now() - t0);
      if (meta2) {
        const beat = meta2.checkedAt || meta2.generatedAt;
        if (beat) beatMin = Math.round((Date.now() - new Date(beat)) / 60000);
        if (meta2.generatedAt) {
          dataMin = Math.round((Date.now() - new Date(meta2.generatedAt)) / 60000);
        }
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
    slas.push(['Summary pipeline heartbeat', '≤ 35 min',
      beatMin == null ? '—' : beatMin + ' min',
      beatMin == null ? 'WARN' : beatMin <= 35 ? 'OK' : beatMin <= 60 ? 'WARN' : 'BREACH',
      'checks every 5 min, commits an idle heartbeat every ≤30 min; last data change ' +
      (dataMin == null ? '—' : dataMin + ' min ago') + ' (only moves when new marks arrive)']);
    slas.push(['Static site response', '≤ 1.5 s',
      staticMs == null ? '—' : (staticMs / 1000).toFixed(2) + ' s',
      staticMs == null ? 'WARN' : staticMs <= 1500 ? 'OK' : staticMs <= 4000 ? 'WARN' : 'BREACH',
      'GitHub Pages CDN serving the dashboard data']);
    const pfOn = pf && (pf.on || (pf.sdP95 != null ? { n: pf.marks, med: pf.sdMed, p95: pf.sdP95 } : null));
    slas.push(['Mark sync delay — online marks (p95)', '≤ 5 min',
      pfOn && pfOn.n ? fmtS(pfOn.p95) : '—',
      !pfOn || !pfOn.n ? 'WARN' : pfOn.p95 <= 300 ? 'OK' : pfOn.p95 <= 900 ? 'WARN' : 'BREACH',
      'marks made WITH network; closing the app mid-upload still counts until next open, ' +
      'so a long tail here means user behaviour, not a slow server']);
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
    ['today', 'analytics', 'exceptions', 'rpts', 'monthly', 'reports', 'leaves', 'register',
      'map', 'admin', 'perf'].forEach(t => {
      $('tab-' + t).classList.toggle('sel', t === name);
      $('view-' + t).hidden = t !== name;
    });
    if (name === 'admin') renderAdmin();
    if (name === 'leaves') renderLeaves();
    // The register is a full-year pull; fetch it on first open, then let the
    // Reload button decide — switching tabs must not re-hit the backend.
    if (name === 'register' && !regData) loadRegister();
    // Leaflet measures its container on creation, so the first draw has to
    // happen after this panel is visible — and every later visit needs a
    // re-measure because the panel was display:none in between.
    if (name === 'map') { if (!mapLoaded) loadMap(); else DistrictMap.invalidate(); }
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
    // The archive is fetched on first open, not at boot: six month files is
    // not something to pull for every console login.
    $('tab-rpts').onclick = () => { switchTab('rpts'); markRptsSeen(); loadRpts(); };
    $('rpts-search').oninput = renderRpts;
    $('rpts-range').onchange = loadRpts;
    $('btn-rpts-load').onclick = loadRpts;
    $('rpts-scope').onchange = renderRpts;
    $('rpts-day').oninput = () => { $('rpts-allday').checked = false; renderRpts(); };
    $('rpts-allday').onchange = renderRpts;
    $('btn-rpts-csv').onclick = rptsCsv;
    $('btn-rpts-daycsv').onclick = rptsDayCsv;
    $('btn-rpts-detailcsv').onclick = rptsDetailCsv;
    $('btn-rpts-missing-csv').onclick = rptsMissingCsv;
    $('tab-monthly').onclick = () => switchTab('monthly');
    $('tab-reports').onclick = () => switchTab('reports');
    $('tab-leaves').onclick = () => switchTab('leaves');
    $('tab-register').onclick = () => switchTab('register');
    $('tab-map').onclick = () => switchTab('map');
    $('btn-map-fit').onclick = () => DistrictMap.fitAll();
    $('btn-map-reload').onclick = loadMap;
    $('btn-reg-load').onclick = loadRegister;
    $('reg-year').onchange = loadRegister;
    // Sector / type / staff-set / search only re-filter what is already loaded.
    $('reg-sector').onchange = renderRegister;
    $('reg-type').onchange = renderRegister;
    $('reg-only').onchange = renderRegister;
    $('reg-search').oninput = renderRegister;
    $('btn-reg-csv').onclick = registerCsv;
    $('btn-reg-apps-csv').onclick = registerAppsCsv;
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
