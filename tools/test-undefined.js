// tools/test-undefined.js — run with:  node tools/test-undefined.js
//
// Catches a call to a function that does not exist.
//
// WHY THIS FILE EXISTS. On 29 Aug 2026 a rename left submitReport calling
// stockCb(), which had become stockExpected(). Nothing detected it: the file
// parses, every suite passed, and the browser only throws when a worker
// actually presses SUBMIT — at which point the button silently does nothing.
// It ran for three days, cost the district ~600 daily returns, and through the
// OUT gate locked ~400 Teachers out of closing their day.
//
// The app ships as plain scripts with no bundler and no type checker, so this
// is what stands between a rename and the field.
//
// Deliberately CONSERVATIVE: a name is reported only when it is called
// somewhere and declared nowhere. A check that cries wolf gets switched off,
// and then it protects nothing.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILES = ['app/js/app.js', 'app/js/api.js', 'app/js/camera.js', 'app/js/db.js',
  'app/js/geo.js', 'app/js/sync.js', 'console/js/app.js', 'console/js/norms.js'];

/**
 * Blank out comments, strings and REGEX LITERALS, keeping length and lines.
 *
 * Regex literals are why this is a hand-written scanner and not three
 * .replace() calls: /[&<>"]/g contains a lone double quote, so a naive string
 * pass treats it as an opening quote and swallows the rest of the file. That
 * produced a page of false positives on this check's first run. Telling a
 * regex from a division needs the previous meaningful character, so the source
 * has to be walked once, in order.
 */
function code(src) {
  let out = '';
  let prev = '';
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '*') {
      const e = src.indexOf('*/', i + 2);
      const seg = src.slice(i, e < 0 ? src.length : e + 2);
      out += blank(seg); i += seg.length - 1; continue;
    }
    if (c === '/' && n === '/') {
      const e = src.indexOf('\n', i);
      const stop = e < 0 ? src.length : e;
      out += blank(src.slice(i, stop)); i = stop - 1; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      out += blank(src.slice(i, Math.min(j + 1, src.length)));
      i = j; prev = c; continue;
    }
    if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%~^<>'.indexOf(prev) >= 0 ||
        /(?:return|typeof|case|in|of|do|else|yield|await)\s*$/.test(out))) {
      let j = i + 1, cls = false, ok = false;
      while (j < src.length) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '[') cls = true;
        else if (d === ']') cls = false;
        else if (d === '\n') break;
        else if (d === '/' && !cls) { ok = true; break; }
        j++;
      }
      if (ok) { out += blank(src.slice(i, j + 1)); i = j; continue; }
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
  }
  return out;
}

// Anything the language, the browser, or a sibling app script provides.
const AMBIENT = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'do',
  'else', 'new', 'delete', 'void', 'await', 'yield', 'in', 'of', 'case', 'with',
  'async', 'get', 'set', 'static', 'class', 'extends', 'super', 'this', 'throw',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date',
  'Promise', 'Map', 'Set', 'WeakMap', 'RegExp', 'Error', 'Symbol', 'BigInt',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'require',
  'window', 'document', 'navigator', 'location', 'console', 'alert', 'confirm',
  'prompt', 'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'requestAnimationFrame', 'FileReader', 'Blob', 'File', 'FormData', 'Image',
  'URL', 'Intl', 'caches', 'indexedDB', 'crypto', 'localStorage', 'sessionStorage',
  'CustomEvent', 'Event', 'Notification', 'AbortController', 'TextEncoder',
  'TextDecoder', 'atob', 'btoa', 'structuredClone', 'matchMedia', 'getComputedStyle',
  // our own modules, each defined in a sibling file loaded on the same page
  'App', 'Api', 'DB', 'Sync', 'Camera', 'Geo', 'APP_CONFIG'
]);

let pass = 0, fail = 0;

for (const rel of FILES) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  const src = code(fs.readFileSync(p, 'utf8'));

  const declared = new Set(AMBIENT);
  const add = (re) => { let m; while ((m = re.exec(src))) declared.add(m[1]); };
  add(/\bfunction\s+([A-Za-z_$][\w$]*)/g);                    // function foo()
  add(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g);            // const foo = ...
  add(/\b([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function\b|\()/g);   // {foo: () =>}
  add(/^[ \t]*(?:async[ \t]+)?(?:(?:get|set)[ \t]+)?([A-Za-z_$][\w$]*)[ \t]*\([^()]*\)[ \t]*\{/gm); // {foo(a) {}}
  add(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g);
  add(/\b([A-Za-z_$][\w$]*)\s*=>/g);                           // x => ...
  // Destructured bindings, and every parameter name in any parameter list.
  let m;
  const destr = /\b(?:const|let|var)\s*\{([^}]*)\}/g;
  while ((m = destr.exec(src))) {
    m[1].split(',').forEach(t => {
      const n = t.split(':').pop().trim().split(/[=\s]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(n)) declared.add(n);
    });
  }
  const params = /\(([^()]*)\)\s*(?:=>|\{)/g;
  while ((m = params.exec(src))) {
    m[1].split(',').forEach(t => {
      const n = t.trim().replace(/^\.\.\./, '').split(/[=:\s]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(n)) declared.add(n);
    });
  }

  // Bare calls only: `name(` not preceded by a dot. Whether some object has a
  // given method is not something a scanner like this can know.
  const called = new Set();
  const call = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = call.exec(src))) called.add(m[2]);

  const missing = [...called].filter(n => !declared.has(n)).sort();
  if (missing.length) {
    console.log('  FAIL ' + rel + ' calls undeclared: ' + missing.join(', '));
    fail++;
  } else {
    console.log('  ok   ' + rel + ' — every function it calls is declared');
    pass++;
  }
}

// The exact regression this file was written for must stay caught.
const app = code(fs.readFileSync(path.join(ROOT, 'app/js/app.js'), 'utf8'));
const good = /\bstockExpected\s*\(/.test(app) && !/[^.\w$]stockCb\s*\(/.test(app);
console.log((good ? '  ok   ' : '  FAIL ') +
  'the stock helper is stockExpected, and stockCb is gone');
good ? pass++ : fail++;

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) {
  console.log('\nA name that is called but never declared throws only when a user reaches\n' +
    'that line — which is how the 29 Aug report outage stayed hidden for three\n' +
    'days. Fix the name, or add it to AMBIENT if it really comes from outside.');
}
process.exit(fail ? 1 : 0);
