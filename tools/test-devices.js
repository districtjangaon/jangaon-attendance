// tools/test-devices.js — run with:  node tools/test-devices.js
//
// Runs backend/Util.gs + Auth.gs + Devices.gs in a stubbed Apps Script scope
// against fake Users / DeviceRequests / Sessions / Audit sheets.
//
// The phone-approval queue is where a blocked Anganwadi worker waits, so two
// things are checked here. First, that a decision really lands: the request
// closes, the binding clears, her live sessions are revoked and the audit
// names the phone that was released. Second, that deciding sixty of them
// costs the same number of Sheets writes as deciding three — the whole point
// of the bulk path is that it does not hold the script lock while 400 phones
// sync behind it.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ------------------------------------------------------------- fake Sheets
let sheetCalls = { read: 0, write: 0, append: 0 };

function FakeSheet(header) {
  this.rows = [header.slice()];
}
FakeSheet.prototype.getLastRow = function () { return this.rows.length; };
FakeSheet.prototype.getMaxRows = function () { return this.rows.length + 100; };
FakeSheet.prototype.getMaxColumns = function () { return this.rows[0].length; };
FakeSheet.prototype.insertColumnsAfter = function () { return this; };
FakeSheet.prototype.appendRow = function (r) { sheetCalls.append++; this.rows.push(r.slice()); };
FakeSheet.prototype.getRange = function (r, c, nr, nc) {
  const sh = this;
  nr = nr == null ? 1 : nr;
  nc = nc == null ? 1 : nc;
  const cell = (i, j) => {
    const row = sh.rows[r - 1 + i] || [];
    return row[c - 1 + j] == null ? '' : row[c - 1 + j];
  };
  return {
    getValues: function () {
      sheetCalls.read++;
      const out = [];
      for (let i = 0; i < nr; i++) {
        const line = [];
        for (let j = 0; j < nc; j++) line.push(cell(i, j));
        out.push(line);
      }
      return out;
    },
    setValues: function (vals) {
      sheetCalls.write++;
      if (vals.length !== nr || vals[0].length !== nc) {
        throw new Error('setValues shape ' + vals.length + 'x' + vals[0].length +
          ' does not match range ' + nr + 'x' + nc);
      }
      for (let i = 0; i < nr; i++) {
        while (sh.rows.length < r + i) sh.rows.push([]);
        const row = sh.rows[r - 1 + i] || (sh.rows[r - 1 + i] = []);
        for (let j = 0; j < nc; j++) row[c - 1 + j] = vals[i][j];
      }
    },
    getValue: function () { sheetCalls.read++; return cell(0, 0); },
    setValue: function (v) {
      sheetCalls.write++;
      const row = sh.rows[r - 1] || (sh.rows[r - 1] = []);
      row[c - 1] = v;
    },
    setNumberFormat: function () { return this; },
    // findRowByValue_ / findRowsByValue_ search through a TextFinder, so the
    // harness has to answer one. matchEntireCell(true) is the only mode the
    // backend uses, and exact string equality is exactly what it means.
    createTextFinder: function (needle) {
      const hits = () => {
        const out = [];
        for (let i = 0; i < nr; i++) {
          for (let j = 0; j < nc; j++) {
            if (String(cell(i, j)) === String(needle)) out.push({ getRow: () => r + i });
          }
        }
        return out;
      };
      const api = {
        matchEntireCell: () => api,
        findNext: () => hits()[0] || null,
        findAll: () => hits()
      };
      return api;
    }
  };
};

let SHEETS = {};
const ctx = {
  console, JSON, Math, Date, String, Number, Array, Object, isFinite, RegExp,
  LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
  Utilities: {
    getUuid: (() => { let n = 0; return () => 'req-' + (++n); })(),
    formatDate: (d, tz, pattern) => {
      const t = new Date(new Date(d).getTime() + 5.5 * 3600000);
      return String(pattern) === 'yyyy-MM-dd'
        ? t.toISOString().slice(0, 10)
        : t.toISOString().replace('Z', '+05:30');
    },
    computeHmacSha256Signature: () => [1, 2, 3],
    base64EncodeWebSafe: s => Buffer.from(String(s)).toString('base64'),
    base64DecodeWebSafe: s => Array.from(Buffer.from(String(s), 'base64')),
    newBlob: b => ({ getDataAsString: () => String(b) }),
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    computeDigest: () => [1, 2, 3]
  },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) },
  CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {},
    putAll: () => {}, getAll: () => ({}) }) },
  SpreadsheetApp: { openById: () => { throw new Error('no live spreadsheet in this harness'); } },
  DriveApp: {},
  Session: { getScriptTimeZone: () => 'Asia/Kolkata' }
};
vm.createContext(ctx);
const load = f => vm.runInContext(fs.readFileSync(path.join(ROOT, 'backend', f), 'utf8'), ctx);
const g = expr => vm.runInContext(expr, ctx);

load('Util.gs');
// Util.gs brings the real masterSS_, which would reach for a live spreadsheet.
ctx.masterSS_ = () => ({
  getSheetByName: n => SHEETS[n] || null,
  insertSheet: n => (SHEETS[n] = new FakeSheet(n === 'DeviceRequests' ? g('DEVREQ_H') : []))
});
load('Auth.gs');
// Admin.gs is not loaded: it is the authorisation layer these routes call
// into, and the harness supplies it so the test can drive each role directly.
ctx.isConsoleRole_ = u => ['ADMIN', 'CDPO', 'SUPERVISOR'].indexOf(String(u.role)) >= 0;
ctx.deny_ = () => ({ ok: false, code: 'FORBIDDEN' });
ctx.sectorScope_ = u => (String(u.role) === 'ADMIN' ? null : [String(u.sector_code)]);
ctx.inScope_ = (actor, target) => String(actor.role) === 'ADMIN' ||
  (String(actor.role) === 'SUPERVISOR' && String(target.sector_code) === String(actor.sector_code) &&
    String(target.role) === 'FIELD');
load('Devices.gs');

const USERS_H = g('USERS_H'), DEVREQ_H = g('DEVREQ_H'), SESS_H = g('SESS_H'), AUD_H = g('AUD_H');
const U_ = g('U_');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond || !detail ? '' : '\n         ' + detail));
  cond ? pass++ : fail++;
}

// --------------------------------------------------------------- fixtures
const ADMIN = { user_id: 'U_ADMIN', name: 'Collector', role: 'ADMIN', sector_code: '' };
const SUP01 = { user_id: 'U_SUP', name: 'Supervisor S01', role: 'SUPERVISOR', sector_code: 'S01' };

/** n field workers in a sector, each bound to a phone and holding a session. */
function seed(n, sector) {
  SHEETS = {
    Users: new FakeSheet(USERS_H),
    DeviceRequests: new FakeSheet(DEVREQ_H),
    Sessions: new FakeSheet(SESS_H),
    Audit: new FakeSheet(AUD_H)
  };
  const ids = [];
  for (let i = 1; i <= n; i++) {
    const uid = 'U' + i;
    ids.push(uid);
    const row = new Array(USERS_H.length).fill('');
    row[U_.user_id] = uid;
    row[U_.phone] = '90000000' + String(i).padStart(2, '0');
    row[U_.name] = 'Worker ' + i;
    row[U_.cadre] = i % 2 ? 'AWT' : 'AWH';
    row[U_.sector_code] = sector || 'S01';
    row[U_.awc_id] = 'A' + i;
    row[U_.role] = 'FIELD';
    row[U_.status] = 'ACTIVE';
    row[U_.device_id] = 'OLD-PHONE-' + i;
    row[U_.device_bound_at] = '2026-08-01T09:00:00+05:30';
    row[U_.created_at] = '2026-07-01T09:00:00+05:30';
    SHEETS.Users.rows.push(row);
    SHEETS.Sessions.rows.push(['tok-' + uid, uid, 'OLD-PHONE-' + i,
      '2026-09-01T09:00:00+05:30', '2026-12-01T09:00:00+05:30', '']);
    SHEETS.DeviceRequests.rows.push(['req-' + uid, uid, 'Worker ' + i, i % 2 ? 'AWT' : 'AWH',
      '90000000' + String(i).padStart(2, '0'), sector || 'S01', 'A' + i,
      'NEW-PHONE-' + i, 'DEVICE_MISMATCH', '2026-09-19T08:10:00+05:30', 'PENDING', '', '']);
  }
  sheetCalls = { read: 0, write: 0, append: 0 };
  return ids;
}

const userRow = uid => SHEETS.Users.rows.find(r => r[U_.user_id] === uid);
const reqRow = id => SHEETS.DeviceRequests.rows.find(r => r[0] === id);
const auditRows = () => SHEETS.Audit.rows.slice(1);
const sessionOf = uid => SHEETS.Sessions.rows.find(r => r[1] === uid);

// ------------------------------------------------------- the single decision
console.log('\none decision at a time');
seed(2);
let r = ctx.apiDeviceRequestDecide_({ userId: 'U_ADMIN', user: ADMIN },
  { id: 'req-U1', decision: 'APPROVED' });
check('an admin can approve', r.ok === true, JSON.stringify(r));
check('the request is closed as APPROVED', reqRow('req-U1')[10] === 'APPROVED', JSON.stringify(reqRow('req-U1')));
check('and stamped with who decided it', reqRow('req-U1')[11] === 'U_ADMIN');
check('her phone binding is cleared', userRow('U1')[U_.device_id] === '', JSON.stringify(userRow('U1')[U_.device_id]));
check('her live session is revoked', String(sessionOf('U1')[5]) === 'TRUE');
check('the audit names the phone she was bound to',
  auditRows()[0][2] === 'DEVICE_REBIND_APPROVED' && auditRows()[0][4] === 'OLD-PHONE-1',
  JSON.stringify(auditRows()[0]));
check('nobody else was touched', userRow('U2')[U_.device_id] === 'OLD-PHONE-2');

r = ctx.apiDeviceRequestDecide_({ userId: 'U_ADMIN', user: ADMIN },
  { id: 'req-U1', decision: 'APPROVED' });
check('deciding it twice is refused', r.ok === false && r.code === 'ALREADY_DECIDED', JSON.stringify(r));

seed(1, 'S99');
r = ctx.apiDeviceRequestDecide_({ userId: 'U_SUP', user: SUP01 },
  { id: 'req-U1', decision: 'APPROVED' });
check('a supervisor cannot decide another sector', r.ok === false && r.code === 'FORBIDDEN',
  JSON.stringify(r));
check('and that worker is still bound', userRow('U1')[U_.device_id] === 'OLD-PHONE-1');

// ------------------------------------------------------------- the whole queue
console.log('\nthe whole queue in one go');
seed(3);
r = ctx.apiDeviceRequestDecideBulk_({ userId: 'U_ADMIN', user: ADMIN },
  { ids: ['req-U1', 'req-U2', 'req-U3'], decision: 'APPROVED' });
check('all three are approved', r.ok === true && r.changed === 3, JSON.stringify(r));
check('nothing was skipped', r.skipped.length === 0, JSON.stringify(r.skipped));
check('every request row is closed',
  ['req-U1', 'req-U2', 'req-U3'].every(id => reqRow(id)[10] === 'APPROVED'));
check('every binding is cleared',
  ['U1', 'U2', 'U3'].every(u => userRow(u)[U_.device_id] === '' && userRow(u)[U_.device_bound_at] === ''));
check('created_at is written back untouched, not blanked',
  userRow('U2')[U_.created_at] === '2026-07-01T09:00:00+05:30', JSON.stringify(userRow('U2')[U_.created_at]));
check('updated_at is stamped', String(userRow('U2')[U_.updated_at]).slice(0, 4) === '20' + new Date().getFullYear().toString().slice(2, 4));
check('every session is revoked', ['U1', 'U2', 'U3'].every(u => String(sessionOf(u)[5]) === 'TRUE'));
check('one audit row per decision', auditRows().length === 3, JSON.stringify(auditRows().length));
check('each audit row names that worker\'s old phone',
  auditRows().every(a => a[4] === 'OLD-PHONE-' + a[3].slice(1)), JSON.stringify(auditRows()));

// The property that matters at scale: the write count is fixed, not per row.
const writesFor = n => {
  seed(n);
  const ids = [];
  for (let i = 1; i <= n; i++) ids.push('req-U' + i);
  ctx.apiDeviceRequestDecideBulk_({ userId: 'U_ADMIN', user: ADMIN },
    { ids: ids, decision: 'APPROVED' });
  return sheetCalls.write + sheetCalls.append;
};
const w3 = writesFor(3), w60 = writesFor(60);
check('60 approvals cost the same Sheets writes as 3', w3 === w60, w3 + ' vs ' + w60);
check('and that is a handful, not hundreds', w60 <= 6, String(w60));

// Compare with the single path, which is what the console used to do 60 times.
seed(60);
let singleWrites = 0;
for (let i = 1; i <= 60; i++) {
  sheetCalls = { read: 0, write: 0, append: 0 };
  ctx.apiDeviceRequestDecide_({ userId: 'U_ADMIN', user: ADMIN },
    { id: 'req-U' + i, decision: 'APPROVED' });
  singleWrites += sheetCalls.write + sheetCalls.append;
}
check('one at a time would have cost far more', singleWrites > 10 * w60,
  singleWrites + ' writes one at a time vs ' + w60 + ' in bulk');

console.log('\nwhat the sweep refuses to take on trust');
seed(3);
SHEETS.DeviceRequests.rows[2][10] = 'REJECTED';           // U2 already decided
SHEETS.Users.rows[3][U_.sector_code] = 'S99';             // U3 out of a supervisor's sector
r = ctx.apiDeviceRequestDecideBulk_({ userId: 'U_SUP', user: SUP01 },
  { ids: ['req-U1', 'req-U2', 'req-U3', 'req-NOPE'], decision: 'APPROVED' });
check('only the one live, in-scope request moves', r.changed === 1, JSON.stringify(r));
const why = {};
r.skipped.forEach(s => { why[s.id] = s.why; });
check('an already-decided request is skipped, not re-decided', why['req-U2'] === 'ALREADY_DECIDED', JSON.stringify(why));
check('another sector is skipped as out of scope', why['req-U3'] === 'OUT_OF_SCOPE', JSON.stringify(why));
check('an id that does not exist is skipped', why['req-NOPE'] === 'NOT_FOUND', JSON.stringify(why));
check('the out-of-scope worker keeps her binding', userRow('U3')[U_.device_id] === 'OLD-PHONE-3');
check('the already-decided row keeps its old decision', reqRow('req-U2')[10] === 'REJECTED');

console.log('\nrejecting in bulk changes nothing but the queue');
seed(2);
r = ctx.apiDeviceRequestDecideBulk_({ userId: 'U_ADMIN', user: ADMIN },
  { ids: ['req-U1', 'req-U2'], decision: 'REJECTED' });
check('both are rejected', r.ok === true && r.changed === 2, JSON.stringify(r));
check('bindings are untouched', ['U1', 'U2'].every(u => userRow(u)[U_.device_id] === 'OLD-PHONE-' + u.slice(1)));
check('sessions are untouched', ['U1', 'U2'].every(u => String(sessionOf(u)[5]) !== 'TRUE'));
check('the audit records the phone she asked for',
  auditRows()[0][2] === 'DEVICE_REBIND_REJECTED' && auditRows()[0][4] === 'NEW-PHONE-1',
  JSON.stringify(auditRows()[0]));

console.log('\nguards');
seed(2);
check('a field worker cannot sweep the queue',
  ctx.apiDeviceRequestDecideBulk_({ userId: 'U1', user: { user_id: 'U1', role: 'FIELD' } },
    { ids: ['req-U1'], decision: 'APPROVED' }).code === 'FORBIDDEN');
check('an empty selection is refused',
  ctx.apiDeviceRequestDecideBulk_({ userId: 'U_ADMIN', user: ADMIN },
    { ids: [], decision: 'APPROVED' }).code === 'NOTHING_SELECTED');
check('a decision that is neither approve nor reject is refused',
  ctx.apiDeviceRequestDecideBulk_({ userId: 'U_ADMIN', user: ADMIN },
    { ids: ['req-U1'], decision: 'MAYBE' }).code === 'BAD_DECISION');
const many = [];
for (let i = 0; i < g('DEVREQ_BULK_MAX') + 1; i++) many.push('req-U1');
check('a selection past the cap is refused',
  ctx.apiDeviceRequestDecideBulk_({ userId: 'U_ADMIN', user: ADMIN },
    { ids: many, decision: 'APPROVED' }).code === 'TOO_MANY');
check('and the queue is untouched after every refusal', reqRow('req-U1')[10] === 'PENDING');

console.log('\nthe list the office reads');
seed(3);
SHEETS.DeviceRequests.rows[2][10] = 'APPROVED';
r = ctx.apiDeviceRequestList_({ userId: 'U_ADMIN', user: ADMIN }, {});
check('only pending requests are listed', r.requests.length === 2, JSON.stringify(r.requests.map(x => x.id)));
check('each carries the id the buttons post back',
  r.requests.every(x => x.id && reqRow(x.id)), JSON.stringify(r.requests.map(x => x.id)));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
