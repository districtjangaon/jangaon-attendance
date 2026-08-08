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
    const nm = await Api.post({ action: 'nameMap', token: token });
    if (!nm.ok) { authLost(); return; }
    names = nm;
    $('screen-login').hidden = true;
    $('main').hidden = false;
    $('btn-logout').hidden = false;
    $('head-user').textContent = me.name + ' (' + me.role + ')';
    $('tab-admin').hidden = false; // server scopes what each role can actually do
    fillMonthControls();
    fillReportControls();
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
  }

  function renderStale() {
    const b = $('stale-banner');
    if (!today || !today.generatedAt) {
      b.hidden = false;
      b.className = 'banner err';
      b.textContent = 'No summary data published yet — check the Apps Script triggers and GitHub token.';
      return;
    }
    const min = Math.round((Date.now() - new Date(today.generatedAt).getTime()) / 60000);
    b.hidden = false;
    b.className = 'banner ' + (min <= 15 ? 'ok' : min <= 45 ? 'warn' : 'err');
    b.textContent = 'Data generated ' + (min < 1 ? 'just now' : min + ' min ago') +
      ' (' + new Date(today.generatedAt).toLocaleTimeString() + ') • regenerates every 5 min in ' +
      'working hours • this screen re-checks every 30 s.';
  }

  // ---------------- helpers ----------------
  const userName = uid => (names.users[uid] && names.users[uid].n) || uid;
  const awcName = a => (names.awcs[a] && names.awcs[a].n) ||
    (window._org && window._org.awcs[a] && window._org.awcs[a].n) || a || '';
  const sectorName = sc => {
    const s = (names.sectors || []).find(x => x.code === sc);
    return s ? s.name : sc;
  };
  const projectName = pc => {
    const p = (names.projects || []).find(x => x.code === pc);
    return p ? p.name : pc;
  };
  const inScopeUid = uid => !!names.users[uid];

  function statusTag(st) { return '<span class="tag ' + esc(st) + '">' + esc(st.replace('_', ' ')) + '</span>'; }
  function gfTag(gf) { return gf ? '<span class="tag ' + esc(gf) + '">' + esc(gf) + '</span>' : ''; }

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
  const PALETTE = ['#1e8e3e', '#4285f4', '#f4b400', '#e37400', '#c5221f', '#7b1e3c'];

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

  function trendSVG(inTimes) {
    if (!inTimes.length) return '<p class="info">No IN marks yet today.</p>';
    const mins = inTimes.map(t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))).sort((a, b) => a - b);
    const start = 6 * 60, end = 18 * 60, W = 340, H = 130, PB = 22, PL = 30;
    const x = m => PL + Math.min(1, Math.max(0, (m - start) / (end - start))) * (W - PL - 8);
    const y = c => (H - PB) - (c / mins.length) * (H - PB - 12);
    let path = 'M' + PL + ',' + (H - PB);
    mins.forEach((m, i) => { path += ' L' + x(m).toFixed(1) + ',' + y(i + 1).toFixed(1); });
    const area = path + ' L' + x(mins[mins.length - 1]).toFixed(1) + ',' + (H - PB) + ' Z';
    let labels = '';
    for (let h = 6; h <= 18; h += 3) {
      labels += '<text x="' + x(h * 60).toFixed(0) + '" y="' + (H - 6) +
        '" font-size="10" fill="#888" text-anchor="middle">' + h + ':00</text>';
    }
    return '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' +
      '<line x1="' + PL + '" y1="' + (H - PB) + '" x2="' + (W - 6) + '" y2="' + (H - PB) + '" stroke="#ddd"/>' +
      '<path d="' + area + '" fill="rgba(30,142,62,.18)"/>' +
      '<path d="' + path + '" fill="none" stroke="#1e8e3e" stroke-width="2"/>' +
      '<text x="' + PL + '" y="12" font-size="11" fill="#555">' + mins.length + ' marked IN (cumulative)</text>' +
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
      html = '<table><tr><th>Project</th><th>Expected</th><th>Marked IN</th><th>Late</th>' +
        '<th>Not marked</th><th>Outside</th><th>Unverified</th></tr>' +
        today.projects.map(p =>
          '<tr class="click" data-code="' + esc(p.code) + '"><td>' + esc(projectName(p.code)) + '</td><td>' +
          p.expected + '</td><td>' + (p.in + p.late) + '</td><td>' + p.late + '</td><td>' +
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
      html = '<table><tr><th>Sector</th><th>Expected</th><th>Marked IN</th><th>Late</th>' +
        '<th>Not marked</th><th>Outside</th><th>Unverified</th></tr>' +
        secs.map(s =>
          '<tr class="click" data-code="' + esc(s.code) + '"><td>' + esc(sectorName(s.code)) + '</td><td>' +
          s.expected + '</td><td>' + (s.in + s.late) + '</td><td>' + s.late + '</td><td>' +
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
  function renderExceptions() {
    const merged = [];
    const seen = {};
    ((today && today.exceptions) || []).concat(nightlyExc).forEach(e => {
      if (!inScopeUid(e.u) || seen[e.key]) return;
      seen[e.key] = 1;
      merged.push(e);
    });
    $('exc-count').hidden = !merged.length;
    $('exc-count').textContent = merged.length;

    if (!merged.length) {
      $('exc-list').innerHTML = '<p class="info">Nothing to review. All marks inside geofence, no flags.</p>';
      return;
    }
    $('exc-list').innerHTML = '<table><tr><th>Name</th><th>Sector</th><th>Date</th><th>Type</th>' +
      '<th>Time</th><th>Geofence</th><th>Flags</th><th>Photo</th></tr>' +
      merged.map(e =>
        '<tr><td>' + esc(userName(e.u)) + '</td><td>' + esc(sectorName(e.s)) + '</td><td>' +
        esc(e.d || (today && today.date) || '') + '</td><td>' + esc(e.t) + '</td><td>' + esc(e.at || '–') +
        '</td><td>' + gfTag(e.gf) + '</td><td class="flags">' + esc(e.fl || '') + '</td><td>' +
        (e.ph ? '<button class="btn btn-plain btn-inline" data-ph="' + esc(e.ph) + '">view</button>' : '') +
        '</td></tr>').join('') + '</table>';

    bindPhotoButtons($('exc-list'));
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
    const rows = res.leaves || [];
    if (!rows.length) {
      $('leaves-table').innerHTML = '<p class="info">No leave applications yet. Workers apply from the app menu.</p>';
      return;
    }
    const dayCount = l => Math.round((new Date(l.to) - new Date(l.from)) / 86400000) + 1;
    $('leaves-table').innerHTML = '<table><tr><th>Name</th><th>From</th><th>To</th><th>Days</th>' +
      '<th>Type</th><th>Reason</th><th>Status</th><th>Applied</th><th>Action</th></tr>' +
      rows.map((l, i) =>
        '<tr><td>' + esc(userName(l.u)) + '</td><td>' + esc(l.from) + '</td><td>' + esc(l.to) +
        '</td><td>' + dayCount(l) + '</td><td>' + esc(l.type) + '</td><td>' + esc(l.reason || '') +
        '</td><td><span class="tag ' + (l.status === 'APPROVED' ? 'OK' : l.status === 'REJECTED' ? 'ERR' : 'WARN') +
        '">' + esc(l.status) + '</span></td><td>' + esc(String(l.at).slice(0, 10)) + '</td><td>' +
        (l.status !== 'REJECTED'
          ? '<button class="btn btn-plain btn-inline" data-dec="REJECTED" data-i="' + i + '">Reject</button>'
          : '<button class="btn btn-plain btn-inline" data-dec="APPROVED" data-i="' + i + '">Approve</button>') +
        '</td></tr>').join('') + '</table>';
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

  // ---------------- Admin ----------------
  function renderAdmin() {
    if (!names) return;
    const q = $('admin-search').value.trim().toLowerCase();
    const uids = Object.keys(names.users).filter(uid => {
      const u = names.users[uid];
      if (!q) return true;
      return u.n.toLowerCase().includes(q) || String(u.p).includes(q) ||
        awcName(u.a).toLowerCase().includes(q) || uid.toLowerCase() === q;
    }).sort((a, b) => names.users[a].n < names.users[b].n ? -1 : 1).slice(0, 200);

    const isAdmin = me.role === 'ADMIN';
    $('admin-table').innerHTML = '<table><tr><th>ID</th><th>Name</th><th>Cadre</th><th>Phone</th>' +
      '<th>AWC / Sector</th><th>Role</th><th>Status</th><th>Actions</th></tr>' +
      uids.map(uid => {
        const u = names.users[uid];
        return '<tr><td>' + esc(uid) + '</td><td>' + esc(u.n) + '</td><td>' + esc(u.c) + '</td><td>' +
          esc(u.p || 'NO PHONE') + '</td><td>' + esc(u.a ? awcName(u.a) : sectorName(u.sc)) + '</td><td>' +
          esc(u.r) + '</td><td>' + esc(u.s) + '</td><td>' +
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

  // ---------------- tabs & events ----------------
  function switchTab(name) {
    ['today', 'exceptions', 'monthly', 'reports', 'leaves', 'admin'].forEach(t => {
      $('tab-' + t).classList.toggle('sel', t === name);
      $('view-' + t).hidden = t !== name;
    });
    if (name === 'admin') renderAdmin();
    if (name === 'leaves') renderLeaves();
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
    $('tab-exceptions').onclick = () => switchTab('exceptions');
    $('tab-monthly').onclick = () => switchTab('monthly');
    $('tab-reports').onclick = () => switchTab('reports');
    $('tab-leaves').onclick = () => switchTab('leaves');
    $('tab-admin').onclick = () => switchTab('admin');
    $('btn-month-load').onclick = loadMonth;
    $('btn-month-csv').onclick = monthCsv;
    $('btn-report-load').onclick = buildReport;
    $('btn-report-csv').onclick = reportCsv;
    $('admin-search').oninput = renderAdmin;
    $('btn-awc-capture').onclick = captureAwc;
    $('lightbox-close').onclick = () => { $('lightbox').hidden = true; };
    $('lightbox').onclick = e => { if (e.target === $('lightbox')) $('lightbox').hidden = true; };
  }

  async function init() {
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
