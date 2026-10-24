/* Advisories: publish, who it reaches, acknowledge once, supersede, retire,
   and the file that rides along. */
'use strict';
module.exports = {
  name: 'Advisories',
  run(t, load) {
    const env = load({ now: '2026-10-24T09:15:00+05:30' });
    env.seed();

    t.eq(env.call('advPublish', 'U0200', { title: 'x', message: 'y' }).code, 'FORBIDDEN', 'a CDPO may not publish');
    t.eq(env.call('advPublish', 'U2000', { message: 'y' }).code, 'NO_TITLE', 'a title is required');
    t.eq(env.call('advPublish', 'U2000', { title: 'x' }).code, 'NO_MESSAGE', 'and a message');
    t.eq(env.call('advPublish', 'U2000', { title: 'x', message: 'y', audience: 'CDPO' }).code, 'BAD_AUDIENCE', 'the audience is one of four');
    t.eq(env.call('advPublish', 'U2000', { title: 'x', message: 'y', file: { name: 'a.exe', b64: 'AAAA' } }).code, 'BAD_FILE', 'an executable is refused');

    // district-wide, to AWTs, with a PDF
    const p1 = env.call('advPublish', 'U2000', { title: 'Growth monitoring round', message: 'Weigh every child by the 30th.', audience: 'AWT',
      file: { name: 'circular.pdf', b64: Buffer.from('%PDF-1.4 mock').toString('base64') } });
    t.eq(p1.ok, true, 'published');
    t.ok(/^ADV-20261024-[A-Z0-9]{4}$/.test(p1.id), 'with a dated id', p1.id);
    const folder = env.driveRoot.getFoldersByName(env.eval('ADV_FOLDER_NAME'));
    t.ok(folder.hasNext(), 'the advisories folder was made');
    const year = folder.next().getFoldersByName('2026');
    t.ok(year.hasNext(), 'with a year folder inside');
    const file = year.next().getFiles().next();
    t.contains(file.getName(), 'ADV_2026-10-24_Growth_monitoring_round', 'the file is named by date and title');
    t.eq(file.sharing, { access: 'ANYONE_WITH_LINK', permission: 'VIEW' }, 'shared view-only by link (a circular, not a photograph)');
    t.ok(env.col('Audit', 'action').indexOf('ADVISORY_PUBLISHED') >= 0, 'publication is audited');

    // who it reaches
    const awt = env.call('advisory', 'U0001');
    t.eq(awt.advisory && awt.advisory.id, p1.id, 'an AWT sees it standing');
    t.eq(awt.acknowledged, false, 'unacknowledged');
    t.ok(awt.advisory.url, 'with the file link');
    const awh = env.call('advisory', 'U0002');
    t.eq(awh.advisory, null, 'an AWH does not (audience AWT)');
    const sup = env.call('advisory', 'U0100');
    t.eq(sup.advisory, null, 'nor a supervisor');

    // the register, for the console
    const reg = env.call('advisory', 'U2000');
    t.eq(reg.ok, true, 'ADMIN reads the register');
    t.eq(reg.totals.due, 3, 'three AWTs are due to acknowledge');
    t.eq(reg.totals.acknowledged, 0, 'none has');

    // acknowledge: once
    const a1 = env.call('advAck', 'U0001', { id: p1.id, at: '2026-10-24T09:20:00+05:30' });
    t.eq(a1.ok, true, 'acknowledged');
    const a2 = env.call('advAck', 'U0001', { id: p1.id });
    t.eq(a2.already, true, 'a second tap is the same receipt');
    t.eq(env.rows('AdvAck').length, 1, 'and writes no second row');
    t.eq(env.call('advisory', 'U0001').acknowledged, true, 'she now reads it as acknowledged');
    t.eq(env.call('advisory', 'U2000').totals.acknowledged, 1, 'the register counts her');
    t.eq(env.call('advAck', 'U0002', {}).code, 'NONE_STANDING', 'an AWH has nothing standing to acknowledge');

    // sector-scoped, to everyone: supersedes the standing one
    const p2 = env.call('advPublish', 'U2000', { title: 'Boil water', message: 'Until the pipeline is repaired.', audience: 'ALL', sectors: 'S02, S99' });
    t.eq(p2.ok, true, 'a second circular is published');
    const rows = env.rows('Advisories');
    t.eq(rows.map(r => r.status), ['SUPERSEDED', 'ACTIVE'], 'the first steps down, it is not deleted');
    t.eq(rows[1].sectors, 'S02', 'unknown sectors are dropped');
    t.eq(env.call('advisory', 'U0004').advisory.id, p2.id, 'the S02 worker sees it');
    t.eq(env.call('advisory', 'U0001').advisory, null, 'the S01 worker does not');
    const rc = env.call('advisory', 'U0001').recent;
    t.eq(rc.map(x => [x.id, x.standing, x.acknowledged]), [[p1.id, false, true]], 'her recent list keeps the superseded one, acknowledged, and not the one that was never hers');

    // retire
    t.eq(env.call('advRetire', 'U0100', { id: p2.id }).code, 'FORBIDDEN', 'a supervisor may not retire');
    const r1 = env.call('advRetire', 'U2000', { id: p2.id });
    t.eq(r1.status, 'RETIRED', 'ADMIN retires it');
    t.eq(env.call('advRetire', 'U2000', { id: p2.id }).already, true, 'retiring twice is a no-op');
    t.eq(env.call('advRetire', 'U2000', { id: 'ADV-NOPE' }).code, 'NO_SUCH', 'an unknown id is refused');
    t.eq(env.call('advisory', 'U0004').advisory, null, 'nothing stands for the S02 worker now');
  }
};
