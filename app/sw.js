'use strict';
/**
 * Service worker: offline app shell (cache-first) + Background Sync relay.
 * API calls (cross-origin to script.google.com) pass straight to network.
 * Honest limitation: if the browser fires 'sync' with no client open we ping
 * clients only — full closed-app sync would mean duplicating the queue code
 * here; the capture/online/foreground triggers cover real usage, and records
 * are never lost either way (they wait in IndexedDB for the next open).
 */
const CACHE = 'attendance-v4';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './css/style.css',
  './js/config.js', './js/db.js', './js/api.js', './js/geo.js',
  './js/camera.js', './js/sync.js', './js/app.js',
  './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).origin !== location.origin) return;
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
