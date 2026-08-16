'use strict';
/**
 * Sync engine. Queue-first: records live in IndexedDB until the server acks
 * them. Triggers: after capture, connectivity restored, app foregrounded,
 * manual "Sync now", Background Sync message from the service worker.
 *
 * Several accounts can be logged in on one phone (AWT + AWH sharing the
 * centre phone). Each queued record's key starts with its owner's user id;
 * every run groups the queue by owner and sends each group under that
 * owner's own token. One account's expired session never blocks another
 * account's records — and never deletes anything.
 *
 * Auto triggers wait a random jitter (server-configurable, default 90 s) so
 * hundreds of phones marking at 9:00 don't stampede one Apps Script endpoint;
 * failures back off exponentially with jitter (30 s .. 30 min).
 */
const Sync = (() => {
  let syncing = false;
  let timer = null;
  let failCount = 0;

  function schedule(reason) {
    const cfg = App.activeConfig;
    const jitterMax = (cfg && cfg.sync && cfg.sync.jitterMaxSec) || 90;
    // Fresh captures send almost immediately (0–8 s) — the user is watching.
    // Herd triggers (online/foreground/bg/drain) keep the full jitter so
    // hundreds of phones regaining network never stampede the endpoint;
    // failure retries additionally back off exponentially below.
    const capSec = reason === 'manual' ? 0
      : reason === 'capture' ? Math.min(8, jitterMax)
      : jitterMax;
    const delay = Math.floor(Math.random() * capSec * 1000);
    clearTimeout(timer);
    timer = setTimeout(run, delay);
  }

  function backoff() {
    failCount++;
    const sec = Math.min(1800, 30 * Math.pow(2, failCount - 1)) + Math.floor(Math.random() * 30);
    clearTimeout(timer);
    timer = setTimeout(run, sec * 1000);
  }

  async function run() {
    if (syncing) return;
    if (!navigator.onLine && !window.APP_CONFIG.DEMO) { App.renderStatus(); return; }
    const accounts = await DB.kvGet('accounts') || {};
    const deviceId = await DB.kvGet('deviceId');
    const queue = await DB.all('queue');
    if (!queue.length) { App.renderStatus(); return; }

    const byUid = {};
    for (const item of queue) {
      const uid = String(item.key).split('_')[0];
      (byUid[uid] = byUid[uid] || []).push(item);
    }

    syncing = true;
    App.renderStatus();
    let anyOk = false, busy = false;
    try {
      for (const uid of Object.keys(byUid)) {
        const acc = accounts[uid];
        if (!acc) continue; // owner logged out with pending marks: they sync after re-login
        const batch = byUid[uid].slice(0, 10);
        const records = [];
        for (const item of batch) {
          records.push({
            key: item.key,
            clientTs: item.clientTs,
            lat: item.lat, lng: item.lng, accuracy: item.accuracy,
            deviceId: deviceId,
            appVersion: window.APP_CONFIG.VERSION,
            netState: item.netState,
            photoB64: item.photoBlob ? await blobToB64(item.photoBlob) : '',
            // Daily-report (RPT) extras; undefined on plain marks, which
            // JSON.stringify simply omits.
            photo2B64: item.photoBlob2 ? await blobToB64(item.photoBlob2) : undefined,
            children: item.children, pregnant: item.pregnant,
            others: item.others, meals: item.meals
          });
        }
        let res;
        try {
          res = await Api.post({ action: 'sync', token: acc.token, deviceNow: Date.now(), records: records });
        } catch (e) {
          busy = true; // network-level failure: back off, try again later
          break;
        }

        if (res.ok) {
          anyOk = true;
          for (const ack of (res.acks || [])) {
            const item = batch.find(b => b.key === ack.key);
            if (ack.status === 'OK' || ack.status === 'DUP') {
              if (item) {
                await DB.put('history', {
                  key: item.key, type: item.type, clientTs: item.clientTs,
                  awcId: item.awcId, synced: true
                });
              }
              await DB.del('queue', ack.key);
            } else if (ack.status === 'REJECTED') {
              // Malformed/foreign key: drop, never loops. EXCEPT daily-report
              // records — a backend deployed before the report feature rejects
              // their key format; keep them queued so nothing is lost across
              // the upgrade window (the app only ever builds well-formed keys).
              if (!/_RPT$/.test(ack.key)) await DB.del('queue', ack.key);
            }
          }
        } else if (res.code === 'BUSY') {
          busy = true; // server saturated: records stay queued, nothing lost
          break;
        } else if (['AUTH', 'EXPIRED', 'REVOKED', 'DEVICE_MISMATCH'].indexOf(res.code) >= 0) {
          await App.onAuthLost(uid, res.code); // this account only; its queue is preserved
        } else {
          busy = true;
          break;
        }
      }

      if (anyOk) {
        failCount = 0;
        await DB.kvSet('lastSync', Date.now());
      }
      if (busy) backoff();
      else if ((await DB.count('queue')) > 0 && anyOk) schedule('drain');
    } finally {
      syncing = false;
      App.renderStatus();
    }
  }

  function blobToB64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1]);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  async function enqueue(record) {
    await DB.put('queue', record);
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      try {
        const reg = await navigator.serviceWorker.ready;
        await reg.sync.register('sync-marks');
      } catch (e) { /* Background Sync unsupported: the other triggers cover it */ }
    }
    schedule('capture');
  }

  function init() {
    window.addEventListener('online', () => schedule('online'));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) schedule('foreground');
    });
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'do-sync') schedule('bg');
      });
    }
  }

  return {
    enqueue: enqueue,
    schedule: schedule,
    run: run,
    init: init,
    isSyncing: () => syncing
  };
})();
