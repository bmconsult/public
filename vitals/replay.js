/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - REWIND: RUN THE DIAGNOSIS AT A PAST MOMENT.  (B1, MARKET_RESEARCH §5)
 *
 * "Why was my computer slow yesterday at 2pm?"
 *
 * Nothing on this machine answers that. Reliability Monitor shows crashes, not pressure. Event
 * Viewer logs events, not utilisation. `perfmon /report` is sixty seconds of NOW and says outright
 * that it cannot detect historical patterns. WPA records everything and requires you to have
 * started the trace BEFORE the problem, which nobody does. VITALS already keeps the record; until
 * now it had no way to point the engine at it.
 *
 * This module points the engine at it. The rule engine is not modified and not duplicated: it reads
 * history through four methods (sustained, stat, spanSec, ring), so a VIEW implementing those four
 * against the archive - rather than against the live ring - makes every rule run at any past moment
 * with no second copy of the logic to drift.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT REWIND CANNOT DO, STATED UP FRONT AND ENFORCED IN CODE.
 *
 * The archive holds what was archived. Process names, battery chemistry, committed bytes and GPU
 * wattage were never rolled up, so every rule that reads them CANNOT run at a past moment - and the
 * dangerous failure here is not an error, it is SILENCE. The engine is written to skip a rule whose
 * input is missing (that is the null discipline the whole product runs on), so a rewound diagnosis
 * would quietly return a shorter list and read as "nothing much was wrong yesterday".
 *
 * That is the "absence of a finding reads as an all-clear" trap the engine's own comments name. So
 * this module does not merely reconstruct what it can - it reports what it could not, derived from
 * the reconstructed tick rather than from a hand-written list that would rot the first time a rule
 * changed. A rewound diagnosis always carries `unavailable`, and the panel is expected to show it.
 * ---------------------------------------------------------------------------------------------
 *
 * ON RECONSTRUCTING SAMPLES FROM A HISTOGRAM. `sustained` asks what FRACTION of samples satisfied a
 * predicate. A histogram answers that directly: every bin's representative value, repeated by its
 * count. Because bins hold a fixed relative width, only samples within that width of the threshold
 * can be misclassified, so the fraction carries the same bound as the percentiles do.
 *
 * It works because every predicate in the engine reads ONE metric. A predicate reading two would
 * need joint samples, and per-metric histograms cannot supply them - merging them would invent a
 * correlation that was never measured. Rather than trust that this stays true, the view REFUSES a
 * two-argument predicate (checked below), so the day someone writes one it fails loudly instead of
 * quietly answering with fabricated pairs.
 */

const { diagnose } = require('./diagnose');

/* Fields the rollups have never carried, and the rules each one silences. Derived into the
   `unavailable` report by checking the reconstructed tick, so this list describes the ARCHIVE's
   shape rather than trying to track the rule set. */
const NOT_ARCHIVED = [
  { path: 'proc', what: 'the process list',
    silences: 'which program was responsible - the top consumers of CPU, memory, disk and handles' },
  { path: 'pwr', what: 'battery state',
    silences: 'charge, charge rate, wear and the "on AC but not charging" findings' },
  { path: 'mem.committedMB', what: 'committed bytes',
    silences: 'the pagefile inference - whether Windows was leaning on disk for memory' },
  { path: 'mem.totalMB', what: 'installed RAM',
    silences: 'anything expressed as a share of installed memory' },
  { path: 'gpu.watts', what: 'GPU power draw', silences: 'GPU power findings' },
  { path: 'disk.io.readMBs', what: 'the read/write split',
    silences: 'nothing on its own - the combined throughput was archived' },
];

/** Read a nested path, tolerating missing parents. */
function dig(o, p) {
  return p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
}

/**
 * The archived state at a moment, shaped like a live tick so the engine needs no changes.
 *
 * Only archived fields are populated. Everything else is left ABSENT rather than defaulted, because
 * a default here would be the plausible zero this project exists to refuse - a reconstructed tick
 * claiming 0 MB committed would fire the pagefile rule on every historical minute.
 */
function tickAt(hist, atMs, opts = {}) {
  const rows = hist.range(opts.days || spanDaysFor(atMs));
  let best = null;
  for (const r of rows) {
    if (r.t > atMs) continue;
    if (!best || r.t > best.t) best = r;
  }
  /* Nothing at or before the moment asked about. Returning a hollow tick would let the engine run
     against nothing and report an all-clear for a time the machine may not even have been on. */
  if (!best || atMs - best.t > 3600_000) return null;

  const H = hist.constructor;
  const avg = (k) => { const t = H.tripleOf(best, k); return t ? t[1] : null; };
  const volId = H.labelOf(best, 'volId');
  const diskPct = avg('diskPct'), diskFreeGB = avg('diskFreeGB');

  const tick = {
    ts: best.t,
    cpu: { total: avg('cpu'), cores: avg('cpuMax') != null ? [avg('cpuMax')] : [] },
    mem: { pct: avg('mem'), pagesSec: avg('hardFaults'), pressure: avg('pressure') },
    disk: {
      /* No volume at all rather than one with null numbers: the engine disables its disk rules on a
         null volume, which is the correct behaviour for a record that does not describe one. */
      vols: diskPct != null ? [{ id: volId, pct: diskPct, freeGB: diskFreeGB }] : [],
      io: { busyPct: avg('diskBusy'), queue: avg('diskQueue'), combinedMBs: avg('diskRW') },
    },
    net: { combinedMBs: avg('net') },
    gpus: avg('gpu') != null ? { max: avg('gpu') } : null,
    gpu: avg('gpuTemp') != null ? { util: avg('gpu'), temp: avg('gpuTemp') } : null,
  };

  /* The volume label is missing from rows written before it was archived. The identity of a system
     volume does not change, so the CURRENT one is the right answer - but it is inferred rather than
     recorded, and saying which is the difference between a reconstruction and a guess. */
  /* THE LABEL MUST NEVER REACH THE PROSE AS `null`.
     Rows written before the volume label was archived carry numbers with nothing attached, and the
     engine interpolates the id straight into its titles - the first rewound diagnosis on this
     machine read "null is 4.7% free", which is a correct measurement wearing a defect. A system
     volume's identity does not change, so the live one is the right answer where the caller can
     supply it; where it cannot, a neutral noun is still true and still reads. Which of the three
     happened is reported rather than smoothed over. */
  let volFrom = volId ? 'archived' : null;
  if (!volId && tick.disk.vols.length) {
    if (opts.liveVolId) {
      tick.disk.vols[0].id = opts.liveVolId;
      volFrom = 'inferred from the current mount — this row predates the volume label being archived';
    } else {
      tick.disk.vols[0].id = 'the system volume';
      volFrom = 'not archived and no current mount supplied — described generically';
    }
  }

  const unavailable = NOT_ARCHIVED
    .filter((f) => dig(tick, f.path) == null)
    .map(({ path, what, silences }) => ({ field: path, what, silences }));

  return { tick, row: best, at: best.t, requested: atMs,
           driftSec: Math.round((atMs - best.t) / 1000), unavailable, volFrom };
}

function spanDaysFor(atMs) {
  return Math.max(2, Math.ceil((Date.now() - atMs) / 86400_000) + 2);
}

/**
 * A History-shaped view of the archive, anchored at a past moment.
 *
 * Implements exactly the four members the engine reads. Anything else is deliberately absent: a
 * view that half-implemented the rest would invite a future rule to call a method that silently
 * answered about the wrong time.
 */
class PastView {
  constructor(hist, atMs) {
    this.hist = hist;
    this.at = atMs;
    this._cache = new Map();
    this.refusals = [];
    /* Coverage of the widest window any rule uses, read ONCE. Two reasons. It is what tells the
       caller whether the sustained-condition rules could run at all - a v1-era moment has rows but
       no distributions, so those rules skip in silence and the diagnosis comes back short and
       calm. And it keeps the day-files from being re-read and re-parsed per metric per rule. */
    this.window = { rows: 0, v1: 0, v2: 0, first: null, last: null };
    const from = atMs - 300_000;
    for (const r of hist.range(spanDaysFor(atMs))) {
      if (r.t < from || r.t > atMs) continue;
      this.window.rows++;
      if (r.v === 2) this.window.v2++; else this.window.v1++;
      if (this.window.first === null || r.t < this.window.first) this.window.first = r.t;
      if (this.window.last === null || r.t > this.window.last) this.window.last = r.t;
    }
  }

  /** True when the archive can answer fraction-of-samples questions at this moment. */
  get hasDistributions() { return this.window.v2 > 0; }

  _dist(key, windowSec) {
    const ck = key + '@' + windowSec;
    if (this._cache.has(ck)) return this._cache.get(ck);
    const d = this.hist.dist(key, this.at - windowSec * 1000, this.at, spanDaysFor(this.at));
    this._cache.set(ck, d);
    return d;
  }

  sustained(key, pred, windowSec, minFraction = 0.6, minSamples = 5) {
    if (typeof pred === 'function' && pred.length >= 2) {
      /* A predicate reading the whole sample needs metrics observed TOGETHER, and per-metric
         histograms cannot supply that pairing. Refusing is the only honest answer; answering from
         independently-merged bins would invent a correlation nobody measured. */
      this.refusals.push({ key, why: 'predicate reads more than one metric; the archive stores each separately' });
      return null;
    }
    const d = this._dist(key, windowSec);
    if (!d || d.n < minSamples) return null;
    if (d.spanSec < windowSec * 0.4) return null;      // window not actually covered, as live
    const frac = d.hist.fraction(pred);
    if (frac === null) return null;
    return frac >= minFraction
      ? { frac, samples: d.n, spanSec: Math.round(d.spanSec), hits: Math.round(frac * d.n),
          fromArchive: true }
      : null;
  }

  stat(key, sec = 300) {
    const d = this._dist(key, sec);
    if (!d) return null;
    const h = d.hist;
    return { min: h.min, avg: +h.avg.toFixed(1), max: h.max, n: h.n };
  }

  spanSec() {
    /* How much RECORD underlies this moment, so the engine's warm-up gate means the same thing
       rewound as it does live: enough wall clock, not enough samples.
       Taken from the rows themselves rather than from a distribution. A v1-era window has a real,
       measured span and no distributions; reading the span off `dist` reported zero, which failed
       the warm-up gate and marked a well-recorded moment "not ready" - the record was there, only
       one kind of question could not be asked of it. */
    const w = this.window;
    if (w.first === null || w.last === null) return 0;
    /* Each row describes the minute that FOLLOWS its timestamp, so the covered span runs to the end
       of the last bucket, not to its start. Without this a single row spans zero seconds. */
    return (w.last - w.first + 60_000) / 1000;
  }

  get ring() {
    /* The engine reads only `.length`, to express a sample rate. The honest length is how many
       samples the archive holds for this window - not a fabricated array of samples, which would
       be joint readings nobody recorded. */
    const d = this._dist('cpu', 300);
    return { length: d ? d.n : 0 };
  }
}

/**
 * Run the full diagnosis as it would have run at a past moment.
 *
 * Returns the engine's own output plus what the archive could not answer. The second half is not
 * decoration: a rewound diagnosis is systematically shorter than a live one, and without the
 * caveat a quiet list reads as a quiet machine.
 */
function diagnoseAt(hist, atMs, extra = {}) {
  const rec = tickAt(hist, atMs, { liveVolId: extra.liveVolId });
  if (!rec) {
    return {
      at: atMs, ok: false, findings: [], unavailable: [],
      summary: 'Nothing was recorded at that moment.',
      note: 'The machine was off, VITALS was not running, or the record has been pruned. This is ' +
            'not a finding of good health - it is an absence of evidence, and the two are different.',
    };
  }
  const view = new PastView(hist, rec.at);
  const unavailable = [...rec.unavailable];
  if (!view.hasDistributions) {
    /* THE ONE THAT MATTERS MOST. Without distributions, every "has this held for two minutes"
       rule - the spiral, the thrash, the one-core saturation, the disk queue - skips without a
       word, and the diagnosis comes back short and reads as calm. Rows written before A2 store
       [min, avg, max], from which a fraction-of-samples cannot be recovered at all. */
    unavailable.push({
      field: 'distributions',
      what: 'per-minute distributions',
      silences: 'every sustained-condition rule — whether a state HELD rather than merely peaked. ' +
                `This moment has ${view.window.v1} row${view.window.v1 === 1 ? '' : 's'} in the ` +
                'pre-A2 format, which stored only min/avg/max. Moments recorded after the upgrade ' +
                'answer these in full.',
    });
  }
  /* `extra` is passed through minus anything that describes NOW. Growth snapshots, the maintenance
     state and the outcomes ledger are all present-tense; attaching them to a past moment would
     dress current facts as historical ones. The outcomes ledger is the exception worth keeping out
     most firmly - its whole value is a record of when things happened. */
  const past = { outcomes: extra.outcomes };
  const out = diagnose(rec.tick, view, past);

  return {
    at: rec.at,
    requested: rec.requested,
    driftSec: rec.driftSec,
    ok: true,
    rewind: true,
    volFrom: rec.volFrom,
    samples: rec.row.n,
    coverage: { ...view.window, hasDistributions: view.hasDistributions },
    unavailable,
    refusals: view.refusals,
    ...out,
    /* Overwritten deliberately, after the spread. The engine's summary describes the findings it
       could produce; at a past moment that set is incomplete by construction, and a bare "Nothing
       wrong that I can measure" would be the strongest possible overstatement of the record. */
    summary: out.findings.length ? out.summary
      : 'Nothing wrong in what was archived for that moment.',
  };
}

module.exports = { diagnoseAt, tickAt, PastView, NOT_ARCHIVED };
