/**
 * Backup.gs — dated copies of the district's data, inside Drive.
 *
 * Google keeps revision history and a trash, but neither survives the thing
 * that actually goes wrong: a bad import, a formula pasted over a column, or
 * a month's spreadsheet deleted and emptied from trash. A dated copy does.
 *
 * What is copied
 *   - the master workbook (Users, AWCs, Sectors, Leaves, Audit, ...)
 *   - every monthly attendance workbook the script knows about
 *
 * What is deliberately NOT copied
 *   - attendance photographs. Policy deletes them after PHOTO_RETENTION_DAYS;
 *     copying them into a backup folder would quietly defeat that retention
 *     rule and leave face images of staff lying about for longer than the
 *     district said they would.
 *
 * Scopes: uses Drive and Sheets, both already granted. Nothing new to consent.
 *
 * Run installBackupTrigger() once to schedule it. backupNow() runs it by hand.
 */

const BACKUP_FOLDER_NAME = 'Sisu Mahila Samridhi — Backups';
// How many dated backups to keep. Thirty daily copies covers the window in
// which a bad edit is realistically noticed, without filling the account.
const BACKUP_KEEP = 30;

/** Run once from the editor: a copy every night, after the summariser. */
function installBackupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'backupNow') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('backupNow').timeBased().atHour(23).everyDays(1).create();
  Logger.log('Backup trigger installed for 23:00-00:00 ' + TZ + '. Keeping ' +
    BACKUP_KEEP + ' dated copies.');
}

function removeBackupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'backupNow') ScriptApp.deleteTrigger(t);
  });
  Logger.log('Backup trigger removed.');
}

/** Take a dated backup now. Safe to run at any time; never deletes live data. */
function backupNow() {
  const stamp = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd_HHmm');
  const root = backupRoot_();
  const dated = root.createFolder(stamp);

  const copied = [], failed = [];

  // The master workbook first: without it the attendance rows cannot be
  // attributed to anyone.
  const masterId = PROPS.getProperty('MASTER_ID');
  if (masterId) {
    try {
      DriveApp.getFileById(masterId).makeCopy('MASTER ' + stamp, dated);
      copied.push('master');
    } catch (e) {
      failed.push('master: ' + e.message);
    }
  } else {
    failed.push('master: MASTER_ID script property is not set');
  }

  // Every monthly attendance workbook the script has ever registered.
  const props = PROPS.getProperties();
  Object.keys(props).sort().forEach(function (k) {
    if (k.indexOf('ATT_') !== 0) return;
    try {
      DriveApp.getFileById(props[k]).makeCopy(k + ' ' + stamp, dated);
      copied.push(k);
    } catch (e) {
      failed.push(k + ': ' + e.message);
    }
  });

  const pruned = pruneBackups_(root);

  Logger.log('Backup ' + stamp);
  Logger.log('  copied : ' + (copied.length ? copied.join(', ') : 'nothing'));
  if (failed.length) Logger.log('  FAILED : ' + failed.join(' | '));
  if (pruned.length) Logger.log('  pruned : ' + pruned.join(', '));
  Logger.log('  folder : ' + dated.getUrl());

  // A backup that fails silently is worse than none: make the run itself fail
  // so the trigger's failure notification reaches the owner.
  if (failed.length) {
    throw new Error('Backup incomplete — ' + failed.join(' | '));
  }
  return { folder: dated.getUrl(), copied: copied, pruned: pruned };
}

/** The one backup folder, created on first use. */
function backupRoot_() {
  const existing = DriveApp.getFoldersByName(BACKUP_FOLDER_NAME);
  if (existing.hasNext()) return existing.next();
  const f = DriveApp.createFolder(BACKUP_FOLDER_NAME);
  f.setDescription('Dated copies of the Sisu Mahila Samridhi master and monthly ' +
    'attendance workbooks. Attendance photographs are deliberately excluded so that ' +
    'the retention policy on them is not defeated.');
  return f;
}

/**
 * Keep the newest BACKUP_KEEP dated folders; trash the rest.
 * Only folders whose name looks like a stamp this script wrote are considered,
 * so anything an officer files here by hand is left alone.
 */
function pruneBackups_(root) {
  const mine = [];
  const it = root.getFolders();
  while (it.hasNext()) {
    const f = it.next();
    if (/^\d{4}-\d{2}-\d{2}_\d{4}$/.test(f.getName())) mine.push(f);
  }
  if (mine.length <= BACKUP_KEEP) return [];
  mine.sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; });  // newest first
  const drop = mine.slice(BACKUP_KEEP);
  drop.forEach(function (f) { f.setTrashed(true); });
  return drop.map(function (f) { return f.getName(); });
}

/**
 * List what is in the backup folder, newest first, with sizes.
 * Use this to confirm the schedule is actually running.
 */
function backupStatus() {
  const root = backupRoot_();
  const rows = [];
  const it = root.getFolders();
  while (it.hasNext()) {
    const f = it.next();
    if (!/^\d{4}-\d{2}-\d{2}_\d{4}$/.test(f.getName())) continue;
    let n = 0, bytes = 0;
    const fi = f.getFiles();
    while (fi.hasNext()) { const x = fi.next(); n++; bytes += x.getSize(); }
    rows.push({ name: f.getName(), files: n, mb: Math.round(bytes / 104857.6) / 10 });
  }
  rows.sort(function (a, b) { return a.name < b.name ? 1 : -1; });
  Logger.log('Backups in "' + BACKUP_FOLDER_NAME + '": ' + rows.length +
    ' (keeping ' + BACKUP_KEEP + ')');
  rows.slice(0, 10).forEach(function (r) {
    Logger.log('  ' + r.name + '  ' + r.files + ' workbooks  ' + r.mb + ' MB');
  });
  if (!rows.length) Logger.log('  none yet — run backupNow() or installBackupTrigger()');
  Logger.log('  folder: ' + root.getUrl());
  return rows;
}
