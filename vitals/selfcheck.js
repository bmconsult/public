/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - THE SELF-VERIFYING COLLECTOR.
 *
 * Every number this product shows comes from one reading of one API. That reading is trusted
 * because it has been cross-checked by a human, once, on one machine - and then shipped to
 * machines nobody has ever seen, where a locale, a driver, a kernel version or a virtualisation
 * layer can change what the same call returns. `caps.js` handles the case where a host CANNOT
 * answer. Nothing handles the case where it answers WRONGLY.
 *
 * So: read a second, INDEPENDENT source on a duty cycle and publish how well the two agree.
 *
 * ---------------------------------------------------------------------------------------------
 * THE ONE THING THIS MUST NOT CLAIM.
 *
 * This is NOT an error bar, and the difference is the whole point. An error bar needs ground
 * truth. Two independent methods disagreeing tells you something is wrong; it does not tell you
 * WHICH ONE is wrong, and a monitor that reported "our error is 4%" would be inventing the very
 * kind of confident number this project exists to refuse.
 *
 * What it can honestly say is AGREEMENT: two paths into the kernel, read at the same moment,
 * differed by this much. Agreement is evidence that both are working. Divergence is evidence that
 * one of them is not, and a prompt to find out which - not a verdict about either.
 * ---------------------------------------------------------------------------------------------
 *
 * INDEPENDENCE IS THE ENTIRE VALUE, AND IT IS NOT UNIFORM.
 *
 * "A collector agreeing with itself proves nothing" is already the rule the live suites are built
 * on. It applies here with teeth: comparing /proc/meminfo against a second read of /proc/meminfo
 * measures nothing but the clock. Node's `os` module is useful here precisely because libuv reaches
 * the kernel by a DIFFERENT route than this collector does on every platform:
 *
 *   memory   collector: PerformanceCounter (win) · /proc/meminfo (linux) · vm_stat (darwin)
 *            reference: os.freemem() -> GlobalMemoryStatusEx · sysinfo(2) · host_statistics64
 *            INDEPENDENT on all three.
 *
 *   cpu      collector: PerformanceCounter (win) · /proc/stat (linux) · iostat stream (darwin)
 *            reference: os.cpus() differenced -> NtQuerySystemInformation · /proc/stat · host_processor_info
 *            INDEPENDENT on win and darwin. NOT on linux - libuv parses the same /proc/stat this
 *            collector does, so the comparison there is a formatting check at best. It is declared
 *            dependent and excluded rather than quietly counted, because a comparison that cannot
 *            fail is worse than no comparison: it manufactures confidence.
 *
 * COST. The references are one syscall each; the duty cycle exists so the honest answer to "what
 * does this cost" stays "nothing you can measure", and so the cadence can be stated on the page
 * rather than implied. The FOOTPRINT page already charges VITALS for its own CPU - this rides that
 * same argument: an instrument that cannot audit itself is asking for trust it has not earned.
 */

const os = require('os');

/* Per-metric declaration of what is being compared and whether the comparison MEANS anything on
   this platform. `independent:false` entries are still described - the page says why they are not
   run, which is more useful than their silent absence. */
const REFS = {
  memAvailMB: {
    label: 'memory available',
    unit: 'MB',
    method: {
      win32: 'PerformanceCounter “Memory\\Available MBytes” vs GlobalMemoryStatusEx (via os.freemem)',
      linux: '/proc/meminfo MemAvailable vs sysinfo(2) (via os.freemem)',
      darwin: 'vm_stat page arithmetic vs host_statistics64 (via os.freemem)',
    },
    independent: { win32: true, linux: true, darwin: true },
    /* THE COMPARISON IS PER-PLATFORM, BECAUSE freemem() IS NOT ONE QUANTITY.
     *
     * The first cut treated os.freemem() as FREE PAGES everywhere, and compared it as a bound:
     * available counts free plus reclaimable cache, so available can never be the smaller number.
     * That is true on linux (sysinfo.freeram) and darwin (host_statistics64 free_count).
     *
     * It is FALSE on Windows. GlobalMemoryStatusEx.ullAvailPhys already includes the standby list,
     * so it is the SAME quantity the collector reports - and a bound between two readings of one
     * quantity, taken a moment apart, is not an invariant, it is a coin toss. Measured on this
     * machine, 45 samples: the difference was signed -85..+91 MB and fell below "free" 21 times
     * out of 45. The check was reporting a defect at almost exactly the rate chance predicts.
     *
     * So win32 differences the two, with the band set by that measurement (|delta| median 12 MB,
     * p95 85, max 91). 200 MB sits far above the noise and far below anything structural: a path
     * reading the wrong quantity on a 16 GB host is wrong by thousands of MB, not by ninety. */
    compare: { win32: 'delta', linux: 'bound', darwin: 'bound' },
    medianTolerance: { win32: 200 },
    measured: 'win32: |delta| median 12 · p95 85 · max 91 MB (45 samples, this machine). ' +
              'linux/darwin: a true bound, available ⊇ free.',
  },
  cpuPct: {
    label: 'cpu total',
    unit: '%',
    method: {
      win32: 'PerformanceCounter “% Processor Time” vs NtQuerySystemInformation (via os.cpus)',
      linux: '/proc/stat vs /proc/stat — libuv reads the same file',
      darwin: 'iostat stream vs host_processor_info (via os.cpus)',
    },
    independent: { win32: true, linux: false, darwin: true },
    compare: 'delta',
    /* JUDGED ON THE MEDIAN, WITH THE TOLERANCE TAKEN FROM MEASUREMENT.
       The first cut compared each sample against a 12-point threshold picked from intuition. Then
       the spread was actually measured on this machine, 40 samples while it was thrashing:
       median 3.8 · p75 8.4 · p90 17.7 · p95 22.2 · max 34.0.
       A per-sample threshold of 12 would therefore have flagged about a quarter of all samples as
       disagreements when nothing was wrong - two interval averages over slightly offset windows
       simply differ, and the tail is wide on a busy host. That is D5's bad invariant: a check that
       fires on noise proves nothing when it fires and nothing when it does not.
       The median is the statistic that survives. A path that has come loose - a counter reading the
       wrong CPU set, a stream that stalled and is repeating its last value - moves the MEDIAN, and
       moves it a long way. Noise moves only the tail. 15 sits far above the measured median and far
       below anything structural. The tail is still reported, as spread, because it is real. */
    medianTolerance: 15,
    measured: 'median 3.8 · p95 22.2 (40 samples, this machine, under load)',
  },
  uptimeSec: {
    label: 'uptime',
    unit: 's',
    method: {
      win32: 'collector uptime vs GetTickCount64 (via os.uptime)',
      linux: 'collector uptime vs /proc/uptime (via os.uptime)',
      darwin: 'collector uptime vs sysctl kern.boottime (via os.uptime)',
    },
    /* Linux libuv reads /proc/uptime, which is where the collector gets it too. Declared. */
    independent: { win32: true, linux: false, darwin: true },
    compare: 'delta',
    /* THE BAND IS SET BY THE COLLECTOR'S OWN QUANTISATION, not by taste.
       `tick.up` is reported in HOURS rounded to one decimal, so two sources that agree perfectly
       can still differ by up to 180 s purely from that rounding. The first cut used 120 s and this
       check duly reported a 149 s "disagreement" about a number that was never wrong.
       Caught by B17 on its first live run, about itself, which is the argument for it. */
    medianTolerance: 240,
    measured: 'collector reports uptime to 0.1 h, so ±180 s is rounding, not disagreement',
  },
};

const PLAT = process.platform;

/* Several of the fields above differ by platform, because the underlying calls differ by platform.
   Read every one of them through here rather than indexing directly, so a scalar and a per-platform
   map are interchangeable at the point of use and adding a platform exception never means auditing
   the call sites. */
/* Below this many comparisons the verdict is withheld: a median over three points is a coin toss
   wearing a statistic's clothes. It also sets how long the fast warm-up phase lasts - see due(). */
const MIN_SAMPLES = 12;

function per(v, plat) {
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v[plat] : v;
}

/* Matched to the collector's tick, so the reference and the thing it checks describe the same
   second. Overridable only so the suite can run without paying a real second per sample. */
const WINDOW_MS = 1000;

/* Reference readings. Each returns null rather than a number it could not take - the same rule the
   collectors hold themselves to, because a fabricated reference would corrupt the very statistic
   this module exists to publish. */
async function reference(windowMs) {
  const out = {};
  const a = cpuSnap();
  if (windowMs > 0) await new Promise((r) => setTimeout(r, windowMs));
  out.cpuPct = cpuPctBetween(a, cpuSnap());
  /* Memory and uptime are instantaneous, so they are read at the END of the window - the same
     moment the tick they are compared against describes. */
  try { out.memFreeMB = Math.round(os.freemem() / 1048576); } catch { out.memFreeMB = null; }
  try { out.uptimeSec = Math.round(os.uptime()); } catch { out.uptimeSec = null; }
  return out;
}

/* THE REFERENCE MUST SPAN THE SAME WINDOW AS THE THING IT CHECKS.
 *
 * os.cpus() carries cumulative ticks, so a percentage needs two samples - and the SPACING of those
 * two samples decides what quantity you have computed. The first version kept a running differencer
 * across the whole duty cycle, so it produced a ~20 SECOND average and compared it against the
 * collector's ~1 SECOND sample. Two honest numbers describing different things, differenced as
 * though they were the same one: not a cross-check, a category error, and it read as a 40-point
 * disagreement on a machine where nothing was wrong.
 *
 * This takes its own short window instead, matched to the collector's cadence. One extra syscall
 * and a one-second wait, inside a check that runs every twentieth tick. */
function cpuSnap() {
  try {
    return os.cpus().reduce((a, c) => {
      const t = c.times;
      a.idle += t.idle;
      a.total += t.user + t.nice + t.sys + t.idle + t.irq;
      return a;
    }, { idle: 0, total: 0 });
  } catch { return null; }
}

function cpuPctBetween(a, b) {
  if (!a || !b) return null;
  const dTotal = b.total - a.total;
  const dIdle = b.idle - a.idle;
  if (!(dTotal > 0)) return null;
  return Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100));
}

class SelfCheck {
  /**
   * @param plat  platform override, for tests
   */
  constructor(plat = PLAT, opts = {}) {
    this.plat = plat;
    this.windowMs = opts.windowMs != null ? opts.windowMs : WINDOW_MS;
    this.stats = {};      // key -> { n, agree, worst, last, lastAt }
    this.checkedAt = null;
  }

  /* How many comparisons the thinnest independent source has. The verdict is gated on the WEAKEST
     one, not the total: three sources at four samples each is not twelve samples of evidence. */
  depth() {
    const run = Object.entries(REFS).filter(([, r]) => r.independent[this.plat]);
    if (!run.length) return Infinity;             // nothing to warm up for
    return Math.min(...run.map(([k]) => (this.stats[k] ? this.stats[k].n : 0)));
  }

  /**
   * Is this tick a check tick?
   *
   * WARM UP FAST, THEN SETTLE. A flat every-20th-tick cadence is right for the steady state and
   * wrong for the first ten minutes: at this collector's rate it takes about a quarter of an hour
   * to reach the sample floor, so anyone opening FOOTPRINT early is told "not enough samples to
   * judge" - which is honest, and useless, and reads as the feature being broken. Checking every
   * third tick until the floor is reached produces a verdict inside a couple of minutes and then
   * gets out of the way. The cost of the fast phase is a one-second window every ~11 s for two
   * minutes, once per boot.
   */
  due(tickNo) {
    return tickNo % (this.depth() < MIN_SAMPLES ? 3 : 20) === 0;
  }

  /* Which comparisons are meaningful here, with the reason attached either way. The page renders
     this list whole - the ones that do not run are as informative as the ones that do. */
  plan() {
    return Object.entries(REFS).map(([key, r]) => ({
      key,
      label: r.label,
      unit: r.unit,
      independent: !!r.independent[this.plat],
      method: r.method[this.plat] || 'no reference on this platform',
      compare: per(r.compare, this.plat),
      tolerance: per(r.medianTolerance, this.plat),
    }));
  }

  /**
   * Compare one tick against a freshly taken independent reading.
   * Returns null when nothing could be compared, never a zero-disagreement placeholder.
   */
  async check(tick) {
    if (!tick) return null;
    const ref = await reference(this.windowMs);
    const now = Date.now();
    const rows = [];

    for (const [key, r] of Object.entries(REFS)) {
      if (!r.independent[this.plat]) continue;      // declared dependent: not counted, not hidden

      let mine = null, theirs = null, delta = null, ok = null, detail = '';

      if (key === 'memAvailMB') {
        mine = tick.mem && typeof tick.mem.freeMB === 'number' ? tick.mem.freeMB : null;
        theirs = ref.memFreeMB;
        if (mine != null && theirs != null) {
          if (per(r.compare, this.plat) === 'bound') {
            /* Where the reference really is free pages, AVAILABLE >= FREE is an invariant rather
               than a tolerance, so it is judged per sample - the only comparison here that is
               exact. */
            ok = mine >= theirs - 1;                // 1 MB of rounding between the two units
            detail = `available ${mine} MB ≥ free ${theirs} MB`;
          } else {
            delta = Math.abs(mine - theirs);
            detail = `${mine} MB vs ${theirs} MB`;
          }
        }
      } else if (key === 'cpuPct') {
        mine = tick.cpu && typeof tick.cpu.total === 'number' ? tick.cpu.total : null;
        theirs = ref.cpuPct;
        if (mine != null && theirs != null) {
          delta = Math.abs(mine - theirs);
          detail = `${mine.toFixed(0)}% vs ${theirs.toFixed(0)}%`;
        }
      } else if (key === 'uptimeSec') {
        mine = typeof tick.up === 'number' ? tick.up * 3600 : null;   // tick.up is hours
        theirs = ref.uptimeSec;
        if (mine != null && theirs != null) {
          delta = Math.abs(mine - theirs);
          detail = `${(mine / 3600).toFixed(1)} h vs ${(theirs / 3600).toFixed(1)} h`;
        }
      }

      if (ok === null && delta === null) continue;  // one side unavailable: no sample, no guess

      const st = this.stats[key] || (this.stats[key] = { n: 0, bad: 0, deltas: [], last: null });
      st.n++;
      if (ok === false) st.bad++;
      if (delta != null) {
        st.deltas.push(delta);
        /* Bounded ring. The verdict is a median over a recent window, not over all time - a path
           that breaks today should show up today rather than being averaged out by a month of
           agreement behind it. */
        if (st.deltas.length > 240) st.deltas.shift();
      }
      st.last = { mine, theirs, delta, ok, detail, at: now };

      rows.push({ key, label: r.label, ok, delta, detail, method: r.method[this.plat] });
    }

    if (!rows.length) return null;
    this.checkedAt = now;
    return { at: now, rows };
  }

  /**
   * Rolling agreement, for the panel.
   *
   * `healthy` is null until there are enough samples to mean anything - "no disagreement yet" and
   * "not checked yet" are different facts and only one of them is reassuring. The spread is
   * published alongside the verdict because the tail is real and hiding it would make the median
   * look more precise than it is.
   */
  summary() {
    const q = (arr, p) => {
      if (!arr.length) return null;
      const s = [...arr].sort((x, y) => x - y);
      return s[Math.min(s.length - 1, Math.floor(s.length * p))];
    };
    const out = { checkedAt: this.checkedAt, sources: [] };

    for (const p of this.plan()) {
      const r = REFS[p.key];
      const st = this.stats[p.key];
      const row = {
        key: p.key, label: p.label, method: p.method, independent: p.independent,
        compare: p.compare, unit: p.unit,
        samples: st ? st.n : 0,
        last: st ? st.last : null,
        healthy: null, median: null, p95: null, violations: null,
        tolerance: p.tolerance != null ? p.tolerance : null,
        measured: r.measured || null,
      };
      if (st && st.n) {
        if (p.compare === 'bound') {
          row.violations = st.bad;
          /* An invariant either holds or it does not; one violation is a finding. */
          row.healthy = st.bad === 0;
        } else {
          row.median = q(st.deltas, 0.5);
          row.p95 = q(st.deltas, 0.95);
          /* Below the floor the numbers are shown and the verdict withheld. */
          row.healthy = st.deltas.length >= MIN_SAMPLES && row.median != null && p.tolerance != null
            ? row.median <= p.tolerance
            : null;
        }
      }
      out.sources.push(row);
    }

    const run = out.sources.filter((s) => s.independent && s.samples);
    out.samples = run.reduce((n, s) => n + s.samples, 0);
    out.checks = run.length;
    /* One unhealthy source makes the whole thing unhealthy; all-null stays null rather than
       collapsing to "fine". */
    out.healthy = run.some((s) => s.healthy === false) ? false
      : run.some((s) => s.healthy === true) ? true
      : null;
    return out;
  }
}

module.exports = { SelfCheck, REFS, MIN_SAMPLES, _cpuSnap: cpuSnap, _cpuPctBetween: cpuPctBetween };
