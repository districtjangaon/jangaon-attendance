'use strict';
/**
 * Service worker: offline app shell (cache-first) + Background Sync relay.
 * API calls (cross-origin to script.google.com) pass straight to network.
 * Honest limitation: if the browser fires 'sync' with no client open we ping
 * clients only — full closed-app sync would mean duplicating the queue code
 * here; the capture/online/foreground triggers cover real usage, and records
 * are never lost either way (they wait in IndexedDB for the next open).
 */
// Stamped by tools/bump-build.py from the app build tag - do not edit by hand.
// The shell is served cache-first and the browser only re-installs this worker
// when its BYTES change, so a build that leaves this name alone never reaches
// a phone that already has the old one. tools/test-build.js enforces the match.
const CACHE = 'attendance-v5.25-20260830-2131';
const FONT_CACHE = 'attendance-fonts-v1';
const FONT_ORIGINS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];
const SHELL = [
  './', './index.html', './manifest.webmanifest', './css/style.css',
  './js/config.js', './js/db.js', './js/api.js', './js/geo.js',
  './js/camera.js', './js/sync.js', './js/app.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/emblem.svg',
  './img/welcome.jpg', './img/login-bg.jpg'
];

self.addEventListener('install', e => {
  // cache:'reload' bypasses the browser HTTP cache (GitHub Pages max-age=600):
  // without it a new shell can be sealed with a stale stylesheet fetched
  // minutes earlier — new HTML, old CSS.
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE && k !== FONT_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      // Tell open pages a new version just took over, so the app can reload
      // itself — otherwise users keep the stale shell until a manual restart.
      .then(() => self.clients.matchAll({ includeUncontrolled: true }))
      .then(clients => clients.forEach(c => c.postMessage({ type: 'sw-updated' })))
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const origin = new URL(e.request.url).origin;
  // Web fonts: cache-first with runtime fill, so typography survives offline
  // after the first online load. First-ever offline run falls back to the
  // system font stack declared in CSS — never blocks the app.
  if (FONT_ORIGINS.includes(origin)) {
    e.respondWith(
      caches.open(FONT_CACHE).then(c =>
        c.match(e.request).then(hit => hit || fetch(e.request).then(res => {
          if (res.ok) c.put(e.request, res.clone());
          return res;
        }))
      )
    );
    return;
  }
  if (origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request))
  );
});

self.addEventListener('sync', e => {
  if (e.tag === 'sync-marks') {
    e.waitUntil(
      self.clients.matchAll({ includeUncontrolled: true }).then(clients => {
        clients.forEach(c => c.postMessage({ type: 'do-sync' }));
      })
    );
  }
});

// ---------- attendance reminders ----------
// Fired by Periodic Background Sync (Chrome, installed PWA, user opted in via
// Notification permission). Timing is at the browser's discretion — this is
// best-effort; the in-app banner is the guaranteed reminder. Reads the same
// IndexedDB the app writes; notifies at most once per user per kind per day.
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('attendance_v1', 1);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const idbReq = r => new Promise((res, rej) => {
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

async function reminderCheck() {
  const now = new Date();
  if (now.getDay() === 0) return; // Sunday
  const p = n => String(n).padStart(2, '0');
  const nowHM = p(now.getHours()) + ':' + p(now.getMinutes());
  const today = '' + now.getFullYear() + p(now.getMonth() + 1) + p(now.getDate());

  const db = await idbOpen();
  const store = (name, mode) => db.transaction(name, mode || 'readonly').objectStore(name);
  const accounts = (await idbReq(store('kv').get('accounts'))) || {};
  const uids = Object.keys(accounts);
  if (!uids.length) return;

  const rows = (await idbReq(store('queue').getAll())).concat(await idbReq(store('history').getAll()));
  const have = {}; // uid -> { IN:true, OUT:true } for today
  rows.forEach(r => {
    const q = String(r.key).split('_');
    if (q[1] === today) (have[q[0]] = have[q[0]] || {})[q[2]] = true;
  });

  for (const uid of uids) {
    const sch = (accounts[uid].config && accounts[uid].config.schedule) || {};
    const name = (accounts[uid].user && accounts[uid].user.name) || '';
    const cadre = (accounts[uid].user && accounts[uid].user.cadre) || '';
    const h = have[uid] || {};
    let kind = null, text = '';
    if (!h.IN && nowHM >= (sch.late_after || '09:30') && nowHM <= '18:00') {
      kind = 'IN'; text = name + ' — you have not marked IN attendance today.';
    } else if (cadre === 'AWT' && h.IN && !h.RPT && nowHM >= '11:00' && nowHM <= '19:00') {
      kind = 'RPT'; text = name + ' — today\'s centre report (children, meals, stock) is not filled yet.';
    } else if (h.IN && !h.OUT && nowHM >= '16:30' && nowHM <= '21:00') {
      kind = 'OUT'; text = name + ' — remember to mark OUT before the day ends.';
    }
    if (!kind) continue;
    // Repeat every ~2 hours until the task is done; a completed task simply
    // stops matching above and the reminders end by themselves.
    const flag = 'notified_' + uid + '_' + today + '_' + kind;
    const lastAt = await idbReq(store('kv').get(flag));
    if (lastAt && Date.now() - lastAt < 115 * 60 * 1000) continue;
    await new Promise((res, rej) => {
      const t = db.transaction('kv', 'readwrite');
      t.objectStore('kv').put(Date.now(), flag);
      t.oncomplete = res;
      t.onerror = rej;
    });
    await self.registration.showNotification('Samridhi reminder', {
      body: text,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: flag
    });
  }
}

self.addEventListener('periodicsync', e => {
  if (e.tag === 'attendance-reminder') e.waitUntil(reminderCheck().catch(() => {}));
});

// The page nudges every 15 min while open; the 2-hour throttle above decides.
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'reminder-check') {
    e.waitUntil(reminderCheck().catch(() => {}));
  }
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(cs => cs.length ? cs[0].focus() : self.clients.openWindow('./'))
  );
});
