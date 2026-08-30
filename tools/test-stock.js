// tools/test-stock.js — run with:  node tools/test-stock.js
//
// Runs backend/Stock.gs in a stubbed Apps Script scope.
//
// This is the fix for Committee point 2 of 2026-08-30 — the closing balance
// was never carried forward into the next day's opening. The risk in carrying
// anything forward is that it goes backwards: marks sync out of order, so a
// report filed on Tuesday can land on Thursday evening, after Wednesday's has
// already been recorded. Advancing the carry on arrival order would silently
// rewind the whole centre's ledger. Most of what follows is about that.
//
// The other half is the CARRY_OFF finding, which accuses a real person of a
// stock discrepancy, so it must never fire on a rounding difference, on a
// centre's first report, or on a gap in reporting.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'backend', 'Stock.gs'), 'utf8');
const util = fs.readFileSync(path.join(ROOT, 'backend', 'Util.gs'), 'utf8');

// The harness must not drift from the real constants.
if (util.indexOf("const STOCK_KEYS = ['eggs', 'rice', 'pulses', 'bal', 'balp', 'milk'];") < 0) {
  console.log('DRIFT: STOCK_KEYS changed in Util.gs — update this harness');
  process.exit(1);
}
if (util.indexOf("'gps_wait_sec', 'platform'];") < 0) {
  console.log('DRIFT: MARKS_H no longer ends with the telemetry columns');
  process.exit(1);
}
// The stub for getAwc_ below must keep the real field names. Reading
// awc.sector_code instead of awc.sector yields undefined, which compares out
// of every scope and refuses every supervisor - caught here, not in the field.
if (util.indexOf("return { awc_id: String(r[0]), sector: String(r[1])") < 0) {
  console.log('DRIFT: awcFromRow_ changed shape - update the getAwc_ stub');
  process.exit(1);
}

// ---- a spreadsheet just real enough to be wrong in the same ways ----
function makeSheet(header) {
  const rows = [header.slice()];
  return {
    _rows: rows,
    getLastRow: () => rows.length,
    getMaxColumns: () => header.length,
    getMaxRows: () => Math.max(rows.length, 1000),
    insertColumnsAfter: () => {},
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        getValue: () => (rows[r - 1] || [])[c - 1],
        getValues: () => {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = rows[r - 1 + i] || [];
            out.push(row.slice(c - 1, c - 1 + nc));
          }
          return out;
        },
        setValues: (vals) => {
          vals.forEach((v, i) => {
            while (rows.length < r + i) rows.push(new Array(header.length).fill(''));
            const row = rows[r - 1 + i];
            v.forEach((x, j) => { row[c - 1 + j] = x; });
          });
        },
        setNumberFormat: () => {}
      };
    }
  };
}

const cache = {};
const sheets = {};
const ctx = {
  console,
  STOCK_KEYS: ['eggs', 'rice', 'pulses', 'bal', 'balp', 'milk'],
  nowIso_: () => '2026-08-30T18:00:00+05:30',
  CACHE: {
    get: k => (k in cache ? cache[k] : null),
    put: (k, v) => { cache[k] = v; },
    remove: k => { delete cache[k]; }
  },
  masterSS_: () => ({
    getSheetByName: n => sheets[n] || null,
    // CARRY_H is a top-level const inside the script, which is a lexical
    // binding and NOT a property of the context object — read it back out.
    insertSheet: n => (sheets[n] = makeSheet(CARRY_H))
  }),
  findRowByValue_: (sh, col, val) => {
    for (let i = 1; i < sh._rows.length; i++) {
      if (String(sh._rows[i][col - 1]) === String(val)) return i + 1;
    }
    return 0;
  },
  rowToObj_: (headers, row) => {
    const o = {};
    headers.forEach((h, i) => { o[h] = row[i]; });
    return o;
  },
  isConsoleRole_: u => ['SUPERVISOR', 'CDPO', 'ADMIN'].indexOf(u.role) >= 0,
  deny_: () => ({ ok: false, code: 'FORBIDDEN' }),
  // Mirrors awcFromRow_ in Util.gs EXACTLY, field names included. A stub that
  // invents a friendlier shape than the real one just hides the bug it was
  // written to catch - which is precisely what this one did on its first run.
  getAwc_: id => ({ awc_id: id, sector: id === 'A0002' ? 'S02' : 'S01',
    project: 'JGN', name: 'Centre ' + id, lat: 17.7, lng: 79.1, radius_m: 200, active: true }),
  sectorScope_: u => (u.role === 'ADMIN' ? null : ['S01'])
};
vm.createContext(ctx);
vm.runInContext(src, ctx);
const CARRY_H = vm.runInContext('CARRY_H', ctx);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond || !detail ? '' : '\n         ' + detail));
  cond ? pass++ : fail++;
}
function reset() {
  Object.keys(cache).forEach(k => delete cache[k]);
  Object.keys(sheets).forEach(k => delete sheets[k]);
}

const USER = { user_id: 'U0001', awc_id: 'A0001' };
/** A report whose six closing balances are all the same number. */
function rpt(cb) {
  const stock = {};
  ctx.STOCK_KEYS.forEach(k => { stock[k] = { ob: 0, used: 0, recd: 0, cb: cb }; });
  return { stock: stock };
}
/** A report whose six OPENING balances are all the same number. */
function opening(ob) {
  const stock = {};
  ctx.STOCK_KEYS.forEach(k => { stock[k] = { ob: ob, used: 0, recd: 0, cb: 0 }; });
  return { stock: stock };
}

console.log('\n-- the carry itself --');
reset();
check('a centre that has never reported has no carry, not a carry of zero',
  ctx.getStockCarry_('A0001') === null);

ctx.setStockCarry_(USER, rpt(120), '20260828');
let c = ctx.getStockCarry_('A0001');
check('after one report the closing balance is the carry',
  c && c.date === '20260828' && c.cb.eggs === 120, JSON.stringify(c));

ctx.setStockCarry_(USER, rpt(95), '20260829');
c = ctx.getStockCarry_('A0001');
check('the next day overwrites it in place, one row per centre',
  c.date === '20260829' && c.cb.eggs === 95 && sheets.StockCarry._rows.length === 2,
  'rows=' + sheets.StockCarry._rows.length);

console.log('\n-- out-of-order sync: a late report must never rewind a centre --');
ctx.setStockCarry_(USER, rpt(40), '20260827');   // Tuesday, arriving last
c = ctx.getStockCarry_('A0001');
check('a report OLDER than the carry leaves the carry alone',
  c.date === '20260829' && c.cb.eggs === 95, JSON.stringify(c));

ctx.setStockCarry_(USER, rpt(77), '20260829');
check('a report for the SAME day as the carry does update it (a correction)',
  ctx.getStockCarry_('A0001').cb.eggs === 77);

ctx.setStockCarry_(USER, rpt(60), '20260901');
check('dates compare as strings across a month boundary, not as numbers',
  ctx.getStockCarry_('A0001').date === '20260901');

console.log('\n-- what is not a number --');
reset();
ctx.setStockCarry_(USER, { stock: { eggs: { cb: '' }, rice: { cb: 12 } } }, '20260829');
c = ctx.getStockCarry_('A0001');
check('a blank closing carries as null, never as zero',
  c.cb.eggs === null && c.cb.rice === 12, JSON.stringify(c.cb));
check('an item the report never mentioned is null too', c.cb.milk === null);

reset();
ctx.setStockCarry_(USER, { stock: null }, '20260829');
check('a pre-v2 app with no per-item stock writes no carry at all',
  ctx.getStockCarry_('A0001') === null);

reset();
ctx.setStockCarry_({ user_id: 'U9', awc_id: '' }, rpt(10), '20260829');
check('a worker with no centre writes nothing — a carry is a centre\'s, not a person\'s',
  !sheets.StockCarry || sheets.StockCarry._rows.length === 1);

console.log('\n-- CARRY_OFF: only when it is really a break --');
const prev = { date: '20260829', cb: { eggs: 100, rice: 50, pulses: 20, bal: 0, balp: 0, milk: 5 } };

check('opening equal to the carried closing raises nothing',
  ctx.carryBreaks_(prev, opening(0) && {
    stock: { eggs: { ob: 100 }, rice: { ob: 50 }, pulses: { ob: 20 },
      bal: { ob: 0 }, balp: { ob: 0 }, milk: { ob: 5 } }
  }, '20260830').length === 0);

let b = ctx.carryBreaks_(prev, { stock: { eggs: { ob: 60 } } }, '20260830');
check('40 eggs that vanished overnight is one finding, named for the item',
  b.length === 1 && b[0].item === 'eggs' && b[0].was === 100 && b[0].now === 60 && b[0].diff === -40,
  JSON.stringify(b));

b = ctx.carryBreaks_(prev, { stock: { eggs: { ob: 140 } } }, '20260830');
check('a SURPLUS is a finding too — stock appearing is as odd as stock leaving',
  b.length === 1 && b[0].diff === 40);

check('0.04 kg is rounding, not a discrepancy',
  ctx.carryBreaks_(prev, { stock: { milk: { ob: 5.04 } } }, '20260830').length === 0);
check('0.5 kg is a discrepancy',
  ctx.carryBreaks_(prev, { stock: { milk: { ob: 5.5 } } }, '20260830').length === 1);

check('a centre with no carry yet is never accused',
  ctx.carryBreaks_(null, { stock: { eggs: { ob: 999 } } }, '20260830').length === 0);
check('the report that SET the carry is not compared against itself',
  ctx.carryBreaks_(prev, { stock: { eggs: { ob: 1 } } }, '20260829').length === 0);
check('nor is a report older than the carry',
  ctx.carryBreaks_(prev, { stock: { eggs: { ob: 1 } } }, '20260828').length === 0);
check('a blank opening is not compared — she has not answered yet',
  ctx.carryBreaks_(prev, { stock: { eggs: { ob: '' } } }, '20260830').length === 0);
check('a carry item that is null is not compared either',
  ctx.carryBreaks_({ date: '20260829', cb: { eggs: null } },
    { stock: { eggs: { ob: 500 } } }, '20260830').length === 0);

b = ctx.carryBreaks_(prev, {
  stock: { eggs: { ob: 60 }, rice: { ob: 50 }, milk: { ob: 1 } }
}, '20260830');
check('two broken items out of three give exactly two findings',
  b.length === 2 && b.map(x => x.item).sort().join(',') === 'eggs,milk', JSON.stringify(b));

console.log('\n-- who may read a carry --');
reset();
ctx.setStockCarry_(USER, rpt(120), '20260829');
const worker = { user: { awc_id: 'A0001', role: 'FIELD' } };
check('a worker reads her own centre',
  ctx.apiStockCarry_(worker, {}).ok === true);
check('a worker cannot read another centre by editing the request',
  ctx.apiStockCarry_(worker, { awcId: 'A0002' }).code === 'FORBIDDEN');
check('a supervisor reads a centre inside her sector',
  ctx.apiStockCarry_({ user: { awc_id: '', role: 'SUPERVISOR' } }, { awcId: 'A0001' }).ok === true);
check('a supervisor cannot read a centre outside her sector',
  ctx.apiStockCarry_({ user: { awc_id: '', role: 'SUPERVISOR' } }, { awcId: 'A0002' })
    .code === 'FORBIDDEN');
check('an admin, whose scope is null, reads any centre',
  ctx.apiStockCarry_({ user: { awc_id: '', role: 'ADMIN' } }, { awcId: 'A0002' }).ok === true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
