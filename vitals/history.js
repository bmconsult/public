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
 */

const fs = require('fs');
const path = require('path');

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
    const keys = Object.keys(this.bucket[0]).filter((k) => k !== 'ts');
    const row = { t: this.bucket[0].ts, n: this.bucket.length };
    for (const k of keys) {
      const vals = this.bucket.map((x) => x[k]).filter((v) => typeof v === 'number');
      if (!vals.length) continue;
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      row[k] = [ +Math.min(...vals).toFixed(2), +avg.toFixed(2), +Math.max(...vals).toFixed(2) ];
    }
    try {
      fs.appendFileSync(path.join(this.dir, `metrics-${this.dayKey(row.t)}.jsonl`),
                        JSON.stringify(row) + '\n');
    } catch (e) { console.error('[history] rollup write failed:', e.message); }
    this.bucket = [];
  }

  dayKey(ms) { const d = new Date(ms); return d.toISOString().slice(0, 10); }

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

  range(days = 7) {
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const key = this.dayKey(Date.now() - i * 86400_000);
      const f = path.join(this.dir, `metrics-${key}.jsonl`);
      if (!fs.existsSync(f)) continue;
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* truncated final line — skip */ }
      }
    }
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
      const v = Array.isArray(r[key]) ? r[key][1] : (typeof r[key] === 'number' ? r[key] : null);
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
        const m = /^metrics-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
        if (m && Date.parse(m[1]) < cutoff) fs.unlinkSync(path.join(this.dir, f));
      }
    } catch { /* best effort */ }
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
