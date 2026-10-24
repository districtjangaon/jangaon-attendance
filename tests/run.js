/* The backend's own test run. Three gates, in order:

     1. PARSE: every backend/*.gs compiles on its own. A file that does not
        parse takes the WHOLE Apps Script project down - every endpoint, not
        one - and the editor is the only place that would have said so.
     2. LOAD: the files load together, in the order the deploy concatenates
        them, inside a mocked Apps Script world (tests/gasmock.js).
     3. SUITES: tests/suites/*.js, each exporting { name, run(t) }. A suite
        builds its own world with load() and asserts through t.

   Run:  node tests/run.js            (exit 1 on any failure)
         node tests/run.js posting    (only suites whose file name contains it)
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { load, buildOrder, BACKEND } = require('./gasmock');

let pass = 0, fail = 0;
const failures = [];
function report(ok, label, detail) {
  if (ok) { pass++; return; }
  fail++;
  failures.push(label + (detail ? '\n      ' + detail : ''));
  console.log('  FAIL ' + label + (detail ? '\n      ' + detail : ''));
}

/* ---- 1. parse ---- */
console.log('\nParse');
const order = buildOrder();
order.forEach(f => {
  try { new vm.Script(fs.readFileSync(path.join(BACKEND, f), 'utf8'), { filename: f }); report(true, f); }
  catch (e) { report(false, f + ' does not parse', String(e.message)); }
});
console.log('  ' + order.length + ' files');

/* ---- 2. load ---- */
console.log('\nLoad');
try {
  const env = load();
  report(typeof env.ctx.doPost === 'function', 'doPost is defined');
  report(typeof env.ctx.featurePost_ === 'function', 'featurePost_ is defined');
  const ping = env.post({ action: 'ping' });
  report(ping && ping.ok === true && (ping.build === 'unbuilt' || /^[0-9a-f]{12}$/.test(String(ping.build))), 'ping answers', JSON.stringify(ping));
  console.log('  loaded ' + order.length + ' files in deploy order');
} catch (e) {
  report(false, 'the backend loads in the mocked world', String(e.stack || e));
}

/* ---- 3. suites ---- */
const only = process.argv[2] || '';
const dir = path.join(__dirname, 'suites');
const suites = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.js$/.test(f) && f.indexOf(only) >= 0).sort() : [];
suites.forEach(f => {
  const s = require(path.join(dir, f));
  console.log('\n' + (s.name || f));
  const t = {
    ok: (cond, label, detail) => report(!!cond, label, cond ? '' : detail),
    eq: (a, b, label) => report(JSON.stringify(a) === JSON.stringify(b), label, 'got ' + JSON.stringify(a) + '\n      want ' + JSON.stringify(b)),
    contains: (hay, needle, label) => report(String(hay).indexOf(needle) >= 0, label, 'got ' + JSON.stringify(String(hay)).slice(0, 300)),
    throws: (fn, label) => { let threw = false; try { fn(); } catch (e) { threw = true; } report(threw, label); }
  };
  const before = fail;
  try { s.run(t, load); }
  catch (e) { report(false, 'suite threw', String(e.stack || e)); }
  console.log('  ' + (fail === before ? 'ok' : (fail - before) + ' failed'));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed' + (failures.length ? '\n\n' + failures.join('\n') : ''));
process.exit(fail ? 1 : 0);
