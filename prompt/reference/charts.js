'use strict';
/**
 * Dependency-free chart toolkit. No CDN, no build step — the console has to
 * open on a filtered government network and on a projector with flaky wifi.
 *
 * WHY MAGNITUDE CHARTS ARE HTML, NOT SVG. A bar chart in a scaled viewBox
 * ties its row height to its row COUNT: a 10-row chart and a 3-row chart in
 * neighbouring cards end up with visibly different bar thicknesses and
 * baselines, which is what made the old dashboard look ragged. Laying bars out
 * in HTML pins every row to an exact pixel height regardless of how many rows
 * there are, so cards line up across the grid. Arcs, lines and grids stay SVG,
 * where the geometry actually needs it.
 *
 * COLOUR. The palette below is validated, not eyeballed — every adjacent pair
 * clears the colourblind and normal-vision separation floors against this
 * console's own surfaces, in both themes. Slots are assigned in fixed order and
 * never cycled or generated. Amber and sky sit below 3:1 against white, so
 * every chart that uses them also carries a direct label (the relief rule).
 * All ink, grid and surface colours come from CSS custom properties, so dark
 * mode is a real second palette rather than an accidental inversion.
 *
 * GRADIENTS are single-hue by construction — the same colour at two opacities,
 * never a second hue — so a bar can never imply a value it doesn't hold.
 */
const Charts = (() => {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Every colour is a CSS token, defined once per theme in console.css and
  // validated against that theme's own surface. Charts therefore recolour on
  // the theme toggle without being re-rendered.
  //
  // Categorical: fixed order, never cycled past slot 8 — fold into "Other".
  const PAL = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)',
    'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];

  // Ordered scales (time bands, tiers): one hue, least -> most. A rainbow here
  // would imply identity where the data only has rank.
  const ORD = ['var(--o1)', 'var(--o2)', 'var(--o3)', 'var(--o4)', 'var(--o5)'];

  // Reserved: these mean good / warning / bad, and are never used as series 4.
  const STATUS = { ok: 'var(--st-ok)', warn: 'var(--st-warn)',
    bad: 'var(--st-bad)', idle: 'var(--st-idle)' };

  let uid = 0;
  const nextId = () => 'cg' + (++uid);

  function niceMax(v) {
    if (v <= 5) return 5;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  const fmt = n => (typeof n === 'number' && isFinite(n))
    ? (Math.abs(n) >= 1000 ? n.toLocaleString('en-IN') : String(n)) : String(n);

  const empty = msg => '<p class="chart-empty">' + esc(msg || 'No data yet.') + '</p>';

  /**
   * Single-hue wash: the same colour fading toward the surface. Declared
   * twice so a browser without color-mix() still gets a solid fill of the
   * right hue rather than no background at all.
   */
  const grad = (color, dir) => {
    const d = dir || '180deg';
    return 'background:linear-gradient(' + d + ',' + color + ' 0%,' + color + ' 100%);' +
      'background:linear-gradient(' + d + ',' + color + ' 0%,' +
      'color-mix(in srgb,' + color + ' 62%, transparent) 100%)';
  };

  // ---------------- columns (HTML) ----------------
  /**
   * Vertical bars. items: [{label, value, color?, title?}]. opts: {pct, max}
   * One series gets ONE colour: colouring each bar differently would double
   * encode height as hue and burn the only free channel on nothing.
   */
  function bar(items, opts) {
    opts = opts || {};
    if (!items || !items.length) return empty(opts.emptyMsg);
    const max = opts.pct ? 100 : niceMax(Math.max(1, ...items.map(i => i.value)));
    const base = opts.color || PAL[0];
    const cols = items.map(it => {
      const c = it.color || base;
      const pc = Math.max(0, Math.min(100, (it.value / max) * 100));
      return '<div class="c-col" title="' + esc(it.title || (it.label + ': ' + it.value)) + '">' +
        '<span class="c-colv">' + esc(fmt(it.value) + (opts.pct ? '%' : '')) + '</span>' +
        '<span class="c-colbar" style="height:' + pc.toFixed(1) + '%;' + grad(c) + '"></span>' +
        '<span class="c-collab">' + esc(it.label) + '</span>' +
      '</div>';
    }).join('');
    return '<div class="c-cols">' + cols + '</div>';
  }

  // ---------------- horizontal bars (HTML) ----------------
  /**
   * Horizontal bars — the right form when labels are long (sector names).
   * Rows are a fixed pixel height, so two of these side by side line up
   * whatever their row counts.
   */
  function hbar(items, opts) {
    opts = opts || {};
    if (!items || !items.length) return empty(opts.emptyMsg);
    const max = opts.pct ? 100 : niceMax(Math.max(1, ...items.map(i => i.value)));
    const base = opts.color || PAL[0];
    const rows = items.map(it => {
      const c = it.color || base;
      const pc = Math.max(1.5, Math.min(100, (it.value / max) * 100));
      return '<div class="c-row" title="' + esc(it.title || (it.label + ': ' + it.value)) + '">' +
        '<span class="c-rowlab">' + esc(it.label) + '</span>' +
        '<span class="c-track"><span class="c-fill" style="width:' + pc.toFixed(1) +
          '%;' + grad(c, '90deg') + '"></span></span>' +
        '<span class="c-rowv">' + esc(fmt(it.value) + (opts.pct ? '%' : '')) + '</span>' +
      '</div>';
    }).join('');
    return '<div class="c-rows">' + rows + '</div>';
  }

  // ---------------- meter (HTML) ----------------
  /**
   * One ratio against a limit. This replaces the two-slice donuts the
   * dashboard used to carry: a pie of two numbers is a stat tile wearing a
   * costume, and it reads worse than the number it is hiding.
   */
  function meter(value, total, opts) {
    opts = opts || {};
    if (!total) return empty(opts.emptyMsg);
    const pc = Math.max(0, Math.min(100, (value / total) * 100));
    const c = opts.color || PAL[0];
    return '<div class="c-meter">' +
      '<div class="c-meterhead"><b class="c-meterv">' + Math.round(pc) + '%</b>' +
        '<span class="c-metersub">' + esc(fmt(value)) + ' of ' + esc(fmt(total)) +
        (opts.unit ? ' ' + esc(opts.unit) : '') + '</span></div>' +
      '<div class="c-metertrack" title="' + esc(fmt(value) + ' of ' + fmt(total)) + '">' +
        '<div class="c-meterfill" style="width:' + pc.toFixed(1) + '%;' +
          grad(c, '90deg') + '"></div></div>' +
      (opts.foot ? '<div class="c-meterfoot">' + esc(opts.foot) + '</div>' : '') +
    '</div>';
  }

  // ---------------- stacked share (HTML) ----------------
  /**
   * Part-to-whole as one bar. Segments are separated by a 2px gap in the
   * surface colour, never by a stroke — a border around a mark is ink that
   * isn't data. Legend always present; it carries identity so colour never
   * has to do it alone.
   */
  function stack(parts, opts) {
    opts = opts || {};
    const live = parts.filter(p => p.value > 0);
    const total = live.reduce((s, p) => s + p.value, 0);
    if (!total) return empty(opts.emptyMsg);
    const segs = live.map((p, i) => {
      const c = p.color || PAL[i % PAL.length];
      return '<span class="c-seg" style="flex:' + p.value + ';' + grad(c, '90deg') +
        '" title="' + esc(p.label + ': ' + fmt(p.value) +
        ' (' + Math.round(p.value / total * 100) + '%)') + '"></span>';
    }).join('');
    const legend = live.map((p, i) => '<div><i style="background:' +
      (p.color || PAL[i % PAL.length]) + '"></i>' + esc(p.label) +
      ' <b>' + esc(fmt(p.value)) + '</b> · ' + Math.round(p.value / total * 100) + '%</div>').join('');
    return '<div class="c-stackwrap">' +
      (opts.center ? '<div class="c-stacktotal">' + esc(fmt(opts.center)) +
        (opts.centerLabel ? '<span>' + esc(opts.centerLabel) + '</span>' : '') + '</div>' : '') +
      '<div class="c-stack">' + segs + '</div>' +
      '<div class="legend c-stacklegend">' + legend + '</div></div>';
  }

  // ---------------- donut (SVG) ----------------
  /** Part-to-whole at a glance, <= 6 segments. Arcs are separated by a real
   *  gap in the surface, and the total sits in the hole as the hero number. */
  function donut(parts, opts) {
    opts = opts || {};
    const live = parts.filter(p => p.value > 0);
    const total = parts.reduce((s, p) => s + p.value, 0);
    if (!total) return empty(opts.emptyMsg);
    const R = 46, SW = 16, C = 2 * Math.PI * R;
    const GAP = live.length > 1 ? 3 : 0;   // 2px surface gap, in user units
    let off = 0, s = '', defs = '';
    live.forEach((p, i) => {
      const col = p.color || PAL[i % PAL.length];
      const arc = (p.value / total) * C;
      const gid = nextId();
      defs += '<linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" style="stop-color:' + col + '"/>' +
        '<stop offset="100%" style="stop-color:' + col + ';stop-opacity:.72"/></linearGradient>';
      s += '<circle r="' + R + '" cx="60" cy="60" fill="none" stroke="url(#' + gid + ')"' +
        ' stroke-width="' + SW + '" stroke-linecap="butt"' +
        ' stroke-dasharray="' + Math.max(0.5, arc - GAP).toFixed(2) + ' ' + C.toFixed(2) + '"' +
        ' stroke-dashoffset="' + (-off).toFixed(2) + '" transform="rotate(-90 60 60)">' +
        '<title>' + esc(p.label + ': ' + fmt(p.value) +
          ' (' + Math.round(p.value / total * 100) + '%)') + '</title></circle>';
      off += arc;
    });
    const centre = (opts.center != null) ? opts.center : total;
    const legend = parts.map((p, i) => '<div><i style="background:' +
      (p.color || PAL[i % PAL.length]) + '"></i>' + esc(p.label) +
      ' <b>' + esc(fmt(p.value)) + '</b></div>').join('');
    return '<div class="c-donutwrap">' +
      '<svg class="c-donut" viewBox="0 0 120 120" role="img"><defs>' + defs + '</defs>' + s +
      '<text class="c-donutv" x="60" y="' + (opts.centerLabel ? 58 : 66) +
        '" text-anchor="middle">' + esc(fmt(centre)) + '</text>' +
      (opts.centerLabel ? '<text class="c-donutk" x="60" y="74" text-anchor="middle">' +
        esc(opts.centerLabel) + '</text>' : '') +
      '</svg><div class="legend">' + legend + '</div></div>';
  }

  // ---------------- line / area (SVG) ----------------
  /** Trend over time. Single series gets a gradient wash and an end dot with a
   *  surface ring; the value is direct-labelled at the end, not on every point. */
  function line(labels, series, opts) {
    opts = opts || {};
    const n = labels.length;
    if (!n || !series.length) return empty(opts.emptyMsg);
    const W = opts.w || 560, H = opts.h || 190, PB = 26, PT = 18, PL = 38;
    const max = opts.pct ? 100
      : niceMax(Math.max(1, ...series.flatMap(s => s.values.filter(v => v != null))));
    const x = i => PL + (n === 1 ? 0 : (i / (n - 1)) * (W - PL - 14));
    const y = v => PT + (1 - v / max) * (H - PB - PT);
    let s = '', defs = '';

    [0, 0.5, 1].forEach(f => {
      const vy = PT + f * (H - PB - PT);
      s += '<line class="c-grid" x1="' + PL + '" y1="' + vy + '" x2="' + (W - 8) + '" y2="' + vy + '"/>' +
        '<text class="c-tick" x="' + (PL - 6) + '" y="' + (vy + 4) + '" text-anchor="end">' +
        fmt(Math.round(max * (1 - f))) + (opts.pct ? '%' : '') + '</text>';
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
          const gid = nextId();
          defs += '<linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" style="stop-color:' + col + ';stop-opacity:.34"/>' +
            '<stop offset="100%" style="stop-color:' + col + ';stop-opacity:0"/></linearGradient>';
          s += '<path d="' + d + ' L' + x(lastI).toFixed(1) + ',' + y(0) + ' L' +
            x(firstI).toFixed(1) + ',' + y(0) + ' Z" fill="url(#' + gid + ')"/>';
        }
      }
      s += '<path d="' + d + '" fill="none" style="stroke:' + col +
        '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
      // Hover targets on every point, but a visible dot + label only at the end.
      sr.values.forEach((v, i) => {
        if (v == null) return;
        s += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) +
          '" r="9" fill="transparent"><title>' +
          esc(labels[i] + ' — ' + sr.name + ': ' + fmt(v) + (opts.pct ? '%' : '')) +
          '</title></circle>';
      });
      let lastI = -1;
      sr.values.forEach((v, i) => { if (v != null) lastI = i; });
      if (lastI >= 0) {
        s += '<circle class="c-enddot" cx="' + x(lastI).toFixed(1) + '" cy="' +
          y(sr.values[lastI]).toFixed(1) + '" r="4.5" style="fill:' + col + '"/>';
        if (series.length === 1) {
          const lx = x(lastI), anchor = lx > W - 60 ? 'end' : 'start';
          s += '<text class="c-endlab" x="' + (lx + (anchor === 'end' ? -8 : 8)).toFixed(1) +
            '" y="' + (y(sr.values[lastI]) - 10).toFixed(1) + '" text-anchor="' + anchor + '">' +
            esc(fmt(sr.values[lastI]) + (opts.pct ? '%' : '')) + '</text>';
        }
      }
    });

    const step = Math.ceil(n / 8);
    labels.forEach((l, i) => {
      if (i % step) return;
      s += '<text class="c-tick" x="' + x(i).toFixed(1) + '" y="' + (H - 8) +
        '" text-anchor="middle">' + esc(l) + '</text>';
    });
    // One series is named by the card title; a one-swatch legend restates it.
    const legend = series.length < 2 ? '' : '<div class="legend legend-row">' +
      series.map((sr, si) => '<div><i style="background:' +
        (sr.color || PAL[si % PAL.length]) + '"></i>' + esc(sr.name) + '</div>').join('') + '</div>';
    return '<div class="c-linewrap"><svg class="c-line" viewBox="0 0 ' + W + ' ' + H +
      '" role="img"><defs>' + defs + '</defs>' + s + '</svg>' + legend + '</div>';
  }

  // ---------------- heatmap (SVG) ----------------
  /**
   * Attendance grid. The ramp is SEMANTIC heat (bad -> good), which is the one
   * licensed multi-hue sequential — so it ships with the scale legend below,
   * without which a reader cannot tell what a shade means.
   */
  function heatmap(rows, colLabels) {
    if (!rows.length) return empty();
    const cw = 20, ch = 20, PL = 130, PT = 20;
    const W = PL + colLabels.length * cw + 6, H = PT + rows.length * ch + 6;
    const color = v => v == null ? 'var(--ch-grid)'
      : v < 0 ? '#dbe6fb'
      : 'hsl(' + Math.round(v * 120) + ' 62% ' + Math.round(86 - v * 36) + '%)';
    let s = '';
    colLabels.forEach((c, i) => {
      if (i % 2) return;
      s += '<text class="c-tick" x="' + (PL + i * cw + cw / 2) + '" y="' + (PT - 6) +
        '" text-anchor="middle">' + esc(c) + '</text>';
    });
    rows.forEach((r, ri) => {
      s += '<text class="c-rowtick" x="' + (PL - 6) + '" y="' + (PT + ri * ch + ch / 2 + 3) +
        '" text-anchor="end">' + esc(String(r.label).slice(0, 20)) + '</text>';
      r.cells.forEach((c, ci) => {
        s += '<rect x="' + (PL + ci * cw) + '" y="' + (PT + ri * ch) + '" width="' + (cw - 2) +
          '" height="' + (ch - 2) + '" rx="3" fill="' + color(c.v) + '">' +
          '<title>' + esc(c.title || '') + '</title></rect>';
      });
    });
    const scale = [0, 0.25, 0.5, 0.75, 1].map(v =>
      '<i style="background:' + color(v) + '"></i>').join('');
    return '<div class="tablewrap"><svg width="' + W + '" height="' + H +
      '" viewBox="0 0 ' + W + ' ' + H + '">' + s + '</svg></div>' +
      '<div class="c-scale">0%' + scale + '100% attendance' +
      '<span class="c-scale-x"><i style="background:' + color(-1) +
      '"></i>leave / holiday<i style="background:var(--ch-grid)"></i>no data</span></div>';
  }

  // ---------------- sparkline (SVG) ----------------
  function spark(values, color) {
    const W = 90, H = 22;
    const vals = values.map(v => v == null ? 0 : v);
    const max = Math.max(1, ...vals);
    const x = i => 2 + (i / Math.max(1, vals.length - 1)) * (W - 4);
    const y = v => H - 3 - (v / max) * (H - 6);
    let d = '';
    vals.forEach((v, i) => { d += (i ? ' L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1); });
    return '<svg class="c-spark" width="' + W + '" height="' + H + '"><path d="' + d +
      '" fill="none" style="stroke:' + (color || PAL[0]) +
      '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>';
  }

  return { bar, hbar, meter, stack, line, donut, heatmap, spark,
    PAL, ORD, STATUS, empty, fmt };
})();
