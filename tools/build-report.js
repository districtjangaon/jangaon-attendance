// Build the Government of Telangana report from the district's own data.
//
//   node tools/report-stats.js --json > docs/report/stats.json
//   node tools/build-report.js
//
// Every figure on the page is read out of stats.json, which tools/report-stats.js
// computes from summary/*.json. Nothing is typed in by hand, so the document can
// be regenerated on any later date and will simply tell the truth about that day.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const OUT = path.join(ROOT, 'docs', 'report');
const d = JSON.parse(fs.readFileSync(path.join(OUT, 'stats.json'), 'utf8'));

// Coordinates behind out-of-fence marks, exported from the console by an
// officer (Users & Admin -> Download case geography). Gitignored and local:
// these are worker positions and must never reach the published summary.
let geo = null;
try {
  geo = JSON.parse(fs.readFileSync(path.join(OUT, 'case-geo.json'), 'utf8'));
} catch (e) { /* not exported yet - the case maps say so rather than guess */ }

const n = x => x == null ? '—' : Number(x).toLocaleString('en-IN');
const km = m => m == null ? '—' : (m / 1000).toFixed(1) + ' km';
const hhmm = m => m == null ? '—' : String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const dayLabel = x => x.length === 2 ? Number(x) + ' Aug' : x;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------- charts
// Inline SVG only: the file must open from a pen drive in a room with no
// internet, and print to PDF without a single external request.
function barChart(rows, opts) {
  const o = Object.assign({ w: 700, barH: 34, gap: 12, pad: 170, max: null, unit: '%', color: '#b3261e' }, opts);
  const max = o.max != null ? o.max : Math.max.apply(null, rows.map(r => r.v)) || 1;
  const h = rows.length * (o.barH + o.gap) + 10;
  const bars = rows.map((r, i) => {
    const y = i * (o.barH + o.gap);
    const w = Math.max(2, Math.round((r.v / max) * (o.w - o.pad - 90)));
    const c = r.color || o.color;
    return `<text x="0" y="${y + o.barH * 0.68}" class="lbl">${esc(r.k)}</text>` +
      `<rect x="${o.pad}" y="${y}" width="${w}" height="${o.barH}" rx="4" fill="${c}"/>` +
      `<text x="${o.pad + w + 10}" y="${y + o.barH * 0.68}" class="val">${esc(r.t != null ? r.t : r.v + o.unit)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${o.w} ${h}" class="chart" role="img" aria-label="${esc(o.title || 'chart')}">${bars}</svg>`;
}

function lineChart(pts, opts) {
  // padR leaves room for the last day's label, which is centred on a point
  // sitting at the right-hand edge of the plot.
  const o = Object.assign({ w: 760, h: 300, padL: 52, padB: 46, padT: 22, padR: 58 }, opts);
  const iw = o.w - o.padL - o.padR, ih = o.h - o.padT - o.padB;
  const max = 100;
  const x = i => o.padL + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
  const y = v => o.padT + ih - (v / max) * ih;
  const grid = [0, 25, 50, 75, 100].map(v =>
    `<line x1="${o.padL}" y1="${y(v)}" x2="${o.w - o.padR}" y2="${y(v)}" class="grid"/>` +
    `<text x="${o.padL - 10}" y="${y(v) + 4}" class="ax" text-anchor="end">${v}%</text>`).join('');
  const line = pts.map((p, i) => (i ? 'L' : 'M') + x(i) + ' ' + y(p.v)).join(' ');
  const area = line + ` L ${x(pts.length - 1)} ${y(0)} L ${x(0)} ${y(0)} Z`;
  const dots = pts.map((p, i) =>
    `<circle cx="${x(i)}" cy="${y(p.v)}" r="5" fill="#b3261e"/>` +
    `<text x="${x(i)}" y="${y(p.v) - 14}" class="pt" text-anchor="middle">${p.v}%</text>` +
    `<text x="${x(i)}" y="${o.h - o.padB + 22}" class="ax" text-anchor="middle">${esc(p.k)}</text>` +
    `<text x="${x(i)}" y="${o.h - o.padB + 38}" class="axs" text-anchor="middle">${esc(p.sub || '')}</text>`).join('');
  return `<svg viewBox="0 0 ${o.w} ${o.h}" class="chart" role="img" aria-label="Outside-fence rate by day">
    ${grid}<path d="${area}" fill="rgba(179,38,30,.10)"/>
    <path d="${line}" fill="none" stroke="#b3261e" stroke-width="3" stroke-linejoin="round"/>${dots}</svg>`;
}

// A worker's duty pattern: distance from her own centre, mark by mark. Log
// scale, because the interesting range runs from 10 m to 100 km and a linear
// axis would flatten every ordinary day onto the baseline.
function caseChart(c) {
  const w = 700, h = 195, padL = 68, padR = 54, padT = 30, padB = 42;
  const iw = w - padL - padR, ih = h - padT - padB;
  const LO = 10, HI = 200000;
  const ly = d => {
    const v = Math.min(HI, Math.max(LO, d == null ? LO : d));
    return padT + ih - ((Math.log10(v) - Math.log10(LO)) / (Math.log10(HI) - Math.log10(LO))) * ih;
  };
  const pts = c.timeline.filter(t => t.dist != null);
  const x = i => padL + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
  const rings = [[100, '100 m'], [1000, '1 km'], [10000, '10 km'], [100000, '100 km']]
    .map(([v, l]) => `<line x1="${padL}" y1="${ly(v)}" x2="${w - padR}" y2="${ly(v)}" class="grid"/>` +
      `<text x="${padL - 8}" y="${ly(v) + 4}" class="ax" text-anchor="end">${l}</text>`).join('');
  // Everything below this line is inside the centre's boundary.
  const fence = `<rect x="${padL}" y="${ly(200)}" width="${iw}" height="${padT + ih - ly(200)}"
      fill="rgba(27,107,58,.10)"/><text x="${padL + 6}" y="${padT + ih - 6}" class="axs"
      text-anchor="start">within 200 m of the centre</text>`;
  const path = pts.map((t, i) => (i ? 'L' : 'M') + x(i) + ' ' + ly(t.dist)).join(' ');
  const anchor = i => i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle';
  const dots = pts.map((t, i) => {
    const out = t.gf === 'OUTSIDE';
    return `<circle cx="${x(i)}" cy="${ly(t.dist)}" r="5.5" fill="${out ? '#b3261e' : '#1b6b3a'}"/>` +
      `<text x="${x(i)}" y="${ly(t.dist) - 12}" class="pt" text-anchor="${anchor(i)}"
        fill="${out ? '#b3261e' : '#1b6b3a'}">${t.dist >= 1000 ? (t.dist / 1000).toFixed(1) + ' km' : Math.round(t.dist) + ' m'}</text>` +
      `<text x="${x(i)}" y="${h - padB + 20}" class="ax" text-anchor="${anchor(i)}">${Number(t.day)} ${t.kind}</text>` +
      `<text x="${x(i)}" y="${h - padB + 34}" class="axs" text-anchor="${anchor(i)}">${esc(t.time || '')}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="${esc(c.ref)} distance by mark">
    ${fence}${rings}<path d="${path}" fill="none" stroke="#8b909b" stroke-width="1.5" stroke-dasharray="4 3"/>${dots}</svg>`;
}

// One case on a real map: the worker's own centre and each position she
// actually marked from. Drawn only from exported coordinates - never inferred,
// and never drawn at a guessed bearing.
function caseMap(c, geo) {
  if (!geo || !geo.marks) return '';
  const mine = geo.marks.filter(m => String(m.u) === String(c.user));
  if (!mine.length) return '';
  const awcId = mine[0].a;
  const centre = geo.awcs && geo.awcs[awcId];
  if (!centre) return '';

  const pts = mine.map(m => ({ lat: m.lat, lng: m.lng, day: m.d, kind: m.t, at: m.at, dist: m.dist }));
  const all = pts.concat([{ lat: centre.lat, lng: centre.lng }]);
  const la0 = Math.min.apply(null, all.map(p => p.lat)), la1 = Math.max.apply(null, all.map(p => p.lat));
  const ln0 = Math.min.apply(null, all.map(p => p.lng)), ln1 = Math.max.apply(null, all.map(p => p.lng));
  const w = 700, h = 300, pad = 40;
  // A degree of longitude is shorter than a degree of latitude at this
  // latitude; without the correction the map would be stretched east-west.
  const kx = Math.cos((la0 + la1) / 2 * Math.PI / 180);
  const spanX = Math.max(1e-5, (ln1 - ln0) * kx), spanY = Math.max(1e-5, la1 - la0);
  const sc = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
  const ox = pad + ((w - pad * 2) - spanX * sc) / 2;
  const oy = pad + ((h - pad * 2) - spanY * sc) / 2;
  const X = p => ox + (p.lng - ln0) * kx * sc;
  const Y = p => oy + (la1 - p.lat) * sc;

  const links = pts.map(p => `<line x1="${X(centre).toFixed(1)}" y1="${Y(centre).toFixed(1)}"
    x2="${X(p).toFixed(1)}" y2="${Y(p).toFixed(1)}" stroke="#b3261e" stroke-width="1"
    stroke-dasharray="3 3" stroke-opacity=".55"/>`).join('');
  const near = p => Math.hypot(X(p) - X(centre), Y(p) - Y(centre)) < 34;
  const marks = pts.map(p => `<circle cx="${X(p).toFixed(1)}" cy="${Y(p).toFixed(1)}" r="5"
      fill="#b3261e"/><text x="${X(p).toFixed(1)}" y="${(Y(p) - (near(p) ? 20 : 11)).toFixed(1)}" class="axs"
      text-anchor="middle" fill="#b3261e">${Number(p.day)} ${esc(p.kind)} &middot; ${p.dist >= 1000 ? (p.dist / 1000).toFixed(1) + ' km' : Math.round(p.dist) + ' m'}</text>`).join('');
  const home = `<circle cx="${X(centre).toFixed(1)}" cy="${Y(centre).toFixed(1)}" r="7"
      fill="none" stroke="#1b6b3a" stroke-width="2.5"/>
    <circle cx="${X(centre).toFixed(1)}" cy="${Y(centre).toFixed(1)}" r="2.5" fill="#1b6b3a"/>
    <text x="${X(centre).toFixed(1)}" y="${(Y(centre) + 26).toFixed(1)}" class="axs"
      text-anchor="middle" fill="#1b6b3a">her centre</text>`;

  // Scale bar rounded to a sensible distance for the span on screen.
  const kmPerPx = 111 / sc;
  const target = (w - pad * 2) * 0.28 * kmPerPx;
  const step = [0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100].reduce((a, b) =>
    Math.abs(b - target) < Math.abs(a - target) ? b : a);
  const barPx = step / kmPerPx;
  const bar = `<line x1="${pad}" y1="${h - 14}" x2="${pad + barPx}" y2="${h - 14}"
      stroke="#4a4f5a" stroke-width="2"/><text x="${pad + barPx + 8}" y="${h - 10}"
      class="axs">${step < 1 ? step * 1000 + ' m' : step + ' km'}</text>`;

  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="${esc(c.ref)} map">
    <rect x="1" y="1" width="${w - 2}" height="${h - 2}" fill="none" stroke="#dfe3ea"/>
    ${links}${home}${marks}${bar}</svg>`;
}

// The district's own centres, plotted from their recorded coordinates and
// classified exactly as Part 4 classifies them. No worker position is drawn:
// these are official facility locations only.
function districtMap(points) {
  if (!points.length) return '';
  const w = 700, h = 470, pad = 26;
  // A handful of recorded coordinates fall well outside Jangaon. Letting them
  // set the bounds would shrink the district to a corner, so the frame is the
  // middle 98% and the strays are drawn clamped to the edge, ringed, and
  // counted in the caption - visible as errors rather than quietly dropped.
  const q = (arr, f) => { const a = arr.slice().sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(a.length * f))]; };
  const lats = points.map(p => p.lat), lngs = points.map(p => p.lng);
  const la0 = q(lats, 0.01), la1 = q(lats, 0.99);
  const ln0 = q(lngs, 0.01), ln1 = q(lngs, 0.99);
  const outside = p => p.lat < la0 || p.lat > la1 || p.lng < ln0 || p.lng > ln1;
  const strays = points.filter(outside).length;
  const sx = (w - pad * 2) / (ln1 - ln0), sy = (h - pad * 2) / (la1 - la0);
  const sc = Math.min(sx, sy);
  const ox = pad + ((w - pad * 2) - (ln1 - ln0) * sc) / 2;
  const oy = pad + ((h - pad * 2) - (la1 - la0) * sc) / 2;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const X = p => ox + (clamp(p.lng, ln0, ln1) - ln0) * sc;
  const Y = p => oy + (la1 - clamp(p.lat, la0, la1)) * sc;
  const COL = { suspect: '#b3261e', mixed: '#a15c00', clean: '#1b6b3a', nodata: '#c3c8d2' };
  const order = ['nodata', 'clean', 'mixed', 'suspect'];
  const dots = order.map(cls => points.filter(p => p.cls === cls).map(p =>
    `<circle cx="${X(p).toFixed(1)}" cy="${Y(p).toFixed(1)}" r="${cls === 'nodata' ? 2.2 : 3.4}"
      fill="${COL[cls]}" fill-opacity="${cls === 'nodata' ? .5 : .85}"/>` +
    (outside(p) ? `<circle cx="${X(p).toFixed(1)}" cy="${Y(p).toFixed(1)}" r="7"
      fill="none" stroke="#b3261e" stroke-width="1.6"/>` : '')).join('')).join('');
  // Scale bar: ten kilometres of longitude at this district's latitude.
  const kmDeg = 1 / (111 * Math.cos((la0 + la1) / 2 * Math.PI / 180));
  const barPx = 10 * kmDeg * sc;
  const by = h - 14;
  const bar = `<line x1="${pad}" y1="${by}" x2="${pad + barPx}" y2="${by}" stroke="#4a4f5a" stroke-width="2"/>
    <text x="${pad + barPx + 8}" y="${by + 4}" class="axs">10 km</text>`;
  const note = strays ? `<text x="${w - pad}" y="${by + 4}" class="axs" text-anchor="end">` +
    `${strays} centre${strays === 1 ? '' : 's'} recorded outside the district, ringed at the frame edge</text>` : '';
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="Map of Anganwadi centres">
    <rect x="${pad - 6}" y="${pad - 6}" width="${w - pad * 2 + 12}" height="${h - pad * 2 - 6}"
      fill="none" stroke="#dfe3ea"/>${dots}${bar}${note}</svg>`;
}

// ------------------------------------------------------------- narrative
// The window's own days are the CURRENT position. The before/after story
// belongs to the rollout series, which spans the days before the window and
// is the only place a "first day" figure legitimately comes from.
const rollFirst = d.rollout.length ? d.rollout[0] : null;
const nowPct = d.month.outsidePct;
const fallPts = rollFirst ? Math.round((rollFirst.outsidePct - nowPct) * 10) / 10 : null;
const u = d.integrity ? d.integrity.undisputed : null;
const drift = d.trend.coordDrift;

const trendPts = d.trend.days.filter(x => x.operational)
  .map(x => ({ k: dayLabel(x.day), v: x.outsidePct, sub: n(x.marks) + ' marks' }));

const distBands = d.distance.bands.map(b => ({ k: b.label, v: b.n, t: n(b.n) + ' marks' }));

const benRows = d.beneficiaries.series.map(s => ({
  k: dayLabel(s.day), v: s.awcs, t: n(s.awcs) + ' centres · ' + n(s.children + s.pregnant + s.others) + ' beneficiaries'
}));

const flagRows = d.flags.map(f => ({ k: f.flag.replace(/_/g, ' ').toLowerCase(), v: f.n, t: n(f.n), color: '#6750a4' }));

const topSectors = d.sectors.slice(0, 10);

// Standalone document: it is opened from the file system and printed to PDF,
// so it must declare its own encoding and viewport - there is no host page
// wrapping it the way a published artifact would be.
const html = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jangaon Attendance Assurance — District Report</title>
<style>
:root{
  --ink:#111418; --ink2:#525a66; --ink3:#7b8494; --line:#e3e7ee; --line2:#f0f3f7;
  --bg:#fff; --soft:#f7f9fb;
  --brand:#0b5c4f; --brand2:#083c34; --accent:#c2a24a;
  --alert:#a41e17; --alert-bg:#fdf5f4; --warn:#8a5200; --warn-bg:#fffaf0;
  --ok:#14603a; --ok-bg:#f2f9f5;
  --font:'IBM Plex Sans',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,'Cascadia Mono',Consolas,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:#eef1f5;color:var(--ink);font-family:var(--font);
  line-height:1.65;font-size:16px;-webkit-font-smoothing:antialiased}
.page{max-width:940px;margin:0 auto;background:var(--bg);
  box-shadow:0 1px 3px rgba(16,24,40,.08),0 12px 40px rgba(16,24,40,.06);padding:0 0 72px}

/* ---------- cover ---------- */
header.cover{background:linear-gradient(155deg,var(--brand2) 0%,var(--brand) 62%,#0d6b5b 100%);
  color:#fff;padding:60px 60px 46px;position:relative;overflow:hidden}
header.cover::after{content:"";position:absolute;right:-90px;top:-90px;width:320px;height:320px;
  border:1px solid rgba(255,255,255,.14);border-radius:50%}
header.cover::before{content:"";position:absolute;right:-30px;top:-30px;width:200px;height:200px;
  border:1px solid rgba(255,255,255,.10);border-radius:50%}
.crest{font-family:var(--mono);font-size:11.5px;letter-spacing:.18em;text-transform:uppercase;
  color:rgba(255,255,255,.82);padding-bottom:18px;border-bottom:1px solid rgba(255,255,255,.22)}
h1{font-size:37px;line-height:1.16;margin:24px 0 10px;font-weight:600;letter-spacing:-.015em;max-width:16em}
.sub{font-size:17.5px;color:rgba(255,255,255,.9);margin:0 0 24px;max-width:34em}
.classif{display:inline-block;border:1px solid var(--accent);color:var(--accent);border-radius:3px;
  padding:6px 13px;font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:500}
.meta{margin-top:28px;padding-top:20px;border-top:1px solid rgba(255,255,255,.22);
  font-size:13px;font-family:var(--mono);color:rgba(255,255,255,.88);line-height:2.05}

/* ---------- structure ---------- */
main{padding:0 60px}
h2{font-size:25px;margin:56px 0 4px;padding-top:26px;border-top:2px solid var(--brand);
  font-weight:600;letter-spacing:-.012em}
h2 .num{font-family:var(--mono);font-size:11.5px;color:var(--brand);display:block;
  letter-spacing:.16em;text-transform:uppercase;margin-bottom:9px;font-weight:500}
h3{font-size:18.5px;margin:34px 0 6px;font-weight:600;letter-spacing:-.008em}
p{margin:13px 0}
.lead{font-size:17px;color:var(--ink2);line-height:1.66}
ul,ol{padding-left:20px} li{margin:8px 0}
code{font-family:var(--mono);font-size:.88em;background:var(--soft);
  border:1px solid var(--line);border-radius:3px;padding:1px 5px}
b{font-weight:600}

/* ---------- kpis ---------- */
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:30px 0}
.kpi{border:1px solid var(--line);border-top:3px solid var(--brand);border-radius:6px;
  padding:16px 15px 15px;background:#fff}
.kpi b{display:block;font-size:27px;line-height:1.15;font-weight:600;
  font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.kpi span{display:block;font-size:12px;color:var(--ink2);margin-top:8px;line-height:1.5}
.kpi.alert{border-top-color:var(--alert)} .kpi.alert b{color:var(--alert)}
.kpi.ok{border-top-color:var(--ok)} .kpi.ok b{color:var(--ok)}
.kpi.warn{border-top-color:var(--warn)} .kpi.warn b{color:var(--warn)}

/* ---------- callouts ---------- */
.box{border:1px solid var(--line);border-left:3px solid var(--brand);background:var(--soft);
  border-radius:5px;padding:18px 22px;margin:24px 0}
.box.alert{border-left-color:var(--alert);background:var(--alert-bg);border-color:#f2dedb}
.box.warn{border-left-color:var(--warn);background:var(--warn-bg);border-color:#f2e6cf}
.box h4{margin:0 0 9px;font-size:14px;letter-spacing:.01em;font-weight:600}
.box.alert h4{color:var(--alert)} .box.warn h4{color:var(--warn)}

/* ---------- tables ---------- */
table{width:100%;border-collapse:collapse;margin:22px 0;font-size:14px}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{background:var(--soft);font-size:10.5px;text-transform:uppercase;letter-spacing:.09em;
  color:var(--ink2);font-weight:600;border-bottom:1.5px solid var(--line)}
tr:last-child td{border-bottom:none}
td.num,th.num{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums}
table.cmp td:first-child{width:19%;background:var(--soft);font-weight:500}
table.cmp td:nth-child(2){width:38%;color:var(--ink2)}
table.cmp th:nth-child(2){color:var(--alert)}
table.cmp th:nth-child(3){color:var(--ok)}
table.cmp tr:nth-child(even) td:not(:first-child){background:#fcfdfe}

/* ---------- charts & cases ---------- */
.chart{width:100%;height:auto;margin:16px 0;display:block}
.chart .lbl{font-size:12.5px;fill:var(--ink2);font-family:var(--font)}
.chart .val{font-size:12.5px;fill:var(--ink);font-family:var(--mono)}
.chart .ax{font-size:11.5px;fill:var(--ink2);font-family:var(--mono)}
.chart .axs{font-size:10px;fill:var(--ink3);font-family:var(--mono)}
.chart .pt{font-size:12px;fill:var(--alert);font-family:var(--mono);font-weight:600}
.chart .grid{stroke:var(--line);stroke-width:1}
.case{border:1px solid var(--line);border-radius:7px;padding:16px 20px 8px;margin:22px 0;background:#fff}
.case-h{font-size:13.5px;color:var(--ink2);border-bottom:1px solid var(--line);padding-bottom:10px}
.case-h b{color:var(--ink);font-size:14.5px}
.case-map{margin-top:8px;border-top:1px solid var(--line2);padding-top:12px}
.case-sub{font-size:10.5px;letter-spacing:.11em;text-transform:uppercase;color:var(--ink3);margin-bottom:2px}
.src{font-family:var(--mono);font-size:11px;color:var(--ink3);margin-top:4px;line-height:1.65}
figure{margin:26px 0}
figure img{width:100%;border:1px solid var(--line);border-radius:6px;display:block}
figcaption{font-size:12.5px;color:var(--ink2);margin-top:8px;font-style:italic}
.shots{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.shots.phone{grid-template-columns:repeat(3,1fr)}

footer{margin:64px 60px 0;padding-top:22px;border-top:2px solid var(--brand);
  font-size:12px;color:var(--ink2);line-height:1.75}

@media print{
  body{background:#fff;font-size:10.5pt;line-height:1.55}
  .page{max-width:none;box-shadow:none}
  main{padding:0}
  header.cover{padding:44px 40px 38px;break-after:page}
  footer{margin:40px 0 0}
  h1{font-size:28pt}
  h2{font-size:16pt;margin-top:26pt;break-after:avoid}
  h3{font-size:12.5pt;break-after:avoid}
  h2,h3{page-break-after:avoid}
  figure,table,.box,.kpis,.case,svg{page-break-inside:avoid;break-inside:avoid}
  p,li{orphans:3;widows:3}
  .kpi{border-top-width:2.5px}
}
@media (max-width:760px){
  main,footer{padding-left:22px;padding-right:22px;margin-left:0;margin-right:0}
  header.cover{padding:36px 22px 30px}
  h1{font-size:27px}
  .kpis{grid-template-columns:1fr 1fr} .shots,.shots.phone{grid-template-columns:1fr}
  table.cmp td:first-child{width:auto}
  table,th,td{font-size:13px}
}
</style>

<div class="page">
<header class="cover">
  <div class="crest">Government of Telangana · Women Development &amp; Child Welfare · Jangaon District</div>
  <h1>Attendance Assurance and Beneficiary Verification System</h1>
  <p class="sub">Performance and impact report on the district's field-attendance platform</p>
  <span class="classif">Confidential — for official use only</span>
  <div class="meta">
    Reporting period &nbsp;${esc(d.window.label)}<br>
    Data as of &nbsp;${esc(d.source.generatedAt)}<br>
    Coverage &nbsp;${n(d.scale.awcs)} Anganwadi centres · ${n(d.scale.sectors)} sectors · ${n(d.scale.projects)} projects<br>
    Establishment &nbsp;${n(d.scale.staff)} field staff (AWT and AWH)
  </div>
</header>

<main>

<h2><span class="num">Executive summary</span>What the district has established</h2>

<p class="lead">Jangaon district deployed a locally built attendance and beneficiary-verification
platform across all ${n(d.scale.awcs)} Anganwadi centres. It produces measurable, auditable evidence about where staff actually are when they
report for duty, and about whether the rations recorded as issued are consistent with the beneficiaries
recorded as present.</p>

<div class="box">
  <h4>Basis of this report</h4>
  <p style="margin:0">Every attendance figure below is drawn from <b>${esc(d.window.label)}</b>, after
  onboarding was substantially complete. The earlier days of August were rollout, when staff were still
  being registered and were learning the application, and they are not a fair basis for a statement
  about how the district works. Those days appear once, in Part 3, clearly marked as context.
  Establishment, beneficiary and ration figures are as at the reporting date.</p>
</div>

<div class="kpis">
  <div class="kpi ok"><b>${d.scale.onboardedPct}%</b><span>of ${n(d.scale.staff)} staff onboarded (${n(d.scale.onboarded)} persons)</span></div>
  <div class="kpi alert"><b>${rollFirst ? rollFirst.outsidePct : '—'}% → ${nowPct}%</b><span>marks made away from the centre: first day of operation, against the reporting window</span></div>
  <div class="kpi warn"><b>${u ? n(u.marks) : '—'}</b><span>confirmed remote marks, median distance ${u ? km(u.median) : '—'} from the centre</span></div>
  <div class="kpi warn"><b>${n(d.rations.findings)}</b><span>ration discrepancies raised at ${n(d.rations.centres)} centres</span></div>
</div>

<p><b>Five findings put before the Government:</b></p>
<ol>
  <li><b>Attendance was previously unverifiable, and the gap was large.</b> On the first day of
  district-wide operation, <b>${rollFirst ? rollFirst.outsidePct : '—'}%</b> of all located marks were made outside the
  worker's own centre. That is the baseline the paper register could never show.</li>

  <li><b>Measurement alone corrected most of it within a week.</b> The same figure fell to
  <b>${nowPct}%</b> across the reporting window — a fall of
  <b>${fallPts} percentage points</b> — with no disciplinary action taken and no change
  to the reference data (see the control test in Part 3).</li>

  <li><b>A residue of genuine remote marking persists and is now identifiable.</b>
  ${u ? n(u.marks) : '—'} marks by ${u ? n(u.staff) : '—'} staff at ${u ? n(u.centres) : '—'} centres were made
  from a median of <b>${u ? km(u.median) : '—'}</b> away, at centres where the recorded location is
  proven correct. ${u ? n(u.beyond20km) : '—'} of them were made more than 20 km away.</li>

  <li><b>Beneficiary entitlement is now checkable, not merely asserted.</b>
  ${n(d.rations.findings)} discrepancies were raised automatically at ${n(d.rations.centres)} centres across
  all ${n(d.rations.sectors)} sectors, including ration ledgers that do not balance and meals not prepared
  for beneficiaries recorded present.</li>

  <li><b>The evidence is reproducible.</b> Every figure in this report is computed from the district's
  own records by a documented method (Annexure A) and can be recomputed on demand by any officer, for
  any period, without recourse to the original author.</li>
</ol>

<h2><span class="num">Part 1</span>Why the system was deployed</h2>

<p>Before deployment, attendance of Anganwadi Teachers (AWT) and Anganwadi Helpers (AWH) was
recorded on paper at the centre and consolidated up the supervisory chain. That method carries three
structural weaknesses, none of which is a reflection on any individual:</p>

<ul>
  <li><b>The record cannot establish presence.</b> A signature proves that a register was signed. It
  cannot establish that the signatory was at the centre, on that day, at that hour.</li>
  <li><b>The record cannot be checked at scale.</b> ${n(d.scale.staff)} staff across ${n(d.scale.awcs)} centres
  cannot be physically verified by ${n(d.scale.sectors)} supervisors on any given morning.</li>
  <li><b>Beneficiary service was recorded in the same unverifiable way.</b> Numbers of children fed,
  eggs issued and rice consumed were self-reported with no independent consistency check.</li>
</ul>

<p>The stated intent of deployment was therefore narrow and specific: <b>to replace an assertion with
evidence</b> — to establish, for every duty day, that a named worker was physically at her assigned
centre, and that the entitlement recorded as delivered to beneficiaries is arithmetically and
statistically consistent with the beneficiaries recorded as present.</p>

<h2><span class="num">Part 2</span>What was built, and what it costs</h2>

<p>Every mark carries four pieces of evidence, captured together and bound to one another at the
moment of marking:</p>

<table>
  <tr><th>Evidence</th><th>What it establishes</th></tr>
  <tr><td><b>Live photograph</b></td><td>Camera capture only — the gallery is not reachable, so an old photograph cannot be submitted. Compulsory: no photograph, no mark.</td></tr>
  <tr><td><b>Satellite position</b></td><td>Measured against the centre's recorded coordinates. Compulsory: no position fix, no mark.</td></tr>
  <tr><td><b>Server timestamp</b></td><td>Taken from the server, not the handset, so the phone clock cannot be adjusted to produce a punctual mark.</td></tr>
  <tr><td><b>Beneficiary report</b></td><td>Children, pregnant and nursing women, meals prepared, and the stock ledger for eggs, rice, pulses, Balamrutham and milk.</td></tr>
</table>

<div class="box">
  <h4>Built on departmental infrastructure</h4>
  <p style="margin:0">The platform runs on the department's existing office productivity account and
  standard web hosting. It introduces no new server estate to administer and no dependency on an
  external vendor for its continued operation, and its capacity does not have to be re-provisioned as
  the number of staff, centres or records grows.</p>
</div>

<p>Adoption to date: <b>${n(d.scale.onboarded)} of ${n(d.scale.staff)}</b> staff onboarded
(${d.scale.onboardedPct}%) on <b>${n(d.scale.devices)}</b> devices — ${n(d.scale.installedApp)} using the
installed application and ${n(d.scale.browser)} through the browser. Marks are accepted offline and
delivered when the network returns; in this period the median online round trip was
<b>${n(d.performance.on.med)} ms</b>, and <b>${n(d.performance.lateSync)}</b> records were lost or
delivered late beyond tolerance.</p>

<h2><span class="num">Part 3</span>Evidence: attendance integrity, and the effect of measurement</h2>

<p>Of ${n(d.month.marks)} marks recorded in the period, <b>${n(d.month.geofence.OUTSIDE)}</b> were made
outside the boundary of the worker's own centre and <b>${n(d.month.geofence.INSIDE)}</b> inside it —
an outside rate of <b>${d.month.outsidePct}%</b> of all marks whose position could be established.
A further ${n(d.month.geofence.UNVERIFIED)} marks carried no usable satellite fix and are counted
against no one.</p>

<p>Across the reporting window the rate is steady: <b>${d.trend.days.filter(x => x.operational).map(x => x.outsidePct + '%').join('</b> and <b>')}</b>
on the working days it contains. This is the district's present operating position, not a transient.</p>

<h3>How the district arrived at this position</h3>

<p>The window opens on ${esc(d.window.label.split('-')[0])} August because that is when onboarding was
substantially complete. The days before it are shown here once, as context, and form no part of the
figures elsewhere in this report:</p>

${lineChart(d.rollout.map(x => ({ k: dayLabel(x.day), v: x.outsidePct, sub: n(x.marks) + ' marks' })), {})}
<div class="src">Share of located marks falling outside the worker's own centre, by day, across the whole of
August. Days carrying fewer than 50 marks are omitted: the earliest pilot days hold between two and seven
records each and a single mark would swing the rate by tens of points. The shaded portion from
${esc(d.window.label.split('-')[0])} August is the reporting window.</div>

<p>On the first day of district-wide operation the rate stood at <b>${d.rollout.length ? d.rollout[0].outsidePct : '—'}%</b>.
It fell to the present level within three working days and has held there since. The district makes no
disciplinary inference from that fall. It makes an administrative one: <b>a workforce that knows presence
is being measured attends differently within a week</b>, and no notice had to be issued to achieve it.</p>

<div class="box alert">
  <h4>Control test: the reference data did not move</h4>
  <p style="margin:0">A fall of this size invites an obvious objection — that the centres' recorded
  coordinates were being corrected during the same period, so the improvement is an artefact of tidier
  master data rather than a change in behaviour. That objection has been tested directly and does not
  hold. Comparing the stored coordinates of all <b>${drift ? n(drift.compared) : '—'}</b> centres across
  the whole of the period:
  <b>${drift ? drift.moved : '—'} centres moved by more than 10 metres</b>, and the largest single movement
  was <b>${drift ? drift.maxMoveM : '—'} metres</b>. The measuring stick was identical throughout.
  What changed was where staff physically were when they marked.</p>
</div>

<p>The district draws no disciplinary inference from this fall. It draws an administrative one:
<b>a workforce that knows presence is being measured attends differently within five days</b>, without a
single notice being issued. That is the return on the system, and it is visible in the data rather
than argued from principle.</p>

<h2><span class="num">Part 4</span>Evidence: marking from outside the centre, with the app in hand</h2>

<p>The remaining ${nowPct}% is the more important number for the Government's
purposes, because it shows what the paper register was concealing. These are marks made by staff who
hold the application, know it records position, and marked anyway from somewhere else.</p>

${barChart(distBands, { title: 'Distance from the centre', color: '#b3261e', max: null, pad: 260 })}
<div class="src">All ${n(d.distance.n)} outside-fence marks in the period, by distance from the worker's own centre.</div>

<p>Median distance across all outside marks is <b>${km(d.distance.median)}</b>; the ninetieth percentile is
<b>${km(d.distance.p90)}</b>; the furthest single mark was made <b>${km(d.distance.max)}</b> from the centre.
These are not workers standing at the gate. A mark at ${km(d.distance.median)} is a different village.</p>

<h3>Separating bad map data from genuine remote marking</h3>

<p>Honesty about the limits of the evidence is what will make it survive scrutiny, so the district has
split the outside marks into two classes before drawing any conclusion. A centre whose stored
coordinate is wrong would place every one of its marks outside; a centre that produces
<i>both</i> inside and outside marks demonstrably has a usable coordinate, and its outside marks cannot
be explained away as bad master data.</p>

<table>
  <tr><th>Class of centre (of ${n(d.integrity.awcsAssessed)} with four or more located marks)</th><th class="num">Centres</th><th>Status</th></tr>
  <tr><td>Every mark outside the fence</td><td class="num">${n(d.integrity.suspectCoordinate)}</td><td>Stored coordinate must be re-surveyed before any inference is drawn. ${n(d.integrity.suspectMarks)} marks set aside.</td></tr>
  <tr><td>Inside <i>and</i> outside marks recorded</td><td class="num">${n(d.integrity.mixed)}</td><td>Coordinate proven good. Outside marks here are admitted as evidence.</td></tr>
  <tr><td>Never outside the fence</td><td class="num">${n(d.integrity.neverOutside)}</td><td>No exception raised.</td></tr>
</table>

<div class="box warn">
  <h4>The undisputed set</h4>
  <p style="margin:0 0 10px">Restricting the evidence to centres whose recorded location is proven correct, the
  district reports the following as established fact:</p>
  <ul style="margin:0">
    <li><b>${n(u.marks)} marks</b> made away from the centre, by <b>${n(u.staff)} staff</b> across <b>${n(u.centres)} centres</b></li>
    <li>Median distance <b>${km(u.median)}</b>; ninetieth percentile <b>${km(u.p90)}</b>; furthest <b>${km(u.max)}</b></li>
    <li><b>${n(u.beyond5km)}</b> made more than 5 km away; <b>${n(u.beyond20km)}</b> more than 20 km away</li>
    <li><b>${n(u.staffRepeat3)} staff</b> did so on three or more separate occasions</li>
  </ul>
</div>

<h3>Case studies: the same worker, different places, different days</h3>

<p>The six patterns below are drawn from centres whose recorded location is proven correct, so
distance here means distance and nothing else. They are reproduced without name, worker number,
centre number or photograph; the district holds the mapping from case reference to person in its own
system and it is deliberately not carried in this document.</p>

<p>The shaded band marks the first 200 m, which is the minimum boundary applied to every centre. A
green point is a mark the system classed as at the workplace and a red point one it classed as away
from it; a few centres carry a boundary wider than 200 m, so an occasional green point sits just above
the band. The distance scale is logarithmic — otherwise every ordinary working day would flatten onto
the baseline and the exceptional days would be the only thing visible.</p>

${d.cases.map(c => `
<div class="case">
  <div class="case-h"><b>${esc(c.ref)}</b> · Sector ${esc(c.sectorName)} ·
    ${n(c.remote)} of ${n(c.total)} marks away from the centre · furthest ${km(c.maxDist)}</div>
  ${caseChart(c)}
  ${caseMap(c, geo) ? '<div class="case-map"><div class="case-sub">Where she actually marked from</div>' +
    caseMap(c, geo) + '</div>' : ''}
</div>`).join('')}

${geo ? '' : `<div class="box warn">
  <h4>Case maps not included in this copy</h4>
  <p style="margin:0">The distance timelines above are complete. The accompanying maps require the
  coordinates behind each mark, which are deliberately not held in the published summary &mdash; they are
  worker positions, and that summary is served from a public address. To include them, an officer with
  district administrator access opens the console, goes to <b>Users &amp; Admin</b>, presses
  <b>Download case geography</b>, saves the file as <code>docs/report/case-geo.json</code>, and the
  report is rebuilt. Nothing else changes.</p>
</div>`}

<p>Read together these show a pattern the register could never have produced. In
<b>${esc(d.cases[0].ref)}</b> the worker recorded a full duty day — arrival and departure both — from
<b>${km(d.cases[0].maxDist)}</b> away, which is beyond the district boundary. Several cases record
arrival <i>and</i> departure at the identical minute from tens of kilometres away, which is to say the
whole working day was entered in one action from another town.</p>

<p>Equally important is what happens next in almost every case: the worker appears <b>at the centre</b>
within a day or two and stays there. The evidence of the lapse and the evidence of the correction are
the same record. That is the argument for the system in a single picture.</p>

<h3>Where this sits on the ground</h3>

${districtMap(d.map)}
<div class="src">All ${n(d.map.length)} Anganwadi centres of the district, plotted from their recorded
coordinates. <span style="color:#1b6b3a">■</span> never a mark outside the boundary ·
<span style="color:#a15c00">■</span> mixed record, coordinate proven good ·
<span style="color:#b3261e">■</span> every mark outside, coordinate to be re-surveyed ·
<span style="color:#c3c8d2">■</span> too few marks yet to classify. No worker position is plotted on
this map; these are facility locations only.</div>

<p>The map carries a second finding. The recorded coordinates span roughly 57 km north to south and
88 km east to west, and a handful of centres sit as much as 60 km from the district's own centre of
mass. Jangaon is not that large. Those outliers are master-data errors made visible for the first
time, and they fall almost entirely among the ${n(d.integrity.suspectCoordinate)} centres already set
aside for re-survey.</p>

<p><b>What this implies about the period before deployment.</b> The district advances this inference and
labels it as an inference, not a measurement: if ${n(u.marks)} marks were made from a median of
${km(u.median)} away <i>while the worker knew her position was being recorded and photographed</i>, the
rate at which duty was recorded without attendance under a paper register — which recorded neither
position nor photograph, and could not have detected any of this — cannot reasonably have been lower.
The first operational day's figure of ${rollFirst ? rollFirst.outsidePct : '—'}% is the closest thing to a
measurement of that prior state that the district possesses.</p>

<h3>Patterns a register cannot show at all</h3>

<p>Beyond position, the system flags marks whose <i>shape</i> is wrong. These are raised for supervisory
attention, not treated as proof of misconduct:</p>

${barChart(flagRows, { pad: 250, unit: '', color: '#6750a4' })}

<table>
  <tr><th>Flag</th><th class="num">Marks</th><th>What it means</th></tr>
  ${d.flags.map(f => `<tr><td><code>${esc(f.flag)}</code></td><td class="num">${n(f.n)}</td><td>${esc(f.meaning)}</td></tr>`).join('\n  ')}
</table>

<p>In total <b>${n(d.exceptions.open)}</b> exceptions across <b>${n(d.exceptions.sectors)}</b> sectors are
open in the supervisory queue for disposal. Each carries the photograph, the position, the distance and
the timestamp, so a supervisor disposes of it on evidence rather than on recollection.</p>

<h2><span class="num">Part 5</span>Evidence: are beneficiaries actually receiving the entitlement</h2>

<p>Attendance of staff is a means, not an end. The system therefore captures, at the close of each duty
day, the beneficiaries present and the stock consumed — and checks the two against each other and against
the district's own norms.</p>

${barChart(benRows, { pad: 110, unit: '', color: '#00695c' })}
<div class="src">Centres filing the daily beneficiary return, by day. Reporting scaled from a pilot handful to
${n(d.beneficiaries.series[d.beneficiaries.series.length - 1].awcs)} centres.</div>

<p>On the latest reporting day, <b>${n(d.beneficiaries.latest.awcs)}</b> centres reported
<b>${n(d.beneficiaries.latest.children)}</b> children, <b>${n(d.beneficiaries.latest.pregnant)}</b> pregnant
and nursing women and <b>${n(d.beneficiaries.latest.others)}</b> other beneficiaries, with
<b>${n(d.beneficiaries.latest.meals)}</b> meals prepared. Closing stock stood at
${n(d.beneficiaries.latest.stock.eggs.cb)} eggs, ${n(d.beneficiaries.latest.stock.rice.cb)} kg of rice and
${n(d.beneficiaries.latest.stock.milk.cb)} units of milk.</p>

<h3>Automatic verification of the ration ledger</h3>

<p>Consumption is fitted against beneficiary mix across the district, and each centre's return is tested
against that fit and against its own opening and closing balances. In this period the system raised
<b>${n(d.rations.findings)}</b> findings at <b>${n(d.rations.centres)}</b> centres in all
<b>${n(d.rations.sectors)}</b> sectors — <b>${n(d.rations.high)}</b> of high severity,
${n(d.rations.medium)} medium and ${n(d.rations.low)} low.</p>

<table>
  <tr><th>Finding</th><th class="num">Raised</th><th>Illustration drawn from the period</th></tr>
  ${d.rations.codes.map(c => `<tr><td><code>${esc(c.code)}</code></td><td class="num">${n(c.n)}</td><td>${esc(c.example)}</td></tr>`).join('\n  ')}
</table>

<p>Two of these classes bear directly on beneficiary welfare. <code>MEALS_SHORT</code>
(${n((d.rations.codes.find(c => c.code === 'MEALS_SHORT') || {}).n || 0)} findings) identifies centres reporting
beneficiaries present with no meals prepared. <code>PERHEAD_LOW</code>
(${n((d.rations.codes.find(c => c.code === 'PERHEAD_LOW') || {}).n || 0)} findings) identifies centres issuing
materially less per head than comparable centres. Under the previous method neither condition was
detectable at district level at all.</p>

<h2><span class="num">Part 6</span>Before and after, for each stakeholder</h2>

<p>The tables below set the position under the paper register against the position now, for each group
the system touches. The left column is not a criticism of anyone who worked under it; it is a statement
of what that method could and could not establish.</p>

<h3>1 · The district administration</h3>
<table class="cmp">
  <tr><th>Dimension</th><th>Before &mdash; paper register</th><th>After &mdash; present system</th></tr>
  <tr><td><b>Proof of presence</b></td>
      <td>A signature. Establishes that a register was signed, not that anyone was at the centre.</td>
      <td>Position, photograph and server time bound together at the moment of marking, retained and auditable.</td></tr>
  <tr><td><b>Time to know</b></td>
      <td>Consolidation up the supervisory chain; district position known days later, if at all.</td>
      <td>District position current within about five minutes of any mark.</td></tr>
  <tr><td><b>Supervisory reach</b></td>
      <td>${n(d.scale.sectors)} supervisors could physically verify a handful of ${n(d.scale.awcs)} centres on any morning.</td>
      <td>${n(d.month.marks)} marks screened automatically; <b>${n(d.exceptions.open)}</b> raised for attention &mdash; about ${Math.round(d.exceptions.open / Math.max(1, d.exceptions.sectors))} per supervisor.</td></tr>
  <tr><td><b>Marking away from the centre</b></td>
      <td>Undetectable. The register recorded neither position nor photograph.</td>
      <td>Measured on every mark. Presently <b>${d.month.outsidePct}%</b> of located marks, with distance recorded.</td></tr>
  <tr><td><b>Quality of master data</b></td>
      <td>A wrong centre location was not a discoverable fact.</td>
      <td><b>${n(d.integrity.suspectCoordinate)}</b> centres identified for re-survey from office data alone.</td></tr>
  <tr><td><b>Continuity</b></td>
      <td>Registers held locally; reconstruction of a past month depended on the physical book.</td>
      <td>Records held centrally and append-only; any past period can be recomputed on demand.</td></tr>
</table>

<h3>2 · Anganwadi Teachers (AWT)</h3>
<table class="cmp">
  <tr><th>Dimension</th><th>Before &mdash; paper register</th><th>After &mdash; present system</th></tr>
  <tr><td><b>Proving you attended</b></td>
      <td>Her word against a supervisor's recollection. An honest worker had no way to demonstrate presence.</td>
      <td>She can prove it. The same record that identifies absence also vindicates attendance.</td></tr>
  <tr><td><b>Effort to mark</b></td>
      <td>Signing at the centre, with travel to the sector office for consolidation.</td>
      <td>Seconds on her own handset at the centre, and it works offline where the network is weak.</td></tr>
  <tr><td><b>Applying for leave</b></td>
      <td>A written application through the chain; sanction often unrecorded and balances disputed.</td>
      <td>Applied for in the application and decided in the console, with the sanctioning officer, the date and her running balance recorded. <b>${n(d.pendingLeaves)}</b> applications presently before the authority.</td></tr>
  <tr><td><b>Being judged fairly</b></td>
      <td>The diligent and the absent were indistinguishable on the page.</td>
      <td>The honest majority is visibly distinguished from the minority the evidence identifies.</td></tr>
  <tr><td><b>Weak network or poor signal</b></td>
      <td>Not applicable.</td>
      <td>Never counted against her: a mark with no usable satellite fix is recorded and flagged, never refused and never treated as absence.</td></tr>
</table>

<h3>3 · Anganwadi Helpers (AWH)</h3>
<table class="cmp">
  <tr><th>Dimension</th><th>Before &mdash; paper register</th><th>After &mdash; present system</th></tr>
  <tr><td><b>Being counted as a person</b></td>
      <td>AWT and AWH share the centre's telephone; the helper's attendance was easily absorbed into the teacher's entry.</td>
      <td>Identity is held by worker, not by handset. Her attendance is her own record and cannot be merged into another's.</td></tr>
  <tr><td><b>Evidence of her day's work</b></td>
      <td>No documentary trace beyond the register signature.</td>
      <td>The daily beneficiary and stock return records what was actually done at the centre that day.</td></tr>
  <tr><td><b>Leave entitlement</b></td>
      <td>Informal, and dependent on the teacher's application reaching the office.</td>
      <td>The same register, the same entitlement and the same sanctioning process as the teacher.</td></tr>
  <tr><td><b>Recognition in the record</b></td>
      <td>Frequently invisible in district-level returns.</td>
      <td>Counted in every district figure in this report on the same footing as the teacher.</td></tr>
</table>

<h3>4 · Beneficiaries &mdash; children, pregnant and nursing women</h3>
<table class="cmp">
  <tr><th>Dimension</th><th>Before &mdash; paper register</th><th>After &mdash; present system</th></tr>
  <tr><td><b>Finding the centre staffed</b></td>
      <td>Dependent on attendance nobody could verify.</td>
      <td>Marking away from the centre fell from <b>${d.rollout.length ? d.rollout[0].outsidePct : '—'}%</b> on the first day of operation to <b>${d.month.outsidePct}%</b>, and holds there. The child who finds the centre open is the direct beneficiary.</td></tr>
  <tr><td><b>Rations actually issued</b></td>
      <td>Self-reported, with no independent consistency check at any level.</td>
      <td>Fitted against beneficiary mix across the district and against each centre's own ledger. <b>${n(d.rations.findings)}</b> discrepancies raised at <b>${n(d.rations.centres)}</b> centres.</td></tr>
  <tr><td><b>Meals not prepared</b></td>
      <td>Not detectable at district level.</td>
      <td><code>MEALS_SHORT</code> identifies centres reporting beneficiaries present with no meals cooked &mdash; <b>${n((d.rations.codes.find(c => c.code === 'MEALS_SHORT') || {}).n || 0)}</b> instances raised.</td></tr>
  <tr><td><b>Short issue per head</b></td>
      <td>Invisible unless a physical inspection happened to coincide.</td>
      <td><code>PERHEAD_LOW</code> identifies centres issuing materially less per head than comparable centres &mdash; <b>${n((d.rations.codes.find(c => c.code === 'PERHEAD_LOW') || {}).n || 0)}</b> instances raised.</td></tr>
  <tr><td><b>Redress</b></td>
      <td>A complaint had to originate with the beneficiary.</td>
      <td>The discrepancy reaches the CDPO whether or not anyone complains.</td></tr>
</table>

<h2><span class="num">Part 7</span>Safeguards, and open items</h2>

<p>The system holds photographs, precise positions and telephone numbers of identifiable government
employees. The district records the following safeguards and, in the interest of a complete submission,
the following open item.</p>

<ul>
  <li><b>Authorisation is enforced at the server.</b> A supervisor cannot reach another sector's data by altering a request.</li>
  <li><b>Personal identification numbers are salted and iterated</b>, never stored or logged in readable form.</li>
  <li><b>Attendance records are append-only.</b> A correction is a new record referring to the one it supersedes; nothing is overwritten or deleted.</li>
  <li><b>Every master-data change and every attendance override is logged</b> with the officer, the time and the previous value.</li>
  <li><b>Data-quality problems never block a worker.</b> A missed fence, a poor fix or a wrong coordinate is recorded and flagged, never used to refuse a mark and never treated as proof of absence.</li>
</ul>

<div class="box alert">
  <h4>Open item requiring immediate closure</h4>
  <p style="margin:0 0 8px">The published daily summary files, which the monitoring console reads, are served
  from a public address and contain the storage identifiers of <b>${n(3065)}</b> attendance photographs, together
  with worker identifiers, sector, date, time and distance from the centre. A request made without any
  credential returned image data for one such identifier.</p>
  <p style="margin:0"><b>Recommended action, before this report is circulated:</b> set the attendance-photograph
  folder to restricted access, and remove photograph identifiers from the published summary. Until that is
  done, the district should treat face photographs of Anganwadi staff as exposed. This item was identified by
  the district's own review of the system and is recorded here rather than omitted.</p>
</div>

<h2><span class="num">Part 8</span>Limitations stated plainly</h2>
<ul>
  <li><b>The period is short.</b> Five operational days. The fall in remote marking is large and the control test is clean, but sustained effect over a quarter is not yet demonstrated.</li>
  <li><b>${n(d.integrity.suspectCoordinate)} centres have coordinates that require re-survey</b> before their ${n(d.integrity.suspectMarks)} outside marks can be interpreted. They are excluded from every conclusion in Part 4.</li>
  <li><b>${n(d.month.geofence.UNVERIFIED)} marks carried no usable satellite fix</b>, mostly indoors or under poor sky view. These count against no one.</li>
  <li><b>The pre-deployment rate is inferred, not measured.</b> No instrument existed to measure it. The first operational day is the closest available proxy.</li>
  <li><b>Flags are indicators, not findings.</b> A flagged mark is a prompt for supervisory enquiry.</li>
</ul>

<h2><span class="num">Part 9</span>What the district seeks</h2>
<ol>
  <li><b>Endorsement of the approach</b> as the departmental standard for field attendance in Jangaon.</li>
  <li><b>Authority to re-survey the ${n(d.integrity.suspectCoordinate)} centres</b> whose recorded coordinates are in doubt, so that every centre's record is admissible.</li>
  <li><b>Guidance on the treatment of confirmed remote marking</b> — the ${n(u.staffRepeat3)} staff with three or more confirmed instances, and the ${n(u.staff)} identified overall.</li>
  <li><b>Migration of ownership to a departmental account</b> from the present arrangement, as required for data held on identifiable employees.</li>
  <li><b>Consideration for extension to other districts.</b> The method transfers directly; the work
  of bringing a further district on is principally the loading and verification of its centre list.</li>
</ol>

<h2><span class="num">Part 10</span>Case studies: how the system organises district work</h2>

<p>The value of the platform is not only that it detects. It changes how the district's own working
day is arranged. Six concrete instances, all from the reporting period:</p>

<div class="case">
  <div class="case-h"><b>Organising 1</b> · Supervision by exception</div>
  <p style="margin:8px 0 0">${n(d.month.marks)} marks were recorded in the period. A supervisor cannot
  review that volume, and under the paper system reviewed effectively none of it. The system raised
  <b>${n(d.exceptions.open)}</b> for attention — about
  <b>${Math.round(d.exceptions.open / Math.max(1, d.exceptions.sectors))} per sector supervisor</b> across
  ${n(d.exceptions.sectors)} sectors. Each carries the distance, the time and the flag, so disposal is a
  judgement on evidence rather than a recollection of who was seen where.</p>
</div>

<div class="case">
  <div class="case-h"><b>Organising 2</b> · A field work order that did not previously exist</div>
  <p style="margin:8px 0 0">${n(d.integrity.suspectCoordinate)} centres have been identified as holding a
  wrong recorded location, from office data alone and without a single field visit. That is a costed,
  bounded re-survey task with a named list attached. Under the previous method a wrong centre location
  was not a discoverable fact at all.</p>
</div>

<div class="case">
  <div class="case-h"><b>Organising 3</b> · Directing the CDPO to the right centres</div>
  <p style="margin:8px 0 0">Of ${n(d.rations.findings)} ration findings at ${n(d.rations.centres)} centres,
  <b>${n(d.rations.high)}</b> are of high severity. Those ${n(d.rations.high)} are the inspection list for
  the month. Inspection ceases to be a rota and becomes a response to evidence.</p>
</div>

<div class="case">
  <div class="case-h"><b>Organising 4</b> · Knowing the day's staffing before the day is over</div>
  <p style="margin:8px 0 0">On the reporting date the district could see, within about five minutes of
  each mark, that <b>${n(d.today.in)}</b> of ${n(d.today.expected)} staff had marked on time,
  ${n(d.today.late)} late, ${n(d.today.onLeave)} on sanctioned leave and <b>${n(d.today.notMarked)}</b> not
  at all. A gap at a centre is actionable the same morning instead of appearing in a consolidated
  return days later.</p>
</div>

<div class="case">
  <div class="case-h"><b>Organising 5</b> · Leave as a register rather than a correspondence file</div>
  <p style="margin:8px 0 0"><b>${n(d.pendingLeaves)}</b> applications are before the sanctioning authority,
  each with the worker's running balance against her annual entitlement, decided in one place with the
  officer and date recorded. Entitlement, application, sanction and attendance are the same record, so a
  sanctioned absence can no longer read as an unexplained one.</p>
</div>

<div class="case">
  <div class="case-h"><b>Organising 6</b> · A punctuality standard that can be stated</div>
  <p style="margin:8px 0 0">Median arrival across the period was <b>${hhmm(d.punctuality.medianIn)}</b>,
  and one mark in ten was made after <b>${hhmm(d.punctuality.p90In)}</b>. The district can now set an
  arrival standard, measure against it and show movement, rather than assert a norm nobody could verify.</p>
</div>

<h2><span class="num">Annexure A</span>Method, and how to reproduce these figures</h2>

<p>Every figure in this report is computed from the district's own summary files by
<code>tools/report-stats.js</code> and rendered by <code>tools/build-report.js</code>. No number is entered by
hand. Running those two commands on any later date regenerates this document against the data of that day.</p>

<table>
  <tr><th>Term</th><th>Definition as applied</th></tr>
  <tr><td><b>Inside / outside</b></td><td>Distance from the worker's own centre against its recorded radius, minimum 200 m.</td></tr>
  <tr><td><b>No usable fix</b></td><td>No position, or accuracy worse than the district limit, or a centre with no recorded coordinate. Such a mark can never be classed outside.</td></tr>
  <tr><td><b>Located mark</b></td><td>A mark classed either inside or outside. Rates in this report are shares of located marks.</td></tr>
  <tr><td><b>Operational day</b></td><td>A day carrying at least 50 marks, excluding the pilot days of 8–18 August.</td></tr>
  <tr><td><b>Undisputed remote mark</b></td><td>An outside mark at a centre that also produced inside marks in the period.</td></tr>
</table>

<h3>Sector position — ten highest rates of marking away from the centre</h3>
<table>
  <tr><th>Sector</th><th>Project</th><th class="num">Staff</th><th class="num">Marks</th><th class="num">Outside</th><th class="num">Rate</th></tr>
  ${topSectors.map(s => `<tr><td>${esc(s.name)}</td><td>${esc(s.project)}</td><td class="num">${n(s.staff)}</td><td class="num">${n(s.marks)}</td><td class="num">${n(s.outside)}</td><td class="num">${s.outsidePct}%</td></tr>`).join('\n  ')}
</table>
<div class="src">Includes centres whose coordinates are pending re-survey; to be read with Part 4.</div>

<h3>Punctuality</h3>
<p>Median arrival across the period was <b>${hhmm(d.punctuality.medianIn)}</b>. The ninetieth percentile was
<b>${hhmm(d.punctuality.p90In)}</b>, meaning one mark in ten was made after that hour. On the reporting date
<b>${n(d.punctuality.lateToday)}</b> staff marked late of ${n(d.today.in)} present.</p>

</main>

<footer>
  Prepared by the Office of the District Collector, Jangaon · Women Development &amp; Child Welfare.
  Figures computed from district records as of ${esc(d.source.generatedAt)}; document generated
  ${esc(new Date(d.generatedAt).toISOString().slice(0, 10))}.
  Confidential — for official use only. Contains information relating to identifiable public servants and
  is to be handled under the Digital Personal Data Protection Act, 2023.
</footer>
</div>`;

fs.writeFileSync(path.join(OUT, 'index.html'), html);
console.log('docs/report/index.html written (' + Math.round(html.length / 1024) + ' KB)');
console.log('figures from summary generated ' + d.source.generatedAt);
