/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - CORRELATION SUITE (B16).  node test-correlate.js   (any platform)
 *
 * What this proves: the arithmetic is right against KNOWN answers, and every guard that stops a
 * meaningless number reaching the page actually stops it.
 *
 * The reason the guards get more checks than the arithmetic: Pearson's r is easy to compute and
 * easy to compute meaninglessly. On ten points it is trivial to draw |r| > 0.9 out of noise, and a
 * constant series yields a divide-by-zero that several languages hand back as a confident 0.00.
 * Both failure modes produce a number that looks exactly like a measurement.
 */

const { correlate, pearson, pValue, PAIRS, MIN_N, MIN_R } = require('./correlate');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra !== undefined ? '  [' + extra + ']' : ''}`); }
};

let seed = 31337;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

/** Build n tick-shaped rows from a generator over index. */
const rows = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));

console.log('--- the arithmetic, against answers known in advance ---');
{
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  check('a perfect straight line is r = 1',
    Math.abs(pearson(xs, xs.map((x) => 3 * x + 7)).r - 1) < 1e-9);
  check('a perfect inverse is r = -1',
    Math.abs(pearson(xs, xs.map((x) => -2 * x + 4)).r + 1) < 1e-9);

  /* A textbook case with a hand-checkable answer. */
  const a = [1, 2, 3, 4, 5], b = [2, 4, 5, 4, 5];
  check('a known mixed case matches the textbook value',
    Math.abs(pearson(a, b).r - 0.7745966) < 1e-6, pearson(a, b).r);

  const ind = rows(4000, () => rnd());
  const ind2 = rows(4000, () => rnd());
  check('two independent series are near zero', Math.abs(pearson(ind, ind2).r) < 0.06,
    pearson(ind, ind2).r);
}

console.log('\n--- a flat series is UNDEFINED, never zero ---');
{
  const flatA = pearson([5, 5, 5, 5, 5], [1, 2, 3, 4, 5]);
  check('a constant on the left yields null', flatA.r === null, JSON.stringify(flatA));
  check('and names which side was flat', flatA.flat === 'a');
  const flatB = pearson([1, 2, 3, 4, 5], [9, 9, 9, 9, 9]);
  check('a constant on the right yields null', flatB.r === null && flatB.flat === 'b');
  check('both flat still yields null, not 0', pearson([2, 2, 2], [3, 3, 3]).r === null);
}

console.log('\n--- the guards, which are the point ---');
{
  /* A perfect correlation over too few samples must NOT reach the page. */
  const few = rows(20, (i) => ({ gpu: i, gpuTemp: i * 2 }));
  const r1 = correlate(few).pairs.find((p) => p.id === 'gpu_heat');
  check('a perfect r over 20 samples is refused for sample count', r1.strong === false, JSON.stringify(r1));
  check('and says how many it needed', /needed before a correlation/.test(r1.why), r1.why);

  /* The same relationship with enough samples must pass. */
  const many = rows(MIN_N + 40, (i) => ({ gpu: i % 50, gpuTemp: (i % 50) * 1.7 + 30 }));
  const r2 = correlate(many).pairs.find((p) => p.id === 'gpu_heat');
  check('with enough samples the same relationship qualifies', r2.strong === true, JSON.stringify(r2));
  check('r is reported', Math.abs(r2.r - 1) < 0.001, r2.r);
  check('and so is p', r2.p != null && r2.p < 0.05, r2.p);
  check('the direction is named in words', r2.direction === 'together');

  /* Noise at scale must not qualify, however many samples there are. */
  const noise = rows(2000, () => ({ gpu: rnd() * 100, gpuTemp: rnd() * 100 }));
  const r3 = correlate(noise).pairs.find((p) => p.id === 'gpu_heat');
  check('noise does not qualify even with 2000 samples', r3.strong === false, `r=${r3.r}`);
  check('and it is reported as measured-and-rejected, not omitted', r3.r !== null && /too weak/.test(r3.why));

  /* A flat side over a long window: undefined, and said so. */
  const flat = rows(400, () => ({ gpu: 40, gpuTemp: 30 + rnd() * 20 }));
  const r4 = correlate(flat).pairs.find((p) => p.id === 'gpu_heat');
  check('a flat side reports undefined rather than absent', r4.r === null && r4.strong === false);
  check('and names it as not varying', /did not vary/.test(r4.why), r4.why);

  /* An inverse relationship is as reportable as a positive one. */
  const inv = rows(MIN_N + 40, (i) => ({ hardFaults: i % 40, diskQueue: 100 - (i % 40) * 2 }));
  const r5 = correlate(inv).pairs.find((p) => p.id === 'paging_queue');
  check('an inverse relationship qualifies too', r5.strong === true && r5.r < 0, r5.r);
  check('and is described as opposed', r5.direction === 'opposed');
}

console.log('\n--- p rejects a strong r that few points could have produced by chance ---');
{
  /* r is held roughly constant while n varies, so the ONLY thing changing is the sample count -
     which isolates the p gate from the r gate. */
  const shape = (i) => ({ mem: i % 30, hardFaults: (i % 30) * 1.4 + (rnd() - 0.5) * 22 });
  const small = correlate(rows(30, shape), { minN: 5 }).pairs.find((p) => p.id === 'mem_paging');
  const big = correlate(rows(600, shape), { minN: 5 }).pairs.find((p) => p.id === 'mem_paging');
  check('p falls as the same relationship gains samples', big.p <= small.p,
    `n=${small.n} p=${small.p}  vs  n=${big.n} p=${big.p}`);
  check('a large sample of a real relationship qualifies', big.strong === true, JSON.stringify(big));
  check('pValue of a null r is 1, not 0', pValue(null, 500) === 1);
  check('pValue on too few points is 1', pValue(0.99, 3) === 1);
}

console.log('\n--- every declared pair carries what it does NOT mean ---');
{
  /* The load-bearing editorial rule. A pair whose confounder cannot be written down is a pair that
     is not understood well enough to publish, so this is asserted rather than trusted. */
  for (const p of PAIRS) {
    check(`${p.id} states what it means`, typeof p.means === 'string' && p.means.length > 20);
    check(`${p.id} states what it does NOT mean`,
      typeof p.doesNotMean === 'string' && p.doesNotMean.length > 20);
  }
  check('the pair ids are unique', new Set(PAIRS.map((p) => p.id)).size === PAIRS.length);
}

console.log('\n--- refusals ---');
{
  const empty = correlate([]);
  check('an empty window returns every pair, all refused',
    empty.pairs.length === PAIRS.length && empty.pairs.every((p) => !p.strong));
  check('null input does not throw', correlate(null).pairs.length === PAIRS.length);
  const junk = correlate(rows(300, () => ({ gpu: 'x', gpuTemp: null })));
  check('non-numeric samples are skipped, not coerced',
    junk.pairs.find((p) => p.id === 'gpu_heat').n === 0);
  check('the thresholds it used are reported alongside the result',
    empty.minN > 0 && empty.minR > 0 && empty.maxP > 0);
}

console.log(`\n${fail ? fail + ' FAILED of ' : 'all '}${pass + fail} checks${fail ? '' : ' passed'} — the arithmetic is checked against known answers, and every guard is checked from the wrong side.`);
process.exit(fail ? 1 : 0);
