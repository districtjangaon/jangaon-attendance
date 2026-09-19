// tools/test-cache.js — run with:  node tools/test-cache.js
//
// Runs backend/Util.gs in a stubbed Apps Script scope against a CacheService
// fake that enforces the REAL 100 KB per-value limit.
//
// This is the regression test for 2026-09-15: the Leaves table grew past
// 100 KB, CACHE.put threw "Argument too large: value" inside getLeavesAll_(),
// and because nothing caught it summaryTick died on every run — the console
// showed 08:55 data for eleven hours while marking carried on normally.
// Two rules are checked: a payload of any size round-trips through the
// chunked helpers, and a cache that cannot store it still never throws.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ------------------------------------------------------------- fake cache
// Apps Script measures the value in BYTES, so a Telugu payload hits the wall
// at a third of the character count. The fake measures it the same way.
const LIMIT = 100 * 1024;
let store = {};
let writes = 0;
let putAllThrows = false;

const bytes = s => Buffer.byteLength(String(s), 'utf8');

const fakeCache = {
  get: k => (k in store ? store[k] : null),
  getAll: keys => {
    const o = {};
    keys.forEach(k => { if (k in store) o[k] = store[k]; });
    return o;
  },
  put: (k, v) => {
    if (bytes(v) > LIMIT) throw new Error('Argument too large: value');
    writes++;
    store[k] = String(v);
  },
  putAll: (values) => {
    if (putAllThrows) throw new Error('cache unavailable');
    Object.keys(values).forEach(k => {
      if (bytes(values[k]) > LIMIT) throw new Error('Argument too large: value');
    });
    Object.keys(values).forEach(k => { writes++; store[k] = String(values[k]); });
  },
  remove: k => { delete store[k]; }
};

const ctx = {
  console, JSON, Math, Date, String, Number, Array, Object, isFinite, RegExp, Buffer,
  LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
  Utilities: { getUuid: () => 'abcdefgh-0000-0000-0000-000000000000',
    formatDate: (d) => new Date(d).toISOString().slice(0, 10) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) },
  CacheService: { getScriptCache: () => fakeCache },
  SpreadsheetApp: { openById: () => { throw new Error('no live spreadsheet in this harness'); } },
  DriveApp: {},
  Session: { getScriptTimeZone: () => 'Asia/Kolkata' }
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'backend', 'Util.gs'), 'utf8'), ctx);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond || !detail ? '' : '\n         ' + detail));
  cond ? pass++ : fail++;
}

/** A leaves-shaped payload of roughly the requested size. */
function payload(approxBytes, reason) {
  const rows = [];
  for (let i = 0; rows.join('').length < approxBytes; i++) {
    rows.push(JSON.stringify({
      leave_id: 'LV-2026-' + i, user_id: 'U' + (1000 + i), from_date: '2026-09-15',
      to_date: '2026-09-16', type: 'CASUAL', status: 'APPROVED',
      reason: reason || 'personal work at home', decided_by: 'U9001',
      decided_at: '2026-09-14T11:02:00+05:30', _row: i + 2
    }));
  }
  return '[' + rows.join(',') + ']';
}

console.log('\nthe outage, reproduced');
const big = payload(300000);
let threw = null;
try { fakeCache.put('leaves', big); } catch (err) { threw = String(err.message); }
check('a 300 KB payload through plain CACHE.put throws the live error',
  threw === 'Argument too large: value', String(threw));

console.log('\nchunked round trip');
store = {}; writes = 0;
ctx.cachePutBig_('leaves', big, 300);
check('it was stored', Object.keys(store).length > 1, Object.keys(store).length + ' keys');
check('no single chunk is over the 100 KB limit',
  Object.keys(store).every(k => bytes(store[k]) <= LIMIT),
  JSON.stringify(Object.keys(store).map(k => bytes(store[k]))));
check('and it reads back byte-for-byte', ctx.cacheGetBig_('leaves') === big,
  'got ' + String(ctx.cacheGetBig_('leaves')).length + ' of ' + big.length + ' chars');
check('the parsed result is the same list',
  JSON.parse(ctx.cacheGetBig_('leaves')).length === JSON.parse(big).length);

console.log('\nTelugu reasons — three bytes a character');
store = {};
const telugu = payload(200000, 'ఇంటి వద్ద వ్యక్తిగత పని ఉన్నందున సెలవు కావాలి');
ctx.cachePutBig_('leaves', telugu, 300);
check('no chunk is over the limit in bytes either',
  Object.keys(store).every(k => bytes(store[k]) <= LIMIT),
  JSON.stringify(Object.keys(store).map(k => bytes(store[k]))));
check('and it survives the round trip intact', ctx.cacheGetBig_('leaves') === telugu);

console.log('\na cache miss must look like a miss, never like corrupt data');
store = {};
ctx.cachePutBig_('leaves', big, 300);
delete store['leaves~2'];                       // one chunk evicted mid-flight
check('a lost chunk reads as null, not as a short list',
  ctx.cacheGetBig_('leaves') === null, JSON.stringify(ctx.cacheGetBig_('leaves')).slice(0, 80));
store = {};
check('an empty cache reads as null', ctx.cacheGetBig_('leaves') === null);

console.log('\na cache that cannot store it must not fail the caller');
store = {}; putAllThrows = true;
let boom = null;
try { ctx.cachePutBig_('leaves', big, 300); } catch (err) { boom = err; }
check('a throwing cache service is swallowed', boom === null, String(boom));
check('and the next read is a clean miss', ctx.cacheGetBig_('leaves') === null);
putAllThrows = false;

console.log('\nbeyond what is worth caching');
store = {};
store['leaves'] = 'chunks:3';                   // a stale count from a smaller day
const huge = payload(41 * 30000 * 1.1);
boom = null;
try { ctx.cachePutBig_('leaves', huge, 300); } catch (err) { boom = err; }
check('an oversized payload is skipped, not thrown', boom === null, String(boom));
check('and the stale chunk count is cleared, so the read is a miss',
  ctx.cacheGetBig_('leaves') === null, JSON.stringify(store['leaves']));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
