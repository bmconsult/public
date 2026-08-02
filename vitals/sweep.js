/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - SETTINGS AS EXPERIMENTS, WITH RECEIPTS.  (B9, MARKET_RESEARCH §9)
 *
 * Do not SET a value. SWEEP it, measure where it degrades on THIS machine, and route by the
 * measured boundary.
 *
 * Every dial in this product currently ships with a number somebody chose. That number was right on
 * one machine, once, and it is presented everywhere with the same confidence. The honest version is
 * to try the values and keep the receipt - which is also the only way to answer "does this setting
 * even do anything here", and on most machines, for most settings, the true answer is NO.
 *
 * ---------------------------------------------------------------------------------------------
 * THE MEASUREMENT PROBLEM, WHICH IS THE WHOLE DIFFICULTY.
 *
 * The measured noise floor on this machine is about +/-1% CPU. Most single settings are worth about
 * the same. So a naive sweep - set A, measure, set B, measure - is measuring the weather. Three
 * things make it a measurement instead:
 *
 *   1. INTERLEAVING. Values are visited round-robin (A B C A B C ...), never in blocks. A machine
 *      drifts over minutes: something starts indexing, a browser tab wakes up. Under blocked
 *      ordering that drift lands entirely on whichever value was being tested at the time and is
 *      reported as the setting's effect. Interleaving spreads drift across every arm equally,
 *      which is the difference between an experiment and a coincidence.
 *
 *   2. MEDIANS, NOT MEANS. One spike during one sample would otherwise move an arm's score by more
 *      than the effect being looked for.
 *
 *   3. A VERDICT ONLY WHEN THE EFFECT EXCEEDS THE NOISE. The within-arm spread IS the noise floor,
 *      measured during this very sweep rather than assumed from a comment. If the gap between the
 *      best and worst arm does not clear it, the honest output is "indistinguishable here", and
 *      that is a real result rather than a failure to find one.
 * ---------------------------------------------------------------------------------------------
 */

const MIN_ROUNDS = 5;

/* EXPECTED RANGE OF k SAMPLES, in units of their standard deviation (the d2 constant from control
   charts). Comparing the BEST arm against the WORST is a multiple-comparison problem, and this is
   the correction for it: with more arms you get more chances at an extreme, so the same underlying
   noise produces a wider best-to-worst gap for free.
   Omitting this is what made the first version hallucinate — 3 of 25 sweeps over IDENTICAL arms
   named a confident winner, a 12% false-positive rate, because a fixed multiple of the noise was
   being asked to do a job that depends on how many arms there are. */
const D2 = { 2: 1.128, 3: 1.693, 4: 2.059, 5: 2.326, 6: 2.534, 7: 2.704, 8: 2.847, 9: 2.970, 10: 3.078 };
function rangeFactor(k) { return D2[Math.min(10, Math.max(2, k))] || 3.1; }

/* CHOSEN BY MEASUREMENT, and the measurement is worth keeping because it also states the limits of
   the whole feature. Calibrated over 600-800 simulated sweeps per cell, noise amplitude +/-2:

     SAFETY   false positive (k=2)   detects an effect of...  1x noise   2x noise
       1.5           37%                                          87%       ~99%
       2.5           17%                                          67%
       3.5            7%                                          44%
       5.0            4%                                          23%        75%
       6.5            2%                                          12%

   5.0 is where a false positive stops being routine. The bias is deliberate: on a settings page,
   telling somebody a dial matters when it does not is worse than failing to notice a small effect -
   an unfounded number is exactly what this feature exists to stop shipping.

   THE HONEST CONSEQUENCE, which the receipt states rather than hides: an effect the size of the
   noise is NOT reliably detectable in seven rounds, and no amount of confident wording would change
   that. More rounds is the only remedy, and it works - measured at SAFETY 5.0, an effect of twice
   the noise is detected 68% of the time at 5 rounds, 92% at 11, and 100% at 15, while the false
   positive rate falls from 5% to 0% over the same range. */
const SAFETY = 5.0;

/** Median of a numeric array, or null. */
function median(xs) {
  const s = xs.filter((v) => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor((s.length - 1) / 2);
  return s.length % 2 ? s[m] : (s[m] + s[m + 1]) / 2;
}

/** Median absolute deviation, scaled to be comparable with a standard deviation. */
function mad(xs) {
  const m = median(xs);
  if (m === null) return null;
  const d = xs.filter((v) => typeof v === 'number' && isFinite(v)).map((v) => Math.abs(v - m));
  const md = median(d);
  return md === null ? null : md * 1.4826;
}

class Sweep {
  /**
   * @param opts.apply   async (value) => void        — put the machine in that state
   * @param opts.measure async (value) => number      — one sample of the cost
   * @param opts.settleMs                             — how long to wait after applying, before measuring
   * @param opts.lowerIsBetter                        — default true (cost), false for a score
   */
  constructor(opts = {}) {
    this.apply = opts.apply;
    this.measure = opts.measure;
    this.settleMs = opts.settleMs != null ? opts.settleMs : 1500;
    this.lowerIsBetter = opts.lowerIsBetter !== false;
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.running = false;
    this.abort = false;
    this.progress = null;
    this.last = null;
  }

  stop() { this.abort = true; }

  /**
   * Run the sweep.
   *
   * @param name   what is being swept, for the receipt
   * @param values the arms
   * @param rounds how many times each arm is visited
   */
  async run(name, values, rounds = 7) {
    if (this.running) return { ok: false, error: 'a sweep is already running' };
    if (!Array.isArray(values) || values.length < 2) {
      return { ok: false, error: 'a sweep needs at least two values to compare' };
    }
    if (rounds < MIN_ROUNDS) {
      /* Refused rather than quietly raised: a caller asking for three rounds has a belief about how
         noisy this is, and it is wrong in a way worth saying out loud. */
      return { ok: false, error: `${rounds} rounds cannot clear the noise floor — ${MIN_ROUNDS} is the minimum` };
    }

    this.running = true; this.abort = false;
    const samples = new Map(values.map((v) => [String(v), []]));
    const order = [];
    const startedAt = Date.now();

    try {
      for (let r = 0; r < rounds && !this.abort; r++) {
        /* INTERLEAVED, and the order within each round is ROTATED so no arm is permanently the one
           measured immediately after a settle. Position in the round is itself a confound. */
        const arms = values.slice(r % values.length).concat(values.slice(0, r % values.length));
        for (const v of arms) {
          if (this.abort) break;
          this.progress = { name, round: r + 1, rounds, value: v };
          await this.apply(v);
          await this.sleep(this.settleMs);
          const s = await this.measure(v);
          if (typeof s === 'number' && isFinite(s)) {
            samples.get(String(v)).push(s);
            order.push({ r, v, s });
          }
        }
      }
    } finally {
      this.running = false;
      this.progress = null;
    }

    const arms = values.map((v) => {
      const xs = samples.get(String(v));
      return { value: v, n: xs.length, median: median(xs), spread: mad(xs), samples: xs.slice() };
    }).filter((a) => a.median !== null);

    if (arms.length < 2) {
      return { ok: false, error: 'not enough samples survived to compare anything', arms };
    }

    /* THE NOISE FLOOR, MEASURED DURING THIS SWEEP. The typical within-arm spread is what the
       machine was doing to us while we were not changing anything, so it is the bar any claimed
       effect has to clear. Taken from the arms themselves rather than from a constant, because it
       differs by machine and by minute. */
    const noise = median(arms.map((a) => a.spread).filter((v) => v != null)) || 0;

    const sorted = [...arms].sort((a, b) => this.lowerIsBetter ? a.median - b.median : b.median - a.median);
    const best = sorted[0], worst = sorted[sorted.length - 1];
    const effect = Math.abs(worst.median - best.median);

    /* THE BAR. Three corrections, and each one earns its place:
         - /sqrt(n)  a MEDIAN of n samples is far more stable than one sample; comparing the gap
                     against raw sample spread would demand an effect many times larger than the
                     measurement can actually resolve, and would reject real findings.
         - x1.253    the standard error of a median is wider than that of a mean by this factor.
         - xd2(k)    comparing best-against-worst of k arms is a multiple comparison. More arms,
                     more chances at an extreme, and the same noise yields a bigger gap for free.
       Without the last one the sweep hallucinated a winner in 12% of pure-noise runs. */
    const nPerArm = Math.max(1, Math.min(...arms.map((a) => a.n)));
    const seMedian = (noise / Math.sqrt(nPerArm)) * 1.253;
    const bar = noise > 0 ? seMedian * rangeFactor(arms.length) * SAFETY : null;

    /* ---------------------------------------------------------------------------------------
       A MEASURED SPREAD OF ZERO MEANS THE INSTRUMENT IS QUANTIZED, NOT THAT THE MACHINE IS QUIET.

       The first version read `noise > 0 ? effect >= bar : effect > 0`, so a zero spread produced a
       bar of 0.00 and ANY gap at all won. That was not the rare corner it was written as. The
       production measurement here is a median frame interval, and frames arrive on vsync, so
       samples land on 16.7 ms steps; in 300 of 300 trial sweeps more than half of them shared a
       step and the MAD came out exactly zero. The branch with no bar in it was the only branch that
       ever ran.

       The fix is not to invent a floor. A magnitude test needs a spread, and there isn't one - but
       there is still real evidence in the data, and it is of a different KIND: whether the arms
       SEPARATE. If nine of nine samples on one arm all read better than nine of nine on the other,
       that is strong evidence however coarse the steps are, and no estimated noise floor is needed
       to say so.

       So the test becomes exact and combinatorial. Under the null the two arms are exchangeable, so
       the chance that one arm's samples all fall on one side of the other's is 2/C(2n,n) - and with
       k arms there are C(k,2) pairs that could have produced it. That product is a real p-value,
       published rather than compared against a constant, and required below 1%.

       FALSE POSITIVES, 300+ sweeps per cell, both arms drawn from ONE distribution and rounded onto
       a 16.7 ms grid. This half is amplitude-independent, because it is combinatorial:

           5 rounds, 2 arms    0.7%      (the design ceiling: 2/C(10,5) = 0.79%, just under the bar)
           7 rounds, 2 arms    0.0%
           9 rounds, 2/3/5     0.0%
          15 rounds, 2 arms    0.0%

       The spread measured zero in 100% of those sweeps, which is the finding that made this branch
       matter: it is not a corner case, it is the normal case for this instrument.

       POWER IS A DIFFERENT STORY AND DEPENDS ENTIRELY ON THE NOISE AMPLITUDE - which the first
       version of this table did not say, quoting a single column beside the amplitude-independent
       one as though both were properties of the design. Review caught it. 400 trials per cell,
       9 rounds, 2 arms, noise uniform on +/-sigma:

           sigma      1 step (16.7 ms)   2 steps (33.3 ms)   3 steps (50 ms)
            1 ms           100%               100%               100%
            2 ms             7%               100%               100%
            4 ms             2%               100%               100%
            8 ms             2%               100%               100%
           16 ms             1%                92%               100%

       Read the first column, not the last. A one-step effect is detectable ONLY when the machine is
       quieter than the grid it is being measured on; past sigma = 2 ms it is gone, and no number of
       rounds recovers it, because complete separation cannot happen when the arms overlap on the
       same step. Two steps is reliable across every amplitude tested. That blind spot is a fact
       about the instrument rather than a finding about the setting, and the verdict says so instead
       of reporting a clean "no difference" the reader would bank.
       --------------------------------------------------------------------------------------- */
    let separation = null;
    if (!(noise > 0)) {
      const lo = this.lowerIsBetter ? best : worst, hi = this.lowerIsBetter ? worst : best;
      const complete = Math.max(...lo.samples) < Math.min(...hi.samples);
      /* log-space, because C(2n,n) overflows a double well before n gets interesting. */
      const lnFact = (m) => { let s = 0; for (let i = 2; i <= m; i++) s += Math.log(i); return s; };
      const lnC = (a, b) => lnFact(a) - lnFact(b) - lnFact(a - b);
      const pPair = Math.exp(Math.log(2) + lnC(2 * nPerArm, nPerArm) * -1);
      const pairs = (arms.length * (arms.length - 1)) / 2;
      separation = { complete, p: +Math.min(1, pPair * pairs).toFixed(5), nPerArm, pairs };
    }

    const distinguishable = noise > 0
      ? effect >= bar
      : (separation.complete && separation.p <= 0.01);

    const receipt = {
      ok: true,
      name,
      startedAt, endedAt: Date.now(),
      rounds, values,
      arms: arms.map((a) => ({ value: a.value, n: a.n,
                               median: +a.median.toFixed(3),
                               spread: a.spread != null ? +a.spread.toFixed(3) : null })),
      noiseFloor: +noise.toFixed(3),
      /* WHICH TEST RAN, named rather than left to be inferred from which fields are null. The two
         are different kinds of evidence and a reader is entitled to know which one they hold. */
      testedBy: noise > 0 ? 'magnitude against the measured noise floor'
                          : 'complete separation — the spread measured zero, so the instrument is ' +
                            'quantized and a magnitude test has nothing to stand on',
      bar: bar != null ? +bar.toFixed(3) : null,
      separation,
      effect: +effect.toFixed(3),
      distinguishable,
      aborted: this.abort,
      /* The sentence a person reads. It has to be able to say "no difference", because that is the
         most common true answer and the one a settings page never gives you. */
      verdict: noise > 0
        ? (!distinguishable
          ? `No measurable difference on this machine. Best and worst differed by ${effect.toFixed(2)}, ` +
            `and ${arms.length} arms at this noise level would produce a gap of ${bar.toFixed(2)} by ` +
            `chance alone — so anything in this range is a matter of taste rather than of cost. ` +
            `An effect around the size of the noise needs more rounds than ${rounds} to show up at all.`
          : `${JSON.stringify(best.value)} measured best at ${best.median.toFixed(2)}, against ` +
            `${worst.median.toFixed(2)} for ${JSON.stringify(worst.value)} — a gap of ${effect.toFixed(2)}, ` +
            `against a chance-alone bar of ${bar.toFixed(2)} for ${arms.length} arms at this noise level.`)
        : (!distinguishable
          ? `No measurable difference on this machine. Every arm's samples came out on the same few ` +
            `values — the measurement is too coarse here to show a spread, so the only thing that ` +
            `would count as evidence is one arm landing entirely clear of another, and none did. ` +
            `A real but small difference would look exactly like this, which is a limit of the ` +
            `instrument rather than a finding about the setting.`
          : `${JSON.stringify(best.value)} measured best at ${best.median.toFixed(2)}, against ` +
            `${worst.median.toFixed(2)} for ${JSON.stringify(worst.value)}. The measurement is too ` +
            `coarse to show a spread, so this rests on separation instead: all ${separation.nPerArm} ` +
            `samples of one landed clear of all ${separation.nPerArm} of the other, which happens by ` +
            `chance about ${(separation.p * 100).toFixed(2)}% of the time across ${separation.pairs} ` +
            `pair${separation.pairs === 1 ? '' : 's'} of arms.`),
      best: distinguishable ? best.value : null,
      /* The raw order is kept so a reader can see the interleaving actually happened and check for
         drift themselves. A receipt you cannot audit is a claim. */
      trace: order,
    };
    this.last = receipt;
    return receipt;
  }

  status() {
    return { running: this.running, progress: this.progress,
             last: this.last ? { name: this.last.name, verdict: this.last.verdict,
                                 distinguishable: this.last.distinguishable,
                                 endedAt: this.last.endedAt } : null };
  }
}

module.exports = { Sweep, median, mad, MIN_ROUNDS, rangeFactor, SAFETY };
