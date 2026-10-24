/**
 * Features.gs — feature modules, ported from the SJGP register.
 *
 * How a new feature is added to a live register without touching the files
 * that already work. Every feature so far has been cut into Main.gs's ROUTES
 * and into whichever file it touched; each incision is a chance to break
 * something that had nothing to do with the feature being added, and the
 * thing it breaks is somebody's attendance record.
 *
 * SO A FEATURE IS A FILE, AND THE MAIN CODE CALLS IT. A module declares the
 * actions it answers and nothing else reaches into it. Main.gs gains one
 * line (the call to featurePost_ after ROUTES has declined the action), and
 * this file gains one name per feature in FEATURE_MODULES.
 *
 * What the register guarantees a module cannot do:
 *   - run before the token is checked: modules are dispatched inside doPost
 *     AFTER verifyToken_, and are handed the authenticated session;
 *   - take over something the core already answers: registration reads the
 *     core's own dispatch out of doPost and REFUSES a module that claims an
 *     action already in it;
 *   - take the register down: every module is loaded and called inside its
 *     own try/catch. One that throws is recorded in the Audit sheet and
 *     answers its caller plainly; every other action is untouched;
 *   - stay on when it misbehaves: the script property FEATURE_OFF is a
 *     comma-separated list of module names, and anything on it is not
 *     loaded. That is the rollback at four in the afternoon, without a deploy.
 *
 * A module is one function named feature_<name>:
 *
 *     function feature_example() {
 *       return {
 *         title: 'What it is, in the Collector's words',
 *         actions: { exampleSave: function (auth, req) { return { ok: true }; } },
 *         daily: function () { return 'done'; }   // optional, ~07:00
 *       };
 *     }
 *
 * Action handlers have the same signature as every ROUTES entry: (auth, req)
 * in, a plain object out (doPost wraps it in jsonOut_).
 *
 * action=diag lists what is loaded, what was refused and why, so "is my
 * feature live" is answered by reading rather than guessing.
 */

// The modules this register carries, in the order they are offered a request.
// ADD A FEATURE BY ADDING ITS FILE AND ITS NAME HERE, and change nothing else.
var FEATURE_MODULES = ['health'];

/**
 * The core's own actions, READ OFF THE RUNNING CODE and never a list typed
 * here. A list would say what its author believed; this says what doPost
 * actually answers, which is the only thing that can tell us a module is
 * about to shadow something.
 */
function coreActions_() {
  const out = {};
  try {
    const src = String(doPost);
    let m;
    const pre = /action === '([A-Za-z0-9_]+)'/g;        // ping, login, diag, deviceRequest
    while ((m = pre.exec(src))) out[m[1]] = true;
    const routed = /([A-Za-z0-9_]+):\s*api[A-Za-z0-9]+_/g; // the ROUTES map
    while ((m = routed.exec(src))) out[m[1]] = true;
  } catch (err) { /* an unreadable doPost refuses nothing; the clash check is advisory */ }
  return out;
}

/** Names the district has switched off by hand, without waiting for a deploy. */
function featuresOff_() {
  const out = {};
  try {
    String(PROPS.getProperty('FEATURE_OFF') || '').split(/[,\s]+/).forEach(function (n) {
      if (n) out[n.trim()] = true;
    });
  } catch (err) { /* no properties: nothing is off */ }
  return out;
}

/**
 * Every module this register should carry, with the reason for each one that
 * is not carried. Nothing here throws: a module that cannot be loaded is a
 * module that is skipped and reported, never an outage.
 */
function featureLoad_() {
  const off = featuresOff_(), core = coreActions_();
  const live = [], skipped = [];
  const seen = {};
  FEATURE_MODULES.forEach(function (name) {
    if (off[name]) { skipped.push({ name: name, why: 'switched off by FEATURE_OFF' }); return; }
    let def = null;
    try {
      const g = (typeof globalThis !== 'undefined') ? globalThis : this;
      const fn = g ? g['feature_' + name] : null;
      if (typeof fn !== 'function') { skipped.push({ name: name, why: 'no function feature_' + name }); return; }
      def = fn();
    } catch (err) { skipped.push({ name: name, why: 'threw while loading: ' + err }); return; }
    if (!def || typeof def !== 'object') { skipped.push({ name: name, why: 'returned nothing' }); return; }

    // It may not take over the core, or another module.
    let clash = '';
    Object.keys(def.actions || {}).forEach(function (a) {
      if (core[a]) clash = clash || ('the register already answers action "' + a + '"');
      if (seen[a]) clash = clash || ('module "' + seen[a] + '" already answers action "' + a + '"');
    });
    if (clash) { skipped.push({ name: name, why: 'refused: ' + clash }); return; }

    Object.keys(def.actions || {}).forEach(function (a) { seen[a] = name; });
    def.name = name;
    live.push(def);
  });
  return { live: live, skipped: skipped };
}

/**
 * Offered the request only after ROUTES has declined it and the session has
 * been verified. Returns the handler's plain result, or null when no module
 * answers the action. A module that throws answers its caller plainly and
 * leaves every other part of the register untouched.
 */
function featurePost_(auth, req) {
  const action = String((req && req.action) || '');
  if (!action) return null;
  let loaded;
  try { loaded = featureLoad_(); } catch (err) { return null; }
  for (let i = 0; i < loaded.live.length; i++) {
    const f = loaded.live[i];
    const fn = (f.actions || {})[action];
    if (typeof fn !== 'function') continue;
    try { return fn(auth, req); }
    catch (err) {
      try { audit_('system', 'FEATURE_FAILED', f.name, '', action + ' - ' + err); } catch (e) { /* the answer below still goes out */ }
      return { ok: false, code: 'FEATURE_ERR', feature: f.name,
        msg: 'That part of the register could not answer: ' + err };
    }
  }
  return null;
}

/**
 * ONE TRIGGER FOR ALL OF THEM. A feature that needs daily work declares a
 * `daily` function; featureDaily() runs them, each inside its own try/catch.
 * A trigger per feature means every new feature needs somebody to open the
 * Apps Script editor, and the jobs that already needed that went uninstalled
 * for weeks because nothing said they were missing. Runs at ~07:00, after
 * the day it reports on has closed and before the field is out.
 */
function featureDaily() {
  const out = [];
  let loaded;
  try { loaded = featureLoad_(); } catch (err) { return 'features could not be loaded: ' + err; }
  loaded.live.forEach(function (f) {
    if (typeof f.daily !== 'function') return;
    try { out.push(f.name + ': ' + (f.daily() || 'done')); }
    catch (err) {
      out.push(f.name + ': FAILED - ' + err);
      try { audit_('system', 'FEATURE_DAILY_FAILED', f.name, '', String(err)); } catch (e) { /* logged below */ }
    }
  });
  const said = out.length ? out.join('\n') : 'no feature has daily work';
  Logger.log(said);
  return said;
}

/** Idempotent: deletes its own trigger before creating it. */
function installFeatureTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'featureDaily') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('featureDaily').timeBased().everyDays(1).atHour(7).create();
  Logger.log('featureDaily installed, ~07:00 ' + TZ + '.');
}

/** What diag and the Health screen report, so a feature's presence is read rather than assumed. */
function featureReport_() {
  try {
    const l = featureLoad_();
    return {
      live: l.live.map(function (f) {
        return { name: f.name, title: f.title || '', actions: Object.keys(f.actions || {}),
          daily: typeof f.daily === 'function' };
      }),
      skipped: l.skipped
    };
  } catch (err) { return { error: String(err) }; }
}
