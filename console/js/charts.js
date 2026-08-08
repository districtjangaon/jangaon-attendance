'use strict';
/**
 * Tiny dependency-free SVG chart toolkit (bar, line, donut, heatmap,
 * sparkline). Hand-rolled so the console stays self-contained and works
 * with no CDN, no build step, and on a projector with flaky internet.
 * All charts scale via viewBox; colors from one shared palette.
 */
const Charts = (() => {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const PAL = ['#1e8e3e', '#4285f4', '#f4b400', '#e37400', '#c5221f', '#7b1e3c', '#00897b', '#546e7a'];

  function niceMax(v) {
    if (v <= 5) return 5;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  /** Vertical bars. items: [{label, value, color?, title?}]. opts: {h, pct} */
  function bar(items, opts) {
    opts = opts || {};
    if (!items.length) return '<p class="info">No data.</p>';
    const H = opts.h || 160, PB = 34, PT = 14, PL = 30;
    const bw = 34, gap = 14;
    const W = PL + items.length * (bw + gap) + 10;
    const max = opts.pct ? 100 : niceMax(Math.max(...items.map(i => i.value)));
    let s = '';
    items.forEach((it, i) => {
      const h = max ? (it.value / max) * (H - PB - PT) : 0;
      const x = PL + i * (bw + gap);
      s += '<rect x="' + x + '" y="' + (H - PB - h).toFixed(1) + '" width="' + bw +
        '" height="' + h.toFixed(1) + '" rx="3" fill="' + (it.color || PAL[0]) + '">' +
        '<title>' + esc(it.title || (it.label + ': ' + it.value)) + '</title></rect>' +
        '<text x="' + (x + bw / 2) + '" y="' + (H - PB - h - 4).toFixed(1) +
        '" font-size="11" text-anchor="middle" fill="#444">' +
        esc(it.value + (opts.pct ? '%' : '')) + '</text>' +
        '<text x="' + (x + bw / 2) + '" y="' + (H - PB + 13) +
        '" font-size="10" text-anchor="middle" fill="#777">' + esc(it.label) + '</text>';
    });
    s += '<line x1="' + PL + '" y1="' + (H - PB) + '" x2="' + (W - 4) + '" y2="' + (H - PB) + '" stroke="#ddd"/>';
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;max-width:' + (W * 1.4) + 'px">' + s + '</svg>';
  }

  /** Multi-series line/area. labels: x labels. series: [{name,color,values,area?}] */
  function line(labels, series, opts) {
    opts = opts || {};
    const n = labels.length;
    if (!n || !series.length) return '<p class="info">No data.</p>';
    const W = opts.w || 560, H = opts.h || 190, PB = 26, PT = 14, PL = 34;
    const max = opts.pct ? 100 : niceMax(Math.max(1, ...series.flatMap(s => s.values.filter(v => v != null))));
    const x = i => PL + (n === 1 ? 0 : (i / (n - 1)) * (W - PL - 10));
    const y = v => PT + (1 - v / max) * (H - PB - PT);
    let s = '';
    [0, 0.5, 1].forEach(f => {
      const vy = PT + f * (H - PB - PT);
      s += '<line x1="' + PL + '" y1="' + vy + '" x2="' + (W - 8) + '" y2="' + vy + '" stroke="#eee"/>' +
        '<text x="' + (PL - 4) + '" y="' + (vy + 4) + '" font-size="10" text-anchor="end" fill="#999">' +
        Math.round(max * (1 - f)) + (opts.pct ? '%' : '') + '</text>';
    });
    series.forEach((sr, si) => {
      const col = sr.color || PAL[si % PAL.length];
      let d = '', open = false;
      sr.values.forEach((v, i) => {
        if (v == null) { open = false; return; }
        d += (open ? ' L' : ' M') + x(i).toFixed(1) + ',' + y(v).toFixed(1);
        open = true;
      });
      if (sr.area) {
        let firstI = sr.values.findIndex(v => v != null), lastI = -1;
        sr.values.forEach((v, i) => { if (v != null) lastI = i; });
        if (firstI >= 0) {
          s += '<path d="' + d + ' L' + x(lastI).toFixed(1) + ',' + y(0) + ' L' + x(firstI).toFixed(1) +
            ',' + y(0) + ' Z" fill="' + col + '" opacity=".13"/>';
        }
      }
      s += '<path d="' + d + '" fill="none" stroke="' + col + '" stroke-width="2"/>';
      sr.values.forEach((v, i) => {
        if (v == null) return;
        s += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="2.5" fill="' + col + '">' +
          '<title>' + esc(labels[i] + ' — ' + sr.name + ': ' + v + (opts.pct ? '%' : '')) + '</title></circle>';
      });
    });
    const step = Math.ceil(n / 12);
    labels.forEach((l, i) => {
      if (i % step) return;
      s += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 8) +
        '" font-size="10" text-anchor="middle" fill="#777">' + esc(l) + '</text>';
    });
    const legend = series.map((sr, si) => '<div><i style="background:' +
      (sr.color || PAL[si % PAL.length]) + '"></i>' + esc(sr.name) + '</div>').join('');
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%">' + s + '</svg>' +
      '<div class="legend legend-row">' + legend + '</div>';
  }

  /** Donut. parts: [{label, value}] */
  function donut(parts, opts) {
    const total = parts.reduce((s, p) => s + p.value, 0);
    if (!total) return '<p class="info">No data.</p>';
    const R = 45, C = 2 * Math.PI * R;
    let off = 0, s = '';
    parts.forEach((p, i) => {
      if (!p.value) return;
      const frac = p.value / total;
      s += '<circle r="' + R + '" cx="60" cy="60" fill="none" stroke="' + PAL[i % PAL.length] +
        '" stroke-width="22" stroke-dasharray="' + (frac * C).toFixed(2) + ' ' + C.toFixed(2) +
        '" stroke-dashoffset="' + (-off * C).toFixed(2) + '" transform="rotate(-90 60 60)">' +
        '<title>' + esc(p.label + ': ' + p.value) + '</title></circle>';
      off += frac;
    });
    const legend = parts.map((p, i) => '<div><i style="background:' + PAL[i % PAL.length] + '"></i>' +
      esc(p.label) + ' — ' + p.value + '</div>').join('');
    return '<div class="chartwrap"><svg width="130" height="130" viewBox="0 0 120 120">' + s +
      '<text x="60" y="66" text-anchor="middle" font-size="20" font-weight="700">' +
      ((opts && opts.center) || total) + '</text></svg><div class="legend">' + legend + '</div></div>';
  }

  /** Heatmap grid. rows: [{label, cells: [{v: 0..1|null, title}]}] */
  function heatmap(rows, colLabels) {
    if (!rows.length) return '<p class="info">No data.</p>';
    const cw = 20, ch = 20, PL = 130, PT = 20;
    const W = PL + colLabels.length * cw + 6, H = PT + rows.length * ch + 6;
    const color = v => v == null ? '#f2f2f2'
      : v < 0 ? '#e3f0fb' // special: leave/holiday
      : 'hsl(' + Math.round(v * 120) + ' 65% ' + Math.round(88 - v * 38) + '%)';
    let s = '';
    colLabels.forEach((c, i) => {
      if (i % 2) return;
      s += '<text x="' + (PL + i * cw + cw / 2) + '" y="' + (PT - 6) +
        '" font-size="9" text-anchor="middle" fill="#888">' + esc(c) + '</text>';
    });
    rows.forEach((r, ri) => {
      s += '<text x="' + (PL - 6) + '" y="' + (PT + ri * ch + ch / 2 + 3) +
        '" font-size="10" text-anchor="end" fill="#555">' + esc(String(r.label).slice(0, 20)) + '</text>';
      r.cells.forEach((c, ci) => {
        s += '<rect x="' + (PL + ci * cw) + '" y="' + (PT + ri * ch) + '" width="' + (cw - 2) +
          '" height="' + (ch - 2) + '" rx="3" fill="' + color(c.v) + '">' +
          '<title>' + esc(c.title || '') + '</title></rect>';
      });
    });
    return '<div class="tablewrap"><svg width="' + W + '" height="' + H +
      '" viewBox="0 0 ' + W + ' ' + H + '">' + s + '</svg></div>';
  }

  /** Inline sparkline for table cells. */
  function spark(values, color) {
    const W = 90, H = 22;
    const vals = values.map(v => v == null ? 0 : v);
    const max = Math.max(1, ...vals);
    const x = i => 2 + (i / Math.max(1, vals.length - 1)) * (W - 4);
    const y = v => H - 3 - (v / max) * (H - 6);
    let d = '';
    vals.forEach((v, i) => { d += (i ? ' L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1); });
    return '<svg width="' + W + '" height="' + H + '"><path d="' + d + '" fill="none" stroke="' +
      (color || PAL[0]) + '" stroke-width="1.6"/></svg>';
  }

  return { bar: bar, line: line, donut: donut, heatmap: heatmap, spark: spark, PAL: PAL };
})();
