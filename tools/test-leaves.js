// tools/test-leaves.js — run with:  node tools/test-leaves.js
//
// Runs backend/Util.gs + backend/Leaves.gs in a stubbed Apps Script scope.
// Two rules are checked here because both touch people directly: an
// application cannot be filed without a stated reason, and a bulk decision
// must re-apply every per-leave guard a single decision applies — while
// writing the sheet in a fixed number of calls, not one per leave.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ------------------------------------------------------------- fake Sheets
// Counts its own API calls: the whole point of the bulk path is that 300
// decisions cost two Sheets round trips, not six hundred.
let sheetCalls = { read: 0, write: 0, append: 0 };

function FakeSheet(header) {
  this.rows = [header.slice()];
}
FakeSheet.prototype.getLastRow = function () { return this.rows.length; };
FakeSheet.prototype.getMaxRows = function () { return this.rows.length + 100; };
FakeSheet.prototype.appendRow = function (r) { sheetCalls.append++; this.rows.push(r.slice()); };
FakeSheet.prototype.getRange = function (r, c, nr, nc) {
  const sh = this;
  nr = nr == null ? 1 : nr;
  nc = nc == null ? 1 : nc;
  return {
    getValues: function () {
      sheetCalls.read++;
      const out = [];
      for (let i = 0; i < nr; i++) {
        const row = sh.rows[r - 1 + i] || [];
        const line = [];
        for (let j = 0; j < nc; j++) line.push(row[c - 1 + j] == null ? '' : row[c - 1 + j]);
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
    getValue: function () { sheetCalls.read++; return (sh.rows[r - 1] || [])[c - 1]; },
    setValue: function (v) {
      sheetCalls.write++;
      const row = sh.rows[r - 1] || (sh.rows[r - 1] = []);
      row[c - 1] = v;
    },
    setNumberFormat: function () { return this; }
  };
};

const LEAVE_HEADER = ['leave_id', 'user_id', 'from_date', 'to_date', 'type', 'reason',
  'status', 'applied_at', 'decided_by', 'decided_at',
  'med_institution', 'med_cert_no', 'med_photo_id'];
const AUDIT_HEADER = ['ts', 'actor', 'action', 'target', 'old_value', 'new_value'];

let SHEETS = {};
function resetSheets() {
  SHEETS = { Leaves: new FakeSheet(LEAVE_HEADER), Audit: new FakeSheet(AUDIT_HEADER) };
  sheetCalls = { read: 0, write: 0, append: 0 };
}
resetSheets();

// -------------------------------------------------------------- fake users
const USERS = {
  U_ADMIN: { user_id: 'U_ADMIN', name: 'Add.Collector Rev', role: 'ADMIN', sector_code: '', can_approve_leave: '' },
  U_NOPOWER: { user_id: 'U_NOPOWER', name: 'Officer', role: 'ADMIN', sector_code: '', can_approve_leave: '0' },
  U_SUP: { user_id: 'U_SUP', name: 'Supervisor', role: 'SUPERVISOR', sector_code: 'S01' },
  U1: { user_id: 'U1', name: 'K. Padma', role: 'FIELD', sector_code: 'S01' },
  U2: { user_id: 'U2', name: 'B. Swapna', role: 'FIELD', sector_code: 'S01' },
  U3: { user_id: 'U3', name: 'M. Lalitha', role: 'FIELD', sector_code: 'S01' },
  U_FAR: { user_id: 'U_FAR', name: 'T. Anitha', role: 'FIELD', sector_code: 'S99' }
};

let inScopeImpl = () => true;

const ctx = {
  console, JSON, Math, Date, String, Number, Array, Object, isFinite, RegExp,
  LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
  Utilities: {
    getUuid: () => 'abcdefgh-0000-0000-0000-000000000000',
    // Enough of the pattern language for the two shapes these paths use:
    // a plain day, and the full timestamp that lands in decided_at.
    formatDate: (d, tz, pattern) => String(pattern) === 'yyyy-MM-dd'
      ? new Date(d).toISOString().slice(0, 10)
      : new Date(d).toISOString().replace('Z', '+05:30')
  },
  // Util.gs builds PROPS and CACHE from these itself, so they are stubbed at
  // the service level rather than replaced afterwards.
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) },
  CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
  SpreadsheetApp: { openById: () => { throw new Error('no live spreadsheet in this harness'); } },
  DriveApp: {},
  Session: { getScriptTimeZone: () => 'Asia/Kolkata' },
  masterSS_: () => ({ getSheetByName: n => SHEETS[n] || null, insertSheet: n => (SHEETS[n] = new FakeSheet([])) }),
  getUserById_: id => USERS[String(id)] || null,
  inScope_: (a, b) => inScopeImpl(a, b),
  deny_: () => ({ ok: false, code: 'FORBIDDEN' }),   // same shape as Admin.gs
  isConsoleRole_: u => ['ADMIN', 'CDPO', 'SUPERVISOR'].indexOf(String(u.role)) >= 0,
  storePhoto_: () => 'photo-id',
  OPTIONAL_HOLIDAYS: {}
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'backend', 'Util.gs'), 'utf8'), ctx);
// Util.gs brings the REAL masterSS_ and getUserById_, which would reach for a
// live spreadsheet. Put the fakes back before Leaves.gs is loaded.
ctx.masterSS_ = () => ({
  getSheetByName: n => SHEETS[n] || null,
  insertSheet: n => (SHEETS[n] = new FakeSheet([]))
});
ctx.getUserById_ = id => USERS[String(id)] || null;
vm.runInContext(fs.readFileSync(path.join(ROOT, 'backend', 'Leaves.gs'), 'utf8'), ctx);

// Top-level `const` in a vm script is a lexical binding, not a property of the
// context, so constants are read by evaluating their name.
const g = expr => vm.runInContext(expr, ctx);

// The harness must not drift from the real header.
if (g('LEAVE_H').join(',') !== LEAVE_HEADER.join(',')) {
  console.log('DRIFT: LEAVE_H changed in Util.gs — update this harness');
  console.log('  real: ' + g('LEAVE_H').join(','));
  process.exit(1);
}

let pass = 0, fail = 0;
function check(label, cond, detail) {
  console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond || !detail ? '' : '\n         ' + detail));
  cond ? pass++ : fail++;
}

const today = new Date().toISOString().slice(0, 10);
const plus = d => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

/** Put a leave straight into the sheet, bypassing the application rules. */
function seed(id, user, status, from, to) {
  SHEETS.Leaves.rows.push([id, user, from || today, to || today, 'CASUAL', 'seeded',
    status, '2026-08-01T09:00:00+05:30', '', '', '', '', '']);
}

// ============================================================ reason gate
console.log('\nA leave application must say why');
resetSheets();
const apply = (reason) => ctx.apiLeaveApply_({ userId: 'U1', user: USERS.U1 },
  { from: plus(1), to: plus(1), type: 'CASUAL', reason: reason });

let r = apply('');
check('a blank reason is refused', r.ok === false && r.code === 'REASON_REQUIRED', JSON.stringify(r));
check('and the form is told the minimum', r.minChars === g('LEAVE_MIN_REASON'), JSON.stringify(r));
r = apply('.');
check('a single full stop is refused', r.code === 'REASON_REQUIRED', JSON.stringify(r));
r = apply('  x  ');
check('whitespace around one character is refused', r.code === 'REASON_REQUIRED', JSON.stringify(r));

resetSheets();
r = apply('flu');
check('a short but real reason is accepted', r.ok === true, JSON.stringify(r));
check('and it reaches the sheet verbatim',
  SHEETS.Leaves.rows[1] && SHEETS.Leaves.rows[1][5] === 'flu',
  JSON.stringify(SHEETS.Leaves.rows[1]));
check('the application is PENDING, not auto-approved',
  SHEETS.Leaves.rows[1] && SHEETS.Leaves.rows[1][6] === 'PENDING');

// A bad date must still surface as a date problem, not as a reason problem.
resetSheets();
r = ctx.apiLeaveApply_({ userId: 'U1', user: USERS.U1 },
  { from: 'not-a-date', to: 'not-a-date', type: 'CASUAL', reason: '' });
check('a broken date is still reported as a date problem', r.code === 'BAD_DATE', JSON.stringify(r));

// ============================================================ bulk decide
console.log('\nDeciding a whole selection at once');
const admin = { userId: 'U_ADMIN', user: USERS.U_ADMIN };

resetSheets();
seed('LV-1', 'U1', 'PENDING');
seed('LV-2', 'U2', 'PENDING');
seed('LV-3', 'U3', 'PENDING');
r = ctx.apiLeaveDecideBulk_({ userId: 'U_SUP', user: USERS.U_SUP },
  { leaveIds: 'LV-1,LV-2', decision: 'APPROVED' });
check('a supervisor cannot decide in bulk', r.ok === false && r.code === 'FORBIDDEN', JSON.stringify(r));
r = ctx.apiLeaveDecideBulk_({ userId: 'U_NOPOWER', user: USERS.U_NOPOWER },
  { leaveIds: 'LV-1,LV-2', decision: 'APPROVED' });
check('an ADMIN whose leave sanction was withdrawn cannot either',
  r.code === 'NOT_LEAVE_APPROVER', JSON.stringify(r));
check('nothing was written on either refusal', sheetCalls.write === 0, JSON.stringify(sheetCalls));

r = ctx.apiLeaveDecideBulk_(admin, { leaveIds: '', decision: 'APPROVED' });
check('an empty selection is refused', r.code === 'NOTHING_SELECTED', JSON.stringify(r));
r = ctx.apiLeaveDecideBulk_(admin, { leaveIds: 'LV-1', decision: 'MAYBE' });
check('an invented decision is refused', r.code === 'BAD_DECISION', JSON.stringify(r));
const many = [];
for (let i = 0; i < g('LEAVE_BULK_MAX') + 1; i++) many.push('LV-' + i);
r = ctx.apiLeaveDecideBulk_(admin, { leaveIds: many, decision: 'APPROVED' });
check('more than the cap is refused, and says the cap',
  r.code === 'TOO_MANY' && r.max === g('LEAVE_BULK_MAX'), JSON.stringify(r));

console.log('\nThe selection is approved and the trail is complete');
resetSheets();
seed('LV-1', 'U1', 'PENDING');
seed('LV-2', 'U2', 'PENDING');
seed('LV-3', 'U3', 'REJECTED');
seed('LV-4', 'U1', 'APPROVED');
r = ctx.apiLeaveDecideBulk_(admin,
  { leaveIds: ['LV-1', 'LV-2', 'LV-3', 'LV-4'], decision: 'APPROVED', reason: 'sanctioned in review' });
check('the three that could change did', r.ok === true && r.changed === 3,
  JSON.stringify({ ok: r.ok, changed: r.changed }));
check('the one already approved was skipped, not re-decided',
  (r.skipped || []).some(x => x.id === 'LV-4' && x.why === 'ALREADY'), JSON.stringify(r.skipped));
const row = id => SHEETS.Leaves.rows.find(x => x[0] === id);
check('a rejected application can be approved in bulk', row('LV-3')[6] === 'APPROVED');
check('the decider is recorded on every changed row',
  ['LV-1', 'LV-2', 'LV-3'].every(id => row(id)[8] === 'U_ADMIN'),
  ['LV-1', 'LV-2', 'LV-3'].map(id => id + '=' + row(id)[8]).join(' '));
check('and the decision time is recorded',
  ['LV-1', 'LV-2', 'LV-3'].every(id => /^\d{4}-\d{2}-\d{2}T/.test(String(row(id)[9]))),
  row('LV-1')[9]);
check('the untouched row keeps its original decided_by', row('LV-4')[8] === '');
check('applied_at is not clobbered by the column rewrite',
  SHEETS.Leaves.rows.slice(1).every(x => x[7] === '2026-08-01T09:00:00+05:30'),
  JSON.stringify(SHEETS.Leaves.rows.slice(1).map(x => x[7])));
check('the reason column is left alone',
  SHEETS.Leaves.rows.slice(1).every(x => x[5] === 'seeded'));

const audit = SHEETS.Audit.rows.slice(1);
check('one audit row per changed leave', audit.length === 3, JSON.stringify(audit));
check('each audit row names the leave it decided',
  ['LV-1', 'LV-2', 'LV-3'].every(id => audit.some(a => a[3] === id)),
  JSON.stringify(audit.map(a => a[3])));
check('each audit row records the status it held before',
  audit.find(a => a[3] === 'LV-3')[4] === 'REJECTED',
  JSON.stringify(audit.find(a => a[3] === 'LV-3')));
check('the actor is the officer who clicked',
  audit.every(a => a[1] === 'U_ADMIN'));
check('the stated reason rides along', audit.every(a => a[5] === 'sanctioned in review'));

console.log('\nScope is re-checked for every leave in the list');
resetSheets();
inScopeImpl = (actor, target) => String(target.sector_code) !== 'S99';
seed('LV-1', 'U1', 'PENDING');
seed('LV-2', 'U_FAR', 'PENDING');
r = ctx.apiLeaveDecideBulk_(admin, { leaveIds: 'LV-1,LV-2,LV-NOPE', decision: 'APPROVED' });
check('an out-of-scope leave in the list is not decided',
  row('LV-2')[6] === 'PENDING' && r.changed === 1, JSON.stringify(r));
check('and it is reported back, not silently dropped',
  (r.skipped || []).some(x => x.id === 'LV-2' && x.why === 'OUT_OF_SCOPE'), JSON.stringify(r.skipped));
check('an id that does not exist is reported too',
  (r.skipped || []).some(x => x.id === 'LV-NOPE' && x.why === 'NOT_FOUND'), JSON.stringify(r.skipped));
check('the out-of-scope leave left no audit row',
  !SHEETS.Audit.rows.slice(1).some(a => a[3] === 'LV-2'));
inScopeImpl = () => true;

console.log('\nCost does not grow with the size of the selection');
resetSheets();
for (let i = 0; i < 250; i++) seed('LV-' + i, 'U1', 'PENDING');
const ids = [];
for (let i = 0; i < 250; i++) ids.push('LV-' + i);
r = ctx.apiLeaveDecideBulk_(admin, { leaveIds: ids, decision: 'APPROVED' });
check('250 leaves are all decided', r.changed === 250, JSON.stringify({ changed: r.changed }));
check('in a single range write, not one per leave',
  sheetCalls.write === 2, JSON.stringify(sheetCalls) +
  ' (1 for the status block, 1 for the audit rows)');
check('and a single append is never used for the audit',
  sheetCalls.append === 0, JSON.stringify(sheetCalls));
check('every row really carries the decision',
  SHEETS.Leaves.rows.slice(1).every(x => x[6] === 'APPROVED' && x[8] === 'U_ADMIN'));
check('250 audit rows were written', SHEETS.Audit.rows.length - 1 === 250);

// ================================================ optional-holiday cut
console.log('\nOptional holidays: 3 for 2026, the standing 5 otherwise');
check('2026 is cut to three', g('leaveEnt_("2026")').OPTIONAL === 3,
  JSON.stringify(g('leaveEnt_("2026")')));
check('a year with no order keeps the standing five',
  g('leaveEnt_("2025")').OPTIONAL === 5 && g('leaveEnt_("2027")').OPTIONAL === 5,
  JSON.stringify([g('leaveEnt_("2025")').OPTIONAL, g('leaveEnt_("2027")').OPTIONAL]));
check('casual and earned are untouched by the cut',
  g('leaveEnt_("2026")').CASUAL === 6 && g('leaveEnt_("2026")').EARNED === 30,
  JSON.stringify(g('leaveEnt_("2026")')));

// The dates themselves come from Annexure-II; only the COUNT changed.
const OPT_DAYS = Object.keys(g('OPTIONAL_HOLIDAYS')).filter(d => d.slice(0, 4) === '2026');
check('the Annexure-II date list is not touched by the cut', OPT_DAYS.length > 3,
  OPT_DAYS.length + ' listed dates');

// leaveBalances_ works off the current year, so these only mean anything
// while the clock says 2026 - which is the year the order applies to.
const THIS_YEAR = String(new Date().getFullYear());
if (THIS_YEAR === '2026') {
  resetSheets();
  check('a worker who has taken nothing has three optional days',
    g('leaveBalances_("U1")').optional.left === 3 &&
    g('leaveBalances_("U1")').optional.ent === 3,
    JSON.stringify(g('leaveBalances_("U1")').optional));

  // Three already sanctioned: the fourth must be refused.
  resetSheets();
  SHEETS.Leaves.rows.push(['LV-a', 'U1', '2026-01-01', '2026-01-01', 'OPTIONAL', 'festival',
    'APPROVED', '2026-01-01T09:00:00+05:30', 'U_ADMIN', '2026-01-01T10:00:00+05:30', '', '', '']);
  SHEETS.Leaves.rows.push(['LV-b', 'U1', '2026-01-16', '2026-01-16', 'OPTIONAL', 'festival',
    'APPROVED', '2026-01-16T09:00:00+05:30', 'U_ADMIN', '2026-01-16T10:00:00+05:30', '', '', '']);
  SHEETS.Leaves.rows.push(['LV-c', 'U1', '2026-03-10', '2026-03-10', 'OPTIONAL', 'festival',
    'APPROVED', '2026-03-10T09:00:00+05:30', 'U_ADMIN', '2026-03-10T10:00:00+05:30', '', '', '']);
  check('three taken leaves none left', g('leaveBalances_("U1")').optional.left === 0,
    JSON.stringify(g('leaveBalances_("U1")').optional));
  r = ctx.apiLeaveApply_({ userId: 'U1', user: USERS.U1 },
    { from: '2026-12-24', to: '2026-12-24', type: 'OPTIONAL', reason: 'Christmas Eve' });
  check('a fourth optional holiday is refused',
    r.ok === false && r.code === 'NO_BALANCE' && r.type === 'OPTIONAL', JSON.stringify(r));

  // Two taken: the third is still allowed, so the cut does not over-block.
  resetSheets();
  SHEETS.Leaves.rows.push(['LV-a', 'U1', '2026-01-01', '2026-01-01', 'OPTIONAL', 'festival',
    'APPROVED', '2026-01-01T09:00:00+05:30', 'U_ADMIN', '2026-01-01T10:00:00+05:30', '', '', '']);
  SHEETS.Leaves.rows.push(['LV-b', 'U1', '2026-01-16', '2026-01-16', 'OPTIONAL', 'festival',
    'APPROVED', '2026-01-16T09:00:00+05:30', 'U_ADMIN', '2026-01-16T10:00:00+05:30', '', '', '']);
  r = ctx.apiLeaveApply_({ userId: 'U1', user: USERS.U1 },
    { from: '2026-12-24', to: '2026-12-24', type: 'OPTIONAL', reason: 'Christmas Eve' });
  check('the third optional holiday is still allowed', r.ok === true, JSON.stringify(r));

  // Someone who took five before the order: the balance floors at zero
  // rather than going negative, and nothing already sanctioned is withdrawn.
  resetSheets();
  ['2026-01-01', '2026-01-16', '2026-03-10', '2026-08-04', '2026-08-15'].forEach((d, i) => {
    SHEETS.Leaves.rows.push(['LV-' + i, 'U2', d, d, 'OPTIONAL', 'festival',
      'APPROVED', d + 'T09:00:00+05:30', 'U_ADMIN', d + 'T10:00:00+05:30', '', '', '']);
  });
  const b5 = g('leaveBalances_("U2")').optional;
  check('a worker already past the new limit shows zero, never a negative',
    b5.left === 0 && b5.used === 5 && b5.ent === 3, JSON.stringify(b5));
  check('and none of her sanctioned days were withdrawn',
    SHEETS.Leaves.rows.slice(1).every(x => x[6] === 'APPROVED'),
    JSON.stringify(SHEETS.Leaves.rows.slice(1).map(x => x[6])));
} else {
  console.log('  --   balance checks skipped: the order applies to 2026, clock says ' + THIS_YEAR);
}

// ============================================ medical: 15 days per application
console.log('\nMedical leave: no yearly ceiling, but 15 days at a time');
check('the medical span cap is fifteen days', g('LEAVE_MAX_SPAN').SICK === 15,
  JSON.stringify(g('LEAVE_MAX_SPAN')));
check('the other three keep the 31-day form limit',
  g('LEAVE_MAX_SPAN').CASUAL === undefined && g('LEAVE_MAX_SPAN_DEFAULT') === 31,
  JSON.stringify([g('LEAVE_MAX_SPAN'), g('LEAVE_MAX_SPAN_DEFAULT')]));
check('medical is still uncapped over the year',
  g('leaveEnt_("2026")').SICK === undefined, JSON.stringify(g('leaveEnt_("2026")')));

// A sixteen-day spell is refused, and the refusal names the type so the app
// can say "apply again for the rest" instead of the generic form message.
resetSheets();
r = ctx.apiLeaveApply_({ userId: 'U1', user: USERS.U1 }, {
  from: plus(-16), to: plus(-1), type: 'SICK', reason: 'typhoid',
  medInstitution: 'Area Hospital, Jangaon', medCertNo: 'MC/2026/4417', medPhotoB64: 'x'
});
check('sixteen days in one application is refused',
  r.ok === false && r.code === 'TOO_LONG', JSON.stringify(r));
check('and the refusal carries the cap and the type',
  r.maxDays === 15 && r.type === 'SICK', JSON.stringify(r));
check('nothing was written for a refused application', sheetCalls.write === 0 &&
  sheetCalls.append === 0, JSON.stringify(sheetCalls));

// Fifteen days must pass the span gate. The certificate photo would need Drive,
// which this harness has no fake for, so the application is sent WITHOUT the
// photo: reaching MED_PHOTO_REQUIRED proves the span gate let it through.
resetSheets();
r = ctx.apiLeaveApply_({ userId: 'U1', user: USERS.U1 }, {
  from: plus(-15), to: plus(-1), type: 'SICK', reason: 'typhoid',
  medInstitution: 'Area Hospital, Jangaon', medCertNo: 'MC/2026/4417'
});
check('fifteen days passes the span gate',
  r.code === 'MED_PHOTO_REQUIRED', JSON.stringify(r));

// The cap is per application, not per year: a second spell after the first
// is a fresh application and must be judged on its own.
resetSheets();
SHEETS.Leaves.rows.push(['LV-m1', 'U1', plus(-30), plus(-16), 'SICK', 'typhoid',
  'APPROVED', plus(-30) + 'T09:00:00+05:30', 'U_ADMIN', plus(-30) + 'T10:00:00+05:30',
  'Area Hospital, Jangaon', 'MC/2026/4417', '']);
r = ctx.apiLeaveApply_({ userId: 'U1', user: USERS.U1 }, {
  from: plus(-15), to: plus(-1), type: 'SICK', reason: 'typhoid, continuing',
  medInstitution: 'Area Hospital, Jangaon', medCertNo: 'MC/2026/4418'
});
check('a second fifteen-day spell is not blocked by the first',
  r.code === 'MED_PHOTO_REQUIRED', JSON.stringify(r));

// Casual is unaffected by the medical cap.
resetSheets();
r = ctx.apiLeaveApply_({ userId: 'U1', user: USERS.U1 },
  { from: plus(1), to: plus(4), type: 'CASUAL', reason: 'family function' });
check('a four-day casual leave is untouched by the medical cap',
  r.ok === true, JSON.stringify(r));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
