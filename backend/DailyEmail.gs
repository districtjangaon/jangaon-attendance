/**
 * DailyEmail.gs — the 18:00 attendance report to the District Collector.
 *
 * One message a day carrying the district position, a sector analysis, the
 * names of everyone who did not mark, and a spreadsheet with one row per
 * person showing arrival, departure, whether each was inside the centre
 * boundary, whether the daily beneficiary report was filed, and leave.
 *
 * Scheduling: the trigger is set for 17:00, not 18:00. Apps Script fires an
 * hourly trigger at some point inside the hour it is given, so 17:00 lands the
 * message between 17:00 and 18:00 and meets the "by 6 pm" requirement. A
 * trigger set at 18:00 could arrive at 18:59.
 *
 * Run installDailyEmailTrigger() once from the editor to start it, and
 * sendDailyAttendanceEmailTest('you@example.com') to see one first.
 */

// The official address of the District Collector, Jangaon. Chosen by the
// district because the report has to reach recipients outside the department
// without being blocked.
const DAILY_EMAIL_TO = 'jangaoncdm@gmail.com';
// Where test sends go. Blank means "the same inbox as the live report", which
// is safe here because the Apps Script project is owned by that same account -
// a test is the Collector's office mailing itself. Put a different address here
// to send tests somewhere else. Not derived from the signed-in account: reading
// that needs an extra OAuth scope, and one fewer permission on a project
// holding staff photographs is worth more than the convenience.
const DAILY_EMAIL_TEST_TO = '';
const DAILY_EMAIL_SUBJECT_PREFIX = 'Jangaon attendance';
// Gmail hides anything past ~102 KB behind a "message clipped" link, and the
// never-marked list sits at the end. Names are dropped from the body beyond
// this count; the spreadsheet always carries everyone.
const DAILY_EMAIL_MAX_NAMES = 700;

/** Run once from the editor. Replaces any existing trigger for this function. */
function installDailyEmailTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendDailyAttendanceEmail') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendDailyAttendanceEmail').timeBased().atHour(17).everyDays(1).create();
  Logger.log('Daily attendance email trigger installed for 17:00-18:00 ' + TZ +
    ', sending to ' + DAILY_EMAIL_TO);
}

function removeDailyEmailTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendDailyAttendanceEmail') ScriptApp.deleteTrigger(t);
  });
  Logger.log('Daily attendance email trigger removed.');
}

/** Trigger target. */
function sendDailyAttendanceEmail() {
  dailyAttendanceEmail_(fmtDay_(Date.now()), DAILY_EMAIL_TO, false);
}

/** Send today's report to one address without touching the live recipient. */
function sendDailyAttendanceEmailTest(to) {
  dailyAttendanceEmail_(fmtDay_(Date.now()), testRecipient_(to), true);
}

/** Send a named past day, for checking against a day that has real traffic. */
function sendDailyAttendanceEmailFor(dateStr, to) {
  dailyAttendanceEmail_(dateStr, testRecipient_(to), true);
}

/**
 * The address a test send goes to: an explicit argument, then the constant
 * above, then the live recipient. The last fallback is deliberate - the
 * project is owned by that same account, so there is no third party a test
 * could surprise, and the subject and a banner both say TEST.
 */
function testRecipient_(to) {
  return String(to || DAILY_EMAIL_TEST_TO || DAILY_EMAIL_TO).trim();
}

/**
 * Build today's report and put it in Drive instead of mailing it.
 *
 * Uses only Drive and Sheets, both of which this project is already
 * authorised for, so it runs without the mail permission. Use it to check the
 * figures and the spreadsheet while the send permission is being granted.
 * Logs the two links.
 */
function previewDailyAttendanceToDrive() {
  previewDailyAttendanceFor_(fmtDay_(Date.now()));
}

/** The same preview for a named past day, e.g. '2026-08-27'. */
function previewDailyAttendanceForDay(dateStr) {
  previewDailyAttendanceFor_(dateStr || fmtDay_(Date.now()));
}

function previewDailyAttendanceFor_(dateStr) {
  const d = dailyAttendanceData_(dateStr);
  const folder = DriveApp.getRootFolder();

  const html = dailyAttendanceHtml_(dateStr, d, holidayFor_(dateStr), true);
  const htmlFile = folder.createFile(
    Utilities.newBlob(html, 'text/html', 'Jangaon-attendance-' + dateStr + '.html'));
  const xlsxFile = folder.createFile(dailyAttendanceXlsx_(dateStr, d));

  Logger.log('Report for ' + dateStr);
  Logger.log('  ' + d.totals.markedIn + ' of ' + d.totals.roll + ' marked IN, ' +
    d.totals.markedOut + ' marked OUT, ' + d.totals.onLeave + ' on leave, ' +
    d.totals.notMarked + ' not marked, ' + d.totals.never + ' never marked');
  Logger.log('  email body : ' + htmlFile.getUrl());
  Logger.log('  spreadsheet: ' + xlsxFile.getUrl());
  return { html: htmlFile.getUrl(), xlsx: xlsxFile.getUrl() };
}

// ---------------------------------------------------------------- the work
function dailyAttendanceEmail_(dateStr, to, isTest) {
  const holiday = holidayFor_(dateStr);
  if (holiday && !isTest) {
    Logger.log('Not sending: ' + dateStr + ' is ' + holiday + '.');
    return;
  }

  const d = dailyAttendanceData_(dateStr);
  const subject = DAILY_EMAIL_SUBJECT_PREFIX + ' ' + prettyDay_(dateStr) + ' — ' +
    d.totals.markedIn + ' of ' + d.totals.roll + ' marked (' +
    pct_(d.totals.markedIn, d.totals.roll) + ')' + (isTest ? '  [TEST]' : '');

  MailApp.sendEmail({
    to: to,
    subject: subject,
    htmlBody: dailyAttendanceHtml_(dateStr, d, holiday, isTest),
    attachments: [dailyAttendanceXlsx_(dateStr, d)],
    name: 'Sisu Mahila Samridhi — Jangaon District'
  });
  Logger.log('Sent ' + subject + ' to ' + to);
}

/**
 * Everything the message needs, in one pass over each sheet.
 * Read once, index in memory: the monthly Marks sheet is the largest read of
 * the day and must not be touched per user.
 */
function dailyAttendanceData_(dateStr) {
  const compact = dateStr.replace(/-/g, '');
  const ym = dateStr.slice(0, 7);

  const users = getUsersAll_().filter(function (u) {
    return String(u.status) === 'ACTIVE' &&
      ['FIELD', 'SUPERVISOR'].indexOf(String(u.role)) >= 0;
  });

  const sectors = {}, awcs = {};
  getSectors_().forEach(function (s) { sectors[String(s.code)] = String(s.name); });
  masterSheetRows_('AWCs', AWC_H).forEach(function (r) {
    const a = awcFromRow_(r);
    awcs[String(a.awc_id)] = String(a.name);
  });

  // ---- marks for the day, and whether the person has ever marked ----
  const today = {};          // uid -> { IN: {...}, OUT: {...} }
  const everMarked = {};     // uid -> true
  const reportedBy = {};     // uid -> filed the daily beneficiary return
  const ss = getMonthSS_(ym, false);
  if (ss) {
    const sh = marksSheet_(ss);
    const last = sh.getLastRow();
    if (last >= 2) {
      sh.getRange(2, 1, last - 1, MARKS_H.length).getValues().forEach(function (v) {
        const o = rowToObj_(MARKS_H, v);
        const p = String(o.key).split('_');
        if (p.length !== 3) return;
        everMarked[String(o.user_id)] = true;
        if (p[1] !== compact) return;
        (today[String(o.user_id)] = today[String(o.user_id)] || {})[p[2]] = {
          time: String(o.client_ts).slice(11, 16),
          geofence: String(o.geofence),
          dist: o.distance_m === '' ? null : Number(o.distance_m),
          flags: String(o.flags || '')
        };
      });
    }
    // The daily beneficiary return.
    const rs = ss.getSheetByName('Reports');
    if (rs) {
      const rl = rs.getLastRow();
      if (rl >= 2) {
        rs.getRange(2, 1, rl - 1, RPT_H.length).getValues().forEach(function (v) {
          const o = rowToObj_(RPT_H, v);
          if (String(o.date) !== dateStr) return;
          reportedBy[String(o.user_id)] = true;
        });
      }
    }
  }

  // ---- approved leave covering the day ----
  const onLeave = {};
  leavesOverlapping_(dateStr, dateStr).forEach(function (l) {
    onLeave[String(l.user_id)] = String(l.type);
  });

  const rows = users.map(function (u) {
    const uid = String(u.user_id);
    const m = today[uid] || {};
    const leave = onLeave[uid] || '';
    return {
      id: uid, name: String(u.name), cadre: String(u.cadre), role: String(u.role),
      project: String(u.project_code), sectorCode: String(u.sector_code),
      sector: sectors[String(u.sector_code)] || String(u.sector_code),
      awc: awcs[String(u.awc_id)] || String(u.awc_id || ''),
      inTime: m.IN ? m.IN.time : '', inFence: m.IN ? fenceWord_(m.IN.geofence) : '',
      inDist: m.IN && m.IN.dist != null ? Math.round(m.IN.dist) : '',
      outTime: m.OUT ? m.OUT.time : '', outFence: m.OUT ? fenceWord_(m.OUT.geofence) : '',
      outDist: m.OUT && m.OUT.dist != null ? Math.round(m.OUT.dist) : '',
      reported: reportedBy[uid] ? 'Yes' : 'No',
      leave: leave ? (LEAVE_TYPE_LABEL[leave] || leave) : '',
      ever: !!everMarked[uid],
      status: personStatus_(m, leave, !!everMarked[uid])
    };
  });

  const has = function (r, k) { return !!r[k]; };
  const totals = {
    roll: rows.length,
    markedIn: rows.filter(function (r) { return has(r, 'inTime'); }).length,
    markedOut: rows.filter(function (r) { return has(r, 'outTime'); }).length,
    onLeave: rows.filter(function (r) { return r.leave; }).length,
    reported: rows.filter(function (r) { return r.reported === 'Yes'; }).length,
    notMarked: rows.filter(function (r) { return !has(r, 'inTime') && !has(r, 'outTime') && !r.leave; }).length,
    never: rows.filter(function (r) { return !r.ever; }).length,
    insideIn: rows.filter(function (r) { return r.inFence === 'Yes'; }).length,
    outsideIn: rows.filter(function (r) { return r.inFence === 'No'; }).length
  };

  return { rows: rows, totals: totals,
    byCadre: groupCounts_(rows, function (r) {
      return r.role === 'SUPERVISOR' ? 'Supervisor' : r.cadre;
    }),
    bySector: groupCounts_(rows, function (r) { return r.sector; }),
    centres: centreCounts_(rows) };
}

function fenceWord_(gf) {
  if (gf === 'INSIDE') return 'Yes';
  if (gf === 'OUTSIDE') return 'No';
  return 'No GPS fix';
}

function personStatus_(m, leave, ever) {
  if (leave) return 'On leave';
  if (m.IN && m.OUT) return 'Present, day complete';
  if (m.IN) return 'Present, no OUT yet';
  if (m.OUT) return 'OUT only';
  return ever ? 'Not marked today' : 'Never marked';
}

function groupCounts_(rows, keyFn) {
  const out = {};
  rows.forEach(function (r) {
    const k = keyFn(r);
    const g = out[k] || (out[k] = { key: k, roll: 0, in: 0, out: 0, leave: 0, notMarked: 0, never: 0 });
    g.roll++;
    if (r.inTime) g.in++;
    if (r.outTime) g.out++;
    if (r.leave) g.leave++;
    if (!r.inTime && !r.outTime && !r.leave) g.notMarked++;
    if (!r.ever) g.never++;
  });
  return Object.keys(out).map(function (k) { return out[k]; });
}

function centreCounts_(rows) {
  const c = {};
  rows.forEach(function (r) {
    if (!r.awc || r.role === 'SUPERVISOR') return;
    const g = c[r.awc] || (c[r.awc] = { roll: 0, marked: 0 });
    g.roll++;
    if (r.inTime || r.outTime) g.marked++;
  });
  const list = Object.keys(c).map(function (k) { return c[k]; });
  return {
    total: list.length,
    full: list.filter(function (g) { return g.marked === g.roll; }).length,
    partial: list.filter(function (g) { return g.marked > 0 && g.marked < g.roll; }).length,
    none: list.filter(function (g) { return g.marked === 0; }).length
  };
}

function pct_(a, b) { return b ? (Math.round(a / b * 1000) / 10) + '%' : '—'; }

function prettyDay_(dateStr) {
  return Utilities.formatDate(new Date(dateStr + 'T12:00:00+05:30'), TZ, 'd MMMM yyyy');
}

// ------------------------------------------------------------------- html
function dailyAttendanceHtml_(dateStr, d, holiday, isTest) {
  const t = d.totals;
  const esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  };
  const TH = 'style="text-align:left;padding:7px 8px;background:#f2f6f8;' +
    'border-bottom:2px solid #0b5c4f;font-size:11px;letter-spacing:.04em;' +
    'text-transform:uppercase;color:#0b5c4f"';
  const TD = 'style="padding:6px 8px;border-bottom:1px solid #eef1f5;font-size:12.5px"';
  const TDR = 'align="right" ' + TD;

  const tile = function (v, l, colour) {
    return '<td style="padding:12px 10px;border:1px solid #e3e7ee;border-top:3px solid ' +
      colour + ';vertical-align:top"><div style="font-size:23px;font-weight:700;color:' +
      colour + '">' + v + '</div><div style="font-size:11px;color:#525a66;margin-top:3px">' +
      l + '</div></td>';
  };

  // Names grouped by sector: far smaller on the wire than one row per person,
  // and the order a supervisor will actually work the list in.
  const nameBlock = function (list) {
    if (!list.length) return '<p style="font-size:12.5px;color:#14603a"><b>None. ' +
      'Every person on the rolls is accounted for.</b></p>';
    const bySec = {};
    list.forEach(function (r) { (bySec[r.sector] = bySec[r.sector] || []).push(r); });
    return '<table style="width:100%;border-collapse:collapse">' +
      Object.keys(bySec).sort().map(function (sc) {
        const people = bySec[sc].sort(function (a, b) { return a.name < b.name ? -1 : 1; });
        return '<tr><td style="padding:7px 8px 2px;font-size:12px;font-weight:600;' +
          'color:#0b5c4f;border-top:1px solid #e3e7ee">' + esc(sc) +
          ' <span style="font-weight:400;color:#7b8494">(' + people.length + ')</span>' +
          '</td></tr><tr><td style="padding:0 8px 7px;font-size:11.5px;line-height:1.75">' +
          people.map(function (p) {
            return esc(p.name) + ' <small>' + esc(p.cadre) + ', ' + esc(p.awc) + '</small>';
          }).join(' &nbsp;| ') + '</td></tr>';
      }).join('') + '</table>';
  };

  const notMarked = d.rows.filter(function (r) {
    return !r.inTime && !r.outTime && !r.leave;
  });
  const never = d.rows.filter(function (r) { return !r.ever; });

  const cadreOrder = ['AWT', 'AWH', 'Supervisor'];
  const cadreRows = d.byCadre.sort(function (a, b) {
    return cadreOrder.indexOf(a.key) - cadreOrder.indexOf(b.key);
  }).map(function (g) {
    return '<tr><td ' + TD + '><b>' + esc(g.key === 'AWT' ? 'Anganwadi Teacher (AWT)'
      : g.key === 'AWH' ? 'Anganwadi Helper (AWH)' : g.key) + '</b></td>' +
      '<td ' + TDR + '>' + g.roll + '</td><td ' + TDR + '>' + g.in + '</td>' +
      '<td ' + TDR + '>' + g.out + '</td><td ' + TDR + '>' + g.leave + '</td>' +
      '<td ' + TDR + '>' + g.notMarked + '</td><td ' + TDR + '>' + g.never + '</td>' +
      '<td ' + TDR + '><b>' + pct_(g.in, g.roll) + '</b></td></tr>';
  }).join('');

  const sectorRows = d.bySector.sort(function (a, b) {
    return (a.in / (a.roll || 1)) - (b.in / (b.roll || 1));
  }).map(function (g) {
    const p = g.roll ? g.in / g.roll * 100 : 0;
    return '<tr><td ' + TD + '>' + esc(g.key) + '</td>' +
      '<td ' + TDR + '>' + g.roll + '</td><td ' + TDR + '>' + g.in + '</td>' +
      '<td ' + TDR + '>' + g.out + '</td><td ' + TDR + '>' + g.leave + '</td>' +
      '<td ' + TDR + '>' + g.notMarked + '</td><td ' + TDR + '>' + g.never + '</td>' +
      '<td ' + TDR + '><b style="color:' + (p < 50 ? '#a41e17' : '#14603a') + '">' +
      pct_(g.in, g.roll) + '</b></td></tr>';
  }).join('');

  return '<div style="font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111418;' +
    'max-width:900px;margin:0 auto;background:#fff">' +

    (isTest ? '<div style="background:#8a5200;color:#fff;padding:8px 22px;font-size:12.5px">' +
      '<b>TEST MESSAGE</b> — sent manually for checking. Not the scheduled report.</div>' : '') +

    '<div style="background:#0b5c4f;color:#fff;padding:18px 22px">' +
    '<div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;opacity:.85">' +
    'Government of Telangana &middot; WD&amp;CW &middot; Jangaon District</div>' +
    '<div style="font-size:20px;font-weight:600;margin-top:5px">Daily Attendance Report &mdash; ' +
    prettyDay_(dateStr) + '</div>' +
    '<div style="font-size:12.5px;opacity:.9;margin-top:3px">Position as at ' +
    Utilities.formatDate(new Date(), TZ, 'HH:mm') + ' hrs. Generated automatically from ' +
    'Sisu Mahila Samridhi.' + (holiday ? ' <b>' + esc(holiday) + '.</b>' : '') + '</div></div>' +

    '<div style="padding:18px 22px">' +

    '<table style="width:100%;border-collapse:separate;border-spacing:6px 0"><tr>' +
    tile(t.roll, 'On the rolls', '#0b5c4f') +
    tile(t.markedIn, 'Marked IN', '#14603a') +
    tile(t.markedOut, 'Marked OUT', '#0b5c4f') +
    tile(t.onLeave, 'On sanctioned leave', '#0b5c4f') +
    tile(t.notMarked, 'Not marked', '#a41e17') +
    tile(t.never, 'Never marked', '#8a5200') +
    '</tr></table>' +
    '<p style="font-size:12px;color:#525a66;margin:8px 0 18px">' +
    pct_(t.markedIn, t.roll) + ' of the establishment marked arrival. ' +
    'Of those arrivals, <b>' + t.insideIn + '</b> were inside the centre boundary and <b>' +
    t.outsideIn + '</b> outside it. ' + t.reported +
    ' persons filed the daily beneficiary return.</p>' +

    '<h3 style="font-size:14px;margin:20px 0 6px;color:#0b5c4f">1. Attendance by cadre</h3>' +
    '<table style="width:100%;border-collapse:collapse"><tr>' +
    '<th ' + TH + '>Cadre</th><th ' + TH + ' align="right">On rolls</th>' +
    '<th ' + TH + ' align="right">Marked IN</th><th ' + TH + ' align="right">Marked OUT</th>' +
    '<th ' + TH + ' align="right">On leave</th><th ' + TH + ' align="right">Not marked</th>' +
    '<th ' + TH + ' align="right">Never marked</th><th ' + TH + ' align="right">Marked %</th>' +
    '</tr>' + cadreRows +
    '<tr style="background:#f7f9fb"><td ' + TD + '><b>Total</b></td>' +
    '<td ' + TDR + '><b>' + t.roll + '</b></td><td ' + TDR + '><b>' + t.markedIn + '</b></td>' +
    '<td ' + TDR + '><b>' + t.markedOut + '</b></td><td ' + TDR + '><b>' + t.onLeave + '</b></td>' +
    '<td ' + TDR + '><b>' + t.notMarked + '</b></td><td ' + TDR + '><b>' + t.never + '</b></td>' +
    '<td ' + TDR + '><b>' + pct_(t.markedIn, t.roll) + '</b></td></tr></table>' +

    '<h3 style="font-size:14px;margin:22px 0 6px;color:#0b5c4f">2. Centres</h3>' +
    '<table style="width:100%;border-collapse:collapse"><tr>' +
    '<th ' + TH + '>Position</th><th ' + TH + ' align="right">Centres</th>' +
    '<th ' + TH + '>Meaning</th></tr>' +
    '<tr><td ' + TD + '>Every posted worker marked</td><td ' + TDR + '>' + d.centres.full +
    '</td><td ' + TD + '>The centre is fully accounted for today.</td></tr>' +
    '<tr><td ' + TD + '>Some marked, some not</td><td ' + TDR + '>' + d.centres.partial +
    '</td><td ' + TD + '>Teacher or helper marked, the other did not.</td></tr>' +
    '<tr><td ' + TD + '><b style="color:#a41e17">Nobody marked</b></td><td ' + TDR + '><b>' +
    d.centres.none + '</b></td><td ' + TD + '>No attendance from this centre at all today. ' +
    'These need the first call.</td></tr>' +
    '<tr style="background:#f7f9fb"><td ' + TD + '><b>Centres with staff posted</b></td>' +
    '<td ' + TDR + '><b>' + d.centres.total + '</b></td><td ' + TD + '></td></tr></table>' +

    '<h3 style="font-size:14px;margin:22px 0 6px;color:#0b5c4f">3. Sector analysis</h3>' +
    '<table style="width:100%;border-collapse:collapse"><tr>' +
    '<th ' + TH + '>Sector</th><th ' + TH + ' align="right">On rolls</th>' +
    '<th ' + TH + ' align="right">Marked IN</th><th ' + TH + ' align="right">Marked OUT</th>' +
    '<th ' + TH + ' align="right">On leave</th><th ' + TH + ' align="right">Not marked</th>' +
    '<th ' + TH + ' align="right">Never marked</th><th ' + TH + ' align="right">Marked %</th>' +
    '</tr>' + sectorRows + '</table>' +
    '<p style="font-size:11.5px;color:#7b8494;margin:6px 0 0">Ordered by marking rate, ' +
    'weakest first.</p>' +

    '<h3 style="font-size:14px;margin:22px 0 6px;color:#a41e17">4. Not marked today &mdash; ' +
    notMarked.length + ' persons</h3>' +
    '<p style="font-size:12px;color:#525a66;margin:0 0 8px">Excludes those on sanctioned ' +
    'leave. Every person, marked or not, is in the attached spreadsheet.</p>' +
    (notMarked.length <= DAILY_EMAIL_MAX_NAMES ? nameBlock(notMarked) :
      '<p style="font-size:12.5px">' + notMarked.length + ' persons. The list is too long ' +
      'to carry in an email without it being truncated by the mail service, so it is in ' +
      'the attached spreadsheet only.</p>') +

    '<h3 style="font-size:14px;margin:24px 0 6px;color:#8a5200">5. Never marked since ' +
    'deployment &mdash; ' + never.length + ' persons</h3>' +
    '<p style="font-size:12px;color:#525a66;margin:0 0 8px">No attendance record at any ' +
    'time. These need onboarding or an explanation, not a day\'s follow-up.</p>' +
    (never.length <= DAILY_EMAIL_MAX_NAMES ? nameBlock(never) :
      '<p style="font-size:12.5px">' + never.length + ' persons; see the attached ' +
      'spreadsheet.</p>') +

    '<div style="margin-top:26px;padding-top:14px;border-top:2px solid #0b5c4f;' +
    'font-size:11px;color:#525a66">Generated automatically from Sisu Mahila Samridhi. ' +
    'Figures are as recorded at the time of generation; marks made where there was no ' +
    'network arrive later and appear in the next day\'s report.<br>' +
    '<b>Confidential.</b> This message names identifiable public servants and is to be ' +
    'handled under the Digital Personal Data Protection Act, 2023.</div>' +
    '</div></div>';
}

// ------------------------------------------------------------------ excel
/**
 * One row per person for the day. Built in a temporary spreadsheet and
 * exported as xlsx, which is the only way Apps Script produces a real Excel
 * file; the temporary file is removed whether or not the export succeeds.
 */
function dailyAttendanceXlsx_(dateStr, d) {
  const header = ['S.No', 'User ID', 'Name', 'Cadre', 'Project', 'Sector', 'Centre',
    'Attendance marked', 'Marked IN', 'IN inside geofence', 'IN distance (m)',
    'Marked OUT', 'OUT inside geofence', 'OUT distance (m)',
    'Daily report submitted', 'On leave', 'Ever marked', 'Status'];

  const body = d.rows.slice().sort(function (a, b) {
    if (a.sector !== b.sector) return a.sector < b.sector ? -1 : 1;
    if (a.awc !== b.awc) return a.awc < b.awc ? -1 : 1;
    return a.name < b.name ? -1 : 1;
  }).map(function (r, i) {
    // "Attendance marked" is deliberately first among the day's columns and
    // is a plain Yes/No, so the sheet can be filtered straight down to the
    // people who did not mark without reading the status text.
    return [i + 1, r.id, r.name, r.role === 'SUPERVISOR' ? 'Supervisor' : r.cadre,
      r.project, r.sector, r.awc,
      (r.inTime || r.outTime) ? 'Yes' : 'No',
      r.inTime || 'Not marked', r.inFence || '-', r.inDist === '' ? '' : r.inDist,
      r.outTime || 'Not marked', r.outFence || '-', r.outDist === '' ? '' : r.outDist,
      r.reported, r.leave || 'No', r.ever ? 'Yes' : 'No', r.status];
  });

  const name = 'Jangaon-attendance-' + dateStr;
  const temp = SpreadsheetApp.create(name);
  let blob;
  try {
    const sh = temp.getActiveSheet();
    sh.setName('Attendance ' + dateStr);
    sh.getRange(1, 1, 1, header.length).setValues([header])
      .setFontWeight('bold').setBackground('#0b5c4f').setFontColor('#ffffff');
    if (body.length) sh.getRange(2, 1, body.length, header.length).setValues(body);
    sh.setFrozenRows(1);
    sh.autoResizeColumns(1, header.length);
    // A filter makes this usable for a supervisor who only wants her sector.
    sh.getRange(1, 1, body.length + 1, header.length).createFilter();
    SpreadsheetApp.flush();

    const url = 'https://docs.google.com/spreadsheets/d/' + temp.getId() + '/export?format=xlsx';
    blob = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: false
    }).getBlob().setName(name + '.xlsx');
  } finally {
    // Never leave the temporary workbook behind in the department's Drive.
    DriveApp.getFileById(temp.getId()).setTrashed(true);
  }
  return blob;
}
