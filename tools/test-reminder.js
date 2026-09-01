// tools/test-reminder.js — run with:  node tools/test-reminder.js
//
// Runs reminderCheck() from app/sw.js against a stubbed IndexedDB.
//
// These rules decide what a government employee is told about her own work, so
// the thing being tested is not "does a notification fire" but "is it true".
// A reminder for work already done is worse than no reminder: it teaches
// people that the reminders are noise, and then the real ones are ignored too.
//
// The report belongs to the CENTRE. Before 1 Sep 2026 this was keyed per
// person, so an AWT whose Helper had already filed was told hers was missing.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'app', 'sw.js'), 'utf8');

// The page must nudge on open, not only on a 15-minute timer: for the 659
// devices running in a browser tab rather than an installed app, opening the
// app is the ONLY moment a reminder can be raised.
const app = fs.readFileSync(path.join(ROOT, 'app', 'js', 'app.js'), 'utf8');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond || !detail ? '' : '\n         ' + detail));
  cond ? pass++ : fail++;
}

/** A tiny IndexedDB that behaves enough like the real one for these rules. */
function makeIdb(stores) {
  const req = (result) => {
    const r = { result, onsuccess: null, onerror: null };
    setTimeout(() => r.onsuccess && r.onsuccess(), 0);
    return r;
  };
  return {
    transaction: (name) => ({
      objectStore: () => ({
        get: (k) => req(stores[name][k]),
        getAll: () => req(Object.values(stores[name])),
        put: (v, k) => { stores[name][k] = v; return req(undefined); }
      }),
      set oncomplete(fn) { setTimeout(fn, 0); },
      set onerror(fn) { /* never in these fixtures */ }
    })
  };
}

/** Run reminderCheck at a given clock and return the notifications raised. */
function run(at, { accounts, rows, kv }) {
  const stores = {
    kv: Object.assign({ accounts }, kv || {}),
    queue: {},
    history: {}
  };
  (rows || []).forEach((r, i) => { stores.history['h' + i] = r; });

  const shown = [];
  const RealDate = Date;
  const fixed = new RealDate(at).getTime();
  const ctx = {
    console,
    indexedDB: { open: () => { const r = { result: makeIdb(stores), onsuccess: null, onerror: null };
      setTimeout(() => r.onsuccess && r.onsuccess(), 0); return r; } },
    Date: new Proxy(RealDate, {
      construct: (t, a) => (a.length ? new t(...a) : new t(fixed)),
      get: (t, p) => (p === 'now' ? () => fixed : t[p])
    }),
    setTimeout, clearTimeout, Promise, Object, String, Number, Math, JSON, Array,
    self: {
      addEventListener: () => {},
      registration: {
        showNotification: (title, opts) => { shown.push({ title, body: opts.body }); }
      },
      clients: { matchAll: () => Promise.resolve([]) },
      skipWaiting: () => {}, caches: undefined
    },
    caches: { open: () => Promise.resolve({}), keys: () => Promise.resolve([]) },
    fetch: () => Promise.resolve()
  };
  ctx.self.location = { href: 'https://x/app/sw.js' };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.reminderCheck().then(() => shown);
}

const AWT = { user: { name: 'K. Rajitha', cadre: 'AWT', awcId: 'A0001' },
  config: { schedule: { late_after: '09:30' } } };
const AWH = { user: { name: 'M. Sunitha', cadre: 'AWH', awcId: 'A0001' },
  config: { schedule: { late_after: '09:30' } } };
const D = '20260902';
const IN = (uid) => ({ key: uid + '_' + D + '_IN', awcId: 'A0001' });
const RPT = (uid) => ({ key: uid + '_' + D + '_RPT', awcId: 'A0001' });

(async () => {
  console.log('\n-- the report reminder --');

  let n = await run('2026-09-02T12:00:00+05:30',
    { accounts: { U1: AWT }, rows: [IN('U1')] });
  check('a Teacher who has not filed is reminded, and told what it needs',
    n.length === 1 && /report is pending/.test(n[0].body) && /stock register/.test(n[0].body),
    JSON.stringify(n));
  check('the notification is titled for the task, not the app',
    n.length === 1 && n[0].title === 'Daily report pending', JSON.stringify(n[0] && n[0].title));

  n = await run('2026-09-02T12:00:00+05:30',
    { accounts: { U1: AWT }, rows: [IN('U1'), RPT('U1')] });
  check('a Teacher who has filed is not reminded', n.length === 0, JSON.stringify(n));

  // The regression this file was written for.
  n = await run('2026-09-02T12:00:00+05:30',
    { accounts: { U1: AWT }, rows: [IN('U1'), RPT('U2')] });
  check('nor when her HELPER filed it — the report belongs to the centre',
    n.length === 0, JSON.stringify(n));

  n = await run('2026-09-02T12:00:00+05:30',
    { accounts: { U1: AWH }, rows: [IN('U1')] });
  check('a Helper is never asked for the report — it is not her duty',
    !n.some(x => /report/.test(x.body)), JSON.stringify(n));

  n = await run('2026-09-02T10:00:00+05:30',
    { accounts: { U1: AWT }, rows: [IN('U1')] });
  check('nothing before 10:30 — the centre day has barely started',
    !n.some(x => /report/.test(x.body)), JSON.stringify(n));

  n = await run('2026-09-02T10:45:00+05:30',
    { accounts: { U1: AWT }, rows: [IN('U1')] });
  check('but at 10:45 yes — while she is at the centre, not at closing time',
    n.some(x => /report is pending/.test(x.body)), JSON.stringify(n));

  n = await run('2026-09-02T12:00:00+05:30',
    { accounts: { U1: AWT }, rows: [] });
  check('a Teacher who has not marked IN is asked for IN, not the report',
    n.length === 1 && /marked IN/.test(n[0].body), JSON.stringify(n));

  console.log('\n-- not becoming noise --');

  n = await run('2026-09-06T12:00:00+05:30',
    { accounts: { U1: AWT }, rows: [{ key: 'U1_20260906_IN', awcId: 'A0001' }] });
  check('nothing at all on a Sunday', n.length === 0, JSON.stringify(n));

  n = await run('2026-09-02T12:00:00+05:30', {
    accounts: { U1: AWT }, rows: [IN('U1')],
    kv: { 'notified_U1_20260902_RPT': new Date('2026-09-02T11:30:00+05:30').getTime() }
  });
  check('not again within two hours of the last one', n.length === 0, JSON.stringify(n));

  n = await run('2026-09-02T14:00:00+05:30', {
    accounts: { U1: AWT }, rows: [IN('U1')],
    kv: { 'notified_U1_20260902_RPT': new Date('2026-09-02T11:30:00+05:30').getTime() }
  });
  check('but again after two hours, while the report is still pending',
    n.length === 1, JSON.stringify(n));

  n = await run('2026-09-02T20:00:00+05:30',
    { accounts: { U1: AWT }, rows: [IN('U1')] });
  check('and never at 20:00 — the working day is over',
    !n.some(x => /report/.test(x.body)), JSON.stringify(n));

  console.log('\n-- the reminder has to be able to reach her --');
  check('the page nudges on open, not only on a 15-minute timer',
    /nudgeReminders\(\);/.test(app) && /setInterval\(nudgeReminders/.test(app));
  check('and again whenever the app returns to the foreground',
    /visibilitychange[\s\S]{0,120}nudgeReminders\(\)/.test(app));
  check('falling back to the active worker when none controls the page yet',
    /sw\.ready\.then\(reg =>[\s\S]{0,120}reg\.active\.postMessage/.test(app));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS FAILED', e); process.exit(1); });
