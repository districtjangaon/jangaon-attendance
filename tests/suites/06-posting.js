/* Postings: the dry run refuses and explains, the apply writes exactly the
   ok rows, audits each with its prior value, and keeps the sector's
   supervisor pointer in step. */
'use strict';
module.exports = {
  name: 'Postings',
  run(t, load) {
    const env = load({ now: '2026-10-24T09:15:00+05:30' });
    env.seed();

    t.eq(env.call('postingUpdate', 'U0200', { rows: [{ uid: 'U0001', act: 'MOVE', dest: 'A0003' }] }).code, 'FORBIDDEN', 'a CDPO may not post');
    t.eq(env.call('postingUpdate', 'U2000', { rows: [] }).code, 'NO_ROWS', 'an empty order is refused');

    // the dry run
    const dry = env.call('postingUpdate', 'U2000', { dry: '1', rows: [
      { uid: 'U0001', act: 'MOVE', dest: 'A0003' },     // ok: to another centre, sector follows
      { uid: 'U0001', act: 'MOVE', dest: 'A0002' },     // listed twice
      { uid: 'U0002', act: 'ADD', dest: 'A0003' },      // a worker holds one centre
      { uid: 'U0003', act: 'MOVE', dest: 'A0002' },     // already there
      { uid: 'U0004', act: 'MOVE', dest: 'A0009' },     // closed centre
      { uid: 'U0100', act: 'ADD', dest: 'S02' },        // ok: dual charge
      { uid: 'U0100', act: 'DROP', dest: 'S01' },       // listed twice
      { uid: 'U0200', act: 'MOVE', dest: 'KDK' },       // ok
      { uid: 'U2000', act: 'MOVE', dest: 'S01' },       // the district account
      { uid: 'U9999', act: 'MOVE', dest: 'A0001' },     // no such user
      { uid: 'U0001', act: 'WANDER', dest: 'A0001' }    // unknown act (and listed again)
    ] });
    t.eq(dry.ok, true, 'the dry run answers');
    t.eq(dry.dry, true, 'as a dry run');
    t.eq(dry.plan.map(p => p.ok), [true, false, false, false, false, true, false, true, false, false, false], 'three rows would change');
    t.contains(dry.plan[1].why, 'listed twice', 'a second row for one person is refused');
    t.contains(dry.plan[2].why, 'one centre', 'ADD does not apply to a worker');
    t.contains(dry.plan[3].why, 'already posted', 'a move to where she is is refused');
    t.contains(dry.plan[4].why, 'closed', 'a closed centre is refused');
    t.contains(dry.plan[8].why, 'no posting', 'the district account has none');
    t.contains(dry.plan[9].why, 'no such user', 'an unknown user is refused');
    t.contains(dry.plan[10].why, 'unknown act', 'an unknown act is refused');
    t.eq(dry.plan[0].after, { project_code: 'JGN', sector_code: 'S02', awc_id: 'A0003' }, 'a move carries the centre\'s sector and project');
    t.eq(dry.plan[5].after.sector_code, 'S01,S02', 'ADD appends to the charge');
    t.contains(dry.plan[0].from, 'Alipur-I', 'the prior posting reads by name');
    t.ok(!dry.plan.some(p => p._user), 'the user row does not leave the server');
    t.eq(env.rows('Users').find(u => u.user_id === 'U0001').awc_id, 'A0001', 'nothing was written');
    t.eq(env.rows('Audit').length, 0, 'and nothing was audited');

    // apply the same order
    const ap = env.call('postingUpdate', 'U2000', { rows: dry.plan.map(p => ({ uid: p.uid, act: p.act, dest: p.dest })) });
    t.eq([ap.applied, ap.skipped], [3, 8], 'three applied, eight skipped');
    const users = {}; env.rows('Users').forEach(u => { users[u.user_id] = u; });
    t.eq([users.U0001.awc_id, users.U0001.sector_code, users.U0001.project_code], ['A0003', 'S02', 'JGN'], 'the worker moved');
    t.eq(users.U0100.sector_code, 'S01,S02', 'the supervisor holds both sectors');
    t.eq(users.U0200.project_code, 'KDK', 'the CDPO moved project');
    t.eq(users.U0003.awc_id, 'A0002', 'a refused row touched nothing');
    const sectors = {}; env.rows('Sectors').forEach(s => { sectors[s.sector_code] = s; });
    t.eq(sectors.S02.supervisor_user_id, 'U0100', 'S02 now points at its supervisor');
    const audit = env.rows('Audit').filter(a => a.action.indexOf('POSTING_') === 0);
    t.eq(audit.map(a => a.action), ['POSTING_MOVE', 'POSTING_ADD', 'POSTING_MOVE'], 'each change is audited');
    t.eq(JSON.parse(audit[0].old_value), { project_code: 'JGN', sector_code: 'S01', awc_id: 'A0001' }, 'with the prior posting');
    t.eq(audit[0].actor, 'U2000', 'by the officer');

    // DROP: never below one sector; and the pointer is released only if it was hers
    const d1 = env.call('postingUpdate', 'U2000', { rows: [{ uid: 'U0100', act: 'DROP', dest: 'S01' }] });
    t.eq(d1.applied, 1, 'dropping one of two is allowed');
    t.eq(env.rows('Users').find(u => u.user_id === 'U0100').sector_code, 'S02', 'she keeps S02');
    t.eq(env.rows('Sectors').find(s => s.sector_code === 'S01').supervisor_user_id, '', 'S01 no longer points at her');
    const d2 = env.call('postingUpdate', 'U2000', { dry: '1', rows: [{ uid: 'U0100', act: 'DROP', dest: 'S02' }] });
    t.contains(d2.plan[0].why, 'at least one sector', 'dropping the last sector is refused');

    // the history, off the audit log
    const hist = env.call('postings', 'U2000');
    t.eq(hist.ok, true, 'ADMIN reads the history');
    t.eq(hist.rows.length, 4, 'four changes, newest first');
    t.eq(hist.rows[0].act, 'DROP', 'the drop is newest');
    t.eq(hist.rows[3].uid, 'U0001', 'the worker\'s move is oldest');
    const cd = env.call('postings', 'U0200');
    t.eq(cd.ok, true, 'a CDPO reads it too');
    t.eq(cd.rows.length, 1, 'but only moves into or out of her project (she is now in KDK)');
    t.eq(env.call('postings', 'U0100').code, 'FORBIDDEN', 'a supervisor may not');
  }
};
