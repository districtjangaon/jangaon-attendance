'use strict';
/**
 * All-time attendance workbook, built in the browser.
 *
 * The same workbook as tools/all-time-report.py, sheet for sheet, so the
 * district gets one report whether it is produced here or on the desk:
 * Summary, Never Marked, Stopped Marking, Staff Summary, Daily Trend, Sector
 * Summary, Centre Summary, Daily Returns, Flag Counts, Flagged Marks, Leaves,
 * and a Register per month. Roll-ups are live formulas over Staff Summary.
 *
 * Sources: the published month files (summary/month for the current month,
 * summary/archive/<ym> for earlier ones), summary/reports/<ym>.json for the
 * daily returns, and the live name map for the rolls. Loaded on demand with
 * vendor/exceljs.min.js (MIT); neither is part of the console's boot.
 *
 * Operational-day rule: a working day counts against a person only when the
 * district was operating - at least OP_SHARE of the rolls marked. That drops
 * the rollout days and district-wide breaks that are not in the Holidays
 * sheet (the Dasara break of 10-21 Oct 2026 had under 80 marks a day).
 */
window.AllTimeReport = (() => {
  const GO_LIVE = '2026-08-08';
  const ROLLOUT_END = '2026-08-21';   // 8-21 Aug = onboarding; full rollout from 22 Aug
  const OP_SHARE = 0.10;
  const STOPPED_OPDAYS = 10;

  const FLAG_TEXT = {
    NO_PHOTO: 'no photo captured', NO_GPS: 'no GPS captured',
    LATE_SYNC: 'synced more than a day late', CLOCK_SKEW: 'phone clock wrong by 5+ minutes',
    PERFECT_ACCURACY: 'GPS accuracy suspiciously perfect',
    AT_CENTER_EXACT: 'exactly on the stored centre point',
    REPEAT_COORDS: 'same coordinates as the previous mark',
    REPEAT_COORDS_5D: 'identical coordinates 5 days in a row',
    IMPOSSIBLE_VELOCITY: 'impossible travel speed between marks',
    FAKE_GPS_SUSPECT: 'possible fake-GPS app', OFFLINE_SYNC: 'marked offline, sent later',
    EARLY_OUT: 'OUT marked before 4:00 PM', NO_REPORT_AT_OUT: 'OUT without the daily centre report',
    OLD_APP: 'outdated app build', PHOTO_DARK: 'photo too dark', PHOTO_FLAT: 'photo has no detail',
    UPLOAD_FAILED: 'photo upload failed'
  };
  const LEAVE_LABEL = { CASUAL: 'Casual Leave', EARNED: 'Earned Leave', OPTIONAL: 'Optional Holiday', SICK: 'Medical Leave' };

  const FONT = 'Arial';
  const fill = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
  const HEAD_FILL = fill('FF0B5C4F'), RED = fill('FFFDE2E1'), AMBER = fill('FFFFF3CD'),
    GREEN = fill('FFE3F4EA'), GREY = fill('FFEDEDED');
  const HEAD_FONT = { name: FONT, bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  const BODY_FONT = { name: FONT, size: 10 };
  const BOLD_FONT = { name: FONT, size: 10, bold: true };
  const CENTER = { horizontal: 'center' };

  const col = n => { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - r - 1) / 26; } return s; };
  const f = formula => ({ formula });
  const dow = ds => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(ds + 'T12:00:00').getDay()];
  const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

  /** New worksheet with a styled header row, column widths and freeze. */
  function sheet(wb, name, header, widths, opt) {
    opt = opt || {};
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', xSplit: opt.xSplit || 0, ySplit: opt.ySplit == null ? 1 : opt.ySplit }] });
    widths.forEach((w, i) => { const c = ws.getColumn(i + 1); c.width = w; c.font = BODY_FONT; });
    if (opt.legend) {
      const r = ws.addRow([opt.legend]);
      r.getCell(1).font = { name: FONT, italic: true, size: 9 };
    }
    const h = ws.addRow(header);
    h.height = 32;
    h.eachCell(c => { c.font = HEAD_FONT; c.fill = HEAD_FILL; c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; });
    ws.headerRow = h.number;
    return ws;
  }
  function filter(ws, cols) {
    if (ws.rowCount > ws.headerRow) ws.autoFilter = { from: { row: ws.headerRow, column: 1 }, to: { row: ws.rowCount, column: cols } };
  }

  async function build(ctx, say) {
    const { Api, names, meta, sectorName, lateAfterFor } = ctx;
    say('Loading month files…');
    const cur = (meta && meta.month) || ymd(new Date()).slice(0, 7);
    const months = [];
    for (let y = Number(GO_LIVE.slice(0, 4)), m = Number(GO_LIVE.slice(5, 7)); ;) {
      const ym = y + '-' + String(m).padStart(2, '0');
      if (ym > cur) break;
      months.push(ym);
      if (++m === 13) { m = 1; y++; }
    }
    const secs = (names.sectors || []).map(s => s.code);

    // ------------------------------------------------ gather marks, leaves, holidays, returns
    const marks = {}, leaves = {}, hols = {}, sources = {};
    const rptDaysByAwc = {}, rptDistrict = {};
    let endDate = '';
    for (const ym of months) {
      const path = sc => ym === cur ? 'summary/month/' + sc + '.json' : 'summary/archive/' + ym + '/' + sc + '.json';
      const [docs, rj] = await Promise.all([
        Promise.all(secs.map(sc => Api.fetchJson(path(sc)))),
        Api.fetchJson('summary/reports/' + ym + '.json')
      ]);
      let n = 0;
      docs.forEach(d => {
        if (!d || d.ym !== ym) return;    // stale files for retired sector codes carry another month
        n++;
        const g = String(d.generatedAt || '').slice(0, 10);
        if (g > endDate) endDate = g;
        Object.assign(hols[ym] = hols[ym] || {}, d.holidays || {});
        Object.keys(d.users || {}).forEach(uid => {
          Object.keys(d.users[uid]).forEach(dd => { (marks[uid] = marks[uid] || {})[ym + '-' + dd] = d.users[uid][dd]; });
        });
        Object.keys(d.leaves || {}).forEach(uid => {
          Object.keys(d.leaves[uid]).forEach(dd => { (leaves[uid] = leaves[uid] || {})[ym + '-' + dd] = d.leaves[uid][dd]; });
        });
      });
      sources[ym] = n ? (ym === cur ? 'summary/month (live), ' : 'summary/archive/' + ym + ', ') + n + ' sector files' : 'no data published';
      if (rj) {
        Object.keys(rj.awcs || {}).forEach(aid => {
          Object.keys((rj.awcs[aid] || {}).d || {}).forEach(dd => { (rptDaysByAwc[aid] = rptDaysByAwc[aid] || []).push(ym + '-' + dd); });
        });
        Object.keys(rj.days || {}).forEach(dd => { rptDistrict[ym + '-' + dd] = rj.days[dd]; });
      }
    }
    if (!endDate) throw new Error('No month files are published yet.');
    // The month files are rebuilt nightly; the period ends on the last day they
    // cover, so a half-day of marks never reads as absence.
    const lastYm = endDate.slice(0, 7);
    if (lastYm < cur) endDate = ymd(new Date(Number(lastYm.slice(0, 4)), Number(lastYm.slice(5, 7)), 0));

    // ------------------------------------------------------------- rolls
    const awcName = a => (names.awcs[a] && names.awcs[a].n) || a || '';
    const awcSector = a => (names.awcs[a] && names.awcs[a].sc) || '';
    const projName = {};
    (names.projects || []).forEach(p => { projName[p.code] = p.name; });
    const sectorProj = {};
    (names.sectors || []).forEach(s => { sectorProj[s.code] = s.project; });
    const secLabel = sc => String(sc || '').split(',').filter(Boolean).map(sectorName).join(', ');
    const cadre = u => u.r === 'SUPERVISOR' ? 'SUP' : u.c;
    const roster = Object.keys(names.users).filter(id => {
      const u = names.users[id];
      return (u.r === 'FIELD' || u.r === 'SUPERVISOR') && u.s === 'ACTIVE';
    }).map(id => Object.assign({ id }, names.users[id]));
    roster.sort((a, b) => {
      const ka = [a.pj || 'zz', a.sc || 'zz', awcName(a.a) || 'zz', a.n], kb = [b.pj || 'zz', b.sc || 'zz', awcName(b.a) || 'zz', b.n];
      for (let i = 0; i < 4; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
      return 0;
    });
    const onRolls = {};
    roster.forEach(u => { onRolls[u.id] = 1; });
    const supOfSector = {};
    roster.filter(u => u.r === 'SUPERVISOR').forEach(u => { String(u.sc || '').split(',').forEach(sc => { supOfSector[sc] = u.n; }); });

    // ---------------------------------------------------------- calendar
    const days = [];
    for (let d = new Date(GO_LIVE + 'T12:00:00'); ymd(d) <= endDate; d.setDate(d.getDate() + 1)) days.push(ymd(d));
    const holidayName = ds => {
      const h = hols[ds.slice(0, 7)] || {};
      if (h[ds.slice(8)]) return h[ds.slice(8)];
      return new Date(ds + 'T12:00:00').getDay() === 0 ? 'Sunday' : '';
    };
    const live = r => r && r.x !== 'REJ' ? r : null;
    const perDay = {};
    Object.keys(marks).forEach(uid => {
      if (!onRolls[uid]) return;
      Object.keys(marks[uid]).forEach(ds => { if (live(marks[uid][ds].IN) || live(marks[uid][ds].OUT)) perDay[ds] = (perDay[ds] || 0) + 1; });
    });
    const minMarks = Math.max(1, Math.round(roster.length * OP_SHARE));
    const working = days.filter(ds => !holidayName(ds));
    const operating = working.filter(ds => (perDay[ds] || 0) >= minMarks);
    const operatingFull = operating.filter(ds => ds > ROLLOUT_END);
    const opSet = {}, opSetFull = {}, recentOps = {};
    operating.forEach(ds => { opSet[ds] = 1; });
    operatingFull.forEach(ds => { opSetFull[ds] = 1; });
    operating.slice(-STOPPED_OPDAYS).forEach(ds => { recentOps[ds] = 1; });
    const nonOp = working.filter(ds => !opSet[ds]);
    const nW = operating.length, nM = operatingFull.length;
    const wdByMonth = {}, odByMonth = {};
    working.forEach(ds => { wdByMonth[ds.slice(0, 7)] = (wdByMonth[ds.slice(0, 7)] || 0) + 1; });
    operating.forEach(ds => { odByMonth[ds.slice(0, 7)] = (odByMonth[ds.slice(0, 7)] || 0) + 1; });

    // -------------------------------------------------------- per person
    const stats = {};
    const flagCounts = {};
    const flaggedRows = [];
    roster.forEach(u => {
      const m = marks[u.id] || {};
      const lateAt = lateAfterFor(u.id);
      const s = { first: '', last: '', any: 0, op: 0, full: 0, inD: 0, outD: 0, both: 0, late: 0, outside: 0, unver: 0,
        flagged: 0, leave: Object.keys(leaves[u.id] || {}).length, recent: false, perMonth: {} };
      Object.keys(m).sort().forEach(ds => {
        const i = live(m[ds].IN), o = live(m[ds].OUT);
        if (!i && !o) return;
        s.any++;
        s.perMonth[ds.slice(0, 7)] = (s.perMonth[ds.slice(0, 7)] || 0) + 1;
        if (opSet[ds]) s.op++;
        if (opSetFull[ds]) s.full++;
        if (recentOps[ds]) s.recent = true;
        s.first = s.first || ds;
        s.last = ds;
        if (i) {
          s.inD++;
          if (i.t && i.t > lateAt) s.late++;
          if (i.gf === 'OUTSIDE') s.outside++;
          if (i.gf === 'UNVERIFIED') s.unver++;
        }
        if (o) s.outD++;
        if (i && o) s.both++;
        [['IN', i], ['OUT', o]].forEach(([typ, r]) => {
          if (!r) return;
          const fl = String(r.fl || '').split(',').filter(Boolean);
          fl.forEach(x => { (flagCounts[x] = flagCounts[x] || {})[ds.slice(0, 7)] = ((flagCounts[x] || {})[ds.slice(0, 7)] || 0) + 1; });
          if (r.gf === 'OUTSIDE') (flagCounts.OUTSIDE_GEOFENCE = flagCounts.OUTSIDE_GEOFENCE || {})[ds.slice(0, 7)] = (flagCounts.OUTSIDE_GEOFENCE[ds.slice(0, 7)] || 0) + 1;
          if (!fl.length && r.gf !== 'OUTSIDE') return;
          s.flagged++;
          const parts = [];
          if (r.gf === 'OUTSIDE') parts.push('marked outside the centre geofence');
          fl.forEach(x => parts.push(FLAG_TEXT[x] || x.toLowerCase().replace(/_/g, ' ')));
          const remark = parts.join('; ');
          flaggedRows.push([ds, u.id, u.n, cadre(u), projName[u.pj] || u.pj || '', secLabel(u.sc), awcName(u.a), typ,
            r.t || '', r.gf || '', r.d == null ? '' : r.d, fl.join(','), remark.charAt(0).toUpperCase() + remark.slice(1)]);
        });
      });
      s.status = !s.any ? 'Never marked' : (s.recent ? 'Active' : 'Stopped marking');
      stats[u.id] = s;
    });

    say('Building workbook…');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Sisu Mahila Samridhi';
    wb.calcProperties.fullCalcOnLoad = true;
    const summaryWs = wb.addWorksheet('Summary');   // first tab; filled last, once the other sheets exist
    const personCols = u => [u.id, u.n, cadre(u), u.p, projName[u.pj] || u.pj || '',
      secLabel(u.sc), awcName(u.a) || (u.r === 'SUPERVISOR' ? 'All sector centres' : '')];

    // ========================================================= Never Marked
    const never = roster.filter(u => stats[u.id].status === 'Never marked');
    ws = sheet(wb, 'Never Marked', ['S.No', 'User ID', 'Name', 'Cadre', 'Phone', 'Project', 'Sector', 'Supervisor', 'Centre',
      'Registered (first login done)', 'Leave days recorded', 'Note'], [6, 9, 28, 7, 12, 13, 18, 22, 26, 12, 10, 24]);
    never.forEach((u, i) => {
      const p = personCols(u);
      ws.addRow([i + 1].concat(p.slice(0, 5), [supOfSector[String(u.sc || '').split(',')[0]] || ''], [p[6]],
        [u.pn ? 'Yes' : 'No', stats[u.id].leave, u.r === 'SUPERVISOR' ? 'Supervisor' : (u.pj ? '' : 'No project/sector in Users sheet')]));
    });
    filter(ws, 12);

    // ====================================================== Stopped Marking
    const stopped = roster.filter(u => stats[u.id].status === 'Stopped marking');
    ws = sheet(wb, 'Stopped Marking', ['S.No', 'User ID', 'Name', 'Cadre', 'Phone', 'Project', 'Sector', 'Supervisor', 'Centre',
      'First mark', 'Last mark', 'Days marked (any day)', 'Operational days missed since last mark'], [6, 9, 28, 7, 12, 13, 18, 22, 26, 11, 11, 10, 12]);
    stopped.forEach((u, i) => {
      const s = stats[u.id], p = personCols(u);
      ws.addRow([i + 1].concat(p.slice(0, 5), [supOfSector[String(u.sc || '').split(',')[0]] || ''], [p[6]],
        [s.first, s.last, s.any, operating.filter(ds => ds > s.last).length]));
    });
    filter(ws, 13);

    // ====================================================== Staff Summary (the roll-up sheets refer to it)
    const SS = "'Staff Summary'!";
    let ws = sheet(wb, 'Staff Summary', ['S.No', 'User ID', 'Name', 'Cadre', 'Phone', 'Project', 'Sector', 'Centre ID', 'Centre',
      'Status', 'Ever marked', 'First mark', 'Last mark',
      'Operational days since go-live', 'Days marked on operational days (go-live)', 'Attendance % (go-live)',
      'Operational days from 22-Aug', 'Days marked on operational days (from 22-Aug)', 'Attendance % (from 22-Aug)',
      'Days IN', 'Days OUT', 'Days IN+OUT', 'Late IN (after schedule)', 'IN outside geofence', 'IN location unverified',
      'Flagged marks', 'Leave days'].concat(months.map(ym => 'Days marked ' + ym + ' (any day)'))
      .concat(['Days marked total (any day, incl. holidays and breaks)']),
    [6, 9, 28, 7, 12, 13, 18, 9, 24, 24, 8, 11, 11, 10, 10, 11, 10, 10, 11, 8, 8, 9, 10, 10, 10, 9, 8].concat(months.map(() => 11)).concat([12]),
    { xSplit: 3 });
    roster.forEach((u, i) => {
      const s = stats[u.id];
      const r = i + 2;
      const row = ws.addRow([i + 1, u.id, u.n, cadre(u), u.p, projName[u.pj] || u.pj || '', secLabel(u.sc), u.a || '',
        awcName(u.a) || (u.r === 'SUPERVISOR' ? 'All sector centres' : ''),
        s.status, s.any ? 'Yes' : 'No', s.first, s.last,
        nW, s.op, f('IF(N' + r + '=0,0,O' + r + '/N' + r + ')'),
        nM, s.full, f('IF(Q' + r + '=0,0,R' + r + '/Q' + r + ')'),
        s.inD, s.outD, s.both, s.late, s.outside, s.unver, s.flagged, s.leave]
        .concat(months.map(ym => s.perMonth[ym] || 0)).concat([s.any]));
      row.getCell(16).numFmt = '0.0%';
      row.getCell(19).numFmt = '0.0%';
      if (s.status === 'Never marked') row.getCell(10).fill = RED;
      else if (s.status === 'Stopped marking') row.getCell(10).fill = AMBER;
    });
    filter(ws, ws.columnCount);
    const STAFF_LAST = ws.rowCount;
    const anyCol = col(28 + months.length);

    // ========================================================== Daily Trend
    ws = sheet(wb, 'Daily Trend', ['Date', 'Day', 'Holiday', 'Operational day (' + minMarks + '+ marks)', 'Staff on rolls',
      'Marked (IN or OUT)', 'IN', 'OUT', 'IN+OUT', 'Late IN', 'IN outside geofence', 'IN unverified', 'On leave', 'Not marked', 'Marked %'],
    [12, 6, 26, 11, 10, 12, 8, 8, 9, 9, 12, 11, 9, 11, 10]);
    days.forEach(ds => {
      const c = { m: 0, i: 0, o: 0, b: 0, l: 0, out: 0, un: 0, lv: 0 };
      roster.forEach(u => {
        const rec = (marks[u.id] || {})[ds] || {};
        const i = live(rec.IN), o = live(rec.OUT);
        if ((leaves[u.id] || {})[ds]) c.lv++;
        if (i || o) c.m++;
        if (i) { c.i++; if (i.t && i.t > lateAfterFor(u.id)) c.l++; if (i.gf === 'OUTSIDE') c.out++; if (i.gf === 'UNVERIFIED') c.un++; }
        if (o) c.o++;
        if (i && o) c.b++;
      });
      const r = ws.rowCount + 1;
      const row = ws.addRow([ds, dow(ds), holidayName(ds), opSet[ds] ? 'Yes' : 'No', roster.length, c.m, c.i, c.o, c.b, c.l, c.out, c.un, c.lv,
        f('E' + r + '-F' + r + '-M' + r), f('IF(E' + r + '=0,0,F' + r + '/E' + r + ')')]);
      row.getCell(15).numFmt = '0.0%';
      const shade = holidayName(ds) ? GREY : (!opSet[ds] ? AMBER : null);
      if (shade) row.eachCell(cell => { cell.fill = shade; });
    });
    filter(ws, 15);

    // ======================================================= Sector Summary
    ws = sheet(wb, 'Sector Summary', ['Project', 'Sector code', 'Sector', 'Supervisor', 'Staff on rolls', 'Never marked', 'Stopped marking',
      'Active', 'Possible person-days (go-live)', 'Person-days marked (go-live)', 'Attendance % (go-live)',
      'Person-days marked from 22-Aug', 'Attendance % (from 22-Aug)', 'Late IN', 'IN outside geofence', 'Flagged marks', 'Leave days'],
    [13, 8, 18, 22, 9, 9, 9, 8, 12, 12, 11, 12, 11, 9, 10, 9, 9]);
    const crit = (c, v) => SS + '$' + c + '$2:$' + c + '$' + STAFF_LAST + ',"' + String(v).replace(/"/g, '""') + '"';
    const sumif = (c, v, s) => f('SUMIF(' + crit(c, v) + ',' + SS + '$' + s + '$2:$' + s + '$' + STAFF_LAST + ')');
    const countifs = (c, v, s, sv) => f('COUNTIFS(' + crit(c, v) + ',' + SS + '$' + s + '$2:$' + s + '$' + STAFF_LAST + ',"' + sv + '")');
    (names.sectors || []).forEach(s => {
      const r = ws.rowCount + 1, label = sectorName(s.code);
      const row = ws.addRow([projName[s.project] || s.project, s.code, s.name, supOfSector[s.code] || '',
        f('COUNTIF(' + crit('G', label) + ')'),
        countifs('G', label, 'J', 'Never marked'), countifs('G', label, 'J', 'Stopped*'), countifs('G', label, 'J', 'Active'),
        sumif('G', label, 'N'), sumif('G', label, 'O'), f('IF(I' + r + '=0,0,J' + r + '/I' + r + ')'),
        sumif('G', label, 'R'), f('IF(E' + r + '=0,0,L' + r + '/(E' + r + '*' + nM + '))'),
        sumif('G', label, 'W'), sumif('G', label, 'X'), sumif('G', label, 'Z'), sumif('G', label, 'AA')]);
      row.getCell(11).numFmt = '0.0%';
      row.getCell(13).numFmt = '0.0%';
    });
    {
      const r = ws.rowCount + 1, last = r - 1;
      const sum = c => f('SUM(' + c + '2:' + c + last + ')');
      const row = ws.addRow(['District total', '', '', '', sum('E'), sum('F'), sum('G'), sum('H'), sum('I'), sum('J'),
        f('IF(I' + r + '=0,0,J' + r + '/I' + r + ')'), sum('L'), f('IF(E' + r + '=0,0,L' + r + '/(E' + r + '*' + nM + '))'),
        sum('N'), sum('O'), sum('P'), sum('Q')]);
      row.getCell(11).numFmt = '0.0%';
      row.getCell(13).numFmt = '0.0%';
      row.eachCell(cell => { cell.font = BOLD_FONT; });
      const multi = roster.filter(u => String(u.sc || '').indexOf(',') >= 0);
      const nosec = roster.filter(u => !u.sc);
      ws.addRow([]);
      ws.addRow(['Rows match on the Sector label in Staff Summary. Not included above: ' + multi.length + ' supervisors holding several sectors (' +
        multi.map(u => u.n).join(', ') + ') and ' + nosec.length + ' person(s) with no sector (' + nosec.map(u => u.id).join(', ') +
        '). Possible person-days = staff x ' + nW + ' operational days since go-live; the from-22-Aug rate uses ' + nM + ' operational days.']);
    }

    // ======================================================= Centre Summary
    ws = sheet(wb, 'Centre Summary', ['Project', 'Sector', 'Centre ID', 'Centre', 'Staff on rolls', 'Never marked', 'Stopped marking',
      'Possible person-days (go-live)', 'Person-days marked (go-live)', 'Attendance % (go-live)', 'Late IN', 'IN outside geofence',
      'Daily returns filed (days)', 'Last return date'], [13, 18, 9, 26, 9, 9, 9, 12, 12, 11, 8, 10, 11, 12]);
    const awcIds = Object.keys(names.awcs).sort((a, b) => {
      const ka = [sectorProj[awcSector(a)] || '', awcSector(a), awcName(a)], kb = [sectorProj[awcSector(b)] || '', awcSector(b), awcName(b)];
      for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
      return 0;
    });
    awcIds.forEach(aid => {
      const r = ws.rowCount + 1;
      const rd = (rptDaysByAwc[aid] || []).slice().sort();
      const row = ws.addRow([projName[sectorProj[awcSector(aid)]] || '', sectorName(awcSector(aid)), aid, awcName(aid),
        f('COUNTIF(' + crit('H', aid) + ')'), countifs('H', aid, 'J', 'Never marked'), countifs('H', aid, 'J', 'Stopped*'),
        sumif('H', aid, 'N'), sumif('H', aid, 'O'), f('IF(H' + r + '=0,0,I' + r + '/H' + r + ')'),
        sumif('H', aid, 'W'), sumif('H', aid, 'X'), rd.length, rd.length ? rd[rd.length - 1] : '']);
      row.getCell(10).numFmt = '0.0%';
    });
    filter(ws, 14);
    const CENTRE_LAST = ws.rowCount;

    // ======================================================== Daily Returns
    ws = sheet(wb, 'Daily Returns', ['Date', 'Day', 'Holiday', 'Centres filing return', 'Children fed', 'Pregnant / lactating', 'Others',
      'Meals served', 'Eggs used', 'Rice used (kg)', 'Pulses used (kg)', 'Balamrutham used (ml)', 'Balamrutham+ used (ml)', 'Milk used (ml)'],
    [12, 6, 22, 11, 11, 11, 9, 10, 10, 11, 11, 12, 12, 11]);
    days.forEach(ds => {
      const v = rptDistrict[ds];
      if (!v) return;
      const st = v.st || {};
      const used = k => (st[k] || [0, 0, 0, 0])[1];
      ws.addRow([ds, dow(ds), holidayName(ds), v.awcs || 0, v.c || 0, v.p || 0, v.o || 0, v.m || 0,
        used('eggs'), used('rice'), used('pulses'), used('bal'), used('balp'), used('milk')]);
    });
    {
      const last = ws.rowCount;
      const row = ws.addRow(['Total', '', '', f('MAX(D2:D' + last + ')')].concat([5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map(c => f('SUM(' + col(c) + '2:' + col(c) + last + ')'))));
      row.eachCell(cell => { cell.font = BOLD_FONT; });
      ws.addRow(['Totals: "Centres filing return" shows the best single day; the other columns are sums over the period. Returns exist from 16 Aug 2026 (feature release).']);
    }

    // ========================================================= Flag Counts
    ws = sheet(wb, 'Flag Counts', ['Flag', 'Meaning'].concat(months).concat(['Total']), [22, 52].concat(months.map(() => 10)).concat([9]));
    Object.keys(flagCounts).sort().forEach(k => {
      const r = ws.rowCount + 1;
      ws.addRow([k, k === 'OUTSIDE_GEOFENCE' ? 'Marked outside the centre geofence (>300 m, accuracy <=250 m)' : (FLAG_TEXT[k] || k)]
        .concat(months.map(ym => flagCounts[k][ym] || 0)).concat([f('SUM(C' + r + ':' + col(2 + months.length) + r + ')')]));
    });

    // ======================================================= Flagged Marks
    ws = sheet(wb, 'Flagged Marks', ['Date', 'User ID', 'Name', 'Cadre', 'Project', 'Sector', 'Centre', 'IN / OUT', 'Time',
      'Geofence', 'Distance (m)', 'Flags', 'Remark'], [12, 9, 28, 7, 13, 18, 24, 8, 7, 12, 10, 26, 60]);
    flaggedRows.sort((a, b) => { for (const i of [0, 5, 2, 7]) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; });
    ws.addRows(flaggedRows);
    filter(ws, 13);

    // ============================================================== Leaves
    ws = sheet(wb, 'Leaves', ['Date', 'User ID', 'Name', 'Cadre', 'Project', 'Sector', 'Centre', 'Leave type'], [12, 9, 28, 7, 13, 18, 24, 16]);
    const lrows = [];
    roster.forEach(u => {
      Object.keys(leaves[u.id] || {}).forEach(ds => {
        lrows.push([ds, u.id, u.n, cadre(u), projName[u.pj] || u.pj || '', secLabel(u.sc), awcName(u.a), LEAVE_LABEL[leaves[u.id][ds]] || leaves[u.id][ds]]);
      });
    });
    lrows.sort((a, b) => (a[0] + a[1]) < (b[0] + b[1]) ? -1 : 1);
    ws.addRows(lrows);
    filter(ws, 8);

    // =========================================================== Registers
    months.forEach(ym => {
      const y = Number(ym.slice(0, 4)), mo = Number(ym.slice(5, 7));
      const dim = new Date(y, mo, 0).getDate();
      const dds = [];
      for (let d = 1; d <= dim; d++) dds.push(String(d).padStart(2, '0'));
      const firstCol = 7, lastCol = firstCol + dim - 1;
      ws = sheet(wb, 'Register ' + ym,
        ['S.No', 'User ID', 'Name', 'Cadre', 'Sector', 'Centre'].concat(dds.map(d => String(Number(d)))).concat(['Present (P+I+O)', 'Absent (A)', 'Leave (L)']),
        [5, 8, 26, 6, 16, 22].concat(dds.map(() => 3.2)).concat([9, 8, 8]),
        { xSplit: 6, ySplit: 2, legend: 'Legend: P = IN and OUT, I = IN only, O = OUT only, L = on leave, H = holiday, A = not marked, ' +
          '- = district not operating that day (rollout / break, not counted), blank = before go-live / after ' + endDate +
          '. Working days this month: ' + (wdByMonth[ym] || 0) + ', of which operational: ' + (odByMonth[ym] || 0) });
      roster.forEach((u, i) => {
        const cells = dds.map(dd => {
          const ds = ym + '-' + dd;
          if (ds < GO_LIVE || ds > endDate) return '';
          const rec = (marks[u.id] || {})[ds] || {};
          const hi = live(rec.IN), ho = live(rec.OUT);
          if (hi && ho) return 'P';
          if (hi) return 'I';
          if (ho) return 'O';
          if ((leaves[u.id] || {})[ds]) return 'L';
          if (holidayName(ds)) return 'H';
          if (!opSet[ds]) return '-';
          return 'A';
        });
        const r = ws.rowCount + 1;
        const rng = col(firstCol) + r + ':' + col(lastCol) + r;
        const row = ws.addRow([i + 1, u.id, u.n, cadre(u), secLabel(u.sc), awcName(u.a)].concat(cells).concat([
          f('COUNTIF(' + rng + ',"P")+COUNTIF(' + rng + ',"I")+COUNTIF(' + rng + ',"O")'),
          f('COUNTIF(' + rng + ',"A")'), f('COUNTIF(' + rng + ',"L")')]));
        cells.forEach((v, k) => {
          const c = row.getCell(firstCol + k);
          c.alignment = CENTER;
          if (v === 'A') c.fill = RED;
          else if (v === 'H') c.fill = GREY;
          else if (v === 'L') c.fill = AMBER;
          else if (v === 'P') c.fill = GREEN;
        });
      });
    });

    // ============================================================= Summary (first sheet)
    ws = summaryWs;
    ws.getColumn(1).width = 58;
    ws.getColumn(2).width = 100;
    const gen = new Date();
    const lines = [
      ['Jangaon District - Sisu Mahila Samridhi attendance: all-time report', ''],
      ['Period', GO_LIVE + ' (go-live) to ' + endDate + ' (last nightly summary; later marks are not yet published)'],
      ['Generated from the console', ymd(gen) + ' ' + gen.toTimeString().slice(0, 5) + ' by ' + ((ctx.me && ctx.me.name) || 'admin')],
      ['', ''],
      ['rolls', 'Staff on rolls (active field staff and supervisors in the Users sheet)', f('COUNTA(' + SS + 'B2:B' + STAFF_LAST + ')')],
      ['  of which AWT', f('COUNTIF(' + SS + 'D2:D' + STAFF_LAST + ',"AWT")')],
      ['  of which AWH', f('COUNTIF(' + SS + 'D2:D' + STAFF_LAST + ',"AWH")')],
      ['  of which Supervisors', f('COUNTIF(' + SS + 'D2:D' + STAFF_LAST + ',"SUP")')],
      ['never', 'NEVER marked attendance since go-live', f('COUNTIF(' + SS + 'J2:J' + STAFF_LAST + ',"Never marked")')],
      ['Marked at least once', f('COUNTIF(' + SS + 'K2:K' + STAFF_LAST + ',"Yes")')],
      ['Stopped marking (marked before, but not on any of the last ' + STOPPED_OPDAYS + ' operational days)', f('COUNTIF(' + SS + 'J2:J' + STAFF_LAST + ',"Stopped*")')],
      ['Active (marked on at least one of the last ' + STOPPED_OPDAYS + ' operational days)', f('COUNTIF(' + SS + 'J2:J' + STAFF_LAST + ',"Active")')],
      ['', ''],
      ['Working days since go-live (holidays and Sundays excluded)', working.length],
      ['wd', 'Operational days since go-live (working days with ' + minMarks + '+ marks district-wide)', nW],
      ['wdf', 'Operational days from 22-Aug (full rollout)', nM],
      ['Working days when the district was NOT operating (excluded from every rate)', nonOp.join(', ')],
      ['Person-days marked on any day (incl. holidays and breaks)', f('SUM(' + SS + anyCol + '2:' + anyCol + STAFF_LAST + ')')],
      ['pd', 'Person-days marked on operational days since go-live', f('SUM(' + SS + 'O2:O' + STAFF_LAST + ')')],
      ['pct', 'District attendance % since go-live', '{wd}|{pd}|{rolls}'],
      ['pdf', 'Person-days marked from 22-Aug', f('SUM(' + SS + 'R2:R' + STAFF_LAST + ')')],
      ['pctf', 'District attendance % from 22-Aug', '{wdf}|{pdf}|{rolls}'],
      ['Late IN marks (after the schedule late-after time)', f('SUM(' + SS + 'W2:W' + STAFF_LAST + ')')],
      ['IN marks outside the centre geofence', f('SUM(' + SS + 'X2:X' + STAFF_LAST + ')')],
      ['IN marks with unverifiable location (no usable GPS fix / centre has no coordinates)', f('SUM(' + SS + 'Y2:Y' + STAFF_LAST + ')')],
      ['Flagged marks (any quality flag or outside geofence)', f('SUM(' + SS + 'Z2:Z' + STAFF_LAST + ')')],
      ['Leave days recorded', f('SUM(' + SS + 'AA2:AA' + STAFF_LAST + ')')],
      ['Daily centre returns filed (centre-days)', f('SUM(\'Centre Summary\'!M2:M' + CENTRE_LAST + ')')],
      ['', ''],
      ['Sheets', ''],
      ['Never Marked', 'Everyone on the rolls with no IN or OUT mark on any day since go-live, with supervisor and centre.'],
      ['Stopped Marking', 'Marked before, but on none of the last ' + STOPPED_OPDAYS + ' operational days; first and last mark shown.'],
      ['Staff Summary', 'One row per person: status, first/last mark, days marked, attendance %, late, geofence, flags, leave, per-month days.'],
      ['Daily Trend', 'District totals for every calendar day since go-live.'],
      ['Sector Summary / Centre Summary', 'Roll-ups computed by formula from Staff Summary.'],
      ['Daily Returns', 'Beneficiary and stock returns filed by centres, per day.'],
      ['Flag Counts / Flagged Marks', 'Data-quality flags by month, and every flagged mark with a plain-language remark.'],
      ['Leaves', 'Every leave day recorded, by person.'],
      ['Register <month>', 'Person x day grid: P / I / O / L / H / A.'],
      ['', ''],
      ['Data sources', '']
    ].concat(months.map(ym => ['  ' + ym + ' marks', sources[ym]])).concat([
      ['  Rolls', 'Live Users sheet via the console name map: role FIELD or SUPERVISOR, status ACTIVE.'],
      ['', ''],
      ['Caveats', ''],
      ['1', 'Admin and test accounts are excluded. Someone deactivated in the Users sheet no longer appears, even if they marked earlier.'],
      ['2', '"Registered" on Never Marked means the person completed first login (set a PIN) in the app.'],
      ['3', '"Late" = IN after the schedule late-after time. Geofence OUTSIDE = beyond 300 m with GPS accuracy <= 250 m; UNVERIFIED is never counted as outside.'],
      ['4', '8-21 Aug 2026 was the onboarding period; the "from 22-Aug" columns give the fair attendance rate.'],
      ['5', 'Operational-day rule: a working day on which fewer than ' + Math.round(OP_SHARE * 100) + '% of the rolls marked district-wide (rollout days, the Dasara break) is not held against anyone and does not count in attendance % or in "stopped marking".']
    ]);
    const keyrow = {};
    lines.forEach(l => {
      if (l.length === 3) { keyrow[l[0]] = ws.rowCount + 1; l = l.slice(1); }
      const row = ws.addRow(l);
      row.getCell(1).font = BOLD_FONT;
      row.getCell(2).font = BODY_FONT;
      row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    });
    ws.getCell('A1').font = { name: FONT, bold: true, size: 14 };
    [['pct', 'wd', 'pd'], ['pctf', 'wdf', 'pdf']].forEach(([k, w, p]) => {
      const c = ws.getCell('B' + keyrow[k]);
      c.value = f('IF(B' + keyrow[w] + '=0,0,B' + keyrow[p] + '/(B' + keyrow.rolls + '*B' + keyrow[w] + '))');
      c.numFmt = '0.0%';
    });
    ws.getCell('B' + keyrow.never).fill = RED;

    say('Writing file…');
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'Jangaon-attendance-all-time-' + GO_LIVE + '-to-' + endDate + '.xlsx';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    return { rolls: roster.length, never: never.length, stopped: stopped.length, opDays: nW, endDate };
  }

  return { build };
})();
