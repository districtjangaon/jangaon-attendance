/* Health: what is installed, read rather than assumed; the backup counted
   off the calendar; and the two actions an ADMIN may take. */
'use strict';
module.exports = {
  name: 'Health (pre-flight)',
  run(t, load) {
    const env = load({ now: '2026-10-24T09:15:00+05:30' });
    env.seed();
    env.props.LAST_GEN = '2026-10-24T09:05:00+05:30';

    t.eq(env.call('health', 'U0100').code, 'FORBIDDEN', 'a supervisor may not read the pre-flight');
    t.eq(env.call('health', 'U0200').code, 'FORBIDDEN', 'nor a CDPO');

    let h = env.call('health', 'U2000');
    t.eq(h.ok, true, 'ADMIN reads it');
    t.eq(h.triggers.ok, false, 'with no trigger installed, triggers are not ok');
    t.eq(h.triggers.missing.length, 7, 'all seven daily jobs are reported missing');
    t.eq(h.backup.ok, false, 'no backup folder: backup is not ok');
    t.contains(h.backup.why, 'folder', 'and the reason names the folder');
    t.eq(h.roll.active, 7, 'the roll counts the active accounts');
    t.eq(h.roll.field, 4, 'and the field staff among them');
    t.eq(h.calendar.holidays, 2, 'the calendar counts this year\'s holidays');
    t.eq(h.summary.ageMin, 10, 'the summary age is read off LAST_GEN');
    t.eq(h.summary.ok, true, 'and ten minutes is fine');
    t.eq(h.allWell, false, 'allWell is false while anything is missing');
    t.ok(h.concerns.indexOf('triggers') >= 0 && h.concerns.indexOf('backup') >= 0, 'the concerns name what is wrong', h.concerns.join(','));
    t.ok(h.features.live.length >= 6, 'the feature report rides along');

    // install the jobs: idempotent
    const inst = env.call('installJobs', 'U2000');
    t.eq(inst.ok, true, 'installJobs answers ok');
    env.call('installJobs', 'U2000');
    const have = env.installed.slice().sort();
    t.eq(have, ['backupNow', 'featureDaily', 'monthPrep', 'nightlyJob', 'reaperJob', 'sendDailyAttendanceEmail', 'summaryTick'], 'a second press leaves exactly one of each trigger');
    t.ok(env.col('Audit', 'action').indexOf('DAILY_JOBS_INSTALLED') >= 0, 'the installation is audited');

    // the backup folder, counted off the calendar: 14 days, two missing
    const name = env.eval('BACKUP_FOLDER_NAME');
    const root = env.driveRoot.createFolder(name);
    for (let i = 1; i <= 14; i++) {
      if (i === 3 || i === 9) continue;
      const d = new Date('2026-10-24T12:00:00+05:30'); d.setDate(d.getDate() - i);
      root.createFolder(d.toISOString().slice(0, 10) + '_2300');
    }
    root.createFolder('not-a-backup');
    h = env.call('health', 'U2000');
    t.eq(h.backup.copies, 12, 'dated sub-folders are counted; the stray one is not');
    t.eq(h.backup.missingLast14.length, 2, 'the two silent nights are named');
    t.eq(h.triggers.ok, true, 'with the jobs installed, triggers are ok');
    t.eq(h.mail.remaining, 100, 'the mail allowance is read, not guessed');
    t.eq(h.mail.looksLike, 'a consumer allowance', 'and a hundred reads as a consumer account');
  }
};
