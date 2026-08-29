// Checks the daily attendance email assembles the right figures before it is
// ever pointed at a live mailbox.
//
//   node tools/test-dailyemail.js
//
// Runs backend/DailyEmail.gs in a stubbed Apps Script scope over a fixture
// whose answers are known by hand, so a wrong total fails here rather than in
// the District Collector's inbox.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.dirname(__dirname);

// ------------------------------------------------------------- fixture
// 8 people: 2 marked fully, 1 IN only, 1 OUT only, 1 on leave, 2 not marked
// (one of whom has never marked), 1 supervisor who marked.
const USERS = [
  { user_id: 'U1', name: 'A Teacher', cadre: 'AWT', role: 'FIELD', status: 'ACTIVE',
    project_code: 'JGN', sector_code: 'S01', awc_id: 'A1' },
  { user_id: 'U2', name: 'B Helper', cadre: 'AWH', role: 'FIELD', status: 'ACTIVE',
    project_code: 'JGN', sector_code: 'S01', awc_id: 'A1' },
  { user_id: 'U3', name: 'C Teacher', cadre: 'AWT', role: 'FIELD', status: 'ACTIVE',
    project_code: 'JGN', sector_code: 'S01', awc_id: 'A2' },
  { user_id: 'U4', name: 'D Helper', cadre: 'AWH', role: 'FIELD', status: 'ACTIVE',
    project_code: 'JGN', sector_code: 'S02', awc_id: 'A3' },
  { user_id: 'U5', name: 'E Teacher', cadre: 'AWT', role: 'FIELD', status: 'ACTIVE',
    project_code: 'JGN', sector_code: 'S02', awc_id: 'A3' },
  { user_id: 'U6', name: 'F Helper', cadre: 'AWH', role: 'FIELD', status: 'ACTIVE',
    project_code: 'JGN', sector_code: 'S02', awc_id: 'A4' },
  { user_id: 'U7', name: 'G Never', cadre: 'AWT', role: 'FIELD', status: 'ACTIVE',
    project_code: 'JGN', sector_code: 'S02', awc_id: 'A4' },
  { user_id: 'U8', name: 'H Supervisor', cadre: 'SUPERVISOR', role: 'SUPERVISOR',
    status: 'ACTIVE', project_code: 'JGN', sector_code: 'S01', awc_id: '' },
  { user_id: 'U9', name: 'I Retired', cadre: 'AWT', role: 'FIELD', status: 'INACTIVE',
    project_code: 'JGN', sector_code: 'S01', awc_id: 'A2' }
];

const DAY = '2026-08-27';
const CD = '20260827';
// key, user, sector, cadre, type, client_ts, server_ts, skew, lat, lng, acc,
// geofence, awc, distance, photo, device, ver, net, delay, flags, tz
const mk = (u, type, day, gf, dist, t) => [u + '_' + day + '_' + type, u, 'S01', 'AWT', type,
  day.slice(0, 4) + '-' + day.slice(4, 6) + '-' + day.slice(6, 8) + 'T' + t + ':00+05:30',
  '', 0, 17.7, 79.1, 20, gf, 'A1', dist, 'p', 'd', 'v', 'on', 0, '', 'Asia/Kolkata'];

const MARKS = [
  mk('U1', 'IN', CD, 'INSIDE', 30, '09:10'), mk('U1', 'OUT', CD, 'INSIDE', 25, '16:05'),
  mk('U2', 'IN', CD, 'OUTSIDE', 4200, '09:40'), mk('U2', 'OUT', CD, 'OUTSIDE', 4100, '16:10'),
  mk('U3', 'IN', CD, 'UNVERIFIED', '', '09:20'),
  mk('U4', 'OUT', CD, 'INSIDE', 40, '16:20'),
  mk('U8', 'IN', CD, 'INSIDE', 15, '09:05'),
  // U6 marked on an earlier day only, so has marked before but not today.
  mk('U6', 'IN', '20260826', 'INSIDE', 22, '09:15')
];
const REPORTS = [['U1_' + CD + '_RPT', 'U1', 'S01', 'A1', DAY]];
const LEAVES = [{ user_id: 'U5', type: 'CASUAL', status: 'APPROVED',
  from_date: DAY, to_date: DAY }];

// --------------------------------------------------------------- harness
let pass = 0, fail = 0;
function check(label, cond, detail) {
  console.log((cond ? '  ok   ' : '  FAIL ') + label +
    (cond || !detail ? '' : '\n         ' + detail));
  cond ? pass++ : fail++;
}

const sheet = (rows, width) => ({
  getLastRow: () => rows.length + 1,
  getRange: (r, c, nr, nc) => ({
    getValues: () => rows.slice(r - 2, r - 2 + nr).map(x => {
      const out = x.slice(0, nc);
      while (out.length < nc) out.push('');
      return out;
    }),
    setValues: () => ({ setFontWeight: () => ({ setBackground: () => ({ setFontColor: () => {} }) }) }),
    createFilter: () => {}
  }),
  setName: () => {}, setFrozenRows: () => {}, autoResizeColumns: () => {}
});

const ctx = {
  console, JSON, Math, Date, String, Number, Array, Object, RegExp, isFinite,
  Logger: { log: () => {} },
  Session: { getScriptTimeZone: () => 'Asia/Kolkata', getEffectiveUser: () => ({ getEmail: () => 'x@y' }) },
  Utilities: {
    formatDate: (d, tz, pat) => {
      const t = new Date(new Date(d).getTime() + 5.5 * 3600000);
      if (pat === 'yyyy-MM-dd') return t.toISOString().slice(0, 10);
      if (pat === 'HH:mm') return t.toISOString().slice(11, 16);
      if (pat === 'u') return String(((t.getUTCDay() + 6) % 7) + 1);
      if (pat === 'd MMMM yyyy') return t.getUTCDate() + ' August ' + t.getUTCFullYear();
      return t.toISOString();
    }
  },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) },
  CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
  SpreadsheetApp: { openById: () => { throw new Error('no live spreadsheet'); } },
  DriveApp: {}, MailApp: { sendEmail: () => {} }, ScriptApp: {}, UrlFetchApp: {}
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'backend', 'Util.gs'), 'utf8'), ctx);

// Util.gs brings the real accessors; replace them before DailyEmail.gs loads.
ctx.getUsersAll_ = () => USERS.slice();
// Exactly what backend/Util.gs getSectors_ returns: code, project, name, sup.
// An earlier stub used sector_code, a field that accessor never emits, and so
// hid a lookup that was silently falling back to the bare sector code.
ctx.getSectors_ = () => [
  { code: 'S01', project: 'JGN', name: 'Sector One', sup: '' },
  { code: 'S02', project: 'JGN', name: 'Sector Two', sup: '' }];
ctx.masterSheetRows_ = () => [
  ['A1', 'S01', 'JGN', 'Centre One', 17.7, 79.1, 300, 'TRUE'],
  ['A2', 'S01', 'JGN', 'Centre Two', 17.7, 79.1, 300, 'TRUE'],
  ['A3', 'S02', 'JGN', 'Centre Three', 17.7, 79.1, 300, 'TRUE'],
  ['A4', 'S02', 'JGN', 'Centre Four', 17.7, 79.1, 300, 'TRUE']];
ctx.getMonthSS_ = () => ({
  getSheetByName: n => n === 'Marks' ? sheet(MARKS) : n === 'Reports' ? sheet(REPORTS) : null
});
ctx.leavesOverlapping_ = () => LEAVES.slice();
// Lives in Marks.gs, which this harness does not load. It only heals the
// header and hands back the tab, so returning the tab is the whole contract.
ctx.marksSheet_ = ss => ss.getSheetByName('Marks');
ctx.getHolidays_ = () => ({});
ctx.LEAVE_TYPE_LABEL = { CASUAL: 'Casual Leave', SICK: 'Medical Leave' };

vm.runInContext(fs.readFileSync(path.join(ROOT, 'backend', 'DailyEmail.gs'), 'utf8'), ctx);
const g = e => vm.runInContext(e, ctx);

// ------------------------------------------------------------- the checks
console.log('\nDaily attendance email: assembling the day');
const d = ctx.dailyAttendanceData_(DAY);
const t = d.totals;

check('inactive staff are left off the rolls', t.roll === 8, 'roll ' + t.roll);
check('marked IN counts arrivals only', t.markedIn === 4,
  'expected U1 U2 U3 U8, got ' + t.markedIn);
check('marked OUT counts departures only', t.markedOut === 3,
  'expected U1 U2 U4, got ' + t.markedOut);
check('sanctioned leave is counted separately', t.onLeave === 1, 'onLeave ' + t.onLeave);
check('not-marked excludes the person on leave', t.notMarked === 2,
  'expected U6 and U7 only - U5 is on leave - got ' + t.notMarked);
check('never-marked counts only those with no record ever', t.never === 2,
  'expected U5 and U7, got ' + t.never);
check('the daily return is attributed to the person who filed it', t.reported === 1,
  'reported ' + t.reported);
check('arrivals inside the boundary are counted', t.insideIn === 2, 'inside ' + t.insideIn);
check('arrivals outside the boundary are counted', t.outsideIn === 1, 'outside ' + t.outsideIn);

const by = id => d.rows.filter(r => r.id === id)[0];
console.log('\nPer-person columns');
check('a complete day reads as complete',
  by('U1').status === 'Present, day complete' && by('U1').inFence === 'Yes' &&
  by('U1').reported === 'Yes', JSON.stringify(by('U1')));
check('an out-of-fence arrival says No, with the distance',
  by('U2').inFence === 'No' && by('U2').inDist === 4200, JSON.stringify(by('U2')));
check('a poor fix is neither yes nor no',
  by('U3').inFence === 'No GPS fix' && by('U3').inDist === '', JSON.stringify(by('U3')));
check('an OUT with no IN is not counted as an arrival',
  by('U4').status === 'OUT only' && by('U4').inTime === '', JSON.stringify(by('U4')));
check('leave outranks not-marked in the status',
  by('U5').status === 'On leave' && by('U5').leave === 'Casual Leave', JSON.stringify(by('U5')));
check('someone who marked before but not today is not "never marked"',
  by('U6').status === 'Not marked today' && by('U6').ever === true, JSON.stringify(by('U6')));
check('someone with no record at all is "never marked"',
  by('U7').status === 'Never marked' && by('U7').ever === false, JSON.stringify(by('U7')));
check('a supervisor is labelled by role, not cadre',
  by('U8').role === 'SUPERVISOR', JSON.stringify(by('U8')));

console.log('\nGrouping');
const sec = n => d.bySector.filter(s => s.key === n)[0];
check('sector rolls add up to the establishment',
  d.bySector.reduce((a, s) => a + s.roll, 0) === t.roll,
  JSON.stringify(d.bySector.map(s => s.key + ':' + s.roll)));
check('a sector carries its own not-marked count', sec('Sector Two').notMarked === 2,
  JSON.stringify(sec('Sector Two')));
check('sectors are reported by name, never by code',
  d.bySector.every(x => /^Sector /.test(x.key)),
  'got ' + JSON.stringify(d.bySector.map(x => x.key)));
check('every person row carries the sector name',
  d.rows.every(r => /^Sector /.test(r.sector)),
  'got ' + JSON.stringify([...new Set(d.rows.map(r => r.sector))]));
check('supervisors are excluded from the centre counts',
  d.centres.total === 4, 'centres ' + d.centres.total);
check('a centre where nobody marked is identified', d.centres.none === 1,
  JSON.stringify(d.centres));
check('a centre where only one of two marked is partial', d.centres.partial === 1,
  'A3 only: A2 has one active person and she marked. ' + JSON.stringify(d.centres));
check('an inactive person does not hold her centre open',
  d.centres.full === 2, 'A1 and A2. ' + JSON.stringify(d.centres));

console.log('\nSending rules');
check('a Sunday or holiday is not sent unless forced',
  /holiday && !isTest/.test(fs.readFileSync(path.join(ROOT, 'backend', 'DailyEmail.gs'), 'utf8')),
  'the holiday guard is missing');
check('the trigger is set for 17:00 so it lands before 18:00',
  /atHour\(17\)/.test(fs.readFileSync(path.join(ROOT, 'backend', 'DailyEmail.gs'), 'utf8')));
check('the temporary workbook is always cleaned up',
  /finally\s*\{[^}]*setTrashed\(true\)/s.test(
    fs.readFileSync(path.join(ROOT, 'backend', 'DailyEmail.gs'), 'utf8')));

const html = ctx.dailyAttendanceHtml_(DAY, d, '', false);
console.log('\nMessage body');
check('the body names the people who did not mark',
  html.indexOf('F Helper') >= 0 && html.indexOf('G Never') >= 0);
check('it does not name the person on sanctioned leave in that list',
  html.split('4. Not marked today')[1].split('5. Never marked')[0].indexOf('E Teacher') < 0);
check('it stays well inside the Gmail clip threshold for this fixture',
  html.length < 102400, Math.round(html.length / 1024) + ' KB');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
