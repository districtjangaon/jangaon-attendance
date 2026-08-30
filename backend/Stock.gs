/**
 * Stock.gs — the stock ledger's continuity between days.
 *
 * Committee finding (point 2): "the closing balance of stock is not
 * automatically carried forward as the opening balance for the following
 * day." It was not. Nothing anywhere read yesterday's report when today's
 * form opened, so every worker retyped six opening figures from memory each
 * morning. A register that starts from memory cannot be reconciled, and the
 * ledger check downstream was measuring the worker's recall, not the store.
 *
 * WHY A SEPARATE SHEET. The obvious implementation is to read back the last
 * report row for the centre. A district-month is ~18,000 report rows and the
 * lookup happens 695 times each morning inside the marking window, so that is
 * a scan we cannot afford. This is a 695-row book kept beside it: one row per
 * centre, overwritten in place, O(1) to read and O(1) to write.
 *
 * IT IS A CONVENIENCE, NEVER A CONSTRAINT. The carried figure is offered to
 * the worker and she may overwrite it — a physical count that disagrees with
 * the book is exactly the fact this system exists to capture, and a locked
 * field would force her to file a number she knows is wrong. When she does
 * overwrite it the row is flagged CARRY_OFF with the size of the break, and
 * that flag is the stock-accounting signal the Committee asked for.
 */

const CARRY_H = ['awc_id', 'date', 'user_id', 'updated_at']
  .concat(STOCK_KEYS.map(function (k) { return k + '_cb'; }));

/** One row per AWC. Created on demand; header self-heals like every other. */
function carrySheet_() {
  const ss = masterSS_();
  let sh = ss.getSheetByName('StockCarry');
  if (!sh) {
    sh = ss.insertSheet('StockCarry');
    sh.getRange(1, 1, 1, CARRY_H.length).setValues([CARRY_H]);
    sh.getRange(1, 1, sh.getMaxRows(), CARRY_H.length).setNumberFormat('@');
    return sh;
  }
  if (sh.getMaxColumns() < CARRY_H.length) {
    sh.insertColumnsAfter(sh.getMaxColumns(), CARRY_H.length - sh.getMaxColumns());
  }
  if (String(sh.getRange(1, CARRY_H.length).getValue()) !== CARRY_H[CARRY_H.length - 1]) {
    sh.getRange(1, 1, 1, CARRY_H.length).setValues([CARRY_H]);
  }
  return sh;
}

/**
 * Yesterday's closing for this centre, or null when the centre has never
 * filed a report. Null must reach the worker as an empty box, never as zero:
 * a pre-filled 0 would be a figure the system invented and she signed for.
 */
function getStockCarry_(awcId) {
  const aid = String(awcId || '');
  if (!aid) return null;
  const hit = CACHE.get('carry_' + aid);
  if (hit) {
    try { return JSON.parse(hit); } catch (e) { /* fall through to the sheet */ }
  }
  const sh = carrySheet_();
  const row = findRowByValue_(sh, 1, aid);
  if (!row) return null;
  const o = rowToObj_(CARRY_H, sh.getRange(row, 1, 1, CARRY_H.length).getValues()[0]);
  const out = { date: String(o.date), cb: {} };
  STOCK_KEYS.forEach(function (k) {
    const v = Number(o[k + '_cb']);
    out.cb[k] = isFinite(v) ? v : null;
  });
  CACHE.put('carry_' + aid, JSON.stringify(out), 21600);
  return out;
}

/**
 * Record this report's closing balances as the centre's carry.
 *
 * Called from inside apiSync_'s existing lock, so it takes none of its own.
 *
 * A LATER DATE ALWAYS WINS. Marks sync out of order — a phone that was in
 * airplane mode on Tuesday can deliver Tuesday's report on Thursday evening,
 * after Wednesday's has already landed. Advancing the carry on arrival order
 * would quietly rewind the whole centre. Compared as yyyymmdd strings, which
 * sort correctly as text, so an older report updates the sheet's history but
 * never the live carry.
 */
function setStockCarry_(user, rec, dateStr) {
  const aid = String(user.awc_id || '');
  if (!aid) return;
  const st = rec && rec.stock;
  if (!st) return;                       // pre-v2 app: no per-item closing to carry

  const prev = getStockCarry_(aid);
  if (prev && String(prev.date) > String(dateStr)) return;

  const sh = carrySheet_();
  const vals = { awc_id: aid, date: String(dateStr), user_id: String(user.user_id),
    updated_at: nowIso_() };
  const cb = {};
  STOCK_KEYS.forEach(function (k) {
    const v = st[k] && st[k].cb;
    const n = Number(v);
    cb[k] = (v === '' || v == null || !isFinite(n)) ? null : n;
    vals[k + '_cb'] = cb[k] == null ? '' : cb[k];
  });
  const row = CARRY_H.map(function (h) { return vals[h]; });
  const at = findRowByValue_(sh, 1, aid);
  sh.getRange(at || sh.getLastRow() + 1, 1, 1, CARRY_H.length).setValues([row]);
  CACHE.put('carry_' + aid, JSON.stringify({ date: String(dateStr), cb: cb }), 21600);
}

/**
 * Which opening figures disagree with the carried closing, and by how much.
 * Returns [] when there is nothing to compare against — a centre's first ever
 * report, or a gap in reporting, is not a discrepancy.
 *
 * Tolerance is half of the item's own smallest step: whole units for eggs,
 * 0.05 for the kilogram items. Rounding is not a finding.
 */
function carryBreaks_(prev, rec, dateStr) {
  if (!prev || !rec || !rec.stock) return [];
  if (!prev.date || String(prev.date) >= String(dateStr)) return [];
  const out = [];
  STOCK_KEYS.forEach(function (k) {
    const was = prev.cb[k];
    const now = rec.stock[k] && rec.stock[k].ob;
    if (was == null || now == null || now === '') return;
    const n = Number(now);
    if (!isFinite(n)) return;
    if (Math.abs(n - Number(was)) > 0.05) {
      out.push({ item: k, was: Number(was), now: n,
        diff: Math.round((n - Number(was)) * 10) / 10 });
    }
  });
  return out;
}

/**
 * The app asks for this when the report screen opens. Deliberately its own
 * route rather than a field on login config: the carry changes every evening
 * and a token lives for weeks, so config would hand back a stale figure for
 * as long as the worker stays signed in.
 */
function apiStockCarry_(auth, req) {
  const awcId = String(req.awcId || auth.user.awc_id || '');
  // A worker may only ask about her own centre. Console roles may ask about
  // any centre inside their own scope, and nothing outside it.
  if (String(awcId) !== String(auth.user.awc_id || '')) {
    if (!isConsoleRole_(auth.user)) return deny_();
    const awc = getAwc_(awcId);
    // awcFromRow_ names this field `sector`, not `sector_code` - reading the
    // wrong one returns undefined, which compares out of every scope and
    // silently refuses every supervisor.
    const scope = sectorScope_(auth.user);
    if (!awc || (scope && scope.indexOf(String(awc.sector)) < 0)) return deny_();
  }
  return { ok: true, carry: getStockCarry_(awcId), items: STOCK_KEYS };
}
