/* The notice ladder: off until the district switches it on; the daily pass
   reminds twice and proposes on the third; nothing is served by a machine;
   serving re-reads attendance; the phone acknowledges once; no leave is
   debited. */
'use strict';
module.exports = {
  name: 'Notice ladder (default off)',
  run(t, load) {
    // Friday 23 Oct 2026, 07:05: the daily round reads Thursday the 22nd.
    const env = load({ now: '2026-10-23T07:05:00+05:30' });
    env.seed();

    // off by default
    const rep0 = env.ctx.featureReport_();
    const sk = rep0.skipped.find(s => s.name === 'notices');
    t.ok(sk && /FEATURE_ON=notices/.test(sk.why), 'notices is off by default, and the reason names the switch', JSON.stringify(sk));
    t.eq(env.ctx.featurePost_(env.auth('U0001'), { action: 'notices' }), null, 'the phone gets no answer while it is off');
    t.ok(!/notices/.test(env.ctx.featureDaily()), 'and the daily round does not run it');
    t.eq(env.rows('Notices').length, 0, 'nothing was written');

    // switched on by the district
    env.props.FEATURE_ON = 'notices';
    t.ok(env.ctx.featureReport_().live.some(f => f.name === 'notices'), 'FEATURE_ON carries it');
    env.props.FEATURE_OFF = 'notices';
    t.ok(!env.ctx.featureReport_().live.some(f => f.name === 'notices'), 'FEATURE_OFF still wins');
    delete env.props.FEATURE_OFF;

    // October 2026 working days up to the 22nd: 1,3,5-10,12-17,19,21,22 (Sundays 4,11,18; Deepavali 20th in the seed)
    const wd = ['2026-10-01', '2026-10-03', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10',
      '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-19', '2026-10-21', '2026-10-22'];
    // U0001 punctual: marked every day but the 22nd (1st miss)
    wd.forEach(d => { if (d !== '2026-10-22') env.mark('U0001', d, 'IN', '09:05'); });
    // U0002: missed the 12th and the 22nd (2nd miss)
    wd.forEach(d => { if (d !== '2026-10-12' && d !== '2026-10-22') env.mark('U0002', d, 'IN', '09:05'); });
    // U0003: missed the 5th, 6th and 22nd (3rd miss)
    wd.forEach(d => { if (['2026-10-05', '2026-10-06', '2026-10-22'].indexOf(d) < 0) env.mark('U0003', d, 'IN', '09:05'); });
    // U0004: on sanctioned leave 21-23; marked nothing all month otherwise - but the leave covers the day read
    wd.forEach(d => { if (d < '2026-10-21') env.mark('U0004', d, 'IN', '09:05'); });
    env.addRow('Leaves', { leave_id: 'L1', user_id: 'U0004', from_date: '2026-10-21', to_date: '2026-10-23', type: 'CASUAL', reason: 'x', status: 'APPROVED', applied_at: '2026-10-10T00:00:00+05:30' });

    const said = env.ctx.featureDaily();
    t.contains(said, 'notices: 2026-10-22: 2 reminder(s), 1 notice(s) proposed', 'the daily round reads the previous working day');
    let rows = env.rows('Notices');
    t.eq(rows.map(r => [r.user_id, r.kind, r.seq, r.status]), [['U0001', 'REMINDER', 1, 'SENT'], ['U0002', 'REMINDER', 2, 'SENT'], ['U0003', 'SHOWCAUSE', 3, 'PROPOSED']],
      'first and second miss remind; the third proposes; leave is not a miss; the supervisor is not on the ladder');
    env.ctx.featureDaily();
    t.eq(env.rows('Notices').length, 3, 'a second run of the same day adds nothing');

    // on a Sunday the round reads the Saturday, and the Friday it never read is not re-read
    env.setNow('2026-10-25T07:05:00+05:30');
    env.mark('U0001', '2026-10-23', 'IN', '09:00');
    ['U0002', 'U0004'].forEach(u => { env.mark(u, '2026-10-23', 'IN', '09:00'); env.mark(u, '2026-10-24', 'IN', '09:00'); });
    env.ctx.featureDaily();
    rows = env.rows('Notices');
    t.eq(rows.filter(r => r.date === '2026-10-24').map(r => [r.user_id, r.kind, r.seq]), [['U0001', 'REMINDER', 2], ['U0003', 'SHOWCAUSE', 5]], 'Sunday reads Saturday: a second reminder, a fifth miss (the 23rd counted too)');
    t.eq(rows.filter(r => r.date === '2026-10-23').length, 0, 'and not Friday');
    env.setNow('2026-10-23T07:05:00+05:30');

    // what the phone sees: a reminder card, and no notice until one is served
    const mine1 = env.call('notices', 'U0001');
    t.eq(mine1.ok, true, 'the phone reads its own');
    t.eq(mine1.reminders.length >= 1 && mine1.reminders[0].date, '2026-10-24', 'the newest reminder first');
    t.eq(mine1.notices, [], 'no notice on her file');
    const mine3 = env.call('notices', 'U0003');
    t.eq(mine3.notices, [], 'a PROPOSED notice is not shown on the phone');
    t.eq(env.call('notices', 'U0100').code, 'FORBIDDEN', 'a supervisor has no part in it');

    // the register
    const reg = env.call('notices', 'U2000');
    t.eq(reg.proposed.map(p => [p.uid, p.date]), [['U0003', '2026-10-24'], ['U0003', '2026-10-22']], 'ADMIN sees the proposals, newest first');
    t.eq(reg.proposed[1].awc, 'Alipur-II', 'with her centre');
    t.eq(env.call('notices', 'U0200').proposed.length, 2, 'the CDPO of the project sees them too');
    t.eq(env.call('noticeDecide', 'U0200', { serve: [reg.proposed[1].id] }).code, 'FORBIDDEN', 'but may not serve');
    t.eq(env.call('noticeDecide', 'U2000', {}).code, 'NOTHING_TO_DECIDE', 'an empty decision is refused');

    // serve one, drop one; the served one was marked meanwhile → dropped by the register
    const id22 = reg.proposed[1].id, id24 = reg.proposed[0].id;
    env.mark('U0003', '2026-10-24', 'IN', '09:50');   // her phone reached the district after the proposal
    const dec = env.call('noticeDecide', 'U2000', { serve: [id22, id24, 'NTC-NOPE'] });
    t.eq(dec.served.map(s => s.id), [id22], 'the 22nd is served');
    t.ok(/^SCN\/2026\/0001$/.test(dec.served[0].no), 'and numbered', dec.served[0].no);
    t.eq(dec.dropped, [id24], 'the 24th is dropped: attendance was received before serving');
    t.eq(dec.skipped.map(s => s.id), ['NTC-NOPE'], 'an unknown id is skipped');
    rows = env.rows('Notices');
    const r22 = rows.find(r => r.notice_id === id22), r24 = rows.find(r => r.notice_id === id24);
    t.eq([r22.status, r22.notice_no, r22.served_by], ['SERVED', 'SCN/2026/0001', 'District Admin (U2000)'], 'the served row carries number and officer');
    t.eq([r24.status, r24.dropped_by], ['DROPPED', 'SYSTEM (attendance received meanwhile)'], 'the dropped row says who dropped it');
    t.eq(env.call('noticeDecide', 'U2000', { serve: [id22] }).skipped[0].why, 'is SERVED', 'serving twice is a no-op');
    const audit = env.col('Audit', 'action');
    t.ok(audit.indexOf('NOTICE_SERVED') >= 0 && audit.indexOf('NOTICE_DROPPED') >= 0, 'both are audited');

    // the phone now sees it, in words, and acknowledges once
    const m3 = env.call('notices', 'U0003');
    t.eq(m3.pending, 1, 'one notice stands');
    t.eq(m3.notices[0].no, 'SCN/2026/0001', 'by number');
    t.contains(m3.notices[0].text, 'SHOW CAUSE NOTICE', 'with the text');
    t.contains(m3.notices[0].text, '22.10.2026', 'naming the day');
    t.contains(m3.notices[0].text, 'C. Pinned, AWT, Alipur-II', 'and her');
    t.ok(!/Casual Leave|debit/i.test(m3.notices[0].text), 'and no word of a leave debit');
    t.eq(env.call('noticeAck', 'U0001', { acks: [{ id: id22 }] }).skipped, [id22], 'nobody else can acknowledge it');
    env.setNow('2026-10-23T10:30:00+05:30');
    const a1 = env.call('noticeAck', 'U0003', { acks: [{ id: id22, at: '2026-10-23T10:00:00+05:30', note: 'Phone was in repair' }] });
    t.eq(a1.acked, [id22], 'acknowledged');
    const a2 = env.call('noticeAck', 'U0003', { acks: [{ id: id22 }] });
    t.eq(a2.already, [id22], 'a re-send is the same receipt');
    const rA = env.rows('Notices').find(r => r.notice_id === id22);
    t.eq([rA.status, rA.ack_at, rA.ack_note], ['ACK', '2026-10-23T10:00:00+05:30', 'Phone was in repair'], 'the phone\'s time and her note are kept');
    t.ok(rA.ack_received_at > rA.ack_at, 'and the district\'s own clock beside them');
    t.eq(env.call('notices', 'U0003').pending, 0, 'nothing stands any more');
    t.eq(env.call('notices', 'U2000').acked.length, 1, 'the register files it as acknowledged');
    t.eq(env.rows('Leaves').length, 1, 'no leave row was added: nothing is debited');
  }
};
