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
    'screen-success', 'screen-history', 'screen-menu', 'screen-leave', 'screen-dash',
    'screen-report', 'screen-welcome'];

  let accounts = {};    // uid -> { token, user, config }
  let activeUid = null;
  let places = [];      // district gazetteer: every AWC's name + coords
  let loginSel = null;  // userId chosen in the who-am-I picker
  let geoPromise = null;
  let geoResult = null;
  let markType = null;
  let camMode = 'mark';                 // 'mark' | 'rpt-child'|'rpt-preg'|'rpt-others'|'rpt-meal'
  let rptPhotos = { child: null, preg: null, others: null, meal: null, geo: null };
  let rptCamFail = {}; // kinds the camera could not photograph (broken/denied)

  const active = () => (activeUid && accounts[activeUid]) || null;

  /** Busy state for slow actions: disables the button, swaps its label and
   *  shows a spinner — Apps Script calls can take several seconds cold. */
  function setBusy(id, on, label) {
    const b = $(id);
    if (on) {
      b.dataset.txt = b.textContent;
      if (label) b.textContent = label;
      b.classList.add('busy');
      b.disabled = true;
    } else {
      if (b.dataset.txt) b.textContent = b.dataset.txt;
      b.classList.remove('busy');
      b.disabled = false;
    }
  }

  const NAV_MAP = {
    'screen-home': 'nav-home', 'screen-report': 'nav-report',
    'screen-history': 'nav-history', 'screen-users': 'nav-users',
    'screen-dash': 'nav-dash', 'screen-menu': 'nav-menu'
  };

  function show(id) {
    screens.forEach(s => { $(s).hidden = (s !== id); });
    $('btn-menu').hidden = (id === 'screen-login');
    // Bottom nav: hidden on login/welcome and during full-attention flows
    // (camera, success); Report is the Teacher's duty, Stats is admin-only.
    const acc = active();
    const nav = $('bottom-nav');
    nav.hidden = !acc ||
      ['screen-login', 'screen-welcome', 'screen-camera', 'screen-success'].indexOf(id) >= 0;
    if (!nav.hidden) {
      $('nav-report').hidden = ['AWT', 'AWH'].indexOf(acc.user.cadre) < 0;
      $('nav-dash').hidden = acc.user.role !== 'ADMIN' && acc.user.role !== 'SUPERVISOR';
      Object.keys(NAV_MAP).forEach(s => $(NAV_MAP[s]).classList.toggle('sel', s === id));
    }
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
    // Ask Android to protect our storage (queue, logins) from the storage
    // cleaners common on government devices. Retried every boot: the grant
    // often only comes once the app is installed and used a few times.
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persisted()
        .then(p => { if (!p) return navigator.storage.persist(); })
        .catch(() => {});
    }
    window.addEventListener('online', renderStatus);
    window.addEventListener('offline', renderStatus);
    buildStockTable();
    bindEvents();
    setInterval(() => { if (!$('screen-home').hidden) updateClock(); }, 20000);
    // While the app is open, nudge the SW every 15 min — reminderCheck's own
    // 2-hour throttle decides whether a notification actually fires.
    setInterval(() => {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'reminder-check' });
      }
    }, 15 * 60 * 1000);

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
      pingAppMode(); // fire-and-forget daily installed-vs-browser telemetry
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
    $('btn-cam-cancel').onclick = () => {
      Camera.stop();
      if (camMode === 'mark') goHome(); else openReport();
    };
    $('btn-cam-flip').onclick = async () => {
      try {
        await Camera.flip($('cam-video'));
        $('cam-video').classList.toggle('rear', Camera.facing() !== 'user');
      } catch (e) {
        $('cam-msg').textContent = 'Could not switch camera on this phone.';
      }
    };
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
    $('lv-type').onchange = () => {
      const opt = $('lv-type').value === 'OPTIONAL';
      $('lv-dates').hidden = opt;
      $('lv-opt-block').hidden = !opt;
    };
    $('btn-test-reset').onclick = testReset;
    $('btn-refresh-app').onclick = refreshApp;
    $('btn-notif').onclick = enableReminders;
    $('btn-dash').onclick = () => { show('screen-dash'); renderDash(); };
    $('btn-dash-refresh').onclick = renderDash;
    $('btn-dash-back').onclick = goHome;
    $('report-chip').onclick = openReport;
    $('btn-rp-back').onclick = goHome;
    $('nav-home').onclick = goHome;
    $('nav-report').onclick = openReport;
    $('nav-history').onclick = showHistory;
    $('nav-users').onclick = showUsers;
    $('nav-dash').onclick = () => { show('screen-dash'); renderDash(); };
    $('nav-menu').onclick = showMenu;
    $('btn-install').onclick = async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      $('btn-install').hidden = true;
    };
    $('btn-rp-photo-child').onclick = () => openRptCamera('child');
    $('btn-rp-photo-preg').onclick = () => openRptCamera('preg');
    $('btn-rp-photo-others').onclick = () => openRptCamera('others');
    $('btn-rp-photo-meal').onclick = () => openRptCamera('meal');
    $('btn-rp-submit').onclick = submitReport;
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
      renderLeaveBal(res.balances);
      fillOptDays(res.optionalDays);
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

  /** Balance chips above the form: CL, EL, optional left + medical used. */
  function renderLeaveBal(b) {
    const box = $('lv-bal');
    if (!b) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML =
      '<span class="bal-chip">Casual <b>' + b.casual.left + '</b> of ' + b.casual.ent + ' left</span>' +
      '<span class="bal-chip">Earned <b>' + b.earned.left + '</b> of ' + b.earned.ent + ' left</span>' +
      (b.optional ? '<span class="bal-chip">Optional <b>' + b.optional.left + '</b> of ' +
        b.optional.ent + ' left</span>' : '') +
      '<span class="bal-chip">Medical <b>' + b.medical.used + '</b> used</span>';
  }

  /** Optional-holiday picker: only listed dates, recent past ≤31 d + future. */
  function fillOptDays(days) {
    const sel = $('lv-opt');
    const cutoff = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
    const opts = (days || []).filter(o => o.d >= cutoff);
    sel.innerHTML = '<option value="">— choose the occasion —</option>' +
      opts.map(o => '<option value="' + o.d + '">' +
        o.d.slice(8, 10) + '-' + o.d.slice(5, 7) + ' · ' + o.n + '</option>').join('');
  }

  async function submitLeave() {
    const msg = $('leave-msg');
    msg.textContent = '';
    const type = $('lv-type').value;
    let from, to;
    if (type === 'OPTIONAL') {
      from = to = $('lv-opt').value;
      if (!from) { msg.textContent = 'Choose the occasion from the list.'; return; }
    } else {
      from = $('lv-from').value;
      to = $('lv-to').value || $('lv-from').value;
      if (!from) { msg.textContent = 'Pick the from-date.'; return; }
    }
    $('btn-leave-submit').disabled = true;
    try {
      const res = await Api.post({
        action: 'leaveApply', token: active().token,
        from: from, to: to, type: type, reason: $('lv-reason').value.trim()
      });
      if (res.ok) {
        msg.textContent = res.status === 'APPROVED'
          ? 'Leave recorded and approved.'
          : 'Sent to the Collector for approval — you will see the decision here.';
        $('lv-from').value = ''; $('lv-to').value = ''; $('lv-reason').value = '';
        renderLeaveBal(res.balances);
        await renderMyLeaves();
      } else {
        msg.textContent = res.code === 'NO_BALANCE'
          ? 'Not enough ' + (res.type === 'CASUAL' ? 'casual leave'
              : res.type === 'OPTIONAL' ? 'optional holiday' : 'earned leave') +
            ' balance — only ' + res.left + ' day(s) left this year.'
          : {
            FROM_AFTER_TO: 'From-date is after to-date.',
            TOO_LONG: 'Maximum 31 days per application.',
            TOO_OLD: 'That period is too far in the past.',
            OVERLAPS_EXISTING: 'You already have a leave covering those dates.',
            OPT_SINGLE_DAY: 'Optional holiday is one single day.',
            BAD_OPT_DATE: 'That date is not on the optional-holiday list.',
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
    $('pin-block').hidden = true; // shown only when the server asks for a PIN
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
        // Re-selecting a name resets the PIN blocks: the server will say on
        // the next LOGIN tap whether this person enters or sets a PIN.
        $('newpin-block').hidden = true;
        $('pin-block').hidden = true;
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

    setBusy('btn-login', true, 'Checking… please wait');
    try {
      const res = await Api.post(body);
      if (res.ok) {
        // The one-AWT-plus-one-AWH-per-phone policy is enforced SERVER-side
        // (DEVICE_FULL / DEVICE_CADRE below), before any device binding — a
        // client-side refusal here would come after the server had already
        // bound the account to this phone, stranding it.
        const uid = res.config.user.id;
        accounts[uid] = { token: res.token, user: res.config.user, config: res.config };
        activeUid = uid;
        await saveAccounts();
        resetLogin();
        await primePermissions();
        showWelcome(res.config.user);
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
        DEVICE_FULL: 'This phone already has its two users (AWT + AWH). Use your own phone, or ask the district office.',
        DEVICE_CADRE: 'Only one Teacher and one Helper can use each phone. Use your own phone, or ask the district office.',
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
        if (['PIN_REQUIRED', 'WRONG_PIN', 'LOCKED'].indexOf(res.code) >= 0) {
          $('pin-block').hidden = false;
          $('newpin-block').hidden = true;
          $('in-pin').focus();
        }
        msg.textContent = texts[res.code] || ('Login failed (' + res.code + ').');
      }
    } catch (e) {
      msg.textContent = 'No connection. Login needs internet the first time.';
    } finally {
      setBusy('btn-login', false);
    }
  }

  // One-tap install: after a QR scan opens this page, Chrome fires
  // beforeinstallprompt when installable — we surface a big Install button
  // instead of making the user hunt the ⋮ menu. (A silent install from a QR
  // scan is not possible on Android; one confirmation tap is the minimum.)
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    installPrompt = e;
    $('btn-install').hidden = false;
  });
  window.addEventListener('appinstalled', () => { $('btn-install').hidden = true; });

  /** 10-second landing after login (photo + one line); tap skips straight home. */
  let welcomeTimer = null;
  function showWelcome(user) {
    $('welcome-greet').textContent = 'Welcome, ' + (String(user.name || '').split(/\s+/)[0] || 'friend');
    show('screen-welcome');
    clearTimeout(welcomeTimer);
    const done = () => { clearTimeout(welcomeTimer); goHome(); };
    welcomeTimer = setTimeout(done, 10000);
    $('screen-welcome').onclick = done;
  }

  /**
   * Ask for camera + location up front, right after the first login on this
   * device, so the first real attendance mark is never interrupted by
   * permission popups. One-time; denial never blocks anything — the marking
   * flow already degrades gracefully (NO_PHOTO / GPS UNVERIFIED).
   */
  /** 'APP' when running installed (WebAPK/TWA standalone), 'BROWSER' in a tab. */
  function displayMode() {
    const standalone = (window.matchMedia &&
      matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone;
    return standalone ? 'APP' : 'BROWSER';
  }

  /** Once a day, tell the server how this device runs the app. */
  async function pingAppMode() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      if (!navigator.onLine || !active()) return;
      if (await DB.kvGet('modePing') === today) return;
      const build = ((document.querySelector('.build-tag') || {}).textContent || '')
        .replace('BUILD:', '').trim();
      const r = await Api.post({ action: 'appMode', token: active().token,
        dm: displayMode(), v: build });
      if (r.ok) await DB.kvSet('modePing', today);
    } catch (e) { /* telemetry only — retry tomorrow */ }
  }

  async function primePermissions() {
    if (await DB.kvGet('permsPrimed')) return;
    await DB.kvSet('permsPrimed', 1);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      s.getTracks().forEach(t => t.stop());
    } catch (e) { /* denied or no camera: fine */ }
    try {
      await new Promise(res => navigator.geolocation.getCurrentPosition(
        () => res(), () => res(), { timeout: 8000, maximumAge: 60000 }));
    } catch (e) { /* no geolocation API: fine */ }
    // Reminders are on by default: ask right after camera/location so the
    // whole permission set arrives in one first-login flow. The banner
    // button remains as the retry path if this gets dismissed.
    try {
      if ('Notification' in window && Notification.permission === 'default') {
        const perm = await Notification.requestPermission();
        if (perm === 'granted') await registerPeriodicReminder();
      }
    } catch (e) { /* older browser: banner still reminds */ }
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
    const wasActive = activeUid === uid;
    delete accounts[uid];
    if (wasActive) activeUid = Object.keys(accounts)[0] || null;
    await saveAccounts();
    if (!wasActive) { renderStatus(); return; } // background account: never yank the UI
    Camera.stop(); // may have been mid-capture; don't leave the stream running
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
    const dashRole = acc.user.role === 'ADMIN' || acc.user.role === 'SUPERVISOR';
    $('btn-dash').hidden = !dashRole;
    $('btn-dash').textContent = acc.user.role === 'SUPERVISOR' ? 'My sector' : 'District dashboard';
    // One store scan feeds both the chip and the reminder banner.
    // AWH also sees the real report state: when the Teacher is absent she may
    // file the centre report herself (server keys reports by AWC, so hers
    // satisfies the AWT OUT-gate and flags identically). Her own OUT stays
    // ungated and she is never nagged about it.
    const rptDone = ['AWT', 'AWH'].indexOf(acc.user.cadre) >= 0 ? await reportDoneToday() : true;
    const chip = $('report-chip');
    if (acc.user.cadre === 'AWT') { // the daily report is the Teacher's duty
      chip.hidden = false;
      chip.classList.toggle('done', rptDone);
      $('report-chip-text').textContent = rptDone
        ? '✓ Daily report submitted' : 'Daily report — fill before OUT';
    } else if (acc.user.cadre === 'AWH') {
      // Fallback duty: surfaces only while the centre report is missing.
      chip.hidden = rptDone;
      chip.classList.remove('done');
      $('report-chip-text').textContent = 'Teacher absent? Fill the centre report';
    } else {
      chip.hidden = true;
    }
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
    await renderHomeExtras(acc, rptDone);
    renderMyIssues(acc); // fire-and-forget: renders when the server answers
    renderStatus();
  }

  /**
   * Issues the supervisor raised ABOUT this worker: shown on home until
   * closed. The worker resolves with a mandatory remark (what was done);
   * the supervisor then confirms the close — full trail kept server-side.
   */
  async function renderMyIssues(acc) {
    const card = $('issues-card');
    if (acc.user.role !== 'FIELD') { card.hidden = true; return; }
    let data = await DB.kvGet('myIssues_' + acc.user.id) || { at: 0, issues: [] };
    if (navigator.onLine) {
      try {
        const res = await Api.post({ action: 'myIssues', token: acc.token });
        if (res.ok) {
          data = { at: Date.now(), issues: res.issues };
          await DB.kvSet('myIssues_' + acc.user.id, data);
        }
      } catch (e) { /* offline: show cached */ }
    }
    if (activeUid !== acc.user.id) return; // user switched while fetching
    const open = data.issues.filter(i => i.status === 'OPEN');
    const resolved = data.issues.filter(i => i.status === 'RESOLVED');
    if (!open.length && !resolved.length) { card.hidden = true; return; }
    card.hidden = false;
    card.innerHTML = '<div class="dash-h">⚠ Issues raised by your supervisor</div>' +
      open.map(i => '<div class="drow"><span class="dr-name">' + escH(CAT_LABEL[i.cat] || i.cat) +
        (i.text ? '<small class="dr-sub">' + escH(i.text) + '</small>' : '') + '</span>' +
        '<button class="resolve-btn" data-id="' + escH(i.id) + '">Mark resolved</button></div>').join('') +
      resolved.map(i => '<div class="drow"><span class="dr-name">' + escH(CAT_LABEL[i.cat] || i.cat) +
        '<small class="dr-sub">Resolved — waiting for your supervisor to confirm</small></span>' +
        '<span class="dr-pct ok">resolved</span></div>').join('');
    card.querySelectorAll('.resolve-btn').forEach(b => {
      b.onclick = async () => {
        const remark = prompt('What did you do to resolve it? (required)');
        if (remark === null) return;
        if (!remark.trim()) { alert('A remark is required.'); return; }
        b.disabled = true;
        try {
          const res = await Api.post({ action: 'resolveIssue', token: acc.token,
            issueId: b.dataset.id, remark: remark.trim() });
          if (res.ok) { alert('Sent to your supervisor for confirmation.'); renderMyIssues(acc); }
          else alert('Could not send (' + res.code + ').');
        } catch (e) {
          alert('Needs internet — try again on network.');
        }
        b.disabled = false;
      };
    });
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

  async function renderHomeExtras(acc, rptDone) {
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

    if (rptDone == null) rptDone = acc.user.cadre === 'AWT' ? await reportDoneToday() : true;
    renderReminder(acc, today, rptDone);
  }

  /** In-app reminder banner (IN / daily report / OUT, most urgent first)
   *  + one-tap opt-in to background notifications. */
  function renderReminder(acc, today, rptDone) {
    const txt = $('remind-text'), btn = $('btn-notif');
    const sch = (acc.config && acc.config.schedule) || {};
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const nowHM = p(d.getHours()) + ':' + p(d.getMinutes());
    let msg = '';
    if (d.getDay() !== 0) {
      if (!today.IN && nowHM >= (sch.late_after || '09:30')) {
        msg = '⏰ You have not marked IN yet today.';
      } else if (acc.user.cadre === 'AWT' && today.IN && !rptDone && nowHM >= '11:00') {
        msg = '📝 Today\'s report is not filled yet — needed before OUT.';
      } else if (today.IN && !today.OUT && nowHM >= '16:30') {
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

  // ---------- admin mobile dashboard ----------
  // Reads the same pre-computed summary JSON the console uses (never the raw
  // sheet): today.json + meta.json each open, org.json names cached 7 days.
  // Published data is pseudonymous (codes, no names/phones), and the button
  // only shows for ADMIN accounts.
  const escH = s => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function dashRow(label, m, e, pc) {
    const cls = pc >= 85 ? 'ok' : pc >= 70 ? 'warn' : 'err';
    return '<div class="drow"><span class="dr-name">' + escH(label) + '</span>' +
      '<span class="dr-nums">' + m + '/' + e + '</span>' +
      '<span class="dr-pct ' + cls + '">' + pc + '%</span></div>';
  }

  function dashStale(stale, meta, today) {
    const dataMin = Math.round((Date.now() - new Date(today.generatedAt).getTime()) / 60000);
    const aliveMin = (meta && meta.checkedAt)
      ? Math.round((Date.now() - new Date(meta.checkedAt).getTime()) / 60000) : dataMin;
    stale.className = 'dash-stale ' + (aliveMin <= 40 ? 'ok' : aliveMin <= 90 ? 'warn' : 'err');
    stale.textContent = (aliveMin <= 40 ? '✓ SYSTEM LIVE' : aliveMin <= 90 ? '⚠ UPDATES DELAYED' : '✖ NOT UPDATING') +
      ' · DATA ' + (dataMin < 1 ? 'JUST NOW' : dataMin + ' MIN AGO');
  }

  const dashTile = (v, k, cls) =>
    '<div class="dtile ' + (cls || '') + '"><b>' + v + '</b><span>' + k + '</span></div>';

  // Issue categories a supervisor files against a worker (district list).
  const ISSUE_CATLIST = [
    ['NO_REPORT', 'No report'],
    ['INCOMPLETE_REPORT', 'Incomplete report'],
    ['QTY_ANOMALY', 'Quantity anomaly (stock)'],
    ['NOT_PRESENT', 'Not present'],
    ['LATE', 'Not logged on time'],
    ['OTHER', 'Other issue…']
  ];
  const CAT_LABEL = {};
  ISSUE_CATLIST.forEach(c => { CAT_LABEL[c[0]] = c[1]; });

  /** Bottom sheet: pick a category, optional detail (required for Other). */
  function openIssueSheet(acc, uid, name, onDone) {
    const bd = document.createElement('div');
    bd.className = 'sheet-backdrop';
    bd.innerHTML = '<div class="issue-sheet"><h3>🚩 Flag issue — ' + escH(name) + '</h3>' +
      ISSUE_CATLIST.map(c =>
        '<button class="btn btn-plain cat-btn" data-cat="' + c[0] + '">' + c[1] + '</button>').join('') +
      '<button class="btn btn-plain cat-cancel">Cancel</button></div>';
    document.body.appendChild(bd);
    bd.querySelector('.cat-cancel').onclick = () => bd.remove();
    bd.onclick = e => { if (e.target === bd) bd.remove(); };
    bd.querySelectorAll('.cat-btn').forEach(cb => {
      cb.onclick = async () => {
        const cat = cb.dataset.cat;
        const text = prompt(cat === 'OTHER'
          ? 'Describe the issue (required):' : 'Add details (optional):');
        if (text === null) return;                      // cancelled
        if (cat === 'OTHER' && !text.trim()) return;
        bd.remove();
        try {
          const res = await Api.post({ action: 'raiseIssue', token: acc.token,
            aboutUid: uid, category: cat, text: text.trim() });
          alert(res.ok
            ? 'Issue flagged — it stays open until you close it with a remark.'
            : 'Could not flag (' + res.code + ').');
          if (res.ok && onDone) onDone();
        } catch (e) {
          alert('Needs internet — try again on network.');
        }
      };
    });
  }

  /**
   * Supervisor's in-app sector view (district decision 2026-08-18: supervisors
   * have NO console — this is their whole window): people-status counts for
   * their sector(s), a 🚩 to flag a categorised issue about any worker, and
   * the open-issues register with close-with-remark.
   */
  async function renderSectorDash(acc) {
    const el = $('dash-content'), stale = $('dash-stale');
    $('dash-title').textContent = 'My Sector';
    el.innerHTML = '<p class="info">Loading your sector&hellip;</p>';
    stale.textContent = '';
    stale.className = 'dash-stale';

    let meta = null, today = null;
    try {
      const t = Date.now();
      [meta, today] = await Promise.all([
        fetch('../summary/meta.json?t=' + t).then(r => r.ok ? r.json() : null),
        fetch('../summary/today.json?t=' + t).then(r => r.ok ? r.json() : null)
      ]);
    } catch (e) { /* offline */ }
    if (!today || !today.users) {
      el.innerHTML = '<p class="info">Could not load — the sector view needs internet.</p>';
      return;
    }

    let nm = await DB.kvGet('nm_' + acc.user.id);
    if (!nm || Date.now() - nm.at > 6 * 3600000) {
      try {
        const res = await Api.post({ action: 'nameMap', token: acc.token });
        if (res.ok) {
          nm = { at: Date.now(), users: res.users, awcs: res.awcs };
          await DB.kvSet('nm_' + acc.user.id, nm);
        }
      } catch (e) { /* keep cached copy if any */ }
    }
    if (!nm) {
      el.innerHTML = '<p class="info">Could not load names — needs internet once.</p>';
      return;
    }
    dashStale(stale, meta, today);

    let issues = [];
    try {
      const ir = await Api.post({ action: 'listIssues', token: acc.token });
      if (ir.ok) issues = ir.issues;
    } catch (e) { /* offline: counts still render */ }

    const stMap = {};
    (today.users || []).forEach(e => { stMap[e.id] = e; });
    const people = Object.keys(nm.users)
      .filter(id => nm.users[id].r === 'FIELD' && nm.users[id].s === 'ACTIVE')
      .map(id => ({
        id: id, n: nm.users[id].n,
        awc: (nm.awcs[nm.users[id].a] || {}).n || nm.users[id].a || '',
        e: stMap[id] || { st: 'NOT_MARKED', in: null, gf: null }
      }))
      .sort((a, b) => a.awc.localeCompare(b.awc));

    const c = { P: 0, L: 0, N: 0, V: 0 };
    people.forEach(p => {
      if (p.e.st === 'PRESENT') c.P++;
      else if (p.e.st === 'LATE') c.L++;
      else if (p.e.st === 'ON_LEAVE') c.V++;
      else c.N++;
    });

    let html = '<div class="dash-grid">' +
      dashTile(people.length, 'Expected', '') + dashTile(c.P, 'On time', 'ok') +
      dashTile(c.L, 'Late', 'warn') + dashTile(c.N, 'Not marked', 'err') +
      '</div><div class="dash-grid">' +
      dashTile(c.V, 'On leave', '') +
      dashTile(people.filter(p => p.e.gf === 'OUTSIDE').length, 'Outside', 'warn') +
      dashTile(people.filter(p => p.e.gf === 'UNVERIFIED').length, 'Unverif.', '') +
      dashTile(people.filter(p => p.e.in).length, 'Marked', 'ok') +
      '</div>';

    html += '<div class="dash-h">Your people · tap 🚩 to flag an issue</div>';
    html += people.map(p => {
      const cls = p.e.st === 'PRESENT' || p.e.st === 'ON_LEAVE' ? 'ok'
        : p.e.st === 'LATE' ? 'warn' : 'err';
      return '<div class="drow"><span class="dr-name">' + escH(p.n) +
        '<small class="dr-sub">' + escH(p.awc) + '</small></span>' +
        '<span class="dr-nums">' + escH(p.e.in || '–') + '</span>' +
        '<span class="dr-pct ' + cls + '">' +
        escH((p.e.st || 'NOT_MARKED').replace('_', ' ').toLowerCase()) + '</span>' +
        '<button class="flag-btn" data-uid="' + p.id + '" data-name="' + escH(p.n) + '">🚩</button></div>';
    }).join('');

    const nOpen = issues.filter(i => i.status !== 'RESOLVED').length;
    const nRes = issues.length - nOpen;
    html += '<div class="dash-h">Issues · open ' + nOpen + ' · resolved by worker ' + nRes + '</div>';
    html += issues.length ? issues.map(i => {
      const who = (nm.users[i.about] || {}).n || i.about;
      const res = i.status === 'RESOLVED';
      return '<div class="drow"><span class="dr-name">' + (res ? '✔ ' : '') +
        escH(CAT_LABEL[i.cat] || i.cat) +
        '<small class="dr-sub">' + escH(who) + (i.text ? ' — ' + escH(i.text) : '') +
        (res && i.resolvedRemark ? '<br>Worker: “' + escH(i.resolvedRemark) + '”' : '') +
        '</small></span>' +
        '<span class="dr-pct ' + (res ? 'ok' : 'warn') + '">' + (res ? 'resolved' : 'open') + '</span>' +
        '<button class="close-btn" data-id="' + escH(i.id) + '">' + (res ? 'Confirm' : 'Close') + '</button></div>';
    }).join('') : '<p class="info">No open issues — flagged items appear here until closed.</p>';

    el.innerHTML = html;

    el.querySelectorAll('.flag-btn').forEach(b => {
      b.onclick = () => openIssueSheet(acc, b.dataset.uid, b.dataset.name,
        () => renderSectorDash(acc));
    });
    el.querySelectorAll('.close-btn').forEach(b => {
      b.onclick = async () => {
        const remark = prompt('Resolution remark (required) — how was it resolved?');
        if (remark === null) return;
        if (!remark.trim()) { alert('A remark is required to close an issue.'); return; }
        b.disabled = true;
        try {
          const res = await Api.post({ action: 'closeIssue', token: acc.token,
            issueId: b.dataset.id, remark: remark.trim() });
          if (res.ok) { alert('Issue closed.'); renderSectorDash(acc); }
          else alert('Could not close (' + res.code + ').');
        } catch (e) {
          alert('Needs internet — try again on network.');
        }
        b.disabled = false;
      };
    });
  }

  async function renderDash() {
    const accNow = active();
    if (accNow && accNow.user.role === 'SUPERVISOR') return renderSectorDash(accNow);
    $('dash-title').textContent = 'District Dashboard';
    const el = $('dash-content'), stale = $('dash-stale');
    el.innerHTML = '<p class="info">Loading district data&hellip;</p>';
    stale.textContent = '';
    stale.className = 'dash-stale';

    let meta = null, today = null;
    try {
      const t = Date.now();
      [meta, today] = await Promise.all([
        fetch('../summary/meta.json?t=' + t).then(r => r.ok ? r.json() : null),
        fetch('../summary/today.json?t=' + t).then(r => r.ok ? r.json() : null)
      ]);
    } catch (e) { /* offline */ }
    if (!today || !today.district) {
      el.innerHTML = '<p class="info">Could not load district data — the dashboard needs internet.</p>';
      return;
    }

    let org = await DB.kvGet('org');
    if (!org || Date.now() - org.at > 7 * 86400000) {
      try {
        const j = await (await fetch('../summary/org.json?t=' + Date.now())).json();
        org = { at: Date.now(), sectors: j.sectors || [], projects: j.projects || [] };
        await DB.kvSet('org', org);
      } catch (e) { org = org || { sectors: [], projects: [] }; }
    }
    const secName = c => { const s = (org.sectors || []).find(x => x.code === c); return s ? s.name : c; };
    const projName = c => { const p = (org.projects || []).find(x => x.code === c); return p ? p.name : c; };

    const dataMin = Math.round((Date.now() - new Date(today.generatedAt).getTime()) / 60000);
    const aliveMin = (meta && meta.checkedAt)
      ? Math.round((Date.now() - new Date(meta.checkedAt).getTime()) / 60000) : dataMin;
    stale.className = 'dash-stale ' + (aliveMin <= 40 ? 'ok' : aliveMin <= 90 ? 'warn' : 'err');
    stale.textContent = (aliveMin <= 40 ? '✓ SYSTEM LIVE' : aliveMin <= 90 ? '⚠ UPDATES DELAYED' : '✖ NOT UPDATING') +
      ' · DATA ' + (dataMin < 1 ? 'JUST NOW' : dataMin + ' MIN AGO');

    const d = today.district;
    const marked = d.in + d.late;
    const pct = d.expected ? Math.round(100 * marked / d.expected) : 0;
    const tile = (v, k, cls) =>
      '<div class="dtile ' + (cls || '') + '"><b>' + v + '</b><span>' + k + '</span></div>';

    let html = '';
    if (today.holiday) html += '<div class="dash-holiday">' + escH(today.holiday) + ' — holiday today</div>';
    html += '<div class="dash-bar-wrap"><div class="dash-bar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="dash-bar-label"><b>' + marked + '</b> of <b>' + d.expected +
      '</b> marked IN · <b>' + pct + '%</b></div></div>';
    html += '<div class="dash-grid">' +
      tile(d.in, 'On time', 'ok') + tile(d.late, 'Late', 'warn') +
      tile(d.notMarked, 'Not marked', 'err') + tile(d.onLeave, 'On leave', '') +
      tile(d.out, 'Marked out', '') + tile((today.exceptions || []).length, 'Flagged', 'warn') +
      tile(d.outside, 'Outside fence', 'warn') + tile(d.unverified, 'GPS unverif.', '') +
      '</div>';

    if (today.rpt) {
      const stk = today.rpt.stock;
      html += '<div class="dash-h">AWC daily reports · ' + today.rpt.awcs + ' centres reported</div>' +
        '<div class="dash-grid">' +
        tile(today.rpt.children, 'Children', 'ok') + tile(today.rpt.pregnant, 'Pregnant', '') +
        tile(today.rpt.others, 'Others', '') + tile(today.rpt.meals, 'Meals', 'ok') +
        '</div>' +
        '<div class="dash-h">Closing stock at centres</div>' +
        (stk
          ? '<div class="dash-grid">' +
            tile(stk.eggs.cb, 'Eggs', '') + tile(stk.rice.cb + 'kg', 'Rice', '') +
            tile(stk.pulses.cb + 'kg', 'Pulses', '') + tile(stk.milk.cb + 'L', 'Milk', '') +
            '</div><div class="dash-grid">' +
            tile(stk.bal.cb + 'ml', 'Balamrutham', '') + tile(stk.balp.cb + 'ml', 'Balam. +', '') +
            tile(stk.eggs.used, 'Eggs used', 'warn') + tile(today.rpt.awcs, 'Reported', 'ok') +
            '</div>'
          : '<div class="dash-grid">' +
            tile(today.rpt.eggs || 0, 'Eggs', '') + tile((today.rpt.riceKg || 0) + 'kg', 'Rice', '') +
            tile((today.rpt.pulsesKg || 0) + 'kg', 'Pulses', '') + tile(today.rpt.awcs, 'Reported', 'ok') +
            '</div>');
    }

    html += '<div class="dash-h">Projects</div>' + (today.projects || []).map(p => {
      const m = p.in + p.late, pc2 = p.expected ? Math.round(100 * m / p.expected) : 0;
      return dashRow(projName(p.code), m, p.expected, pc2);
    }).join('');

    const secs = (today.sectors || []).filter(s => s.code && s.code !== '?' && s.expected > 0)
      .map(s => ({ name: secName(s.code), m: s.in + s.late, e: s.expected,
        pc: Math.round(100 * (s.in + s.late) / s.expected) }))
      .sort((a, b) => b.pc - a.pc);
    html += '<div class="dash-h">Best sectors</div>' +
      secs.slice(0, 5).map(s => dashRow(s.name, s.m, s.e, s.pc)).join('');
    html += '<div class="dash-h">Needs attention</div>' +
      secs.slice(-5).reverse().map(s => dashRow(s.name, s.m, s.e, s.pc)).join('');

    el.innerHTML = html;
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
    const queue = await DB.all('queue'); // add-user stays visible: the server
    // enforces the AWT+AWH pair limit and admins are legitimately unrestricted
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
  /** (Re)start GPS acquisition for the capture screen; retried on demand. */
  function startGeoWatch() {
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
        gpsLine.textContent = 'GPS not found — location is required. Move under open sky.';
        gpsLine.className = 'gps-line bad';
      }
      return g;
    });
  }

  async function openCamera(title, face) {
    $('cam-title').textContent = title;
    $('cam-msg').textContent = '';
    show('screen-camera');

    startGeoWatch();

    try {
      await Camera.start($('cam-video'), face);
      $('cam-video').classList.toggle('rear', Camera.facing() !== 'user');
    } catch (e) {
      $('cam-msg').textContent = camMode === 'mark'
        ? 'Camera is required to mark attendance. Allow camera permission for this app, then try again.'
        : 'Camera not available — you can still save without a photo.';
    }
  }

  async function startMark() {
    if (!active()) { resetLogin(); show('screen-login'); return; }
    markType = await nextAction();
    if (!markType) return;
    // District rule 2026-08-20: OUT opens at 16:00 — no early day-close.
    if (markType === 'OUT') {
      const d = new Date();
      const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      if (hm < '16:00') {
        alert('OUT attendance opens at 4:00 PM.');
        return;
      }
    }
    // District rule: OUT requires today's centre report to exist — AWT
    // (Teacher) only; the AWH is exempt. The report can be filled any time
    // of day; OUT is NOT chained after it — the worker marks OUT whenever
    // she actually leaves.
    if (markType === 'OUT' && active().user.cadre === 'AWT' && !(await reportDoneToday())) {
      openReport();
      $('rpt-msg').textContent = 'Complete today\'s report first — then mark OUT anytime.';
      return;
    }
    camMode = 'mark';
    openCamera(markType === 'IN' ? 'IN — take your photo' : 'OUT — take your photo', 'user');
  }

  async function doCapture() {
    const acc = active();
    if (!acc) { Camera.stop(); resetLogin(); show('screen-login'); return; }
    if (camMode !== 'mark') { await captureRptPhoto(acc); return; }
    setBusy('btn-capture', true, 'Saving…');
    try {
      const clientTs = localIso();
      // District order 2026-08-19: photo AND a GPS fix are mandatory for an
      // attendance mark. Geofence miss or poor accuracy still saves (flagged)
      // — only the complete ABSENCE of a fix or photo blocks, with retry.
      const g = geoResult || (await geoPromise);
      if (!g) {
        $('cam-msg').textContent = 'Location is required to mark attendance. ' +
          'Move near a window or open sky — GPS is retrying, then tap capture again.';
        startGeoWatch();
        return;
      }
      let photoBlob = null;
      const video = $('cam-video');
      if (video.srcObject && video.srcObject.active && video.videoWidth > 0) {
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
      if (!photoBlob) {
        $('cam-msg').textContent = 'Photo is required to mark attendance. ' +
          'If the picture is black, tap the flip button or close and reopen the app.';
        return;
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
      setBusy('btn-capture', false);
    }
  }

  // ---------- daily report (children / pregnant / others / meals) ----------
  /**
   * Done when any account on this phone has today's RPT record for this AWC
   * (queued or synced). A centre phone is shared by its AWT+AWH pair, so a
   * device-local check covers the real sharing case; the server additionally
   * dedupes per AWC when aggregating.
   */
  async function reportDoneToday() {
    const acc = active();
    const t = todayCompact();
    const myAwc = String(acc.user.awcId || '');
    const rows = (await DB.all('queue')).concat(await DB.all('history'));
    return rows.some(r => {
      const p = String(r.key).split('_');
      if (p[1] !== t || p[2] !== 'RPT') return false;
      return !r.awcId || !myAwc || String(r.awcId) === myAwc;
    });
  }

  function openReport() {
    $('rpt-msg').textContent = '';
    updateRptPhotoButtons();
    show('screen-report');
  }

  // ---------- stock register: 6 items, Opening/Used/Received editable,
  // Closing auto-calculated (Opening + Received − Used) ----------
  // max = plausibility cap per AWC per day — values above it are almost
  // certainly typing errors (7,100 kg rice was really entered once).
  const STOCK_ITEMS = [
    { k: 'eggs', label: 'Eggs', unit: 'count', dec: false, max: 1000 },
    { k: 'rice', label: 'Rice', unit: 'KG', dec: true, max: 500 },
    { k: 'pulses', label: 'Pulses', unit: 'KG', dec: true, max: 100 },
    { k: 'bal', label: 'Balamrutham', unit: 'ml', dec: false, max: 25000 },
    { k: 'balp', label: 'Balamrutham +', unit: 'ml', dec: false, max: 25000 },
    { k: 'milk', label: 'Milk', unit: 'litres', dec: true, max: 100 }
  ];
  const ST_COLS = ['ob', 'used', 'recd'];

  function buildStockTable() {
    const t = $('stock-table');
    STOCK_ITEMS.forEach(it => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td class="item">' + it.label + '<small>' + it.unit + '</small></td>' +
        ST_COLS.map(c => '<td><input id="st-' + it.k + '-' + c +
          '" type="number" inputmode="' + (it.dec ? 'decimal' : 'numeric') +
          '" min="0" max="' + it.max + '"' + (it.dec ? ' step="0.5"' : '') +
          ' placeholder="0"></td>').join('') +
        '<td class="cb" id="st-' + it.k + '-cb">&ndash;</td>';
      t.appendChild(tr);
      ST_COLS.forEach(c => $('st-' + it.k + '-' + c)
        .addEventListener('input', () => updateStockCb(it)));
    });
  }

  const stockVal = (it, c) => {
    const v = $('st-' + it.k + '-' + c).value.trim();
    return v === '' || isNaN(Number(v)) ? null : Number(v);
  };

  function stockCb(it) {
    const ob = stockVal(it, 'ob'), used = stockVal(it, 'used'), recd = stockVal(it, 'recd');
    if (ob == null || used == null || recd == null) return null;
    return Math.round((ob + recd - used) * 10) / 10;
  }

  function updateStockCb(it) {
    const cb = stockCb(it);
    const cell = $('st-' + it.k + '-cb');
    cell.textContent = cb == null ? '–' : cb;
    cell.classList.toggle('neg', cb != null && cb < 0);
  }

  const RPT_KINDS = {
    child:  { btn: 'btn-rp-photo-child',  label: 'children photo',            stamp: 'CHILDREN PRESENT',    title: 'Children present — take photo' },
    preg:   { btn: 'btn-rp-photo-preg',   label: 'pregnant women photo',      stamp: 'PREGNANT WOMEN',      title: 'Pregnant women — take photo' },
    others: { btn: 'btn-rp-photo-others', label: 'other beneficiaries photo', stamp: 'OTHER BENEFICIARIES', title: 'Other beneficiaries — take photo' },
    meal:   { btn: 'btn-rp-photo-meal',   label: 'meal photo',                stamp: 'MEAL PREPARED',       title: 'Meal prepared — take photo' }
  };

  function updateRptPhotoButtons() {
    Object.keys(RPT_KINDS).forEach(k => {
      const d = RPT_KINDS[k], b = $(d.btn);
      b.textContent = rptPhotos[k]
        ? '✓ ' + d.label.charAt(0).toUpperCase() + d.label.slice(1) + ' taken — tap to retake'
        : rptCamFail[k]
          ? '⚠ Camera unavailable — ' + d.label + ' will be flagged'
          : '📷 Take ' + d.label + ' (live, geo-tagged)';
      b.classList.toggle('taken', !!rptPhotos[k]);
    });
  }

  function openRptCamera(kind) {
    camMode = 'rpt-' + kind;
    // Report photos shoot the room/food, not a selfie: default to the rear camera.
    openCamera(RPT_KINDS[kind].title, 'environment');
  }

  async function captureRptPhoto(acc) {
    setBusy('btn-capture', true, 'Saving…');
    try {
      const clientTs = localIso();
      const g = geoResult ||
        (await Promise.race([geoPromise, new Promise(r => setTimeout(() => r(null), 1500))]));
      const kind = camMode.slice(4); // 'rpt-child' -> 'child'
      const video = $('cam-video');
      if (video.srcObject && video.srcObject.active && video.videoWidth > 0) {
        const stamp = [
          clientTs.slice(0, 16).replace('T', ' '),
          placeLine(g, acc.config),
          RPT_KINDS[kind].stamp + ' — ' + acc.user.name.slice(0, 20)
        ];
        rptPhotos[kind] = await Camera.capture(video, stamp,
          (acc.config && acc.config.photoMaxKB) || 60);
        delete rptCamFail[kind];
        if (g) rptPhotos.geo = g;
      } else {
        // Camera broken/denied: never-block escape — the report may be
        // submitted without this photo and the server flags NO_PHOTO_*.
        rptCamFail[kind] = true;
      }
      Camera.stop();
      openReport();
      if (rptCamFail[kind]) {
        $('rpt-msg').textContent = 'No camera available — the report can be submitted; the missing photo will be flagged.';
      }
    } finally {
      setBusy('btn-capture', false);
    }
  }

  async function submitReport() {
    const acc = active();
    if (!acc) { resetLogin(); show('screen-login'); return; }
    const msg = $('rpt-msg');
    msg.textContent = '';
    if (await reportDoneToday()) {
      msg.textContent = 'Today\'s report is already submitted for this centre.';
      return;
    }
    const num = id => Math.min(999, Math.max(0, Math.round(Number($(id).value) || 0)));
    // District rule: EVERY field and ALL FOUR photos are compulsory. A value
    // of 0 is fine, but it must be typed — blank, negative or non-numeric
    // does not pass. Photos are excused only when the camera itself is
    // broken/denied (never-block): those sync flagged NO_PHOTO_*.
    const FIELD_LABELS = {
      'rp-children': 'children count', 'rp-pregnant': 'pregnant women count',
      'rp-others': 'other beneficiaries count', 'rp-meals': 'meals count'
    };
    const badValue = v => v.trim() === '' || isNaN(Number(v)) || Number(v) < 0;
    const missing = Object.keys(FIELD_LABELS)
      .filter(id => badValue($(id).value)).map(id => FIELD_LABELS[id])
      .concat(Object.keys(RPT_KINDS)
        .filter(k => !rptPhotos[k] && !rptCamFail[k]).map(k => RPT_KINDS[k].label));
    STOCK_ITEMS.forEach(it => {
      ST_COLS.forEach(c => {
        if (badValue($('st-' + it.k + '-' + c).value)) {
          missing.push(it.label + ' ' + (c === 'ob' ? 'opening' : c === 'used' ? 'used' : 'received'));
        }
      });
    });
    if (missing.length) {
      msg.textContent = 'Required (0 allowed, blank/negative not): ' + missing.join(', ') + '.';
      return;
    }
    const shortItem = STOCK_ITEMS.find(it => (stockCb(it) || 0) < 0);
    if (shortItem) {
      msg.textContent = shortItem.label + ': used is more than opening + received. Please correct.';
      return;
    }
    // Plausibility caps — a centre cannot hold 7,100 kg of rice; values above
    // the per-item maximum are typing mistakes and must be corrected.
    const COUNT_MAX = { 'rp-children': 150, 'rp-pregnant': 50, 'rp-others': 100, 'rp-meals': 300 };
    const overs = [];
    Object.keys(COUNT_MAX).forEach(id => {
      if (Number($(id).value) > COUNT_MAX[id]) {
        overs.push(FIELD_LABELS[id] + ' ' + $(id).value + ' (max ' + COUNT_MAX[id] + ')');
      }
    });
    STOCK_ITEMS.forEach(it => {
      ST_COLS.forEach(c => {
        const v = Number($('st-' + it.k + '-' + c).value);
        if (v > it.max) {
          overs.push(it.label + ' ' + (c === 'ob' ? 'opening' : c === 'used' ? 'used' : 'received') +
            ' ' + v + ' (max ' + it.max + ' ' + it.unit + ')');
        }
      });
    });
    if (overs.length) {
      msg.textContent = 'These values look wrong — please check and correct: ' + overs.join('; ') + '.';
      return;
    }
    const round1 = (v, dec) => dec ? Math.round(v * 10) / 10 : Math.round(v);
    const stock = {};
    STOCK_ITEMS.forEach(it => {
      stock[it.k] = {
        ob: Math.min(it.max, round1(stockVal(it, 'ob'), it.dec)),
        used: Math.min(it.max, round1(stockVal(it, 'used'), it.dec)),
        recd: Math.min(it.max, round1(stockVal(it, 'recd'), it.dec)),
        cb: Math.min(it.max, round1(stockCb(it), it.dec))
      };
    });
    setBusy('btn-rp-submit', true, 'Saving report…');
    try {
      const g = rptPhotos.geo || (await Geo.capture(5000));
      const record = {
        key: acc.user.id + '_' + todayCompact() + '_RPT',
        type: 'RPT',
        clientTs: localIso(),
        lat: g ? Number(g.lat.toFixed(6)) : '',
        lng: g ? Number(g.lng.toFixed(6)) : '',
        accuracy: g ? Math.round(g.accuracy) : '',
        netState: navigator.onLine ? 'ONLINE' : 'OFFLINE',
        awcId: String(acc.user.awcId || ''),
        children: num('rp-children'), pregnant: num('rp-pregnant'),
        others: num('rp-others'), meals: num('rp-meals'),
        // legacy single-value stock columns keep older consumers working:
        // they now carry the CLOSING balances
        eggs: stock.eggs.cb, riceKg: stock.rice.cb, pulsesKg: stock.pulses.cb,
        stock: stock,
        photoBlob: rptPhotos.child, photoBlob2: rptPhotos.meal,
        photoBlob3: rptPhotos.preg, photoBlob4: rptPhotos.others
      };
      await Sync.enqueue(record);
      ['rp-children', 'rp-pregnant', 'rp-others', 'rp-meals'].forEach(id => { $(id).value = ''; });
      STOCK_ITEMS.forEach(it => {
        ST_COLS.forEach(c => { $('st-' + it.k + '-' + c).value = ''; });
        updateStockCb(it);
      });
      rptPhotos = { child: null, preg: null, others: null, meal: null, geo: null };
      rptCamFail = {};

      $('success-text').textContent = 'Daily report saved';
      $('success-sub').textContent = navigator.onLine
        ? 'Sending to server…'
        : 'You are offline — it will be sent automatically when network returns.';
      show('screen-success');
      setTimeout(goHome, 1800);
    } finally {
      setBusy('btn-rp-submit', false);
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
