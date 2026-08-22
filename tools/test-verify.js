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

/**
 * An ordinary, honest report. Consumption follows the GROUP each item serves,
 * which is the whole point: Balamrutham goes to the children, Balamrutham+ to
 * the women, eggs to both, and the cooked meal to children and women.
 */
function honest(aid, dd, children, pregnant, others) {
  const p = pregnant == null ? 2 : pregnant;
  const o = others == null ? 1 : others;
  const eggs = children * 1 + p * 1;              // both groups
  const rice = children * 0.1 + p * 0.15;         // women get the larger ration
  const pulses = children * 0.03 + p * 0.04;
  const bal = children * 100;                     // children only
  const balp = p * 120;                           // women only
  const milk = children * 0.15;
  const meals = children + p;
  return {
    date: '202608' + dd, awc_id: aid, sector_code: 'S01',
    children: children, pregnant: p, others: o, meals: meals,
    eggs_ob: 400, eggs_used: eggs, eggs_recd: 0, eggs_cb: 400 - eggs,
    rice_ob: 200, rice_used: rice, rice_recd: 0, rice_cb: 200 - rice,
    pulses_ob: 80, pulses_used: pulses, pulses_recd: 0, pulses_cb: 80 - pulses,
    bal_ob: 40000, bal_used: bal, bal_recd: 0, bal_cb: 40000 - bal,
    balp_ob: 40000, balp_used: balp, balp_recd: 0, balp_cb: 40000 - balp,
    milk_ob: 300, milk_used: milk, milk_recd: 0, milk_cb: 300 - milk,
    photo_child_id: 'p1', photo_meal_id: 'p2', photo_pregnant_id: 'p3', photo_others_id: 'p4'
  };
}

/**
 * A district with a REAL SPREAD OF MIXES — some centres child-heavy, some with
 * many pregnant women. A single per-child ratio would mark half of these as
 * anomalous purely because of who walks through their door.
 */
function district(dd, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const children = 6 + (i % 11);
    const pregnant = (i % 5);
    const others = (i % 3);
    out.push(honest('A' + String(1000 + i), dd, children, pregnant, others));
  }
  return out;
}

const parse = f => JSON.parse(f.content);

// ---------------------------------------------------------------- honest day
console.log('\nAn honest district raises nothing');
let out = parse(ctx.buildVerifyFile_('2026-08', district('16', 60)));
check('60 honest centres of every mix produce 0 findings', out.findings.length === 0,
  'got ' + out.findings.length + ': ' + JSON.stringify(out.findings.slice(0, 2)));
check('a per-group model was fitted for eggs', !!out.medians['16'].eggs,
  JSON.stringify(out.medians['16'].eggs));
check('the model separates the groups it actually serves',
  !!out.medians['16'].balp && out.medians['16'].balp.b[1] > 0 &&
  out.medians['16'].balp.b[0] === 0,
  'Balamrutham+ coefficients ' + JSON.stringify(out.medians['16'].balp &&
    out.medians['16'].balp.b));
check('Balamrutham is fitted to the children, not the women',
  !!out.medians['16'].bal && out.medians['16'].bal.b[0] > 0 && out.medians['16'].bal.b[1] === 0,
  'Balamrutham coefficients ' + JSON.stringify(out.medians['16'].bal &&
    out.medians['16'].bal.b));

// ------------------------------------------------------- the reported problem
console.log('\nThe case that prompted this: photo shows 2, ten typed');
let rows = district('16', 60);
const liar = honest('A9999', '16', 10, 2, 1);
// She typed ten children but cooked, served and drew stock for two.
liar.meals = 3;
liar.eggs_used = 2; liar.eggs_cb = 398;
liar.rice_used = 0.2; liar.rice_cb = 199.8;
liar.bal_used = 100; liar.bal_cb = 39900;
liar.milk_used = 0.3; liar.milk_cb = 299.7;
liar.pulses_used = 0.06; liar.pulses_cb = 79.94;
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
  check('the sentence names the mix and both numbers',
    /Only 3 meals were prepared for 10 children, 2 pregnant women and 1 other beneficiary/
      .test(f.r.find(r => r.code === 'MEALS_SHORT').t),
    f.r.find(r => r.code === 'MEALS_SHORT').t);
  console.log('    → "' + f.r.find(r => r.code === 'MEALS_SHORT').t + '"');
  const ph = f.r.find(r => r.code === 'PERHEAD_LOW');
  console.log('    → "' + ph.t + '"');
  check('the photos are attached for review', f.ph.c === 'p1' && f.ph.m === 'p2');
}

// -------------------------------------------------------------- ledger drift
console.log('\nA stock register that does not balance');
rows = district('16', 60);
const drift = honest('A8888', '16', 10);
drift.eggs_cb = 900;                       // closing far above what the maths allows
rows.push(drift);
out = parse(ctx.buildVerifyFile_('2026-08', rows));
const d = out.findings.find(x => x.a === 'A8888');
check('the drift is caught', !!d && d.r.some(r => r.code === 'LEDGER_OFF'));
if (d) console.log('    → "' + d.r.find(r => r.code === 'LEDGER_OFF').t + '"');

// An all-zero stock block is an old client, not a discrepancy.
rows = district('16', 60);
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
out = parse(ctx.buildVerifyFile_('2026-08', district('16', 6).concat([liar])));
const small = out.findings.find(x => x.a === 'A9999');
check('with 7 centres, no model is fitted at all', out.medians['16'].eggs === null,
  JSON.stringify(out.medians['16'].eggs));
check('and nothing is claimed about consumption', !small,
  small ? small.r.map(r => r.code).join(',') : '');

// ------------------------------------------------------------ behaviour
console.log('\nBehaviour over a month');
rows = [];
for (let i = 0; i < 12; i++) {
  const dd = String(10 + i);
  rows = rows.concat(district(dd, 40));
  rows.push(honest('A5555', dd, 10, 2, 1));           // exactly ten, every day
  rows.push(honest('A4444', dd, [7, 9, 11, 8][i % 4], 2, 1));  // ordinary variation
}
out = parse(ctx.buildVerifyFile_('2026-08', rows));
const flat = out.centres.find(c => c.a === 'A5555');
const normal = out.centres.find(c => c.a === 'A4444');
check('the flat reporter is caught', !!flat && flat.r.some(r => r.code === 'FLAT_COUNT'));
if (flat) console.log('    → "' + flat.r.find(r => r.code === 'FLAT_COUNT').t + '"');
check('a centre with ordinary variation is left alone', !normal,
  normal ? JSON.stringify(normal.r.map(r => r.code)) : '');

console.log('\nA centre with too few days is not judged on behaviour');
rows = district('16', 40).concat(district('17', 40));
for (const dd of ['16', '17']) rows.push(honest('A3333', dd, 10));
out = parse(ctx.buildVerifyFile_('2026-08', rows));
check('2 filed days produces no behavioural finding',
  !out.centres.find(c => c.a === 'A3333' && c.r.some(r => r.code === 'FLAT_COUNT')));

// --------------------------------------------- the mistake this model prevents
console.log('\nA different beneficiary mix is not an anomaly');
rows = district('16', 60);
// A centre that serves mostly pregnant women and few children. Judged on a
// single per-child ratio it would look like it was consuming several times its
// entitlement; judged on its own mix it is entirely ordinary.
const womenHeavy = honest('A6666', '16', 3, 14, 2);
rows.push(womenHeavy);
// And its mirror: almost all children, hardly any women.
const childHeavy = honest('A6667', '16', 26, 0, 0);
rows.push(childHeavy);
out = parse(ctx.buildVerifyFile_('2026-08', rows));
const wh = out.findings.find(x => x.a === 'A6666');
const ch = out.findings.find(x => x.a === 'A6667');
check('a centre serving mostly pregnant women is NOT flagged', !wh,
  wh ? wh.r.map(r => r.t).join(' | ') : '');
check('a centre serving almost only children is NOT flagged', !ch,
  ch ? ch.r.map(r => r.t).join(' | ') : '');
// Prove the naive check would have accused them, so the test has teeth.
const eggFit = out.medians['16'].eggs.b;
const naivePerChild = eggFit[0] + eggFit[1] * (2 / 10);   // roughly a mixed centre
const naiveExpect = naivePerChild * womenHeavy.children;
check('and the old per-child rule really would have accused the first',
  womenHeavy.eggs_used > naiveExpect * 2.5,
  'used ' + womenHeavy.eggs_used + ' vs naive expectation ' + naiveExpect.toFixed(1));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
