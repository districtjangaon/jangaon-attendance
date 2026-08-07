/**
 * Maintenance.gs — one-time setup, triggers, photo reaper, month pre-creation,
 * and the owner-run bulk import of the AWC master data.
 *
 * FIRST RUN: edit BOOTSTRAP_ADMIN below, then run setupAll() from the editor.
 * IMPORT: paste the five tools/import-awc.py output CSVs into tabs named
 * IMPORT_PROJECTS / IMPORT_SECTORS / IMPORT_AWCS / IMPORT_USERS /
 * IMPORT_SCHEDULES in ATTENDANCE_MASTER (header rows included), run
 * importFromSheets(), then publishOrg().
 */

// EDIT BEFORE RUNNING setupAll — this becomes the first ADMIN login.
const BOOTSTRAP_ADMIN = {
  phone: '9999999999',
  name: 'District Admin'
};

function setupAll() {
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
    ['Schedules', SCH_H], ['Sessions', SESS_H], ['Audit', AUD_H]
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
  if (getUsersByPhone_(BOOTSTRAP_ADMIN.phone).length) return;
  upsertUser_({
    phone: BOOTSTRAP_ADMIN.phone, name: BOOTSTRAP_ADMIN.name,
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

  resolveSectorSupervisors_();

  const summary = out.join('\n') || 'No IMPORT_* tabs found in ATTENDANCE_MASTER.';
  console.log(summary);
  return summary;
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
