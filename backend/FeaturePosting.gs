/**
 * FeaturePosting.gs — postings: who serves where, changed with a dry run and
 * an audit trail.
 *
 * Ported from the SJGP register, cut to this roll's shape. Here a person is
 * ONE Users row, so a posting is that row's project_code / sector_code /
 * awc_id — never a new row. Three acts, by role:
 *
 *   FIELD (AWT/AWH)   MOVE  to another centre; sector and project follow the
 *                           centre off the AWC master. ADD/DROP do not apply:
 *                           a worker holds one centre.
 *   SUPERVISOR        MOVE  to one sector (replaces the whole charge);
 *                     ADD   a further sector to the charge (dual charge is the
 *                           norm: 20 supervisors cover 27 sectors);
 *                     DROP  one sector from a charge of two or more.
 *   CDPO              MOVE  to another project.
 *   ADMIN             has no posting; the request is refused row by row.
 *
 * THE DRY RUN IS THE SAME CODE AS THE APPLY, minus the writes. The console
 * shows the officer every change with its prior value and its reason for
 * refusal, and only then offers Apply. A refused row is skipped on apply,
 * never half-done; the answer says what was skipped.
 *
 * EVERY CHANGE IS AUDITED with the prior posting (POSTING_MOVE / POSTING_ADD /
 * POSTING_DROP, old = {project_code, sector_code, awc_id}, new = the same
 * three after). The history the console shows is read back off that log, so
 * there is one record and it is the audit.
 *
 * Sectors.supervisor_user_id is kept in step: a sector a supervisor takes
 * points at her; a sector she leaves stops pointing at her (and only then —
 * if the register already names someone else there, that stands).
 */
var POSTING_ACTS = ['MOVE', 'ADD', 'DROP'];
var POSTING_MAX_ROWS = 50;        // one order, not a bulk import — that is Maintenance.gs
var POSTING_HISTORY_SCAN = 3000;  // audit rows read from the tail
var POSTING_HISTORY_MAX = 300;

function feature_posting() {
  return {
    title: 'Postings: move a worker, a supervisor or a CDPO, dry run first, every change audited',
    actions: {
      // action: "postingUpdate"  req: { token, rows:[{uid, act, dest}], dry }
      //   FIELD dest = awc_id · SUPERVISOR dest = sector_code · CDPO dest = project_code
      postingUpdate: function (auth, req) {
        if (String(auth.user.role) !== 'ADMIN') return deny_();
        const rows = Array.isArray(req.rows) ? req.rows.slice(0, POSTING_MAX_ROWS) : [];
        if (!rows.length) return { ok: false, code: 'NO_ROWS' };
        const dry = String(req.dry || '') === '1' || req.dry === true;
        const plan = postingPlan_(rows);
        if (dry) return { ok: true, dry: true, plan: postingPublic_(plan), at: nowIso_() };
        const res = postingApply_(plan, auth.userId);
        return { ok: true, dry: false, applied: res.applied, skipped: res.skipped, plan: postingPublic_(plan), at: nowIso_() };
      },
      // action: "postings"  req: { token }  — recent postings off the audit log
      postings: function (auth, req) {
        const role = String(auth.user.role);
        if (role !== 'ADMIN' && role !== 'CDPO') return deny_();
        const project = role === 'CDPO' ? String(auth.user.project_code) : null;
        return { ok: true, rows: postingHistory_(project), at: nowIso_() };
      }
    }
  };
}

/** The three columns a posting is made of. */
function postingOf_(u) {
  return { project_code: String(u.project_code || ''), sector_code: String(u.sector_code || ''), awc_id: String(u.awc_id || '') };
}
function postingSectors_(u) {
  return String(u.sector_code || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}
/** What a posting reads as, for the officer. */
function postingLabel_(p, role) {
  if (role === 'FIELD') {
    const a = p.awc_id ? getAwc_(p.awc_id) : null;
    return (a ? a.name + ' (' + p.awc_id + ')' : (p.awc_id || 'no centre')) + (p.sector_code ? ' · ' + p.sector_code : '');
  }
  if (role === 'SUPERVISOR') return p.sector_code ? 'sector ' + p.sector_code.split(',').map(function (s) { return s.trim(); }).join(' + ') : 'no sector';
  if (role === 'CDPO') return p.project_code ? 'project ' + p.project_code : 'no project';
  return '—';
}

/**
 * One plan row per request row: what would change and why not. The user row
 * is kept on the plan (as _user) for the apply and stripped before it leaves.
 */
function postingPlan_(rows) {
  const sectors = {};
  getSectors_().forEach(function (s) { sectors[s.code] = s; });
  const projects = {};
  getProjects_().forEach(function (p) { projects[p.code] = p; });
  const seen = {};

  return rows.map(function (r) {
    const uid = String((r && r.uid) || '').trim();
    const act = String((r && r.act) || '').trim().toUpperCase();
    const dest = String((r && r.dest) || '').trim();
    const out = { uid: uid, act: act, dest: dest, name: '', role: '', cadre: '', from: '', to: '', ok: false, why: '' };
    const refuse = function (why) { out.why = why; return out; };

    if (!uid) return refuse('no user id');
    if (POSTING_ACTS.indexOf(act) < 0) return refuse('unknown act ' + (act || '(blank)'));
    if (seen[uid]) return refuse('listed twice: one change per person per order');
    seen[uid] = true;
    const u = getUserById_(uid);
    if (!u) return refuse('no such user');
    const role = String(u.role);
    const before = postingOf_(u);
    out.name = String(u.name); out.role = role; out.cadre = String(u.cadre);
    out.from = postingLabel_(before, role);
    if (String(u.status) !== 'ACTIVE') out.note = 'account is ' + String(u.status);

    let after = null;
    if (role === 'FIELD') {
      if (act !== 'MOVE') return refuse('a worker holds one centre: use Move');
      const a = dest ? getAwc_(dest) : null;
      if (!a) return refuse('no such centre: ' + (dest || '(blank)'));
      if (!a.active) return refuse(a.name + ' is closed in the AWC master');
      if (before.awc_id === a.awc_id) return refuse('already posted at ' + a.name);
      after = { project_code: a.project, sector_code: a.sector, awc_id: a.awc_id };
    } else if (role === 'SUPERVISOR') {
      const s = sectors[dest];
      if (!s) return refuse('no such sector: ' + (dest || '(blank)'));
      const held = postingSectors_(u);
      if (act === 'MOVE') {
        if (held.length === 1 && held[0] === s.code) return refuse('already holds sector ' + s.code + ' alone');
        after = { project_code: s.project, sector_code: s.code, awc_id: '' };
      } else if (act === 'ADD') {
        if (held.indexOf(s.code) >= 0) return refuse('already holds sector ' + s.code);
        after = { project_code: held.length ? before.project_code : s.project, sector_code: held.concat([s.code]).join(','), awc_id: '' };
      } else {
        if (held.indexOf(s.code) < 0) return refuse('does not hold sector ' + s.code);
        if (held.length < 2) return refuse('a supervisor keeps at least one sector: use Move');
        const rest = held.filter(function (c) { return c !== s.code; });
        after = { project_code: (sectors[rest[0]] || {}).project || before.project_code, sector_code: rest.join(','), awc_id: '' };
      }
    } else if (role === 'CDPO') {
      if (act !== 'MOVE') return refuse('a CDPO holds one project: use Move');
      if (!projects[dest]) return refuse('no such project: ' + (dest || '(blank)'));
      if (before.project_code === dest) return refuse('already posted to project ' + dest);
      after = { project_code: dest, sector_code: '', awc_id: '' };
    } else {
      return refuse('the district account has no posting');
    }

    out.ok = true;
    out.to = postingLabel_(after, role);
    out.before = before;
    out.after = after;
    out._user = u;
    return out;
  });
}

function postingPublic_(plan) {
  return plan.map(function (p) {
    const o = {};
    Object.keys(p).forEach(function (k) { if (k !== '_user') o[k] = p[k]; });
    return o;
  });
}

/** Writes every ok row under one lock; refused rows are counted, not touched. */
function postingApply_(plan, actor) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let applied = 0, skipped = 0, sectorsTouched = false;
  try {
    const ssh = masterSS_().getSheetByName('Sectors');
    const sectorRow = function (code) { return ssh ? findRowByValue_(ssh, 1, code) : 0; };
    plan.forEach(function (p) {
      if (!p.ok) { skipped++; return; }
      const u = p._user;
      updateUser_(u, p.after);
      if (p.role === 'SUPERVISOR' && ssh) {
        const was = p.before.sector_code.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        const now = p.after.sector_code.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        now.forEach(function (code) {
          if (was.indexOf(code) >= 0) return;
          const row = sectorRow(code);
          if (row) { ssh.getRange(row, 4).setValue(p.uid); sectorsTouched = true; }
        });
        was.forEach(function (code) {
          if (now.indexOf(code) >= 0) return;
          const row = sectorRow(code);
          if (row && String(ssh.getRange(row, 4).getValue()) === p.uid) { ssh.getRange(row, 4).setValue(''); sectorsTouched = true; }
        });
      }
      audit_(actor, 'POSTING_' + p.act, p.uid, p.before, p.after);
      p.appliedAt = nowIso_();
      applied++;
    });
  } finally {
    lock.releaseLock();
  }
  if (sectorsTouched) CACHE.remove('sectors');
  return { applied: applied, skipped: skipped };
}

/** Recent postings off the audit log, newest first. A CDPO sees moves into or out of her project. */
function postingHistory_(project) {
  const sh = masterSS_().getSheetByName('Audit');
  const last = sh ? sh.getLastRow() : 0;
  if (last < 2) return [];
  const start = Math.max(2, last - POSTING_HISTORY_SCAN + 1);
  const vals = sh.getRange(start, 1, last - start + 1, AUD_H.length).getValues();
  const parse = function (s) { try { return JSON.parse(String(s || '')) || {}; } catch (e) { return {}; } };
  const out = [];
  for (let i = vals.length - 1; i >= 0 && out.length < POSTING_HISTORY_MAX; i--) {
    const action = String(vals[i][2] || '');
    if (action.indexOf('POSTING_') !== 0) continue;
    const before = parse(vals[i][4]), after = parse(vals[i][5]);
    if (project && String(before.project_code) !== project && String(after.project_code) !== project) continue;
    out.push({ at: String(vals[i][0]), by: String(vals[i][1]), act: action.slice(8), uid: String(vals[i][3]), before: before, after: after });
  }
  return out;
}
