/* The mock-location reading: a pinned phone is a finding, a perfect claim is
   a lead, a shared point between centres is shared, a pair on one centre
   phone is not, and the honest scatter is nobody's concern. */
'use strict';
module.exports = {
  name: 'Mock-location reading',
  run(t, load) {
    const env = load({ now: '2026-10-24T09:15:00+05:30' });
    env.seed();
    const day = i => { const d = new Date('2026-10-24T12:00:00+05:30'); d.setDate(d.getDate() - i); return d.toISOString().slice(0, 10); };

    // U0001 honest: twelve mornings, scattered by a few tens of metres, 8-25 m accuracy
    for (let i = 1; i <= 12; i++) env.mark('U0001', day(i), 'IN', '09:0' + (i % 10), { lat: 17.7201 + i * 0.00011, lng: 79.1502 + i * 0.00005, accuracy_m: 8 + i });
    // U0002 honest too, but one morning the phone claimed 1 m: a lead
    for (let i = 1; i <= 8; i++) env.mark('U0002', day(i), 'IN', '09:10', { lat: 17.7203 + i * 0.00013, lng: 79.1500 + i * 0.00007, accuracy_m: i === 4 ? 1 : 12 });
    // U0003 pinned: the same six decimals on nine mornings at 3 m, plus one scattered
    for (let i = 1; i <= 9; i++) env.mark('U0003', day(i), 'IN', '09:00', { lat: 17.725512, lng: 79.161134, accuracy_m: 3 });
    env.mark('U0003', day(10), 'IN', '09:00', { lat: 17.7259, lng: 79.1615, accuracy_m: 20 });
    // U0004 has two mornings only (this one and the shared one below): not judged, however perfect the claim
    env.mark('U0004', day(1), 'IN', '09:00', { lat: 17.7402, lng: 79.1203, accuracy_m: 1 });
    // a shared point: U0001 (A0001) and U0004 (A0003) at one fine fix on day 3
    env.mark('U0004', day(3), 'IN', '09:40', { lat: 17.733300, lng: 79.122200, accuracy_m: 6 });
    env.mark('U0001', day(3), 'OUT', '16:10', { lat: 17.733300, lng: 79.122200, accuracy_m: 6 });   // an OUT: not read
    env.mark('U0001', day(3), 'IN', '08:55', { lat: 17.733300, lng: 79.122200, accuracy_m: 6 });
    // the pair on one phone: U0001 and U0002 (both A0001) at the same fix on day 5 — not shared
    env.mark('U0002', day(5), 'IN', '09:12', { lat: 17.7201 + 5 * 0.00011, lng: 79.1502 + 5 * 0.00005, accuracy_m: 9 });
    // the window: a 20-day-old pinned morning of U0003 is outside a 14-day read
    env.mark('U0003', day(20), 'IN', '09:00', { lat: 17.725512, lng: 79.161134, accuracy_m: 3 });
    // an unlocated mark
    env.mark('U0001', day(13), 'IN', '09:00', { lat: '', lng: '', accuracy_m: '' });

    t.eq(env.call('mockloc', 'U0200').code, 'FORBIDDEN', 'a CDPO may not read it');
    const r = env.call('mockloc', 'U2000', { days: 30 });
    t.eq(r.ok, true, 'ADMIN reads it');
    t.eq(r.days, 30, 'over thirty days');
    t.eq(r.from, '2026-09-25', 'from the 25th of September');
    t.eq(r.scanned.users, 4, 'four people had a located morning');
    t.eq(r.scanned.judged, 3, 'three had enough mornings');
    t.eq(r.scanned.notJudged, 1, 'one had not');
    t.eq(r.findings.map(f => f.uid), ['U0003'], 'the pinned phone is the one finding');
    t.eq(r.findings[0].pinnedDays, 10, 'pinned on ten mornings in thirty days');
    t.eq(r.findings[0].coord, '17.725512,79.161134', 'at that coordinate');
    t.ok(r.findings[0].scatterM <= 5, 'with next to no scatter', String(r.findings[0].scatterM));
    t.eq(r.findings[0].awcName, 'Alipur-II', 'named by her centre');
    t.eq(r.leads.map(f => f.uid), ['U0002'], 'the perfect claim is the one lead');
    t.eq(r.leads[0].perfectDays, 1, 'on one morning');
    t.ok(r.leads[0].scatterM > 5, 'and her phone otherwise scatters', String(r.leads[0].scatterM));
    t.eq(r.shared.length, 1, 'one shared point');
    t.eq(r.shared[0].users.map(u => u.uid).sort(), ['U0001', 'U0004'], 'between the two centres');
    t.eq(r.shared[0].date, day(3), 'on that morning');
    t.ok(!r.findings.some(f => f.uid === 'U0001') && !r.leads.some(f => f.uid === 'U0001'), 'the honest phone is nobody\'s concern');

    // the cache, and the window
    env.mark('U0002', day(6), 'IN', '08:50', { lat: 17.7203, lng: 79.15, accuracy_m: 1 });   // earlier than the loop's 09:10, so it is the morning
    t.eq(env.call('mockloc', 'U2000', { days: 30 }).leads[0].perfectDays, 1, 'a repeat read is served from cache');
    t.eq(env.call('mockloc', 'U2000', { days: 30, fresh: '1' }).leads[0].perfectDays, 2, 'fresh=1 re-reads');
    const r14 = env.call('mockloc', 'U2000', { days: 14 });
    t.eq(r14.findings[0].pinnedDays, 9, 'a 14-day read leaves the 20-day-old morning out');
    t.eq(env.call('mockloc', 'U2000', { days: 3 }).days, 7, 'the window is never under seven days');
    t.eq(env.call('mockloc', 'U2000', { days: 400 }).days, 90, 'nor over ninety');
  }
};
