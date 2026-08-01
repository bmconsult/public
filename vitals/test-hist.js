/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - HISTOGRAM SUITE.  node test-hist.js   (any platform)
 *
 * What this proves: the error bound HOLDS on real-shaped data, the merge is exact, the encoding
 * round-trips, and the layout chooser picks the smaller of the two.
 *
 * The central test is not "does it return a number" - it is that the realised quantile error is
 * MEASURED against the true quantile of the raw samples, on every distribution shape these metrics
 * actually take, and asserted against the bound the module claims. A histogram that quietly missed
 * its own error bound would be the exact failure this substrate exists to prevent: a confident
 * number with nothing behind it.
 */

const { Hist, mergeEncoded, ALPHA } = require('./hist');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra !== undefined ? '  [' + extra + ']' : ''}`); }
};

/* Deterministic pseudo-random, so a failure is reproducible and CI cannot flake. Seeded LCG. */
let seed = 20260731;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

const trueQuantile = (arr, q) => {
  const s = [...arr].sort((a, b) => a - b);
  if (q <= 0) return s[0];
  if (q >= 1) return s[s.length - 1];
  let r = Math.floor(q * s.length);
  if (r >= s.length) r = s.length - 1;
  return s[r];
};

/* The shapes these metrics genuinely take, named so a failure says which one broke. */
const SHAPES = {
  'cpu percent (bounded, mid-range)': () => Array.from({ length: 4000 }, () => 5 + rnd() * 40),
  'memory percent (bounded, tight)': () => Array.from({ length: 4000 }, () => 79 + rnd() * 3),
  'hard faults (heavy tail, real range 0-618)': () =>
    Array.from({ length: 4000 }, () => (rnd() < 0.8 ? rnd() * 5 : Math.pow(10, 1 + rnd() * 1.8))),
  'disk MB/s (mostly idle, occasional burst)': () =>
    Array.from({ length: 4000 }, () => (rnd() < 0.9 ? rnd() * 0.5 : 20 + rnd() * 200)),
  'frame time ms (the stutter case)': () =>
    Array.from({ length: 4000 }, () => (rnd() < 0.96 ? 8 + rnd() * 1.5 : 200 + rnd() * 150)),
  'a constant': () => new Array(2000).fill(42),
  'all zero': () => new Array(2000).fill(0),
};

console.log('--- the error bound HOLDS, measured against the raw samples ---');
{
  let worst = 0, worstWhere = '';
  for (const [name, gen] of Object.entries(SHAPES)) {
    const raw = gen();
    const h = new Hist();
    for (const v of raw) h.add(v);
    let bad = 0, localWorst = 0;
    for (const q of [0.05, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99]) {
      const got = h.quantile(q), want = trueQuantile(raw, q);
      /* Relative error, except near zero where relative error is meaningless - there the absolute
         miss must be under the noise floor instead. Saying which rule applies matters: a bound
         quoted as relative that silently becomes absolute is not a bound. */
      const err = Math.abs(want) < 0.01 ? Math.abs(got - want) : Math.abs(got - want) / Math.abs(want);
      if (err > localWorst) localWorst = err;
      if (err > ALPHA + 1e-9) bad++;
    }
    if (localWorst > worst) { worst = localWorst; worstWhere = name; }
    check(`within ${(ALPHA * 100).toFixed(0)}% on ${name}`, bad === 0,
      `worst ${(localWorst * 100).toFixed(2)}%`);
  }
  console.log(`      worst realised error across all shapes: ${(worst * 100).toFixed(2)}%  (${worstWhere})`);
}

console.log('\n--- the motivating case: a mean cannot see a stutter, a histogram can ---');
{
  /* Two minutes with the SAME mean. One ran evenly; one ran fast with four long hitches. This is
     the complaint a user actually files, and the v1 [min,avg,max] rollup recorded them identically
     apart from the max - which is one sample and could be anything. */
  const even = new Array(600).fill(12.0);
  const hitchy = new Array(600).fill(8.0);
  /* 108, not a round 112: 576 frames at 8 ms plus 24 at 108 is exactly 7200 ms, the same total as
     600 even frames at 12. The point of the test is that the means are IDENTICAL, so the number
     has to be solved for rather than picked - the first draft used 112 and the means differed by
     0.16, which would have let the test pass for the wrong reason. */
  for (let i = 0; i < 24; i++) hitchy[i * 25] = 108.0;      // 4% of frames
  const mEven = even.reduce((a, b) => a + b) / even.length;
  const mHitch = hitchy.reduce((a, b) => a + b) / hitchy.length;
  check('the two minutes have the same mean to within 0.1',
    Math.abs(mEven - mHitch) < 0.1, `${mEven.toFixed(2)} vs ${mHitch.toFixed(2)}`);

  const a = new Hist(), b = new Hist();
  even.forEach((v) => a.add(v));
  hitchy.forEach((v) => b.add(v));
  check('p50 already separates them', b.quantile(0.5) < a.quantile(0.5) * 0.75,
    `${b.quantile(0.5).toFixed(1)} vs ${a.quantile(0.5).toFixed(1)}`);
  check('p99 separates them by an order of magnitude',
    b.quantile(0.99) > a.quantile(0.99) * 5,
    `${b.quantile(0.99).toFixed(1)} vs ${a.quantile(0.99).toFixed(1)}`);
}

console.log('\n--- the merge is EXACT, which is what "store by scale" rests on ---');
{
  const all = [];
  const parts = [];
  for (let m = 0; m < 60; m++) {                    // sixty "minutes"
    const h = new Hist();
    const n = 30 + Math.floor(rnd() * 40);          // varying sample counts, as the real rate drifts
    for (let i = 0; i < n; i++) {
      const v = rnd() < 0.9 ? rnd() * 30 : 60 + rnd() * 40;
      h.add(v); all.push(v);
    }
    parts.push(h);
  }
  const merged = new Hist();
  for (const p of parts) merged.merge(p);
  const direct = new Hist();
  for (const v of all) direct.add(v);

  check('merged count equals the direct count', merged.n === direct.n, `${merged.n} vs ${direct.n}`);
  check('merged sum equals the direct sum', Math.abs(merged.sum - direct.sum) < 1e-6);
  check('merged min/max are exact', merged.min === direct.min && merged.max === direct.max);
  let same = true;
  for (const q of [0.1, 0.5, 0.9, 0.95, 0.99]) if (merged.quantile(q) !== direct.quantile(q)) same = false;
  check('every merged quantile is IDENTICAL, not merely close', same);

  /* And the thing means cannot do: sixty means averaged is only right when every bucket had the
     same sample count. The counts vary here exactly as the real collector's rate does. */
  const meanOfMeans = parts.reduce((a, p) => a + p.avg, 0) / parts.length;
  check('averaging the sixty means is measurably WRONG (why this replaced it)',
    Math.abs(meanOfMeans - direct.avg) > 1e-9,
    `meanOfMeans ${meanOfMeans.toFixed(4)} vs true ${direct.avg.toFixed(4)}`);
}

console.log('\n--- encode / decode round-trips, and the layout chooser earns its keep ---');
{
  const quiet = new Hist();
  for (let i = 0; i < 58; i++) quiet.add(7 + rnd() * 1.2);     // a calm CPU minute
  const spread = new Hist();
  for (let i = 0; i < 58; i++) spread.add(rnd() < 0.7 ? rnd() * 0.4 : Math.pow(10, rnd() * 2.8));

  const qe = quiet.encode(), se = spread.encode();
  check('a tight distribution encodes DENSE', qe[5] === 0, `mode ${qe[5]}`);
  check('a spread one encodes SPARSE', se[5] === 1, `mode ${se[5]}`);
  /* The chooser must actually be choosing the smaller, not just switching on a hunch. */
  const denseLenOf = (h) => { const k = [...h.bins.keys()].sort((a, b) => a - b); return k.length ? k[k.length - 1] - k[0] + 2 : 0; };
  check('sparse really is smaller for the spread case',
    spread.bins.size * 2 < denseLenOf(spread), `${spread.bins.size * 2} vs ${denseLenOf(spread)}`);

  /* THE BINS must survive exactly - they are the measurement. The head numbers (min, max, sum) are
     deliberately quantised to two decimals on the way out, the same precision the v1 rollups
     stored, so they are checked against that rounding rather than for bit-equality. Asserting
     exact equality there would be asserting the absence of a rounding the format chose on purpose,
     and the first draft of this test did exactly that and failed the code for obeying its spec. */
  for (const [name, h] of [['quiet', quiet], ['spread', spread]]) {
    const back = Hist.decode(h.encode());
    const binsSame = JSON.stringify([...h.bins].sort((a, b) => a[0] - b[0]))
                  === JSON.stringify([...back.bins].sort((a, b) => a[0] - b[0]));
    check(`${name}: every bin survives encode -> decode EXACTLY`, binsSame);
    check(`${name}: count and zero bucket survive exactly`, back.n === h.n && back.zero === h.zero);
    check(`${name}: head numbers survive to the stored 0.01`,
      Math.abs(back.min - h.min) <= 0.005 && Math.abs(back.max - h.max) <= 0.005
      && Math.abs(back.sum - h.sum) <= 0.005);
    let qOk = true;
    for (const q of [0.5, 0.9, 0.99]) if (Math.abs(back.quantile(q) - h.quantile(q)) > 0.01) qOk = false;
    check(`${name}: quantiles unchanged across the round trip`, qOk);
  }

  const empty = new Hist();
  check('an empty histogram encodes and decodes without inventing a bin',
    Hist.decode(empty.encode()).n === 0 && Hist.decode(empty.encode()).quantile(0.5) === null);

  const merged = mergeEncoded([quiet.encode(), spread.encode()]);
  check('encoded records merge without a full decode round-trip first',
    merged.n === quiet.n + spread.n);
}

console.log('\n--- refusals: it never invents a reading ---');
{
  const h = new Hist();
  check('empty quantile is null, not 0', h.quantile(0.5) === null);
  check('empty avg is null, not 0', h.avg === null);
  check('empty triple is null', h.triple() === null);

  h.add(NaN); h.add(Infinity); h.add(undefined); h.add(null); h.add('12');
  check('non-numbers are ignored entirely, not counted as zero', h.n === 0,
    `n=${h.n} sum=${h.sum}`);

  h.add(0); h.add(0); h.add(5);
  check('real zeros ARE counted', h.n === 3);
  check('p50 of [0,0,5] is 0', h.quantile(0.5) === 0);
  check('min is exactly 0 and max exactly 5', h.min === 0 && h.max === 5);

  const one = new Hist(); one.add(42);
  check('a single sample reports itself at every quantile',
    one.quantile(0) === 42 && one.quantile(0.5) === 42 && one.quantile(1) === 42,
    `${one.quantile(0)} ${one.quantile(0.5)} ${one.quantile(1)}`);
}

console.log('\n--- extremes are exact, never a rounded bin ---');
{
  const h = new Hist();
  for (let i = 0; i < 500; i++) h.add(10 + rnd());
  h.add(0.137); h.add(987.654);
  check('p0 returns the exact minimum', h.quantile(0) === 0.137);
  check('p100 returns the exact maximum', h.quantile(1) === 987.654);
  check('no quantile can exceed the observed max',
    [0.5, 0.9, 0.99, 0.999].every((q) => h.quantile(q) <= h.max));
  check('no quantile can fall below the observed min',
    [0.001, 0.01, 0.1].every((q) => h.quantile(q) >= h.min));
}

console.log('\n--- the old [min, avg, max] stays derivable, so v1 readers survive ---');
{
  const raw = Array.from({ length: 300 }, () => 5 + rnd() * 40);
  const h = new Hist();
  raw.forEach((v) => h.add(v));
  const t = h.triple();
  const trueAvg = raw.reduce((a, b) => a + b) / raw.length;
  check('min is exact', Math.abs(t[0] - Math.min(...raw)) < 0.01);
  check('max is exact', Math.abs(t[2] - Math.max(...raw)) < 0.01);
  check('avg is EXACT, not a bin estimate (the sum is carried)',
    Math.abs(t[1] - trueAvg) < 0.01, `${t[1]} vs ${trueAvg.toFixed(4)}`);
}

console.log(`\n${fail ? fail + ' FAILED of ' : 'all '}${pass + fail} checks${fail ? '' : ' passed'} — the bound is measured, not asserted.`);
process.exit(fail ? 1 : 0);
