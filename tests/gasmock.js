/* A mocked Apps Script world, enough of it to run the backend's feature
   modules on a laptop. Ported from the SJGP register's tests/gasmock.js and
   cut to what THIS backend touches: Sheets by id, script properties, the
   script cache (whole and chunked), Drive folders and files, triggers, mail,
   UrlFetch, and a clock the suites can set.

   WHAT IT IS NOT: a Sheets engine. Values are stored as given; a range reads
   back what was written, '' where nothing was. A TextFinder matches whole
   cells by string equality, which is what every caller here asks of it.

   Usage:
     const { load } = require('./gasmock');
     const env = load({ now: '2026-10-24T09:15:00+05:30' });
     env.seed();                          // the standing roll
     env.call('myDays', 'U0001', {});     // a feature action, as doPost would dispatch it
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const BACKEND = path.join(ROOT, 'backend');

/* ---------- time, in a named zone ---------- */
function parts(d, tz) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset' });
  const o = {};
  f.formatToParts(d).forEach(p => { o[p.type] = p.value; });
  if (o.hour === '24') o.hour = '00';
  const dow = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[o.weekday] || 0;
  let off = (o.timeZoneName || 'GMT').replace('GMT', '') || '+00:00';
  if (off === 'Z' || off === '') off = '+00:00';
  if (/^[+-]\d{2}$/.test(off)) off += ':00';
  if (/^[+-]\d:\d\d$/.test(off)) off = off[0] + '0' + off.slice(1);
  return { y: o.year, M: o.month, d: o.day, H: o.hour, m: o.minute, s: o.second, u: String(dow), X: off };
}
/* the Utilities.formatDate patterns the backend uses, and no more */
function fmtInTz(d, tz, fmt) {
  const p = parts(d, tz);
  let out = '';
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c === "'") { const j = fmt.indexOf("'", i + 1); out += fmt.slice(i + 1, j); i = j; continue; }
    let n = 1;
    while (fmt[i + n] === c) n++;
    const run = fmt.slice(i, i + n);
    i += n - 1;
    if (run === 'yyyy') out += p.y;
    else if (run === 'yy') out += p.y.slice(2);
    else if (run === 'MM') out += p.M;
    else if (run === 'dd') out += p.d;
    else if (run === 'HH') out += p.H;
    else if (run === 'mm') out += p.m;
    else if (run === 'ss') out += p.s;
    else if (run === 'u') out += p.u;
    else if (run === 'XXX') out += p.X;
    else if (run === 'EEE') out += ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][Number(p.u)];
    else out += run;
  }
  return out;
}

/* ---------- Sheets ---------- */
class MockRange {
  constructor(sh, r, c, nr, nc) { this.sh = sh; this.r = r; this.c = c; this.nr = nr; this.nc = nc; }
  getRow() { return this.r; }
  getColumn() { return this.c; }
  getNumRows() { return this.nr; }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = this.sh.rows[this.r - 1 + i] || [];
      const o = [];
      for (let j = 0; j < this.nc; j++) { const v = row[this.c - 1 + j]; o.push(v === undefined ? '' : v); }
      out.push(o);
    }
    return out;
  }
  setValues(vals) {
    for (let i = 0; i < vals.length; i++) {
      while (this.sh.rows.length < this.r + i) this.sh.rows.push([]);
      const row = this.sh.rows[this.r - 1 + i];
      for (let j = 0; j < vals[i].length; j++) row[this.c - 1 + j] = vals[i][j];
    }
    return this;
  }
  getValue() { return this.getValues()[0][0]; }
  setValue(v) { return this.setValues([[v]]); }
  getDisplayValues() { return this.getValues().map(r => r.map(v => v instanceof Date ? fmtInTz(v, this.sh.env.tz, 'yyyy-MM-dd') : String(v))); }
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
  setBackground() { return this; }
  clearContent() { for (let i = 0; i < this.nr; i++) { const row = this.sh.rows[this.r - 1 + i]; if (row) for (let j = 0; j < this.nc; j++) row[this.c - 1 + j] = ''; } return this; }
  /* whole-cell string equality, which is the only way the backend uses it */
  createTextFinder(text) {
    const self = this, want = String(text);
    let entire = false;
    const hits = () => {
      const out = [];
      for (let i = 0; i < self.nr; i++) for (let j = 0; j < self.nc; j++) {
        const row = self.sh.rows[self.r - 1 + i] || [];
        const v = row[self.c - 1 + j];
        const s = v === undefined || v === null ? '' : String(v);
        if (entire ? s === want : s.indexOf(want) >= 0) out.push(new MockRange(self.sh, self.r + i, self.c + j, 1, 1));
      }
      return out;
    };
    return {
      matchEntireCell(b) { entire = !!b; return this; },
      matchCase() { return this; },
      findNext() { const h = hits(); return h.length ? h[0] : null; },
      findAll() { return hits(); }
    };
  }
}

class MockSheet {
  constructor(name, env) { this.name = name; this.env = env; this.rows = []; }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  getMaxRows() { return Math.max(1000, this.rows.length); }
  appendRow(arr) { this.rows.push(arr.slice()); return this; }
  getRange(r, c, nr, nc) {
    if (typeof r === 'string') return new MockRange(this, 1, 1, 0, 0);   // 'A:T' and the like: formatting only
    return new MockRange(this, r, c, nr === undefined ? 1 : nr, nc === undefined ? 1 : nc);
  }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  deleteRow(r) { this.rows.splice(r - 1, 1); return this; }
  deleteRows(r, n) { this.rows.splice(r - 1, n); return this; }
  clear() { this.rows = []; return this; }
  setFrozenRows() { return this; }
  hideSheet() { return this; }
}

class MockSpreadsheet {
  constructor(id, name, env) { this.id = id; this.name = name; this.env = env; this.sheets = {}; this.order = []; this.tz = env.tz; }
  getId() { return this.id; }
  getName() { return this.name; }
  getUrl() { return 'https://sheets.mock/' + this.id; }
  getSheetByName(n) { return this.sheets[n] || null; }
  getSheets() { return this.order.map(n => this.sheets[n]).filter(Boolean); }
  insertSheet(n) { const sh = new MockSheet(n, this.env); this.sheets[n] = sh; this.order.push(n); return sh; }
  deleteSheet(sh) { delete this.sheets[sh.name]; this.order = this.order.filter(n => n !== sh.name); }
  setSpreadsheetTimeZone(tz) { this.tz = tz; }
  getSpreadsheetTimeZone() { return this.tz; }
}

/* ---------- Drive ---------- */
function mockIter(arr) { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; }
function mockBlob(data, type, name) {
  return {
    data: data, type: type, name: name,
    getName() { return this.name; }, setName(n) { this.name = n; return this; },
    getContentType() { return this.type; }, setContentType(t) { this.type = t; return this; },
    getBytes() { return Buffer.isBuffer(this.data) ? Array.from(this.data) : Array.from(Buffer.from(String(this.data))); },
    getDataAsString() { return Buffer.isBuffer(this.data) ? this.data.toString('utf8') : String(this.data); }
  };
}
let driveSeq = 0;
class MockFile {
  constructor(name, blob, parent) {
    this.name = name; this.blob = blob; this.parentName = parent ? parent.name : '';
    this.id = 'mockfile-' + (++driveSeq); this.trashed = false; this.sharing = null; this.created = new Date();
  }
  getId() { return this.id; }
  getName() { return this.name; }
  getBlob() { return this.blob; }
  getUrl() { return 'https://drive.mock/' + this.parentName + '/' + this.name; }
  getSize() { return this.blob && this.blob.data != null ? Buffer.byteLength(Buffer.isBuffer(this.blob.data) ? this.blob.data : String(this.blob.data)) : 0; }
  getMimeType() { return (this.blob && this.blob.type) || 'application/octet-stream'; }
  getDateCreated() { return this.created; }
  setSharing(a, p) { this.sharing = { access: a, permission: p }; return this; }
  setTrashed(t) { this.trashed = !!t; return this; }
  isTrashed() { return this.trashed; }
  makeCopy(name, folder) { return folder.createFile(mockBlob('copy-of-' + this.name, this.getMimeType(), name)); }
}
class MockFolder {
  constructor(name) { this.name = name; this.folders = {}; this.files = []; this.trashed = false; this.id = 'mockfolder-' + (++driveSeq); }
  getId() { return this.id; }
  getName() { return this.name; }
  live() { return this.files.filter(f => !f.trashed); }
  getFoldersByName(n) { const hit = this.folders[n] && !this.folders[n].trashed ? [this.folders[n]] : []; return mockIter(hit); }
  getFilesByName(n) { return mockIter(this.live().filter(f => f.getName() === n)); }
  getFiles() { return mockIter(this.live()); }
  getFolders() { return mockIter(Object.keys(this.folders).map(k => this.folders[k]).filter(f => !f.trashed)); }
  createFolder(n) { const f = new MockFolder(n); this.folders[n] = f; return f; }
  createFile(blob) { const f = new MockFile((blob && (blob.name || (blob.getName && blob.getName()))) || 'file', blob, this); this.files.push(f); return f; }
  getUrl() { return 'https://drive.mock/' + this.name; }
  setSharing() { return this; }
  setTrashed(t) { this.trashed = !!t; return this; }
  isTrashed() { return this.trashed; }
}

/* ---------- the backend files, in the order the deploy concatenates them ---------- */
function buildOrder() {
  const py = fs.readFileSync(path.join(ROOT, 'tools', 'build-combined.py'), 'utf8');
  const m = py.match(/ORDER\s*=\s*\[([\s\S]*?)\]/);
  const names = m ? Array.from(m[1].matchAll(/'([^']+\.gs)'/g)).map(x => x[1]) : [];
  const onDisk = fs.readdirSync(BACKEND).filter(f => /\.gs$/.test(f) && f !== 'COMBINED.gs');
  const extra = onDisk.filter(f => names.indexOf(f) < 0).sort();
  return names.filter(f => onDisk.indexOf(f) >= 0).concat(extra);
}

/* ---------- the world ---------- */
function load(opts) {
  opts = opts || {};
  const env = {
    tz: 'Asia/Kolkata',
    props: {}, cacheStore: {}, outbox: [], logs: [], fetches: [], installed: [], triggers: [],
    spreadsheets: {}, driveRoot: new MockFolder('root'), mailQuota: 100,
    fetchReply: null, fetchCode: 200
  };
  const clock = { now: Date.parse(opts.now || '2026-10-24T09:15:00+05:30') };
  env.setNow = iso => { clock.now = Date.parse(iso); };
  class FakeDate extends Date {
    constructor(...a) { if (a.length === 0) super(clock.now); else super(...a); }
    static now() { return clock.now; }
  }

  const sandbox = {
    Date: FakeDate,
    console: { log() {}, warn() {}, error() {} },
    SpreadsheetApp: {
      openById: id => { const ss = env.spreadsheets[id]; if (!ss) throw new Error('no spreadsheet ' + id); return ss; },
      create: name => { const id = 'ss-' + crypto.randomBytes(4).toString('hex'); const ss = new MockSpreadsheet(id, name, env); ss.insertSheet('Sheet1'); env.spreadsheets[id] = ss; return ss; },
      flush() {}
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (env.props[k] === undefined ? null : env.props[k]),
        setProperty: (k, v) => { env.props[k] = String(v); },
        deleteProperty: k => { delete env.props[k]; },
        getProperties: () => Object.assign({}, env.props)
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: k => (env.cacheStore[k] === undefined ? null : env.cacheStore[k]),
        put: (k, v) => { if (String(v).length > 100 * 1024) throw new Error('Argument too large: value'); env.cacheStore[k] = String(v); },
        remove: k => { delete env.cacheStore[k]; },
        getAll: keys => { const o = {}; keys.forEach(k => { if (env.cacheStore[k] !== undefined) o[k] = env.cacheStore[k]; }); return o; },
        putAll: obj => { Object.keys(obj).forEach(k => { env.cacheStore[k] = String(obj[k]); }); },
        removeAll: keys => { keys.forEach(k => { delete env.cacheStore[k]; }); }
      })
    },
    Utilities: {
      formatDate: (d, tz, fmt) => fmtInTz(d, tz, fmt),
      getUuid: () => crypto.randomUUID(),
      base64Encode: x => (Buffer.isBuffer(x) ? x : Buffer.from(Array.isArray(x) ? x : String(x))).toString('base64'),
      base64Decode: s => Array.from(Buffer.from(String(s), 'base64')),
      computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(Array.isArray(s) ? Buffer.from(s) : String(s)).digest()),
      computeHmacSha256Signature: (s, k) => Array.from(crypto.createHmac('sha256', String(k)).update(String(s)).digest()),
      newBlob: (data, type, name) => mockBlob(Array.isArray(data) ? Buffer.from(data) : data, type, name),
      sleep: () => {},
      DigestAlgorithm: { SHA_256: 'SHA_256' }
    },
    Session: { getScriptTimeZone: () => env.tz, getEffectiveUser: () => ({ getEmail: () => 'district@mock.example' }) },
    ContentService: {
      createTextOutput: s => ({ _c: s, setMimeType() { return this; }, getContent() { return this._c; } }),
      MimeType: { JSON: 'application/json', TEXT: 'text/plain' }
    },
    LockService: {
      getScriptLock: () => ({ waitLock() {}, releaseLock() {}, tryLock() { return true; }, hasLock() { return true; } }),
      getDocumentLock: () => ({ waitLock() {}, releaseLock() {}, tryLock() { return true; } })
    },
    MailApp: {
      sendEmail: (to, subject, body, options) => { env.outbox.push(typeof to === 'object' ? to : { to, subject, body, options }); },
      getRemainingDailyQuota: () => env.mailQuota
    },
    GmailApp: { sendEmail: (to, subject, body, options) => { env.outbox.push({ to, subject, body, options }); } },
    DriveApp: {
      getRootFolder: () => env.driveRoot,
      getFoldersByName: n => env.driveRoot.getFoldersByName(n),
      createFolder: n => env.driveRoot.createFolder(n),
      getFolderById: id => { const walk = f => f.id === id ? f : Object.keys(f.folders).map(k => walk(f.folders[k])).find(Boolean); const hit = walk(env.driveRoot); if (!hit) throw new Error('no folder ' + id); return hit; },
      getFileById: id => { const walk = f => f.files.find(x => x.id === id) || Object.keys(f.folders).map(k => walk(f.folders[k])).find(Boolean); const hit = walk(env.driveRoot); if (!hit) throw new Error('no file ' + id); return hit; },
      Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK', PRIVATE: 'PRIVATE' },
      Permission: { VIEW: 'VIEW', NONE: 'NONE' }
    },
    ScriptApp: {
      getProjectTriggers: () => env.installed.map(name => ({ getHandlerFunction: () => name })),
      deleteTrigger: t => { const n = t.getHandlerFunction(); const i = env.installed.indexOf(n); if (i >= 0) env.installed.splice(i, 1); },
      newTrigger: name => ({
        timeBased() { return this; }, everyDays() { return this; }, everyMinutes() { return this; }, everyHours() { return this; },
        atHour() { return this; }, nearMinute() { return this; }, inTimezone() { return this; },
        create() { env.triggers.push(name); env.installed.push(name); return { getHandlerFunction: () => name }; }
      }),
      getScriptId: () => 'mock-script-id',
      getOAuthToken: () => 'mock-oauth-token',
      getService: () => ({ getUrl: () => 'https://script.mock/exec' })
    },
    UrlFetchApp: {
      fetch: (url, o) => {
        env.fetches.push({ url, opts: o });
        const r = typeof env.fetchReply === 'function' ? env.fetchReply(url, o) : env.fetchReply;
        const body = r === undefined || r === null ? '{}' : (typeof r === 'string' ? r : JSON.stringify(r));
        const code = typeof env.fetchCode === 'function' ? env.fetchCode(url) : env.fetchCode;
        return { getContentText: () => body, getResponseCode: () => code, getBlob: () => mockBlob(body, 'application/octet-stream', 'download'), getHeaders: () => ({}) };
      }
    },
    Logger: { log: s => { env.logs.push(String(s)); } }
  };
  sandbox.globalThis = sandbox;

  /* the master register exists before the backend is parsed: Util.gs reads
     script properties at the top level and everything else reads MASTER_ID */
  env.props.MASTER_ID = 'master-ss';
  env.props.HMAC_SECRET = 'mock-secret';
  env.master = new MockSpreadsheet('master-ss', 'ATTENDANCE_MASTER', env);
  env.spreadsheets['master-ss'] = env.master;

  const ctx = vm.createContext(sandbox);
  const order = buildOrder();
  order.forEach(f => vm.runInContext(fs.readFileSync(path.join(BACKEND, f), 'utf8'), ctx, { filename: f }));
  env.ctx = ctx;
  env.files = order;
  env.eval = code => vm.runInContext(code, ctx);

  /* ---- conveniences ---- */
  env.mkSheet = (name, headers, rowObjs, ss) => {
    const book = ss || env.master;
    const sh = book.getSheetByName(name) || book.insertSheet(name);
    sh.rows = [headers.slice()];
    (rowObjs || []).forEach(o => sh.appendRow(headers.map(h => (o[h] === undefined ? '' : o[h]))));
    return sh;
  };
  env.addRow = (name, obj, ss) => {
    const sh = (ss || env.master).getSheetByName(name);
    const head = sh.rows[0].map(String);
    sh.appendRow(head.map(h => (obj[h] === undefined ? '' : obj[h])));
  };
  env.rows = (name, ss) => {
    const sh = (ss || env.master).getSheetByName(name);
    if (!sh || sh.rows.length < 2) return [];
    const head = sh.rows[0].map(String);
    return sh.rows.slice(1).map(r => { const o = {}; head.forEach((h, i) => { o[h] = r[i] === undefined ? '' : r[i]; }); return o; });
  };
  env.col = (name, header, ss) => env.rows(name, ss).map(o => o[header]);
  env.month = ym => {
    const id = env.props['ATT_' + ym];
    if (id) return env.spreadsheets[id];
    const ss = new MockSpreadsheet('att-' + ym, 'ATT_' + ym.replace('-', '_'), env);
    env.spreadsheets[ss.id] = ss;
    env.props['ATT_' + ym] = ss.id;
    const H = env.eval('MARKS_H');
    env.mkSheet('Marks', H, [], ss);
    env.mkSheet('Corrections', env.eval('CORR_H'), [], ss);
    return ss;
  };
  /* one attendance mark, as Marks.gs would have written it */
  env.mark = (uid, date, type, hm, more) => {
    const ss = env.month(date.slice(0, 7));
    const u = env.rows('Users').find(x => String(x.user_id) === uid) || {};
    env.addRow('Marks', Object.assign({
      key: uid + '_' + date.replace(/-/g, '') + '_' + type, user_id: uid,
      sector_code: String(u.sector_code || '').split(',')[0], cadre: u.cadre || '', type: type,
      client_ts: date + 'T' + hm + ':00+05:30', server_ts: date + 'T' + hm + ':30+05:30', skew_sec: 0,
      lat: 17.7, lng: 79.1, accuracy_m: 12, geofence: 'INSIDE', awc_id: u.awc_id || '', distance_m: 20,
      photo_id: 'p', device_id: 'd', app_version: 'test', net_state: 'online', sync_delay_sec: 30, flags: '', tz: 'Asia/Kolkata'
    }, more || {}), ss);
  };
  env.post = body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
  /* the authenticated session doPost hands a handler, without the token dance */
  env.auth = uid => {
    const u = ctx.getUserById_(uid);
    if (!u) throw new Error('no such user in the seed: ' + uid);
    return { ok: true, tokenId: 'tok-' + uid, userId: uid, deviceId: 'dev-' + uid, user: u };
  };
  env.call = (action, uid, req) => ctx.featurePost_(env.auth(uid), Object.assign({ action: action, token: 'tok-' + uid }, req || {}));

  /* the standing roll: one project, two sectors, three centres, a pair on a shared phone */
  env.seed = extra => {
    env.mkSheet('Projects', ['project_code', 'name'], [{ project_code: 'JGN', name: 'Jangaon' }, { project_code: 'KDK', name: 'Kodakandla' }]);
    env.mkSheet('Sectors', ['sector_code', 'project_code', 'name', 'supervisor_user_id'], [
      { sector_code: 'S01', project_code: 'JGN', name: 'Jangaon Urban', supervisor_user_id: 'U0100' },
      { sector_code: 'S02', project_code: 'JGN', name: 'Jangaon Rural', supervisor_user_id: '' },
      { sector_code: 'S03', project_code: 'KDK', name: 'Kodakandla', supervisor_user_id: '' }
    ]);
    env.mkSheet('AWCs', ['awc_id', 'sector_code', 'project_code', 'name', 'lat', 'lng', 'radius_m', 'active'], [
      { awc_id: 'A0001', sector_code: 'S01', project_code: 'JGN', name: 'Alipur-I', lat: 17.7201, lng: 79.1502, radius_m: 200, active: 'TRUE' },
      { awc_id: 'A0002', sector_code: 'S01', project_code: 'JGN', name: 'Alipur-II', lat: 17.7255, lng: 79.1611, radius_m: 200, active: 'TRUE' },
      { awc_id: 'A0003', sector_code: 'S02', project_code: 'JGN', name: 'Bachannapet', lat: 17.7402, lng: 79.1203, radius_m: 200, active: 'TRUE' },
      { awc_id: 'A0009', sector_code: 'S02', project_code: 'JGN', name: 'Closed centre', lat: 17.7, lng: 79.1, radius_m: 200, active: 'FALSE' }
    ]);
    const U = env.eval('USERS_H');
    const user = (id, name, cadre, role, pj, sc, awc) => ({ user_id: id, phone: '9000000001', name: name, cadre: cadre, project_code: pj, sector_code: sc, awc_id: awc, role: role, status: 'ACTIVE', pin_hash: 'x', created_at: '2026-08-01T00:00:00+05:30', updated_at: '2026-08-01T00:00:00+05:30' });
    env.mkSheet('Users', U, [
      user('U0001', 'A. Punctual', 'AWT', 'FIELD', 'JGN', 'S01', 'A0001'),
      user('U0002', 'B. Helper', 'AWH', 'FIELD', 'JGN', 'S01', 'A0001'),
      user('U0003', 'C. Pinned', 'AWT', 'FIELD', 'JGN', 'S01', 'A0002'),
      user('U0004', 'D. Rural', 'AWT', 'FIELD', 'JGN', 'S02', 'A0003'),
      user('U0100', 'S. Supervisor', 'SUPERVISOR', 'SUPERVISOR', 'JGN', 'S01', ''),
      user('U0200', 'P. CDPO', 'CDPO', 'CDPO', 'JGN', '', ''),
      user('U2000', 'District Admin', 'OTHER', 'ADMIN', '', '', '')
    ].concat(extra || []));
    env.mkSheet('Schedules', ['project_code', 'cadre', 'in_start', 'in_end', 'late_after', 'out_start', 'out_end'],
      [{ project_code: 'ALL', cadre: 'ALL', in_start: '08:30', in_end: '10:00', late_after: '09:30', out_start: '16:00', out_end: '18:00' }]);
    env.mkSheet('Holidays', ['date', 'name'], [{ date: '2026-10-20', name: 'Deepavali' }]);
    env.mkSheet('Leaves', env.eval('LEAVE_H'), []);
    env.mkSheet('Audit', env.eval('AUD_H'), []);
    env.mkSheet('Sessions', env.eval('SESS_H'), []);
    Object.keys(env.cacheStore).forEach(k => { delete env.cacheStore[k]; });
  };

  return env;
}

module.exports = { load, fmtInTz, buildOrder, BACKEND };
