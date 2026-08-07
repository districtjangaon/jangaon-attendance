/**
 * Marks.gs — the write path: batched sync with idempotency, LockService,
 * geofence classification, anti-fraud flags, photo storage, monthly rollover.
 * Plus the token-checked photo proxy and the user's own history.
 */

/**
 * action: "sync"
 * req: { token, deviceNow: epochMs, records: [{ key, clientTs, lat, lng,
 *        accuracy, photoB64, deviceId, appVersion, netState }] }
 * Key format: {user_id}_{yyyymmdd}_{IN|OUT} — deterministic, so the
 * one-IN-one-OUT-per-day rule IS the dedupe rule.
 */
function apiSync_(auth, req) {
  const user = auth.user;
  const records = req.records || [];
  if (!records.length) return { ok: true, acks: [], serverTs: nowIso_() };
  if (records.length > BATCH_MAX) return { ok: false, code: 'BATCH_TOO_BIG' };

  const serverMs = Date.now();
  const deviceNowMs = Number(req.deviceNow) || 0;
  const skewSec = deviceNowMs ? Math.round((serverMs - deviceNowMs) / 1000) : '';

  const acks = [];
  const prepared = [];
  for (const rec of records) {
    const key = String(rec.key || '');
    const m = key.match(/^(U\d+)_(\d{8})_(IN|OUT)$/);
    if (!m || m[1] !== String(user.user_id)) {
      // A client may only ever write its own marks — enforced from the token.
      // On a shared centre phone each user syncs under their own session.
      acks.push({ key: key, status: 'REJECTED' });
      continue;
    }
    if (CACHE.get('mk_' + key)) {
      acks.push({ key: key, status: 'DUP' });
      continue;
    }
    prepared.push({ rec: rec, key: key, dateStr: m[2], type: m[3] });
  }

  // Photos go to Drive BEFORE we take the lock — Drive writes don't contend,
  // and a failed photo upload must never block the attendance record.
  for (const it of prepared) {
    it.photoId = '';
    it.photoFlag = '';
    if (it.rec.photoB64) {
      try {
        it.photoId = storePhoto_(it.dateStr, it.key, String(it.rec.photoB64));
      } catch (err) {
        it.photoFlag = 'UPLOAD_FAILED';
      }
    } else {
      it.photoFlag = 'NO_PHOTO';
    }
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    // Client keeps the records queued and retries with backoff. Nothing lost.
    return { ok: false, code: 'BUSY', retryable: true };
  }

  try {
    const byMonth = {};
    prepared.forEach(it => {
      const ym = it.dateStr.slice(0, 4) + '-' + it.dateStr.slice(4, 6);
      (byMonth[ym] = byMonth[ym] || []).push(it);
    });
    Object.keys(byMonth).forEach(ym => {
      const ss = getMonthSS_(ym);
      const sh = ss.getSheetByName('Marks');
      const rows = [];
      byMonth[ym].forEach(it => {
        if (findRowByValue_(sh, 1, it.key)) {
          acks.push({ key: it.key, status: 'DUP' });
        } else {
          rows.push(buildMarkRow_(user, it, skewSec, serverMs));
          acks.push({ key: it.key, status: 'OK' });
        }
        CACHE.put('mk_' + it.key, '1', 21600);
      });
      if (rows.length) {
        sh.getRange(sh.getLastRow() + 1, 1, rows.length, MARKS_H.length).setValues(rows);
      }
    });
  } finally {
    lock.releaseLock();
  }
  return { ok: true, acks: acks, serverTs: nowIso_() };
}

function buildMarkRow_(user, it, skewSec, serverMs) {
  const rec = it.rec;
  const hasFix = rec.lat != null && rec.lat !== '' && rec.lng != null && rec.lng !== '';
  const lat = hasFix ? Number(Number(rec.lat).toFixed(6)) : '';
  const lng = hasFix ? Number(Number(rec.lng).toFixed(6)) : '';
  const acc = rec.accuracy != null && rec.accuracy !== '' ? Math.round(Number(rec.accuracy)) : '';

  const gf = classifyGeofence_(user, hasFix ? lat : null, hasFix ? lng : null, acc === '' ? null : acc);

  const flags = [];
  if (it.photoFlag) flags.push(it.photoFlag);

  const clientMs = new Date(String(rec.clientTs || '')).getTime();
  const syncDelay = isNaN(clientMs) ? '' : Math.max(0, Math.round((serverMs - clientMs) / 1000));
  if (syncDelay !== '' && syncDelay > 86400) flags.push('LATE_SYNC');
  if (skewSec !== '' && Math.abs(skewSec) > 300) flags.push('CLOCK_SKEW');
  if (acc !== '' && acc > 0 && acc <= 3) flags.push('PERFECT_ACCURACY');

  // Velocity + repeated-coordinates checks against the user's previous mark
  // (cached 6 h; the nightly job re-runs these across the whole month).
  if (hasFix) {
    const prevRaw = CACHE.get('lastm_' + user.user_id);
    if (prevRaw) {
      const prev = JSON.parse(prevRaw);
      if (prev.lat === lat && prev.lng === lng) flags.push('REPEAT_COORDS');
      if (!isNaN(clientMs) && prev.ms && clientMs > prev.ms) {
        const kmh = (distM_(prev.lat, prev.lng, lat, lng) / 1000) / ((clientMs - prev.ms) / 3600000);
        if (kmh > 150) flags.push('IMPOSSIBLE_VELOCITY');
      }
    }
    CACHE.put('lastm_' + user.user_id,
      JSON.stringify({ lat: lat, lng: lng, ms: isNaN(clientMs) ? 0 : clientMs }), 21600);
  }

  return [
    it.key, String(user.user_id), String(user.sector_code), String(user.cadre), it.type,
    String(rec.clientTs || ''), fmtIso_(serverMs), skewSec,
    lat, lng, acc, gf.status, gf.awcId, gf.dist, it.photoId,
    String(rec.deviceId || ''), String(rec.appVersion || ''), String(rec.netState || ''),
    syncDelay, flags.join(',')
  ];
}

/**
 * INSIDE / OUTSIDE / UNVERIFIED against the user's geofence candidates:
 * a field user's own AWC, or every AWC in a supervisor's sector. AWCs whose
 * coordinates were blanked at import (out-of-district errors) drop out of the
 * candidate list, so marks there classify UNVERIFIED — never falsely OUTSIDE.
 */
function classifyGeofence_(user, lat, lng, acc) {
  if (lat == null || lng == null) return { status: 'UNVERIFIED', awcId: '', dist: '' };
  if (acc != null && acc > GPS_UNVERIFIED_ACC_M) return { status: 'UNVERIFIED', awcId: '', dist: '' };
  const awcs = geofenceCandidatesFor_(user).filter(a => a.lat != null && a.lng != null);
  if (!awcs.length) return { status: 'UNVERIFIED', awcId: '', dist: '' };
  let best = null, bestDist = Infinity;
  for (const a of awcs) {
    const d = distM_(lat, lng, a.lat, a.lng);
    if (d < bestDist) { bestDist = d; best = a; }
  }
  return {
    status: bestDist <= best.radius_m ? 'INSIDE' : 'OUTSIDE',
    awcId: best.awc_id,
    dist: bestDist
  };
}

// ---- photo storage ----
function storePhoto_(dateStr, key, b64) {
  const clean = b64.replace(/^data:image\/\w+;base64,/, '');
  const blob = Utilities.newBlob(Utilities.base64Decode(clean), 'image/jpeg', key + '.jpg');
  const day = dateStr.slice(0, 4) + '-' + dateStr.slice(4, 6) + '-' + dateStr.slice(6, 8);
  return getDailyFolder_(day).createFile(blob).getId();
}

function getDailyFolder_(day) {
  const c = CACHE.get('pf_' + day);
  if (c) return DriveApp.getFolderById(c);
  const root = DriveApp.getFolderById(PROPS.getProperty('PHOTOS_ROOT_ID'));
  const existing = root.getFoldersByName(day);
  const folder = existing.hasNext() ? existing.next() : root.createFolder(day);
  CACHE.put('pf_' + day, folder.getId(), 21600);
  return folder;
}

// ---- monthly rollover ----
/**
 * Returns (and lazily creates) the ATT_yyyy-MM spreadsheet.
 * NOT internally locked: the sync path already holds the script lock when it
 * gets here (LockService locks are not reentrant); trigger paths must acquire
 * the lock before calling with creation enabled.
 */
function getMonthSS_(ym, noCreate) {
  const prop = 'ATT_' + ym;
  let id = PROPS.getProperty(prop);
  if (id) return SpreadsheetApp.openById(id);
  if (noCreate) return null;

  const ss = SpreadsheetApp.create('ATT_' + ym.replace('-', '_'));
  ss.setSpreadsheetTimeZone(TZ);
  const marks = ss.insertSheet('Marks');
  marks.getRange(1, 1, 1, MARKS_H.length).setValues([MARKS_H]);
  marks.getRange('A:T').setNumberFormat('@');
  const corr = ss.insertSheet('Corrections');
  corr.getRange(1, 1, 1, CORR_H.length).setValues([CORR_H]);
  corr.getRange('A:F').setNumberFormat('@');
  const meta = ss.insertSheet('Meta');
  meta.getRange(1, 1, 2, 2).setValues([['today_date', ''], ['today_start_row', '2']]);
  const def = ss.getSheetByName('Sheet1');
  if (def) ss.deleteSheet(def);
  PROPS.setProperty(prop, ss.getId());
  return ss;
}

// ---- photo proxy (the only non-static console read besides admin actions) ----
function apiPhoto_(params) {
  const auth = verifyToken_(params.token);
  if (!auth.ok) return jsonOut_(auth);
  const fileId = String(params.id || '');
  if (!fileId) return jsonOut_({ ok: false, code: 'NO_ID' });

  let file;
  try {
    file = DriveApp.getFileById(fileId);
  } catch (e) {
    return jsonOut_({ ok: false, code: 'NOT_FOUND' });
  }
  // The file must live inside our photos tree — this endpoint runs as the
  // owner, so without this check any Drive file id would be readable.
  const parents = file.getParents();
  if (!parents.hasNext()) return jsonOut_({ ok: false, code: 'FORBIDDEN' });
  const dayFolder = parents.next();
  const gp = dayFolder.getParents();
  if (!gp.hasNext() || gp.next().getId() !== PROPS.getProperty('PHOTOS_ROOT_ID')) {
    return jsonOut_({ ok: false, code: 'FORBIDDEN' });
  }

  const targetUid = file.getName().split('_')[0];
  const viewer = auth.user;
  if (viewer.role === 'FIELD' && targetUid !== String(viewer.user_id)) {
    return jsonOut_({ ok: false, code: 'FORBIDDEN' });
  }
  if (viewer.role === 'SUPERVISOR' || viewer.role === 'CDPO') {
    const target = getUserById_(targetUid);
    if (!target || !inScope_(viewer, target)) {
      return jsonOut_({ ok: false, code: 'FORBIDDEN' });
    }
  }
  return jsonOut_({ ok: true, mime: 'image/jpeg', b64: Utilities.base64Encode(file.getBlob().getBytes()) });
}

// ---- own history (used after reinstall; day-to-day history is client-local) ----
function apiMyHistory_(auth, req) {
  const now = new Date();
  const yms = [Utilities.formatDate(now, TZ, 'yyyy-MM')];
  const prevYm = Utilities.formatDate(new Date(now.getTime() - 32 * 86400000), TZ, 'yyyy-MM');
  if (prevYm !== yms[0]) yms.push(prevYm);

  const out = [];
  for (const ym of yms) {
    const ss = getMonthSS_(ym, true);
    if (!ss) continue;
    const sh = ss.getSheetByName('Marks');
    const rows = findRowsByValue_(sh, 2, auth.userId).slice(-80);
    for (const r of rows) {
      const o = rowToObj_(MARKS_H, sh.getRange(r, 1, 1, MARKS_H.length).getValues()[0]);
      out.push({
        key: String(o.key), type: String(o.type), clientTs: String(o.client_ts),
        gf: String(o.geofence), flags: String(o.flags)
      });
    }
  }
  return { ok: true, marks: out };
}
