'use strict';
/**
 * App orchestration: screens, login, marking flow, multi-user accounts.
 *
 * At ~190 of 695 AWCs the AWT and AWH share the centre's phone, so this app
 * holds SEVERAL logged-in accounts on one device:
 *   kv 'accounts'  = { userId: { token, user, config } }
 *   kv 'activeUid' = the account currently marking
 * Queue records embed the user id in their idempotency key, so the sync
 * engine always sends each record under its owner's token, whoever is active.
 *
 * Taps from open to marked: IN (1) -> CAPTURE (2). Two.
 */
const App = (() => {
  const $ = id => document.getElementById(id);
  const screens = ['screen-login', 'screen-home', 'screen-users', 'screen-camera',
    'screen-success', 'screen-history', 'screen-menu', 'screen-leave'];

  let accounts = {};    // uid -> { token, user, config }
  let activeUid = null;
  let places = [];      // district gazetteer: every AWC's name + coords
  let loginSel = null;  // userId chosen in the who-am-I picker
  let geoPromise = null;
  let geoResult = null;
  let markType = null;

  const active = () => (activeUid && accounts[activeUid]) || null;

  function show(id) {
    screens.forEach(s => { $(s).hidden = (s !== id); });
    $('btn-menu').hidden = (id === 'screen-login');
  }

  function localIso() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-', a = Math.abs(off);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
      sign + p(Math.floor(a / 60)) + ':' + p(a % 60);
  }
  const todayCompact = () => localIso().slice(0, 10).replace(/-/g, '');

  async function deviceId() {
    let id = await DB.kvGet('deviceId');
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) ||
        'd-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
      await DB.kvSet('deviceId', id);
    }
    return id;
  }

  async function saveAccounts() {
    await DB.kvSet('accounts', accounts);
    await DB.kvSet('activeUid', activeUid);
  }

  /**
   * District gazetteer (summary/places.json, published by the backend):
   * lets the photo stamp always carry a PLACE NAME, never raw coordinates.
   * Cached in IndexedDB for offline days; refreshed weekly.
   */
  async function loadPlaces() {
    const cached = await DB.kvGet('places');
    if (cached) places = cached.list || [];
    if (cached && Date.now() - cached.at < 7 * 86400000) return;
    try {
      const res = await fetch('../summary/places.json?t=' + Date.now());
      if (!res.ok) return;
      const j = await res.json();
      places = Object.keys(j.awcs || {}).map(id =>
        ({ name: j.awcs[id].n, lat: j.awcs[id].lat, lng: j.awcs[id].lng }));
      await DB.kvSet('places', { at: Date.now(), list: places });
    } catch (e) { /* offline: keep the cached copy */ }
  }

  const fmtDist = d => d >= 1000 ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m';

  /** Human place line for the stamp: own AWC, else nearest known centre. */
  function placeLine(g, cfg) {
    if (!g) return 'GPS UNAVAILABLE';
    let best = null, bestD = Infinity, isNear = false;
    for (const l of ((cfg && cfg.locations) || [])) {
      if (l.lat == null || l.lng == null) continue;
      const d = Geo.distM(g.lat, g.lng, l.lat, l.lng);
      if (d < bestD) { bestD = d; best = l; }
    }
    if (!best) {
      for (const p of places) {
        const d = Geo.distM(g.lat, g.lng, p.lat, p.lng);
        if (d < bestD) { bestD = d; best = p; }
      }
      isNear = true;
    }
    return best
      ? (isNear ? 'Near ' : '') + best.name.slice(0, 26) + ' · ' + fmtDist(bestD)
      : g.lat.toFixed(5) + ',' + g.lng.toFixed(5); // empty gazetteer: last resort
  }

  // ---------- init ----------
  async function init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
      // A new version activated: reload to run it — but never mid-capture,
      // and never while records are being sent.
      navigator.serviceWorker.addEventListener('message', e => {
        if (e.data && e.data.type === 'sw-updated' &&
            $('screen-camera').hidden && !Sync.isSyncing()) {
          location.reload();
        }
      });
    }
    Sync.init();
    window.addEventListener('online', renderStatus);
    window.addEventListener('offline', renderStatus);
    bindEvents();
    setInterval(() => { if (!$('screen-home').hidden) updateClock(); }, 20000);

    accounts = await DB.kvGet('accounts') || {};
    if ('Notification' in window && Notification.permission === 'granted') {
      registerPeriodicReminder();
    }
    activeUid = await DB.kvGet('activeUid') || null;
    loadPlaces(); // async; stamp falls back gracefully until it arrives
    if (activeUid && !accounts[activeUid]) activeUid = Object.keys(accounts)[0] || null;
    if (active()) {
      await goHome();
      Sync.schedule('startup');
    } else {
      resetLogin();
      show('screen-login');
    }
  }

  function bindEvents() {
    $('btn-login').onclick = doLogin;
    ['in-phone', 'in-pin', 'in-newpin2'].forEach(id => {
      $(id).addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
    });
    $('btn-mark').onclick = () => startMark();
    $('btn-capture').onclick = doCapture;
    $('btn-cam-cancel').onclick = () => { Camera.stop(); goHome(); };
    $('btn-syncnow').onclick = () => { Sync.schedule('manual'); };
    $('btn-history').onclick = showHistory;
    $('btn-history-back').onclick = goHome;
    $('btn-users').onclick = showUsers;
    $('btn-users-back').onclick = goHome;
    $('btn-adduser').onclick = () => { resetLogin(); show('screen-login'); };
    $('btn-menu').onclick = showMenu;
    $('btn-menu-back').onclick = goHome;
    $('btn-logout').onclick = doLogout;
    $('btn-demo-reset').onclick = demoReset;
    $('btn-leave').onclick = showLeave;
    $('btn-leave-back').onclick = goHome;
    $('btn-leave-submit').onclick = submitLeave;
    $('btn-test-reset').onclick = testReset;
    $('btn-refresh-app').onclick = refreshApp;
    $('btn-notif').onclick = enableReminders;
  }

  /** Header ↻: check for a new version and reload — works on every screen. */
  async function refreshApp() {
    $('btn-refresh-app').classList.add('spinning');
    try {
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) await reg.update(); // if a new version installs, sw-updated
      }                              // will reload us; otherwise reload below
    } catch (e) { /* offline: plain reload still shows cached app */ }
    setTimeout(() => location.reload(), 800);
  }

  /** ADMIN only: wipe own marks for today (server + this phone) to re-test. */
  async function testReset() {
    const acc = active();
    if (!acc || acc.user.role !== 'ADMIN') return;
    if (!confirm('Delete YOUR OWN marks for today (server + this phone) so you can mark again? ' +
      'Only works for admin accounts.')) return;
    try {
      const res = await Api.post({ action: 'testReset', token: acc.token });
      if (!res.ok) { alert('Failed: ' + res.code); return; }
      const t = todayCompact();
      for (const store of ['queue', 'history']) {
        for (const type of ['IN', 'OUT']) {
          await DB.del(store, activeUid + '_' + t + '_' + type);
        }
      }
      alert('Cleared ' + res.removed + ' server record(s). You can mark IN again.');
      await goHome();
    } catch (e) {
      alert('Needs internet.');
    }
  }

  // ---------- leave ----------
  async function showLeave() {
    if (!navigator.onLine && !window.APP_CONFIG.DEMO) {
      alert('Leave application needs internet. Marks work offline, leave requests do not.');
      return;
    }
    $('leave-msg').textContent = '';
    show('screen-leave');
    await renderMyLeaves();
  }

  async function renderMyLeaves() {
    const list = $('leave-list');
    try {
      const res = await Api.post({ action: 'myLeaves', token: active().token });
      if (!res.ok) { list.innerHTML = '<li>Could not load (' + res.code + ').</li>'; return; }
      if (!res.leaves.length) { list.innerHTML = '<li>No leave applications yet.</li>'; return; }
      list.innerHTML = '';
      res.leaves.forEach(l => {
        const li = document.createElement('li');
        li.innerHTML = '<span class="tag">' + l.type + '</span><span>' +
          l.from + (l.to !== l.from ? ' → ' + l.to : '') + '</span>' +
          '<span class="' + (l.status === 'APPROVED' ? 'sync' : l.status === 'REJECTED' ? 'pend' : '') + '">' +
          l.status + '</span>';
        list.appendChild(li);
      });
    } catch (e) {
      list.innerHTML = '<li>No connection.</li>';
    }
  }

  async function submitLeave() {
    const msg = $('leave-msg');
    msg.textContent = '';
    const from = $('lv-from').value, to = $('lv-to').value || $('lv-from').value;
    if (!from) { msg.textContent = 'Pick the from-date.'; return; }
    $('btn-leave-submit').disabled = true;
    try {
      const res = await Api.post({
        action: 'leaveApply', token: active().token,
        from: from, to: to, type: $('lv-type').value, reason: $('lv-reason').value.trim()
      });
      if (res.ok) {
        msg.textContent = res.status === 'APPROVED'
          ? 'Leave recorded and approved.' : 'Leave submitted for approval.';
        $('lv-from').value = ''; $('lv-to').value = ''; $('lv-reason').value = '';
        await renderMyLeaves();
      } else {
        msg.textContent = {
          FROM_AFTER_TO: 'From-date is after to-date.',
          TOO_LONG: 'Maximum 31 days per application.',
          TOO_OLD: 'That period is too far in the past.',
          OVERLAPS_EXISTING: 'You already have a leave covering those dates.',
          BAD_DATE: 'Pick valid dates.'
        }[res.code] || ('Failed (' + res.code + ').');
      }
    } catch (e) {
      msg.textContent = 'No connection — try again with internet.';
    } finally {
      $('btn-leave-submit').disabled = false;
    }
  }

  /** DEMO only: wipe everything on this device and start over. */
  async function demoReset() {
    if (!window.APP_CONFIG.DEMO) return;
    if (!confirm('Delete ALL demo data on this device (accounts, marks, queue) and start fresh?')) return;
    accounts = {};
    activeUid = null;
    await Promise.all([
      DB.kvDel('accounts'), DB.kvDel('activeUid'), DB.kvDel('lastSync')
    ]);
    const wipe = store => DB.all(store).then(rows =>
      Promise.all(rows.map(r => DB.del(store, r.key))));
    await Promise.all([wipe('queue'), wipe('history')]);
    location.reload();
  }

  // ---------- login ----------
  function resetLogin() {
    loginSel = null;
    $('whoami-block').hidden = true;
    $('whoami-list').innerHTML = '';
    $('newpin-block').hidden = true;
    $('pin-block').hidden = false;
    $('in-pin').value = '';
    $('in-newpin').value = '';
    $('in-newpin2').value = '';
    $('login-msg').textContent = '';
  }

  function renderWhoami(users) {
    const list = $('whoami-list');
    list.innerHTML = '';
    users.forEach(u => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'whoami-btn' + (loginSel === u.id ? ' sel' : '');
      b.innerHTML = '<b>' + u.name + '</b><span>' +
        (u.cadre === 'AWT' ? 'Teacher (AWT)' : u.cadre === 'AWH' ? 'Helper (AWH)' : u.cadre) + '</span>';
      b.onclick = () => {
        loginSel = u.id;
        renderWhoami(users);
        $('login-msg').textContent = '';
      };
      list.appendChild(b);
    });
    $('whoami-block').hidden = false;
  }

  async function doLogin() {
    const phone = $('in-phone').value.trim();
    const pin = $('in-pin').value.trim();
    const newPinShown = !$('newpin-block').hidden;
    const msg = $('login-msg');
    msg.textContent = '';

    if (!/^\d{10}$/.test(phone)) { msg.textContent = 'Enter your 10-digit mobile number.'; return; }

    const body = { action: 'login', phone: phone, deviceId: await deviceId() };
    if (loginSel) body.userId = loginSel;
    if (newPinShown) {
      const p1 = $('in-newpin').value.trim(), p2 = $('in-newpin2').value.trim();
      if (!/^\d{4}$/.test(p1)) { msg.textContent = 'PIN must be exactly 4 digits.'; return; }
      if (p1 !== p2) { msg.textContent = 'The two PINs do not match.'; return; }
      body.newPin = p1;
    } else if (pin) {
      if (!/^\d{4}$/.test(pin)) { msg.textContent = 'PIN must be exactly 4 digits.'; return; }
      body.pin = pin;
    }
    // No PIN typed? Submit anyway — only the server knows whether this account
    // is on first login (SET_PIN_REQUIRED), shared (CHOOSE_USER) or needs its
    // PIN (PIN_REQUIRED). Demanding a PIN first deadlocks brand-new users.

    $('btn-login').disabled = true;
    try {
      const res = await Api.post(body);
      if (res.ok) {
        const uid = res.config.user.id;
        accounts[uid] = { token: res.token, user: res.config.user, config: res.config };
        activeUid = uid;
        await saveAccounts();
        resetLogin();
        await goHome();
        Sync.schedule('login');
        return;
      }
      const texts = {
        NO_USER: 'This number is not registered. Contact the district office.',
        INACTIVE: 'This account is deactivated. Contact the district office.',
        PIN_REQUIRED: 'Enter your 4-digit PIN.',
        WRONG_PIN: 'Wrong PIN.' + (res.left ? ' Attempts left: ' + res.left : ''),
        LOCKED: 'Too many wrong attempts. Try again after 15 minutes.',
        DEVICE_MISMATCH: 'This account is active on another phone. Ask the district office to approve this phone.',
        RATE_LIMIT: 'Too many attempts. Please wait an hour.',
        BAD_PIN_FORMAT: 'PIN must be exactly 4 digits.'
      };
      if (res.code === 'CHOOSE_USER') {
        renderWhoami(res.users || []);
        msg.textContent = 'Tap your name above, then press LOGIN.';
      } else if (res.code === 'SET_PIN_REQUIRED') {
        if (res.userId) loginSel = res.userId;
        $('newpin-block').hidden = false;
        $('pin-block').hidden = true;
        msg.textContent = 'First login: choose your PIN below.';
      } else {
        msg.textContent = texts[res.code] || ('Login failed (' + res.code + ').');
      }
    } catch (e) {
      msg.textContent = 'No connection. Login needs internet the first time.';
    } finally {
      $('btn-login').disabled = false;
    }
  }

  async function doLogout() {
    const acc = active();
    if (!acc) return;
    const mine = (await DB.all('queue')).filter(r => String(r.key).split('_')[0] === activeUid);
    if (mine.length > 0 &&
      !confirm(mine.length + ' record(s) of ' + acc.user.name +
        ' not yet sent. They stay saved on this phone. Logout anyway?')) return;
    try { await Api.post({ action: 'logout', token: acc.token }); } catch (e) { /* offline logout ok */ }
    delete accounts[activeUid];
    activeUid = Object.keys(accounts)[0] || null;
    await saveAccounts();
    if (active()) await goHome();
    else { resetLogin(); show('screen-login'); }
  }

  /**
   * A token stopped working for ONE account. Other accounts on this phone and
   * everything in the queue stay untouched — their marks sync as usual.
   */
  async function onAuthLost(uid, code) {
    delete accounts[uid];
    if (activeUid === uid) activeUid = Object.keys(accounts)[0] || null;
    await saveAccounts();
    if (active()) { await goHome(); return; }
    resetLogin();
    $('login-msg').textContent = code === 'DEVICE_MISMATCH'
      ? 'This account moved to another phone. Ask the district office if this is wrong.'
      : 'Session expired — please login again. Your saved records are safe.';
    show('screen-login');
  }

  // ---------- home ----------
  async function goHome() {
    const acc = active();
    show('screen-home');
    $('home-name').textContent = acc.user.name +
      (acc.user.cadre === 'AWT' ? ' — Teacher' : acc.user.cadre === 'AWH' ? ' — Helper' : '');
    $('home-awc').textContent = acc.user.awcName || '';
    $('home-date').textContent = new Date().toDateString();
    $('btn-users').hidden = false;
    const next = await nextAction();
    if (next) {
      $('btn-mark').hidden = false;
      $('mark-done').hidden = true;
      $('btn-mark').textContent = next;
      $('btn-mark').classList.toggle('out', next === 'OUT');
    } else {
      $('btn-mark').hidden = true;
      $('mark-done').hidden = false;
    }
    await renderHomeExtras(acc);
    renderStatus();
  }

  // ---------- home extras: clock, today's times, stats, 7-day trend ----------
  function fmtDate(d) {
    const p = n => String(n).padStart(2, '0');
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  }

  /** date(yyyymmdd) -> {IN:'HH:MM', OUT:'HH:MM'} for the active user, local stores only. */
  async function myMarkMap() {
    const map = {};
    (await DB.all('queue')).concat(await DB.all('history')).forEach(r => {
      const p = String(r.key).split('_');
      if (p[0] !== activeUid) return;
      (map[p[1]] = map[p[1]] || {})[p[2]] = String(r.clientTs || '').slice(11, 16);
    });
    return map;
  }

  function updateClock() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    $('home-clock').textContent = p(d.getHours()) + ':' + p(d.getMinutes());
  }

  async function renderHomeExtras(acc) {
    updateClock();
    const name = acc.user.name || '';
    $('home-avatar').textContent =
      name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '–';
    const h = new Date().getHours();
    $('home-greet').textContent = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';

    const map = await myMarkMap();
    const today = map[todayCompact()] || {};
    $('tt-in').textContent = today.IN || '–';
    $('tt-out').textContent = today.OUT || '–';
    let hrs = '–';
    if (today.IN && today.OUT) {
      const m = (Number(today.OUT.slice(0, 2)) * 60 + Number(today.OUT.slice(3))) -
        (Number(today.IN.slice(0, 2)) * 60 + Number(today.IN.slice(3)));
      if (m > 0) hrs = Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
    }
    $('tt-hrs').textContent = hrs;

    // 7-day strip, today rightmost. Sundays shown neutral; a day with no mark
    // is shown as '–' (could be leave/holiday — that data lives server-side).
    const strip = $('week-strip');
    strip.innerHTML = '';
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const m = map[fmtDate(d)] || {};
      let cls = 'none', sym = '–';
      if (d.getDay() === 0) { cls = 'sun'; sym = 'S'; }
      else if (m.IN && m.OUT) { cls = 'full'; sym = '✓'; }
      else if (m.IN) { cls = 'half'; sym = 'IN'; }
      const cell = document.createElement('div');
      cell.className = 'wd';
      cell.innerHTML = 'SMTWTFS'[d.getDay()] + '<i class="' + cls + '">' + sym + '</i>';
      strip.appendChild(cell);
    }

    const monthPrefix = todayCompact().slice(0, 6);
    $('stat-month').textContent =
      Object.keys(map).filter(k => k.startsWith(monthPrefix) && map[k].IN).length;

    let streak = 0;
    for (let i = 0; i < 60; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      if (d.getDay() === 0) continue;              // Sundays never break a streak
      const m = map[fmtDate(d)];
      if (m && m.IN) streak++;
      else if (i === 0) continue;                  // today may simply not be marked yet
      else break;
    }
    $('stat-streak').textContent = streak;

    const ins = [];
    for (let i = 0; i < 7; i++) {
      const m = map[fmtDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i))];
      if (m && m.IN) ins.push(Number(m.IN.slice(0, 2)) * 60 + Number(m.IN.slice(3)));
    }
    if (ins.length) {
      const avg = Math.round(ins.reduce((a, b) => a + b, 0) / ins.length);
      const p = n => String(n).padStart(2, '0');
      $('stat-avgin').textContent = p(Math.floor(avg / 60)) + ':' + p(avg % 60);
    } else {
      $('stat-avgin').textContent = '–';
    }

    renderReminder(acc, today);
  }

  /** In-app reminder banner + one-tap opt-in to background notifications. */
  function renderReminder(acc, today) {
    const txt = $('remind-text'), btn = $('btn-notif');
    const sch = (acc.config && acc.config.schedule) || {};
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const nowHM = p(d.getHours()) + ':' + p(d.getMinutes());
    let msg = '';
    if (d.getDay() !== 0) {
      if (!today.IN && nowHM >= (sch.late_after || '09:30')) {
        msg = '⏰ You have not marked IN yet today.';
      } else if (today.IN && !today.OUT && nowHM >= (sch.out_end || '17:30')) {
        msg = '⏰ Remember to mark OUT before leaving.';
      }
    }
    const canAsk = ('Notification' in window) && Notification.permission === 'default';
    btn.hidden = !canAsk;
    txt.textContent = msg || (canAsk ? 'Get a reminder if you forget to mark IN or OUT.' : '');
    $('remind-banner').hidden = !txt.textContent;
  }

  async function enableReminders() {
    try {
      const perm = await Notification.requestPermission();
      if (perm === 'granted') await registerPeriodicReminder();
    } catch (e) { /* older browser: the in-app banner still reminds */ }
    const acc = active();
    if (acc) await renderHomeExtras(acc);
  }

  /**
   * Background reminders use Periodic Background Sync (Chrome, installed PWA).
   * The browser decides actual firing times — best-effort by design; the
   * in-app banner is the guaranteed path. No push service involved (₹0).
   */
  async function registerPeriodicReminder() {
    try {
      const reg = await navigator.serviceWorker.ready;
      if ('periodicSync' in reg) {
        await reg.periodicSync.register('attendance-reminder', { minInterval: 60 * 60 * 1000 });
      }
    } catch (e) { /* unsupported browser: fine */ }
  }

  async function nextAction() {
    const t = todayCompact();
    const have = { IN: false, OUT: false };
    (await DB.all('queue')).concat(await DB.all('history')).forEach(r => {
      const p = String(r.key).split('_');
      if (p[0] === activeUid && p[1] === t) have[p[2]] = true;
    });
    if (!have.IN) return 'IN';
    if (!have.OUT) return 'OUT';
    return null;
  }

  async function renderStatus() {
    if (!active()) return;
    $('offline-banner').hidden = navigator.onLine;
    $('st-net').innerHTML = navigator.onLine ? '<b>Online</b>connection' : '<b>Offline</b>saved on phone';
    const pending = await DB.count('queue');
    const p = $('st-pending');
    p.innerHTML = '<b>' + pending + '</b>' + (Sync.isSyncing() ? 'sending…' : 'waiting to send');
    p.classList.toggle('warn', pending > 0);
    const last = await DB.kvGet('lastSync');
    $('st-lastsync').innerHTML = '<b>' + (last ? timeAgo(last) : '–') + '</b>last sync';
  }

  function timeAgo(ms) {
    const m = Math.floor((Date.now() - ms) / 60000);
    if (m < 1) return 'now';
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    return h < 24 ? h + 'h ago' : Math.floor(h / 24) + 'd ago';
  }

  // ---------- switch user ----------
  async function showUsers() {
    const list = $('users-list');
    list.innerHTML = '';
    const queue = await DB.all('queue');
    Object.keys(accounts).forEach(uid => {
      const u = accounts[uid].user;
      const pend = queue.filter(r => String(r.key).split('_')[0] === uid).length;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'whoami-btn' + (uid === activeUid ? ' sel' : '');
      b.innerHTML = '<b>' + u.name + '</b><span>' +
        (u.cadre === 'AWT' ? 'Teacher (AWT)' : u.cadre === 'AWH' ? 'Helper (AWH)' : u.cadre) +
        (pend ? ' — ' + pend + ' waiting' : '') + '</span>';
      b.onclick = async () => {
        activeUid = uid;
        await saveAccounts();
        await goHome();
      };
      list.appendChild(b);
    });
    show('screen-users');
  }

  // ---------- marking ----------
  async function startMark() {
    if (!active()) { resetLogin(); show('screen-login'); return; }
    markType = await nextAction();
    if (!markType) return;
    $('cam-title').textContent = markType === 'IN' ? 'IN — take your photo' : 'OUT — take your photo';
    $('cam-msg').textContent = '';
    show('screen-camera');

    geoResult = null;
    const gpsLine = $('cam-gps');
    gpsLine.textContent = 'Getting GPS…';
    gpsLine.className = 'gps-line';
    geoPromise = Geo.capture(12000).then(g => {
      geoResult = g;
      if (g) {
        gpsLine.textContent = 'GPS OK (±' + Math.round(g.accuracy) + ' m)';
        gpsLine.className = 'gps-line ok';
      } else {
        gpsLine.textContent = 'GPS not available — attendance will still be saved';
        gpsLine.className = 'gps-line bad';
      }
      return g;
    });

    try {
      await Camera.start($('cam-video'));
    } catch (e) {
      // Never block the mark: allow capture without photo, server flags NO_PHOTO.
      $('cam-msg').textContent = 'Camera not available — you can still mark attendance.';
    }
  }

  async function doCapture() {
    const acc = active();
    if (!acc) { Camera.stop(); resetLogin(); show('screen-login'); return; }
    $('btn-capture').disabled = true;
    try {
      const clientTs = localIso();
      const g = geoResult || (await Promise.race([geoPromise, new Promise(r => setTimeout(() => r(null), 1500))]));
      let photoBlob = null;
      const video = $('cam-video');
      if (video.srcObject && video.videoWidth > 0) {
        // Burnt-in stamp reads like a register entry: place name (own AWC,
        // else nearest known centre) and the person's name — never raw
        // coordinates. Coordinates still travel inside the record.
        const stamp = [
          clientTs.slice(0, 16).replace('T', ' '),
          placeLine(g, acc.config),
          acc.user.name.slice(0, 28) + ' — ' + markType
        ];
        photoBlob = await Camera.capture(video, stamp, (acc.config && acc.config.photoMaxKB) || 60);
      }
      Camera.stop();

      const record = {
        key: acc.user.id + '_' + todayCompact() + '_' + markType,
        type: markType,
        clientTs: clientTs,
        lat: g ? Number(g.lat.toFixed(6)) : '',
        lng: g ? Number(g.lng.toFixed(6)) : '',
        accuracy: g ? Math.round(g.accuracy) : '',
        netState: navigator.onLine ? 'ONLINE' : 'OFFLINE',
        photoBlob: photoBlob
      };
      await Sync.enqueue(record);

      $('success-text').textContent = markType + ' attendance saved';
      $('success-sub').textContent = navigator.onLine
        ? 'Sending to server…'
        : 'You are offline — it will be sent automatically when network returns.';
      show('screen-success');
      setTimeout(goHome, 2500);
    } finally {
      $('btn-capture').disabled = false;
    }
  }

  // ---------- history & menu ----------
  async function showHistory() {
    const list = $('history-list');
    list.innerHTML = '';
    const mine = r => String(r.key).split('_')[0] === activeUid;
    const items = (await DB.all('history')).filter(mine).map(r => ({ r: r, synced: true }))
      .concat((await DB.all('queue')).filter(mine).map(r => ({ r: r, synced: false })))
      .sort((a, b) => a.r.key < b.r.key ? 1 : -1)
      .slice(0, 70);
    if (!items.length) list.innerHTML = '<li>No records on this phone yet.</li>';
    items.forEach(it => {
      const p = it.r.key.split('_');
      const li = document.createElement('li');
      li.innerHTML = '<span class="tag">' + p[2] + '</span>' +
        '<span>' + p[1].slice(6) + '-' + p[1].slice(4, 6) + '-' + p[1].slice(0, 4) +
        ' ' + String(it.r.clientTs || '').slice(11, 16) + '</span>' +
        (it.synced ? '<span class="sync">sent ✓</span>' : '<span class="pend">waiting…</span>');
      list.appendChild(li);
    });
    show('screen-history');
  }

  function showMenu() {
    const acc = active();
    $('menu-user').textContent = acc.user.name + ' (' + acc.user.id + ') — ' +
      acc.user.cadre + ', ' + (acc.user.awcName || acc.user.sector);
    $('menu-version').textContent = 'App version ' + window.APP_CONFIG.VERSION +
      (window.APP_CONFIG.DEMO ? ' — DEMO MODE (no server)' : '');
    $('btn-demo-reset').hidden = !window.APP_CONFIG.DEMO;
    $('btn-test-reset').hidden = acc.user.role !== 'ADMIN';
    show('screen-menu');
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    renderStatus: renderStatus,
    onAuthLost: onAuthLost,
    get accounts() { return accounts; },
    get activeConfig() { const a = active(); return a ? a.config : null; }
  };
})();
