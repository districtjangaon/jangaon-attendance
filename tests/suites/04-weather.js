/* Weather: one Open-Meteo call for every sector point, the IMD's rainfall
   classes, the three levels, and who sees what. */
'use strict';
module.exports = {
  name: 'Weather (Open-Meteo)',
  run(t, load) {
    const env = load({ now: '2026-10-24T09:15:00+05:30' });
    env.seed();

    // the pure readings first
    t.eq(env.ctx.wxRainClass_(1), '', 'under 2.5 mm is no class');
    t.eq(env.ctx.wxRainClass_(10), 'light rain', '2.5-15.5 is light');
    t.eq(env.ctx.wxRainClass_(40), 'moderate rain', '15.6-64.4 is moderate');
    t.eq(env.ctx.wxRainClass_(100), 'heavy rain', '64.5-115.5 is heavy');
    t.eq(env.ctx.wxRainClass_(150), 'very heavy rain', '115.6-204.4 is very heavy');
    t.eq(env.ctx.wxRainClass_(250), 'extremely heavy rain', 'above 204.4 is extremely heavy');
    t.eq(env.ctx.wxLevel_({ code: 1, rain: 0, wind: 10, tmax: 33 }), 'CALM', 'a fair day is CALM');
    t.eq(env.ctx.wxLevel_({ code: 95, rain: 5, wind: 10, tmax: 33 }), 'WATCH', 'a thunderstorm is WATCH');
    t.eq(env.ctx.wxLevel_({ code: 1, rain: 0, wind: 10, tmax: 41 }), 'WATCH', '40 degrees is WATCH');
    t.eq(env.ctx.wxLevel_({ code: 1, rain: 70, wind: 10, tmax: 33 }), 'SEVERE', 'heavy rain is SEVERE');
    t.eq(env.ctx.wxLevel_({ code: 99, rain: 0, wind: 10, tmax: 33 }), 'SEVERE', 'hail is SEVERE');
    t.eq(env.ctx.wxLevel_({ code: 1, rain: 0, wind: 55, tmax: 33 }), 'SEVERE', '50 km/h wind is SEVERE');

    // the points: the district first, then one per sector; a sector with no located centre reads the district centre
    const pts = env.ctx.wxPoints_();
    t.eq(pts.map(p => p.sector), ['', 'S01', 'S02', 'S03'], 'district first, then every sector');
    t.eq(pts[1].located, true, 'S01 has located centres');
    t.eq(pts[3].located, false, 'S03 has none and reads the district centre');
    t.ok(Math.abs(pts[1].lat - 17.7228) < 0.001 && Math.abs(pts[1].lng - 79.1557) < 0.001, 'a sector point is the mean of its centres', JSON.stringify(pts[1]));

    // one call answers every point
    const daily = (rain, code, tmax) => ({
      time: ['2026-10-10', '2026-10-23', '2026-10-24', '2026-10-25'],
      weather_code: [1, 1, code, 1], temperature_2m_max: [33, 34, tmax, 33], temperature_2m_min: [22, 22, 22, 22],
      precipitation_sum: [0, 2, rain, 0], precipitation_probability_max: [0, 10, 80, 0], wind_speed_10m_max: [10, 12, 14, 10]
    });
    env.fetchReply = url => {
      const n = url.match(/latitude=([^&]+)/)[1].split(',').length;
      return Array.from({ length: n }, (_, i) => ({
        current: { temperature_2m: 30 + i, relative_humidity_2m: 60, precipitation: 0, weather_code: 2, wind_speed_10m: 8 },
        daily: i === 2 ? daily(70, 63, 33) : i === 3 ? daily(20, 61, 33) : daily(0, 1, 33)
      }));
    };
    const a = env.call('weather', 'U2000');
    t.eq(a.ok, true, 'ADMIN reads the weather');
    t.eq(env.fetches.length, 1, 'with one call to the forecast service');
    t.contains(env.fetches[0].url, 'api.open-meteo.com', 'at Open-Meteo');
    t.contains(env.fetches[0].url, 'past_days=14', 'asking for the fortnight behind');
    t.eq(a.rows.length, 4, 'one row per point');
    t.eq(a.rows[2].rainClass, 'heavy rain', 'S02\'s 70 mm is heavy rain');
    t.eq(a.rows[2].level, 'SEVERE', 'and SEVERE');
    t.eq(a.rows[3].level, 'WATCH', 'S03\'s 20 mm is WATCH');
    t.eq(a.level, 'SEVERE', 'the district level is the worst sector');
    t.eq(a.counts, { severe: 1, watch: 1, calm: 2 }, 'the counts add up');
    t.eq(a.rows[1].days.length, 3, 'the past days up to today ride along (not the forecast)');
    t.eq(a.rows[0].today, 'Mostly clear', 'the WMO code reads in words');

    // a worker sees her own sector, and no table
    const w = env.call('weather', 'U0004');
    t.eq(w.ok, true, 'a worker reads the weather');
    t.eq(w.rows, undefined, 'without the district table');
    t.eq(w.mine.sector, 'S02', 'her own sector');
    t.eq(w.level, 'SEVERE', 'at her sector\'s level');
    t.eq(env.fetches.length, 1, 'served from the half-hour cache: still one call');

    // the service down: a plain answer, not a throw
    Object.keys(env.cacheStore).forEach(k => { if (k.indexOf('wx_2') === 0) delete env.cacheStore[k]; });
    env.fetchCode = 503; env.fetchReply = '{"reason":"maintenance"}';
    const down = env.call('weather', 'U2000');
    t.eq(down.ok, false, 'a 503 answers ok:false');
    t.eq(down.code, 'WX_UNAVAILABLE', 'as WX_UNAVAILABLE');
    t.contains(down.msg, '503', 'naming the status');
  }
};
