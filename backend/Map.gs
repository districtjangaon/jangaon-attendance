/**
 * Map.gs — the live district map: seen pings, last-known fixes, and the
 * pre-computed payload the console draws.
 *
 * This is a record used to act against people. A pin that overstates what is
 * known accuses someone of something they did not do, so every position on
 * the map is one of exactly three things and says which:
 *
 *   1. a mark taken today, at the place it was taken;
 *   2. a seen ping — "the app was opened here at HH:MM today", never
 *      presented as attendance;
 *   3. the person's last located mark, dated — "last marked here on
 *      dd.mm.yyyy".
 *
 * There is no fourth case. An AWC centroid, a sector office, a unit address:
 * none of these are ever used to place a person. Someone with no coordinates
 * of their own simply does not appear on the map.
 *
 * WHERE THE PAYLOAD LIVES. today.json is committed to a PUBLIC GitHub Pages
 * repo, which is why it is pseudonymous — ids, never names. Precise GPS of
 * identifiable government employees must not go there at all, so the map
 * payload is written to the MapCache sheet in the private master spreadsheet
 * and served through an authorised, scope-checked call instead. The console
 * still never touches the raw attendance sheet: buildMapDay_ runs inside the
 * summary trigger that has already read today's marks, and apiMapDay_ only
 * reads back the finished blob.
 */

// ---- seen pings -----------------------------------------------------------

/**
 * APPEND-ONLY, deliberately.
 *
 * The obvious shape is one row per person per day updated in place. At this
 * district's load that means up to 400 read-modify-write cycles inside the
 * same 45-minute window as the marking peak, each holding the script lock
 * while it searches for its own row — the exact contention this system is
 * built to avoid. Appending is a single unlocked write; the read path keeps
 * the latest ping per person per day, and pruneSeen_() drops anything older
 * than a week each night, so the sheet stays around 7,000 rows.
 */
function seenSheet_() {
  const ss = masterSS_();
  let sh = ss.getSheetByName('Seen');
  if (!sh) {
    sh = ss.insertSheet('Seen');
    sh.getRange(1, 1, 1, SEEN_H.length).setValues([SEEN_H]);
    sh.getRange(1, 1, sh.getMaxRows(), SEEN_H.length).setNumberFormat('@');
  }
  return sh;
}

// action: "seenPing"  req: { token, lat, lng, acc, at }
// Sent once per person per working day when the app is opened. It is NOT
// attendance and is never counted as any: it exists so the map can say where
// an unmarked person's phone was TODAY instead of showing last week's pin.
function apiSeenPing_(auth, req) {
  const today = fmtDay_(Date.now());
  // One ping per person per day is all that is useful. The client also holds
  // a per-day guard, but a reinstall or a second device would defeat that,
  // so the server keeps its own cheap cache guard.
  const guard = 'seen_' + today + '_' + auth.userId;
  if (CACHE.get(guard)) return { ok: true, deduped: true };

  const lat = numOrBlank_(req.lat);
  const lng = numOrBlank_(req.lng);
  const acc = numOrBlank_(req.acc);
  if (lat === '' || lng === '') return { ok: false, code: 'NO_FIX' };

  seenSheet_().appendRow([today, String(auth.userId), String(req.at || nowIso_()),
    Number(Number(lat).toFixed(6)), Number(Number(lng).toFixed(6)),
    acc === '' ? '' : Math.round(acc), nowIso_()]);
  CACHE.put(guard, '1', 21600);
  return { ok: true };
}

function numOrBlank_(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  return isFinite(n) ? n : '';
}

/** Latest ping per user for one date: { uid -> {at, lat, lng, acc} }. */
function seenForDate_(date) {
  const sh = seenSheet_();
  const last = sh.getLastRow();
  if (last < 2) return {};
  const vals = sh.getRange(2, 1, last - 1, SEEN_H.length).getValues();
  const out = {};
  for (const v of vals) {
    const o = rowToObj_(SEEN_H, v);
    if (String(o.date) !== date) continue;
    if (o.lat === '' || o.lng === '') continue;
    const uid = String(o.user_id);
    // Later rows win: the newest ping of the day is the honest one.
    if (!out[uid] || String(o.at) >= String(out[uid].at)) {
      out[uid] = { at: String(o.at), lat: Number(o.lat), lng: Number(o.lng),
        acc: o.accuracy_m === '' ? null : Number(o.accuracy_m) };
    }
  }
  return out;
}

/** Nightly: keep a week of pings, drop the rest. Called from nightlyJob(). */
function pruneSeen_() {
  const sh = seenSheet_();
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const cutoff = fmtDay_(Date.now() - 7 * 86400000);
  const dates = sh.getRange(2, 1, last - 1, 1).getValues();
  // Rows are appended in date order, so everything to drop is a leading block.
  let keepFrom = 0;
  while (keepFrom < dates.length && String(dates[keepFrom][0]) < cutoff) keepFrom++;
  if (keepFrom > 0) sh.deleteRows(2, keepFrom);
  return keepFrom;
}

// ---- last located mark ----------------------------------------------------

function lastFixSheet_() {
  const ss = masterSS_();
  let sh = ss.getSheetByName('LastFix');
  if (!sh) {
    sh = ss.insertSheet('LastFix');
    sh.getRange(1, 1, 1, LASTFIX_H.length).setValues([LASTFIX_H]);
    sh.getRange(1, 1, sh.getMaxRows(), LASTFIX_H.length).setNumberFormat('@');
  }
  return sh;
}

/**
 * Rewrite the whole LastFix table. Called from the nightly job, which has
 * already read the month's marks — deriving it there costs nothing extra,
 * whereas maintaining it on the sync path would add a write per mark.
 * `fixes` is { uid -> {date, at, lat, lng, acc} }; existing entries survive
 * unless the month supplies something newer.
 */
function writeLastFixes_(fixes) {
  const sh = lastFixSheet_();
  const last = sh.getLastRow();
  const merged = {};
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, LASTFIX_H.length).getValues().forEach(function (v) {
      const o = rowToObj_(LASTFIX_H, v);
      if (!o.user_id) return;
      merged[String(o.user_id)] = { date: String(o.date), at: String(o.at),
        lat: Number(o.lat), lng: Number(o.lng),
        acc: o.accuracy_m === '' ? null : Number(o.accuracy_m) };
    });
  }
  Object.keys(fixes).forEach(function (uid) {
    const f = fixes[uid];
    const cur = merged[uid];
    if (!cur || String(f.date) >= String(cur.date)) merged[uid] = f;
  });

  const uids = Object.keys(merged).sort();
  const rows = uids.map(function (uid) {
    const f = merged[uid];
    return [uid, f.date, f.at, f.lat, f.lng, f.acc == null ? '' : f.acc];
  });
  if (last >= 2) sh.getRange(2, 1, last - 1, LASTFIX_H.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, LASTFIX_H.length).setValues(rows);
  return rows.length;
}

function readLastFixes_() {
  const sh = lastFixSheet_();
  const last = sh.getLastRow();
  if (last < 2) return {};
  const out = {};
  sh.getRange(2, 1, last - 1, LASTFIX_H.length).getValues().forEach(function (v) {
    const o = rowToObj_(LASTFIX_H, v);
    if (!o.user_id || o.lat === '' || o.lng === '') return;
    out[String(o.user_id)] = { date: String(o.date), at: String(o.at),
      lat: Number(o.lat), lng: Number(o.lng),
      acc: o.accuracy_m === '' ? null : Number(o.accuracy_m) };
  });
  return out;
}

// ---- trustworthiness ------------------------------------------------------

/**
 * Why a fix should not be believed, in the plain words the popup prints.
 * Returns [] when nothing is wrong. Accuracy is re-derived from the stored
 * raw metres here — never from anything the client asserted.
 */
function fixDoubts_(lat, lng, acc, tz) {
  const out = [];
  if (lat < DISTRICT_BOX.minLat || lat > DISTRICT_BOX.maxLat ||
      lng < DISTRICT_BOX.minLng || lng > DISTRICT_BOX.maxLng) {
    out.push('the fix falls outside Jangaon district');
  }
  if (acc == null) out.push('the phone reported no accuracy figure');
  else if (acc > GPS_UNVERIFIED_ACC_M) {
    out.push('accuracy is ' + Math.round(acc) + ' m, worse than the ' +
      GPS_UNVERIFIED_ACC_M + ' m limit');
  }
  if (tz && EXPECTED_TZ.indexOf(tz) < 0) out.push('the phone clock is set to ' + tz);
  return out;
}

// ---- payload --------------------------------------------------------------

/**
 * Build the map payload for `date` from data the caller already holds.
 *
 * marksByUser: uid -> { IN: markRow, OUT: markRow }   (today's rows)
 * users:       the ACTIVE FIELD + SUPERVISOR list the summary already built
 * leaveByUid:  uid -> leave type, for approved leave covering today
 * rptRows:     today's daily reports (may be empty)
 *
 * Pseudonymous by construction: ids, sector and AWC codes only. The console
 * resolves names through the authenticated nameMap call, exactly as it does
 * for every other summary.
 */
function buildMapDay_(date, marksByUser, users, leaveByUid, rptRows) {
  const seen = seenForDate_(date);
  const lastFix = readLastFixes_();

  const present = [], onLeave = [], absent = [], filed = [];

  users.forEach(function (u) {
    const uid = String(u.user_id);
    const sc = primarySector_(u);
    const base = { id: uid, role: String(u.role), unit: String(u.awc_id), s: sc };
    const recs = marksByUser[uid] || {};
    // The IN mark places the person; OUT only tells us they marked twice.
    const m = recs.IN || recs.OUT || null;
    const hasFix = m && m.lat !== '' && m.lng !== '';

    if (hasFix) {
      const lat = Number(m.lat), lng = Number(m.lng);
      const acc = m.accuracy_m === '' ? null : Number(m.accuracy_m);
      const tz = String(m.tz || '');
      const doubts = fixDoubts_(lat, lng, acc, tz);
      present.push(Object.assign({}, base, {
        at: String(m.client_ts).slice(11, 16),
        lat: lat, lng: lng, acc: acc,
        verified: acc != null && acc <= GPS_UNVERIFIED_ACC_M,
        tz: tz, gf: String(m.geofence), fl: String(m.flags || ''),
        marks: (recs.IN ? 1 : 0) + (recs.OUT ? 1 : 0),
        doubts: doubts
      }));
      return;
    }
    if (m) return; // marked, but with no coordinates at all: nothing to place

    // Not marked. Sanctioned leave is not absence — read the register before
    // colouring anyone, or a festival day paints every approved officer red.
    const place = placeUnmarked_(uid, seen, lastFix);
    if (!place) return;                       // no coordinates of their own
    const row = Object.assign({}, base, place);
    if (leaveByUid[uid]) {
      row.lv = String(leaveByUid[uid]);
      onLeave.push(row);
    } else {
      absent.push(row);
    }
  });

  (rptRows || []).forEach(function (r) {
    if (r.lat === '' || r.lng === '' || r.lat == null || r.lng == null) return;
    filed.push({
      id: String(r.key || ''), unit: String(r.awc_id || ''), s: String(r.sector_code || ''),
      lat: Number(r.lat), lng: Number(r.lng),
      at: String(r.client_ts || '').slice(11, 16),
      children: Number(r.children) || 0, meals: Number(r.meals) || 0,
      flag: String(r.flags || ''),
      grade: String(r.flags || '') ? 'FLAGGED' : 'COMPLETE',
      date: date
    });
  });

  return {
    generatedAt: nowIso_(), date: date,
    box: DISTRICT_BOX, centre: DISTRICT_CENTRE, accLimit: GPS_UNVERIFIED_ACC_M,
    present: present, onLeave: onLeave, absent: absent, filed: filed
  };
}

/** Today's ping first, then the last located mark, then nothing. */
function placeUnmarked_(uid, seen, lastFix) {
  const s = seen[uid];
  if (s) {
    return { lat: s.lat, lng: s.lng, acc: s.acc,
      seenAt: String(s.at).slice(11, 16), lastDate: '' };
  }
  const f = lastFix[uid];
  if (f) {
    return { lat: f.lat, lng: f.lng, acc: f.acc, seenAt: '', lastDate: String(f.date) };
  }
  return null;
}

// ---- cache sheet ----------------------------------------------------------

function mapCacheSheet_() {
  const ss = masterSS_();
  let sh = ss.getSheetByName('MapCache');
  if (!sh) {
    sh = ss.insertSheet('MapCache');
    sh.getRange(1, 1, 1, MAPCACHE_H.length).setValues([MAPCACHE_H]);
    sh.getRange(1, 1, sh.getMaxRows(), MAPCACHE_H.length).setNumberFormat('@');
  }
  return sh;
}

const MAP_CHUNK = 45000; // a Sheets cell holds 50,000 characters

function writeMapCache_(payload) {
  const json = JSON.stringify(payload);
  const chunks = [];
  for (let i = 0; i < json.length; i += MAP_CHUNK) chunks.push(json.slice(i, i + MAP_CHUNK));
  const sh = mapCacheSheet_();
  const last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, MAPCACHE_H.length).clearContent();
  const rows = chunks.map(function (c, i) { return [payload.date, String(i), c]; });
  if (rows.length) sh.getRange(2, 1, rows.length, MAPCACHE_H.length).setValues(rows);
  // Short-lived memory copy so back-to-back console opens skip the sheet.
  try { CACHE.put('mapday', json.length < 95000 ? json : '', 600); } catch (e) { /* size */ }
  return { chunks: rows.length, bytes: json.length };
}

function readMapCache_() {
  const hot = CACHE.get('mapday');
  if (hot) {
    try { return JSON.parse(hot); } catch (e) { /* fall through to the sheet */ }
  }
  const sh = mapCacheSheet_();
  const last = sh.getLastRow();
  if (last < 2) return null;
  const vals = sh.getRange(2, 1, last - 1, MAPCACHE_H.length).getValues();
  const parts = vals.slice()
    .sort(function (a, b) { return Number(a[1]) - Number(b[1]); })
    .map(function (v) { return String(v[2]); });
  try { return JSON.parse(parts.join('')); } catch (e) { return null; }
}

// ---- the console call -----------------------------------------------------

// action: "mapDay"  req: { token }
// Serves the pre-computed payload, filtered to the caller's own scope on the
// server. A supervisor must not reach another cluster's positions by editing
// a request parameter, so the filtering happens here and not in the browser.
function apiMapDay_(auth, req) {
  if (!isConsoleRole_(auth.user)) return deny_();
  const payload = readMapCache_();
  if (!payload) return { ok: false, code: 'NOT_BUILT' };

  const scope = sectorScope_(auth.user);
  if (!scope) return Object.assign({ ok: true }, payload);

  const keep = function (arr) {
    return (arr || []).filter(function (r) { return scope.indexOf(String(r.s)) >= 0; });
  };
  return Object.assign({}, payload, { ok: true,
    present: keep(payload.present), onLeave: keep(payload.onLeave),
    absent: keep(payload.absent), filed: keep(payload.filed) });
}

/** Owner-run: rebuild the map payload now, without waiting for a tick. */
function publishMap() {
  buildToday_();
  const p = readMapCache_();
  console.log(p ? 'map ' + p.date + ': present ' + p.present.length +
    ', leave ' + p.onLeave.length + ', absent ' + p.absent.length +
    ', filed ' + p.filed.length : 'map not built');
}
