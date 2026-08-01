/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS — time-series store.
 *
 * Almost every monitor in this category shows you RIGHT NOW. That makes the most useful question
 * unanswerable: "when did this start, and what changed?" This module keeps enough history to answer
 * it, at two resolutions, without a database:
 *
 *   - HIGH-RES ring in memory: 1 Hz for the last hour (3600 samples). Powers live sparklines and
 *     the "is this sustained or a spike?" test that the diagnosis engine leans on.
 *   - MINUTE ROLLUPS on disk: one JSONL line per minute per day-file. 1440 lines/day, ~43k/month.
 *     Storing raw 1 Hz for 30 days would be 2.6M samples; min/avg/max per minute keeps the shape
 *     and the extremes while costing 1/60th the space.
 *   - MFT SNAPSHOTS: written by mftscan.ps1. Diffing two of them is what turns "your disk is full"
 *     into "Downloads\beat_project grew 12 GB in the last 14 days."
 *
 * JSONL over SQLite deliberately: node:sqlite is still experimental behind a flag on Node 22, and
 * append-only text survives a crash mid-write (you lose at most the last line, and a truncated
 * final line is simply skipped on read).
 *
 * ---------------------------------------------------------------------------------------------
 * A2 (2026-07-31): ROLLUPS STORE DISTRIBUTIONS, NOT MEANS.
 *
 * v1 rows stored [min, avg, max] per metric per minute. That draws a chart and cannot answer the
 * question the product exists for - "is this slower than usual" - because the mean is precisely
 * the statistic that hides a stutter, and p50/p95 are NOT RECOVERABLE from it afterwards. No later
 * feature can fix that: the information was discarded at write time.
 *
 * v2 rows store a mergeable histogram per metric (see hist.js), carrying min, max and the exact
 * sum alongside. Two consequences:
 *   - p50/p95/p99 become derivable over ANY span, because histograms merge exactly. An hour is the
 *     sum of its sixty minutes; a month is the sum of its minutes. One stored resolution answers
 *     every zoom level, which is what B1's log-time axis rides on.
 *   - the old triple stays derivable, so nothing that read v1 breaks, and avg is exact rather than
 *     estimated - the sum is carried.
 *
 * MEASURED on this machine's own samples: v2 rows are 3.6x the bytes of v1 (312 -> 1137 B/row,
 * 39 -> 141 MB per 90 days). Gzipped they are 293 B/row, 36 MB per 90 days - LESS than the v1
 * format costs today uncompressed. So completed day-files are compacted (see compact()) while
 * TODAY's file stays plain append-only JSONL. That split is deliberate: the crash-safety property
 * above is worth more than the current day's 1.5 MB, and a gzip stream truncated mid-write is
 * unreadable from the truncation point rather than merely short.
 *
 * BOTH FORMATS ARE READ. v1 rows exist on every machine that ran an earlier build, and a store
 * that orphaned them would be discarding the only long history anyone has.
 * ---------------------------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Hist } = require('./hist');

/* PowerShell 5.1's `Set-Content -Encoding utf8` ALWAYS writes a BOM — there is no BOM-less utf8
 * option in that version. JSON.parse treats the leading U+FEFF as an unexpected token and throws,
 * so every file written by the PowerShell helpers must be de-BOM'd on the way in. */
function readJsonFile(file) {
  let txt = fs.readFileSync(file, 'utf8');
  if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);
  return JSON.parse(txt);
}

const HI_RES = 3600;                 // 1 hour at 1 Hz
const ROLLUP_MS = 60_000;
const KEEP_DAYS = 90;

class History {
  constructor(dir) {
    this.dir = dir;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.ring = [];
    this.bucket = [];
    this.bucketStart = 0;
    this.pruneOldRollups();
    /* Compaction at construction rather than on a timer: the bridge restarts often enough (every
       config change, every update) that a day-file is never plain for long, and a timer is one more
       thing that can fire during a write. Yesterday's file cannot receive another line, so there is
       no race to lose. */
    this.compact();
  }

  /* ---------- ingest ---------- */

  add(tick) {
    /* vols is NULL on the darwin plug until its first df poll answers, and the system volume is
       'C:' only on Windows - as written this line crashed every early macOS tick (caught upstream,
       so history silently recorded nothing) and then fell back to {pct:0, freeGB:0}, logging a
       full-disk-of-zero for any platform without a C:. Root volume first, then the biggest thing
       present, then honest nulls. */
    const vols = tick.disk.vols || [];
    const c = vols.find((v) => v.id === 'C:' || v.id === '/') || vols[0] || { pct: null, freeGB: null };
    const io = tick.disk.io;
    const s = {
      ts: tick.ts,
      cpu: tick.cpu.total,
      cpuMax: Math.max(0, ...(tick.cpu.cores || [0])),
      mem: tick.mem.pct,
      hardFaults: tick.mem.pagesSec,
      /* The kernel memory verdict; null everywhere it is not measured, and flush() drops null
         fields so Windows rollups do not grow a dead column. Two platform shapes, one number
         recorded: darwin emits Apple's level (1 normal / 2 warning / 4 critical), linux emits PSI
         {some, full} avg10 percentages and the `some` figure is the one archived - a history file
         never mixes the two, because a machine never changes kernels between ticks. */
      pressure: typeof tick.mem.pressure === 'number' ? tick.mem.pressure
        : (tick.mem.pressure && typeof tick.mem.pressure.some === 'number' ? tick.mem.pressure.some : null),
      /* WHICH volume, archived alongside its numbers. Without it a finding replayed from the record
         reads "null is 8% free": the figures survived and the thing they describe did not. It is a
         string, so flush() passes it through rather than binning it. */
      volId: c.id != null ? String(c.id) : null,
      diskPct: c.pct,
      diskFreeGB: c.freeGB,
      diskBusy: io.busyPct,
      diskQueue: io.queue,
      /* null + null is 0 in JavaScript, so the old sums recorded "perfectly idle" for platforms
         that report null - the plausible zero, archived. Sum only what was measured. */
      diskRW: (io.readMBs != null || io.writeMBs != null)
        ? (io.readMBs || 0) + (io.writeMBs || 0)
        : (io.combinedMBs != null ? io.combinedMBs : null),
      net: (tick.net.rxMBs != null || tick.net.txMBs != null)
        ? (tick.net.rxMBs || 0) + (tick.net.txMBs || 0) : null,
      // busiest adapter across BOTH GPUs (GPU Engine counters), not just the NVIDIA:
      // nvidia-smi reads 0% while the Intel iGPU composites the desktop — the old field
      // recorded that lie for history too. Fallback keeps old ticks readable.
      gpu: tick.gpus && typeof tick.gpus.max === 'number' ? tick.gpus.max : (tick.gpu ? tick.gpu.util : 0),
      gpuTemp: tick.gpu ? tick.gpu.temp : 0,
    };
    this.ring.push(s);
    if (this.ring.length > HI_RES) this.ring.shift();

    if (!this.bucketStart) this.bucketStart = s.ts;
    this.bucket.push(s);
    if (s.ts - this.bucketStart >= ROLLUP_MS) { this.flush(); this.bucketStart = s.ts; }
    return s;
  }

  flush() {
    if (!this.bucket.length) return;
    /* Keys are taken from the WHOLE bucket, not from its first sample. A field that is null on the
       first tick of a minute and present afterwards - which is exactly how the darwin plug's disk
       fields behave while the first df poll is still outstanding - was silently dropped for that
       whole minute. */
    const keys = new Set();
    for (const s of this.bucket) for (const k of Object.keys(s)) if (k !== 'ts') keys.add(k);

    const row = { t: this.bucket[0].ts, n: this.bucket.length, v: 2 };
    for (const k of keys) {
      /* Not everything worth archiving is a number. The volume's identity is a label that happens
         to travel with its measurements, and binning a string would drop it silently - add()
         ignores non-numbers, so the column would simply vanish and nobody would be told. Passed
         through as the last value seen in the minute, which for a mount point is every value. */
      const strs = this.bucket.map((s) => s[k]).filter((v) => typeof v === 'string');
      if (strs.length) { row[k] = strs[strs.length - 1]; continue; }

      const h = new Hist();
      for (const s of this.bucket) h.add(s[k]);      // add() ignores nulls; it never invents one
      if (!h.n) continue;                            // nothing measured: no column, not a zero
      row[k] = h.encode();
    }
    try {
      fs.appendFileSync(path.join(this.dir, `metrics-${this.dayKey(row.t)}.jsonl`),
                        JSON.stringify(row) + '\n');
    } catch (e) { console.error('[history] rollup write failed:', e.message); }
    this.bucket = [];
  }

  dayKey(ms) { const d = new Date(ms); return d.toISOString().slice(0, 10); }

  /* ---------- the v1/v2 seam ----------
   * Every reader goes through these two. The version is detected FROM THE ROW rather than assumed,
   * because a 90-day window on any existing machine spans the format change - the day it upgraded
   * sits in the middle of the range, and half the answer would otherwise be wrong in a way that
   * reports no error at all. */

  /** The distribution for one metric in one row, or null if that row cannot supply one. */
  static distOf(row, key) {
    const v = row[key];
    if (!v) return null;
    /* Passthrough columns (the volume label) are not distributions and must not be decoded as one.
       Hist.decode would hand back an empty histogram, which reads as "measured, and empty" rather
       than "this was never a measurement". */
    if (!Array.isArray(v)) return null;
    if (row.v === 2) return Hist.decode(v);
    /* A v1 row has three numbers and no distribution. Rather than synthesise one - which would put
       invented samples into a merge and quietly corrupt every percentile downstream - it reports
       unavailable, and callers say "no distribution before <date>" instead of guessing. */
    return null;
  }

  /** The [min, avg, max] triple from either format. v2's avg is exact: the sum is stored. */
  static tripleOf(row, key) {
    const v = row[key];
    if (!v) return null;
    if (!Array.isArray(v)) return null;
    if (row.v === 2) return Hist.decode(v).triple();
    return v.length === 3 ? v : null;
  }

  /** A passthrough (non-numeric) column, or null. */
  static labelOf(row, key) {
    const v = row[key];
    return typeof v === 'string' ? v : null;
  }

  /* ---------- read ---------- */

  recent(n = 300) { return this.ring.slice(-n); }

  /* Windows are selected by TIMESTAMP, not by sample count.
     The metrics loop does not actually run at 1 Hz — the CIM queries cost ~2 s per pass, so the
     real rate is nearer 0.3 Hz and it drifts with system load. Slicing the last N entries would
     therefore mean "the last N samples", i.e. an unknown and variable amount of wall-clock time,
     which makes every "sustained for 2 minutes" claim a lie. Selecting by time is correct at any
     sample rate. It also means a window can legitimately hold very few samples, so callers get
     `samples` back and rules require a minimum before trusting the fraction. */
  window(sec) {
    const cutoff = Date.now() - sec * 1000;
    return this.ring.filter((s) => s.ts >= cutoff);
  }

  /** Sustained-condition test. Instantaneous spikes are noise; the engine only fires on a condition
   *  that held for a real fraction of a real span of wall-clock time. */
  sustained(key, pred, windowSec, minFraction = 0.6, minSamples = 5) {
    const win = this.window(windowSec);
    if (win.length < minSamples) return null;                   // not enough history yet
    const spanSec = (win[win.length - 1].ts - win[0].ts) / 1000;
    if (spanSec < windowSec * 0.4) return null;                 // window not actually covered
    const hits = win.filter((s) => pred(s[key], s)).length;
    const frac = hits / win.length;
    return frac >= minFraction ? { frac, samples: win.length, spanSec: +spanSec.toFixed(0), hits } : null;
  }

  stat(key, sec = 300) {
    const win = this.window(sec).map((s) => s[key]).filter((v) => typeof v === 'number');
    if (!win.length) return null;
    const avg = win.reduce((a, b) => a + b, 0) / win.length;
    return { min: Math.min(...win), avg: +avg.toFixed(1), max: Math.max(...win), n: win.length };
  }

  /** Wall-clock seconds of history held, which is what "ready" should depend on. */
  spanSec() {
    if (this.ring.length < 2) return 0;
    return (this.ring[this.ring.length - 1].ts - this.ring[0].ts) / 1000;
  }

  /** One day-file, plain or compacted. Returns '' when neither exists. */
  readDay(key) {
    const plain = path.join(this.dir, `metrics-${key}.jsonl`);
    const gz = plain + '.gz';
    try {
      if (fs.existsSync(plain)) return fs.readFileSync(plain, 'utf8');
      if (fs.existsSync(gz)) return zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8');
    } catch (e) {
      /* A corrupt archive must cost you that day, not the whole range. Compaction writes the .gz
         and only then unlinks the plain file, so the window in which this can happen is one fsync
         wide - but "one day is unreadable" and "history is unreadable" are very different
         failures, and only one of them should ever reach the user. */
      console.error('[history] day unreadable:', key, e.message);
    }
    return '';
  }

  range(days = 7) {
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const txt = this.readDay(this.dayKey(Date.now() - i * 86400_000));
      if (!txt) continue;
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* truncated final line — skip */ }
      }
    }
    return out;
  }

  /* ---------- A2: distributions over an arbitrary span ----------
   * THE POINT OF THE WHOLE SUBSTRATE. Merge every minute bucket that overlaps [fromMs, toMs] into
   * one histogram and read percentiles off it. Because the merge is exact, the answer for an hour
   * and the answer for a month come from the same stored resolution - no pre-aggregated zoom
   * levels, no "which rollup tier am I looking at".
   *
   * It also reports what it COULD NOT cover. Rows written before the format change carry no
   * distribution, and a p95 computed from the half of the window that happens to be v2 - presented
   * as though it covered the whole window - is exactly the kind of confident wrong number this
   * project refuses. The caller gets `v1Rows` and decides what to say. */
  dist(key, fromMs, toMs, days = null) {
    const spanDays = days != null ? days
      : Math.max(1, Math.ceil((Date.now() - fromMs) / 86400_000) + 1);
    const h = new Hist();
    let v2Rows = 0, first = null, last = null;
    const v2Spans = [];        // [start, end) already accounted for by a stored distribution
    const v1Spans = [];        // [start, end) a stored row covers but cannot describe
    for (const r of this.range(spanDays)) {
      if (r.t < fromMs || r.t > toMs) continue;
      if (r[key] == null) continue;
      const span = [r.t, r.t + ROLLUP_MS];
      const d = History.distOf(r, key);
      if (!d) { v1Spans.push(span); continue; }
      v2Rows++;
      v2Spans.push(span);
      if (first === null || r.t < first) first = r.t;
      if (last === null || r.t > last) last = r.t;
      h.merge(d);
    }

    /* THE RING FILLS EVERY HOLE, not just the tail.
     *
     * The first cut skipped any ring sample at or before the newest stored bucket, on the reasoning
     * that stored buckets already covered it. That is true of v2 buckets and FALSE of v1 ones,
     * which cover a minute while describing nothing - so an hour of full-resolution samples sitting
     * in memory was discarded in favour of rows that contributed no distribution at all. Measured
     * on this machine mid-upgrade: n=98 for a window the ring could answer with ~3,600 samples.
     *
     * Now a ring sample is used unless a v2 bucket already counted it, which also repairs any gap -
     * a minute lost to a crash, a restart, a disk that was full - rather than only the newest one.
     * Only spans overlapping the ring can matter, so the membership test stays small. */
    const ringFrom = this.ring.length ? this.ring[0].ts : Infinity;
    const near = v2Spans.filter((s) => s[1] >= ringFrom);
    const inV2 = (ts) => near.some((s) => ts >= s[0] && ts < s[1]);
    const ringMinutes = new Set();
    for (const s of this.ring) {
      if (s.ts < fromMs || s.ts > toMs) continue;
      if (typeof s[key] !== 'number') continue;
      if (inV2(s.ts)) continue;
      h.add(s[key]);
      ringMinutes.add(Math.floor(s.ts / ROLLUP_MS));
      if (first === null || s.ts < first) first = s.ts;
      if (last === null || s.ts > last) last = s.ts;
    }

    /* A v1 span the ring has since described in full is not a hole. Counting it as one would
       report a window as partially blind while holding every sample from it. */
    const v1Rows = v1Spans.filter((s) => !ringMinutes.has(Math.floor(s[0] / ROLLUP_MS))).length;

    if (!h.n) return null;
    return { key, hist: h, n: h.n, v1Rows, v2Rows, ringSamples: ringMinutes.size, from: first, to: last,
             covered: v1Rows === 0, spanSec: first != null && last != null ? (last - first) / 1000 : 0 };
  }

  /* ---------- B1: the log-time band ----------
   * One column per pixel, each column a merge of whatever minute buckets fall inside it. This is
   * the operation the substrate was built for and the reason "zooming becomes scrolling": at any
   * span from a minute to a quarter, the answer comes from the same stored resolution, so there is
   * no pyramid of pre-aggregated zoom levels to build, keep consistent, or get wrong.
   *
   * LOG TIME. Columns are spaced logarithmically in AGE, not linearly in time, so the last ten
   * minutes get as much width as the last ten weeks. That matches how the question is actually
   * asked - "it was fine this morning and awful an hour ago" needs fine resolution near now and
   * coarse resolution far away - and it puts a whole quarter on one screen without a scrollbar.
   *
   * Each column reports its own sample count, so a column drawn from four samples is visibly
   * different from one drawn from four thousand. Empty columns come back as nulls rather than
   * zeros: the machine being off is not the machine being idle, and a chart that draws a flat line
   * through a power cut is lying in the most legible way possible. */
  band(key, opts = {}) {
    const now = opts.to || Date.now();
    const oldestSec = opts.oldestSec || KEEP_DAYS * 86400;
    const cols = Math.max(8, Math.min(600, opts.cols || 160));
    const newestSec = Math.max(1, opts.newestSec || 30);
    const qs = opts.q || [0.5, 0.95];

    /* Column edges, evenly spaced in log(age). Edge i is the OLDER boundary of column i. */
    const lnA = Math.log(newestSec), lnB = Math.log(oldestSec);
    const edgeAge = (i) => Math.exp(lnA + (lnB - lnA) * (i / cols));
    const buckets = new Array(cols).fill(null).map((_, i) => ({
      i,
      t1: now - edgeAge(i) * 1000,          // newer edge
      t0: now - edgeAge(i + 1) * 1000,      // older edge
      h: new Hist(), v1: 0,
    }));

    /* Which column an instant belongs to, by inverting the spacing - a scan per row would be
       O(rows x cols) and this is the same answer in one step. */
    const colOf = (ts) => {
      const age = (now - ts) / 1000;
      if (age < newestSec || age > oldestSec) return -1;
      const i = Math.floor(((Math.log(age) - lnA) / (lnB - lnA)) * cols);
      return i >= 0 && i < cols ? i : -1;
    };

    const days = Math.ceil(oldestSec / 86400) + 1;
    for (const r of this.range(days)) {
      if (r[key] == null) continue;
      const c = colOf(r.t);
      if (c < 0) continue;
      const d = History.distOf(r, key);
      if (!d) { buckets[c].v1++; continue; }
      buckets[c].h.merge(d);
    }
    /* The live ring covers the newest columns at full resolution - the only place it can, and the
       place a log axis gives the most width to. */
    for (const s of this.ring) {
      if (typeof s[key] !== 'number') continue;
      const c = colOf(s.ts);
      if (c >= 0 && !buckets[c].h.n) buckets[c].h.add(s[key]);
    }

    return {
      key, now, newestSec, oldestSec, cols,
      /* Reported so the axis can be labelled by the caller without re-deriving the spacing and
         drifting out of step with it. */
      columns: buckets.map((b) => {
        if (!b.h.n) return { t0: Math.round(b.t0), t1: Math.round(b.t1), n: 0, v1: b.v1, q: null };
        const q = {};
        for (const p of qs) q[String(p)] = b.h.quantile(p);
        return { t0: Math.round(b.t0), t1: Math.round(b.t1), n: b.h.n, v1: b.v1,
                 min: b.h.min, max: b.h.max, avg: +b.h.avg.toFixed(2), q };
      }),
    };
  }

  /** Percentiles over a span, with the caveat attached rather than dropped. */
  percentiles(key, fromMs, toMs, qs = [0.5, 0.95, 0.99]) {
    const d = this.dist(key, fromMs, toMs);
    if (!d) return null;
    const out = { key, n: d.n, min: d.hist.min, max: d.hist.max, avg: d.hist.avg,
                  covered: d.covered, v1Rows: d.v1Rows, from: d.from, to: d.to, q: {} };
    for (const q of qs) out.q[String(q)] = d.hist.quantile(q);
    return out;
  }

  /* ---------- B3: trend over the rollups (2026-07-31, MARKET_RESEARCH §9) ----------
   * Least-squares fit over HOURLY MEDIANS of the minute rollups' avg column, so a predictive
   * rule can say "at the measured rate, N days to the wall" — and, just as important, refuse
   * to. The fit therefore returns its own honesty alongside the slope: r², the slope's
   * standard error, and the span actually covered. Callers gate on those and fall back to the
   * plain current-state finding when the trend is noise; a confidently wrong prediction is
   * worse than a late one.
   *
   * Hourly medians rather than raw minutes: the median ignores the single minute a cache was
   * emptied, while an hour is still fine-grained enough to catch a 20 GB/day runaway inside
   * its first day. A real structural break (a big cleanup mid-window) wrecks the r² and the
   * fit disqualifies itself — which is the designed behaviour, not a failure mode. */
  trend(key, days = 14) {
    const buckets = new Map();                       // hour index -> values seen in that hour
    for (const r of this.range(days)) {
      /* Reads the AVERAGE from either format. `r[key][1]` was the v1 middle of [min,avg,max]; on a
         v2 row index 1 is the maximum, so the unversioned read would have silently fitted a trend
         through the wrong statistic - a line that is confidently drawn and describes nothing. */
      const t = History.tripleOf(r, key);
      const v = t ? t[1] : (typeof r[key] === 'number' ? r[key] : null);
      if (typeof v !== 'number' || Number.isNaN(v)) continue;
      const h = Math.floor(r.t / 3600_000);
      if (!buckets.has(h)) buckets.set(h, []);
      buckets.get(h).push(v);
    }
    const pts = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([h, vals]) => {
      const s = vals.sort((a, b) => a - b);
      return { t: h * 3600_000, v: s[Math.floor((s.length - 1) / 2)] };
    });
    if (pts.length < 2) return null;                 // one point is a value, not a trend
    const t0 = pts[0].t;
    const xs = pts.map((p) => (p.t - t0) / 86400_000);   // days since the first point
    const ys = pts.map((p) => p.v);
    const n = pts.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxx = 0, sxy = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx, dy = ys[i] - my;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    if (sxx === 0) return null;                      // all points in one hour — no time axis
    const base = { key, n, spanDays: +xs[n - 1].toFixed(2), last: ys[n - 1], lastTs: pts[n - 1].t };
    if (syy === 0)                                   // perfectly flat: a measured absence of trend
      return { ...base, perDay: 0, sePerDay: 0, r2: 1 };
    const slope = sxy / sxx;
    const r2 = (sxy * sxy) / (sxx * syy);
    const sse = Math.max(syy - slope * sxy, 0);
    const se = n > 2 ? Math.sqrt(sse / (n - 2) / sxx) : Infinity;
    return { ...base, perDay: +slope.toFixed(4), sePerDay: +(+se).toFixed(4), r2: +r2.toFixed(3) };
  }

  pruneOldRollups() {
    const cutoff = Date.now() - KEEP_DAYS * 86400_000;
    try {
      for (const f of fs.readdirSync(this.dir)) {
        const m = /^metrics-(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/.exec(f);
        if (m && Date.parse(m[1]) < cutoff) fs.unlinkSync(path.join(this.dir, f));
      }
    } catch { /* best effort */ }
  }

  /* ---------- A2: compact finished days ----------
   * v2 rows are 3.6x the bytes of v1 and gzip to 0.26x of themselves - measured on this machine,
   * 293 B/row against v1's 312 uncompressed. So the richer format ends up costing LESS disk than
   * the one it replaces, provided finished days are compacted.
   *
   * TODAY IS NEVER TOUCHED. The append-only plain file is what makes a crash mid-write cost at most
   * one line; a gzip stream truncated mid-write is unreadable from that point on, which trades a
   * one-line loss for a one-day loss to save ~1.5 MB. Compaction therefore runs only on days that
   * can no longer receive a write.
   *
   * Write-then-verify-then-unlink, in that order. A compaction that removed the source before
   * confirming the archive reads back would be a data-loss bug that only appears on a machine you
   * do not own. */
  compact() {
    const today = this.dayKey(Date.now());
    const done = [];
    let saved = 0;
    try {
      for (const f of fs.readdirSync(this.dir)) {
        const m = /^metrics-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
        if (!m || m[1] >= today) continue;                    // today, or something newer: leave it
        const src = path.join(this.dir, f), gz = src + '.gz';
        try {
          const raw = fs.readFileSync(src);
          if (!raw.length) { fs.unlinkSync(src); continue; }
          const packed = zlib.gzipSync(raw, { level: 9 });
          /* A gzip header is ~20 bytes, so a day-file with a handful of rows in it - a machine that
             ran for two minutes, or the tail of an upgrade - comes out LARGER. Compacting it would
             spend a rename and a delete to lose bytes and to give up the plain file's readability
             for nothing. Leave it: this is a size optimisation, and it should decline when it is
             not one. (Caught by the suite printing "-0.0 MB reclaimed".) */
          if (packed.length >= raw.length) continue;
          fs.writeFileSync(gz + '.tmp', packed);
          /* Read the archive back and compare before anything is removed. gzipSync failing
             silently is unlikely; a full disk truncating the write is not. */
          if (!zlib.gunzipSync(fs.readFileSync(gz + '.tmp')).equals(raw)) {
            throw new Error('archive did not read back identical');
          }
          fs.renameSync(gz + '.tmp', gz);
          fs.unlinkSync(src);
          saved += raw.length - packed.length;
          done.push({ day: m[1], from: raw.length, to: packed.length });
        } catch (e) {
          console.error('[history] compaction skipped', m[1] + ':', e.message);
          try { fs.unlinkSync(gz + '.tmp'); } catch { /* nothing to clean */ }
        }
      }
    } catch { /* best effort */ }
    if (done.length) {
      console.error(`[history] compacted ${done.length} day-file${done.length === 1 ? '' : 's'}, ` +
                    `${(saved / 1048576).toFixed(1)} MB reclaimed`);
    }
    return { files: done.length, savedBytes: saved, days: done };
  }

  /* ---------- MFT snapshots ---------- */

  snapshots() {
    try {
      /* Two snapshot families: mft-* from the NTFS scanner, walk-* from the portable tree walker
         (growthscan.js). Same entries shape, so everything downstream reads both; growth() refuses
         to diff ACROSS families via the scanner-version guard below, because an MFT index and a
         permission-limited walk measure different things. */
      return fs.readdirSync(this.dir)
        .filter((f) => /^(?:mft|walk)-.*\.json$/.test(f))
        .map((f) => {
          const st = fs.statSync(path.join(this.dir, f));
          return { file: f, mtime: st.mtimeMs, sizeMB: +(st.size / 1048576).toFixed(2) };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch { return []; }
  }

  readSnapshot(file) {
    try { return readJsonFile(path.join(this.dir, file)); }
    catch (e) { console.error('[history] snapshot read failed:', file, e.message); return null; }
  }

  /** Growth attribution: what got bigger between two snapshots, and by how much.
   *  Filters to directories whose growth isn't just their children's — otherwise every ancestor of
   *  a grown folder appears in the list and buries the actual culprit. */
  growth(newFile, oldFile, minGB = 0.25) {
    const A = this.readSnapshot(newFile), B = this.readSnapshot(oldFile);
    if (!A || !B) return null;
    // A scanner change alters how sizes are computed, so a cross-version diff measures the change
    // in the SCANNER, not on the disk. Refuse rather than report fiction.
    if ((A.scanner || 1) !== (B.scanner || 1)) {
      return { incompatible: true, newScanner: A.scanner || 1, oldScanner: B.scanner || 1,
               note: 'snapshots were produced by different scanner versions and cannot be compared' };
    }
    const oldMap = new Map(B.entries.map((e) => [e.path, e.bytes]));
    const rows = [];
    for (const e of A.entries) {
      const was = oldMap.get(e.path);
      if (was === undefined) { rows.push({ path: e.path, from: 0, to: e.bytes, deltaGB: +(e.bytes / 2 ** 30).toFixed(2), isNew: true }); continue; }
      const d = e.bytes - was;
      if (Math.abs(d) / 2 ** 30 >= minGB) rows.push({ path: e.path, from: was, to: e.bytes, deltaGB: +(d / 2 ** 30).toFixed(2), isNew: false });
    }
    rows.sort((a, b) => b.deltaGB - a.deltaGB);

    // Keep only the DEEPEST attribution: if a child accounts for ~all of a parent's growth, the
    // parent is just carrying it and listing both is noise.
    // The parent/child test needs the snapshot's OWN separator: walker snapshots declare it
    // (path.sep on the machine that walked), MFT snapshots predate the field and are always '\\'.
    // With '\\' hard-coded, every posix snapshot failed this test and listed the whole ancestor
    // chain of any grown folder, burying the culprit under its own parents.
    const SEP = A.sep || '\\';
    const kept = [];
    for (const r of rows) {
      const childCovers = rows.some((o) =>
        o !== r && o.path.startsWith(r.path + SEP) && Math.abs(o.deltaGB - r.deltaGB) < 0.15 * Math.abs(r.deltaGB || 1));
      if (!childCovers) kept.push(r);
    }
    return {
      newest: { file: newFile, takenAt: A.takenAt, totalGB: +(A.totalBytes / 2 ** 30).toFixed(1) },
      oldest: { file: oldFile, takenAt: B.takenAt, totalGB: +(B.totalBytes / 2 ** 30).toFixed(1) },
      spanDays: +((Date.parse(A.takenAt) - Date.parse(B.takenAt)) / 86400_000).toFixed(2),
      netGB: +((A.totalBytes - B.totalBytes) / 2 ** 30).toFixed(2),
      grew: kept.filter((r) => r.deltaGB > 0).slice(0, 25),
      shrank: kept.filter((r) => r.deltaGB < 0).slice(-15).reverse(),
    };
  }
}

module.exports = { History, readJsonFile };
