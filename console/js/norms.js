'use strict';
/**
 * norms.js — the prescribed entitlement per beneficiary per day.
 *
 * The verification cards can compare a centre against two different things,
 * and they answer different questions:
 *
 *   against the district   "is this centre unlike its neighbours?"
 *   against the norm       "did the beneficiary get what she is entitled to?"
 *
 * A centre can sit comfortably on the district average and still be below
 * entitlement, if the whole district is under-issuing. Only the second
 * question tells an officer that.
 *
 * PROVENANCE MATTERS MORE THAN COMPLETENESS HERE. Everything below is either
 * a figure from the national rules, which is stated with its source, or it is
 * null and the console says so rather than comparing against a guess. Fill the
 * nulls from the State Government Order in force and the cards start using
 * them immediately; nothing else needs changing.
 */
window.NUTRITION_NORMS = {
  // Shown on screen so a reader always knows what the comparison rests on.
  source: 'Supplementary Nutrition (ICDS) norms, Schedule II of the National Food ' +
    'Security Act 2013 as amended. Per-item quantities must be set from the ' +
    'Telangana Government Order in force.',
  reviewedOn: '',          // set when an officer checks this against the GO
  reviewedBy: '',

  /**
   * Energy and protein per beneficiary per day. These are the national norms
   * and are not district-specific.
   */
  energy: {
    child_6m_3y: { kcal: 500, protein: '12-15 g', label: 'Child 6 months to 3 years' },
    child_3y_6y: { kcal: 500, protein: '12-15 g', label: 'Child 3 to 6 years' },
    child_sam: { kcal: 800, protein: '20-25 g', label: 'Severely underweight child' },
    pregnant_lactating: { kcal: 600, protein: '18-20 g', label: 'Pregnant or lactating woman' }
  },

  /**
   * Quantity of each commodity per beneficiary per day, by the three heads the
   * daily return actually counts: children, pregnant and lactating women, and
   * other beneficiaries.
   *
   * null means "not set" - the console will not compare against it, and will
   * say the entitlement is not configured rather than imply the centre passed.
   * These vary by State Order, so they are deliberately left for the district
   * to enter rather than assumed here.
   */
  perDay: {
    eggs: { children: null, pregnant: null, others: null, unit: 'eggs' },
    rice: { children: null, pregnant: null, others: null, unit: 'kg' },
    pulses: { children: null, pregnant: null, others: null, unit: 'kg' },
    bal: { children: null, pregnant: null, others: null, unit: 'g' },
    balp: { children: null, pregnant: null, others: null, unit: 'g' },
    milk: { children: null, pregnant: null, others: null, unit: 'ml' },
    meals: { children: null, pregnant: null, others: null, unit: 'meals' }
  }
};

/**
 * What this centre was entitled to issue, for the beneficiaries it entered.
 * Returns null when the norm is not configured, which the caller must treat as
 * "cannot say" and never as "met".
 */
window.normFor = function (item, n) {
  const cfg = (window.NUTRITION_NORMS.perDay || {})[item];
  if (!cfg) return null;
  if (cfg.children == null && cfg.pregnant == null && cfg.others == null) return null;
  return (cfg.children || 0) * (n.c || 0) +
    (cfg.pregnant || 0) * (n.p || 0) +
    (cfg.others || 0) * (n.o || 0);
};

/** True when at least one commodity has a configured entitlement. */
window.normsConfigured = function () {
  const p = window.NUTRITION_NORMS.perDay || {};
  return Object.keys(p).some(function (k) {
    return p[k].children != null || p[k].pregnant != null || p[k].others != null;
  });
};
