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
    ['Schedules', SCH_H], ['Holidays', HOL_H], ['Leaves', LEAVE_H],
    ['Sessions', SESS_H], ['Audit', AUD_H]
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

/**
 * One-click TEST FIXTURES (run from the editor; idempotent):
 * a TRAINING centre A9990 (no coordinates -> marks classify UNVERIFIED,
 * never falsely OUTSIDE) plus its AWT+AWH pair BOTH on phone 9999999901 —
 * the shared-centre-phone case (~190 real AWCs), so the who-am-I picker,
 * switch-user, the AWT-only daily report and the AWH exemption are all
 * testable end to end. When testing ends, set both users INACTIVE from the
 * console (they count in district expected totals while ACTIVE).
 */
function seedTestUsers() {
  const sh = masterSS_().getSheetByName('AWCs');
  if (!findRowByValue_(sh, 1, 'A9990')) {
    sh.appendRow(['A9990', 'S01', 'JGN', 'TEST CENTRE (TRAINING)', '', '', 200, 'TRUE']);
    CACHE.remove('awc_A9990');
    CACHE.remove('sawcs_S01');
  }
  const mk = (id, name, cadre) => upsertUser_({
    user_id: id, allowCreateWithId: true, phone: '9999999901', name: name,
    cadre: cadre, role: 'FIELD', project_code: 'JGN', sector_code: 'S01', awc_id: 'A9990'
  }, 'SEED_TEST');
  const awt = mk('U9901', 'Test Teacher (AWT)', 'AWT');
  const awh = mk('U9902', 'Test Helper (AWH)', 'AWH');
  return 'Seeded: A9990 + ' + JSON.stringify(awt) + ' + ' + JSON.stringify(awh) +
    ' — login with phone 9999999901, pick your name, set a PIN.';
}

/**
 * One-click Collector account (run from the editor; idempotent).
 * The Collector & District Magistrate gets full ADMIN — console
 * administration, complete monitoring, and the app's District Dashboard.
 * ADMIN is this system's highest role: district-wide scope, no device
 * binding restrictions, all admin actions. If the phone already exists
 * (e.g. an old register row), that user is upgraded in place.
 */
function seedCollector() {
  const phone = '9063753622';
  const existing = getUsersByPhone_(phone);
  const res = upsertUser_({
    user_id: existing.length ? String(existing[0].user_id) : 'U2002',
    allowCreateWithId: true,
    phone: phone,
    name: 'Collector & District Magistrate',
    cadre: 'OTHER', role: 'ADMIN', status: 'ACTIVE'
  }, 'SEED_COLLECTOR');
  return JSON.stringify(res) +
    ' — Collector logs in on app and console with ' + phone + ' and sets a PIN on first login.';
}


/**
 * One-click SUPERVISOR onboarding (run from the editor; idempotent) — from
 * input/Supervisors-Input.xlsx of 2026-08-18: 20 supervisors covering all 27
 * sectors (five hold dual/triple charge -> comma-separated sector lists).
 * Creates/updates the accounts, links each sector's supervisor_user_id, and
 * from the next summary tick supervisors count in the expected numbers.
 */
function importSupervisors() {
  const DATA = [ // [phone, name, project, 'S..' or 'S..,S..']
    ['9381632415', 'Lingala Kavitha', 'JGN', 'S01,S05'],
    ['6302309983', 'Gudelly SunithaDevi', 'JGN', 'S02'],
    ['8688047527', 'Bolgam Poornima', 'JGN', 'S03'],
    ['7032012574', 'Paladgu Hamsamma', 'JGN', 'S04'],
    ['8106140401', 'Ette Shruthi', 'JGN', 'S06'],
    ['8106178736', 'Arepula Vani', 'JGN', 'S07'],
    ['6303433932', 'Madavath Swathi', 'JGN', 'S08'],
    ['9848314028', 'Bhanothu Rangamma', 'JGN', 'S09'],
    ['8074714215', 'Pasupuleti Vasantha', 'JGN', 'S10'],
    ['9505677525', 'Muttadi Sridevi', 'KDK', 'S11'],
    ['7981119614', 'Biragani Savitri', 'KDK', 'S12'],
    ['6304605486', 'Botla Mallishwari', 'KDK', 'S13'],
    ['9912234090', 'Peram Sarala', 'KDK', 'S14'],
    ['9398851583', 'Bukka Sarika', 'KDK', 'S15'],
    ['9701662600', 'Tahera Begum', 'KDK', 'S16'],
    ['9676844334', 'Bhookya Saraswathi', 'KDK', 'S17'],
    ['9492245284', 'Vajja Dulamma', 'SGN', 'S18,S22,S25'],
    ['9381446171', 'Mohammed Naseemunisa', 'SGN', 'S19,S20'],
    ['9959279669', 'Singapuram Anitha', 'SGN', 'S21,S26,S27'],
    ['9848750472', 'Dodda Manjulatha', 'SGN', 'S23,S24'],
  ];
  const secSh = masterSS_().getSheetByName('Sectors');
  const results = [];
  DATA.forEach(function (d) {
    const existing = getUsersByPhone_(d[0]);
    const res = upsertUser_({
      user_id: existing.length ? String(existing[0].user_id) : '',
      phone: d[0], name: d[1], cadre: 'SUPERVISOR', role: 'SUPERVISOR',
      project_code: d[2], sector_code: d[3], status: 'ACTIVE'
    }, 'IMPORT_SUPERVISORS');
    if (res.error) { results.push(d[3] + ':' + res.error); return; }
    d[3].split(',').forEach(function (sc) {
      const row = findRowByValue_(secSh, 1, sc.trim());
      if (row) secSh.getRange(row, 4).setValue(String(res.userId));
    });
    results.push(d[3] + ':' + res.userId);
  });
  CACHE.remove('sectors');
  return results.join(' | ');
}

/**
 * One-click E2E AUTOMATION PAIR (run from the editor; idempotent):
 * U9903/U9904 on phone 9999999902 at the TRAINING centre A9990. Each run
 * RESETS their PINs and device binding, so the automated browser test can
 * always complete a fresh first-login. Keep INACTIVE outside test windows
 * if their rows in the dashboards bother anyone.
 */
function seedE2ePair() {
  const sh = masterSS_().getSheetByName('AWCs');
  if (!findRowByValue_(sh, 1, 'A9990')) {
    sh.appendRow(['A9990', 'S01', 'JGN', 'TEST CENTRE (TRAINING)', '', '', 200, 'TRUE']);
    CACHE.remove('awc_A9990');
    CACHE.remove('sawcs_S01');
  }
  const mk = (id, name, cadre) => upsertUser_({
    user_id: id, allowCreateWithId: true, phone: '9999999902', name: name,
    cadre: cadre, role: 'FIELD', project_code: 'JGN', sector_code: 'S01', awc_id: 'A9990'
  }, 'SEED_E2E');
  mk('U9903', 'E2E Teacher (AWT)', 'AWT');
  mk('U9904', 'E2E Helper (AWH)', 'AWH');
  // Automation supervisor (sector S01, covers the training centre) — for
  // browser E2E of the My Sector view and the issue register.
  upsertUser_({
    user_id: 'U9905', allowCreateWithId: true, phone: '9999999903',
    name: 'E2E Supervisor', cadre: 'SUPERVISOR', role: 'SUPERVISOR',
    project_code: 'JGN', sector_code: 'S01'
  }, 'SEED_E2E');
  ['U9903', 'U9904', 'U9905'].forEach(function (id) {
    const u = getUserById_(id);
    if (u) updateUser_(u, { pin_hash: '', pin_salt: '', device_id: '', failed_attempts: '0', locked_until: '' });
  });
  return 'E2E pair (9999999902) + E2E Supervisor (9999999903) ready — PINs reset.';
}

/**
 * One-click SUPERVISOR persona for the district admin (run from the editor;
 * idempotent). Reuses the ADMIN_PHONE from Script Properties — after this,
 * logging in with that number shows a picker: the ADMIN account or this
 * "(Supervisor view)" account, which carries charge of ALL sectors so the
 * admin can experience the supervisor app exactly as the field sees it.
 * NOTE: supervisors count in expected attendance — this persona adds +1
 * expected (under its primary sector) while ACTIVE; set INACTIVE when not
 * needed if the dashboards should stay exact.
 */
function seedMySupervisor() {
  const phone = String(PROPS.getProperty('ADMIN_PHONE')).replace(/\D/g, '');
  if (!/^\d{10}$/.test(phone)) throw new Error('ADMIN_PHONE Script Property is not a 10-digit number.');
  const allSecs = getSectors_().map(function (s) { return s.code; }).sort().join(',');
  const existing = getUsersByPhone_(phone).filter(function (u) { return String(u.role) === 'SUPERVISOR'; });
  const res = upsertUser_({
    user_id: existing.length ? String(existing[0].user_id) : 'U2099',
    allowCreateWithId: true, phone: phone,
    name: 'Test Sup',
    cadre: 'SUPERVISOR', role: 'SUPERVISOR',
    project_code: 'JGN', sector_code: allSecs, status: 'ACTIVE'
  }, 'SEED_MY_SUP');
  return JSON.stringify(res) + ' — login with ' + phone +
    ', tap the "(Supervisor view)" name, set a PIN. Charge: ALL sectors (' + allSecs + ').';
}

/**
 * Removes the 'Test Sup' persona from the admin phone: every ACTIVE
 * SUPERVISOR account on ADMIN_PHONE goes INACTIVE (audit-logged), so that
 * number logs straight in as Admin with no account chooser. Editor-run.
 * Run seedMySupervisor again later if the persona is ever needed back.
 */
function removeTestSup() {
  const phone = String(PROPS.getProperty('ADMIN_PHONE')).replace(/\D/g, '');
  if (!/^\d{10}$/.test(phone)) throw new Error('ADMIN_PHONE Script Property is not a 10-digit number.');
  const sups = getUsersByPhone_(phone).filter(function (u) {
    return String(u.role) === 'SUPERVISOR' && String(u.status) === 'ACTIVE';
  });
  if (!sups.length) return 'Nothing to remove — no active SUPERVISOR account on ' + phone + '.';
  const done = sups.map(function (u) {
    const res = upsertUser_({
      user_id: String(u.user_id), phone: phone,
      name: String(u.name), cadre: String(u.cadre), role: 'SUPERVISOR',
      project_code: String(u.project_code), sector_code: String(u.sector_code),
      status: 'INACTIVE'
    }, 'REMOVE_TEST_SUP');
    if (res.error) throw new Error(String(u.user_id) + ': ' + res.error);
    return String(u.user_id);
  });
  return 'Deactivated ' + done.join(', ') + ' — ' + phone +
    ' now logs in as Admin only. Run seedMySupervisor to bring the persona back.';
}

/**
 * Official Telangana General Holidays 2026 — G.O.Rt.No.1715, General
 * Administration (SPL.E) Dept, dt. 06.12.2025, Annexure-I (27 days).
 * Replaces every 2026 row in the Holidays tab; other years untouched.
 * Sundays are automatic in code. Annexure-II Optional Holidays are an
 * individual's choice (max 5/year) — they go through the leave module,
 * never into this tab. Editor-run once; live immediately (cache cleared).
 */
function importHolidays2026() {
  const H = [
    ['2026-01-14', 'Bhogi'],
    ['2026-01-15', 'Sankranti / Pongal'],
    ['2026-01-26', 'Republic Day'],
    ['2026-02-15', 'Maha Shivaratri'],
    ['2026-03-03', 'Holi'],
    ['2026-03-19', 'Ugadi'],
    ['2026-03-21', 'Eidul Fitr (Ramzan)'],
    ['2026-03-22', 'Following day of Ramzan'],
    ['2026-03-27', 'Sri Rama Navami'],
    ['2026-04-03', 'Good Friday'],
    ['2026-04-05', "Babu Jagjivan Ram's Birthday"],
    ['2026-04-14', "Dr. B.R. Ambedkar's Birthday"],
    ['2026-05-27', 'Eidul Azha (Bakrid)'],
    ['2026-06-26', 'Shahadat Imam Hussain (10th Moharam)'],
    ['2026-08-10', 'Bonalu'],
    ['2026-08-15', 'Independence Day'],
    ['2026-08-26', 'Eid Miladun Nabi'],
    ['2026-09-04', 'Sri Krishna Astami'],
    ['2026-09-14', 'Vinayaka Chavithi'],
    ['2026-10-02', 'Mahatma Gandhi Jayanthi'],
    ['2026-10-18', 'Saddula Bathukamma'],
    ['2026-10-20', 'Vijaya Dasami / Dussehra'],
    ['2026-10-21', 'Following day of Vijaya Dasami'],
    ['2026-11-08', 'Deepavali'],
    ['2026-11-24', "Kartika Purnima / Guru Nanak's Jayanthi"],
    ['2026-12-25', 'Christmas'],
    ['2026-12-26', 'Following day of Christmas (Boxing Day)']
  ];
  const sh = masterSS_().getSheetByName('Holidays');
  const last = sh.getLastRow();
  const keep = [];
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, HOL_H.length).getValues().forEach(function (r) {
      const d = r[0] instanceof Date ? Utilities.formatDate(r[0], TZ, 'yyyy-MM-dd') : String(r[0]).trim();
      if (d && d.slice(0, 4) !== '2026') keep.push([d, String(r[1] || 'Holiday')]);
    });
    sh.getRange(2, 1, last - 1, HOL_H.length).clearContent();
  }
  sh.getRange(1, 1, sh.getMaxRows(), HOL_H.length).setNumberFormat('@');
  const rows = keep.concat(H);
  sh.getRange(2, 1, rows.length, HOL_H.length).setValues(rows);
  CACHE.remove('holidays');
  audit_('SYSTEM', 'HOLIDAYS_IMPORT_2026', 'GO.Rt.1715', '', { general: H.length, kept: keep.length });
  return 'Holidays tab: ' + H.length + ' official 2026 general holidays (G.O.Rt.No.1715)' +
    (keep.length ? ' + ' + keep.length + ' rows kept from other years' : '') +
    '. Attendance on these days is voluntary — no LATE, nobody counted absent.';
}

function installTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('summaryTick').timeBased().everyMinutes(5).create();
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
  const awcGeo = []; // gazetteer: nearest-centre naming for unverified marks
  masterSheetRows_('AWCs', AWC_H).forEach(r => {
    const a = awcFromRow_(r);
    awcNames[a.awc_id] = a.name;
    if (a.active && a.lat != null && a.lng != null) awcGeo.push(a);
  });
  const photoUrl = id => id ? 'https://drive.google.com/file/d/' + id + '/view' : '';
  const fmtM = d => d >= 1000 ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m';
  const nearestAwc = (lat, lng) => {
    let best = null, bestD = Infinity;
    for (const a of awcGeo) {
      const d = distM_(lat, lng, a.lat, a.lng);
      if (d < bestD) { bestD = d; best = a; }
    }
    return best ? { name: best.name, d: bestD } : null;
  };

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

  // Approved leaves for the month: fill leaveId/leaveType on marked days and
  // emit ON_LEAVE rows for unmarked working leave days.
  const dim = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
  const monthEnd = ym + '-' + pad_(dim, 2);
  const leaveDay = {}; // 'uid_yyyymmdd' -> leave row
  leavesOverlapping_(ym + '-01', monthEnd).forEach(l => {
    const from = String(l.from_date) > ym + '-01' ? String(l.from_date) : ym + '-01';
    const to = String(l.to_date) < monthEnd ? String(l.to_date) : monthEnd;
    for (let d = Number(from.slice(8)); d <= Number(to.slice(8)); d++) {
      leaveDay[String(l.user_id) + '_' + ym.replace('-', '') + pad_(d, 2)] = l;
    }
  });

  const rows = Object.keys(days).sort().map(dk => {
    const seg = dk.split('_');
    const uid = seg[0];
    const date = seg[1].slice(0, 4) + '-' + seg[1].slice(4, 6) + '-' + seg[1].slice(6, 8);
    const u = users[uid] || {};
    const lv = leaveDay[dk];
    const inM = days[dk].IN, outM = days[dk].OUT;
    const first = inM || outM;               // the day's first mark drives the familiar columns
    const flags = [inM && inM.flags, outM && outM.flags].filter(Boolean).join(',');
    // Human location, never raw coordinates: the AWC the mark verified
    // against, else the nearest known centre ("Near X"). Raw coordinates
    // live only in the audit columns at the end.
    let location = 'GPS not available';
    if (String(first.geofence) !== 'UNVERIFIED' && first.awc_id && awcNames[String(first.awc_id)]) {
      const d = Number(first.distance_m);
      location = awcNames[String(first.awc_id)] + (isFinite(d) ? ' (' + fmtM(d) + ')' : '');
    } else if (first.lat !== '' && first.lat != null) {
      const nr = nearestAwc(Number(first.lat), Number(first.lng));
      location = nr ? 'Near ' + nr.name + ' (' + fmtM(nr.d) + ')' : first.lat + ', ' + first.lng;
    }
    return [
      dk, date, String(u.phone || ''), String(u.name || ''), String(u.cadre || ''),
      sectors[String(u.sector_code)] || String(u.sector_code || ''),
      String(first.client_ts), location,
      String(first.geofence) === 'INSIDE' ? 'TRUE' : 'FALSE', photoUrl(String(first.photo_id)),
      'Asia/Calcutta', String(first.server_ts), 'PRESENT',
      lv ? String(lv.leave_id) : '', lv ? String(lv.type) : '',
      (inM ? 1 : 0) + (outM ? 1 : 0), inM ? String(inM.client_ts) : '',
      outM ? String(outM.client_ts) : '',
      outM ? (String(outM.geofence) === 'INSIDE' ? 'TRUE' : 'FALSE') : '',
      holidayFor_(date) || 'WORKING', flags,
      awcNames[String(u.awc_id)] || String(u.awc_id || ''), uid,
      first.lat, first.lng, first.accuracy_m
    ];
  });

  // ON_LEAVE rows for approved leave days without any mark (working days only).
  Object.keys(leaveDay).sort().forEach(dk => {
    if (days[dk]) return;
    const seg = dk.split('_');
    const uid = seg[0];
    const date = seg[1].slice(0, 4) + '-' + seg[1].slice(4, 6) + '-' + seg[1].slice(6, 8);
    if (holidayFor_(date)) return;
    const u = users[uid] || {};
    const lv = leaveDay[dk];
    rows.push([
      dk, date, String(u.phone || ''), String(u.name || ''), String(u.cadre || ''),
      sectors[String(u.sector_code)] || String(u.sector_code || ''),
      '', '', '', '', 'Asia/Calcutta', '', 'ON_LEAVE',
      String(lv.leave_id), String(lv.type), 0, '',
      '', '', 'WORKING', '',
      awcNames[String(u.awc_id)] || String(u.awc_id || ''), uid, '', '', ''
    ]);
  });
  rows.sort((a, b) => a[0] < b[0] ? -1 : 1);

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
