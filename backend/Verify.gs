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
 * NO INVENTED NORMS, AND NO SINGLE PER-HEAD FIGURE. A centre feeds three
 * different groups — children, pregnant and lactating women, and other
 * beneficiaries — and they do not eat the same things in the same amounts.
 * Balamrutham+ is for the women, Balamrutham for the children; eggs and the
 * cooked meal reach different mixes of both. Dividing what a centre used by its
 * CHILD count alone would mark a centre with many pregnant women as
 * over-consuming and one with few as pilfering, which is the opposite of what
 * this file is for.
 *
 * So the expected consumption of each item is LEARNED from the district's own
 * reports as a share per group:
 *
 *     used  ~=  a x children  +  b x pregnant women  +  c x others
 *
 * a, b and c are fitted by least squares over every report (per day where
 * there are enough, otherwise over the month), refitted once with the worst
 * tenth of residuals dropped so the fabricators cannot set the yardstick they
 * are judged against. Coefficients cannot go negative — an item that never
 * reaches a group simply fits to zero there, which is how Balamrutham+ ends up
 * with a coefficient on women and nothing on children, without anyone telling
 * it so. If the fit does not explain the district's own data, NOTHING is
 * flagged for that item: no model, no accusation. A Norms sheet overrides the
 * lot when the real per-head entitlements are to hand.
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
// Fitting three coefficients needs samples. Below this a day borrows the
// month's fit; below it for the month too, the item is not judged at all.
const VERIFY_MIN_FIT = 30;
// How well the fit must explain the district's own data before it is allowed
// to be the yardstick for anyone. Below this: no model, no accusation.
const VERIFY_MIN_R2 = 0.5;
// Consumption this far from what the fit expects is worth a look.
const VERIFY_LOW_RATIO = 0.4, VERIFY_HIGH_RATIO = 2.5;
// A report needs this many beneficiaries in total before ratios mean anything.
const VERIFY_MIN_HEADS = 5;
// And the gap must be worth something in absolute terms, or a centre expected
// to use 0.4 kg and using 0.1 kg becomes a finding.
const VERIFY_MIN_GAP = { eggs: 4, rice: 0.5, pulses: 0.2, bal: 40, balp: 40,
  milk: 0.5, meals: 4 };

const VERIFY_ITEM_NAME = { eggs: 'eggs', rice: 'rice', pulses: 'pulses',
  bal: 'Balamrutham', balp: 'Balamrutham+', milk: 'milk', meals: 'meals' };
const VERIFY_ITEM_UNIT = { eggs: '', rice: ' kg', pulses: ' kg',
  bal: ' ml', balp: ' ml', milk: ' L', meals: '' };
// Meals are fitted exactly like a ration: how many a centre prepares is also a
// function of who turned up, and this district's own habit decides the shape.
const VERIFY_METRICS = STOCK_KEYS.concat(['meals']);

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

/**
 * Least squares for  y = b0*x0 + b1*x1 + b2*x2  with NO intercept: nobody
 * present should mean nothing consumed, and an intercept would quietly grant
 * every centre a free ration.
 *
 * Solved through the normal equations with a small ridge term, because a
 * district where (say) "others" is almost always zero makes the matrix nearly
 * singular and an unregularised solve would return wild coefficients.
 */
function solve3_(xs, ys) {
  const n = 3, RIDGE = 1e-6;
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  for (let r = 0; r < xs.length; r++) {
    const x = xs[r], y = ys[r];
    for (let i = 0; i < n; i++) {
      b[i] += x[i] * y;
      for (let j = 0; j < n; j++) A[i][j] += x[i] * x[j];
    }
  }
  for (let i = 0; i < n; i++) A[i][i] += RIDGE * (A[i][i] || 1);
  // Gaussian elimination with partial pivoting.
  const M = [[A[0][0], A[0][1], A[0][2], b[0]],
    [A[1][0], A[1][1], A[1][2], b[1]],
    [A[2][0], A[2][1], A[2][2], b[2]]];
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    const t = M[c]; M[c] = M[piv]; M[piv] = t;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

/**
 * Fit "how much of this item does a centre use, given who turned up".
 * samples: [{x: [children, pregnant, others], y: used}]
 *
 * Two guards that matter. A coefficient is never allowed to go negative — that
 * would say a group makes food appear — so a negative term is pinned to zero
 * and the rest refitted. And the fit is run twice, the second time without the
 * worst tenth of residuals, so the very centres this file exists to find
 * cannot drag the yardstick towards themselves.
 */
function fitUsage_(samples) {
  const usable = samples.filter(function (s) {
    return (s.x[0] + s.x[1] + s.x[2]) > 0 && isFinite(s.y) && s.y >= 0;
  });
  if (usable.length < VERIFY_MIN_FIT) return null;

  function run(rows, mask) {
    const xs = rows.map(function (s) {
      return [mask[0] ? s.x[0] : 0, mask[1] ? s.x[1] : 0, mask[2] ? s.x[2] : 0];
    });
    const beta = solve3_(xs, rows.map(function (s) { return s.y; }));
    if (!beta) return null;
    for (let i = 0; i < 3; i++) if (!mask[i] || !isFinite(beta[i])) beta[i] = 0;
    return beta;
  }

  function fitWithNonNegative(rows) {
    let mask = [1, 1, 1];
    for (let guard = 0; guard < 3; guard++) {
      const beta = run(rows, mask);
      if (!beta) return null;
      let worst = -1;
      for (let i = 0; i < 3; i++) if (mask[i] && beta[i] < 0 && (worst < 0 || beta[i] < beta[worst])) worst = i;
      if (worst < 0) return beta;
      mask[worst] = 0;                       // this group does not receive it
      if (!mask[0] && !mask[1] && !mask[2]) return null;
    }
    return null;
  }

  let beta = fitWithNonNegative(usable);
  if (!beta) return null;
  const pred = function (bt, s) { return bt[0] * s.x[0] + bt[1] * s.x[1] + bt[2] * s.x[2]; };

  // Refit without the worst tenth: the outliers are the subject, not the ruler.
  const ranked = usable.slice().sort(function (a, b2) {
    return Math.abs(a.y - pred(beta, a)) - Math.abs(b2.y - pred(beta, b2));
  });
  const kept = ranked.slice(0, Math.max(VERIFY_MIN_FIT, Math.floor(ranked.length * 0.9)));
  const refit = fitWithNonNegative(kept);
  if (refit) beta = refit;

  // Does the fit actually explain this district's own data? If not, say
  // nothing: a bad model has no business accusing anyone.
  let ssRes = 0, ssTot = 0;
  kept.forEach(function (s) {
    const e = s.y - pred(beta, s);
    ssRes += e * e;
    ssTot += s.y * s.y;
  });
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  if (!(r2 >= VERIFY_MIN_R2)) return null;
  if (beta[0] <= 0 && beta[1] <= 0 && beta[2] <= 0) return null;
  return { b: [vR2_(beta[0]), vR2_(beta[1]), vR2_(beta[2])], n: kept.length, r2: vR2_(r2) };
}

function fitExpect_(fit, c, p, o) {
  return fit.b[0] * c + fit.b[1] * p + fit.b[2] * o;
}

/** "10 children, 2 pregnant women and 1 other" — the mix, in words. */
function vMix_(c, p, o) {
  const parts = [];
  if (c) parts.push(vPl_(c, 'child', 'children'));
  if (p) parts.push(vPl_(p, 'pregnant woman', 'pregnant women'));
  if (o) parts.push(vPl_(o, 'other beneficiary', 'other beneficiaries'));
  if (!parts.length) return 'nobody';
  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

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

  // ---- learn what this district actually gives each group -----------------
  // Eggs and the cooked meal often follow a weekly cycle, so a day fits its own
  // coefficients when it has the samples; otherwise it borrows the month's,
  // which is steadier than a thin day and honest about being an average.
  const allRows = [];
  Object.keys(perDay).forEach(function (dd) {
    perDay[dd].forEach(function (r) { allRows.push(r); });
  });
  const sampleOf = function (rows, k) {
    return rows.map(function (r) {
      return { x: [r.c, r.p, r.o], y: k === 'meals' ? r.m : r.used[k] };
    });
  };
  const monthFit = {}, dayFit = {};
  VERIFY_METRICS.forEach(function (k) {
    // A Norms row states the per-head entitlement outright; it is applied to
    // every group, which is what a single published figure means.
    monthFit[k] = norms[k] != null
      ? { b: [norms[k], norms[k], norms[k]], n: 0, r2: 1, norm: true }
      : fitUsage_(sampleOf(allRows, k));
  });
  Object.keys(perDay).forEach(function (dd) {
    dayFit[dd] = {};
    VERIFY_METRICS.forEach(function (k) {
      dayFit[dd][k] = (norms[k] != null) ? monthFit[k]
        : (fitUsage_(sampleOf(perDay[dd], k)) || monthFit[k]);
    });
  });

  // ---- per-report findings ------------------------------------------------
  const findings = [];
  const medians = {};
  Object.keys(perDay).sort().forEach(function (dd) {
    const list = perDay[dd];
    const fits = dayFit[dd];
    // Published so the console can show what the district's own habit is.
    medians[dd] = {};
    VERIFY_METRICS.forEach(function (k) {
      medians[dd][k] = fits[k] ? { b: fits[k].b, n: fits[k].n, r2: fits[k].r2 } : null;
    });

    list.forEach(function (r) {
      const reasons = [];
      const heads = r.c + r.p + r.o;

      // 1. Nobody fed at all, with a room full of people. This one needs no
      //    model: whatever the ration pattern, zero meals for fifteen present
      //    is worth asking about.
      if (heads >= 10 && r.m === 0) {
        reasons.push({ code: 'MEALS_SHORT', w: VERIFY_W.MEALS_SHORT,
          t: vMix_(r.c, r.p, r.o) + ' were reported present, but no meals were prepared at all.' });
      }

      // 2. Everything else against what this district actually gives each
      //    group. The expectation is built from the centre's OWN mix, so a
      //    centre with many pregnant women and few children is measured
      //    against that mix rather than against a single per-child figure.
      if (heads >= VERIFY_MIN_HEADS) {
        VERIFY_METRICS.forEach(function (k) {
          const fit = fits[k];
          if (!fit) return;                       // no trustworthy model: say nothing
          const actual = k === 'meals' ? r.m : r.used[k];
          const expected = fitExpect_(fit, r.c, r.p, r.o);
          if (!(expected > 0)) return;            // this mix is not entitled to it
          if (Math.abs(actual - expected) < (VERIFY_MIN_GAP[k] || 0)) return;
          const forMix = ' for ' + vMix_(r.c, r.p, r.o);
          if (k === 'meals') {
            if (actual < expected * VERIFY_LOW_RATIO) {
              reasons.push({ code: 'MEALS_SHORT', w: VERIFY_W.MEALS_SHORT,
                t: 'Only ' + vPl_(r.m, 'meal was', 'meals were') + ' prepared' + forMix +
                  '. Centres across the district prepared about ' + Math.round(expected) +
                  ' for that mix.' });
            } else if (actual > expected * VERIFY_HIGH_RATIO) {
              reasons.push({ code: 'MEALS_EXCESS', w: VERIFY_W.MEALS_EXCESS,
                t: vPl_(r.m, 'meal was', 'meals were') + ' prepared' + forMix +
                  ', against about ' + Math.round(expected) + ' across the district.' });
            }
            return;
          }
          if (actual < expected * VERIFY_LOW_RATIO) {
            reasons.push({ code: 'PERHEAD_LOW', w: VERIFY_W.PERHEAD_LOW,
              t: 'Only ' + vQty_(k, actual) + ' ' + vQtyVerb_(k, actual) + ' used' + forMix +
                '. Centres across the district used about ' + vQty_(k, vR1_(expected)) +
                ' for that mix.' });
          } else if (actual > expected * VERIFY_HIGH_RATIO) {
            reasons.push({ code: 'PERHEAD_HIGH', w: VERIFY_W.PERHEAD_HIGH,
              t: vQty_(k, actual) + ' ' + vQtyVerb_(k, actual) + ' used' + forMix +
                ', against about ' + vQty_(k, vR1_(expected)) + ' across the district.' });
          }
        });
      }

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
      if (prev.c < VERIFY_MIN_HEADS || cur.c < prev.c * 2) continue;
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
