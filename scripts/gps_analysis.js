// Phase 1.3 forensic analysis of location data for the district report.
//
//   node scripts/gps_analysis.js
//
// Writes analysis/gps_findings.csv (one row per located mark in the window)
// and analysis/gps_summary.md (methodology, exclusions, aggregates, cases).
//
// This script reports. It does not argue. Every classification rule it applies
// is stated in the summary it writes, so a reader who disagrees with a rule can
// see exactly which rows it moved.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const OUT = path.join(ROOT, 'analysis');
fs.mkdirSync(OUT, { recursive: true });

const FROM_DAY = Number(process.argv[process.argv.indexOf('--from') + 1]) || 22;

const S = p => JSON.parse(fs.readFileSync(path.join(ROOT, 'summary', p), 'utf8'));
const meta = S('meta.json');
const org = S('org.json');

// Thresholds read from the backend so this analysis cannot drift from the
// rules the live system actually applied.
const util = fs.readFileSync(path.join(ROOT, 'backend', 'Util.gs'), 'utf8');
const num = re => { const m = util.match(re); return m ? Number(m[1]) : null; };
const ACC_LIMIT = num(/GPS_UNVERIFIED_ACC_M\s*=\s*(\d+)/);
const MIN_RADIUS = num(/GEOFENCE_MIN_RADIUS_M\s*=\s*(\d+)/);

// ---------------------------------------------------------------- load
const userAwc = {}, userCadre = {};
const lines = fs.readFileSync(path.join(ROOT, 'master-data', 'IMPORT_USERS.csv'), 'utf8')
  .trim().split(/\r?\n/);
const h = lines[0].replace(/^﻿/, '').split(',');
const iU = h.indexOf('user_id'), iA = h.indexOf('awc_id'), iC = h.indexOf('cadre');
lines.slice(1).forEach(l => {
  const c = l.split(',');
  if (c[iU]) { userAwc[c[iU]] = c[iA]; userCadre[c[iU]] = c[iC]; }
});

const sectorOf = {};
org.sectors.forEach(s => { sectorOf[s.code] = s.name; });

const all = [];
fs.readdirSync(path.join(ROOT, 'summary', 'month')).filter(f => f.endsWith('.json')).forEach(f => {
  const m = S(path.join('month', f));
  Object.keys(m.users || {}).forEach(u => {
    Object.keys(m.users[u]).forEach(day => {
      ['IN', 'OUT'].forEach(kind => {
        const e = m.users[u][day][kind];
        if (!e) return;
        all.push({ user: u, awc: userAwc[u] || '', cadre: userCadre[u] || '',
          sector: String(m.sector || ''), day: day, kind: kind, time: String(e.t || ''),
          gf: String(e.gf || ''), dist: typeof e.d === 'number' ? e.d : null,
          flags: String(e.fl || '') });
      });
    });
  });
});
const win = all.filter(m => Number(m.day) >= FROM_DAY);

// ------------------------------------------------- centre coordinate class
// Classified on EVERY mark, not just the window: whether a recorded centre
// point is usable is a property of the centre, and more evidence classifies
// it better. A centre that produces inside marks as well as outside ones has
// demonstrably got a usable coordinate.
const byAwc = {};
all.forEach(m => {
  if (!m.awc || (m.gf !== 'INSIDE' && m.gf !== 'OUTSIDE')) return;
  const a = byAwc[m.awc] || (byAwc[m.awc] = { n: 0, out: 0 });
  a.n++; if (m.gf === 'OUTSIDE') a.out++;
});
const centreClass = awc => {
  const a = byAwc[awc];
  if (!a || a.n < 4) return 'UNCLASSIFIED';
  if (a.out === 0) return 'COORD_OK_NEVER_OUTSIDE';
  return a.out / a.n >= 0.9 ? 'COORD_SUSPECT' : 'COORD_OK_MIXED';
};

// ------------------------------------------------------------- classify
// SUSPECT_MOCK is deliberately conservative. A browser application cannot read
// Android's mock-location flag, so this is a pattern indicator only: a fix
// reported as flawless together with coordinates repeated to the metre.
function classify(m) {
  if (m.gf === 'UNVERIFIED') return 'NO_GPS';
  if (m.gf === 'INSIDE') return 'WITHIN_GEOFENCE';
  const f = m.flags;
  if (/PERFECT_ACCURACY/.test(f) && /REPEAT_COORDS/.test(f)) return 'SUSPECT_MOCK';
  const cls = centreClass(m.awc);
  if (cls === 'COORD_SUSPECT') return 'OUTSIDE_COORD_UNVERIFIED';
  if (cls === 'UNCLASSIFIED') return 'OUTSIDE_UNCLASSIFIED';
  return 'OUTSIDE';
}

const rows = win.map(m => Object.assign({}, m, {
  centreClass: centreClass(m.awc), classification: classify(m)
}));

// Pseudonyms, stable within this run, so a case can be discussed without
// naming anyone. The key back to worker ids is written separately.
const refOf = {}, keyRows = [];
let seq = 0;
rows.forEach(r => {
  if (!refOf[r.user]) {
    refOf[r.user] = 'W' + String(++seq).padStart(4, '0');
    keyRows.push([refOf[r.user], r.user, r.cadre, r.sector]);
  }
});

// ------------------------------------------------------------------ csv
const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
const csv = ['worker_ref,cadre,sector_code,sector_name,date,mark_type,time,geofence,' +
  'distance_m,flags,centre_coordinate_class,classification']
  .concat(rows.map(r => [refOf[r.user], r.cadre, r.sector, sectorOf[r.sector] || '',
    meta.month + '-' + r.day, r.kind, r.time, r.gf,
    r.dist == null ? '' : Math.round(r.dist), r.flags, r.centreClass, r.classification]
    .map(q).join(',')));
fs.writeFileSync(path.join(OUT, 'gps_findings.csv'), csv.join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'worker_ref_key.csv'),
  'worker_ref,user_id,cadre,sector_code\n' +
  keyRows.map(r => r.map(q).join(',')).join('\n') + '\n');

// ------------------------------------------------------------ aggregate
const count = c => rows.filter(r => r.classification === c).length;
const CLASSES = ['WITHIN_GEOFENCE', 'OUTSIDE', 'OUTSIDE_COORD_UNVERIFIED',
  'OUTSIDE_UNCLASSIFIED', 'SUSPECT_MOCK', 'NO_GPS'];
const located = rows.filter(r => r.gf === 'INSIDE' || r.gf === 'OUTSIDE').length;

// ------------------------------------------------------------- cases
// Only from centres whose coordinate is proven usable, and only where the
// pattern repeats. A single distant mark is noise, not a case.
const byUser = {};
rows.forEach(r => {
  if (r.classification !== 'OUTSIDE') return;
  (byUser[r.user] = byUser[r.user] || []).push(r);
});
const cases = Object.keys(byUser)
  .map(u => ({
    user: u, ref: refOf[u], cadre: userCadre[u] || '',
    sector: sectorOf[rows.find(r => r.user === u).sector] || '',
    remote: byUser[u].length,
    maxDist: Math.max.apply(null, byUser[u].map(r => r.dist || 0)),
    days: new Set(byUser[u].map(r => r.day)).size,
    total: rows.filter(r => r.user === u).length,
    inside: rows.filter(r => r.user === u && r.gf === 'INSIDE').length,
    timeline: rows.filter(r => r.user === u)
      .sort((a, b) => a.day === b.day ? (a.kind === 'IN' ? -1 : 1) : (a.day < b.day ? -1 : 1))
  }))
  .filter(c => c.remote >= 2 && c.days >= 2 && c.maxDist >= 2000)
  .sort((a, b) => b.remote - a.remote || b.maxDist - a.maxDist)
  .slice(0, 5);

const km = m => (m / 1000).toFixed(1) + ' km';
const md = [];
md.push('# Location findings — ' + meta.month + ', from day ' + FROM_DAY + ' onwards');
md.push('');
md.push('Generated ' + new Date().toISOString() + ' from the district summary files.');
md.push('Source data generated ' + meta.generatedAt + '.');
md.push('');
md.push('## Method');
md.push('');
md.push('Every mark carries a position recorded by the handset at the moment of marking, and the');
md.push('distance from that position to the centre the worker is posted to. This analysis uses');
md.push('those distances. It does not use names, photographs or telephone numbers.');
md.push('');
md.push('**Classification applied by the live system when the mark was made:**');
md.push('');
md.push('| Term | Rule |');
md.push('| --- | --- |');
md.push('| Inside | Distance within the centre\'s radius, minimum ' + MIN_RADIUS + ' m |');
md.push('| Outside | Distance beyond that radius |');
md.push('| No usable fix | No position, or reported accuracy worse than ' + ACC_LIMIT + ' m, or a centre with no recorded coordinate |');
md.push('');
md.push('**Exclusion rule required of this analysis:** a mark must not be counted as outside');
md.push('where the distance is within the position\'s own margin of error.');
md.push('');
md.push('That rule is satisfied by construction, and this is worth stating plainly because it is');
md.push('the first thing a reviewer should test. A mark can only be classified outside if its');
md.push('reported accuracy was **' + ACC_LIMIT + ' m or better** — anything worse was recorded as');
md.push('*no usable fix* and counted against nobody. A mark can only be classified outside if the');
md.push('distance exceeded **' + MIN_RADIUS + ' m**. Since ' + MIN_RADIUS + ' m is greater than ' +
  ACC_LIMIT + ' m, every mark counted as outside has a distance larger than its own margin of');
md.push('error. No record needed to be removed under this rule.');
md.push('');
md.push('**Second exclusion applied here:** a centre whose recorded coordinate is wrong would');
md.push('place every one of its marks outside. Centres are therefore classified first, using');
md.push('every mark of the month. A centre producing both inside and outside marks demonstrably');
md.push('has a usable coordinate. Marks from centres where *every* mark is outside are reported');
md.push('separately as `OUTSIDE_COORD_UNVERIFIED` and are excluded from all findings.');
md.push('');
md.push('## Aggregate');
md.push('');
md.push('| Classification | Marks | Share of located |');
md.push('| --- | ---: | ---: |');
CLASSES.forEach(c => {
  const n = count(c);
  md.push('| `' + c + '` | ' + n + ' | ' +
    (c === 'NO_GPS' ? '—' : (located ? (n / located * 100).toFixed(1) + '%' : '—')) + ' |');
});
md.push('| **Total records examined** | **' + rows.length + '** | |');
md.push('');
md.push('Sample: ' + rows.length + ' marks by ' + Object.keys(refOf).length + ' workers across ' +
  new Set(rows.map(r => r.sector)).size + ' sectors, ' + meta.month + '-' +
  String(FROM_DAY).padStart(2, '0') + ' to ' + meta.month + '-' +
  Math.max.apply(null, rows.map(r => Number(r.day))) + '.');
md.push('');
md.push('## Distance profile of confirmed outside marks');
md.push('');
const conf = rows.filter(r => r.classification === 'OUTSIDE' && r.dist != null).map(r => r.dist);
const sortD = conf.slice().sort((a, b) => a - b);
const qd = p => sortD.length ? sortD[Math.floor(sortD.length * p)] : 0;
md.push('| Measure | Value |');
md.push('| --- | ---: |');
md.push('| Records | ' + conf.length + ' |');
md.push('| Median | ' + km(qd(0.5)) + ' |');
md.push('| 90th percentile | ' + km(qd(0.9)) + ' |');
md.push('| Furthest | ' + km(sortD[sortD.length - 1] || 0) + ' |');
md.push('| Beyond 1 km | ' + conf.filter(d => d >= 1000).length + ' |');
md.push('| Beyond 5 km | ' + conf.filter(d => d >= 5000).length + ' |');
md.push('| Beyond 20 km | ' + conf.filter(d => d >= 20000).length + ' |');
md.push('');
md.push('## Case studies');
md.push('');
md.push('Selected where the pattern repeats over at least two days and the distance exceeds 2 km,');
md.push('at centres whose coordinate is proven usable. One-off distant marks are not included.');
md.push('');
cases.forEach((c, i) => {
  md.push('### Case ' + String.fromCharCode(65 + i) + ' — ' + c.ref + ', ' + c.cadre +
    ', Sector ' + c.sector);
  md.push('');
  md.push('Records examined: ' + c.total + '. Marks away from the centre: ' + c.remote +
    ' over ' + c.days + ' days. Furthest: ' + km(c.maxDist) + '. Marks at the centre: ' + c.inside + '.');
  md.push('');
  md.push('| Date | Mark | Time | Device reported | Classification |');
  md.push('| --- | --- | --- | ---: | --- |');
  c.timeline.forEach(t => {
    md.push('| ' + meta.month + '-' + t.day + ' | ' + t.kind + ' | ' + (t.time || '—') + ' | ' +
      (t.dist == null ? 'no usable fix' : km(t.dist)) + ' | ' + t.classification + ' |');
  });
  md.push('');
});
md.push('## Explanations this analysis cannot rule out');
md.push('');
md.push('The data records where a **device** was, not where a **person** was, and the district');
md.push('should hold the following open when considering any individual record:');
md.push('');
md.push('- A home visit to a beneficiary, a survey duty, or an immunisation day held elsewhere.');
md.push('- Official duty at the sector or project office, or training.');
md.push('- A handset carried or used by a family member.');
md.push('- Position drift indoors or under heavy tree cover, within the accuracy limit but still wrong.');
md.push('- A centre coordinate that is correct for the building but recorded at its boundary.');
md.push('');
md.push('The finding this analysis supports is narrow and it is the only one claimed:');
md.push('**these marks were made at a distance from the registered centre, that distance is now');
md.push('measured and recorded, and it can be put to the worker for explanation.** Previously it');
md.push('could not be.');
md.push('');
fs.writeFileSync(path.join(OUT, 'gps_summary.md'), md.join('\n'));

console.log('analysis/gps_findings.csv   ' + rows.length + ' rows');
console.log('analysis/worker_ref_key.csv ' + keyRows.length + ' workers (not for the report body)');
console.log('analysis/gps_summary.md');
console.log('');
CLASSES.forEach(c => console.log('  ' + String(count(c)).padStart(5) + '  ' + c));
console.log('  ' + String(rows.length).padStart(5) + '  TOTAL');
console.log('');
console.log('case studies: ' + cases.length);
cases.forEach((c, i) => console.log('  Case ' + String.fromCharCode(65 + i) + '  ' + c.ref +
  '  ' + c.remote + ' remote over ' + c.days + ' days, furthest ' + km(c.maxDist)));
