/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - SWEEP SUITE (B9).  node test-sweep.js   (any platform)
 *
 * The important tests here are the NEGATIVE ones.
 *
 * Anyone can write a sweep that finds a winner. The hard part - and the only part that makes the
 * receipt worth keeping - is refusing to find one when there is nothing there. Two failure modes
 * are simulated directly and both must produce "indistinguishable":
 *
 *   PURE NOISE       — arms that differ in no way at all. A sweep that names a winner here is a
 *                      random number generator with a confident voice.
 *   DRIFT            — a machine that gets steadily slower during the run. Under blocked ordering
 *                      that drift lands on whichever arm was measured last and is reported as its
 *                      effect. This is the specific confound interleaving exists to defeat, so the
 *                      suite builds it deliberately and checks the verdict survives.
 *
 * Time is injected, so the whole thing runs in milliseconds rather than in the minutes a real
 * sweep takes.
 */

const { Sweep, median, mad, MIN_ROUNDS } = require('./sweep');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra !== undefined ? '  [' + extra + ']' : ''}`); }
};

let seed = 991;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const noisy = (base, amp) => base + (rnd() - 0.5) * 2 * amp;

/** A sweep whose clock does not actually sleep. */
const rig = (measure, opts = {}) => new Sweep({
  apply: async () => {}, measure, settleMs: 0, sleep: async () => {}, ...opts,
});

(async () => {

console.log('--- statistics ---');
{
  check('median of an odd list', median([3, 1, 2]) === 2);
  check('median of an even list', median([1, 2, 3, 4]) === 2.5);
  check('median ignores junk', median([1, null, 2, NaN, 3]) === 2);
  check('median of nothing is null, not 0', median([]) === null);
  check('mad of a constant list is 0', mad([5, 5, 5, 5]) === 0);
  check('mad grows with spread', mad([1, 5, 9]) > mad([4, 5, 6]));
}

console.log('\n--- it finds an effect that is really there ---');
{
  /* A clear effect: 30 against 10, with noise of about 1. */
  const s = rig(async (v) => noisy(v === 'high' ? 30 : 10, 1));
  const r = await s.run('fps', ['high', 'low'], 7);
  check('the sweep completes', r.ok === true);
  check('it calls the difference distinguishable', r.distinguishable === true);
  check('and picks the cheaper arm', r.best === 'low', r.best);
  /* Asserted on MEANING: the verdict must carry both the observed gap and the bar that gap had to
     clear. A number without the thing it was compared against is an assertion. */
  check('the verdict states the gap AND the bar it had to clear',
    /gap of/.test(r.verdict) && /chance-alone bar/.test(r.verdict), r.verdict);
  check('and the receipt publishes that bar as a number', typeof r.bar === 'number' && r.bar > 0, r.bar);
  check('every arm reports its own spread', r.arms.every((a) => a.spread != null));
  check('and its sample count', r.arms.every((a) => a.n === 7), JSON.stringify(r.arms.map((a) => a.n)));
}

console.log('\n--- THE ONE THAT MATTERS: pure noise must NOT produce a winner ---');
{
  /* Identical arms. Any "winner" here is the sweep hallucinating.

     Asserted as a RATE, not as zero. This is a statistical property: demanding zero over a handful
     of trials is a test that passes or fails on the seed, which is a flaky test wearing a strict
     one's clothes. Calibrated at SAFETY 5.0 the true rate is about 4% at seven rounds, so the bar
     is set where a regression in the correction would be caught and ordinary variance would not. */
  let falsePositives = 0;
  const TRIALS = 300;
  for (let trial = 0; trial < TRIALS; trial++) {
    const s = rig(async () => noisy(20, 2));
    const r = await s.run('nothing', ['a', 'b', 'c'], 7);
    if (r.distinguishable) falsePositives++;
  }
  const fpRate = falsePositives / TRIALS;
  check(`${TRIALS} sweeps of identical arms stay under a 10% false-winner rate`,
    fpRate < 0.10, `${(fpRate * 100).toFixed(1)}% (${falsePositives}/${TRIALS})`);
  check('and the rate is far below the 37% the uncorrected version produced',
    fpRate < 0.15, `${(fpRate * 100).toFixed(1)}%`);

  /* MORE ROUNDS MUST BUY POWER, or the advice "run it longer" is empty. */
  let detected = 0;
  for (let trial = 0; trial < 40; trial++) {
    const s = rig(async (v) => noisy(v === 'hi' ? 24 : 20, 2));   // a 2x-noise effect
    const r = await s.run('power', ['hi', 'lo'], 15);
    if (r.distinguishable) detected++;
  }
  check('a 2x-noise effect IS found once given 15 rounds', detected / 40 > 0.6,
    `${detected}/40 detected`);

  const s = rig(async () => noisy(20, 2));
  const r = await s.run('nothing', ['a', 'b'], 7);
  check('and it says so in plain words', /No measurable difference/.test(r.verdict), r.verdict);
  check('with no "best" value offered', r.best === null);
  check('the verdict calls it a matter of taste rather than of cost', /taste rather than of cost/.test(r.verdict));
}

console.log('\n--- DRIFT must not be attributed to a setting ---');
{
  /* A machine that gets steadily slower over the run: cost climbs with every measurement taken,
     regardless of which arm is being measured. Under BLOCKED ordering this lands entirely on the
     last arm. Interleaving is what defeats it. */
  let taken = 0;
  const s = rig(async () => { taken++; return noisy(20 + taken * 0.6, 1); });
  const r = await s.run('drifting', ['a', 'b', 'c'], 8);
  check('a steadily drifting machine produces no false winner', r.distinguishable === false,
    `effect ${r.effect} vs noise ${r.noiseFloor} — ${r.verdict}`);

  /* And the proof that interleaving is what did it: the same drift under blocked ordering WOULD
     separate the arms, which is the confound this design exists to remove. */
  const blocked = [];
  let t2 = 0;
  for (const arm of ['a', 'b', 'c']) {
    const xs = [];
    for (let i = 0; i < 8; i++) { t2++; xs.push(20 + t2 * 0.6); }
    blocked.push({ arm, median: median(xs) });
  }
  const spreadIfBlocked = Math.max(...blocked.map((b) => b.median)) - Math.min(...blocked.map((b) => b.median));
  check('the same drift WOULD have separated the arms if measured in blocks',
    spreadIfBlocked > 4, `${spreadIfBlocked.toFixed(1)} apart under blocked ordering`);
}

console.log('\n--- interleaving really happens, and rotates ---');
{
  const seenOrder = [];
  const s = rig(async (v) => { seenOrder.push(v); return 10; });
  await s.run('order', ['a', 'b', 'c'], 6);
  const first6 = seenOrder.slice(0, 6).join('');
  check('arms alternate rather than running in blocks', !/aaa|bbb|ccc/.test(seenOrder.join('')),
    seenOrder.slice(0, 12).join(''));
  check('each arm is visited once per round',
    seenOrder.length === 18 && seenOrder.filter((v) => v === 'a').length === 6);
  check('and the order ROTATES, so no arm is always measured first',
    seenOrder[0] !== seenOrder[3], first6);
}

console.log('\n--- the receipt is auditable ---');
{
  const s = rig(async (v) => noisy(v === 'x' ? 30 : 12, 1));
  const r = await s.run('receipt', ['x', 'y'], 6);
  check('the raw trace is kept', Array.isArray(r.trace) && r.trace.length === 12);
  check('every sample records which round and which arm it came from',
    r.trace.every((t) => typeof t.r === 'number' && t.v !== undefined && typeof t.s === 'number'));
  check('the noise floor is reported as a number, not implied', typeof r.noiseFloor === 'number');
  check('so is the effect size', typeof r.effect === 'number');
  check('and when it started and finished', r.startedAt > 0 && r.endedAt >= r.startedAt);
}

console.log('\n--- refusals ---');
{
  const s = rig(async () => 10);
  check('one value is not a sweep', (await s.run('x', ['only'], 7)).ok === false);
  check('and neither is none', (await s.run('x', [], 7)).ok === false);
  const few = await s.run('x', ['a', 'b'], 3);
  check('too few rounds is REFUSED, not silently raised', few.ok === false, JSON.stringify(few));
  check('and the refusal explains the noise floor', /noise floor/.test(few.error), few.error);

  /* A measure that throws must not leave the sweep marked as running forever. */
  const boom = rig(async () => { throw new Error('measure failed'); });
  let threw = false;
  try { await boom.run('x', ['a', 'b'], 5); } catch { threw = true; }
  check('a failing measurement does not leave the sweep stuck running', boom.running === false,
    `threw=${threw}`);

  const s2 = rig(async () => 10);
  const p = s2.run('x', ['a', 'b'], 9);
  s2.stop();
  const r = await p;
  check('a stopped sweep says it was aborted', r.aborted === true || r.ok === false);
}

console.log(`\n${fail ? fail + ' FAILED of ' : 'all '}${pass + fail} checks${fail ? '' : ' passed'} — it finds real effects and, more importantly, refuses to invent one.`);
process.exit(fail ? 1 : 0);
})();
