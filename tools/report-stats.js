// Aggregate the district's own summary files into the figures used in the
// Government of Telangana report. Every number in that report comes from
// here, so it can be re-run and checked - nothing is typed in by hand.
//
//   node tools/report-stats.js            human-readable
//   node tools/report-stats.js --json     machine-readable, for the report page
//
// Reads summary/*.json (what the console already reads) and, if present,
// master-data/IMPORT_USERS.csv for the user -> AWC mapping. No name, phone
// number or photograph is read or emitted: everything below is a count, a
// median, a sector code or an AWC code.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const S = p => JSON.parse(fs.readFileSync(path.join(ROOT, 'summary', p), 'utf8'));

const meta = S('meta.json');
const today = S('today.json');
const org = S('org.json');
const exc = S('exceptions.json');
const verify = S(path.join('verify', meta.month + '.json'));
const reports = S(path.join('reports', meta.month + '.json'));

// A day only counts as operational once the district is actually using the
// system. The pilot days carry two to seven marks; averaging them in would
// let a handful of records swamp a day of 1,000.
const OPERATIONAL_MIN_MARKS = 50;

// ---------------------------------------------------------------- helpers
const pct = (n, d) => d ? Math.round((n / d) * 1000) / 10 : 0;
const sorted = a => a.slice().sort((x, y) => x - y);
const med = a => {
  if (!a.length) return null;
  const s = sorted(a), i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : Math.round((s[i - 1] + s[i]) / 2);
};
const quant = (a, q) => a.length ? sorted(a)[Math.min(a.length - 1, Math.floor(a.length * q))] : null;

// user -> AWC, so a wrong stored coordinate can be told apart from a worker
// who was somewhere else. Optional: the file is real district data and is
// not committed, so the tool still runs without it.
const userAwc = {};
try {
  const lines = fs.readFileSync(path.join(ROOT, 'master-data', 'IMPORT_USERS.csv'), 'utf8')
    .trim().split(/\r?\n/);
  const h = lines[0].replace(/^﻿/, '').split(',');
  const iU = h.indexOf('user_id'), iA = h.indexOf('awc_id');
  lines.slice(1).forEach(l => {
    const c = l.split(',');
    if (c[iU]) userAwc[c[iU]] = c[iA];
  });
} catch (e) { /* mapping unavailable - the coordinate split is skipped */ }
const haveAwcMap = Object.keys(userAwc).length > 0;

// ------------------------------------------------- every mark of the month
const marks = [];
const sectorOf = {};
org.sectors.forEach(s => { sectorOf[s.code] = s; });

fs.readdirSync(path.join(ROOT, 'summary', 'month'))
  .filter(f => f.endsWith('.json'))
  .forEach(f => {
    const m = S(path.join('month', f));
    Object.keys(m.users || {}).forEach(uid => {
      Object.keys(m.users[uid]).forEach(day => {
        ['IN', 'OUT'].forEach(kind => {
          const e = m.users[uid][day][kind];
          if (!e) return;
          marks.push({
            sector: String(m.sector || ''), user: uid, awc: userAwc[uid] || '',
            day: day, kind: kind, time: String(e.t || ''), gf: String(e.gf || ''),
            dist: typeof e.d === 'number' ? e.d : null,
            flags: String(e.fl || '').split(/[,;| ]+/).filter(Boolean),
            photo: !!e.ph
          });
        });
      });
    });
  });

// ------------------------------------------------------------- geofencing
// UNVERIFIED means no usable fix, or an AWC with no stored coordinate. A
// centre without coordinates can never produce OUTSIDE - the classifier
// drops it from the candidate list - so OUTSIDE always means a real fix
// measured against a real stored point.
const gf = { INSIDE: 0, OUTSIDE: 0, UNVERIFIED: 0, other: 0 };
marks.forEach(m => { gf[m.gf] === undefined ? gf.other++ : gf[m.gf]++; });
const located = gf.INSIDE + gf.OUTSIDE;

const outsideDist = marks.filter(m => m.gf === 'OUTSIDE' && m.dist != null).map(m => m.dist);
const band = (lo, hi) => outsideDist.filter(d => d >= lo && (hi == null || d < hi)).length;

// -------------------------------------------------------- per-day movement
const byDay = {};
marks.forEach(m => {
  const d = byDay[m.day] || (byDay[m.day] = { day: m.day, marks: 0, outside: 0, located: 0, staff: {} });
  d.marks++; d.staff[m.user] = 1;
  if (m.gf === 'OUTSIDE') { d.outside++; d.located++; }
  else if (m.gf === 'INSIDE') d.located++;
});
const days = Object.keys(byDay).sort().map(k => {
  const d = byDay[k];
  return { day: k, marks: d.marks, staff: Object.keys(d.staff).length,
    outside: d.outside, located: d.located, outsidePct: pct(d.outside, d.located),
    operational: d.marks >= OPERATIONAL_MIN_MARKS };
});
const opDays = days.filter(d => d.operational);
const firstOp = opDays[0] || null;
const lastOp = opDays[opDays.length - 1] || null;

// -------------------------------------- did the stored coordinates change?
// If the geofence reference moved, a fall in the outside rate would prove
// nothing. Compared straight from the committed history of places.json.
let coordDrift = null;
try {
  const { execFileSync } = require('child_process');
  const log = execFileSync('git', ['log', '--format=%H %ad', '--date=format:%Y-%m-%d',
    '--', 'summary/places.json'], { cwd: ROOT }).toString().trim().split('\n');
  const at = tag => JSON.parse(execFileSync('git', ['show', tag + ':summary/places.json'],
    { cwd: ROOT, maxBuffer: 1 << 26 }).toString()).awcs;
  const pick = d => (log.find(l => l.endsWith(d)) || '').split(' ')[0];
  const aRef = firstOp && pick(firstOp.day.length === 2 ? meta.month + '-' + firstOp.day : firstOp.day);
  const bRef = lastOp && pick(lastOp.day.length === 2 ? meta.month + '-' + lastOp.day : lastOp.day);
  if (aRef && bRef) {
    const A = at(aRef), B = at(bRef);
    const R = 6371000, rad = x => x * Math.PI / 180;
    const dist = (p, q) => {
      const dp = rad(q.lat - p.lat), dl = rad(q.lng - p.lng);
      const s = Math.sin(dp / 2) ** 2 + Math.cos(rad(p.lat)) * Math.cos(rad(q.lat)) * Math.sin(dl / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(s));
    };
    let moved = 0, max = 0, compared = 0;
    Object.keys(A).forEach(k => {
      if (!B[k] || A[k].lat == null || B[k].lat == null) return;
      compared++;
      const d = dist(A[k], B[k]);
      if (d > 10) moved++;
      if (d > max) max = d;
    });
    coordDrift = { from: firstOp.day, to: lastOp.day, compared: compared,
      moved: moved, maxMoveM: Math.round(max) };
  }
} catch (e) { /* history unavailable - the claim is simply not made */ }

// ------------------------------- wrong coordinate, or worker somewhere else
// A centre that produces INSIDE marks as well as OUTSIDE ones demonstrably
// has a usable stored coordinate, so its outside marks cannot be explained
// away as bad master data. Those are the undisputed remote marks.
let integrity = null;
if (haveAwcMap) {
  const byAwc = {};
  marks.forEach(m => {
    if (!m.awc || (m.gf !== 'INSIDE' && m.gf !== 'OUTSIDE')) return;
    const a = byAwc[m.awc] || (byAwc[m.awc] = { n: 0, out: 0 });
    a.n++; if (m.gf === 'OUTSIDE') a.out++;
  });
  const enough = Object.keys(byAwc).filter(k => byAwc[k].n >= 4);
  const suspect = enough.filter(k => byAwc[k].out / byAwc[k].n >= 0.9);
  const mixed = enough.filter(k => byAwc[k].out > 0 && byAwc[k].out / byAwc[k].n < 0.9);
  const clean = enough.filter(k => byAwc[k].out === 0);
  const mixedSet = {};
  mixed.forEach(k => { mixedSet[k] = 1; });
  const und = marks.filter(m => m.gf === 'OUTSIDE' && mixedSet[m.awc] && m.dist != null);
  const ud = und.map(m => m.dist);
  const perUser = {};
  und.forEach(m => { perUser[m.user] = (perUser[m.user] || 0) + 1; });
  integrity = {
    awcsAssessed: enough.length,
    suspectCoordinate: suspect.length,
    suspectMarks: suspect.reduce((s, k) => s + byAwc[k].out, 0),
    mixed: mixed.length,
    neverOutside: clean.length,
    undisputed: {
      marks: und.length, staff: Object.keys(perUser).length,
      centres: Object.keys(und.reduce((m, x) => { m[x.awc] = 1; return m; }, {})).length,
      median: med(ud), p90: quant(ud, 0.9), max: ud.length ? Math.max.apply(null, ud) : null,
      beyond1km: ud.filter(d => d >= 1000).length,
      beyond5km: ud.filter(d => d >= 5000).length,
      beyond20km: ud.filter(d => d >= 20000).length,
      staffRepeat3: Object.values(perUser).filter(n => n >= 3).length
    }
  };
}

// ------------------------------------------------------------ per sector
const bySector = {};
marks.forEach(m => {
  const s = bySector[m.sector] || (bySector[m.sector] = { marks: 0, outside: 0, located: 0, users: {} });
  s.marks++; s.users[m.user] = 1;
  if (m.gf === 'OUTSIDE') { s.outside++; s.located++; }
  else if (m.gf === 'INSIDE') s.located++;
});
const sectors = Object.keys(bySector).filter(Boolean).map(k => {
  const s = bySector[k];
  return { sector: k, name: (sectorOf[k] || {}).name || k, project: (sectorOf[k] || {}).project || '',
    staff: Object.keys(s.users).length, marks: s.marks, outside: s.outside,
    located: s.located, outsidePct: pct(s.outside, s.located) };
}).sort((a, b) => b.outsidePct - a.outsidePct);

// --------------------------------------------------------------- flags
const flagCount = {};
marks.forEach(m => m.flags.forEach(f => { flagCount[f] = (flagCount[f] || 0) + 1; }));
const FLAG_MEANING = {
  REPEAT_COORDS: 'the very same coordinates as an earlier mark, to the metre',
  PERFECT_ACCURACY: 'a GPS fix reported as flawless, which real handsets do not produce',
  AT_CENTER_EXACT: 'a fix landing exactly on the stored centre point',
  CLOCK_SKEW: 'the handset clock disagreeing with the server',
  NO_PHOTO: 'recorded before the photograph became compulsory',
  LATE_SYNC: 'marked offline and delivered when the network returned',
  EARLY_OUT: 'an OUT mark before the sanctioned hour',
  NO_REPORT_AT_OUT: 'the day closed without the beneficiary report'
};

// ------------------------------------------------------ ration verification
const findingCodes = {}, findingText = {};
let high = 0, medium = 0, low = 0;
verify.findings.forEach(f => {
  (f.r || []).forEach(r => {
    findingCodes[r.code] = (findingCodes[r.code] || 0) + 1;
    if (!findingText[r.code]) findingText[r.code] = r.t;
  });
  if (f.score >= 70) high++; else if (f.score >= 40) medium++; else low++;
});

// -------------------------------------------------- beneficiary reporting
const benDays = Object.keys(reports.days).sort().map(d => {
  const x = reports.days[d];
  return { day: d, awcs: x.awcs, children: x.c, pregnant: x.p, others: x.o, meals: x.m };
});

const inTimes = marks.filter(m => m.kind === 'IN' && /^\d{2}:\d{2}$/.test(m.time))
  .map(m => Number(m.time.slice(0, 2)) * 60 + Number(m.time.slice(3, 5)));

// ------------------------------------------------------------------- out
const out = {
  generatedAt: new Date().toISOString(),
  source: { generatedAt: meta.generatedAt, month: meta.month, date: meta.date },
  scale: {
    staff: today.adopt.staff, onboarded: today.adopt.onboarded,
    onboardedPct: pct(today.adopt.onboarded, today.adopt.staff),
    devices: today.adopt.devices, installedApp: today.adopt.app, browser: today.adopt.chrome,
    awcs: Object.keys(org.awcs).length, sectors: org.sectors.length, projects: org.projects.length
  },
  today: today.district,
  todayPct: {
    marked: pct(today.district.in, today.district.expected),
    late: pct(today.district.late, today.district.in),
    outside: pct(today.district.outside, today.district.in),
    notMarked: pct(today.district.notMarked, today.district.expected)
  },
  month: {
    marks: marks.length, days: days.length, operationalDays: opDays.length,
    staffSeen: Object.keys(marks.reduce((m, x) => { m[x.user] = 1; return m; }, {})).length,
    geofence: gf, located: located,
    outsidePct: pct(gf.OUTSIDE, located),
    unverifiedPct: pct(gf.UNVERIFIED, marks.length),
    photoPct: pct(marks.filter(m => m.photo).length, marks.length)
  },
  distance: {
    n: outsideDist.length, median: med(outsideDist),
    p90: quant(outsideDist, 0.9), p99: quant(outsideDist, 0.99),
    max: outsideDist.length ? Math.max.apply(null, outsideDist) : null,
    beyond1km: outsideDist.filter(d => d >= 1000).length,
    beyond5km: outsideDist.filter(d => d >= 5000).length,
    bands: [
      { label: 'just outside the fence (200 m - 500 m)', n: band(200, 500) },
      { label: '500 m - 1 km', n: band(500, 1000) },
      { label: '1 km - 5 km', n: band(1000, 5000) },
      { label: '5 km - 20 km', n: band(5000, 20000) },
      { label: 'more than 20 km away', n: band(20000, null) }
    ]
  },
  trend: {
    days: days,
    firstOperational: firstOp, lastOperational: lastOp,
    fallPoints: firstOp && lastOp ? Math.round((firstOp.outsidePct - lastOp.outsidePct) * 10) / 10 : null,
    coordDrift: coordDrift
  },
  integrity: integrity,
  sectors: sectors,
  flags: Object.keys(flagCount).sort((a, b) => flagCount[b] - flagCount[a])
    .map(f => ({ flag: f, n: flagCount[f], meaning: FLAG_MEANING[f] || '' })),
  punctuality: { n: inTimes.length, medianIn: med(inTimes), p90In: quant(inTimes, 0.9),
    lateToday: today.district.late },
  exceptions: {
    open: exc.open.length, staffInvolved: new Set(exc.open.map(x => x.u)).size,
    sectors: new Set(exc.open.map(x => x.s)).size,
    from: exc.open.map(x => x.d).sort()[0], to: exc.open.map(x => x.d).sort().slice(-1)[0]
  },
  rations: {
    findings: verify.findings.length,
    centres: new Set(verify.findings.map(f => f.a)).size,
    sectors: new Set(verify.findings.map(f => f.s)).size,
    high: high, medium: medium, low: low,
    codes: Object.keys(findingCodes).sort((a, b) => findingCodes[b] - findingCodes[a])
      .map(c => ({ code: c, n: findingCodes[c], example: findingText[c] }))
  },
  beneficiaries: { latest: today.rpt, series: benDays },
  performance: today.perf,
  pendingLeaves: today.pendingLeaves,
  projects: today.projects
};

if (process.argv.indexOf('--json') >= 0) {
  console.log(JSON.stringify(out, null, 2));
} else {
  const hhmm = m => m == null ? '-' : String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  const km = m => m == null ? '-' : (m / 1000).toFixed(1) + ' km';
  console.log('Source: summary generated ' + out.source.generatedAt + ' (month ' + out.source.month + ')\n');
  console.log('SCALE       ' + out.scale.staff + ' staff, ' + out.scale.awcs + ' AWCs, ' +
    out.scale.sectors + ' sectors, ' + out.scale.projects + ' projects');
  console.log('            onboarded ' + out.scale.onboarded + ' (' + out.scale.onboardedPct + '%), ' +
    out.scale.devices + ' devices, ' + out.scale.installedApp + ' installed / ' + out.scale.browser + ' browser');
  console.log('\nMONTH       ' + out.month.marks + ' marks, ' + out.month.operationalDays +
    ' operational days, ' + out.month.staffSeen + ' staff; photograph on ' + out.month.photoPct + '%');
  console.log('GEOFENCE    inside ' + gf.INSIDE + ' | OUTSIDE ' + gf.OUTSIDE + ' (' +
    out.month.outsidePct + '% of located) | no usable fix ' + gf.UNVERIFIED);
  console.log('DISTANCE    median ' + km(out.distance.median) + ', p90 ' + km(out.distance.p90) +
    ', furthest ' + km(out.distance.max));
  out.distance.bands.forEach(b => console.log('              ' + String(b.n).padStart(5) + '  ' + b.label));

  console.log('\nTREND (operational days only)');
  opDays.forEach(d => console.log('   ' + out.source.month + '-' + d.day + '  ' +
    String(d.marks).padStart(5) + ' marks  ' + String(d.outsidePct).padStart(5) + '% outside'));
  if (out.trend.fallPoints != null) {
    console.log('   fall from first to last operational day: ' + out.trend.fallPoints + ' points');
  }
  if (coordDrift) {
    console.log('   geofence reference over the same span: ' + coordDrift.compared +
      ' AWCs compared, ' + coordDrift.moved + ' moved more than 10 m (largest ' +
      coordDrift.maxMoveM + ' m)');
  }

  if (integrity) {
    console.log('\nCOORDINATE INTEGRITY (' + integrity.awcsAssessed + ' AWCs with 4+ located marks)');
    console.log('   ' + String(integrity.suspectCoordinate).padStart(4) + '  every mark outside - stored coordinate must be checked (' + integrity.suspectMarks + ' marks)');
    console.log('   ' + String(integrity.mixed).padStart(4) + '  both inside AND outside marks - coordinate proven good');
    console.log('   ' + String(integrity.neverOutside).padStart(4) + '  never outside');
    const u = integrity.undisputed;
    console.log('   UNDISPUTED remote marks (from proven-good centres): ' + u.marks +
      ' by ' + u.staff + ' staff at ' + u.centres + ' centres');
    console.log('     median ' + km(u.median) + ', p90 ' + km(u.p90) + ', furthest ' + km(u.max));
    console.log('     beyond 1 km ' + u.beyond1km + ' | beyond 5 km ' + u.beyond5km +
      ' | beyond 20 km ' + u.beyond20km + ' | staff with 3+ ' + u.staffRepeat3);
  }

  console.log('\nFLAGS');
  out.flags.forEach(f => console.log('   ' + String(f.n).padStart(4) + '  ' + f.flag + ' - ' + f.meaning));

  console.log('\nRATIONS     ' + out.rations.findings + ' findings at ' + out.rations.centres +
    ' centres in ' + out.rations.sectors + ' sectors (high ' + out.rations.high +
    ', medium ' + out.rations.medium + ', low ' + out.rations.low + ')');
  out.rations.codes.forEach(c => console.log('   ' + String(c.n).padStart(4) + '  ' + c.code));

  console.log('\nBENEFICIARY REPORTING');
  out.beneficiaries.series.forEach(d => console.log('   ' + out.source.month + '-' + d.day + '  ' +
    String(d.awcs).padStart(4) + ' AWCs  ' + String(d.children).padStart(5) + ' children  ' +
    String(d.pregnant).padStart(5) + ' pregnant/nursing  ' + String(d.meals).padStart(5) + ' meals'));

  console.log('\nPUNCTUALITY median IN ' + hhmm(out.punctuality.medianIn) +
    ', p90 ' + hhmm(out.punctuality.p90In) + ', late today ' + out.punctuality.lateToday);
  console.log('EXCEPTIONS  ' + out.exceptions.open + ' open, ' + out.exceptions.staffInvolved +
    ' staff, ' + out.exceptions.sectors + ' sectors');
  console.log('PERFORMANCE online median ' + out.performance.on.med + ' ms, p95 ' +
    out.performance.on.p95 + ' ms; offline ' + out.performance.off.n + ' marks; late sync ' +
    out.performance.lateSync);
}
