'use strict';
/**
 * IndexedDB wrapper. Stores:
 *   queue   — marks waiting for server ack (record + photo Blob), key = idempotency key
 *   history — acked marks (last ~35 days), so "My record" works offline
 *   kv      — session, config, deviceId, lastSync
 * IndexedDB and not localStorage: localStorage is ~5 MB, synchronous and
 * string-only — queued 60 KB photos as base64 would jank and overflow it.
 */
const DB = (() => {
  let dbp = null;

  function open() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open('attendance_v1', 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'key' });
          if (!db.objectStoreNames.contains('history')) db.createObjectStore('history', { keyPath: 'key' });
          if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }

  function tx(store, mode, op) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const r = op(t.objectStore(store));
      t.oncomplete = () => resolve(r ? r.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  return {
    put: (store, val) => tx(store, 'readwrite', s => s.put(val)),
    get: (store, key) => tx(store, 'readonly', s => s.get(key)),
    del: (store, key) => tx(store, 'readwrite', s => s.delete(key)),
    all: (store) => tx(store, 'readonly', s => s.getAll()),
    count: (store) => tx(store, 'readonly', s => s.count()),
    kvGet: (key) => tx('kv', 'readonly', s => s.get(key)),
    kvSet: (key, val) => tx('kv', 'readwrite', s => s.put(val, key)),
    kvDel: (key) => tx('kv', 'readwrite', s => s.delete(key))
  };
})();
