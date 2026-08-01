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
 *
 * All four have to pass. Anything that fails is reported as measured-and-rejected rather than
 * omitted, because "we looked and found nothing" is a useful answer and an absence is not.
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

/** Pearson's r, plus the pieces needed to judge whether it means anything. */
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
    const p2 = pValue(st.r, st.n);
    const strong = Math.abs(st.r) >= MIN_R && p2 < MAX_P;
    out.push({
      ...base,
      r: +st.r.toFixed(3),
      p: +p2.toFixed(4),
      strong,
      direction: st.r >= 0 ? 'together' : 'opposed',
      why: strong
        ? `r ${st.r.toFixed(2)} over ${st.n} samples (p ${p2 < 0.0001 ? '< 0.0001' : p2.toFixed(4)})`
        : Math.abs(st.r) < MIN_R
          ? `r ${st.r.toFixed(2)} — below ${MIN_R}, too weak to be worth a sentence`
          : `r ${st.r.toFixed(2)} but p ${p2.toFixed(3)} — could be chance at this sample count`,
    });
  }
  out.sort((x, y) => (y.strong - x.strong) || (Math.abs(y.r || 0) - Math.abs(x.r || 0)));
  return { pairs: out, window: (samples || []).length, minN, minR: MIN_R, maxP: MAX_P };
}

module.exports = { correlate, pearson, pValue, PAIRS, MIN_N, MIN_R, MAX_P };
