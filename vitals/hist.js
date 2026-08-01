/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - MERGEABLE HISTOGRAMS.  (A2, MARKET_RESEARCH §8.2 + §9)
 *
 * WHY THIS EXISTS, IN ONE SENTENCE: p50 and p95 are not recoverable from a stored mean, and every
 * question worth asking about a slow machine is a question about the tail.
 *
 * The rollup format this replaces stored [min, avg, max] per metric per minute. That is enough to
 * draw a chart and not enough to answer "is this slower than usual" - because the mean is exactly
 * the statistic that hides a stutter. A minute that ran at 8ms with four 300ms hitches has the same
 * mean as a minute that ran evenly at 12ms, and only one of them is the complaint.
 *
 * -------------------------------------------------------------------------------------------
 * THE PROPERTY THAT MAKES THIS WORK: HISTOGRAMS MERGE, MEANS DO NOT.
 *
 * An hour's histogram is the sum of its sixty minutes, EXACTLY - add the bin counts. A day is the
 * sum of 1440. So one stored resolution answers every zoom level without storing every zoom level,
 * which is the whole of "store by scale, not by sample" and the thing B1's log-time axis rides on.
 *
 * You cannot do this with means. Averaging sixty means gives you an hour's mean only if every
 * minute had the same sample count, and the collector's rate drifts 0.32-1.03 Hz, so it never does.
 * You cannot do it with p95s either: the median of medians is not the median.
 * -------------------------------------------------------------------------------------------
 *
 * THE BIN SCHEME, AND WHY RELATIVE ERROR IS THE HONEST ONE.
 *
 * Bins are logarithmic with a fixed RELATIVE error (the DDSketch construction): bin index for a
 * value v is ceil(log_gamma(v)), with gamma = (1+A)/(1-A). Every value in bin i is within A of
 * every other, so any quantile read back is within A of the true one - a bound that HOLDS, and can
 * therefore be printed next to the number instead of hoped for.
 *
 * Relative rather than absolute because these metrics span decades and a fixed-width bin cannot
 * serve both ends. This machine's own rollups carry hard-fault rates from 0 to 618/s in the same
 * column; 5-unit bins would be 124 bins of mostly nothing and would still round 0.4 to 0. Relative
 * error says "p95 hard faults = 618 +/- 12" and "p95 cpu = 24% +/- 0.5%", both of which are true
 * statements and neither of which a linear scheme gives you.
 *
 * WHAT IT REFUSES TO DO. It does not interpolate inside a bin to make the answer look precise, and
 * it does not report a quantile from a bucket that never saw a sample. min and max are carried
 * EXACTLY alongside the bins, because the extremes are the one thing a histogram genuinely blurs
 * and they are cheap to keep. The sum is carried too, so the mean stays exact and the old
 * [min, avg, max] readers can still be served from the new record.
 */

/* 2% relative error. Chosen, not guessed: at 2% a p95 CPU of 24% is +/- 0.5 points and a p95 frame
   time of 16.7 ms is +/- 0.33 ms - both below the threshold at which a human could act differently
   on the number. Tightening to 1% roughly doubles the occupied bins for no decision that changes.
   The suite MEASURES the realised error against raw samples rather than trusting this comment. */
const ALPHA = 0.02;
const GAMMA = (1 + ALPHA) / (1 - ALPHA);
const LOG_GAMMA = Math.log(GAMMA);

/* Below this a value is counted as a zero rather than given a bin. Necessary because log(0) is
   -Infinity, and honest because these metrics are rates and percentages where "0.0001 MB/s" and
   "nothing happened" are the same event. It also bounds the index range: without a floor, one
   denormal reading would open thousands of empty bins beneath everything else. */
const MIN_VALUE = 1e-3;

function binOf(v) {
  return Math.ceil(Math.log(v) / LOG_GAMMA);
}

/* The representative value for a bin: its geometric midpoint, which is the point that minimises the
   worst-case relative error across the bin rather than favouring either edge. */
function valueOf(i) {
  return (2 * Math.pow(GAMMA, i)) / (GAMMA + 1);
}

class Hist {
  constructor() {
    this.bins = new Map();   // bin index -> count
    this.zero = 0;           // values below MIN_VALUE, counted exactly
    this.n = 0;
    this.sum = 0;
    this.min = null;
    this.max = null;
  }

  add(v, count = 1) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return this;   // never invent a sample
    this.n += count;
    this.sum += v * count;
    if (this.min === null || v < this.min) this.min = v;
    if (this.max === null || v > this.max) this.max = v;
    /* Negative values do not occur in any metric this stores (rates, percentages, counts) and a
       log scheme cannot represent them. Counting them as zero would be a silent lie, so they go to
       the zero bucket only if they are within the noise floor; anything genuinely negative would be
       a collector defect and is left to show up as a min below zero, which it will. */
    if (v < MIN_VALUE) this.zero += count;
    else {
      const i = binOf(v);
      this.bins.set(i, (this.bins.get(i) || 0) + count);
    }
    return this;
  }

  /** Exact merge. This is the operation the whole design exists for. */
  merge(other) {
    if (!other || !other.n) return this;
    this.n += other.n;
    this.sum += other.sum;
    this.zero += other.zero;
    if (other.min !== null && (this.min === null || other.min < this.min)) this.min = other.min;
    if (other.max !== null && (this.max === null || other.max > this.max)) this.max = other.max;
    for (const [i, c] of other.bins) this.bins.set(i, (this.bins.get(i) || 0) + c);
    return this;
  }

  get avg() { return this.n ? this.sum / this.n : null; }

  /**
   * Quantile in [0,1]. Returns null on an empty histogram rather than 0 - "nothing was recorded"
   * and "it was zero" are different answers and only one of them is a measurement.
   *
   * p0 and p100 return the EXACT min and max rather than a bin midpoint. The extremes are carried
   * exactly, so reporting a rounded one would be throwing away a better number that is right there.
   */
  quantile(q) {
    if (!this.n) return null;
    if (q <= 0) return this.min;
    if (q >= 1) return this.max;
    /* Rank of the wanted sample. floor(q*n) with a 0-based walk puts p50 of [1,2,3,4] at 3, the
       upper of the two middles - consistent with the "nearest rank" definition, and stated here
       because quantile conventions differ and a chart that disagrees with a test is usually this. */
    let rank = Math.floor(q * this.n);
    if (rank >= this.n) rank = this.n - 1;

    if (rank < this.zero) return 0;
    let seen = this.zero;
    const idx = [...this.bins.keys()].sort((a, b) => a - b);
    for (const i of idx) {
      seen += this.bins.get(i);
      if (rank < seen) {
        /* Clamp the bin's representative value into the observed range. A geometric midpoint can
           sit slightly outside [min,max] when a bucket holds one sample, and reporting a p95 above
           the largest value ever seen is the kind of small lie that erodes trust in the big ones. */
        const v = valueOf(i);
        return Math.min(this.max, Math.max(this.min, v));
      }
    }
    return this.max;
  }

  /**
   * REPRESENTATIVE SAMPLES: each bin's value, repeated by its count.
   *
   * For answering "what fraction of samples satisfied this predicate" when the samples themselves
   * are long gone. Because a bin is a fixed relative width, only samples within that width of the
   * predicate's threshold can land on the wrong side, so the fraction inherits the same bound the
   * quantiles carry.
   *
   * It lives here rather than in the caller because it is the bin scheme's own arithmetic, and a
   * second copy of GAMMA somewhere else is a second copy that can be changed alone.
   *
   * These are NOT the original samples and must never be presented as them: order is lost, and
   * values are the bin's representative rather than what was measured.
   */
  expand() {
    const out = [];
    for (let k = 0; k < this.zero; k++) out.push(0);
    for (const i of [...this.bins.keys()].sort((a, b) => a - b)) {
      const v = Math.min(this.max, Math.max(this.min, valueOf(i)));
      const c = this.bins.get(i);
      for (let k = 0; k < c; k++) out.push(v);
    }
    return out;
  }

  /** Fraction of samples satisfying a single-value predicate, from the bins. */
  fraction(pred) {
    if (!this.n) return null;
    const vals = this.expand();
    return vals.filter((v) => pred(v)).length / vals.length;
  }

  /** Convenience: several quantiles in one walk of the bins. */
  quantiles(qs) {
    const out = {};
    for (const q of qs) out[String(q)] = this.quantile(q);
    return out;
  }

  /**
   * ENCODE, choosing the smaller of two layouts and saying which.
   *
   *   [min, max, n, sum, zero, mode, payload]
   *     mode 0 - DENSE: payload = [firstBinIndex, c0, c1, ...] including interior zeros.
   *     mode 1 - SPARSE: payload = [i0, c0, i1, c1, ...].
   *
   * Both are needed and the choice is data-dependent, which is why it is measured per record rather
   * than decided once. A quiet minute of CPU occupies three adjacent bins and is tiny dense. A
   * minute of hard faults spanning 0 to 618/s touches maybe eight bins spread across two hundred
   * indices, where dense would store 200 numbers to carry 8. Picking the smaller costs one
   * comparison and removes the need to guess which case is typical.
   */
  encode() {
    const idx = [...this.bins.keys()].sort((a, b) => a - b);
    const head = [
      this.min === null ? null : round(this.min),
      this.max === null ? null : round(this.max),
      this.n,
      round(this.sum),
      this.zero,
    ];
    if (!idx.length) return [...head, 1, []];

    const lo = idx[0], hi = idx[idx.length - 1];
    const denseLen = hi - lo + 2;          // the offset plus one count per bin in the span
    const sparseLen = idx.length * 2;
    if (denseLen <= sparseLen) {
      const counts = new Array(hi - lo + 1).fill(0);
      for (const i of idx) counts[i - lo] = this.bins.get(i);
      return [...head, 0, [lo, ...counts]];
    }
    const pairs = [];
    for (const i of idx) { pairs.push(i, this.bins.get(i)); }
    return [...head, 1, pairs];
  }

  static decode(a) {
    const h = new Hist();
    if (!Array.isArray(a) || a.length < 7) return h;
    h.min = a[0]; h.max = a[1]; h.n = a[2] || 0; h.sum = a[3] || 0; h.zero = a[4] || 0;
    const mode = a[5], p = a[6] || [];
    if (mode === 0) {
      const lo = p[0];
      for (let k = 1; k < p.length; k++) if (p[k]) h.bins.set(lo + k - 1, p[k]);
    } else {
      for (let k = 0; k + 1 < p.length; k += 2) if (p[k + 1]) h.bins.set(p[k], p[k + 1]);
    }
    return h;
  }

  /** The old [min, avg, max] triple, so a v1 reader can still be served from a v2 record. */
  triple() {
    if (!this.n) return null;
    return [round(this.min), round(this.avg), round(this.max)];
  }
}

/* Two decimals everywhere, matching what the v1 rollups already stored. The bins carry the
   precision that matters; the head numbers are for display and for the compatibility triple. */
function round(v) {
  return v == null ? null : +v.toFixed(2);
}

/** Merge many encoded records without decoding each into a full object first. */
function mergeEncoded(list) {
  const out = new Hist();
  for (const a of list) if (a) out.merge(Hist.decode(a));
  return out;
}

module.exports = { Hist, mergeEncoded, ALPHA, GAMMA, MIN_VALUE, _binOf: binOf, _valueOf: valueOf };
