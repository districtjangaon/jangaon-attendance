'use strict';
/**
 * Service worker: offline app shell (cache-first) + Background Sync relay.
 * API calls (cross-origin to script.google.com) pass straight to network.
 * Honest limitation: if the browser fires 'sync' with no client open we ping
 * clients only — full closed-app sync would mean duplicating the queue code
 * here; the capture/online/foreground triggers cover real usage, and records
 * are never lost either way (they wait in IndexedDB for the next open).
 */
const CACHE = 'attendance-v17';
const FONT_CACHE = 'attendance-fonts-v1';
const FONT_ORIGINS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];
const SHELL = [
  './', './index.html', './manifest.webmanifest', './css/style.css',
  './js/config.js', './js/db.js', './js/api.js', './js/geo.js',
  './js/camera.js', './js/sync.js', './js/app.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/emblem.svg'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
