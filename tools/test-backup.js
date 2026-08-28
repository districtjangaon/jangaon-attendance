// Checks the Drive backup before it is scheduled against live data.
//
//   node tools/test-backup.js
//
// The dangerous part of a backup script is not the copying, it is the pruning:
// a wrong sort or a loose name test trashes the wrong folders. That is what
// these checks are for.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.dirname(__dirname);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  console.log((cond ? '  ok   ' : '  FAIL ') + label +
    (cond || !detail ? '' : '\n         ' + detail));
  cond ? pass++ : fail++;
}

// ------------------------------------------------------------- fake Drive
function makeFolder(name, sub) {
  const f = {
    name: name, trashed: false, folders: (sub || []), files: [],
    getName: () => f.name,
    getUrl: () => 'https://drive/' + f.name,
    setDescription: () => f,
    setTrashed: v => { f.trashed = v; },
    createFolder: n => { const c = makeFolder(n); f.folders.push(c); return c; },
    getFolders: () => iter(f.folders.filter(x => !x.trashed)),
    getFiles: () => iter(f.files)
  };
  return f;
}
const iter = arr => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };

let copies = [];
const FILES = {};
const mkFile = (id, name) => (FILES[id] = {
  getName: () => name, getSize: () => 1024,
  makeCopy: (n, dest) => { copies.push({ from: name, as: n, into: dest.getName() });
    dest.files.push({ getName: () => n, getSize: () => 1024 }); return {}; }
});

let ROOT_FOLDER;
const PROPS = {};

const ctx = {
  console, JSON, Math, Date, String, Number, Array, Object, RegExp, isFinite, Error,
  Logger: { log: () => {} },
  Session: { getScriptTimeZone: () => 'Asia/Kolkata' },
  Utilities: {
    formatDate: (d, tz, pat) => {
      const t = new Date(new Date(d).getTime() + 5.5 * 3600000);
      if (pat === 'yyyy-MM-dd_HHmm') {
        return t.toISOString().slice(0, 10) + '_' + t.toISOString().slice(11, 13) +
          t.toISOString().slice(14, 16);
      }
      return t.toISOString();
    }
  },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: k => PROPS[k] || null,
      getProperties: () => Object.assign({}, PROPS),
      setProperty: (k, v) => { PROPS[k] = v; }
    })
  },
  CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
  SpreadsheetApp: { openById: () => { throw new Error('not needed'); } },
  ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ atHour: () => ({ everyDays: () => ({ create: () => {} }) }) }) }), deleteTrigger: () => {} },
  DriveApp: {
    getFileById: id => { if (!FILES[id]) throw new Error('File not found: ' + id); return FILES[id]; },
    getFoldersByName: n => iter(ROOT_FOLDER && ROOT_FOLDER.getName() === n ? [ROOT_FOLDER] : []),
    createFolder: n => { ROOT_FOLDER = makeFolder(n); return ROOT_FOLDER; }
  },
  MailApp: { sendEmail: () => {} }, UrlFetchApp: {}
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'backend', 'Util.gs'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'backend', 'Backup.gs'), 'utf8'), ctx);
const g = e => vm.runInContext(e, ctx);

function reset(existingStamps) {
  copies = [];
  Object.keys(FILES).forEach(k => delete FILES[k]);
  Object.keys(PROPS).forEach(k => delete PROPS[k]);
  ROOT_FOLDER = makeFolder(g('BACKUP_FOLDER_NAME'),
    (existingStamps || []).map(s => makeFolder(s)));
}

// ------------------------------------------------------------ what it copies
console.log('\nWhat a backup copies');
reset();
PROPS.MASTER_ID = 'M1';
PROPS['ATT_2026-07'] = 'A7';
PROPS['ATT_2026-08'] = 'A8';
PROPS.PHOTOS_ROOT_ID = 'PHOTOS';
PROPS.HMAC_SECRET = 'secret';
mkFile('M1', 'MASTER'); mkFile('A7', 'ATT 07'); mkFile('A8', 'ATT 08');
mkFile('PHOTOS', 'photo root');
let r = ctx.backupNow();
check('the master workbook is copied', copies.some(c => c.from === 'MASTER'),
  JSON.stringify(copies));
check('every monthly attendance workbook is copied',
  copies.filter(c => c.from.indexOf('ATT') === 0).length === 2, JSON.stringify(copies));
check('attendance photographs are NOT copied',
  !copies.some(c => c.from === 'photo root'),
  'copying them would defeat the retention policy: ' + JSON.stringify(copies));
check('a script secret is not mistaken for a file id',
  !copies.some(c => c.from === 'secret'), JSON.stringify(copies));
check('everything lands in one dated folder',
  new Set(copies.map(c => c.into)).size === 1 &&
  /^\d{4}-\d{2}-\d{2}_\d{4}$/.test(copies[0].into), JSON.stringify(copies));

// -------------------------------------------------------------- failure
console.log('\nWhen something cannot be copied');
reset();
PROPS.MASTER_ID = 'GONE';
let threw = false;
try { ctx.backupNow(); } catch (e) { threw = /incomplete/i.test(e.message); }
check('an unreadable workbook fails the run rather than passing quietly', threw,
  'a silent partial backup is worse than none - the trigger must report failure');

// --------------------------------------------------------------- pruning
console.log('\nPruning');
const stamps = n => Array.from({ length: n }, (_, i) =>
  '2026-0' + (1 + Math.floor(i / 28)) + '-' + String((i % 28) + 1).padStart(2, '0') + '_2300');

reset(stamps(40));
PROPS.MASTER_ID = 'M1'; mkFile('M1', 'MASTER');
r = ctx.backupNow();
const keep = g('BACKUP_KEEP');
const left = ROOT_FOLDER.folders.filter(f => !f.trashed).length;
check('no more than the retention count survives', left === keep,
  left + ' left, keeping ' + keep);
check('the oldest are the ones trashed',
  r.pruned.every(p => p < '2026-02'), JSON.stringify(r.pruned.slice(0, 3)));
check('today\'s backup is never pruned',
  ROOT_FOLDER.folders.some(f => !f.trashed && f.files.length > 0));

reset(['2026-08-01_2300', 'Manual copy before import', 'notes']);
PROPS.MASTER_ID = 'M1'; mkFile('M1', 'MASTER');
r = ctx.backupNow();
check('folders an officer filed by hand are left alone',
  ROOT_FOLDER.folders.filter(f => f.trashed).length === 0,
  JSON.stringify(ROOT_FOLDER.folders.map(f => f.getName() + (f.trashed ? ' TRASHED' : ''))));

reset(stamps(5));
PROPS.MASTER_ID = 'M1'; mkFile('M1', 'MASTER');
r = ctx.backupNow();
check('nothing is pruned below the retention count', r.pruned.length === 0,
  JSON.stringify(r.pruned));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
