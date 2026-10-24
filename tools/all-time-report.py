# -*- coding: utf-8 -*-
"""All-time attendance report workbook, from go-live to the latest summary.

    python tools/all-time-report.py

Writes docs/report/Jangaon-attendance-all-time-<from>-to-<to>.xlsx (gitignored:
it names every worker).

Sources, all already on this machine - nothing is typed in by hand:
  summary/month/*.json              current month, per sector, every mark per person per day
  summary/archive/<ym>/*.json       frozen earlier months (archive began 2026-10-01)
  git history of summary/month/     months older than the archive (August 2026) are read
                                    from the last nightly commit of that month
  summary/reports/<ym>.json         daily beneficiary returns per centre
  summary/org.json                  projects, sectors, centres, schedule (late_after)
  master-data/IMPORT_USERS.csv      field staff register (AWT / AWH)
  backend/Maintenance.gs            supervisor roster (importSupervisors data, ids U2003+)

Sheets: Summary, Never Marked, Staff Summary, Daily Trend, Sector Summary,
Centre Summary, Daily Returns, Flag Counts, Flagged Marks, Leaves,
Register <month> (one per month).
"""
import csv
import datetime as dt
import io
import json
import os
import re
import subprocess

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill, Border, Side
from openpyxl.utils import get_column_letter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'docs', 'report')
GO_LIVE = '2026-08-08'          # first marks in the system
ROLLOUT_END = '2026-08-21'      # 8-21 Aug = onboarding; full rollout from 22 Aug
# A working day only counts against a worker when the district was actually
# operating: at least this share of the rolls marked district-wide. This drops
# rollout days and de-facto breaks that are not in the Holidays sheet (e.g. the
# Dasara break of 10-21 Oct 2026, when fewer than 80 of 1,180 staff marked).
OPERATIONAL_MIN_SHARE = 0.10
STOPPED_AFTER_OPDAYS = 10       # no mark in the last N operational days = "stopped marking"
FIRST_SUP_ID = 2003             # importSupervisors() assigns U2003.. in array order

FLAG_TEXT = {
    'NO_PHOTO': 'no photo captured', 'NO_GPS': 'no GPS captured',
    'LATE_SYNC': 'synced more than a day late', 'CLOCK_SKEW': 'phone clock wrong by 5+ minutes',
    'PERFECT_ACCURACY': 'GPS accuracy suspiciously perfect',
    'AT_CENTER_EXACT': 'exactly on the stored centre point',
    'REPEAT_COORDS': 'same coordinates as the previous mark',
    'REPEAT_COORDS_5D': 'identical coordinates 5 days in a row',
    'IMPOSSIBLE_VELOCITY': 'impossible travel speed between marks',
    'FAKE_GPS_SUSPECT': 'possible fake-GPS app', 'OFFLINE_SYNC': 'marked offline, sent later',
    'EARLY_OUT': 'OUT marked before 4:00 PM', 'NO_REPORT_AT_OUT': 'OUT without the daily centre report',
    'OLD_APP': 'outdated app build', 'PHOTO_DARK': 'photo too dark', 'PHOTO_FLAT': 'photo has no detail',
    'UPLOAD_FAILED': 'photo upload failed',
}
LEAVE_LABEL = {'CASUAL': 'Casual Leave', 'EARNED': 'Earned Leave',
               'OPTIONAL': 'Optional Holiday', 'SICK': 'Medical Leave'}

FONT = 'Arial'
HEAD_FILL = PatternFill('solid', fgColor='0B5C4F')
ALT_FILL = PatternFill('solid', fgColor='F3F7F6')
RED_FILL = PatternFill('solid', fgColor='FDE2E1')
AMBER_FILL = PatternFill('solid', fgColor='FFF3CD')
GREEN_FILL = PatternFill('solid', fgColor='E3F4EA')
GREY_FILL = PatternFill('solid', fgColor='EDEDED')
THIN = Side(style='thin', color='D0D7D5')


def jload(path):
    with io.open(path, encoding='utf-8') as f:
        return json.load(f)


def git(*args):
    return subprocess.run(['git'] + list(args), cwd=ROOT, capture_output=True,
                          text=True, encoding='utf-8', errors='replace').stdout


def months_between(a, b):
    y, m = int(a[:4]), int(a[5:7])
    out = []
    while '%04d-%02d' % (y, m) <= b:
        out.append('%04d-%02d' % (y, m))
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


def load_month(ym, current):
    """Return list of per-sector JSON docs for a month, from the best source.

    Only docs whose own `ym` matches are kept: summary/month/ can hold stale
    files for sector codes that are no longer published (e.g. a supervisor's
    combined 'S21,S26,S27.json' from August), and their holidays and marks
    must not leak into another month."""
    def load_dir(d):
        docs = [jload(os.path.join(d, f)) for f in os.listdir(d) if f.endswith('.json')]
        return [x for x in docs if x.get('ym') == ym]
    if ym == current:
        return load_dir(os.path.join(ROOT, 'summary', 'month')), 'summary/month (live)'
    d = os.path.join(ROOT, 'summary', 'archive', ym)
    if os.path.isdir(d):
        return load_dir(d), 'summary/archive/' + ym
    # Older than the archive: last commit whose month files carried this ym.
    for h in git('log', '--format=%h', '--', 'summary/month/S01.json').split():
        try:
            probe = json.loads(git('show', h + ':summary/month/S01.json'))
        except ValueError:
            continue
        if probe.get('ym') == ym:
            names = git('ls-tree', '--name-only', h, 'summary/month/').split('\n')
            docs = []
            for n in names:
                if n.endswith('.json'):
                    docs.append(json.loads(git('show', h + ':' + n)))
            return docs, 'git commit %s (%s)' % (h, probe.get('generatedAt', ''))
        if probe.get('ym', '') < ym:
            break
    raise SystemExit('No data found for month ' + ym)


def supervisors_from_source():
    """Parse the embedded importSupervisors() table: [phone, name, project, 'S01,S05']."""
    src = io.open(os.path.join(ROOT, 'backend', 'Maintenance.gs'), encoding='utf-8').read()
    m = re.search(r'function importSupervisors\b.*?\n\}', src, re.S)
    if not m:
        raise SystemExit('importSupervisors() not found in backend/Maintenance.gs')
    rows = re.findall(r"\['(\d{10})',\s*'([^']+)',\s*'([A-Z]{3})',\s*'([S0-9,]+)'\]", m.group(0))
    if len(rows) < 10:
        raise SystemExit('supervisor table parse failed (%d rows)' % len(rows))
    out = {}
    for i, (phone, name, proj, sects) in enumerate(rows):
        uid = 'U%04d' % (FIRST_SUP_ID + i)
        out[uid] = {'user_id': uid, 'phone': phone, 'name': name, 'cadre': 'SUP',
                    'project_code': proj, 'sector_code': sects, 'awc_id': ''}
    return out


def hm_gt(a, b):
    return bool(a) and bool(b) and str(a) > str(b)


def style_header(ws, row=1):
    for c in ws[row]:
        c.font = Font(name=FONT, bold=True, color='FFFFFF', size=10)
        c.fill = HEAD_FILL
        c.alignment = Alignment(vertical='center', wrap_text=True, horizontal='center')
    ws.row_dimensions[row].height = 32


def finish(ws, widths, freeze='A2', filt=True, header_row=1):
    style_header(ws, header_row)
    for n, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(n)].width = w
    ws.freeze_panes = freeze
    if filt and ws.max_row > header_row:
        ws.auto_filter.ref = 'A%d:%s%d' % (header_row, get_column_letter(ws.max_column), ws.max_row)
    for row in ws.iter_rows(min_row=header_row + 1):
        for c in row:
            if c.font.name != FONT:
                c.font = Font(name=FONT, size=10, bold=c.font.bold, color=c.font.color)


def main():
    meta = jload(os.path.join(ROOT, 'summary', 'meta.json'))
    org = jload(os.path.join(ROOT, 'summary', 'org.json'))
    cur_ym = meta['month']
    months = months_between(GO_LIVE[:7], cur_ym)

    proj_name = {p['code']: p['name'] for p in org['projects']}
    sector_name = {s['code']: s['name'] for s in org['sectors']}
    sector_proj = {s['code']: s['project'] for s in org['sectors']}
    awc_name = {k: v['n'] for k, v in org['awcs'].items()}
    sch = next((s for s in org['schedules'] if s['project_code'] == 'ALL'), org['schedules'][0])
    late_after = sch['late_after']

    # ----------------------------------------------------------------- roster
    users = {}
    with io.open(os.path.join(ROOT, 'master-data', 'IMPORT_USERS.csv'), encoding='utf-8-sig') as f:
        for r in csv.DictReader(f):
            if r.get('user_id'):
                users[r['user_id']] = r
    sups = supervisors_from_source()
    users.update(sups)
    sup_of_sector = {}
    for u in sups.values():
        for sc in u['sector_code'].split(','):
            sup_of_sector[sc] = u['name']

    # ------------------------------------------------------------------ marks
    marks, leaves, holidays, sources = {}, {}, {}, {}
    end_date = GO_LIVE
    for ym in months:
        docs, src = load_month(ym, cur_ym)
        sources[ym] = src
        holidays[ym] = {}
        for d in docs:
            # The month files are rebuilt nightly; the period ends on the last
            # day they cover, so a half-day of marks never reads as absence.
            if ym == cur_ym:
                end_date = max(end_date, str(d.get('generatedAt', ''))[:10])
            holidays[ym].update(d.get('holidays') or {})
            for uid, days in (d.get('users') or {}).items():
                for dd, rec in days.items():
                    marks.setdefault(uid, {})[ym + '-' + dd] = rec
            for uid, days in (d.get('leaves') or {}).items():
                for dd, typ in days.items():
                    leaves.setdefault(uid, {})[ym + '-' + dd] = typ

    # Ids that marked but are not on the register: hand-added rows in the live
    # Users sheet (e.g. U1162) are kept and named as such; admin/test ids are not staff.
    NON_STAFF = re.compile(r'^U(2000|2001|2002|2099|99\d\d)$')
    for uid in sorted(set(marks) | set(leaves)):
        if uid in users or NON_STAFF.match(uid):
            continue
        any_rec = next(iter(marks.get(uid, {}).values()), None)
        users[uid] = {'user_id': uid, 'phone': '', 'name': '(added in live sheet - not in register export)',
                      'cadre': '', 'project_code': '', 'sector_code': '', 'awc_id': ''}
    for uid in [u for u in list(marks) if NON_STAFF.match(u)]:
        marks.pop(uid, None)
        leaves.pop(uid, None)

    # ------------------------------------------------------------ calendar
    today = dt.date.fromisoformat(end_date)
    all_days = []
    d = dt.date.fromisoformat(GO_LIVE)
    while d <= today:
        all_days.append(d.isoformat())
        d += dt.timedelta(days=1)

    def is_holiday(ds):
        return ds[8:] in holidays.get(ds[:7], {})

    def holiday_name(ds):
        return holidays.get(ds[:7], {}).get(ds[8:], '')

    marks_per_day = {}
    for uid, days in marks.items():
        for ds, rec in days.items():
            if rec.get('IN') or rec.get('OUT'):
                marks_per_day[ds] = marks_per_day.get(ds, 0) + 1

    OPERATIONAL_MIN_MARKS = int(round(OPERATIONAL_MIN_SHARE * len(users)))

    def is_operational(ds):
        return not is_holiday(ds) and marks_per_day.get(ds, 0) >= OPERATIONAL_MIN_MARKS

    working = [ds for ds in all_days if not is_holiday(ds)]
    operational = [ds for ds in working if is_operational(ds)]
    operational_full = [ds for ds in operational if ds > ROLLOUT_END]
    op_set = set(operational)
    op_set_full = set(operational_full)
    recent_ops = set(operational[-STOPPED_AFTER_OPDAYS:])
    wd_by_month = {ym: sum(1 for ds in working if ds[:7] == ym) for ym in months}
    od_by_month = {ym: sum(1 for ds in operational if ds[:7] == ym) for ym in months}
    non_op_working = [ds for ds in working if ds not in op_set]

    # ---------------------------------------------------------- per person
    def person_stats(uid):
        m = marks.get(uid, {})
        lv = leaves.get(uid, {})
        s = {'in': 0, 'out': 0, 'both': 0, 'late': 0, 'outside': 0, 'unver': 0, 'flagged': 0,
             'marked_days': 0, 'marked_op': 0, 'marked_full': 0, 'first': '', 'last': '', 'leave': len(lv)}
        per_month = {ym: 0 for ym in months}
        for ds in sorted(m):
            rec = m[ds]
            i, o = rec.get('IN'), rec.get('OUT')
            if not (i or o):
                continue
            s['marked_days'] += 1
            if ds in op_set:
                s['marked_op'] += 1
            if ds in op_set_full:
                s['marked_full'] += 1
            per_month[ds[:7]] = per_month.get(ds[:7], 0) + 1
            s['first'] = s['first'] or ds
            s['last'] = ds
            if i:
                s['in'] += 1
                if hm_gt(i.get('t'), late_after):
                    s['late'] += 1
                if i.get('gf') == 'OUTSIDE':
                    s['outside'] += 1
                if i.get('gf') == 'UNVERIFIED':
                    s['unver'] += 1
            if o:
                s['out'] += 1
            if i and o:
                s['both'] += 1
            for r in (i, o):
                if r and (r.get('fl') or r.get('gf') == 'OUTSIDE'):
                    s['flagged'] += 1
        s['per_month'] = per_month
        if not s['marked_days']:
            s['status'] = 'Never marked'
        elif not any(ds in recent_ops for ds in m if m[ds].get('IN') or m[ds].get('OUT')):
            s['status'] = 'Stopped marking'
        else:
            s['status'] = 'Active'
        return s

    def sector_label(sc):
        return ', '.join(sector_name.get(x, x) for x in str(sc).split(',') if x)

    def sort_key(u):
        return (u.get('project_code') or 'zz', str(u.get('sector_code') or 'zz'),
                awc_name.get(u.get('awc_id'), u.get('awc_id') or 'zz'), u.get('name') or '')

    roster = sorted(users.values(), key=sort_key)
    stats = {u['user_id']: person_stats(u['user_id']) for u in roster}

    wb = Workbook()

    # ========================================================== Staff Summary
    ws = wb.active
    ws.title = 'Staff Summary'
    hdr = ['S.No', 'User ID', 'Name', 'Cadre', 'Phone', 'Project', 'Sector', 'Centre ID', 'Centre',
           'Status', 'Ever marked', 'First mark', 'Last mark',
           'Operational days since go-live', 'Days marked on operational days (go-live)', 'Attendance % (go-live)',
           'Operational days from 22-Aug', 'Days marked on operational days (from 22-Aug)', 'Attendance % (from 22-Aug)',
           'Days IN', 'Days OUT', 'Days IN+OUT', 'Late IN (after %s)' % late_after,
           'IN outside geofence', 'IN location unverified', 'Flagged marks', 'Leave days']
    hdr += ['Days marked %s (any day)' % ym for ym in months]
    hdr += ['Days marked total (any day, incl. holidays and breaks)']
    ws.append(hdr)
    nW, nM = len(operational), len(operational_full)
    for n, u in enumerate(roster, 1):
        s = stats[u['user_id']]
        r = n + 1
        row = [n, u['user_id'], u.get('name', ''), u.get('cadre', ''), u.get('phone', ''),
               proj_name.get(u.get('project_code'), u.get('project_code', '')),
               sector_label(u.get('sector_code', '')), u.get('awc_id', ''),
               awc_name.get(u.get('awc_id'), u.get('awc_id') or ('All sector centres' if u.get('cadre') == 'SUP' else '')),
               s['status'], 'Yes' if s['marked_days'] else 'No', s['first'], s['last'],
               nW, s['marked_op'], '=IF(N%d=0,0,O%d/N%d)' % (r, r, r),
               nM, s['marked_full'], '=IF(Q%d=0,0,R%d/Q%d)' % (r, r, r),
               s['in'], s['out'], s['both'], s['late'], s['outside'], s['unver'], s['flagged'], s['leave']]
        row += [s['per_month'][ym] for ym in months]
        row += [s['marked_days']]
        ws.append(row)
        ws.cell(row=r, column=16).number_format = '0.0%'
        ws.cell(row=r, column=19).number_format = '0.0%'
        fill = RED_FILL if s['status'] == 'Never marked' else (AMBER_FILL if s['status'].startswith('Stopped') else None)
        if fill:
            ws.cell(row=r, column=10).fill = fill
    finish(ws, [6, 9, 28, 7, 12, 13, 18, 9, 24, 24, 8, 11, 11, 10, 10, 11, 10, 10, 11, 8, 8, 9, 10, 10, 10, 9, 8] + [11] * len(months) + [12], freeze='D2')
    STAFF_LAST = ws.max_row

    # ============================================================ Never Marked
    ws = wb.create_sheet('Never Marked', 0)
    ws.append(['S.No', 'User ID', 'Name', 'Cadre', 'Phone', 'Project', 'Sector', 'Supervisor', 'Centre',
               'Leave days recorded', 'Note'])
    n = 0
    for u in roster:
        s = stats[u['user_id']]
        if s['marked_days']:
            continue
        n += 1
        note = ''
        if u.get('cadre') == 'SUP':
            note = 'Supervisor'
        elif not u.get('project_code'):
            note = 'Not in register export'
        ws.append([n, u['user_id'], u.get('name', ''), u.get('cadre', ''), u.get('phone', ''),
                   proj_name.get(u.get('project_code'), u.get('project_code', '')),
                   sector_label(u.get('sector_code', '')),
                   sup_of_sector.get(str(u.get('sector_code', '')).split(',')[0], ''),
                   awc_name.get(u.get('awc_id'), u.get('awc_id', '')), s['leave'], note])
    finish(ws, [6, 9, 28, 7, 12, 13, 18, 22, 26, 10, 24])
    NEVER_COUNT = n

    # ========================================================== Stopped Marking
    ws = wb.create_sheet('Stopped Marking', 1)
    ws.append(['S.No', 'User ID', 'Name', 'Cadre', 'Phone', 'Project', 'Sector', 'Supervisor', 'Centre',
               'First mark', 'Last mark', 'Days marked (any day)', 'Operational days missed since last mark'])
    n = 0
    for u in roster:
        s = stats[u['user_id']]
        if s['status'] != 'Stopped marking':
            continue
        n += 1
        ws.append([n, u['user_id'], u.get('name', ''), u.get('cadre', ''), u.get('phone', ''),
                   proj_name.get(u.get('project_code'), u.get('project_code', '')),
                   sector_label(u.get('sector_code', '')),
                   sup_of_sector.get(str(u.get('sector_code', '')).split(',')[0], ''),
                   awc_name.get(u.get('awc_id'), u.get('awc_id', '')), s['first'], s['last'], s['marked_days'],
                   sum(1 for ds in operational if ds > s['last'])])
    finish(ws, [6, 9, 28, 7, 12, 13, 18, 22, 26, 11, 11, 10, 12])

    # ============================================================= Daily Trend
    ws = wb.create_sheet('Daily Trend')
    ws.append(['Date', 'Day', 'Holiday', 'Operational day (%d+ marks)' % OPERATIONAL_MIN_MARKS,
               'Staff on rolls', 'Marked (IN or OUT)', 'IN', 'OUT', 'IN+OUT',
               'Late IN', 'IN outside geofence', 'IN unverified', 'On leave', 'Not marked', 'Marked %'])
    roster_n = len(roster)
    for ds in all_days:
        c = {'m': 0, 'in': 0, 'out': 0, 'both': 0, 'late': 0, 'outside': 0, 'unver': 0, 'leave': 0}
        for u in roster:
            uid = u['user_id']
            rec = marks.get(uid, {}).get(ds) or {}
            i, o = rec.get('IN'), rec.get('OUT')
            if ds in leaves.get(uid, {}):
                c['leave'] += 1
            if i or o:
                c['m'] += 1
            if i:
                c['in'] += 1
                c['late'] += hm_gt(i.get('t'), late_after)
                c['outside'] += i.get('gf') == 'OUTSIDE'
                c['unver'] += i.get('gf') == 'UNVERIFIED'
            if o:
                c['out'] += 1
            if i and o:
                c['both'] += 1
        r = ws.max_row + 1
        ws.append([ds, dt.date.fromisoformat(ds).strftime('%a'), holiday_name(ds),
                   'Yes' if is_operational(ds) else 'No', roster_n, c['m'], c['in'], c['out'],
                   c['both'], c['late'], c['outside'], c['unver'], c['leave'],
                   '=E%d-F%d-M%d' % (r, r, r), '=IF(E%d=0,0,F%d/E%d)' % (r, r, r)])
        ws.cell(row=r, column=15).number_format = '0.0%'
        if holiday_name(ds):
            for cc in ws[r]:
                cc.fill = GREY_FILL
        elif not is_operational(ds):
            for cc in ws[r]:
                cc.fill = AMBER_FILL
    finish(ws, [12, 6, 26, 11, 10, 12, 8, 8, 9, 9, 12, 11, 9, 11, 10])

    # =========================================================== Sector Summary
    ws = wb.create_sheet('Sector Summary')
    ws.append(['Project', 'Sector code', 'Sector', 'Supervisor', 'Staff on rolls', 'Never marked', 'Stopped marking',
               'Active', 'Possible person-days (go-live)', 'Person-days marked (go-live)', 'Attendance % (go-live)',
               'Person-days marked from 22-Aug', 'Attendance % (from 22-Aug)', 'Late IN', 'IN outside geofence',
               'Flagged marks', 'Leave days'])
    SS = "'Staff Summary'!"
    for s in org['sectors']:
        r = ws.max_row + 1
        sc = s['code']
        crit = SS + '$G$2:$G$%d,"%s"' % (STAFF_LAST, sector_name.get(sc, sc))
        # Supervisors carry a comma list of sectors; they are counted under their first sector only
        # (their row's Sector cell reads "A, B"), so sector totals here are field staff + any
        # supervisor whose label matches exactly.
        ws.append([proj_name.get(s['project'], s['project']), sc, s['name'], sup_of_sector.get(sc, ''),
                   '=COUNTIF(%s)' % crit,
                   '=COUNTIFS(%s,%s$J$2:$J$%d,"Never marked")' % (crit, SS, STAFF_LAST),
                   '=COUNTIFS(%s,%s$J$2:$J$%d,"Stopped*")' % (crit, SS, STAFF_LAST),
                   '=COUNTIFS(%s,%s$J$2:$J$%d,"Active")' % (crit, SS, STAFF_LAST),
                   '=SUMIF(%s,%s$N$2:$N$%d)' % (crit, SS, STAFF_LAST),
                   '=SUMIF(%s,%s$O$2:$O$%d)' % (crit, SS, STAFF_LAST),
                   '=IF(I%d=0,0,J%d/I%d)' % (r, r, r),
                   '=SUMIF(%s,%s$R$2:$R$%d)' % (crit, SS, STAFF_LAST),
                   '=IF(E%d=0,0,L%d/(E%d*%d))' % (r, r, r, nM),
                   '=SUMIF(%s,%s$W$2:$W$%d)' % (crit, SS, STAFF_LAST),
                   '=SUMIF(%s,%s$X$2:$X$%d)' % (crit, SS, STAFF_LAST),
                   '=SUMIF(%s,%s$Z$2:$Z$%d)' % (crit, SS, STAFF_LAST),
                   '=SUMIF(%s,%s$AA$2:$AA$%d)' % (crit, SS, STAFF_LAST)])
        ws.cell(row=r, column=11).number_format = '0.0%'
        ws.cell(row=r, column=13).number_format = '0.0%'
    r = ws.max_row + 1
    ws.append(['District total', '', '', '', ] + ['=SUM(%s2:%s%d)' % (get_column_letter(c), get_column_letter(c), r - 1)
                                               for c in range(5, 11)]
              + ['=IF(I%d=0,0,J%d/I%d)' % (r, r, r), '=SUM(L2:L%d)' % (r - 1),
                 '=IF(E%d=0,0,L%d/(E%d*%d))' % (r, r, r, nM)]
              + ['=SUM(%s2:%s%d)' % (get_column_letter(c), get_column_letter(c), r - 1) for c in range(14, 18)])
    ws.cell(row=r, column=11).number_format = '0.0%'
    ws.cell(row=r, column=13).number_format = '0.0%'
    for c in ws[r]:
        c.font = Font(name=FONT, bold=True, size=10)
    multi = [u for u in roster if ',' in str(u.get('sector_code', ''))]
    nosec = [u for u in roster if not u.get('sector_code')]
    ws.cell(row=r + 2, column=1).value = (
        'Rows match on the Sector label in Staff Summary. Not included above: %d supervisors holding '
        'several sectors (%s) and %d person(s) with no sector in the register (%s). '
        'Possible person-days = staff x %d operational days since go-live; the from-22-Aug rate uses %d operational days.'
        % (len(multi), ', '.join(u['name'] for u in multi), len(nosec), ', '.join(u['user_id'] for u in nosec), nW, nM))
    finish(ws, [13, 8, 18, 22, 9, 9, 9, 8, 12, 12, 11, 12, 11, 9, 10, 9, 9], filt=False)

    # ----------------------------------------------------------- daily returns
    rpt_days_by_awc, rpt_district = {}, {}
    rpt_fields = None
    for ym in months:
        p = os.path.join(ROOT, 'summary', 'reports', ym + '.json')
        if not os.path.exists(p):
            continue
        rj = jload(p)
        rpt_fields = rpt_fields or rj.get('fields')
        for aid, v in (rj.get('awcs') or {}).items():
            for dd in (v.get('d') or {}):
                rpt_days_by_awc.setdefault(aid, set()).add(ym + '-' + dd)
        for dd, v in (rj.get('days') or {}).items():
            rpt_district[ym + '-' + dd] = v

    # =========================================================== Centre Summary
    ws = wb.create_sheet('Centre Summary')
    ws.append(['Project', 'Sector', 'Centre ID', 'Centre', 'Staff on rolls', 'Never marked', 'Stopped marking',
               'Possible person-days (go-live)', 'Person-days marked (go-live)', 'Attendance % (go-live)',
               'Late IN', 'IN outside geofence', 'Daily returns filed (days)', 'Last return date'])
    awc_ids = sorted(org['awcs'], key=lambda a: (sector_proj.get(org['awcs'][a]['sc'], ''), org['awcs'][a]['sc'], org['awcs'][a]['n']))
    for aid in awc_ids:
        a = org['awcs'][aid]
        r = ws.max_row + 1
        crit = SS + '$H$2:$H$%d,"%s"' % (STAFF_LAST, aid)
        days = sorted(rpt_days_by_awc.get(aid, ()))
        ws.append([proj_name.get(sector_proj.get(a['sc'], ''), ''), sector_name.get(a['sc'], a['sc']), aid, a['n'],
                   '=COUNTIF(%s)' % crit,
                   '=COUNTIFS(%s,%s$J$2:$J$%d,"Never marked")' % (crit, SS, STAFF_LAST),
                   '=COUNTIFS(%s,%s$J$2:$J$%d,"Stopped*")' % (crit, SS, STAFF_LAST),
                   '=SUMIF(%s,%s$N$2:$N$%d)' % (crit, SS, STAFF_LAST),
                   '=SUMIF(%s,%s$O$2:$O$%d)' % (crit, SS, STAFF_LAST),
                   '=IF(H%d=0,0,I%d/H%d)' % (r, r, r),
                   '=SUMIF(%s,%s$W$2:$W$%d)' % (crit, SS, STAFF_LAST),
                   '=SUMIF(%s,%s$X$2:$X$%d)' % (crit, SS, STAFF_LAST),
                   len(days), days[-1] if days else ''])
        ws.cell(row=r, column=10).number_format = '0.0%'
    finish(ws, [13, 18, 9, 26, 9, 9, 9, 12, 12, 11, 8, 10, 11, 12])

    # ============================================================ Daily Returns
    ws = wb.create_sheet('Daily Returns')
    ws.append(['Date', 'Day', 'Holiday', 'Centres filing return', 'Children fed', 'Pregnant / lactating', 'Others',
               'Meals served', 'Eggs used', 'Rice used (kg)', 'Pulses used (kg)', 'Balamrutham used (ml)',
               'Balamrutham+ used (ml)', 'Milk used (ml)'])
    for ds in all_days:
        v = rpt_district.get(ds)
        if not v:
            continue
        st = v.get('st') or {}
        used = lambda k: (st.get(k) or [0, 0, 0, 0])[1]
        r = ws.max_row + 1
        ws.append([ds, dt.date.fromisoformat(ds).strftime('%a'), holiday_name(ds), v.get('awcs', 0), v.get('c', 0),
                   v.get('p', 0), v.get('o', 0), v.get('m', 0), used('eggs'), used('rice'), used('pulses'),
                   used('bal'), used('balp'), used('milk')])
    r = ws.max_row + 1
    ws.append(['Total', '', '', '=MAX(D2:D%d)' % (r - 1)] + ['=SUM(%s2:%s%d)' % (get_column_letter(c), get_column_letter(c), r - 1) for c in range(5, 15)])
    ws.cell(row=r, column=4).value = '=MAX(D2:D%d)' % (r - 1)
    for c in ws[r]:
        c.font = Font(name=FONT, bold=True, size=10)
    ws.cell(row=r + 1, column=1).value = 'Totals: "Centres filing return" shows the best single day; the other columns are sums over the period. Returns exist from 16 Aug 2026 (feature release).'
    finish(ws, [12, 6, 22, 11, 11, 11, 9, 10, 10, 11, 11, 12, 12, 11], filt=False)

    # ============================================================= Flagged Marks
    ws = wb.create_sheet('Flagged Marks')
    ws.append(['Date', 'User ID', 'Name', 'Cadre', 'Project', 'Sector', 'Centre', 'IN / OUT', 'Time',
               'Geofence', 'Distance (m)', 'Flags', 'Remark'])
    flag_counts = {}
    for u in roster:
        uid = u['user_id']
        for ds, rec in marks.get(uid, {}).items():
            for typ in ('IN', 'OUT'):
                rr = rec.get(typ)
                if not rr:
                    continue
                fl = [f for f in str(rr.get('fl') or '').split(',') if f]
                gf = rr.get('gf')
                for f in fl:
                    flag_counts.setdefault(f, {}).setdefault(ds[:7], 0)
                    flag_counts[f][ds[:7]] += 1
                if gf == 'OUTSIDE':
                    flag_counts.setdefault('OUTSIDE_GEOFENCE', {}).setdefault(ds[:7], 0)
                    flag_counts['OUTSIDE_GEOFENCE'][ds[:7]] += 1
                if not fl and gf != 'OUTSIDE':
                    continue
                parts = []
                if gf == 'OUTSIDE':
                    parts.append('marked outside the centre geofence')
                parts += [FLAG_TEXT.get(f, f.lower().replace('_', ' ')) for f in fl]
                ws.append([ds, uid, u.get('name', ''), u.get('cadre', ''),
                           proj_name.get(u.get('project_code'), u.get('project_code', '')),
                           sector_label(u.get('sector_code', '')), awc_name.get(u.get('awc_id'), u.get('awc_id', '')),
                           typ, rr.get('t') or '', gf or '', rr.get('d') if rr.get('d') is not None else '',
                           ','.join(fl), '; '.join(parts).capitalize()])
    rows = list(ws.iter_rows(min_row=2, values_only=True))
    rows.sort(key=lambda x: (x[0], x[5], x[2], x[7]))
    ws.delete_rows(2, ws.max_row)
    for x in rows:
        ws.append(list(x))
    finish(ws, [12, 9, 28, 7, 13, 18, 24, 8, 7, 12, 10, 26, 60])

    # ============================================================== Flag Counts
    ws = wb.create_sheet('Flag Counts')
    ws.append(['Flag', 'Meaning'] + months + ['Total'])
    for f in sorted(flag_counts):
        r = ws.max_row + 1
        meaning = 'Marked outside the centre geofence (>300 m, accuracy <=250 m)' if f == 'OUTSIDE_GEOFENCE' else FLAG_TEXT.get(f, f)
        ws.append([f, meaning] + [flag_counts[f].get(ym, 0) for ym in months]
                  + ['=SUM(C%d:%s%d)' % (r, get_column_letter(2 + len(months)), r)])
    finish(ws, [22, 52] + [10] * len(months) + [9], filt=False)

    # ==================================================================== Leaves
    ws = wb.create_sheet('Leaves')
    ws.append(['Date', 'User ID', 'Name', 'Cadre', 'Project', 'Sector', 'Centre', 'Leave type'])
    lrows = []
    for u in roster:
        for ds, typ in leaves.get(u['user_id'], {}).items():
            lrows.append([ds, u['user_id'], u.get('name', ''), u.get('cadre', ''),
                          proj_name.get(u.get('project_code'), u.get('project_code', '')),
                          sector_label(u.get('sector_code', '')), awc_name.get(u.get('awc_id'), u.get('awc_id', '')),
                          LEAVE_LABEL.get(typ, typ)])
    for x in sorted(lrows):
        ws.append(x)
    finish(ws, [12, 9, 28, 7, 13, 18, 24, 16])

    # ================================================================= Registers
    for ym in months:
        ws = wb.create_sheet('Register ' + ym)
        y, m = int(ym[:4]), int(ym[5:])
        ndays = (dt.date(y + (m == 12), (m % 12) + 1, 1) - dt.date(y, m, 1)).days
        days = ['%02d' % d for d in range(1, ndays + 1)]
        ws.append(['Legend: P = IN and OUT, I = IN only, O = OUT only, L = on leave, H = holiday, A = not marked, '
                   '- = district not operating that day (rollout / break, not counted), blank = before go-live / after %s. '
                   'Working days this month: %d, of which operational: %d' % (end_date, wd_by_month[ym], od_by_month[ym])])
        ws.append(['S.No', 'User ID', 'Name', 'Cadre', 'Sector', 'Centre'] + [str(int(d)) for d in days]
                  + ['Present (P+I+O)', 'Absent (A)', 'Leave (L)'])
        first_col = 7
        last_col = first_col + ndays - 1
        for n, u in enumerate(roster, 1):
            uid = u['user_id']
            cells = []
            for d in days:
                ds = ym + '-' + d
                if ds < GO_LIVE or ds > end_date:
                    cells.append('')
                    continue
                rec = marks.get(uid, {}).get(ds) or {}
                i, o = rec.get('IN'), rec.get('OUT')
                if i and o:
                    cells.append('P')
                elif i:
                    cells.append('I')
                elif o:
                    cells.append('O')
                elif ds in leaves.get(uid, {}):
                    cells.append('L')
                elif is_holiday(ds):
                    cells.append('H')
                elif not is_operational(ds):
                    cells.append('-')
                else:
                    cells.append('A')
            r = ws.max_row + 1
            rng = '%s%d:%s%d' % (get_column_letter(first_col), r, get_column_letter(last_col), r)
            ws.append([n, uid, u.get('name', ''), u.get('cadre', ''), sector_label(u.get('sector_code', '')),
                       awc_name.get(u.get('awc_id'), u.get('awc_id', ''))] + cells
                      + ['=COUNTIF(%s,"P")+COUNTIF(%s,"I")+COUNTIF(%s,"O")' % (rng, rng, rng),
                         '=COUNTIF(%s,"A")' % rng, '=COUNTIF(%s,"L")' % rng])
            for ci, v in enumerate(cells, first_col):
                c = ws.cell(row=r, column=ci)
                c.alignment = Alignment(horizontal='center')
                if v == 'A':
                    c.fill = RED_FILL
                elif v == 'H':
                    c.fill = GREY_FILL
                elif v == 'L':
                    c.fill = AMBER_FILL
                elif v == 'P':
                    c.fill = GREEN_FILL
        ws.cell(row=1, column=1).font = Font(name=FONT, italic=True, size=9)
        finish(ws, [5, 8, 26, 6, 16, 22] + [3.2] * ndays + [9, 8, 8], freeze='G3', header_row=2)

    # =================================================================== Summary
    ws = wb.create_sheet('Summary', 0)
    ws.append(['Jangaon District - Sisu Mahila Samridhi attendance: all-time report', ''])
    ws['A1'].font = Font(name=FONT, bold=True, size=14)
    # Formulas that refer to other Summary rows are written as {key} and
    # resolved to row numbers after the layout is final.
    lines = [
        ['Period', '%s (go-live) to %s (last nightly summary; later marks are not yet published)' % (GO_LIVE, end_date)],
        ['Generated from summary files dated', meta['generatedAt']],
        ['', ''],
        ['rolls', 'Staff on rolls (register AWT/AWH + supervisors + hand-added)', '=COUNTA(\'Staff Summary\'!B2:B%d)' % STAFF_LAST],
        ['  of which AWT', '=COUNTIF(\'Staff Summary\'!D2:D%d,"AWT")' % STAFF_LAST],
        ['  of which AWH', '=COUNTIF(\'Staff Summary\'!D2:D%d,"AWH")' % STAFF_LAST],
        ['  of which Supervisors', '=COUNTIF(\'Staff Summary\'!D2:D%d,"SUP")' % STAFF_LAST],
        ['never', 'NEVER marked attendance since go-live', '=COUNTIF(\'Staff Summary\'!J2:J%d,"Never marked")' % STAFF_LAST],
        ['Marked at least once', '=COUNTIF(\'Staff Summary\'!K2:K%d,"Yes")' % STAFF_LAST],
        ['Stopped marking (marked before, but not on any of the last %d operational days)' % STOPPED_AFTER_OPDAYS, '=COUNTIF(\'Staff Summary\'!J2:J%d,"Stopped*")' % STAFF_LAST],
        ['Active (marked on at least one of the last %d operational days)' % STOPPED_AFTER_OPDAYS, '=COUNTIF(\'Staff Summary\'!J2:J%d,"Active")' % STAFF_LAST],
        ['', ''],
        ['Working days since go-live (holidays and Sundays excluded)', len(working)],
        ['wd', 'Operational days since go-live (working days with %d+ marks district-wide)' % OPERATIONAL_MIN_MARKS, nW],
        ['wdf', 'Operational days from 22-Aug (full rollout)', nM],
        ['Working days when the district was NOT operating (excluded from every rate)', ', '.join(non_op_working)],
        ['Person-days marked on any day (incl. holidays and breaks)', '=SUM(\'Staff Summary\'!%s2:%s%d)' % (get_column_letter(28 + len(months)), get_column_letter(28 + len(months)), STAFF_LAST)],
        ['pd', 'Person-days marked on operational days since go-live', '=SUM(\'Staff Summary\'!O2:O%d)' % STAFF_LAST],
        ['pct', 'District attendance % since go-live', '=IF({wd}=0,0,{pd}/({rolls}*{wd}))'],
        ['pdf', 'Person-days marked from 22-Aug', '=SUM(\'Staff Summary\'!R2:R%d)' % STAFF_LAST],
        ['pctf', 'District attendance % from 22-Aug', '=IF({wdf}=0,0,{pdf}/({rolls}*{wdf}))'],
        ['Late IN marks (after %s)' % late_after, '=SUM(\'Staff Summary\'!W2:W%d)' % STAFF_LAST],
        ['IN marks outside the centre geofence', '=SUM(\'Staff Summary\'!X2:X%d)' % STAFF_LAST],
        ['IN marks with unverifiable location (no usable GPS fix / centre has no coordinates)', '=SUM(\'Staff Summary\'!Y2:Y%d)' % STAFF_LAST],
        ['Flagged marks (any quality flag or outside geofence)', '=SUM(\'Staff Summary\'!Z2:Z%d)' % STAFF_LAST],
        ['Leave days recorded', '=SUM(\'Staff Summary\'!AA2:AA%d)' % STAFF_LAST],
        ['Daily centre returns filed (centre-days)', '=SUM(\'Centre Summary\'!M2:M%d)' % (len(awc_ids) + 1)],
        ['', ''],
        ['Sheets', ''],
        ['Never Marked', 'Everyone on the rolls with no IN or OUT mark on any day since go-live, with supervisor and centre.'],
        ['Staff Summary', 'One row per person: status, first/last mark, days marked, attendance %, late, geofence, flags, leave, per-month days.'],
        ['Daily Trend', 'District totals for every calendar day since go-live.'],
        ['Sector Summary / Centre Summary', 'Roll-ups computed by formula from Staff Summary.'],
        ['Daily Returns', 'Beneficiary and stock returns filed by centres, per day.'],
        ['Flag Counts / Flagged Marks', 'Data-quality flags by month, and every flagged mark with a plain-language remark.'],
        ['Leaves', 'Every leave day recorded, by person.'],
        ['Register <month>', 'Person x day grid: P / I / O / L / H / A.'],
        ['', ''],
        ['Data sources', ''],
    ]
    for ym in months:
        lines.append(['  %s marks' % ym, sources[ym]])
    lines += [
        ['  Register', 'master-data/IMPORT_USERS.csv (AWT/AWH); supervisors from backend importSupervisors() table, ids U2003 onward in table order.'],
        ['', ''],
        ['Caveats', ''],
        ['1', 'Register status (ACTIVE/INACTIVE) is held only in the live Users sheet and was not readable here; anyone deactivated after import still appears on the rolls.'],
        ['2', 'Admin and test accounts (U2000-U2002, U2099, U99xx) are excluded. Ids that marked but are missing from the register export are listed with a note.'],
        ['3', 'Whether a never-marked person ever logged in is not in the summary data; the live console Users tab shows that.'],
        ['4', '"Late" = IN after %s (district schedule). Geofence OUTSIDE = beyond 300 m with GPS accuracy <= 250 m; UNVERIFIED is never counted as outside.' % late_after],
        ['5', '8-21 Aug 2026 was the onboarding period; the "from 22-Aug" columns give the fair attendance rate.'],
        ['6', 'Operational-day rule: a working day on which fewer than %d people marked district-wide (rollout days, the Dasara break) is not held against anyone and does not count in attendance %% or in "stopped marking".' % OPERATIONAL_MIN_MARKS],
    ]
    keyrow = {}
    for l in lines:
        if len(l) == 3:
            keyrow[l[0]] = ws.max_row + 1
            l = l[1:]
        ws.append(l)
    for r in range(2, ws.max_row + 1):
        c = ws.cell(row=r, column=2)
        if isinstance(c.value, str) and '{' in c.value:
            c.value = re.sub(r'\{(\w+)\}', lambda m: 'B%d' % keyrow[m.group(1)], c.value)
        ws.cell(row=r, column=1).font = Font(name=FONT, bold=True, size=10)
        c.font = Font(name=FONT, size=10)
        c.alignment = Alignment(wrap_text=True, vertical='top')
    for k in ('pct', 'pctf'):
        ws.cell(row=keyrow[k], column=2).number_format = '0.0%'
    ws.cell(row=keyrow['never'], column=2).fill = RED_FILL
    ws.column_dimensions['A'].width = 58
    ws.column_dimensions['B'].width = 100

    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, 'Jangaon-attendance-all-time-%s-to-%s.xlsx' % (GO_LIVE, end_date))
    wb.save(out)

    never_by_cadre = {}
    for u in roster:
        if not stats[u['user_id']]['marked_days']:
            k = u.get('cadre') or '?'
            never_by_cadre[k] = never_by_cadre.get(k, 0) + 1
    pd_all = sum(s['marked_days'] for s in stats.values())
    pd_full = sum(s['marked_full'] for s in stats.values())
    print('Workbook: ' + out)
    print('rolls=%d never=%d (%s) stopped=%d active=%d' % (
        len(roster), NEVER_COUNT, never_by_cadre,
        sum(1 for s in stats.values() if s['status'].startswith('Stopped')),
        sum(1 for s in stats.values() if s['status'] == 'Active')))
    print('period %s..%s; working days=%d operational=%d (from 22-aug %d); non-operational working days: %s' % (
        GO_LIVE, end_date, len(working), nW, nM, ', '.join(non_op_working)))
    pd_op = sum(s['marked_op'] for s in stats.values())
    print('operational threshold=%d marks; person-days any-day=%d, operational=%d (%.1f%%), from 22-aug=%d (%.1f%%)' % (
        OPERATIONAL_MIN_MARKS, pd_all, pd_op, 100.0 * pd_op / (len(roster) * nW), pd_full, 100.0 * pd_full / (len(roster) * nM)))
    print('months: ' + ', '.join('%s<-%s' % (ym, sources[ym]) for ym in months))


if __name__ == '__main__':
    main()
