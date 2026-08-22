// tools/test-map.js — run with:  node tools/test-map.js
//
// Runs backend/Map.gs in a stubbed Apps Script scope and checks the rules the
// spec says must never bend: no invented positions, leave is not absence,
// fresh vs stale is distinguishable, and trustworthiness is recomputed here.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const src = fs.readFileSync(path.join(ROOT, 'backend', 'Map.gs'), 'utf8');

const ctx = {
  console,
  // --- constants copied from Util.gs (asserted below to stay in step) ---
  DISTRICT_BOX: { minLat: 17.45, maxLat: 18.06, minLng: 78.67, maxLng: 79.60 },
  DISTRICT_CENTRE: { lat: 17.7566, lng: 79.1361, zoom: 10 },
  GPS_UNVERIFIED_ACC_M: 250,
  EXPECTED_TZ: ['Asia/Kolkata', 'Asia/Calcutta'],
  SEEN_H: [], LASTFIX_H: [], MAPCACHE_H: [],
  nowIso_: () => '2026-08-22T10:00:00+05:30',
  fmtDay_: () => '2026-08-22',
  primarySector_: u => String(u.sector_code).split(',')[0],
  masterSS_: () => { throw new Error('no sheet in this harness'); },
  CACHE: { get: () => null, put: () => {} },
  rowToObj_: () => ({})
};
vm.createContext(ctx);
vm.runInContext(src, ctx);

// The harness must not drift from the real constants.
const util = fs.readFileSync(path.join(ROOT, 'backend', 'Util.gs'), 'utf8');
for (const [name, needle] of [
  ['GPS_UNVERIFIED_ACC_M', 'const GPS_UNVERIFIED_ACC_M = 250;'],
  ['DISTRICT_BOX', 'minLat: 17.45, maxLat: 18.06, minLng: 78.67, maxLng: 79.60'],
  ['EXPECTED_TZ', "const EXPECTED_TZ = ['Asia/Kolkata', 'Asia/Calcutta'];"]
]) {
  if (util.indexOf(needle) < 0) { console.log('DRIFT: Util.gs no longer has ' + name); process.exit(1); }
}

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok ? '' : '\n         got  ' + JSON.stringify(got) +
    '\n         want ' + JSON.stringify(want)));
  ok ? pass++ : fail++;
};

console.log('\nfixDoubts_ — why a fix should not be believed');
check('clean fix inside the district', ctx.fixDoubts_(17.72, 79.15, 18, 'Asia/Kolkata'), []);
check('coarse fix', ctx.fixDoubts_(17.72, 79.15, 900, 'Asia/Kolkata'),
  ['accuracy is 900 m, worse than the 250 m limit']);
check('outside the district', ctx.fixDoubts_(19.9, 72.8, 15, 'Asia/Kolkata'),
  ['the fix falls outside Jangaon district']);
check('foreign timezone', ctx.fixDoubts_(17.72, 79.15, 15, 'Asia/Dubai'),
  ['the phone clock is set to Asia/Dubai']);
check('legacy Asia/Calcutta alias is NOT a doubt',
  ctx.fixDoubts_(17.72, 79.15, 15, 'Asia/Calcutta'), []);
check('no accuracy reported', ctx.fixDoubts_(17.72, 79.15, null, 'Asia/Kolkata'),
  ['the phone reported no accuracy figure']);
check('250 m exactly is still believed', ctx.fixDoubts_(17.72, 79.15, 250, 'Asia/Kolkata'), []);

console.log('\nplaceUnmarked_ — three sources, never a fourth');
const seen = { U1: { at: '2026-08-22T09:14:00+05:30', lat: 17.7, lng: 79.1, acc: 40 } };
const fixes = { U2: { date: '2026-08-11', at: '09:02', lat: 17.8, lng: 79.2, acc: 22 } };
check('today\'s ping wins and is dated today',
  ctx.placeUnmarked_('U1', seen, fixes), { lat: 17.7, lng: 79.1, acc: 40, seenAt: '09:14', lastDate: '' });
check('else the last located mark, dated',
  ctx.placeUnmarked_('U2', seen, fixes),
  { lat: 17.8, lng: 79.2, acc: 22, seenAt: '', lastDate: '2026-08-11' });
check('neither: no position at all, no centroid', ctx.placeUnmarked_('U3', seen, fixes), null);

console.log('\nbuildMapDay_ — the whole payload');
ctx.seenForDate_ = () => seen;
ctx.readLastFixes_ = () => fixes;
const users = [
  { user_id: 'P1', role: 'FIELD', awc_id: 'A1', sector_code: 'S01' }, // present, clean
  { user_id: 'P2', role: 'FIELD', awc_id: 'A2', sector_code: 'S01' }, // present, coarse
  { user_id: 'P3', role: 'FIELD', awc_id: 'A3', sector_code: 'S02' }, // present, no coords
  { user_id: 'U1', role: 'FIELD', awc_id: 'A4', sector_code: 'S02' }, // unmarked, pinged
  { user_id: 'U2', role: 'FIELD', awc_id: 'A5', sector_code: 'S03' }, // unmarked, stale
  { user_id: 'U3', role: 'FIELD', awc_id: 'A6', sector_code: 'S03' }, // unmarked, nowhere
  { user_id: 'L1', role: 'FIELD', awc_id: 'A7', sector_code: 'S03' }  // on leave, stale fix
];
const mark = (lat, lng, acc, tz) => ({ lat: lat, lng: lng, accuracy_m: acc,
  client_ts: '2026-08-22T09:05:00+05:30', geofence: 'INSIDE', flags: '', tz: tz });
const marks = {
  P1: { IN: mark(17.72, 79.15, 18, 'Asia/Kolkata') },
  P2: { IN: mark(17.73, 79.16, 900, 'Asia/Kolkata'), OUT: mark(17.73, 79.16, 900, 'Asia/Kolkata') },
  P3: { IN: mark('', '', '', '') }
};
fixes.L1 = { date: '2026-08-09', at: '09:00', lat: 17.9, lng: 79.3, acc: 30 };
const out = ctx.buildMapDay_('2026-08-22', marks, users, { L1: 'CASUAL' }, [
  { key: 'R1', user_id: 'P1', sector_code: 'S01', awc_id: 'A1', lat: 17.72, lng: 79.15,
    client_ts: '2026-08-22T11:20:00+05:30', children: 21, meals: 19, flags: '' },
  { key: 'R2', user_id: 'P2', sector_code: 'S01', awc_id: 'A2', lat: '', lng: '',
    client_ts: '2026-08-22T11:25:00+05:30', children: 10, meals: 9, flags: 'NO_PHOTO_MEAL' }
]);

check('present count (P3 has no coords, so no pin)', out.present.length, 2);
check('P1 is verified with no doubts',
  [out.present[0].id, out.present[0].verified, out.present[0].doubts.length], ['P1', true, 0]);
check('P2 is unverified and says why',
  [out.present[1].verified, out.present[1].doubts], [false, ['accuracy is 900 m, worse than the 250 m limit']]);
check('P2 marked twice', out.present[1].marks, 2);
check('leave is not absence', [out.onLeave.length, out.onLeave[0].id, out.onLeave[0].lv],
  [1, 'L1', 'CASUAL']);
check('the leave pin is dated, not fresh',
  [out.onLeave[0].seenAt, out.onLeave[0].lastDate], ['', '2026-08-09']);
check('absent: only U1 and U2, never U3', out.absent.map(a => a.id), ['U1', 'U2']);
check('U1 reads as seen today', [out.absent[0].seenAt, out.absent[0].lastDate], ['09:14', '']);
check('U2 reads as an older date', [out.absent[1].seenAt, out.absent[1].lastDate], ['', '2026-08-11']);
check('filed drops the report with no coordinates', out.filed.map(f => f.id), ['R1']);
check('filed grade', out.filed[0].grade, 'COMPLETE');
check('payload carries no names', /"name"|"phone"/.test(JSON.stringify(out)), false);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
