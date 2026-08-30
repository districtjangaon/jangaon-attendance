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
  // The number lives in a Script Property, not in the source: this file is in
  // a public repo, and a real mobile number does not belong in one. Set
  // COLLECTOR_PHONE in Project Settings -> Script Properties before running.
  const phone = String(PROPS.getProperty('COLLECTOR_PHONE') || '').replace(/\D/g, '');
  if (!/^\d{10}$/.test(phone)) {
    return 'Set the COLLECTOR_PHONE script property to the 10-digit mobile ' +
      'number of the Collector, then run this again.';
  }
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

  const sh = marksSheet_(ss);
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

/**
 * Grant a named user full console access.
 *
 * Run from the editor:  grantConsoleAccess('U2023')
 *
 * Sets role ADMIN, status ACTIVE and the leave-sanction right. An ADMIN sees
 * every console tab - dashboard, analytics, flagged, daily reports, monthly,
 * leaves, leave register, verification, map, users - and every export on
 * them, because the exports are built from what the tab already holds.
 *
 * Reports what it changed rather than what it set, so running it on an
 * account that is already correct says so instead of implying work was done.
 * Every change is audit-logged with its previous value.
 */
function grantConsoleAccess(userId) {
  const uid = String(userId || '').trim();
  if (!uid) throw new Error('Pass a user id, e.g. grantConsoleAccess("U2023")');
  const u = getUserById_(uid);
  if (!u) throw new Error('No such user: ' + uid);

  const want = { role: 'ADMIN', status: 'ACTIVE', can_approve_leave: '1' };
  const changed = [];
  Object.keys(want).forEach(function (k) {
    const now = String(u[k] == null ? '' : u[k]);
    if (now === want[k]) return;
    changed.push(k + ': "' + now + '" -> "' + want[k] + '"');
  });

  Logger.log('User   ' + uid + '  ' + String(u.name) + '  (' + String(u.cadre) + ')');
  if (!changed.length) {
    Logger.log('Already has full console access. Nothing changed.');
    return { userId: uid, changed: [] };
  }

  updateUser_(u, want);
  changed.forEach(function (c) {
    audit_('MAINTENANCE', 'CONSOLE_ACCESS_GRANT', uid, c.split(' -> ')[0], c);
  });
  CACHE.remove('users');

  Logger.log('Changed: ' + changed.join(' | '));
  Logger.log('She can now open the console with her own number and PIN, see every');
  Logger.log('tab, and decide leave. If she has never signed in, the first sign-in');
  Logger.log('will ask her to set a PIN.');
  return { userId: uid, changed: changed };
}

/**
 * Committee finding 5, examined: why a Helper cannot mark on her Teacher's phone.
 *
 * Run from the editor:  deviceAudit()
 *
 * READ THE CATEGORIES CAREFULLY — MOST OF THEM ARE NOT FAULTS. The first
 * version of this function called them "causes", which was wrong and would
 * have put a misleading figure in front of the Committee: it reported that
 * 50.8% of Helpers had a "phone mismatch", when a Helper registered on her
 * own mobile number is an ordinary, correct arrangement. What these
 * categories describe is HOW PHONES ARE DISTRIBUTED across the district.
 * Only two of them are anybody's work.
 *
 *   NEEDS ACTION
 *     NEVER_SIGNED_IN    No PIN has ever been set, so the account has never
 *                        been opened. Nothing is broken; someone has to sit
 *                        with her once. This is the real backlog.
 *
 *   NEEDS A CORRECTION
 *     INACTIVE           Status is not ACTIVE, so sign-in refuses before any
 *                        device check runs. A master-data correction.
 *
 *   NOT FAULTS — configuration, reported so the numbers are understood
 *     OWN_NUMBER         Registered on her own mobile rather than the centre's.
 *                        She signs in perfectly well with her own number. The
 *                        trap is that she does NOT appear when someone types
 *                        the CENTRE number on the Teacher's handset, which
 *                        reads exactly like an account that was never
 *                        activated. Answered by the centre picker, which lists
 *                        colleagues by name instead of asking for a number.
 *     SEPARATE_HANDSET   Bound to a handset that is not her Teacher's — which
 *                        is simply what it looks like when she has a phone of
 *                        her own. It only becomes a problem the day she needs
 *                        the Teacher's phone instead, and that day she can now
 *                        ask for approval from the sign-in screen.
 *     SHARES_CENTRE_PHONE  Same number as her Teacher: the shared-phone case
 *                        the system was designed around.
 *
 * THE NUMBER THAT ACTUALLY MEASURES BLOCKAGE is the count of pending approval
 * requests, printed at the end. That is workers who tried, were refused, and
 * said so — not an inference from how the register happens to be filled in.
 *
 * Read-only. Changes nothing and is safe to run during the marking window.
 */
function deviceAudit() {
  const users = getUsersAll_();
  const field = users.filter(function (u) { return String(u.role) === 'FIELD'; });
  const byAwc = {};
  field.forEach(function (u) {
    const a = String(u.awc_id || '');
    if (a) (byAwc[a] = byAwc[a] || []).push(u);
  });

  const buckets = { NEVER_SIGNED_IN: [], INACTIVE: [], OWN_NUMBER: [],
    SEPARATE_HANDSET: [], SHARES_CENTRE_PHONE: [] };

  field.filter(function (u) { return String(u.cadre) === 'AWH'; }).forEach(function (h) {
    const mates = (byAwc[String(h.awc_id || '')] || [])
      .filter(function (u) { return String(u.cadre) === 'AWT'; });
    const teacher = mates[0] || null;
    const label = String(h.user_id) + ' ' + String(h.name) + ' @ ' + String(h.awc_id || '-') +
      (teacher ? ' (AWT ' + String(teacher.name) + ')' : ' (no AWT on record)');

    if (String(h.status) !== 'ACTIVE') { buckets.INACTIVE.push(label); return; }
    if (!h.pin_hash) { buckets.NEVER_SIGNED_IN.push(label); return; }
    if (teacher && String(teacher.phone) !== String(h.phone)) {
      buckets.OWN_NUMBER.push(label + ' — hers ' + String(h.phone) +
        ', centre ' + String(teacher.phone));
      return;
    }
    if (h.device_id && teacher && teacher.device_id &&
        String(h.device_id) !== String(teacher.device_id)) {
      buckets.SEPARATE_HANDSET.push(label);
      return;
    }
    buckets.SHARES_CENTRE_PHONE.push(label);
  });

  const total = Object.keys(buckets).reduce(function (n, k) { return n + buckets[k].length; }, 0);
  const pct = function (n) { return total ? Math.round((n / total) * 1000) / 10 : 0; };

  Logger.log('Helper (AWH) accounts examined: ' + total);
  Logger.log('');
  Logger.log('NEEDS ACTION');
  ['NEVER_SIGNED_IN', 'INACTIVE'].forEach(function (k) {
    Logger.log('  ' + k + ': ' + buckets[k].length + '  (' + pct(buckets[k].length) + '%)');
  });
  Logger.log('');
  Logger.log('NOT FAULTS — how phones are distributed');
  ['OWN_NUMBER', 'SEPARATE_HANDSET', 'SHARES_CENTRE_PHONE'].forEach(function (k) {
    Logger.log('  ' + k + ': ' + buckets[k].length + '  (' + pct(buckets[k].length) + '%)');
  });

  // Only the two actionable lists are printed. Naming 254 women under a
  // heading that is not a fault is how a working arrangement turns into a
  // list of people to chase.
  ['NEVER_SIGNED_IN', 'INACTIVE'].forEach(function (k) {
    if (!buckets[k].length) return;
    Logger.log('');
    Logger.log('--- ' + k + ' (first 40 of ' + buckets[k].length + ') ---');
    buckets[k].slice(0, 40).forEach(function (l) { Logger.log('  ' + l); });
  });

  const pending = devReqSheet_();
  let open = 0;
  if (pending.getLastRow() > 1) {
    open = pending.getRange(2, 11, pending.getLastRow() - 1, 1).getValues()
      .filter(function (r) { return String(r[0]) === 'PENDING'; }).length;
  }
  Logger.log('');
  Logger.log('ACTUALLY BLOCKED RIGHT NOW (asked and were refused): ' + open);
  Logger.log('This is the figure to quote. The rest is configuration.');

  return { total: total, counts: Object.keys(buckets).reduce(function (o, k) {
    o[k] = buckets[k].length; return o;
  }, {}), blockedNow: open };
}

/**
 * Finish a release: everything that cannot be done by deploying code.
 *
 * Run from the editor:  finishRelease()
 *
 * This exists because the alternative was a scratch file to paste in by hand,
 * and a step that lives outside the pipeline is a step that eventually does
 * not get run. It ships with the backend, so after any deploy it is simply
 * there in the function list.
 *
 * Idempotent throughout. Running it twice changes nothing the second time and
 * says so, so it is safe to run whenever you are unsure whether it was run.
 */
function finishRelease() {
  const out = [];
  const step = function (name, fn) {
    try {
      out.push('OK    ' + name + '  -> ' + (fn() || 'done'));
    } catch (e) {
      out.push('FAIL  ' + name + '  -> ' + String((e && e.message) || e));
    }
  };

  // The version floor. Stamped into the build from app/index.html, so it is
  // the app that actually shipped alongside this backend rather than a number
  // somebody remembered to retype. A handset behind it replaces itself at its
  // next config load instead of at some later sync.
  step('MIN_APP_BUILD', function () {
    const want = APP_BUILD_SHIPPED;
    const had = PROPS.getProperty('MIN_APP_BUILD') || '(unset)';
    if (had === want) return 'already ' + want;
    PROPS.setProperty('MIN_APP_BUILD', want);
    return had + ' -> ' + want;
  });

  // The 18:00 report to the Collector's office, and the nightly backup. Both
  // installers already replace their own trigger rather than adding a second.
  step('daily email trigger', function () { installDailyEmailTrigger(); return 'installed'; });
  step('backup trigger', function () { installBackupTrigger(); return 'installed'; });

  Logger.log(out.join('\n'));
  Logger.log('');
  Logger.log('Backend build ' + backendBuild_() + '  |  app floor ' + APP_BUILD_SHIPPED);
  Logger.log('');
  Logger.log('---- Committee finding 5: Helper accounts, by cause ----');
  const audit = deviceAudit();   // read-only; safe at any hour
  return { steps: out, helperAccounts: audit };
}
