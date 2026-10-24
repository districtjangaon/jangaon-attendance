/**
 * FeatureWeather.gs — the sky over each sector, from one free call an hour.
 *
 * Ported from the SJGP register. Open-Meteo (api.open-meteo.com) answers
 * several coordinates in a single request and needs no key, so the district's
 * 27 sectors cost one call every half hour and ₹0. The app shows a worker
 * her own sector's day (temperature, rain, wind) and a temperature row under
 * the fortnight card; the console roles get every sector.
 *
 * THE THRESHOLDS ARE THE IMD'S, NOT MINE. Rainfall is classed the way the
 * India Meteorological Department classes it (light 2.5–15.5 mm, moderate
 * 15.6–64.4, heavy 64.5–115.5, very heavy 115.6–204.4, extremely heavy above
 * that), because a district officer already reads those words in that sense.
 *
 * IT FORECASTS; IT DOES NOT WARN. Nothing here is an IMD warning and nothing
 * here is an order.
 *
 * WHERE EACH SECTOR IS. The AWC master holds a latitude and longitude for
 * every centre; the average of a sector's located centres is a point inside
 * that sector. A sector with no located centre reads the district centre.
 */
var WX_URL = 'https://api.open-meteo.com/v1/forecast';
var WX_CACHE_SEC = 1800;            // half an hour; the sky is not a ledger
var WX_POINTS_CACHE_SEC = 21600;    // the sectors do not move

function feature_weather() {
  return {
    title: 'The sky over each sector, from Open-Meteo: one free call an hour',
    actions: {
      // action: "weather"  req: { token }
      weather: function (auth, req) {
        let w;
        try { w = wxRead_(); }
        catch (err) { return { ok: false, code: 'WX_UNAVAILABLE', msg: String((err && err.message) || err) }; }
        const u = auth.user, role = String(u.role);
        const sec = primarySector_(u);
        const mine = w.rows.filter(function (r) { return r.sector === sec; })[0] || w.rows[0] || null;
        if (role === 'ADMIN' || role === 'CDPO') {
          return { ok: true, at: w.at, date: w.date, level: w.level, counts: w.counts, rows: w.rows,
            mine: mine, source: w.source };
        }
        return { ok: true, at: w.at, date: w.date, source: w.source, mine: mine,
          level: (mine && mine.level) || 'CALM' };
      }
    }
  };
}

/** WMO weather codes, in the words a worker would use. */
function wxText_(c) {
  const n = Number(c);
  if (n === 0) return 'Clear';
  if (n === 1) return 'Mostly clear';
  if (n === 2) return 'Partly cloudy';
  if (n === 3) return 'Overcast';
  if (n === 45 || n === 48) return 'Fog';
  if (n >= 51 && n <= 57) return 'Drizzle';
  if (n >= 61 && n <= 65) return 'Rain';
  if (n === 66 || n === 67) return 'Freezing rain';
  if (n >= 71 && n <= 77) return 'Snow';
  if (n >= 80 && n <= 82) return 'Rain showers';
  if (n === 85 || n === 86) return 'Snow showers';
  if (n === 95) return 'Thunderstorm';
  if (n === 96 || n === 99) return 'Thunderstorm with hail';
  return 'Unsettled';
}
/** The IMD's rainfall classes, by the day's total in millimetres. */
function wxRainClass_(mm) {
  const v = Number(mm) || 0;
  if (v < 2.5) return '';
  if (v <= 15.5) return 'light rain';
  if (v <= 64.4) return 'moderate rain';
  if (v <= 115.5) return 'heavy rain';
  if (v <= 204.4) return 'very heavy rain';
  return 'extremely heavy rain';
}
/** SEVERE is what the district would act on before the day starts; WATCH is what it would want to know. */
function wxLevel_(d) {
  const code = Number(d.code) || 0, mm = Number(d.rain) || 0;
  const wind = Number(d.wind) || 0, tmax = Number(d.tmax);
  if (code === 96 || code === 99 || mm > 64.4 || wind >= 50 || (isFinite(tmax) && tmax >= 43)) return 'SEVERE';
  if (code === 95 || mm > 15.5 || wind >= 35 || (isFinite(tmax) && tmax >= 40)) return 'WATCH';
  return 'CALM';
}
var WX_RANK = { CALM: 0, WATCH: 1, SEVERE: 2 };

/** One point per sector (the average of its located centres), the district centre first. */
function wxPoints_() {
  const hit = CACHE.get('wx_pts');
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* rebuild */ } }
  const agg = {};
  const sh = masterSS_().getSheetByName('AWCs');
  const last = sh ? sh.getLastRow() : 0;
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, AWC_H.length).getValues().forEach(function (r) {
      const a = awcFromRow_(r);
      if (!a.active || a.lat == null || a.lng == null || !a.lat || !a.lng) return;
      // a centre whose coordinates fell outside the district (a typo in the
      // master) must not move the sector's point onto another state
      if (Math.abs(a.lat - DISTRICT_CENTRE.lat) > 1 || Math.abs(a.lng - DISTRICT_CENTRE.lng) > 1) return;
      const g = agg[a.sector] = agg[a.sector] || { la: 0, ln: 0, n: 0 };
      g.la += a.lat; g.ln += a.lng; g.n++;
    });
  }
  const names = {};
  getSectors_().forEach(function (s) { names[s.code] = s.name; });
  const pts = [{ sector: '', name: 'Jangaon district', lat: DISTRICT_CENTRE.lat, lng: DISTRICT_CENTRE.lng, located: true }];
  Object.keys(names).sort().forEach(function (code) {
    const g = agg[code];
    pts.push(g && g.n
      ? { sector: code, name: names[code], lat: +(g.la / g.n).toFixed(4), lng: +(g.ln / g.n).toFixed(4), located: true }
      : { sector: code, name: names[code], lat: DISTRICT_CENTRE.lat, lng: DISTRICT_CENTRE.lng, located: false });
  });
  try { CACHE.put('wx_pts', JSON.stringify(pts), WX_POINTS_CACHE_SEC); } catch (e) { /* fine */ }
  return pts;
}

/** One request, every point. */
function wxFetch_(points) {
  const url = WX_URL +
    '?latitude=' + points.map(function (p) { return p.lat; }).join(',') +
    '&longitude=' + points.map(function (p) { return p.lng; }).join(',') +
    '&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max' +
    '&timezone=Asia%2FKolkata&forecast_days=3&past_days=14';   // the fortnight behind, for the worker's own row
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  let j;
  try { j = JSON.parse(res.getContentText()); }
  catch (err) { throw new Error('the forecast service did not answer with figures'); }
  if (res.getResponseCode() !== 200) throw new Error('the forecast service answered ' + res.getResponseCode() + (j && j.reason ? ': ' + j.reason : ''));
  // one coordinate returns an object, several return an array; Open-Meteo does both
  return Array.isArray(j) ? j : [j];
}

function wxRead_() {
  const key = 'wx_' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd-HH');
  const hit = cacheGetBig_(key);
  if (hit) { try { return JSON.parse(hit); } catch (err) { /* re-read */ } }

  const points = wxPoints_();
  const raw = wxFetch_(points);
  const td = fmtDay_(Date.now());
  const rows = points.map(function (p, i) {
    const w = raw[i] || raw[0] || {};
    const cur = w.current || {}, day = w.daily || {};
    const time = Array.isArray(day.time) ? day.time.map(String) : [];
    let ti = time.indexOf(td); if (ti < 0) ti = 0;
    const at = function (a) { return Array.isArray(a) ? a[ti] : undefined; };
    const d = {
      sector: p.sector, name: p.name, lat: p.lat, lng: p.lng, located: p.located,
      temp: cur.temperature_2m, humidity: cur.relative_humidity_2m,
      code: cur.weather_code, now: wxText_(cur.weather_code), windNow: cur.wind_speed_10m,
      tmax: at(day.temperature_2m_max), tmin: at(day.temperature_2m_min),
      rain: at(day.precipitation_sum), rainChance: at(day.precipitation_probability_max),
      wind: at(day.wind_speed_10m_max), dayCode: at(day.weather_code)
    };
    d.days = time.map(function (dt, k) {
      return { date: dt, tmax: (day.temperature_2m_max || [])[k], tmin: (day.temperature_2m_min || [])[k],
        rain: (day.precipitation_sum || [])[k], code: (day.weather_code || [])[k] };
    }).filter(function (x) { return x.date && x.date <= td && x.tmax != null; });
    d.rainClass = wxRainClass_(d.rain);
    d.level = wxLevel_({ code: d.dayCode != null ? d.dayCode : d.code, rain: d.rain, wind: d.wind, tmax: d.tmax });
    d.today = wxText_(d.dayCode);
    return d;
  });
  const worst = rows.reduce(function (s, r) { return WX_RANK[r.level] > WX_RANK[s] ? r.level : s; }, 'CALM');
  const out = {
    at: nowIso_(), date: td, level: worst, rows: rows,
    counts: {
      severe: rows.filter(function (r) { return r.level === 'SEVERE'; }).length,
      watch: rows.filter(function (r) { return r.level === 'WATCH'; }).length,
      calm: rows.filter(function (r) { return r.level === 'CALM'; }).length
    },
    source: 'Open-Meteo · thresholds after the India Meteorological Department'
  };
  try { cachePutBig_(key, JSON.stringify(out), WX_CACHE_SEC); } catch (err) { /* an uncached answer is still an answer */ }
  return out;
}
