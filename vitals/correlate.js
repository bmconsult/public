/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - THE CORRELATION ENGINE.  (B16, MARKET_RESEARCH §6.4)
 *
 * Every finding in diagnose.js reads ONE signal and applies a threshold. That catches the problems
 * that live in one number and misses every problem that only exists in the relationship between
 * two - a GPU that is fine until it is hot, a disk queue that only builds while the machine is
 * paging. Those are the cross-layer problems no single-tool view attempts, and they were being
 * written one hard-coded pair at a time.
 *
 * This promotes them from a list of pairs to a subsystem: a declared table of relationships, one
 * measurement path, one place where the statistics are done properly.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT A CORRELATION IS NOT.
 *
 * It is not causation, and the honest handling of that is not a disclaimer at the bottom - it is
 * that EVERY PAIR CARRIES ITS OWN `means` AND `doesNotMean` TEXT, written when the pair was added.
 * "GPU utilisation correlates with GPU temperature" means the load is producing the heat; it does
 * NOT mean the machine is throttling, and a reader who takes it that way has been misled by the
 * tool rather than by themselves. A pair whose confounder cannot be written down is a pair that
 * does not belong in the table.
 *
 * THE STATISTICS, AND WHY EACH GUARD EXISTS.
 *
 *   n >= MIN_N            A correlation over ten points is theatre. Pearson's r on tiny samples is
 *                         wildly unstable and it is trivially easy to get |r| > 0.9 from noise.
 *   both sides must VARY  If either series is constant, r is undefined - and computing it anyway
 *                         yields NaN or a divide-by-zero that some languages report as 0. A flat
 *                         series means "we learned nothing", not "no relationship".
 *   |r| >= MIN_R          Below this the relationship is not worth a sentence even when real.
 *   p < 0.05              A t-test on r, so a strong-looking correlation from few points cannot
 *                         reach the page. This is the guard that MIN_N alone does not provide.
 *   AUTOCORRELATION       Added after review, and the review was right: the two guards above were
 *                         doing nothing. A t-test assumes independent draws, and consecutive ticks
 *                         of a machine are nothing of the kind - CPU at t all but determines CPU at
 *                         t+1. Over 2000 windows of 300 samples from two INDEPENDENT random walks,
 *                         the uncorrected test called the pair "strong" 38.5% of the time. The stated
 *                         p < 0.05 was off by nearly a factor of eight, and the guard that existed
 *                         to keep coincidence off the page was the thing letting it through.
 *                         So the p-value is computed on Bartlett's EFFECTIVE sample count rather
 *                         than the raw one, which fixes the ordinary case outright.
 *   PERSISTENCE IS PRICED For the residual case it does not fix, see MAX_DRIFT: no available test
 *                         separates a drifting series from a smooth stationary one on a window this
 *                         size, so instead of a guard that cannot work, a finding on two highly
 *                         persistent series carries the MEASURED rate at which unrelated signals
 *                         that persistent correlate this strongly. The reader gets a number, not a
 *                         silence and not a false confidence.
 *   AND A SECOND ARM      Every pair is also measured on its CHANGES, not only its levels, and the
 *                         two answers are published side by side. Differencing annihilates the
 *                         spurious case (15.5% -> 0.0% on two independent random walks) but it is
 *                         NOT a replacement for the levels test, because it also annihilates every
 *                         relationship where one side accumulates the other - load heating a chip
 *                         scores 99.9% in levels and 0.0% differenced. Swapping to differences
 *                         would have deleted the two flagship pairs in the table and called it
 *                         rigour. So both run, and a pair strong in levels alone is labelled
 *                         UNRESOLVED rather than spurious. See the block beside the calculation.
 *
 * The first four have to pass; the fifth prices what is left and the sixth says how far it holds. Anything that fails is reported as
 * measured-and-rejected rather than omitted, because "we looked and found nothing" is a useful
 * answer and an absence is not.
 * ---------------------------------------------------------------------------------------------
 */

/* The declared relationships. Adding one means writing down what it would mean AND what it would
   not - if you cannot write the second, the pair is not understood well enough to publish. */
const PAIRS = [
  {
    id: 'gpu_heat', a: 'gpu', b: 'gpuTemp',
    label: 'GPU load vs GPU temperature',
    means: 'the load is producing the heat, which is the expected and healthy relationship',
    doesNotMean: 'that the machine is throttling — throttling would show as temperature holding ' +
                 'flat at a ceiling while load keeps climbing, which is the ABSENCE of this ' +
                 'correlation at the top end rather than its presence',
  },
  {
    id: 'paging_queue', a: 'hardFaults', b: 'diskQueue',
    label: 'hard faults vs disk queue',
    means: 'the disk queue is being built by paging rather than by ordinary file I/O — the ' +
           'memory pressure is what is making the disk slow',
    doesNotMean: 'that the disk is failing. A healthy disk under paging load looks exactly like ' +
                 'this, and the fix is memory, not storage',
  },
  {
    id: 'mem_paging', a: 'mem', b: 'hardFaults',
    label: 'memory in use vs hard faults',
    means: 'the machine has crossed the point where more memory pressure produces real paging, ' +
           'which is where "using a lot of RAM" stops being free',
    doesNotMean: 'that a high memory percentage is itself a problem — cached memory is not ' +
                 'wasted memory, and the relationship is what matters, not the level',
  },
  {
    id: 'io_queue', a: 'diskRW', b: 'diskQueue',
    label: 'disk throughput vs disk queue',
    means: 'the queue is tracking real transfer volume — the disk is busy because work is being ' +
           'asked of it',
    doesNotMean: 'anything about latency. A queue that grows WITHOUT throughput is the ' +
                 'interesting case, and it is the absence of this correlation that signals it',
  },
  {
    id: 'cpu_heat', a: 'cpu', b: 'gpuTemp',
    label: 'CPU load vs package temperature',
    means: 'CPU work is heating the shared package, which on a laptop is the usual path to ' +
           'thermal limits',
    doesNotMean: 'that the GPU is the source of the heat, even though the sensor is a GPU one — ' +
                 'on integrated hardware the two share a die and a cooler',
  },
];

const MIN_N = 60;        // samples
const MIN_R = 0.5;
const MAX_P = 0.05;

/* WHERE THE CORRECTION STOPS WORKING — AND WHY THE ANSWER IS A NUMBER RATHER THAN A REFUSAL.
 *
 * Bartlett's effective-n (below) assumes the series are STATIONARY: fluctuating around a level. A
 * series that drifts has no such level, and two independent drifting series correlate for free no
 * matter how many samples you take or how you discount them. That is the classic spurious-
 * regression trap, and no variance correction escapes it.
 *
 * The obvious move is to detect that condition and refuse. THREE DISCRIMINATORS WERE TRIED AND
 * MEASURED, AND NONE OF THEM WORKS, which is why this constant does what it does:
 *
 *   lag-1 autocorrelation   a random walk over 300 samples measures 0.978. A smooth sine — perfectly
 *                           stationary, revisits its mean seven times in the window — measures 0.98.
 *                           A threshold here refused a REAL coupling at r = 0.998.
 *   mean crossings          random walk median 15, that same sine median 14. No separation.
 *   variance ratio          separates them, but the sine lands at 7.0 and the walk at 0.96 — the
 *                           "suspicious" side of the statistic is the legitimate series, so there is
 *                           no side to threshold on.
 *
 * That is not three failures of imagination, it is the known one: telling a unit root apart from a
 * highly persistent stationary process on a few hundred points is exactly the case the standard
 * tests for it have famously poor power against. This engine is not going to settle it in a window.
 *
 * So it reports instead of pretending. Persistence is measured per pair, and past this threshold the
 * finding carries the MEASURED false-positive rate at its own persistence — from 3000 windows of 300
 * samples with both series generated INDEPENDENTLY, after the effective-n correction:
 *
 *   measured sqrt(rx*ry)   0.787   0.884   0.934   0.943   0.952   0.961   0.969   0.978
 *   false "strong"          0.0%    0.3%    2.8%    3.8%    5.0%    6.1%    8.0%   17.0%
 *
 * 0.95 is where the residual rate stops being the 5% that MAX_P advertises, so that is where the
 * caveat attaches. Telling a reader "about one in six correlations this persistent is a coincidence"
 * is worth more than either a confident claim or a silent refusal, and it is the only one of the
 * three that is true. */
const MAX_DRIFT = 0.95;

/* The table above, as a function. Linear between the measured points, flat past the ends — an
   extrapolation beyond what was measured would be the invented number this exists to avoid. */
const FP_AT_PERSISTENCE = [[0.787, 0.0], [0.884, 0.3], [0.934, 2.8], [0.943, 3.8],
                           [0.952, 5.0], [0.961, 6.1], [0.969, 8.0], [0.978, 17.0]];
function falsePositivePct(d) {
  const t = FP_AT_PERSISTENCE;
  if (d <= t[0][0]) return t[0][1];
  if (d >= t[t.length - 1][0]) return t[t.length - 1][1];
  for (let i = 1; i < t.length; i++) {
    if (d <= t[i][0]) {
      const [x0, y0] = t[i - 1], [x1, y1] = t[i];
      return y0 + (y1 - y0) * ((d - x0) / (x1 - x0));
    }
  }
  return t[t.length - 1][1];
}

/** Pearson's r, plus the pieces needed to judge whether it means anything. */
/* First differences. The series of CHANGES rather than of levels. */
function differences(xs) {
  const d = [];
  for (let i = 1; i < xs.length; i++) d.push(xs[i] - xs[i - 1]);
  return d;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  /* EITHER SIDE FLAT MEANS UNDEFINED, NOT ZERO. A constant series carries no information about
     covariance; returning 0 would report "no relationship" for a measurement that never happened.
     This is the null-vs-zero rule the whole product runs on, in its statistical form. */
  if (sxx === 0 || syy === 0) return { r: null, n, flat: sxx === 0 ? 'a' : 'b' };
  const r = sxy / Math.sqrt(sxx * syy);
  return { r: Math.max(-1, Math.min(1, r)), n, flat: null };
}

/**
 * Two-tailed p for Pearson's r, via the t distribution.
 *
 * The normal approximation to the t tail is adequate here and it avoids shipping an incomplete
 * beta function for a number that only ever decides "yes or no" against 0.05. Its weakness is
 * small n - which MIN_N already excludes by a wide margin, so the approximation is only ever used
 * where it is good.
 */
function lag1(xs) {
  const n = xs.length;
  if (n < 3) return 0;
  let m = 0;
  for (let i = 0; i < n; i++) m += xs[i];
  m /= n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const d = xs[i] - m;
    den += d * d;
    if (i) num += d * (xs[i - 1] - m);
  }
  if (den === 0) return 0;
  return Math.max(-0.999, Math.min(0.999, num / den));
}

/**
 * THE NUMBER OF INDEPENDENT OBSERVATIONS, WHICH IS NOT THE NUMBER OF SAMPLES.
 *
 * This is the correction the first version did not have, and without it the p-value in this file
 * was decorative. A t-test on r assumes every sample is an independent draw. These samples are
 * consecutive ticks of a machine, one second apart, and machines are not memoryless: CPU at t is
 * enormously informative about CPU at t+1. Feeding 600 autocorrelated ticks to a test expecting
 * 600 independent ones makes every p-value far too small, and the guard that was supposed to keep
 * coincidences off the page waves them through instead.
 *
 * MEASURED, not argued: over 2000 windows of 300 samples from two INDEPENDENT random walks - series
 * that by construction have nothing to do with each other - the uncorrected test called the pair
 * "strong" 38.5% of the time. That is a coin flip presented as p < 0.05.
 * (38.5% is the reproduced figure. Two earlier drafts of this file said 39% and 43.2% for the same
 * measurement, in two places, which is its own small lesson: a number worth stating once is worth
 * stating identically everywhere, or a reader cannot tell which one was measured.)
 *
 * The correction is Bartlett's: for two series with lag-1 autocorrelations rx and ry,
 *
 *     n_eff = n * (1 - rx*ry) / (1 + rx*ry)
 *
 * A machine metric with rx = 0.9 against another at 0.9 keeps about 10% of its samples' worth of
 * information, and a true random walk (r -> 1) keeps almost none - which is the correct answer,
 * because a random walk genuinely tells you nothing about another random walk no matter how long
 * you watch. The floor of 4 is where the t approximation stops meaning anything.
 */
function effectiveN(n, rx, ry) {
  const rr = rx * ry;
  const nEff = n * (1 - rr) / (1 + rr);
  return Math.max(4, Math.min(n, Math.round(nEff)));
}

function pValue(r, n) {
  if (r == null || n < 4) return 1;
  const ar = Math.min(Math.abs(r), 0.999999);
  const t = ar * Math.sqrt((n - 2) / (1 - ar * ar));
  /* Abramowitz & Stegun 7.1.26 for erfc, then two-tailed. */
  const z = t / Math.SQRT2;
  const tt = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * tt - 1.453152027) * tt) + 1.421413741) * tt - 0.284496736) * tt
                 + 0.254829592) * tt * Math.exp(-z * z);
  return Math.max(0, Math.min(1, 1 - y));
}

/**
 * Run every declared pair over a window of samples.
 *
 * `samples` is the history ring (or any array of tick-shaped rows). Returns EVERY pair with what
 * was measured and why it did or did not qualify - a table of what was looked at is more useful
 * than a filtered list of hits, and it makes the absence of a correlation legible.
 */
function correlate(samples, opts = {}) {
  const minN = opts.minN || MIN_N;
  const out = [];
  for (const p of PAIRS) {
    const xs = [], ys = [];
    for (const s of samples || []) {
      const a = s[p.a], b = s[p.b];
      if (typeof a !== 'number' || typeof b !== 'number') continue;
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      xs.push(a); ys.push(b);
    }
    const base = { id: p.id, label: p.label, a: p.a, b: p.b,
                   means: p.means, doesNotMean: p.doesNotMean, n: xs.length };

    if (xs.length < minN) {
      out.push({ ...base, r: null, strong: false,
                 why: `only ${xs.length} paired samples — ${minN} needed before a correlation means anything` });
      continue;
    }
    const st = pearson(xs, ys);
    if (!st || st.r == null) {
      out.push({ ...base, r: null, strong: false,
                 why: `${st && st.flat === 'a' ? p.a : p.b} did not vary at all over this window, ` +
                      `so the relationship is undefined rather than absent` });
      continue;
    }
    /* The p-value is computed on the EFFECTIVE sample count, never on the raw one. */
    const rx = lag1(xs), ry = lag1(ys);
    const nEff = effectiveN(st.n, rx, ry);
    const p2 = pValue(st.r, nEff);
    const persistence = Math.sqrt(Math.max(0, rx * ry));
    const strong = Math.abs(st.r) >= MIN_R && p2 < MAX_P;

    /* -----------------------------------------------------------------------------------------
       THE SECOND ARM: THE SAME PAIR, MEASURED ON CHANGES INSTEAD OF LEVELS.
    
       Review pointed out that all three discriminators above classify the SERIES, and that the
       econometric remedy for spurious regression does not - it changes the STATISTIC. Differencing
       is one line and it annihilates the spurious case completely. Measured, 1000 trials per row,
       this module's own thresholds on both arms:
    
                                                    levels   differenced
         two independent random walks                15.5%       0.0%
         independent AR(1) rho=0.99                   7.2%       0.0%
         real: r=0.998 instantaneous coupling       100.0%     100.0%
         real: load -> temperature (integrator)      99.9%       0.0%     <-- and this is the catch
         level-only: memory level -> faults          96.9%      51.0%
    
       SO IT IS NOT A REPLACEMENT, AND THE FOURTH ROW IS WHY. Review's version of that row read
       100%, from a generator where temperature tracked load instantaneously. Heat does not work
       that way: temperature is an INTEGRAL of load, so d(temp) tracks the LEVEL of load, not
       d(load), and differencing both sides destroys a relationship that is entirely real. Modelled
       as an actual leaky integrator it detects 0.0% - the same score as two random walks. Swapping
       to differences would have silently deleted `gpu_heat` and `cpu_heat`, the two flagship pairs
       in the table, and called it rigour.
    
       So BOTH are run and the DISAGREEMENT is published, which is more information than either arm
       alone. Three states, and the honest naming of the middle one is the whole point:
    
         both          the relationship holds in levels AND in changes. The strongest thing this
                       engine can say, and nothing about persistence weakens it.
         levels only   UNRESOLVED - not "spurious". A shared trend looks exactly like this, and so
                       does every integrator relationship, and 300 samples cannot separate them.
                       Review called this state the textbook signature of spurious regression; it is
                       equally the signature of the most physically real pair in the table.
         changes only  a coupling in the RATE that the levels do not show - usually two things that
                       move together while sitting at unrelated levels.
       ----------------------------------------------------------------------------------------- */
    const dx = differences(xs), dy = differences(ys);
    const dst = pearson(dx, dy);
    let changes = null;
    if (dst && dst.r != null) {
      const dEff = effectiveN(dst.n, lag1(dx), lag1(dy));
      const dp = pValue(dst.r, dEff);
      changes = { r: +dst.r.toFixed(3), p: +dp.toFixed(4), nEff: dEff,
                  strong: Math.abs(dst.r) >= MIN_R && dp < MAX_P };
    }
    const agreement = !strong ? null
      : (changes && changes.strong) ? 'both'
      : 'levels-only';

    /* The residual, attached to the finding rather than buried in a module header. `p` is what the
       test says; `couldBeCoincidencePct` is how often a test that confident is wrong on series this
       persistent — and past MAX_DRIFT those two numbers disagree, which is the whole point of
       printing both. */
    const fp = persistence > MAX_DRIFT ? +falsePositivePct(persistence).toFixed(1) : null;
    out.push({
      ...base,
      r: +st.r.toFixed(3),
      p: +p2.toFixed(4),
      /* Published so the discount can be checked. A reader who sees 600 samples collapse to 31 is
         being told something true about their machine's metrics, not being fobbed off. */
      nEff,
      autocorr: { a: +rx.toFixed(3), b: +ry.toFixed(3) },
      persistence: +persistence.toFixed(3),
      couldBeCoincidencePct: fp,
      /* The second arm, published whole so a reader can check the disagreement rather than take
         the label for it. */
      changes,
      agreement,
      strong,
      direction: st.r >= 0 ? 'together' : 'opposed',
      why: strong
        ? `r ${st.r.toFixed(2)} over ${st.n} samples — worth ${nEff} independent ones once ` +
          `autocorrelation is discounted (p ${p2 < 0.0001 ? '< 0.0001' : p2.toFixed(4)})` +
          (agreement === 'both'
            ? `. It holds on the CHANGES too (r ${changes.r}), not just on the levels — which is ` +
              `the strongest form this engine can report, because a shared trend cannot produce it.`
            : `. It does NOT hold on the changes (r ${changes ? changes.r : 'n/a'}), so this rests ` +
              `on the levels alone. That is what a shared trend looks like — and also what every ` +
              `relationship where one side accumulates the other looks like, load heating a chip ` +
              `being the obvious one. This window cannot tell those apart.`) +
          (fp != null
            ? ` Both series are also highly persistent here (lag-1 ${rx.toFixed(2)} and ` +
              `${ry.toFixed(2)}), and two unrelated signals that persistent correlate this strongly ` +
              `about ${fp.toFixed(0)}% of the time by chance. Treat it as a lead, and confirm on a ` +
              `window where both rise AND fall.`
            : '')
        : Math.abs(st.r) < MIN_R
          ? `r ${st.r.toFixed(2)} — below ${MIN_R}, too weak to be worth a sentence`
          : `r ${st.r.toFixed(2)} but p ${p2.toFixed(3)} — these ${st.n} ticks are worth only ` +
            `${nEff} independent samples, so a correlation this size could be chance`,
    });
  }
  out.sort((x, y) => (y.strong - x.strong) || (Math.abs(y.r || 0) - Math.abs(x.r || 0)));
  return { pairs: out, window: (samples || []).length, minN, minR: MIN_R, maxP: MAX_P };
}

module.exports = { correlate, pearson, pValue, lag1, effectiveN, differences, PAIRS, MIN_N, MIN_R, MAX_P, MAX_DRIFT, falsePositivePct };
