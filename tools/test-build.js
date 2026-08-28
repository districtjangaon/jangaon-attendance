// Build-integrity checks. These are the failures that reach every phone at
// once and are invisible from the desk:
//
//  1. The service-worker cache name not matching the app build tag. The shell
//     is served cache-first and the browser only re-installs the worker when
//     the bytes of sw.js change, so a build that leaves the cache name alone
//     never reaches a phone that already has the old one - which is exactly
//     what happened to app v5.17, v5.18 and v5.19.
//  2. A file listed in SHELL that is not on disk. cache.addAll() rejects as a
//     unit, so ONE bad path means the install fails, the worker never
//     activates, and every phone silently keeps the shell it already had.
//
// Run: node tools/test-build.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond || !detail ? '' : '\n         ' + detail));
  cond ? pass++ : fail++;
}

const appHtml = read('app/index.html');
const conHtml = read('console/index.html');
const sw = read('app/sw.js');

console.log('\nBuild tags');
const appTags = appHtml.match(/BUILD: v\d+\.\d+-\d{8}-\d{4}/g) || [];
const conTags = conHtml.match(/BUILD: v\d+\.\d+-\d{8}-\d{4}/g) || [];
check('the app carries exactly one build tag', appTags.length === 1, JSON.stringify(appTags));
check('the console carries exactly one build tag', conTags.length === 1, JSON.stringify(conTags));

console.log('\nService worker');
const caches = sw.match(/const CACHE = '([^']+)';/);
check('the service worker names one shell cache', !!caches, String(caches));
if (caches && appTags.length === 1) {
  const want = 'attendance-' + appTags[0].replace('BUILD: ', '');
  // This is the check that would have caught the stale-shell bug.
  check('the cache name matches the app build tag', caches[1] === want,
    'cache ' + caches[1] + '\n         tag   ' + want +
    '\n         run: python tools/bump-build.py --app <version>');
}

// Every shell path must resolve, or the install rejects and no phone updates.
const shellBlock = sw.match(/const SHELL = \[([\s\S]*?)\];/);
check('the shell list can be read', !!shellBlock);
if (shellBlock) {
  const files = (shellBlock[1].match(/'([^']+)'/g) || []).map(s => s.slice(1, -1));
  check('the shell list is not empty', files.length > 0, files.length + ' entries');
  const missing = files.filter(f => f !== './' &&
    !fs.existsSync(path.join(ROOT, 'app', f.replace(/^\.\//, ''))));
  check('every shell file exists on disk', missing.length === 0, missing.join(', '));
  const dupes = files.filter((f, i) => files.indexOf(f) !== i);
  check('no path is listed twice', dupes.length === 0, dupes.join(', '));
  // A shell entry that git does not track is on this machine only: the
  // deployed site would 404 it and the install would reject there, not here.
  const { execFileSync } = require('child_process');
  const untracked = files.filter(f => {
    if (f === './') return false;
    try {
      execFileSync('git', ['ls-files', '--error-unmatch', 'app/' + f.replace(/^\.\//, '')],
        { cwd: ROOT, stdio: 'ignore' });
      return false;
    } catch (e) { return true; }
  });
  check('every shell file is committed, not local-only', untracked.length === 0,
    untracked.join(', '));
}

// ------------------------------------------------- backend OAuth scopes
// appsscript.json pins oauthScopes explicitly, so Apps Script never infers a
// missing one; the first symptom is an exception in production. Every Google
// service the backend calls must have its scope declared here.
console.log('\nBackend OAuth scopes');
const manifest = JSON.parse(read('backend/appsscript.json'));
const scopes = manifest.oauthScopes || [];
const backendSrc = fs.readdirSync(path.join(ROOT, 'backend'))
  .filter(f => f.endsWith('.gs') && f !== 'COMBINED.gs')
  .map(f => read('backend/' + f)).join('\n');

const NEEDS = [
  [/\bMailApp\s*\./, 'script.send_mail', 'MailApp.sendEmail'],
  [/\bGmailApp\s*\./, 'gmail.send', 'GmailApp'],
  [/\bUrlFetchApp\s*\./, 'script.external_request', 'UrlFetchApp.fetch'],
  [/ScriptApp\.(newTrigger|getProjectTriggers|deleteTrigger)/, 'script.scriptapp',
   'trigger management'],
  [/\bDriveApp\s*\.|SpreadsheetApp\.create/, 'drive', 'Drive file access'],
  [/\bSpreadsheetApp\s*\./, 'spreadsheets', 'SpreadsheetApp'],
  [/Session\.getEffectiveUser|Session\.getActiveUser/, 'userinfo.email',
   'the signed-in address']
];
NEEDS.forEach(pair => {
  if (!pair[0].test(backendSrc)) return;
  const declared = scopes.some(x => x.split('/').pop() === pair[1]);
  check('the backend calls ' + pair[2] + ', so ' + pair[1] + ' is declared', declared,
    'add https://www.googleapis.com/auth/' + pair[1] + ' to backend/appsscript.json');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
