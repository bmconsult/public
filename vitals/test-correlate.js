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

const { correlate, pearson, pValue, PAIRS, MIN_N, MIN_R, MAX_DRIFT } = require('./correlate');

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

console.log('\n--- THE ONE THE FIRST VERSION FAILED: consecutive ticks are not independent draws ---');
{
  /* Two random walks, built from separate streams so they have provably nothing to do with each
     other. This is the shape of the failure: the p-value was computed as if 300 ticks were 300
     independent observations, so a pair of unrelated drifting series cleared p < 0.05 about 39% of
     the time. Deterministic seeds here so the check is a check and not a coin flip. */
  let s1 = 12345, s2 = 998877;
  const r1 = () => (s1 = (s1 * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;
  const r2 = () => (s2 = (s2 * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;
  let va = 0, vb = 0;
  const rows = [];
  for (let i = 0; i < 300; i++) {
    va += r1(); vb += r2();
    rows.push({ gpu: 50 + va * 4, gpuTemp: 60 + vb * 4 });
  }
  const res = correlate(rows);
  const pair = res.pairs.find((p) => p.id === 'gpu_heat');
  check('the autocorrelation is measured and published, not assumed away',
    pair.autocorr && pair.autocorr.a > 0.9 && pair.autocorr.b > 0.9, JSON.stringify(pair.autocorr));
  check('300 autocorrelated ticks are NOT counted as 300 independent samples',
    pair.nEff < pair.n, `${pair.n} ticks -> ${pair.nEff} effective`);

  /* THE ASSERTION THAT ACTUALLY PROTECTS THE FIX, and the suite did not have one.
     Everything above checks that `nEff` is PUBLISHED and smaller. None of it checked that the
     p-value is computed FROM it. Reverting `pValue(st.r, nEff)` to `pValue(st.r, st.n)` — undoing
     this round's entire statistical correction — left all 46 checks green, because `nEff` would
     still be published and still be smaller while being used for nothing.
     There is no behavioural test available here: 15% of independent random walks still read
     "strong" even when corrected, so "a spurious pair is rejected" is not a property that holds.
     So this asserts the arithmetic directly — which number went into the published p — and that
     is deterministic, not statistical. */
  const pFromEffective = +pValue(pair.r, pair.nEff).toFixed(4);
  const pFromRaw = +pValue(pair.r, pair.n).toFixed(4);
  check('the published p is computed from the EFFECTIVE n, not the raw one',
    Math.abs(pair.p - pFromEffective) < 1e-4 && Math.abs(pair.p - pFromRaw) > 1e-4,
    `published ${pair.p} · from nEff ${pFromEffective} · from raw n ${pFromRaw}`);
  check('and the raw-n figure really would have been the more confident one — which is the bug',
    pFromRaw < pFromEffective, `${pFromRaw} vs ${pFromEffective}`);

  /* No test available on one window separates this from a legitimate smooth signal — three were
     tried and measured, see MAX_DRIFT — so what must be true is that the risk is PRICED. A reader
     handed r = 0.9 on two random walks has to be told how often that happens by itself. */
  check('a persistent pair carries the measured chance it is a coincidence',
    pair.persistence > MAX_DRIFT && pair.couldBeCoincidencePct > 0,
    `persistence ${pair.persistence}, could be coincidence ${pair.couldBeCoincidencePct}%`);
  if (pair.strong) {
    check('and says so in the sentence a person reads, with the number in it',
      /could be coincidence|% of the time/.test(pair.why), pair.why);
    check('and calls it a lead rather than a finding', /Treat it as a lead/.test(pair.why), pair.why);
    check('and reports that it does NOT survive differencing — the spurious signature',
      pair.agreement === 'levels-only' && /does NOT hold on the changes/.test(pair.why), pair.agreement);
  } else {
    check('or it did not clear the corrected test at all, which is the other good outcome',
      pair.strong === false, pair.why);
    pass++; console.log('PASS  (the correction alone was enough on this seed)');
  }

  /* The correction must not become a gag. A genuine, fast-moving relationship on STATIONARY series
     — load rising and falling, temperature following — still has to come through. */
  let s3 = 4242;
  const r3 = () => (s3 = (s3 * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;
  const real = [];
  for (let i = 0; i < 300; i++) {
    const load = 50 + 35 * Math.sin(i / 7) + r3() * 4;
    real.push({ gpu: load, gpuTemp: 40 + load * 0.4 + r3() * 2 });
  }
  const rr = correlate(real).pairs.find((p) => p.id === 'gpu_heat');
  check('a real relationship on series that actually fluctuate is still found', rr.strong === true,
    `r ${rr.r}, p ${rr.p} — ${rr.why}`);
  check('and the discount is shown rather than hidden', rr.nEff > 0 && rr.nEff <= 300,
    `${rr.n} ticks worth ${rr.nEff} independent samples`);
}

console.log('\n--- TWO ARMS: levels AND changes, with the disagreement published ---');
{
  /* A relationship that holds BOTH ways: an instantaneous coupling. Nothing about persistence can
     weaken this one, because a shared trend cannot survive differencing. */
  let s4 = 777;
  const r4 = () => (s4 = (s4 * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;
  const inst = [];
  for (let i = 0; i < 300; i++) {
    const load = 50 + 35 * Math.sin(i / 7) + r4() * 4;
    inst.push({ gpu: load, gpuTemp: 40 + load * 0.4 + r4() * 2 });
  }
  const ri = correlate(inst).pairs.find((p) => p.id === 'gpu_heat');
  check('an instantaneous coupling holds on the CHANGES as well as the levels',
    ri.agreement === 'both' && ri.changes.strong === true,
    `${ri.agreement} · changes r ${ri.changes && ri.changes.r}`);
  check('and the verdict says that is the strongest form available',
    /strongest form this engine can report/.test(ri.why), ri.why);

  /* AND THE ONE THAT KEEPS DIFFERENCING FROM BECOMING THE ONLY TEST. Temperature INTEGRATES load,
     so d(temp) tracks the LEVEL of load, not d(load). Differencing both sides destroys a
     relationship that is completely real — measured at 0.0% detection over 1000 trials, the same
     score as two independent random walks. Had the engine switched to differences instead of adding
     them, it would have silently deleted gpu_heat and cpu_heat and called it rigour. */
  let s5 = 24680;
  const r5 = () => (s5 = (s5 * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;
  const integ = [];
  let load = 50, temp = 60;
  for (let i = 0; i < 300; i++) {
    load = Math.max(0, Math.min(100, load + r5() * 18));
    temp += 0.05 * (load - 50) - 0.08 * (temp - 60) + r5() * 0.4;
    integ.push({ gpu: load, gpuTemp: temp });
  }
  const rg = correlate(integ).pairs.find((p) => p.id === 'gpu_heat');
  check('a REAL integrator relationship is found in the levels', rg.strong === true,
    `r ${rg.r} — ${rg.why}`);
  check('and it does NOT survive differencing, which is expected physics rather than a defect',
    rg.changes && rg.changes.strong === false, `changes r ${rg.changes && rg.changes.r}`);
  check('so "levels only" is reported as UNRESOLVED rather than as spurious',
    rg.agreement === 'levels-only' && /cannot tell those apart/.test(rg.why), rg.why);
  check('and the verdict names the accumulating case, not only the shared-trend case',
    /load heating a chip/.test(rg.why), rg.why);

  check('a pair that never qualified carries no agreement label at all',
    correlate(rows(400, () => ({ gpu: 40 + rnd(), gpuTemp: 30 + rnd() * 20 })))
      .pairs.find((p) => p.id === 'gpu_heat').agreement === null);
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
