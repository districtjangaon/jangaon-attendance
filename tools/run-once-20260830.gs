/**
 * tools/run-once-20260830.gs — the manual steps that finish the 2026-08-30 release.
 *
 * NOT part of the deployed build. It lives outside backend/ on purpose: the
 * build refuses any backend/*.gs that is not in ORDER, so a scratch file kept
 * there could not stay unshipped. Paste this into the editor as a new file, run
 * finishRelease_20260830(), read the log, then delete it.
 *
 * Everything here is idempotent. Running it twice changes nothing the second
 * time and says so.
 */
function finishRelease_20260830() {
  const log = [];
  const step = function (name, fn) {
    try {
      const r = fn();
      log.push('OK    ' + name + (r ? '  -> ' + r : ''));
    } catch (e) {
      log.push('FAIL  ' + name + '  -> ' + String((e && e.message) || e));
    }
  };

  // 1. Version enforcement. A handset behind this stamp replaces itself at its
  //    next config load rather than at some later sync. Set to the build now on
  //    Pages, so today's release is the floor.
  step('MIN_APP_BUILD', function () {
    const want = '20260830-2012';
    const had = PROPS.getProperty('MIN_APP_BUILD') || '(unset)';
    if (had === want) return 'already ' + want;
    PROPS.setProperty('MIN_APP_BUILD', want);
    return had + ' -> ' + want;
  });

  // 2. The 18:00 report to the Collector's office, and the nightly backup.
  step('daily email trigger', function () { installDailyEmailTrigger(); return 'installed'; });
  step('backup trigger', function () { installBackupTrigger(); return 'installed'; });

  // 3. Console access for the Additional Collector (Revenue).
  step('console access U2023', function () {
    const r = grantConsoleAccess('U2023');
    return r.changed.length ? r.changed.join(' | ') : 'already correct';
  });

  Logger.log(log.join('\n'));
  Logger.log('');
  Logger.log('---- Committee finding 5: Helper accounts, by cause ----');

  // 4. Read-only. This is the diagnostic whose four counts the Committee is
  //    owed; it changes nothing and is safe to run at any hour.
  const audit = deviceAudit();
  return { steps: log, helperAccounts: audit };
}
