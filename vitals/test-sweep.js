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

console.log('\n--- A QUANTIZED INSTRUMENT IS NOT A NOISELESS ONE ---');
{
  /* The production case, reproduced. The real measurement is a median frame interval, and frames
     arrive on vsync, so samples land on 16.7 ms steps. When more than half of them share a step the
     MAD is exactly ZERO - which happened in 300 of 300 trial sweeps, meaning the zero-noise branch
     was not the corner case it was written as, it was the only branch that ever ran. And that
     branch had no bar: `effect > 0` made any difference at all a winner.

     Both arms below are the SAME distribution, sampled onto the same grid. There is nothing to
     find. A one-step gap between their medians is the grid, not the setting. */
  const step = 1000 / 60;
  const quant = (x) => Math.round(x / step) * step;
  const s = rig(async () => quant(noisy(24, 9)));
  const r = await s.run('vsync', ['on', 'off'], 9);
  check('the within-arm spread really is zero, as it is in production',
    r.arms.every((a) => a.spread === 0), JSON.stringify(r.arms.map((a) => a.spread)));
  check('a quantized instrument does NOT get a free winner', r.distinguishable === false,
    `effect ${r.effect} — ${r.verdict}`);
  check('there is no bar, and none is invented', r.bar === null);
  check('the receipt names the test that actually ran', /separation/.test(r.testedBy || ''), r.testedBy);
  check('and the verdict blames the instrument rather than clearing the setting',
    /limit of the\s+instrument/.test(r.verdict), r.verdict);

  /* The other end of it. A magnitude test has nothing to stand on here, but SEPARATION does: if
     every sample of one arm lands clear of every sample of the other, that is strong evidence no
     matter how coarse the steps are. Refusing to say so would be its own dishonesty. */
  const big = rig(async (v) => quant(noisy(v === 'on' ? 16.7 : 66, 6)));
  const rb = await big.run('vsync', ['on', 'off'], 9);
  check('but arms that separate COMPLETELY are still reported', rb.distinguishable === true,
    `${rb.verdict}`);
  check('and the claim rests on an exact p-value, not on an estimated floor',
    rb.separation && rb.separation.complete === true && rb.separation.p < 0.01, JSON.stringify(rb.separation));

  /* SEPARATION ALONE IS NOT ENOUGH — and the check that used to sit here proved nothing.
     It read `distinguishable === (separation.p <= 0.01)`, which asserts the module agrees with its
     own implementation: deleting the p gate entirely left the suite green. Worse, its name
     described a case it could not construct — `run()` refuses fewer than MIN_ROUNDS rounds, and at
     5 rounds with 2 arms p is already 0.0079, comfortably under the bar.
     The case IS reachable through the ARM COUNT, because p carries a C(k,2) multiple-comparison
     factor. Five arms at 5 rounds: 10 pairs x 2/C(10,5) = 0.079, eight times the bar. These two
     runs differ ONLY in how many chances there were to find an extreme, and the verdict flips. */
  const sep = async (arms, rounds) => {
    const base = {}; arms.forEach((a, i) => { base[a] = 16.7 + i * 66; });
    return rig(async (v) => quant(noisy(base[v], 6))).run('vsync', arms, rounds);
  };
  const wide = await sep(['a', 'b', 'c', 'd', 'e'], MIN_ROUNDS);
  check('perfectly separated arms are still REFUSED when there were too many chances to separate',
    wide.separation.complete === true && wide.distinguishable === false && wide.separation.p > 0.01,
    `${wide.separation.pairs} pairs, p=${wide.separation.p}, complete=${wide.separation.complete}`);

  const enough = await sep(['a', 'b', 'c', 'd', 'e'], 9);
  check('the SAME five arms with more rounds clear the same bar',
    enough.separation.complete === true && enough.distinguishable === true && enough.separation.p <= 0.01,
    `p=${enough.separation.p}`);

  /* And the degenerate case: nothing varies at all, anywhere. */
  const flat = rig(async () => 42);
  const rf = await flat.run('flat', ['a', 'b'], 6);
  check('all-identical samples yield no winner', rf.distinguishable === false && rf.effect === 0);
  check('and no separation is claimed from them', rf.separation.complete === false);
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
