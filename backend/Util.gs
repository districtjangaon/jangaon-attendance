/**
 * Util.gs — constants, schema, properties, sheet helpers, crypto helpers.
 *
 * Org model (from AWC DATA-31.07.2026.xlsx):
 *   District > Project (3: JGN/KDK/SGN) > Sector (27) > AWC (695).
 *   Field users are AWT/AWH tied to one AWC; an AWT+AWH pair usually shares
 *   the centre's phone, so PHONE IS NOT UNIQUE — identity is user_id.
 *
 * Script Properties used (set by setupAll() or manually):
 *   MASTER_ID        id of ATTENDANCE_MASTER spreadsheet
 *   PHOTOS_ROOT_ID   id of AttendancePhotos Drive folder
 *   HMAC_SECRET      random secret for session-token signing
 *   ATT_yyyy-MM      id of each monthly attendance spreadsheet
 *   GH_TOKEN         GitHub fine-grained token (contents:write on the Pages repo)
 *   GH_REPO          e.g. "someuser/attendance"
 *   GH_BRANCH        default "main"
 *   JITTER_MAX_SEC   client sync jitter ceiling, default 90
 *   USER_SEQ         id counter for console-added users (import seeds it)
 */

const TZ = 'Asia/Kolkata';
const PROPS = PropertiesService.getScriptProperties();
const CACHE = CacheService.getScriptCache();

// ---- sheet schemas (column order is the contract; never reorder) ----
const USERS_H = ['user_id', 'phone', 'name', 'cadre', 'project_code', 'sector_code', 'awc_id',
  'role', 'status', 'pin_hash', 'pin_salt', 'pin_set_at', 'failed_attempts', 'locked_until',
  'device_id', 'device_bound_at', 'created_at', 'updated_at'];
const AWC_H = ['awc_id', 'sector_code', 'project_code', 'name', 'lat', 'lng', 'radius_m', 'active'];
const PROJ_H = ['project_code', 'name'];
const SECT_H = ['sector_code', 'project_code', 'name', 'supervisor_user_id'];
const SCH_H = ['project_code', 'cadre', 'in_start', 'in_end', 'late_after', 'out_start', 'out_end'];
const HOL_H = ['date', 'name'];
// Medical columns were APPENDED after first ship (append-only rule): a SICK
// application must carry a government medical certificate, so the issuing
// institution, its certificate number and the Drive id of the photographed
// certificate ride along on the same row.
const LEAVE_H = ['leave_id', 'user_id', 'from_date', 'to_date', 'type', 'reason',
  'status', 'applied_at', 'decided_by', 'decided_at',
  'med_institution', 'med_cert_no', 'med_photo_id'];
const SESS_H = ['token_id', 'user_id', 'device_id', 'issued_at', 'expires_at', 'revoked'];
const AUD_H = ['ts', 'actor', 'action', 'target', 'old_value', 'new_value'];
const MARKS_H = ['key', 'user_id', 'sector_code', 'cadre', 'type', 'client_ts', 'server_ts', 'skew_sec',
  'lat', 'lng', 'accuracy_m', 'geofence', 'awc_id', 'distance_m', 'photo_id',
  'device_id', 'app_version', 'net_state', 'sync_delay_sec', 'flags'];
const CORR_H = ['corr_id', 'orig_key', 'actor', 'action', 'reason', 'ts'];
// New columns are APPENDED only (column order is the contract): the
// pregnant/others photos and the stock tracker landed after first ship.
const RPT_H = ['key', 'user_id', 'sector_code', 'awc_id', 'date', 'client_ts', 'server_ts',
  'lat', 'lng', 'accuracy_m', 'children', 'pregnant', 'others', 'meals',
  'photo_child_id', 'photo_meal_id', 'flags',
  'photo_pregnant_id', 'photo_others_id', 'eggs', 'rice_kg', 'pulses_kg',
  // stock register v2: per-item opening / used / received / closing.
  // The legacy eggs/rice_kg/pulses_kg columns above now carry closing values.
  'eggs_ob', 'eggs_used', 'eggs_recd', 'eggs_cb',
  'rice_ob', 'rice_used', 'rice_recd', 'rice_cb',
  'pulses_ob', 'pulses_used', 'pulses_recd', 'pulses_cb',
  'bal_ob', 'bal_used', 'bal_recd', 'bal_cb',
  'balp_ob', 'balp_used', 'balp_recd', 'balp_cb',
  'milk_ob', 'milk_used', 'milk_recd', 'milk_cb'];
const STOCK_KEYS = ['eggs', 'rice', 'pulses', 'bal', 'balp', 'milk'];
// Columns are append-only (order is the contract).
// Lifecycle: OPEN -> RESOLVED (the worker fixed it, with remark)
//         -> CLOSED (the supervisor confirmed, with remark).
const ISSUE_H = ['ts', 'raised_by', 'sector', 'about_user', 'issue', 'status',
  'category', 'issue_id', 'closed_ts', 'closed_by', 'close_remark',
  'resolved_ts', 'resolved_remark'];
const ISSUE_CATS = ['INCOMPLETE_REPORT', 'NO_REPORT', 'QTY_ANOMALY',
  'NOT_PRESENT', 'LATE', 'OTHER'];

// ---- policy constants ----
const PIN_ITERATIONS = 4000;      // salted SHA-256 iterations (bcrypt does not exist in Apps Script)
const TOKEN_DAYS = 30;            // session lifetime
const LOCKOUT_AFTER = 5;          // failed PINs before lockout
const LOCKOUT_MIN = 15;           // lockout duration
const GPS_UNVERIFIED_ACC_M = 250; // accuracy worse than this => UNVERIFIED
const OUT_EARLIEST_HM = '16:00'; // district rule 2026-08-20: no OUT before 4 PM
const GEOFENCE_MIN_RADIUS_M = 300; // district relaxation 2026-08-20: imported
// coordinates and consumer GPS aren't precise enough for tighter fences —
// every AWC's effective radius is at least this (larger per-AWC values win).
const PHOTO_RETENTION_DAYS = 45;  // per policy decision 2026-08-02
const BATCH_MAX = 20;             // max marks per sync POST
const CADRES = ['AWT', 'AWH', 'SUPERVISOR', 'CDPO', 'OTHER'];
const ROLES = ['FIELD', 'SUPERVISOR', 'CDPO', 'ADMIN'];

const U_ = headerIndex_(USERS_H);

function headerIndex_(headers) {
  const ix = {};
  headers.forEach((h, i) => { ix[h] = i; });
  return ix;
}

function rowToObj_(headers, row) {
  const o = {};
  headers.forEach((h, i) => { o[h] = row[i]; });
  return o;
}

// ---- responses & time ----
function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function fmtIso_(ms) { return Utilities.formatDate(new Date(ms), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"); }
function nowIso_() { return fmtIso_(Date.now()); }
function fmtDay_(ms) { return Utilities.formatDate(new Date(ms), TZ, 'yyyy-MM-dd'); }

/** "HH:mm" (or a Sheets time-of-day Date) -> minutes since midnight, or null. */
function hmToMin_(v) {
  const s = hmStr_(v);
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function hmStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'HH:mm');
  return String(v == null ? '' : v).trim();
}

function pad_(n, width) { return String(n).padStart(width, '0'); }

// ---- crypto ----
function toHex_(bytes) {
  return bytes.map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

/** Salted, iterated SHA-256. Fixed iteration count so hashes stay verifiable. */
function hashPin_(pin, salt) {
  let bytes = Utilities.newBlob(salt + ':' + pin).getBytes();
  for (let i = 0; i < PIN_ITERATIONS; i++) {
    bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
  }
  return toHex_(bytes);
}

function hmac_(payload) {
  return toHex_(Utilities.computeHmacSha256Signature(payload, PROPS.getProperty('HMAC_SECRET')));
}

// ---- master spreadsheet access ----
function masterSS_() { return SpreadsheetApp.openById(PROPS.getProperty('MASTER_ID')); }

/** First row (1-based) in `sheet` whose column `colIndex1` equals `value` exactly; 0 if none. */
function findRowByValue_(sheet, colIndex1, value) {
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const hit = sheet.getRange(2, colIndex1, last - 1, 1)
    .createTextFinder(String(value)).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}

/** All matching row numbers. */
function findRowsByValue_(sheet, colIndex1, value) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, colIndex1, last - 1, 1)
    .createTextFinder(String(value)).matchEntireCell(true).findAll()
    .map(r => r.getRow());
}

// ---- users ----
function userAtRow_(sh, row) {
  const o = rowToObj_(USERS_H, sh.getRange(row, 1, 1, USERS_H.length).getValues()[0]);
  o._row = row;
  return o;
}

/**
 * ALL users registered under a phone. AWT+AWH pairs share the centre phone
 * (190 of 695 AWCs in the source data), so this is a list, never a single row.
 */
function getUsersByPhone_(phone) {
  const sh = masterSS_().getSheetByName('Users');
  return findRowsByValue_(sh, U_.phone + 1, phone).map(r => userAtRow_(sh, r));
}

function getUserById_(id) {
  const c = CACHE.get('uid_' + id);
  if (c) return JSON.parse(c);
  const sh = masterSS_().getSheetByName('Users');
  const row = findRowByValue_(sh, U_.user_id + 1, id);
  if (!row) return null;
  const u = userAtRow_(sh, row);
  CACHE.put('uid_' + id, JSON.stringify(u), 300);
  return u;
}

function updateUser_(user, updates) {
  const sh = masterSS_().getSheetByName('Users');
  const row = user._row || findRowByValue_(sh, U_.user_id + 1, user.user_id);
  Object.keys(updates).forEach(k => {
    sh.getRange(row, U_[k] + 1).setValue(updates[k]);
    user[k] = updates[k];
  });
  sh.getRange(row, U_.updated_at + 1).setValue(nowIso_());
  CACHE.remove('uid_' + user.user_id);
}

function getUsersAll_() {
  const sh = masterSS_().getSheetByName('Users');
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, USERS_H.length).getValues().map((r, i) => {
    const o = rowToObj_(USERS_H, r);
    o._row = i + 2;
    return o;
  });
}

// ---- org: projects, sectors, AWCs (all cached) ----
function getProjects_() {
  const c = CACHE.get('projects');
  if (c) return JSON.parse(c);
  const sh = masterSS_().getSheetByName('Projects');
  const last = sh.getLastRow();
  const out = last < 2 ? [] : sh.getRange(2, 1, last - 1, PROJ_H.length).getValues()
    .map(r => ({ code: String(r[0]), name: String(r[1]) }));
  CACHE.put('projects', JSON.stringify(out), 600);
  return out;
}

function getSectors_() {
  const c = CACHE.get('sectors');
  if (c) return JSON.parse(c);
  const sh = masterSS_().getSheetByName('Sectors');
  const last = sh.getLastRow();
  const out = last < 2 ? [] : sh.getRange(2, 1, last - 1, SECT_H.length).getValues()
    .map(r => ({ code: String(r[0]), project: String(r[1]), name: String(r[2]), sup: String(r[3]) }));
  CACHE.put('sectors', JSON.stringify(out), 600);
  return out;
}

function awcFromRow_(r) {
  return { awc_id: String(r[0]), sector: String(r[1]), project: String(r[2]), name: String(r[3]),
    lat: r[4] === '' || r[4] == null ? null : Number(r[4]),
    lng: r[5] === '' || r[5] == null ? null : Number(r[5]),
    radius_m: Number(r[6]) || 200, active: String(r[7]) !== 'FALSE' };
}

function getAwc_(awcId) {
  if (!awcId) return null;
  const c = CACHE.get('awc_' + awcId);
  if (c) return JSON.parse(c);
  const sh = masterSS_().getSheetByName('AWCs');
  const row = findRowByValue_(sh, 1, awcId);
  if (!row) return null;
  const a = awcFromRow_(sh.getRange(row, 1, 1, AWC_H.length).getValues()[0]);
  CACHE.put('awc_' + awcId, JSON.stringify(a), 600);
  return a;
}

/** Active AWCs of one sector (~15–40 rows; cached — supervisors geofence against these). */
function getSectorAwcs_(sectorCode) {
  const c = CACHE.get('sawcs_' + sectorCode);
  if (c) return JSON.parse(c);
  const sh = masterSS_().getSheetByName('AWCs');
  const out = findRowsByValue_(sh, 2, sectorCode)
    .map(r => awcFromRow_(sh.getRange(r, 1, 1, AWC_H.length).getValues()[0]))
    .filter(a => a.active);
  CACHE.put('sawcs_' + sectorCode, JSON.stringify(out), 600);
  return out;
}

/**
 * Geofence candidates for a user's marks:
 *   FIELD -> their own AWC; SUPERVISOR -> every AWC in their sector (they mark
 *   from whichever centre they are inspecting); CDPO/ADMIN -> none (UNVERIFIED).
 */
function geofenceCandidatesFor_(user) {
  const role = String(user.role);
  if (role === 'SUPERVISOR') {
    // Possibly multi-sector (dual charge): valid from any AWC of any of them.
    return String(user.sector_code).split(',').map(s => s.trim()).filter(Boolean)
      .reduce(function (all, sc) { return all.concat(getSectorAwcs_(sc)); }, []);
  }
  const awc = getAwc_(String(user.awc_id));
  return awc && awc.active ? [awc] : [];
}

/** First sector of a possibly comma-separated charge list — the sector a
 *  supervisor's own rows are recorded/counted under. */
function primarySector_(user) {
  return String(user.sector_code).split(',')[0].trim();
}

function getSchedules_() {
  const c = CACHE.get('schedules');
  if (c) return JSON.parse(c);
  const sh = masterSS_().getSheetByName('Schedules');
  const last = sh.getLastRow();
  const out = last < 2 ? [] : sh.getRange(2, 1, last - 1, SCH_H.length).getValues().map(r => ({
    project_code: String(r[0]).trim(), cadre: String(r[1]).trim(),
    in_start: hmStr_(r[2]), in_end: hmStr_(r[3]), late_after: hmStr_(r[4]),
    out_start: hmStr_(r[5]), out_end: hmStr_(r[6])
  }));
  CACHE.put('schedules', JSON.stringify(out), 600);
  return out;
}

// ---- holidays (state list in the Holidays tab; Sundays by rule) ----
function getHolidays_() {
  const c = CACHE.get('holidays');
  if (c) return JSON.parse(c);
  const sh = masterSS_().getSheetByName('Holidays');
  const out = {};
  if (sh && sh.getLastRow() >= 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, HOL_H.length).getValues().forEach(r => {
      const d = r[0] instanceof Date ? Utilities.formatDate(r[0], TZ, 'yyyy-MM-dd') : String(r[0]).trim();
      if (d) out[d] = String(r[1] || 'Holiday').trim();
    });
  }
  CACHE.put('holidays', JSON.stringify(out), 3600);
  return out;
}

/** 'Sunday', the holiday name, or '' for a working day. dateStr = yyyy-MM-dd. */
function holidayFor_(dateStr) {
  const dow = Utilities.formatDate(new Date(dateStr + 'T12:00:00+05:30'), TZ, 'u');
  if (dow === '7') return 'Sunday';
  return getHolidays_()[dateStr] || '';
}

/** Most specific matching schedule row: project+cadre > project > cadre > ALL. */
function scheduleFor_(project, cadre) {
  let best = null, bestScore = -1;
  for (const r of getSchedules_()) {
    const pOK = r.project_code === project, pAll = r.project_code === 'ALL';
    const cOK = r.cadre === cadre, cAll = r.cadre === 'ALL';
    if (!(pOK || pAll) || !(cOK || cAll)) continue;
    const score = (pOK ? 2 : 0) + (cOK ? 1 : 0);
    if (score > bestScore) { best = r; bestScore = score; }
  }
  return best;
}

// ---- geometry ----
function distM_(lat1, lng1, lat2, lng2) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

// ---- audit ----
function audit_(actor, action, target, oldValue, newValue) {
  masterSS_().getSheetByName('Audit').appendRow([
    nowIso_(), String(actor), String(action), String(target),
    typeof oldValue === 'object' ? JSON.stringify(oldValue) : String(oldValue == null ? '' : oldValue),
    typeof newValue === 'object' ? JSON.stringify(newValue) : String(newValue == null ? '' : newValue)
  ]);
}

// ---- id sequences ----
function nextSeq_(name) {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const n = Number(PROPS.getProperty(name) || '0') + 1;
    PROPS.setProperty(name, String(n));
    return n;
  } finally {
    lock.releaseLock();
  }
}
