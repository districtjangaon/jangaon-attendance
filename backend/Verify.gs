/**
 * Verify.gs — does the daily report hold together?
 *
 * THE PROBLEM. A centre photographs two children and types ten. Nobody can
 * check 695 photographs a day, and counting children in a 60 KB indoor
 * photograph is not something software can do reliably — children move, sit
 * behind each other, face away, fall half out of frame. Any system that claims
 * "the photo shows seven" is producing a number that will not survive an
 * inquiry.
 *
 * THE APPROACH. The photograph is not the check; the arithmetic is. A worker
 * who reports ten children must also have served about ten meals, used about
 * ten eggs, and drawn rice and Balamrutham for ten. Inflating one number in
 * isolation makes the report contradict itself, and that contradiction is
 * detectable — deterministically, for nothing, across every centre, every day.
 * The photograph then becomes the evidence a supervisor looks at AFTER the
 * arithmetic has pointed somewhere, which turns 695 centres into a queue of
 * about twenty worth a person's time.
 *
 * NO INVENTED NORMS. This district has no per-centre enrolment figure and this
 * file does not pretend to know the scheme's per-head entitlements. Per-head
 * checks compare a centre against the DISTRICT'S OWN MEDIAN for that item on
 * that day, so the yardstick is what everyone else actually did. A Norms sheet
 * can override any of it when the real figures are to hand.
 *
 * A FINDING IS NOT A FINDING OF GUILT. Every rule emits a plain sentence with
 * the real numbers in it, because these are read out to a government employee
 * who is entitled to know exactly what is being put to her. A short day, a
 * feast day, a delivery that arrived late — all produce anomalies innocently.
 * The console says so; so does every export.
 */

// Weights are how much a rule moves the score, not how guilty it is. They are
// tuned so that one arithmetic contradiction outranks any number of soft
// behavioural signals: a report that does not add up is a fact, while a flat
// attendance pattern is only a question.
const VERIFY_W = {
  MEALS_SHORT: 40, MEALS_EXCESS: 25, LEDGER_OFF: 30,
  PERHEAD_LOW: 22, PERHEAD_HIGH: 12,
  FLAT_COUNT: 18, ROUND_BIAS: 12, STEP_JUMP: 20, PEER_OUTLIER: 14
};

// A centre needs this many filed days before behaviour means anything; below
// it, "always exactly ten" is just a short sample.
const VERIFY_MIN_DAYS = 8;
// A day needs this many reporting centres before its median is a yardstick.
const VERIFY_MIN_PEERS = 20;
// Per-head usage this far from the district median is worth a look.
const VERIFY_LOW_RATIO = 0.4, VERIFY_HIGH_RATIO = 2.5;
// Below this many children the ratios are too noisy to mean anything.
const VERIFY_MIN_CHILDREN = 5;

const VERIFY_ITEM_NAME = { eggs: 'eggs', rice: 'rice', pulses: 'pulses',
  bal: 'Balamrutham', balp: 'Balamrutham+', milk: 'milk' };
const VERIFY_ITEM_UNIT = { eggs: '', rice: ' kg', pulses: ' kg',
  bal: ' ml', balp: ' ml', milk: ' L' };

function vNum_(x) { const n = Number(x); return isFinite(n) ? n : 0; }

/**
 * These sentences are read out to a government employee, so they are written
 * as English rather than assembled from fragments: "1 other", not "1 others";
 * "2 eggs", not "2 of eggs". A finding that reads like a machine invites the
 * reply that a machine made a mistake.
 */
function vPl_(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
function vQty_(k, v) {
  const u = VERIFY_ITEM_UNIT[k];
  return u ? vR1_(v) + u + ' of ' + VERIFY_ITEM_NAME[k]
    : vPl_(vR1_(v), VERIFY_ITEM_NAME[k].replace(/s$/, ''), VERIFY_ITEM_NAME[k]);
}
/** Verb to agree with vQty_: a mass takes "was", a count takes the number. */
function vQtyVerb_(k, v) {
  if (VERIFY_ITEM_UNIT[k]) return 'was';       // "0.2 kg of rice was used"
  return vR1_(v) === 1 ? 'was' : 'were';       // "1 egg was" / "2 eggs were"
}
function vR1_(v) { return Math.round(v * 10) / 10; }
function vR2_(v) { return Math.round(v * 100) / 100; }

function median_(arr) {
  if (!arr.length) return null;
  const a = arr.slice().sort(function (x, y) { return x - y; });
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Optional overrides: a Norms sheet of [item, per_head] wins over the median. */
function verifyNorms_() {
  const c = CACHE.get('rptNorms');
  if (c) return JSON.parse(c);
  const out = {};
  try {
    const sh = masterSS_().getSheetByName('Norms');
    if (sh && sh.getLastRow() >= 2) {
      sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
        const k = String(r[0]).trim();
        const v = Number(r[1]);
        if (k && isFinite(v) && v > 0) out[k] = v;
      });
    }
  } catch (e) { /* no sheet: medians carry the checks */ }
  CACHE.put('rptNorms', JSON.stringify(out), 600);
  return out;
}

/**
 * Build the verification file for a month from rows already read by the report
 * archive. Sharing the read matters: the Reports sheet is ~18,000 rows of 46
 * columns for a full district-month, and reading it twice in one nightly run
 * is the kind of thing that ends in a timeout.
 */
function buildVerifyFile_(ym, rows) {
  const norms = verifyNorms_();
  const perDay = {};   // dd -> [{aid, sc, c, p, o, m, used{}, ledger[], ph{}}]
  const byAwc = {};    // aid -> { sc, days: [{dd, c, m, eggs}] }

  rows.forEach(function (o) {
    const dd = String(o.date).slice(6, 8);
    const aid = String(o.awc_id) || String(o.user_id);
    if (!aid || !dd) return;
    const c = vNum_(o.children), p = vNum_(o.pregnant),
      ot = vNum_(o.others), m = vNum_(o.meals);
    const used = {}, ledger = [];
    STOCK_KEYS.forEach(function (k) {
      used[k] = vNum_(o[k + '_used']);
      const ob = vNum_(o[k + '_ob']), recd = vNum_(o[k + '_recd']), cb = vNum_(o[k + '_cb']);
      // Only judge the ledger when the centre actually filled it in; an all
      // zero block is an old client, not a discrepancy.
      if (ob || recd || cb || used[k]) {
        const drift = vR1_(cb - (ob + recd - used[k]));
        if (Math.abs(drift) > 0.05) ledger.push({ k: k, drift: drift });
      }
    });
    const rec = { aid: aid, sc: String(o.sector_code), c: c, p: p, o: ot, m: m,
      used: used, ledger: ledger,
      ph: { c: String(o.photo_child_id || ''), m: String(o.photo_meal_id || ''),
        p: String(o.photo_pregnant_id || ''), o: String(o.photo_others_id || '') } };
    (perDay[dd] = perDay[dd] || []).push(rec);
    const a = byAwc[aid] || (byAwc[aid] = { sc: rec.sc, days: [] });
    a.days.push({ dd: dd, c: c, m: m, eggs: used.eggs });
  });

  // ---- per-report findings ------------------------------------------------
  const findings = [];
  const medians = {};
  Object.keys(perDay).sort().forEach(function (dd) {
    const list = perDay[dd];
    // The day's yardstick: what the median centre used per child today.
    const med = {};
    STOCK_KEYS.forEach(function (k) {
      const ratios = list.filter(function (r) { return r.c >= VERIFY_MIN_CHILDREN; })
        .map(function (r) { return r.used[k] / r.c; })
        .filter(function (v) { return isFinite(v) && v > 0; });
      med[k] = norms[k] != null ? norms[k]
        : (ratios.length >= VERIFY_MIN_PEERS ? vR2_(median_(ratios)) : null);
    });
    medians[dd] = med;

    list.forEach(function (r) {
      const reasons = [];
      const heads = r.c + r.p + r.o;

      // 1. Meals against the people said to have been fed. Pure arithmetic —
      //    no norm, no median, nothing to argue with.
      if (heads >= VERIFY_MIN_CHILDREN && r.m < heads * 0.6) {
        reasons.push({ code: 'MEALS_SHORT', w: VERIFY_W.MEALS_SHORT,
          t: vPl_(r.c, 'child', 'children') + ', ' +
            vPl_(r.p, 'pregnant woman', 'pregnant women') + ' and ' +
            vPl_(r.o, 'other', 'others') + ' were reported present, but only ' +
            vPl_(r.m, 'meal was', 'meals were') + ' prepared.' });
      } else if (heads > 0 && r.m > heads * 1.5 + 5) {
        reasons.push({ code: 'MEALS_EXCESS', w: VERIFY_W.MEALS_EXCESS,
          t: vPl_(r.m, 'meal was', 'meals were') + ' prepared for ' +
            vPl_(heads, 'person', 'people') + ' reported present.' });
      }

      // 2. Per-head consumption against what every other centre did today.
      STOCK_KEYS.forEach(function (k) {
        if (!med[k] || r.c < VERIFY_MIN_CHILDREN) return;
        const ratio = r.used[k] / r.c;
        if (!isFinite(ratio)) return;
        const expected = vR1_(med[k] * r.c);
        if (ratio < med[k] * VERIFY_LOW_RATIO) {
          reasons.push({ code: 'PERHEAD_LOW', w: VERIFY_W.PERHEAD_LOW,
            t: 'For ' + vPl_(r.c, 'child', 'children') + ', only ' + vQty_(k, r.used[k]) +
              ' ' + vQtyVerb_(k, r.used[k]) + ' used. Centres across the district used about ' +
              vQty_(k, expected) + ' for that many children today.' });
        } else if (ratio > med[k] * VERIFY_HIGH_RATIO) {
          reasons.push({ code: 'PERHEAD_HIGH', w: VERIFY_W.PERHEAD_HIGH,
            t: vQty_(k, r.used[k]) + ' ' + vQtyVerb_(k, r.used[k]) + ' used for ' +
              vPl_(r.c, 'child', 'children') + ', against about ' + vQty_(k, expected) +
              ' across the district.' });
        }
      });

      // 3. The stock register not balancing against itself.
      r.ledger.forEach(function (l) {
        reasons.push({ code: 'LEDGER_OFF', w: VERIFY_W.LEDGER_OFF,
          t: 'The ' + VERIFY_ITEM_NAME[l.k] + ' register does not balance: closing is ' +
            (l.drift > 0 ? l.drift + VERIFY_ITEM_UNIT[l.k] + ' more' :
              (-l.drift) + VERIFY_ITEM_UNIT[l.k] + ' less') +
            ' than opening plus received minus used.' });
      });

      if (!reasons.length) return;
      findings.push({
        a: r.aid, s: r.sc, d: dd,
        score: Math.min(100, reasons.reduce(function (t, x) { return t + x.w; }, 0)),
        n: { c: r.c, p: r.p, o: r.o, m: r.m,
          u: STOCK_KEYS.map(function (k) { return vR1_(r.used[k]); }) },
        r: reasons, ph: r.ph
      });
    });
  });
  findings.sort(function (a, b) { return b.score - a.score; });

  // ---- per-centre behaviour over the month --------------------------------
  const centres = [];
  Object.keys(byAwc).forEach(function (aid) {
    const a = byAwc[aid];
    if (a.days.length < VERIFY_MIN_DAYS) return;
    a.days.sort(function (x, y) { return x.dd < y.dd ? -1 : 1; });
    const cs = a.days.map(function (d) { return d.c; });
    const reasons = [];

    // Real attendance moves. A month of identical numbers is a copied figure.
    const mean = cs.reduce(function (s, v) { return s + v; }, 0) / cs.length;
    const sd = Math.sqrt(cs.reduce(function (s, v) { return s + (v - mean) * (v - mean); }, 0) / cs.length);
    if (sd < 0.35 && mean > 0) {
      reasons.push({ code: 'FLAT_COUNT', w: VERIFY_W.FLAT_COUNT,
        t: 'Exactly ' + Math.round(mean) + ' children were reported on all ' +
          cs.length + ' days filed this month. Real attendance varies.' });
    }

    // Numbers that are always round are numbers that were chosen, not counted.
    const round = cs.filter(function (v) { return v % 5 === 0; }).length;
    if (cs.length >= VERIFY_MIN_DAYS && round / cs.length >= 0.85 && sd >= 0.35) {
      reasons.push({ code: 'ROUND_BIAS', w: VERIFY_W.ROUND_BIAS,
        t: Math.round(100 * round / cs.length) + '% of this centre’s child counts end in 0 or 5.' });
    }

    // A jump in children that the kitchen did not notice.
    for (let i = 1; i < a.days.length; i++) {
      const prev = a.days[i - 1], cur = a.days[i];
      if (prev.c < VERIFY_MIN_CHILDREN || cur.c < prev.c * 2) continue;
      const mealMove = prev.m ? Math.abs(cur.m - prev.m) / prev.m : 1;
      const eggMove = prev.eggs ? Math.abs(cur.eggs - prev.eggs) / prev.eggs : 1;
      if (mealMove < 0.2 && eggMove < 0.2) {
        reasons.push({ code: 'STEP_JUMP', w: VERIFY_W.STEP_JUMP,
          t: 'Children reported went from ' + prev.c + ' on the ' + prev.dd + 'th to ' +
            cur.c + ' on the ' + cur.dd + 'th, while meals and eggs barely moved.' });
        break;
      }
    }
    if (reasons.length) {
      centres.push({ a: aid, s: a.sc, days: cs.length, mean: vR1_(mean),
        score: Math.min(100, reasons.reduce(function (t, x) { return t + x.w; }, 0)), r: reasons });
    }
  });

  // Peer comparison needs the sector's own centres, so it runs after the loop.
  const bySector = {};
  Object.keys(byAwc).forEach(function (aid) {
    const a = byAwc[aid];
    if (a.days.length < VERIFY_MIN_DAYS) return;
    const mean = a.days.reduce(function (s, d) { return s + d.c; }, 0) / a.days.length;
    (bySector[a.sc] = bySector[a.sc] || []).push({ aid: aid, mean: mean });
  });
  Object.keys(bySector).forEach(function (sc) {
    const list = bySector[sc];
    if (list.length < 5) return;   // too few peers to call anyone an outlier
    const med = median_(list.map(function (x) { return x.mean; }));
    if (!med) return;
    list.forEach(function (x) {
      const hi = x.mean > med * 2.5, lo = x.mean < med * 0.4;
      if (!hi && !lo) return;
      const t = 'This centre reports about ' + vR1_(x.mean) + ' children a day; the ' +
        'middle centre in its sector reports about ' + vR1_(med) + '.';
      const found = centres.find(function (c) { return c.a === x.aid; });
      if (found) {
        found.r.push({ code: 'PEER_OUTLIER', w: VERIFY_W.PEER_OUTLIER, t: t });
        found.score = Math.min(100, found.score + VERIFY_W.PEER_OUTLIER);
      } else {
        centres.push({ a: x.aid, s: sc, days: 0, mean: vR1_(x.mean),
          score: VERIFY_W.PEER_OUTLIER, r: [{ code: 'PEER_OUTLIER', w: VERIFY_W.PEER_OUTLIER, t: t }] });
      }
    });
  });
  centres.sort(function (a, b) { return b.score - a.score; });

  return {
    path: 'summary/verify/' + ym + '.json',
    content: JSON.stringify({ ym: ym, generatedAt: nowIso_(),
      items: STOCK_KEYS, medians: medians,
      findings: findings.slice(0, 2000), centres: centres.slice(0, 500) })
  };
}

/** Owner-run: rebuild one month's verification file. */
function buildVerifyMonth(ym) {
  const target = ym || Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
  const rows = readMonthReportRows_(target);
  if (rows == null) return 'No attendance spreadsheet for ' + target + '.';
  const f = buildVerifyFile_(target, rows);
  ghCommit_([f], 'verify ' + target + ' ' + nowIso_());
  const p = JSON.parse(f.content);
  return target + ': ' + p.findings.length + ' report findings, ' +
    p.centres.length + ' centres with behavioural findings.';
}

// ---- the human loop -------------------------------------------------------
/**
 * A finding only earns its place if someone looks and says what they saw.
 * Verdicts are appended, never overwritten: a review is a record of what an
 * officer concluded on a date, and rewriting one destroys the audit trail.
 * The latest verdict for a centre-day wins on read.
 */
function reviewsSheet_() {
  const ss = masterSS_();
  let sh = ss.getSheetByName('Reviews');
  if (!sh) {
    sh = ss.insertSheet('Reviews');
    sh.getRange(1, 1, 1, REVIEW_H.length).setValues([REVIEW_H]);
    sh.getRange(1, 1, sh.getMaxRows(), REVIEW_H.length).setNumberFormat('@');
  }
  return sh;
}

// action: "reviewFinding"  req: { token, awcId, date, verdict, note }
// verdict: MATCHES | MISMATCH | EXPLAINED
function apiReviewFinding_(auth, req) {
  if (!isConsoleRole_(auth.user)) return deny_();
  const awcId = String(req.awcId || '').trim();
  const date = String(req.date || '').trim();          // yyyy-MM-dd
  const verdict = String(req.verdict || '').toUpperCase();
  if (!awcId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, code: 'BAD_TARGET' };
  if (['MATCHES', 'MISMATCH', 'EXPLAINED'].indexOf(verdict) < 0) {
    return { ok: false, code: 'BAD_VERDICT' };
  }
  // Scope: a supervisor must not review another cluster's centre by editing a
  // request parameter, so the centre's sector is checked here.
  const awc = getAwc_(awcId);
  if (!awc) return { ok: false, code: 'NO_AWC' };
  const scope = sectorScope_(auth.user);
  if (scope && scope.indexOf(String(awc.sector)) < 0) return deny_();

  const note = String(req.note || '').trim().slice(0, 300);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    reviewsSheet_().appendRow([nowIso_(), String(auth.userId), awcId, date, verdict, note,
      String(req.score == null ? '' : req.score), String(req.codes || '')]);
  } finally {
    lock.releaseLock();
  }
  CACHE.remove('reviews_' + date.slice(0, 7));
  audit_(auth.userId, 'REPORT_REVIEW', awcId + '@' + date, '', verdict + (note ? ' — ' + note : ''));
  return { ok: true, by: String(auth.user.name), at: nowIso_() };
}

// action: "reviewList"  req: { token, ym }
// The latest verdict per centre-day for a month, scoped to the caller.
function apiReviewList_(auth, req) {
  if (!isConsoleRole_(auth.user)) return deny_();
  const ym = /^\d{4}-\d{2}$/.test(String(req.ym || '')) ? String(req.ym)
    : Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
  const sh = reviewsSheet_();
  const last = sh.getLastRow();
  if (last < 2) return { ok: true, ym: ym, reviews: {} };
  const scope = sectorScope_(auth.user);
  const awcSector = {};
  masterSheetRows_('AWCs', AWC_H).forEach(function (r) {
    const a = awcFromRow_(r);
    awcSector[a.awc_id] = a.sector;
  });
  const out = {};
  const names = {};
  sh.getRange(2, 1, last - 1, REVIEW_H.length).getValues().forEach(function (v) {
    const o = rowToObj_(REVIEW_H, v);
    const date = String(o.date);
    if (date.slice(0, 7) !== ym) return;
    const aid = String(o.awc_id);
    if (scope && scope.indexOf(String(awcSector[aid])) < 0) return;
    if (names[o.actor] === undefined) {
      const u = getUserById_(String(o.actor));
      names[o.actor] = u ? String(u.name) : String(o.actor);
    }
    // Later rows win: the newest verdict for a centre-day is the standing one.
    out[aid + '|' + date] = { v: String(o.verdict), n: String(o.note || ''),
      by: names[o.actor], at: String(o.ts) };
  });
  return { ok: true, ym: ym, reviews: out };
}
