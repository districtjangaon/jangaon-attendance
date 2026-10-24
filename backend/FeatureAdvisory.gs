/**
 * FeatureAdvisory.gs — a circular from the district to every phone.
 *
 * Ported from the SJGP register. The district publishes one advisory at a
 * time: a title, one line of instruction, and optionally the signed page as a
 * PDF, Word file or image. It opens on every addressed worker's home screen
 * and stays there until she acknowledges it. The console can then say, by
 * name, who has read it and who has not.
 *
 * AN ACKNOWLEDGEMENT IS RECEIPT, NOT COMPLIANCE. It records that the worker
 * saw the circular. It is not evidence that she acted on it.
 *
 * NOTHING IS DESTROYED. Publishing a new advisory retires the standing one to
 * SUPERSEDED; the district may also retire one by order (RETIRED, with the
 * day and the hand). Either way the row stays and every receipt against it
 * stands. Both tabs are append-only in spirit: the only cell ever changed is
 * a status.
 *
 * WHO A CIRCULAR IS ADDRESSED TO: an audience (ALL, a cadre AWT/AWH, or the
 * role SUPERVISOR) and a list of sectors (empty means the whole district).
 * The two compose. ADMIN accounts issue circulars and are never addressed.
 *
 * THE FILE. A circular is a government instruction meant to be read by the
 * staff it addresses, so the stored copy is shared view-only to anyone with
 * the link, the way a circular on a notice board is. Attendance photographs
 * live elsewhere and are never shared this way.
 */
var ADV_H = ['adv_id', 'title', 'message', 'file_name', 'mime', 'size_kb', 'file_id', 'url',
  'published_at', 'published_by', 'audience', 'sectors', 'status', 'retired_at', 'retired_by'];
var ADV_ACK_H = ['adv_id', 'user_id', 'ack_at', 'received_at'];
var ADV_FOLDER_NAME = 'Sisu Mahila Samridhi — Advisories';
var ADV_MAX_KB = 12 * 1024;
var ADV_EXT = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png'
};
var ADV_AUDIENCES = { ALL: 1, AWT: 1, AWH: 1, SUPERVISOR: 1 };

function feature_advisory() {
  return {
    title: 'Advisories: a circular from the district, opened on every phone until acknowledged',
    actions: {
      // action: "advisory"  req: { token, id? }   a worker's own view, or the district's register
      advisory: function (auth, req) {
        const u = auth.user, role = String(u.role);
        if (role === 'ADMIN' || role === 'CDPO') return advRegister_(u, String((req && req.id) || ''));
        return advMine_(u);
      },
      // action: "advPublish"  req: { token, title, message, audience, sectors:[], file:{name,b64}? }
      advPublish: function (auth, req) {
        if (String(auth.user.role) !== 'ADMIN') return deny_();
        return advPublish_(auth, req || {});
      },
      // action: "advRetire"  req: { token, id }
      advRetire: function (auth, req) {
        if (String(auth.user.role) !== 'ADMIN') return deny_();
        return advRetire_(auth, String((req && req.id) || '').trim());
      },
      // action: "advAck"  req: { token, id, at? }
      advAck: function (auth, req) {
        if (String(auth.user.role) === 'ADMIN') return deny_();
        return advAck_(auth, req || {});
      }
    }
  };
}

function advSheet_(name, H) {
  const ss = masterSS_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, H.length).setValues([H]);
    sh.getRange(1, 1, sh.getMaxRows(), H.length).setNumberFormat('@');
  }
  return sh;
}
function advSectorList_(v) {
  if (v == null || v === '') return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const out = [], seen = {};
  arr.forEach(function (x) {
    const t = String(x || '').trim().toUpperCase();
    if (!t || seen[t]) return;
    seen[t] = true; out.push(t);
  });
  return out;
}
function advRowObj_(r, i) {
  const o = rowToObj_(ADV_H, r);
  return { id: String(o.adv_id), title: String(o.title), message: String(o.message),
    fileName: String(o.file_name || ''), url: String(o.url || ''),
    audience: String(o.audience || 'ALL').toUpperCase() || 'ALL',
    sectors: advSectorList_(o.sectors),
    publishedAt: String(o.published_at || ''), publishedBy: String(o.published_by || ''),
    status: String(o.status || 'ACTIVE'), retiredAt: String(o.retired_at || ''),
    retiredBy: String(o.retired_by || ''), _row: i + 2 };
}
/** Every circular, newest first. A blank row is not a circular. */
function advAll_() {
  const sh = advSheet_('Advisories', ADV_H);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, ADV_H.length).getValues()
    .map(advRowObj_).filter(function (a) { return !!a.id; }).reverse();
}
/** Whether a circular addresses this user: a role or cadre, and a sector, and they compose. */
function advApplies_(adv, u) {
  const role = String(u.role || '').toUpperCase();
  if (role === 'ADMIN') return false;
  const a = String((adv && adv.audience) || 'ALL').toUpperCase();
  if (a !== 'ALL' && a !== role && a !== String(u.cadre || '').toUpperCase()) return false;
  const ss = advSectorList_(adv && adv.sectors);
  if (!ss.length) return true;
  const mine = String(u.sector_code || '').split(',').map(function (s) { return s.trim().toUpperCase(); });
  return mine.some(function (s) { return s && ss.indexOf(s) >= 0; });
}
/** Receipts: { advId -> { userId -> receivedAt } } */
function advAcks_() {
  const sh = advSheet_('AdvAck', ADV_ACK_H);
  const last = sh.getLastRow(), out = {};
  if (last < 2) return out;
  sh.getRange(2, 1, last - 1, ADV_ACK_H.length).getValues().forEach(function (r) {
    const id = String(r[0] || ''), uid = String(r[1] || '');
    if (!id || !uid) return;
    (out[id] = out[id] || {})[uid] = String(r[3] || r[2] || '');
  });
  return out;
}

/** A worker's own view: the circular standing for her, her receipt, and the recent ones she may reopen. */
function advMine_(u) {
  const uid = String(u.user_id);
  const all = advAll_(), acks = advAcks_();
  const standing = all.filter(function (a) { return a.status === 'ACTIVE' && advApplies_(a, u); })[0] || null;
  const recent = [];
  all.forEach(function (a) {
    if (recent.length >= 8 || !advApplies_(a, u)) return;
    recent.push({ id: a.id, title: a.title, message: a.message, url: a.url, audience: a.audience,
      publishedAt: a.publishedAt, publishedBy: a.publishedBy, standing: a.status === 'ACTIVE',
      acknowledged: !!(acks[a.id] && acks[a.id][uid]), ackAt: (acks[a.id] && acks[a.id][uid]) || '' });
  });
  return { ok: true,
    advisory: standing ? { id: standing.id, title: standing.title, message: standing.message, url: standing.url,
      fileName: standing.fileName, publishedAt: standing.publishedAt, publishedBy: standing.publishedBy } : null,
    acknowledged: !!(standing && acks[standing.id] && acks[standing.id][uid]),
    ackAt: (standing && acks[standing.id] && acks[standing.id][uid]) || '',
    recent: recent };
}

/** The district's register: the circular standing (or the one asked for), who has read it, every circular with its tally. */
function advRegister_(u, idReq) {
  const all = advAll_(), acks = advAcks_();
  const standing = all.filter(function (a) { return a.status === 'ACTIVE'; })[0] || null;
  const adv = idReq ? (all.filter(function (a) { return a.id === idReq; })[0] || standing) : standing;
  const scope = sectorScope_(u);     // null for ADMIN; the project's sectors for a CDPO
  const sectorName = {};
  getSectors_().forEach(function (s) { sectorName[s.code] = s.name; });
  const everyone = getUsersAll_().filter(function (x) {
    if (String(x.status) !== 'ACTIVE' || String(x.role) === 'ADMIN') return false;
    if (scope && !String(x.sector_code).split(',').some(function (s) { return scope.indexOf(s.trim()) >= 0; })) return false;
    return true;
  });
  const got = adv ? (acks[adv.id] || {}) : {};
  const roll = [];
  everyone.forEach(function (x) {
    if (!advApplies_(adv || { audience: 'ALL' }, x)) return;
    const uid = String(x.user_id);
    roll.push({ u: uid, name: String(x.name), cadre: String(x.cadre), role: String(x.role),
      sc: primarySector_(x), acknowledged: !!got[uid], ackAt: got[uid] || '' });
  });
  roll.sort(function (a, b) { return a.sc.localeCompare(b.sc) || a.name.localeCompare(b.name); });
  const done = roll.filter(function (r) { return r.acknowledged; }).length;
  const bySector = {};
  roll.forEach(function (r) {
    const c = bySector[r.sc] = bySector[r.sc] || { sc: r.sc, name: sectorName[r.sc] || r.sc, due: 0, acknowledged: 0 };
    c.due++; if (r.acknowledged) c.acknowledged++;
  });
  // the composer must be able to say who it will reach before it reaches them
  const counts = { total: 0, byAudience: {}, bySector: {} };
  everyone.forEach(function (x) {
    const sc = primarySector_(x), keys = ['ALL', String(x.cadre).toUpperCase(), String(x.role).toUpperCase()];
    counts.total++;
    const s = counts.bySector[sc] = counts.bySector[sc] || {};
    keys.forEach(function (k) {
      if (!ADV_AUDIENCES[k]) return;
      counts.byAudience[k] = (counts.byAudience[k] || 0) + 1;
      s[k] = (s[k] || 0) + 1;
    });
  });
  const list = all.map(function (a) {
    const g = acks[a.id] || {};
    let due = 0, d2 = 0;
    everyone.forEach(function (x) { if (!advApplies_(a, x)) return; due++; if (g[String(x.user_id)]) d2++; });
    return { id: a.id, title: a.title, publishedAt: a.publishedAt, publishedBy: a.publishedBy, status: a.status,
      retiredAt: a.retiredAt, retiredBy: a.retiredBy, audience: a.audience, sectors: a.sectors, url: a.url,
      due: due, acknowledged: d2, pending: due - d2 };
  });
  return { ok: true, advisory: adv, roll: roll, list: list,
    viewing: adv ? adv.id : '', standing: standing ? standing.id : '',
    totals: { due: roll.length, acknowledged: done, pending: roll.length - done },
    coverage: Object.keys(bySector).sort().map(function (k) { return bySector[k]; }),
    counts: counts, canPublish: String(u.role) === 'ADMIN' };
}

function advFolder_() {
  const existing = DriveApp.getFoldersByName(ADV_FOLDER_NAME);
  const root = existing.hasNext() ? existing.next() : DriveApp.createFolder(ADV_FOLDER_NAME);
  const y = Utilities.formatDate(new Date(), TZ, 'yyyy');
  const sub = root.getFoldersByName(y);
  return sub.hasNext() ? sub.next() : root.createFolder(y);
}

function advPublish_(auth, b) {
  const u = auth.user;
  const title = String(b.title || '').trim(), message = String(b.message || '').trim();
  if (!title) return { ok: false, code: 'NO_TITLE', msg: 'An advisory needs a title.' };
  if (!message) return { ok: false, code: 'NO_MESSAGE', msg: 'An advisory needs a line of instruction; that is what the worker reads first.' };
  const audience = String(b.audience || 'ALL').toUpperCase();
  if (!ADV_AUDIENCES[audience]) return { ok: false, code: 'BAD_AUDIENCE', msg: 'The audience must be ALL, AWT, AWH or SUPERVISOR.' };
  const known = {};
  getSectors_().forEach(function (s) { known[s.code] = true; });
  const sectors = advSectorList_(b.sectors).filter(function (s) { return known[s]; });

  let url = '', fileId = '', fileName = '', mime = '', sizeKB = 0;
  const f = b.file || {};
  if (f.b64 && f.name) {
    const ext = String(f.name).split('.').pop().toLowerCase();
    if (!ADV_EXT[ext]) return { ok: false, code: 'BAD_FILE', msg: 'An advisory may be a PDF, a Word document or an image.' };
    sizeKB = Math.round((String(f.b64).length * 3 / 4) / 1024);
    if (sizeKB > ADV_MAX_KB) return { ok: false, code: 'TOO_BIG', msg: 'That file is about ' + Math.round(sizeKB / 1024) + ' MB. The limit is ' + Math.round(ADV_MAX_KB / 1024) + ' MB.' };
    try {
      const file = advFolder_().createFile(Utilities.newBlob(Utilities.base64Decode(f.b64), ADV_EXT[ext],
        'ADV_' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd') + '_' + title.replace(/[^\w\-]+/g, '_').slice(0, 60) + '.' + ext));
      fileId = file.getId(); url = file.getUrl(); fileName = String(f.name); mime = ADV_EXT[ext];
      try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { /* the link still works for signed-in staff */ }
    } catch (err) {
      return { ok: false, code: 'FILE_FAILED', msg: 'The file could not be stored (' + err + '). Nothing was published.' };
    }
  }

  const sh = advSheet_('Advisories', ADV_H);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let id = '';
  try {
    // the standing circular steps down; it is not deleted, and the receipts against it stand
    const last = sh.getLastRow();
    if (last >= 2) {
      const st = sh.getRange(2, 13, last - 1, 1).getValues();   // status column
      for (let i = 0; i < st.length; i++) {
        if (String(st[i][0] || 'ACTIVE') === 'ACTIVE' && String(sh.getRange(i + 2, 1).getValue())) sh.getRange(i + 2, 13).setValue('SUPERSEDED');
      }
    }
    id = 'ADV-' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd') + '-' + Utilities.getUuid().slice(0, 4).toUpperCase();
    sh.appendRow([id, title, message, fileName, mime, sizeKB, fileId, url, nowIso_(),
      String(u.name) + ' (' + String(u.role) + ')', audience, sectors.join(','), 'ACTIVE', '', '']);
  } finally { lock.releaseLock(); }
  audit_(String(u.user_id), 'ADVISORY_PUBLISHED', id, '', title + ' to ' + audience + (sectors.length ? ' in ' + sectors.join(',') : ' district-wide'));
  CACHE.remove('adv_standing');
  return { ok: true, id: id, url: url, title: title };
}

function advRetire_(auth, id) {
  if (!id) return { ok: false, code: 'NO_ID', msg: 'Say which circular is to be retired; an order is passed by id.' };
  const sh = advSheet_('Advisories', ADV_H);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const last = sh.getLastRow();
    if (last < 2) return { ok: false, code: 'NO_SUCH', msg: 'No circular carries the id ' + id + '.' };
    const ids = sh.getRange(2, 1, last - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) !== id) continue;
      const row = i + 2;
      const status = String(sh.getRange(row, 13).getValue() || 'ACTIVE');
      const title = String(sh.getRange(row, 2).getValue());
      if (status !== 'ACTIVE') return { ok: true, id: id, title: title, already: true, status: status };
      sh.getRange(row, 13, 1, 3).setValues([['RETIRED', nowIso_(), String(auth.user.name) + ' (' + String(auth.user.role) + ')']]);
      audit_(String(auth.user.user_id), 'ADVISORY_RETIRED', id, 'ACTIVE', 'RETIRED: ' + title + ' (the receipts stand)');
      return { ok: true, id: id, title: title, status: 'RETIRED' };
    }
    return { ok: false, code: 'NO_SUCH', msg: 'No circular carries the id ' + id + '.' };
  } finally { lock.releaseLock(); }
}

/** Idempotent: a double tap, or a re-send after the signal returned, never writes a second receipt. */
function advAck_(auth, b) {
  const uid = String(auth.userId);
  let id = String(b.id || '').trim();
  if (!id) {
    const s = advAll_().filter(function (a) { return a.status === 'ACTIVE' && advApplies_(a, auth.user); })[0];
    id = s ? s.id : '';
  }
  if (!id) return { ok: false, code: 'NONE_STANDING', msg: 'There is no advisory standing.' };
  const sh = advSheet_('AdvAck', ADV_ACK_H);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const last = sh.getLastRow();
    if (last >= 2) {
      const v = sh.getRange(2, 1, last - 1, 3).getValues();
      for (let i = 0; i < v.length; i++) {
        if (String(v[i][0]) === id && String(v[i][1]) === uid) return { ok: true, already: true, ackAt: String(v[i][2] || '') };
      }
    }
    // the handset's claim is kept, but the district's own clock is what the register is read by
    sh.appendRow([id, uid, String(b.at || nowIso_()), nowIso_()]);
  } finally { lock.releaseLock(); }
  return { ok: true, ackAt: nowIso_() };
}
