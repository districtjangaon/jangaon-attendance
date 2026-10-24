/* My days: the worker's own fortnight off the month workbooks - earliest IN,
   latest OUT, late by the schedule, leave is leave, Sunday and the holiday
   are off, today is still running. */
'use strict';
module.exports = {
  name: 'My days (the fortnight)',
  run(t, load) {
    // Saturday 24 Oct 2026, 09:15. The fortnight is 11-24 Oct; 11 and 18 are
    // Sundays, 20 is Deepavali in the seed.
    const env = load({ now: '2026-10-24T09:15:00+05:30' });
    env.seed();
    env.mark('U0001', '2026-10-12', 'IN', '09:10'); env.mark('U0001', '2026-10-12', 'OUT', '16:30');
    env.mark('U0001', '2026-10-13', 'IN', '09:45'); env.mark('U0001', '2026-10-13', 'OUT', '16:05');   // late
    env.mark('U0001', '2026-10-13', 'IN', '09:20');                                                     // an earlier IN wins
    env.mark('U0001', '2026-10-14', 'IN', '09:00');                                                     // no OUT
    env.mark('U0001', '2026-10-24', 'IN', '09:05');                                                     // today
    env.mark('U0002', '2026-10-15', 'IN', '09:00');                                                     // somebody else
    // sanctioned leave 15-16 Oct
    env.addRow('Leaves', { leave_id: 'L1', user_id: 'U0001', from_date: '2026-10-15', to_date: '2026-10-16', type: 'CASUAL', reason: 'x', status: 'APPROVED', applied_at: '2026-10-10T00:00:00+05:30' });
    env.addRow('Leaves', { leave_id: 'L2', user_id: 'U0001', from_date: '2026-10-21', to_date: '2026-10-21', type: 'CASUAL', reason: 'x', status: 'REJECTED', applied_at: '2026-10-10T00:00:00+05:30' });

    const r = env.call('myDays', 'U0001');
    t.eq(r.ok, true, 'answers ok');
    t.eq(r.from, '2026-10-11', 'the fortnight starts fourteen days back');
    t.eq(r.to, '2026-10-24', 'and ends today');
    t.eq(r.days.length, 14, 'fourteen days');
    t.eq(r.cutoff, '09:30', 'the late cutoff is the schedule\'s');
    const by = {}; r.days.forEach(d => { by[d.date] = d; });
    t.eq(by['2026-10-11'].off, 'Sunday', 'Sunday is off');
    t.eq(by['2026-10-20'].off, 'Deepavali', 'the holiday is off, by name');
    t.eq([by['2026-10-12'].in, by['2026-10-12'].out, by['2026-10-12'].late], ['09:10', '16:30', false], 'a full day reads in, out, not late');
    t.eq([by['2026-10-13'].in, by['2026-10-13'].late], ['09:20', false], 'the EARLIEST IN of a day is the one that counts');
    t.eq(by['2026-10-14'].out, '', 'a day without OUT is open');
    t.eq(by['2026-10-15'].leave, 'Casual Leave', 'sanctioned leave is leave');
    t.eq(by['2026-10-21'].leave, '', 'a rejected application is not');
    t.eq(by['2026-10-15'].in, '', 'and another worker\'s mark is not hers');
    t.eq(r.totals, { working: 9, marked: 4, full: 2, late: 0, leaveDays: 2, notMarked: 5 }, 'the totals add up (today is never "not marked")');

    // the late reading
    env.mark('U0003', '2026-10-22', 'IN', '09:31');
    const r3 = env.call('myDays', 'U0003');
    const d3 = r3.days.find(d => d.date === '2026-10-22');
    t.eq(d3.late, true, 'one minute past the cutoff is late');
    t.eq(r3.totals.late, 1, 'and counted');

    // the cache: a second read inside ten minutes is the same answer; fresh=1 re-reads
    env.mark('U0001', '2026-10-23', 'IN', '09:00');
    t.eq(env.call('myDays', 'U0001').totals.marked, 4, 'a repeat read within ten minutes is served from cache');
    t.eq(env.call('myDays', 'U0001', { fresh: '1' }).totals.marked, 5, 'fresh=1 re-reads the workbook');
  }
};
