/**
 * Reports.gs — the AWC daily-report archive.
 *
 * The console could only ever see TODAY's reports, because today.json is the
 * only place they were published. This builds one file per month so the
 * console can look back six months, track the stock register over time, and
 * export the lot — without ever reading the attendance spreadsheet itself.
 *
 * WHAT IS AND IS NOT IN THE FILE. These land in the PUBLIC Pages repo, so the
 * same rule as every other summary applies: codes, never names. The report
 * rows also carry a GPS fix and photo ids; both are deliberately dropped here.
 * A centre's coordinates are a public facility location, but the fix taken at
 * report time is the worker's position, and it belongs with the map payload in
 * the private store, not on the open internet.
 *
 * SHAPE. Per-AWC-per-day rows are the bulk, so they are fixed-length arrays
 * rather than objects — a district-month is ~695 x 26 rows, and key names
 * repeated 18,000 times are most of the bytes:
 *
 *   days: { "01": { awcs, c, p, o, m, st: { eggs:[ob,used,recd,cb], ... } } }
 *   awcs: { "A0001": { s: "S01",
 *                      d: { "01": [c, p, o, m, eggsUsed, riceUsed,
 *                                  pulsesUsed, balUsed, balpUsed, milkUsed] },
 *                      st: { eggs:[ob,used,recd,cb], ... } } }
 *
 * Daily consumption per centre is what "tracking the resources" needs; the
 * opening and closing balances only have to be right per month, so they are
 * aggregated (first opening seen, last closing seen, movements summed).
 */

/** Fixed field order of the per-AWC-per-day array. The console mirrors it. */
const RPT_DAY_FIELDS = ['children', 'pregnant', 'others', 'meals']
  .concat(STOCK_KEYS.map(function (k) { return k + '_used'; }));

const rptR1_ = function (v) { return Math.round(v * 10) / 10; };

/**
 * Build summary/reports/<ym>.json from the month's Reports sheet.
 * Returns a {path, content} file for ghCommit_, or null when the month has no
 * spreadsheet at all.
 */
/**
 * The month's report rows, parsed once. A full district-month is ~18,000 rows
 * of 46 columns; the archive and the verification checker both need them, and
 * reading that twice in one nightly run is how a trigger times out.
 * Returns null when the month has no spreadsheet at all.
 */
function readMonthReportRows_(ym) {
  const ss = getMonthSS_(ym, true);
  if (!ss) return null;
  const sh = ss.getSheetByName('Reports');
  if (!sh || sh.getLastRow() < 2) return [];
  const compact = ym.replace('-', '');
  return sh.getRange(2, 1, sh.getLastRow() - 1, RPT_H.length).getValues()
    .map(function (v) { return rowToObj_(RPT_H, v); })
    .filter(function (o) { return String(o.date).slice(0, 6) === compact; });
}

function buildReportFile_(ym, rows) {
  if (rows == null) return null;
  if (!rows.length) {
    return { path: 'summary/reports/' + ym + '.json',
      content: JSON.stringify({ ym: ym, generatedAt: nowIso_(), days: {}, awcs: {},
        fields: RPT_DAY_FIELDS, items: STOCK_KEYS }) };
  }

  const compact = ym.replace('-', '');
  const days = {};
  const awcs = {};
  const blankSt = function () {
    const o = {};
    STOCK_KEYS.forEach(function (k) { o[k] = [0, 0, 0, 0]; });
    return o;
  };

  // One report per AWC per day is the rule; a duplicate (retry that slipped
  // past the idempotency key) must not double the district's meal count, so
  // the first row for a centre-day wins and later ones are ignored.
  const seen = {};

  for (const o of rows) {
    const dd = String(o.date).slice(6, 8);
    const aid = String(o.awc_id) || String(o.user_id);
    if (!aid) continue;
    const seenKey = aid + '|' + dd;
    if (seen[seenKey]) continue;
    seen[seenKey] = 1;

    const n = function (x) { const y = Number(x); return isFinite(y) ? y : 0; };
    const c = n(o.children), p = n(o.pregnant), ot = n(o.others), m = n(o.meals);

    const day = days[dd] || (days[dd] = { awcs: 0, c: 0, p: 0, o: 0, m: 0, st: blankSt() });
    day.awcs++;
    day.c += c; day.p += p; day.o += ot; day.m += m;

    const a = awcs[aid] || (awcs[aid] = { s: String(o.sector_code), d: {}, st: blankSt() });
    const row = [c, p, ot, m];

    STOCK_KEYS.forEach(function (k) {
      const ob = n(o[k + '_ob']), used = n(o[k + '_used']),
        recd = n(o[k + '_recd']), cb = n(o[k + '_cb']);
      row.push(rptR1_(used));
      // District per-day movement.
      const ds = day.st[k];
      ds[0] = rptR1_(ds[0] + ob); ds[1] = rptR1_(ds[1] + used);
      ds[2] = rptR1_(ds[2] + recd); ds[3] = rptR1_(ds[3] + cb);
      // Per-AWC month: the earliest opening and the latest closing are the
      // real balances; movements sum. Summing openings would be nonsense.
      const as = a.st[k];
      if (a._first == null || dd <= a._first) as[0] = ob;
      as[1] = rptR1_(as[1] + used);
      as[2] = rptR1_(as[2] + recd);
      if (a._last == null || dd >= a._last) as[3] = cb;
    });
    a._first = (a._first == null || dd < a._first) ? dd : a._first;
    a._last = (a._last == null || dd > a._last) ? dd : a._last;
    a.d[dd] = row;
  }

  Object.keys(awcs).forEach(function (aid) {
    delete awcs[aid]._first;
    delete awcs[aid]._last;
  });

  return {
    path: 'summary/reports/' + ym + '.json',
    content: JSON.stringify({ ym: ym, generatedAt: nowIso_(),
      fields: RPT_DAY_FIELDS, items: STOCK_KEYS, days: days, awcs: awcs })
  };
}

/**
 * Owner-run: build (or rebuild) the archive for a specific month.
 * Call as buildReportMonth('2026-07') from the editor to backfill.
 */
function buildReportMonth(ym) {
  const target = ym || Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
  const rows = readMonthReportRows_(target);
  const f = buildReportFile_(target, rows);
  if (!f) return 'No attendance spreadsheet for ' + target + ' — nothing to build.';
  const files = [f];
  try { files.push(buildVerifyFile_(target, rows)); }
  catch (err) { console.error('verify build failed for ' + target + ': ' + err); }
  ghCommit_(files, 'reports ' + target + ' ' + nowIso_());
  const parsed = JSON.parse(f.content);
  return target + ': ' + Object.keys(parsed.awcs).length + ' centres, ' +
    Object.keys(parsed.days).length + ' days, ' + f.content.length + ' bytes.';
}

/**
 * Owner-run: backfill the last N months in one go (default 6). Each month is
 * a separate commit so a failure part-way leaves the earlier months published.
 */
function buildReportHistory(months) {
  const n = Math.min(24, Math.max(1, Number(months) || 6));
  const out = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = Utilities.formatDate(d, TZ, 'yyyy-MM');
    try {
      out.push(buildReportMonth(ym));
    } catch (err) {
      out.push(ym + ': FAILED — ' + err);
    }
  }
  return out.join('\n');
}

/** The months the console should offer, newest first. */
function reportMonthsAvailable_(n) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < (n || 6); i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(Utilities.formatDate(d, TZ, 'yyyy-MM'));
  }
  return out;
}
