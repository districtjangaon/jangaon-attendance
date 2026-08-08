/**
 * Maintenance.gs — one-time setup, triggers, photo reaper, month pre-creation,
 * and the owner-run bulk import of the AWC master data.
 *
 * FIRST RUN: set Script Properties ADMIN_PHONE (10 digits) and ADMIN_NAME
 * (Project Settings > Script properties), then run setupAll() from the
 * editor. They live in properties, not code, so no real phone number is
 * ever committed to the (public) Pages repository.
 * IMPORT: paste the five tools/import-awc.py output CSVs into tabs named
 * IMPORT_PROJECTS / IMPORT_SECTORS / IMPORT_AWCS / IMPORT_USERS /
 * IMPORT_SCHEDULES in ATTENDANCE_MASTER (header rows included), run
 * importFromSheets(), then publishOrg().
 */

function setupAll() {
  const adminPhone = String(PROPS.getProperty('ADMIN_PHONE') || '').replace(/\D/g, '');
  if (!/^\d{10}$/.test(adminPhone)) {
    throw new Error('Set Script Property ADMIN_PHONE (10-digit mobile of the first admin) before running setupAll.');
  }
  if (!PROPS.getProperty('HMAC_SECRET')) {
    PROPS.setProperty('HMAC_SECRET', Utilities.getUuid() + Utilities.getUuid());
  }
  if (!PROPS.getProperty('MASTER_ID')) createMaster_();
  if (!PROPS.getProperty('PHOTOS_ROOT_ID')) {
    PROPS.setProperty('PHOTOS_ROOT_ID', DriveApp.createFolder('AttendancePhotos').getId());
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    getMonthSS_(Utilities.formatDate(new Date(), TZ, 'yyyy-MM'));
  } finally {
    lock.releaseLock();
  }
  bootstrapAdmin_();
  installTriggers_();
  return 'Setup complete. MASTER_ID=' + PROPS.getProperty('MASTER_ID');
}

function createMaster_() {
  const ss = SpreadsheetApp.create('ATTENDANCE_MASTER');
  ss.setSpreadsheetTimeZone(TZ);
  const tabs = [
    ['Users', USERS_H], ['AWCs', AWC_H], ['Projects', PROJ_H], ['Sectors', SECT_H],
    ['Schedules', SCH_H], ['Holidays', HOL_H], ['Sessions', SESS_H], ['Audit', AUD_H]
  ];
  tabs.forEach(t => {
    const sh = ss.insertSheet(t[0]);
    sh.getRange(1, 1, 1, t[1].length).setValues([t[1]]);
    sh.getRange(1, 1, sh.getMaxRows(), t[1].length).setNumberFormat('@'); // keep phones/ISO strings as text
  });
  const def = ss.getSheetByName('Sheet1');
  if (def) ss.deleteSheet(def);
  PROPS.setProperty('MASTER_ID', ss.getId());
}

function bootstrapAdmin_() {
  const phone = String(PROPS.getProperty('ADMIN_PHONE')).replace(/\D/g, '');
  if (getUsersByPhone_(phone).length) return;
  // Fixed id U2000, outside both the register range (U0001..) and the manual
  // console-account range (U2001..): an id-keyed import can never clobber it.
  upsertUser_({
    user_id: 'U2000', allowCreateWithId: true,
    phone: phone, name: String(PROPS.getProperty('ADMIN_NAME') || 'District Admin'),
    cadre: 'OTHER', role: 'ADMIN'
  }, 'SETUP');
}

function installTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('summaryTick').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('nightlyJob').timeBased().atHour(22).everyDays(1).create();
  ScriptApp.newTrigger('reaperJob').timeBased().atHour(2).everyDays(1).create();
  ScriptApp.newTrigger('monthPrep').timeBased().atHour(3).everyDays(1).create();
}

/**
 * Deletes photo day-folders older than PHOTO_RETENTION_DAYS.
 * Hard-deletes via the Drive advanced service so the bytes leave the quota
 * immediately (trash counts against quota for 30 days); falls back to trash.
 * Processes at most 3 day-folders per run to stay inside the 6-min limit.
 */
function reaperJob() {
  const cutoff = fmtDay_(Date.now() - PHOTO_RETENTION_DAYS * 86400000);
  const root = DriveApp.getFolderById(PROPS.getProperty('PHOTOS_ROOT_ID'));
  const it = root.getFolders();
  const victims = [];
  while (it.hasNext()) {
    const f = it.next();
    if (/^\d{4}-\d{2}-\d{2}$/.test(f.getName()) && f.getName() < cutoff) victims.push(f);
  }
  victims.sort((a, b) => a.getName() < b.getName() ? -1 : 1);
  let done = 0;
  for (const folder of victims.slice(0, 3)) {
    try {
      const files = folder.getFiles();
      while (files.hasNext()) Drive.Files.remove(files.next().getId());
      Drive.Files.remove(folder.getId());
    } catch (e) {
      folder.setTrashed(true); // quota frees 30 days later, but retention still enforced
    }
    done++;
  }
  console.log('reaper: removed ' + done + '/' + victims.length + ' day folders older than ' + cutoff);
}

/** From the 25th, make sure next month's spreadsheet exists before it's needed. */
function monthPrep() {
  const now = new Date();
  if (Number(Utilities.formatDate(now, TZ, 'd')) < 25) return;
  const y = Number(Utilities.formatDate(now, TZ, 'yyyy'));
  const m = Number(Utilities.formatDate(now, TZ, 'M'));
  const nextYm = m === 12 ? (y + 1) + '-01' : y + '-' + pad_(m + 1, 2);
  if (PROPS.getProperty('ATT_' + nextYm)) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    getMonthSS_(nextYm);
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Bulk import — owner-run from the editor. Idempotent: re-running with a
// corrected file updates org data and user master fields but NEVER touches
// pin_hash / device binding / status of existing users, and never deletes.
// ---------------------------------------------------------------------------

function importFromSheets() {
  const ss = masterSS_();
  const out = [];

  const readTab = (name, width) => {
    const sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return null;
    return sh.getRange(2, 1, sh.getLastRow() - 1, width).getValues()
      .filter(r => String(r[0]).trim());
  };

  const replaceTab = (name, headers, rows) => {
    const sh = ss.getSheetByName(name);
    if (sh.getLastRow() >= 2) sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).clearContent();
    if (rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  };

  // Projects: project_code,name
  const proj = readTab('IMPORT_PROJECTS', 2);
  if (proj) {
    replaceTab('Projects', PROJ_H, proj.map(r => [String(r[0]).trim(), String(r[1]).trim()]));
    CACHE.remove('projects');
    out.push('projects: ' + proj.length);
  }

  // Sectors: sector_code,project_code,name,supervisor_phone
  // supervisor_user_id resolves AFTER users import — run resolveSectorSupervisors() then.
  const sect = readTab('IMPORT_SECTORS', 4);
  if (sect) {
    replaceTab('Sectors', SECT_H, sect.map(r =>
      [String(r[0]).trim(), String(r[1]).trim(), String(r[2]).trim(), '']));
    CACHE.remove('sectors');
    out.push('sectors: ' + sect.length);
  }

  // AWCs: awc_id,sector_code,project_code,name,lat,lng,radius_m
  const awcs = readTab('IMPORT_AWCS', 7);
  if (awcs) {
    replaceTab('AWCs', AWC_H, awcs.map(r => [
      String(r[0]).trim(), String(r[1]).trim(), String(r[2]).trim(), String(r[3]).trim(),
      r[4] === '' || r[4] == null ? '' : Number(r[4]),
      r[5] === '' || r[5] == null ? '' : Number(r[5]),
      Number(r[6]) || 200, 'TRUE'
    ]));
    out.push('awcs: ' + awcs.length);
  }

  // Users: user_id,phone,name,cadre,role,project_code,sector_code,awc_id
  // Merged in bulk: one read, one write. Existing rows keep their auth columns.
  const usersIn = readTab('IMPORT_USERS', 8);
  if (usersIn) {
    const sh = ss.getSheetByName('Users');
    const existing = {};
    getUsersAll_().forEach(u => { existing[String(u.user_id)] = u; });

    let added = 0, updated = 0, maxSeq = Number(PROPS.getProperty('USER_SEQ') || '0');
    const errors = [];
    const newRows = [];
    for (const r of usersIn) {
      const uid = String(r[0]).trim();
      const phone = String(r[1] == null ? '' : r[1]).replace(/\D/g, '');
      const name = String(r[2]).trim();
      const cadre = String(r[3]).trim().toUpperCase();
      const role = String(r[4] || 'FIELD').trim().toUpperCase();
      if (!/^U\d{4,}$/.test(uid)) { errors.push(uid + ':BAD_ID'); continue; }
      if (phone && phone.length !== 10) { errors.push(uid + ':BAD_PHONE'); continue; }
      if (CADRES.indexOf(cadre) < 0) { errors.push(uid + ':BAD_CADRE'); continue; }
      if (ROLES.indexOf(role) < 0) { errors.push(uid + ':BAD_ROLE'); continue; }
      const fields = {
        phone: phone, name: name, cadre: cadre, role: role,
        project_code: String(r[5]).trim(), sector_code: String(r[6]).trim(),
        awc_id: String(r[7] == null ? '' : r[7]).trim()
      };
      const seqN = Number(uid.slice(1));
      if (seqN > maxSeq) maxSeq = seqN;
      const ex = existing[uid];
      if (ex) {
        const changed = Object.keys(fields).some(k => String(ex[k]) !== String(fields[k]));
        if (changed) {
          updateUser_(ex, fields);
          updated++;
        }
      } else {
        newRows.push([uid, fields.phone, fields.name, fields.cadre, fields.project_code,
          fields.sector_code, fields.awc_id, fields.role, 'ACTIVE',
          '', '', '', '0', '', '', '', nowIso_(), nowIso_()]);
        added++;
      }
    }
    if (newRows.length) {
      sh.getRange(sh.getLastRow() + 1, 1, newRows.length, USERS_H.length).setValues(newRows);
    }
    PROPS.setProperty('USER_SEQ', String(maxSeq));
    audit_('OWNER', 'USERS_IMPORT', 'Users', '', { added: added, updated: updated, errors: errors.length });
    out.push('users: ' + added + ' added, ' + updated + ' updated, errors: ' +
      (errors.length ? errors.join(', ') : 'none'));
  }

  // Schedules: project_code,cadre,in_start,in_end,late_after,out_start,out_end
  const sch = readTab('IMPORT_SCHEDULES', 7);
  if (sch) {
    const res = apiSetSchedules_({ user: { role: 'ADMIN' }, userId: 'OWNER' }, {
      rows: sch.map(r => ({ project_code: String(r[0]).trim(), cadre: String(r[1]).trim(),
        in_start: r[2], in_end: r[3], late_after: r[4], out_start: r[5], out_end: r[6] }))
    });
    out.push('schedules: ' + JSON.stringify(res));
  }

  // Holidays: date,name (Sundays are computed by rule, not listed).
  const hol = readTab('IMPORT_HOLIDAYS', 2);
  if (hol) {
    let hsh = ss.getSheetByName('Holidays');
    if (!hsh) {
      hsh = ss.insertSheet('Holidays');
      hsh.getRange(1, 1, 1, HOL_H.length).setValues([HOL_H]);
      hsh.getRange(1, 1, hsh.getMaxRows(), HOL_H.length).setNumberFormat('@');
    }
    replaceTab('Holidays', HOL_H, hol.map(r => [
      r[0] instanceof Date ? Utilities.formatDate(r[0], TZ, 'yyyy-MM-dd') : String(r[0]).trim(),
      String(r[1] || 'Holiday').trim()
    ]));
    CACHE.remove('holidays');
    out.push('holidays: ' + hol.length);
  }

  resolveSectorSupervisors_();

  const summary = out.join('\n') || 'No IMPORT_* tabs found in ATTENDANCE_MASTER.';
  console.log(summary);
  return summary;
}

// ---------------------------------------------------------------------------
// Detailed attendance register — owner-run. buildRegister() (or
// buildRegister('2026-07') for an older month) rebuilds a 'Register' tab in
// that month's ATT spreadsheet: one row per mark with every detail joined in
// (person, org unit, GPS, verification, photo link, timing, day type).
// Open the spreadsheet and File > Download > Excel for offline use.
// ---------------------------------------------------------------------------

// One row per person per day, in the district's requested format; our extra
// audit detail (OUT mark, day type, flags, AWC) is appended after markCount /
// firstMarkAt so the familiar columns line up exactly.
const REG_H = ['id', 'date', 'phone', 'name', 'role', 'mandal', 'markedAt', 'location',
  'verified', 'photo', 'timezone', 'receivedAt', 'status', 'leaveId', 'leaveType',
  'markCount', 'firstMarkAt',
  'outMarkedAt', 'outVerified', 'dayType', 'flags', 'awc', 'userId', 'lat', 'lng', 'accuracy_m'];

function buildRegister(ymOpt) {
  const ym = ymOpt || Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
  const ss = getMonthSS_(ym, true);
  if (!ss) return 'No attendance spreadsheet for ' + ym;

  const users = {};
  getUsersAll_().forEach(u => { users[String(u.user_id)] = u; });
  const sectors = {};
  getSectors_().forEach(s => { sectors[s.code] = s.name; });
  const awcNames = {};
  masterSheetRows_('AWCs', AWC_H).forEach(r => { awcNames[String(r[0])] = String(r[3]); });
  const photoUrl = id => id ? 'https://drive.google.com/file/d/' + id + '/view' : '';

  const sh = ss.getSheetByName('Marks');
  const last = sh.getLastRow();
  const days = {}; // uid_yyyymmdd -> { IN: markObj, OUT: markObj }
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, MARKS_H.length).getValues().forEach(v => {
      const o = rowToObj_(MARKS_H, v);
      const p = String(o.key).split('_');
      if (p.length !== 3) return;
      (days[p[0] + '_' + p[1]] = days[p[0] + '_' + p[1]] || {})[p[2]] = o;
    });
  }

  const rows = Object.keys(days).sort().map(dk => {
    const seg = dk.split('_');
    const uid = seg[0];
    const date = seg[1].slice(0, 4) + '-' + seg[1].slice(4, 6) + '-' + seg[1].slice(6, 8);
    const u = users[uid] || {};
    const inM = days[dk].IN, outM = days[dk].OUT;
    const first = inM || outM;               // the day's first mark drives the familiar columns
    const flags = [inM && inM.flags, outM && outM.flags].filter(Boolean).join(',');
    // Human location: the AWC the mark was verified against + how far away,
    // instead of raw coordinates (those move to the audit columns at the end).
    let location = 'GPS not available';
    if (String(first.geofence) !== 'UNVERIFIED' && first.awc_id) {
      const d = Number(first.distance_m);
      location = (awcNames[String(first.awc_id)] || String(first.awc_id)) +
        (isFinite(d) ? ' (' + (d >= 1000 ? (d / 1000).toFixed(1) + ' km' : d + ' m') + ')' : '');
    } else if (first.lat !== '' && first.lat != null) {
      location = first.lat + ', ' + first.lng;
    }
    return [
      dk, date, String(u.phone || ''), String(u.name || ''), String(u.cadre || ''),
      sectors[String(u.sector_code)] || String(u.sector_code || ''),
      String(first.client_ts), location,
      String(first.geofence) === 'INSIDE' ? 'TRUE' : 'FALSE', photoUrl(String(first.photo_id)),
      'Asia/Calcutta', String(first.server_ts), 'PRESENT', '', '',
      (inM ? 1 : 0) + (outM ? 1 : 0), inM ? String(inM.client_ts) : '',
      outM ? String(outM.client_ts) : '',
      outM ? (String(outM.geofence) === 'INSIDE' ? 'TRUE' : 'FALSE') : '',
      holidayFor_(date) || 'WORKING', flags,
      awcNames[String(u.awc_id)] || String(u.awc_id || ''), uid,
      first.lat, first.lng, first.accuracy_m
    ];
  });

  let reg = ss.getSheetByName('Register');
  if (!reg) reg = ss.insertSheet('Register');
  reg.clearContents();
  reg.getRange(1, 1, 1, REG_H.length).setNumberFormat('@');
  reg.getRange(1, 1, 1, REG_H.length).setValues([REG_H]);
  if (rows.length) {
    reg.getRange(2, 1, rows.length, REG_H.length).setNumberFormat('@');
    reg.getRange(2, 1, rows.length, REG_H.length).setValues(rows);
  }
  const msg = 'Register ' + ym + ': ' + rows.length + ' marks — ' + ss.getUrl();
  console.log(msg);
  return msg;
}

/**
 * Fills Sectors.supervisor_user_id from IMPORT_SECTORS.supervisor_phone once
 * the supervisor users exist. Safe to re-run any time.
 */
function resolveSectorSupervisors_() {
  const ss = masterSS_();
  const imp = ss.getSheetByName('IMPORT_SECTORS');
  if (!imp || imp.getLastRow() < 2) return;
  const sh = ss.getSheetByName('Sectors');
  const impRows = imp.getRange(2, 1, imp.getLastRow() - 1, 4).getValues();
  for (const r of impRows) {
    const scode = String(r[0]).trim();
    const phone = String(r[3] == null ? '' : r[3]).replace(/\D/g, '');
    if (!scode || !phone) continue;
    const sup = getUsersByPhone_(phone).find(u => String(u.role) === 'SUPERVISOR');
    if (!sup) continue;
    const row = findRowByValue_(sh, 1, scode);
    if (row) sh.getRange(row, 4).setValue(String(sup.user_id));
  }
  CACHE.remove('sectors');
}
