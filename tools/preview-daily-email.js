// Preview of the 18:00 daily attendance email, built from the district's own
// data so the layout and the numbers can be judged before anything is sent.
//
//   node tools/preview-daily-email.js [--day 27]
//
// Writes docs/report/daily-email-preview.html. Sends nothing. The backend
// implementation will compute the same figures from the live Users and Marks
// sheets, where supervisors are present; this preview reads the field-staff
// CSV, which holds AWT and AWH only, so the supervisor row is marked as such.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const S = p => JSON.parse(fs.readFileSync(path.join(ROOT, 'summary', p), 'utf8'));
const argDay = process.argv.indexOf('--day');
const DAY = argDay > 0 ? String(process.argv[argDay + 1]).padStart(2, '0') : '27';

const org = S('org.json');
const meta = S('meta.json');
const today = S('today.json');
const reports = S(path.join('reports', meta.month + '.json'));

// ------------------------------------------------------------ establishment
const lines = fs.readFileSync(path.join(ROOT, 'master-data', 'IMPORT_USERS.csv'), 'utf8')
  .trim().split(/\r?\n/);
const H = lines[0].replace(/^﻿/, '').split(',');
const ix = k => H.indexOf(k);
const U = {};
lines.slice(1).forEach(l => {
  const c = l.split(',');
  if (!c[ix('user_id')]) return;
  U[c[ix('user_id')]] = {
    id: c[ix('user_id')], name: c[ix('name')], cadre: c[ix('cadre')],
    sector: c[ix('sector_code')], awc: c[ix('awc_id')], project: c[ix('project_code')]
  };
});

const sectorName = {}, sectorProject = {};
org.sectors.forEach(s => { sectorName[s.code] = s.name; sectorProject[s.code] = s.project; });
const awcName = {};
Object.keys(org.awcs).forEach(a => { awcName[a] = org.awcs[a].n; });

// ------------------------------------------------------------------ marks
const marks = {};
fs.readdirSync(path.join(ROOT, 'summary', 'month')).filter(f => f.endsWith('.json')).forEach(f => {
  const j = S(path.join('month', f));
  Object.keys(j.users || {}).forEach(u => {
    Object.keys(j.users[u]).forEach(d => { (marks[u] = marks[u] || {})[d] = j.users[u][d]; });
  });
});

const ids = Object.keys(U);
const rec = id => (marks[id] || {})[DAY];
const everMarked = id => marks[id] && Object.keys(marks[id]).length > 0;

const inToday = ids.filter(id => rec(id) && rec(id).IN);
const outToday = ids.filter(id => rec(id) && rec(id).OUT);
const notMarked = ids.filter(id => !rec(id) || (!rec(id).IN && !rec(id).OUT));
const neverMarked = ids.filter(id => !everMarked(id));

// Supervisors mark too, but they are not in the field CSV. The backend reads
// the live Users sheet and will have them; here they are counted from marks
// that belong to nobody in the CSV, with district test accounts removed.
const supIds = Object.keys(marks).filter(u => !U[u] && !/^U99/.test(u));
const supIn = supIds.filter(u => (marks[u][DAY] || {}).IN).length;
const supOut = supIds.filter(u => (marks[u][DAY] || {}).OUT).length;

const cadreOf = c => ids.filter(id => U[id].cadre === c);
const cnt = (arr, c) => arr.filter(id => U[id].cadre === c).length;

// -------------------------------------------------------------- by sector
const sectors = org.sectors.map(s => {
  const roll = ids.filter(id => U[id].sector === s.code);
  const din = roll.filter(id => rec(id) && rec(id).IN);
  const nm = roll.filter(id => !rec(id) || (!rec(id).IN && !rec(id).OUT));
  const nev = roll.filter(id => !everMarked(id));
  return {
    code: s.code, name: s.name, project: s.project,
    roll: roll.length, in: din.length, notMarked: nm.length, never: nev.length,
    pct: roll.length ? Math.round(din.length / roll.length * 1000) / 10 : 0
  };
}).sort((a, b) => a.pct - b.pct);

// -------------------------------------------------------------- by centre
const centres = {};
ids.forEach(id => {
  const a = U[id].awc;
  if (!a) return;
  const c = centres[a] || (centres[a] = { awc: a, sector: U[id].sector, roll: 0, marked: 0 });
  c.roll++;
  if (rec(id) && (rec(id).IN || rec(id).OUT)) c.marked++;
});
const cList = Object.values(centres);
const fully = cList.filter(c => c.marked === c.roll && c.roll > 0);
const partial = cList.filter(c => c.marked > 0 && c.marked < c.roll);
const none = cList.filter(c => c.marked === 0);

const benDay = reports.days[DAY] || null;

// --------------------------------------------------------------- render
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const nf = x => Number(x).toLocaleString('en-IN');
const pctOf = (a, b) => b ? (a / b * 100).toFixed(1) + '%' : '—';

/**
 * Names grouped under their sector. One line per person, the centre in
 * brackets. Grouping by sector is both far smaller on the wire and the way a
 * supervisor will actually work the list.
 */
const nameRows = (list) => {
  const bySec = {};
  list.forEach(id => { (bySec[U[id].sector] = bySec[U[id].sector] || []).push(id); });
  return Object.keys(bySec).sort((a, b) =>
    (sectorName[a] || a).localeCompare(sectorName[b] || b)).map(sc => {
    const people = bySec[sc].sort((a, b) => U[a].name.localeCompare(U[b].name));
    return '<tr><td style="padding:7px 8px 2px;font-size:12px;font-weight:600;color:#0b5c4f;' +
      'border-top:1px solid #e3e7ee">' + esc(sectorName[sc] || sc) +
      ' <span style="font-weight:400;color:#7b8494">(' + people.length + ')</span></td></tr>' +
      '<tr><td style="padding:0 8px 7px;font-size:11.5px;line-height:1.75;color:#111418">' +
      people.map(id => esc(U[id].name) + ' <small>' + esc(U[id].cadre) +
        ', ' + esc(awcName[U[id].awc] || U[id].awc) + '</small>').join(' &nbsp;| ') +
      '</td></tr>';
  }).join('');
};

const th = 'style="text-align:left;padding:7px 8px;background:#f2f6f8;border-bottom:2px solid #0b5c4f;' +
  'font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#0b5c4f"';
const td = 'style="padding:6px 8px;border-bottom:1px solid #eef1f5;font-size:12.5px"';
const tdr = 'align="right" ' + td;

const tile = (v, l, colour) =>
  '<td style="padding:12px 10px;border:1px solid #e3e7ee;border-top:3px solid ' + colour +
  ';border-radius:4px;vertical-align:top">' +
  '<div style="font-size:23px;font-weight:700;color:' + colour + '">' + v + '</div>' +
  '<div style="font-size:11px;color:#525a66;margin-top:3px">' + l + '</div></td>';

const totalRoll = ids.length + supIds.length;
const dateLabel = Number(DAY) + ' ' + new Date(meta.month + '-' + DAY + 'T00:00:00')
  .toLocaleString('en-IN', { month: 'long' }) + ' ' + meta.month.slice(0, 4);

const html = `<meta charset="utf-8">
<div style="font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111418;max-width:900px;
  margin:0 auto;background:#fff">

<div style="background:#0b5c4f;color:#fff;padding:18px 22px">
  <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;opacity:.85">
    Government of Telangana &middot; WD&amp;CW &middot; Jangaon District</div>
  <div style="font-size:20px;font-weight:600;margin-top:5px">Daily Attendance Report &mdash; ${dateLabel}</div>
  <div style="font-size:12.5px;opacity:.9;margin-top:3px">
    Position as at 18:00 hrs. Generated automatically from Sisu Mahila Samridhi.</div>
</div>

<div style="padding:18px 22px">

<table style="width:100%;border-collapse:separate;border-spacing:6px 0;margin-bottom:6px"><tr>
  ${tile(nf(totalRoll), 'On the rolls', '#0b5c4f')}
  ${tile(nf(inToday.length + supIn), 'Marked IN', '#14603a')}
  ${tile(nf(outToday.length + supOut), 'Marked OUT', '#0b5c4f')}
  ${tile(nf(notMarked.length), 'Not marked today', '#a41e17')}
  ${tile(nf(neverMarked.length), 'Never marked', '#8a5200')}
</tr></table>
<p style="font-size:12px;color:#525a66;margin:4px 0 18px">
  ${pctOf(inToday.length + supIn, totalRoll)} of the establishment marked arrival.
  ${nf(outToday.length + supOut)} recorded a departure.</p>

<h3 style="font-size:14px;margin:20px 0 6px;color:#0b5c4f">1. Attendance by cadre</h3>
<table style="width:100%;border-collapse:collapse">
<tr><th ${th}>Cadre</th><th ${th} align="right">On rolls</th><th ${th} align="right">Marked IN</th>
<th ${th} align="right">Marked OUT</th><th ${th} align="right">Not marked</th>
<th ${th} align="right">Never marked</th><th ${th} align="right">Marked %</th></tr>
${['AWT', 'AWH'].map(c => `<tr>
  <td ${td}><b>${c === 'AWT' ? 'Anganwadi Teacher (AWT)' : 'Anganwadi Helper (AWH)'}</b></td>
  <td ${tdr}>${nf(cadreOf(c).length)}</td>
  <td ${tdr}>${nf(cnt(inToday, c))}</td>
  <td ${tdr}>${nf(cnt(outToday, c))}</td>
  <td ${tdr}>${nf(cnt(notMarked, c))}</td>
  <td ${tdr}>${nf(cnt(neverMarked, c))}</td>
  <td ${tdr}>${pctOf(cnt(inToday, c), cadreOf(c).length)}</td></tr>`).join('')}
<tr><td ${td}><b>Supervisor</b></td>
  <td ${tdr}>${nf(supIds.length)}</td><td ${tdr}>${nf(supIn)}</td><td ${tdr}>${nf(supOut)}</td>
  <td ${tdr}>${nf(supIds.length - supIn)}</td><td ${tdr}>&mdash;</td>
  <td ${tdr}>${pctOf(supIn, supIds.length)}</td></tr>
<tr style="background:#f7f9fb"><td ${td}><b>Total</b></td>
  <td ${tdr}><b>${nf(totalRoll)}</b></td><td ${tdr}><b>${nf(inToday.length + supIn)}</b></td>
  <td ${tdr}><b>${nf(outToday.length + supOut)}</b></td>
  <td ${tdr}><b>${nf(notMarked.length)}</b></td><td ${tdr}><b>${nf(neverMarked.length)}</b></td>
  <td ${tdr}><b>${pctOf(inToday.length + supIn, totalRoll)}</b></td></tr>
</table>

<h3 style="font-size:14px;margin:22px 0 6px;color:#0b5c4f">2. Centres</h3>
<table style="width:100%;border-collapse:collapse">
<tr><th ${th}>Position</th><th ${th} align="right">Centres</th><th ${th}>Meaning</th></tr>
<tr><td ${td}>Every posted worker marked</td><td ${tdr}>${nf(fully.length)}</td>
  <td ${td}>The centre is fully accounted for today.</td></tr>
<tr><td ${td}>Some marked, some not</td><td ${tdr}>${nf(partial.length)}</td>
  <td ${td}>Teacher or helper marked, the other did not.</td></tr>
<tr><td ${td}><b style="color:#a41e17">Nobody marked</b></td><td ${tdr}><b>${nf(none.length)}</b></td>
  <td ${td}>No attendance from this centre at all today. These need the first call.</td></tr>
<tr style="background:#f7f9fb"><td ${td}><b>Centres with staff posted</b></td>
  <td ${tdr}><b>${nf(cList.length)}</b></td><td ${td}></td></tr>
</table>
${benDay ? `<p style="font-size:12px;color:#525a66;margin:8px 0 0">
  Daily beneficiary return filed by <b>${nf(benDay.awcs)}</b> centres:
  ${nf(benDay.c)} children, ${nf(benDay.p)} pregnant and nursing women,
  ${nf(benDay.o)} others, ${nf(benDay.m)} meals prepared.</p>` : ''}

<h3 style="font-size:14px;margin:22px 0 6px;color:#0b5c4f">3. Sector analysis</h3>
<table style="width:100%;border-collapse:collapse">
<tr><th ${th}>Sector</th><th ${th}>Project</th><th ${th} align="right">On rolls</th>
<th ${th} align="right">Marked</th><th ${th} align="right">Not marked</th>
<th ${th} align="right">Never marked</th><th ${th} align="right">Marked %</th></tr>
${sectors.map(s => `<tr>
  <td ${td}>${esc(s.name)}</td><td ${td}>${esc(s.project)}</td>
  <td ${tdr}>${nf(s.roll)}</td><td ${tdr}>${nf(s.in)}</td>
  <td ${tdr}${s.notMarked > s.in ? ' bgcolor="#fdf5f4"' : ''}>${nf(s.notMarked)}</td>
  <td ${tdr}>${nf(s.never)}</td>
  <td ${tdr}><b style="color:${s.pct < 50 ? '#a41e17' : '#14603a'}">${s.pct}%</b></td></tr>`).join('')}
</table>
<p style="font-size:11.5px;color:#7b8494;margin:6px 0 0">Ordered by marking rate, weakest first.</p>

<h3 style="font-size:14px;margin:22px 0 6px;color:#a41e17">
  4. Not marked today &mdash; ${nf(notMarked.length)} persons</h3>
<p style="font-size:12px;color:#525a66;margin:0 0 8px">Includes those who have never marked,
  listed again separately below. Full list also attached as a spreadsheet.</p>
<table style="width:100%;border-collapse:collapse">${nameRows(notMarked)}</table>

<h3 style="font-size:14px;margin:24px 0 6px;color:#8a5200">
  5. Never marked since deployment &mdash; ${nf(neverMarked.length)} persons</h3>
<p style="font-size:12px;color:#525a66;margin:0 0 8px">No attendance record at any time.
  These require onboarding or an explanation, not a day's follow-up.</p>
<table style="width:100%;border-collapse:collapse">${nameRows(neverMarked)}</table>

<div style="margin-top:26px;padding-top:14px;border-top:2px solid #0b5c4f;font-size:11px;color:#525a66">
  Generated automatically at 18:00 hrs from Sisu Mahila Samridhi. Figures are as recorded at that
  moment; marks made offline may arrive later and are included in the next day's report.<br>
  <b>Confidential.</b> This message names identifiable public servants and is to be handled under
  the Digital Personal Data Protection Act, 2023. Do not forward outside the department.
</div>
</div></div>`;

const out = path.join(ROOT, 'docs', 'report', 'daily-email-preview.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);

console.log('Preview: ' + out);
console.log('');
console.log('Subject: Jangaon attendance ' + dateLabel + ' — ' +
  nf(inToday.length + supIn) + ' of ' + nf(totalRoll) + ' marked (' +
  pctOf(inToday.length + supIn, totalRoll) + ')');
console.log('');
console.log('  on rolls        ' + nf(totalRoll) + '  (AWT ' + nf(cadreOf('AWT').length) +
  ', AWH ' + nf(cadreOf('AWH').length) + ', Supervisor ' + nf(supIds.length) + ')');
console.log('  marked IN       ' + nf(inToday.length + supIn));
console.log('  marked OUT      ' + nf(outToday.length + supOut));
console.log('  not marked      ' + nf(notMarked.length));
console.log('  never marked    ' + nf(neverMarked.length));
console.log('  centres: ' + nf(fully.length) + ' complete, ' + nf(partial.length) +
  ' partial, ' + nf(none.length) + ' with nobody marked');
console.log('  email size      ' + Math.round(html.length / 1024) + ' KB' +
  (html.length > 102400 ? '  << over Gmail 102 KB clip threshold' : ''));
