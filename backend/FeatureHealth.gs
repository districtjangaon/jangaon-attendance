/**
 * FeatureHealth.gs — is this register fit to be changed?
 *
 * The pre-flight check, asked of the register itself before a new series of
 * features goes near it. It answers the questions that have each cost a day:
 *
 *   - are the daily jobs actually installed? The summariser, the nightly
 *     register build, the photo reaper, the backup and the Collector's daily
 *     email all run from triggers, and a trigger that was never installed
 *     looks exactly like one that is working: nothing arrives, and nothing
 *     says why. (The daily email's trigger was missed exactly this way.)
 *   - is the nightly backup running? Counted off the CALENDAR, not off the
 *     folder: a job that has been failing for three weeks looks exactly like
 *     one that is working if you only read the newest copy;
 *   - how much mail is left today? One allowance is shared by every message
 *     the script sends, and on a consumer account it is a hundred;
 *   - and what the register holds: the roll, the holiday calendar, how fresh
 *     the published summary is, and the feature modules it is carrying.
 *
 * READ-ONLY, except for two actions the district admin may take from the
 * console: installing the daily jobs, and running the backup now. Both call
 * the same functions the editor would, and both are idempotent.
 */
function feature_health() {
  return {
    title: 'Pre-flight: triggers, backup, mail allowance and what is loaded',

    actions: {
      // action: "health" (ADMIN)
      health: function (auth, req) {
        if (String(auth.user.role) !== 'ADMIN') return deny_();
        const today = fmtDay_(Date.now());
        const out = { ok: true, at: nowIso_(), today: today, build: backendBuild_() };

        out.triggers = healthTriggers_();

        // ---- the mail allowance ----
        out.mail = (function () {
          try {
            const left = MailApp.getRemainingDailyQuota();
            return { remaining: left,
              // a consumer account is 100 a day, Workspace 1,500: the figure
              // itself tells which, without guessing
              looksLike: left > 200 ? 'a Workspace allowance' : 'a consumer allowance',
              ok: left > 0 };
          } catch (err) { return { error: String(err), ok: false }; }
        })();

        out.backup = healthBackup_(today);

        // ---- the roll ----
        out.roll = (function () {
          try {
            let active = 0, field = 0, noPin = 0, console = 0;
            getUsersAll_().forEach(function (u) {
              if (String(u.status) !== 'ACTIVE') return;
              active++;
              if (String(u.role) === 'FIELD') field++; else console++;
              if (!u.pin_hash) noPin++;
            });
            return { active: active, field: field, console: console, withoutPin: noPin, ok: active > 0 };
          } catch (err) { return { error: String(err), ok: false }; }
        })();

        // ---- the calendar ----
        out.calendar = (function () {
          try {
            const y = today.slice(0, 4);
            const all = getHolidays_();
            const n = Object.keys(all).filter(function (k) { return k.slice(0, 4) === y; }).length;
            const next = Object.keys(all).filter(function (k) { return k.slice(0, 4) === String(Number(y) + 1); }).length;
            return { year: Number(y), holidays: n, nextYear: next, today: holidayFor_(today) || '', ok: n > 0 };
          } catch (err) { return { error: String(err), ok: false }; }
        })();

        // ---- the published summary ----
        out.summary = (function () {
          try {
            const gen = PROPS.getProperty('LAST_GEN') || '';
            const ageMin = gen ? Math.round((Date.now() - new Date(gen).getTime()) / 60000) : null;
            // Idle afternoons are normal; a day without a publish is not.
            return { generatedAt: gen, ageMin: ageMin, ok: ageMin !== null && ageMin < 24 * 60 };
          } catch (err) { return { error: String(err), ok: false }; }
        })();

        out.features = featureReport_();

        // one word for the whole thing, so the console can show a light
        const parts = ['triggers', 'mail', 'backup', 'roll', 'calendar', 'summary'];
        out.allWell = parts.every(function (k) { return out[k] && out[k].ok === true; });
        out.concerns = parts.filter(function (k) { return !(out[k] && out[k].ok === true); });
        return out;
      },

      // action: "installJobs" (ADMIN). Every installer deletes its own trigger
      // before creating it (installTriggers_ clears the lot first), so a
      // nervous second press changes nothing.
      installJobs: function (auth, req) {
        if (String(auth.user.role) !== 'ADMIN') return deny_();
        try {
          installTriggers_();          // summaryTick, nightlyJob, reaperJob, monthPrep
          installBackupTrigger();      // backupNow, 23:00
          installDailyEmailTrigger();  // sendDailyAttendanceEmail, 17:00
          installFeatureTrigger();     // featureDaily, 07:00
          const have = [];
          ScriptApp.getProjectTriggers().forEach(function (t) { have.push(t.getHandlerFunction()); });
          have.sort();
          audit_(String(auth.user.user_id), 'DAILY_JOBS_INSTALLED', 'triggers', '', have.join(', '));
          return { ok: true, installed: have, triggers: healthTriggers_() };
        } catch (err) {
          return { ok: false, code: 'INSTALL_FAILED', msg: String((err && err.message) || err) };
        }
      },

      // action: "runBackup" (ADMIN). Installing the trigger and knowing the
      // backup WORKS are two different things; only running it tells a
      // missing trigger from a job that throws every night. The folder is
      // read before and after, so the answer is evidence and not a tick.
      runBackup: function (auth, req) {
        if (String(auth.user.role) !== 'ADMIN') return deny_();
        const today = fmtDay_(Date.now());
        const before = healthBackup_(today);
        let threw = '';
        const t0 = Date.now();
        try { backupNow(); } catch (err) { threw = String((err && err.message) || err); }
        const after = healthBackup_(today);
        const made = (after.copies || 0) - (before.copies || 0);
        audit_(String(auth.user.user_id), 'BACKUP_RUN_BY_HAND', 'backup', '',
          (threw ? 'FAILED: ' + threw : 'completed') + ' - ' + made + ' dated copy(ies) made');
        return { ok: !threw, code: threw ? 'BACKUP_FAILED' : undefined, msg: threw || '',
          seconds: Math.round((Date.now() - t0) / 1000), made: made, before: before, after: after };
      }
    }
  };
}

/** The daily jobs wanted, against the triggers actually installed. */
function healthTriggers_() {
  try {
    const want = {
      summaryTick: 'the summary publisher, every 5 min',
      nightlyJob: 'the nightly summary and register build, 22:00',
      reaperJob: 'the photo retention reaper, 02:00',
      monthPrep: 'the next month workbook, 03:00',
      backupNow: 'the nightly backup, 23:00',
      sendDailyAttendanceEmail: 'the Collector daily email, 17:00',
      featureDaily: 'the feature modules daily round, 07:00'
    };
    const have = {};
    ScriptApp.getProjectTriggers().forEach(function (t) { have[t.getHandlerFunction()] = true; });
    const missing = Object.keys(want).filter(function (k) { return !have[k]; });
    return { wanted: want, installed: Object.keys(have).sort(), missing: missing, ok: missing.length === 0 };
  } catch (err) { return { error: String(err), ok: false }; }
}

/**
 * What the backup folder holds, counted off the calendar. The folder holds
 * one dated sub-folder per run (yyyy-MM-dd_HHmm); a day with no folder in the
 * last fourteen is a night the backup did not happen.
 */
function healthBackup_(today) {
  try {
    const it = DriveApp.getFoldersByName(BACKUP_FOLDER_NAME);
    if (!it.hasNext()) return { ok: false, why: 'no "' + BACKUP_FOLDER_NAME + '" folder yet', copies: 0, missingLast14: [] };
    const root = it.next();
    const days = {};
    let newest = '', n = 0;
    const sub = root.getFolders();
    while (sub.hasNext()) {
      const f = sub.next();
      const m = f.getName().match(/^(\d{4}-\d{2}-\d{2})_\d{4}$/);
      if (!m) continue;
      n++;
      days[m[1]] = true;
      if (m[1] > newest) newest = m[1];
    }
    const missing = [];
    for (let i = 1; i <= 14; i++) {
      const d = new Date(today + 'T12:00:00+05:30');
      d.setDate(d.getDate() - i);
      const key = Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
      if (!days[key]) missing.push(key);
    }
    return { copies: n, newest: newest, missingLast14: missing, keep: BACKUP_KEEP,
      ok: missing.length === 0 && !!newest };
  } catch (err) { return { error: String(err), copies: 0, missingLast14: [], ok: false }; }
}
