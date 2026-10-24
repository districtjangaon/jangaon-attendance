/* The feature registry: every module named loads, none shadows the core,
   FEATURE_OFF takes one out without a deploy, and a module that throws
   answers plainly and leaves the rest alone. */
'use strict';
module.exports = {
  name: 'Feature registry',
  run(t, load) {
    const env = load();
    env.seed();
    const rep = env.ctx.featureReport_();
    const modules = env.eval('FEATURE_MODULES');
    t.eq(rep.live.map(f => f.name), modules, 'every module in FEATURE_MODULES is live');
    t.eq(rep.skipped, [], 'nothing is skipped on a clean load');

    const core = env.ctx.coreActions_();
    t.ok(core.sync && core.login && core.nameMap && core.userUpsert, 'the core actions are read off doPost itself', JSON.stringify(Object.keys(core)));
    const all = [];
    rep.live.forEach(f => f.actions.forEach(a => all.push(a)));
    t.ok(all.every(a => !core[a]), 'no feature action shadows a core action', all.filter(a => core[a]).join(','));
    t.eq(all.length, new Set(all).size, 'no two features answer the same action');

    // an unknown action is nobody's: null, so doPost answers NO_ACTION
    t.eq(env.ctx.featurePost_(env.auth('U2000'), { action: 'noSuchThing' }), null, 'an unknown action is declined');

    // FEATURE_OFF
    env.props.FEATURE_OFF = 'weather, mockloc';
    const off = env.ctx.featureReport_();
    t.eq(off.skipped.map(s => s.name), ['weather', 'mockloc'], 'FEATURE_OFF takes modules out');
    t.contains(off.skipped[0].why, 'FEATURE_OFF', 'and says why');
    t.eq(env.ctx.featurePost_(env.auth('U2000'), { action: 'weather' }), null, 'a switched-off module answers nothing');
    delete env.props.FEATURE_OFF;

    // a module that throws
    env.eval("function feature_broken(){ return { title: 'broken', actions: { breakIt: function(){ throw new Error('boom'); } } }; }");
    env.eval("FEATURE_MODULES.push('broken')");
    const r = env.ctx.featurePost_(env.auth('U2000'), { action: 'breakIt' });
    t.eq(r.ok, false, 'a throwing handler answers ok:false');
    t.eq(r.code, 'FEATURE_ERR', 'with FEATURE_ERR');
    t.eq(r.feature, 'broken', 'naming the module');
    t.ok(env.col('Audit', 'action').indexOf('FEATURE_FAILED') >= 0, 'and the failure is audited');
    t.ok(env.ctx.featurePost_(env.auth('U2000'), { action: 'health' }).ok === true, 'the other modules still answer');

    // a module claiming a core action is refused, not loaded
    env.eval("function feature_shadow(){ return { title: 'shadow', actions: { sync: function(){ return {ok:true}; } } }; }");
    env.eval("FEATURE_MODULES.push('shadow')");
    const rep2 = env.ctx.featureReport_();
    const sk = rep2.skipped.find(s => s.name === 'shadow');
    t.ok(sk && /already answers action "sync"/.test(sk.why), 'a module claiming a core action is refused', JSON.stringify(sk));

    // the daily round runs every daily hook inside its own try/catch
    env.eval("function feature_dailyok(){ return { title: 'd', actions: {}, daily: function(){ return 'ran'; } }; }");
    env.eval("function feature_dailybad(){ return { title: 'd', actions: {}, daily: function(){ throw new Error('nope'); } }; }");
    env.eval("FEATURE_MODULES.push('dailyok','dailybad')");
    const said = env.ctx.featureDaily();
    t.contains(said, 'dailyok: ran', 'a daily hook runs');
    t.contains(said, 'dailybad: FAILED', 'a failing daily hook is reported, not fatal');

    // the trigger installer is idempotent
    env.ctx.installFeatureTrigger();
    env.ctx.installFeatureTrigger();
    t.eq(env.installed.filter(n => n === 'featureDaily').length, 1, 'installFeatureTrigger leaves exactly one trigger');
  }
};
