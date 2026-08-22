// tools/test-verify.js — run with:  node tools/test-verify.js
//
// Runs backend/Verify.gs in a stubbed Apps Script scope. These rules produce
// sentences that get read out to a government employee, so the tests check the
// thing that matters: an honest report raises nothing, and a dishonest one is
// described accurately.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'backend', 'Verify.gs'), 'utf8');

const ctx = {
  console,
  STOCK_KEYS: ['eggs', 'rice', 'pulses', 'bal', 'balp', 'milk'],
  nowIso_: () => '2026-08-22T22:00:00+05:30',
  CACHE: { get: () => null, put: () => {} },
  masterSS_: () => { throw new Error('no Norms sheet in this harness'); },
  ghCommit_: () => {}
};
vm.createContext(ctx);
vm.runInContext(src, ctx);

// The harness must not drift from the real constants.
const util = fs.readFileSync(path.join(ROOT, 'backend', 'Util.gs'), 'utf8');
if (util.indexOf("const STOCK_KEYS = ['eggs', 'rice', 'pulses', 'bal', 'balp', 'milk'];") < 0) {
  console.log('DRIFT: STOCK_KEYS changed in Util.gs — update this harness');
  process.exit(1);
}

let pass = 0, fail = 0;
function check(label, cond, detail) {
  console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond || !detail ? '' : '\n         ' + detail));
  cond ? pass++ : fail++;
}

/** An ordinary, honest report: everything in proportion. */
function honest(aid, dd, children) {
  return {
    date: '202608' + dd, awc_id: aid, sector_code: 'S01',
    children: children, pregnant: 2, others: 1, meals: children + 3,
    eggs_ob: 100, eggs_used: children, eggs_recd: 0, eggs_cb: 100 - children,
    rice_ob: 50, rice_used: children * 0.1, rice_recd: 0, rice_cb: 50 - children * 0.1,
    pulses_ob: 20, pulses_used: children * 0.03, pulses_recd: 0, pulses_cb: 20 - children * 0.03,
    bal_ob: 5000, bal_used: children * 5, bal_recd: 0, bal_cb: 5000 - children * 5,
    balp_ob: 5000, balp_used: 10, balp_recd: 0, balp_cb: 4990,
    milk_ob: 60, milk_used: children * 0.15, milk_recd: 0, milk_cb: 60 - children * 0.15,
    photo_child_id: 'p1', photo_meal_id: 'p2', photo_pregnant_id: 'p3', photo_others_id: 'p4'
  };
}

// A whole district of honest centres on one day, so the medians are real.
function district(dd, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(honest('A' + String(1000 + i), dd, 8 + (i % 7)));
  }
  return out;
}

const parse = f => JSON.parse(f.content);

// ---------------------------------------------------------------- honest day
console.log('\nAn honest district raises nothing');
let out = parse(ctx.buildVerifyFile_('2026-08', district('16', 40)));
check('40 honest centres produce 0 findings', out.findings.length === 0,
  'got ' + out.findings.length + ': ' + JSON.stringify(out.findings.slice(0, 2)));
check('a district median was established for eggs', out.medians['16'].eggs > 0,
  JSON.stringify(out.medians['16']));

// ------------------------------------------------------- the reported problem
console.log('\nThe case that prompted this: photo shows 2, ten typed');
let rows = district('16', 40);
const liar = honest('A9999', '16', 10);
// She typed ten children but cooked, served and drew stock for two.
liar.meals = 3;
liar.eggs_used = 2; liar.eggs_cb = 98;
liar.rice_used = 0.2; liar.rice_cb = 49.8;
liar.bal_used = 10; liar.bal_cb = 4990;
liar.milk_used = 0.3; liar.milk_cb = 59.7;
liar.pulses_used = 0.06; liar.pulses_cb = 19.94;
rows.push(liar);
out = parse(ctx.buildVerifyFile_('2026-08', rows));
const f = out.findings.find(x => x.a === 'A9999');
check('the inflated centre is flagged', !!f);
if (f) {
  const codes = f.r.map(r => r.code);
  check('the meal shortfall is caught', codes.indexOf('MEALS_SHORT') >= 0, codes.join(','));
  check('under-use of stock per child is caught', codes.indexOf('PERHEAD_LOW') >= 0, codes.join(','));
  check('it scores high enough to reach the top of the queue', f.score >= 60, 'score ' + f.score);
  check('it is the first row in the queue', out.findings[0].a === 'A9999');
  check('the sentence names the real numbers',
    /10 children.*only 3 meals/.test(f.r.find(r => r.code === 'MEALS_SHORT').t),
    f.r[0].t);
  console.log('    → "' + f.r.find(r => r.code === 'MEALS_SHORT').t + '"');
  const ph = f.r.find(r => r.code === 'PERHEAD_LOW');
  console.log('    → "' + ph.t + '"');
  check('the photos are attached for review', f.ph.c === 'p1' && f.ph.m === 'p2');
}

// -------------------------------------------------------------- ledger drift
console.log('\nA stock register that does not balance');
rows = district('16', 40);
const drift = honest('A8888', '16', 10);
drift.eggs_cb = 200;                       // closing far above what the maths allows
rows.push(drift);
out = parse(ctx.buildVerifyFile_('2026-08', rows));
const d = out.findings.find(x => x.a === 'A8888');
check('the drift is caught', !!d && d.r.some(r => r.code === 'LEDGER_OFF'));
if (d) console.log('    → "' + d.r.find(r => r.code === 'LEDGER_OFF').t + '"');

// An all-zero stock block is an old client, not a discrepancy.
rows = district('16', 40);
const oldClient = honest('A7777', '16', 10);
ctx.STOCK_KEYS.forEach(k => {
  oldClient[k + '_ob'] = 0; oldClient[k + '_used'] = 0;
  oldClient[k + '_recd'] = 0; oldClient[k + '_cb'] = 0;
});
oldClient.meals = 13;
rows.push(oldClient);
out = parse(ctx.buildVerifyFile_('2026-08', rows));
const oc = out.findings.find(x => x.a === 'A7777');
check('an empty stock block is not called a discrepancy',
  !oc || !oc.r.some(r => r.code === 'LEDGER_OFF'), oc ? JSON.stringify(oc.r.map(r => r.code)) : '');

// ------------------------------------------------------------ small district
console.log('\nToo few peers to judge anyone');
out = parse(ctx.buildVerifyFile_('2026-08', district('16', 5).concat([liar])));
const small = out.findings.find(x => x.a === 'A9999');
check('with 6 centres, no per-head median is published', out.medians['16'].eggs === null,
  JSON.stringify(out.medians['16']));
check('the meal arithmetic still fires without peers',
  !!small && small.r.some(r => r.code === 'MEALS_SHORT'));
check('but no per-head claim is made', !small || !small.r.some(r => r.code === 'PERHEAD_LOW'),
  small ? small.r.map(r => r.code).join(',') : '');

// ------------------------------------------------------------ behaviour
console.log('\nBehaviour over a month');
rows = [];
for (let i = 0; i < 12; i++) {
  const dd = String(10 + i);
  rows = rows.concat(district(dd, 25));
  rows.push(honest('A5555', dd, 10));           // exactly ten, every single day
  rows.push(honest('A4444', dd, [7, 9, 11, 8][i % 4]));  // ordinary variation
}
out = parse(ctx.buildVerifyFile_('2026-08', rows));
const flat = out.centres.find(c => c.a === 'A5555');
const normal = out.centres.find(c => c.a === 'A4444');
check('the flat reporter is caught', !!flat && flat.r.some(r => r.code === 'FLAT_COUNT'));
if (flat) console.log('    → "' + flat.r.find(r => r.code === 'FLAT_COUNT').t + '"');
check('a centre with ordinary variation is left alone', !normal,
  normal ? JSON.stringify(normal.r.map(r => r.code)) : '');

console.log('\nA centre with too few days is not judged on behaviour');
rows = district('16', 25).concat(district('17', 25));
for (const dd of ['16', '17']) rows.push(honest('A3333', dd, 10));
out = parse(ctx.buildVerifyFile_('2026-08', rows));
check('2 filed days produces no behavioural finding',
  !out.centres.find(c => c.a === 'A3333' && c.r.some(r => r.code === 'FLAT_COUNT')));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
