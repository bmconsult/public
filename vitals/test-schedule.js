/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - SCHEDULING SUITE (B8 + B11).  node test-schedule.js   (any platform)
 *
 * What this proves: jobs SPREAD instead of stacking, the minimum gap actually holds, a job that
 * throws cannot take the scheduler down, and the boot trial refuses to invent a verdict it could
 * not measure.
 *
 * The scheduler is driven by an injected clock rather than by waiting. A scheduling test that
 * sleeps is slow, flaky, and proves less: with a controlled clock the collision question can be
 * asked exhaustively over a whole period instead of sampled.
 */

const { Scheduler, BootTrial, offsetFor } = require('./schedule');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra !== undefined ? '  [' + extra + ']' : ''}`); }
};

function rig(opts = {}) {
  let t = 1_000_000;
  const s = new Scheduler({ now: () => t, salt: 'test-machine', ...opts });
  return { s, adv: (ms) => { t += ms; }, at: () => t, set: (v) => { t = v; } };
}

console.log('--- B8: jobs SPREAD across the period instead of stacking on its boundary ---');
{
  const period = 600_000;
  const names = ['diagnosis', 'maintenance', 'hardware', 'trend', 'workloads', 'growth', 'selfcheck'];
  const { s: sc } = rig();
  for (const nm of names) sc.every(nm, period, () => {});
  const offs = sc.jobs.map((j) => j.offset);
  check('every job gets an offset inside its period', offs.every((o) => o >= 0 && o < period));
  check('they are not all the same', new Set(offs).size === names.length, offs.join(','));

  /* THE GUARANTEE, not the hope. Bare hashing is uniform-random and uniform-random points cluster:
     the first version of this put two of these seven 1 SECOND apart. Stratified placement cuts the
     period into one slot per job, so the separation is a property of the construction. With seven
     jobs in ten minutes the slot is ~86 s and the central band keeps them off the boundaries. */
  const tight = sc.tightestGapMs();
  check('no two of seven jobs land within 30 s of each other on a 10-minute period',
    tight > 30_000, `closest pair ${Math.round(tight / 1000)} s apart`);
  check('and the guarantee scales — 20 jobs still separate', (() => {
    const { s: big } = rig();
    for (let i = 0; i < 20; i++) big.every('job' + i, period, () => {});
    return big.tightestGapMs() > 6_000;
  })(), 'slot width shrinks with count, but the floor is structural');

  const { s: again } = rig();
  for (const nm of names) again.every(nm, period, () => {});
  check('the schedule is DETERMINISTIC — a restart must not re-roll it',
    JSON.stringify(again.jobs.map((j) => j.offset)) === JSON.stringify(offs));
  const { s: other } = rig({ salt: 'other-machine' });
  for (const nm of names) other.every(nm, period, () => {});
  check('and it differs per machine, so a fleet does not synchronise',
    JSON.stringify(other.jobs.map((j) => j.offset)) !== JSON.stringify(offs));
}

console.log('\n--- nothing fires at boot+0 ---');
{
  const { s, adv } = rig();
  let ran = 0;
  s.every('a', 600_000, () => { ran++; });
  s.every('b', 600_000, () => { ran++; });
  check('no job is due at the instant of boot', s.due() === null);
  adv(1000);
  check('nor a second later', s.due() === null, 'boot is the busiest moment of the process');
  adv(600_000);
  check('but they do become due within one period', s.due() !== null);
}

console.log('\n--- the guaranteed minimum gap holds even when the hash does not separate them ---');
{
  const { s, adv } = rig({ minGapMs: 5000 });
  const fired = [];
  /* Force a collision: three jobs made due at exactly the same instant. */
  s.every('x', 60_000, () => fired.push(['x', s.now()]));
  s.every('y', 60_000, () => fired.push(['y', s.now()]));
  s.every('z', 60_000, () => fired.push(['z', s.now()]));
  for (const j of s.jobs) j.nextAt = s.now();

  (async () => {
    await s.tick();
    check('one job fires', fired.length === 1);
    await s.tick();
    check('the second is HELD by the gap, not fired alongside it', fired.length === 1);
    adv(5001);
    await s.tick();
    check('and fires once the gap has passed', fired.length === 2);
    adv(5001);
    await s.tick();
    check('the third follows on the next gap', fired.length === 3);
    check('they are three different jobs, so none starved',
      new Set(fired.map((f) => f[0])).size === 3, fired.map((f) => f[0]).join(','));
  })();
}

(async () => {
  await new Promise((r) => setTimeout(r, 60));

  console.log('\n--- a job that throws cannot take the scheduler down ---');
  {
    const { s, adv } = rig({ minGapMs: 0 });
    let good = 0;
    s.every('bad', 10_000, () => { throw new Error('boom'); });
    s.every('good', 10_000, () => { good++; });
    for (const j of s.jobs) j.nextAt = s.now();

    await s.tick();
    await s.tick();
    check('the healthy job still ran', good === 1, `good=${good}`);
    const bad = s.jobs.find((j) => j.name === 'bad');
    check('the failure is counted against that job', bad.errors === 1);
    check('and recorded with its reason', s.status().recent.some((r) => r.what === 'error' && /boom/.test(r.detail)));
    check('the scheduler keeps scheduling it rather than dropping it',
      bad.nextAt > s.now(), 'a job that fails once may succeed next time');

    /* And a rejected promise, which is the version that actually happens in this codebase. */
    const r2 = rig({ minGapMs: 0 });
    r2.s.every('async-bad', 10_000, async () => { throw new Error('async boom'); });
    r2.s.jobs[0].nextAt = r2.s.now();
    await r2.s.tick();
    check('an async rejection is caught too', r2.s.jobs[0].errors === 1);
  }

  console.log('\n--- the period is honoured after a run ---');
  {
    const { s, adv } = rig({ minGapMs: 0 });
    let n = 0;
    s.every('p', 100_000, () => { n++; });
    s.jobs[0].nextAt = s.now();
    await s.tick();
    check('it ran once', n === 1);
    adv(50_000); await s.tick();
    check('and not again inside its period', n === 1);
    adv(50_001); await s.tick();
    check('but does after it', n === 2);
  }

  console.log('\n--- status reports enough to debug a schedule ---');
  {
    const { s } = rig();
    s.every('alpha', 600_000, () => {});
    s.every('beta', 300_000, () => {});
    const st = s.status();
    check('every job is listed', st.jobs.length === 2);
    check('with its period, its offset and when it is next due',
      st.jobs.every((j) => j.periodSec > 0 && j.offsetSec >= 0 && j.inSec >= 0),
      JSON.stringify(st.jobs));
    check('sorted by what happens next', st.jobs[0].inSec <= st.jobs[1].inSec);
    check('and the gap it is enforcing is stated', st.minGapMs > 0);
  }

  console.log('\n--- B11: the boot trial measures once and refuses what it could not measure ---');
  {
    let t = 5_000_000;
    const bt = new BootTrial({ now: () => t });
    const r = await bt.run({
      fps:    async () => { t += 40; return { value: 58.5, verdict: 'high', why: 'held 58.5 fps for 40 frames' }; },
      spawn:  async () => { t += 900; return { value: 900, verdict: 'slow', why: 'a PowerShell one-shot took 900 ms' }; },
      broken: async () => { throw new Error('no such counter'); },
    });

    check('a probe that measured yields its verdict', r.fps.verdict === 'high' && r.fps.ok === true);
    check('and reports the MEASUREMENT, not only the verdict', r.fps.value === 58.5 && /58.5 fps/.test(r.fps.why));
    check('how long the probe itself took is recorded', r.spawn.ms >= 900, r.spawn.ms);

    /* The important one. A probe that could not run must not produce a pessimistic verdict — that
       is how a capable machine ends up permanently degraded by one missing counter. */
    check('a probe that FAILED yields no verdict at all', r.broken.ok === false && r.broken.verdict === null);
    check('and says it could not measure, rather than that it measured something bad',
      /could not run/.test(r.broken.why), r.broken.why);
    check('the caller gets its own default for an unmeasurable probe',
      bt.verdict('broken', 'assume-capable') === 'assume-capable');
    check('and the real verdict where there was one', bt.verdict('fps', 'x') === 'high');
    check('an unknown probe falls back too', bt.verdict('nope', 'dflt') === 'dflt');

    const st = bt.status();
    check('the trial declares that it is NOT persisted', st.persisted === false);
    check('and explains why in words', /every boot re-earns it/.test(st.note), st.note);
    check('every result carries the boot it came from', Object.values(st.results).every((x) => x.at === bt.ranAt));
  }

  console.log(`\n${fail ? fail + ' FAILED of ' : 'all '}${pass + fail} checks${fail ? '' : ' passed'} — jobs spread, failures are contained, and an unmeasurable probe yields no verdict.`);
  process.exit(fail ? 1 : 0);
})();
