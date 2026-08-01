/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - WORKLOADS: WHAT A PROGRAM COSTS, AND WHETHER TODAY IS DIFFERENT.  (B5 + B6)
 *
 * Every metric this product stores is about the MACHINE. That makes the most common complaint
 * unanswerable: "the export is slower than it used to be." Slower than what? A machine-wide average
 * cannot say, because it is an average over everything the machine was doing, and the thing being
 * asked about is one program.
 *
 * So: a per-workload record, on the same substrate as everything else. A workload is a named
 * executable group (`tick.proc` already aggregates by name - "claude" with fourteen pids is one
 * workload), and a SESSION is a contiguous period of observing it. Each session accumulates
 * mergeable histograms of what that workload cost and what the machine was like while it ran.
 *
 * ---------------------------------------------------------------------------------------------
 * B5 - PERCENTILES, BECAUSE A MEAN HIDES THE COMPLAINT.
 *
 * A build that usually runs at 40% CPU with a p95 of 45% is a different experience from one that
 * averages the same 40% with a p95 of 98%, and only the second one is what people describe as
 * "stuttering". The A2 substrate makes this nearly free: the same histograms, keyed per workload.
 *
 * B6 - IS IT THE MACHINE, OR IS IT THE JOB?
 *
 * These are opposite findings with opposite fixes, and every tool conflates them. Separating them
 * needs TWO comparisons against the same workload's own past, not one:
 *
 *   1. Is the JOB heavier?      this session's cpu/io/memory  vs  its own baseline
 *   2. Is the MACHINE worse?    contention DURING this session vs contention during past sessions
 *
 * The second is the one nobody does, and it is the reason this can answer at all. Comparing the
 * machine's contention now against its all-time average would just rediscover that you are running
 * something heavy. Comparing it against *what the machine was like the last twenty times you ran
 * this same program* controls for the workload, so what is left is the machine.
 *
 * Four outcomes, and each has a different sentence:
 *   job normal + machine normal  -> nothing to say
 *   job heavier + machine normal -> "this run is doing more work than usual"
 *   job normal  + machine worse  -> "your machine is slower, and it is not this program's doing"
 *   both                         -> "a heavier run on a slower machine", and both need naming
 * ---------------------------------------------------------------------------------------------
 *
 * WHAT A SESSION IS NOT. `tick.proc` is the TOP 16 BY MEMORY. A workload that goes quiet drops off
 * that list, so absence is NOT an exit and a session boundary is NOT a process lifetime. Calling it
 * one would silently turn "Photoshop got quiet for a while" into "Photoshop ran three times".
 * Sessions are therefore periods of OBSERVED ACTIVITY, named that way throughout, and two of them
 * separated by a short gap are stitched back together. The pid set is what distinguishes the two
 * cases honestly: same pids after a gap means it never left, and a wholly new pid set means it
 * genuinely restarted.
 */

const fs = require('fs');
const path = require('path');
const { Hist } = require('./hist');

/* Absent for longer than this and the session is closed. Below it, a gap is treated as the workload
   having dropped out of the top-16 rather than having gone away - which is the common case for
   anything idling in a background tab. */
const GAP_MS = 180_000;

/* A session shorter than this is noise: a program that appeared in the top list for one tick tells
   you nothing about what it costs, and writing it would bury the real sessions. */
const MIN_SESSION_MS = 30_000;
const MIN_SAMPLES = 8;

/* Sessions needed before a baseline is allowed to judge. Two runs of a program is an anecdote; the
   whole point of B6 is to say "different from usual", and "usual" needs enough runs to mean it. */
const MIN_BASELINE_SESSIONS = 3;

/* How much a percentile must move before it is called a change. Not a guess: A2's histograms carry
   a 2% relative bound, and run-to-run variation on the same workload is far larger than that, so
   the threshold is set by what a person would notice rather than by what the instrument can see.
   A third more CPU, or half again the I/O, is a difference someone would describe out loud. */
const JOB_RATIO = 1.35;
const MACHINE_RATIO = 1.5;

/* What each session records. `self` is the workload's own cost; `env` is what the machine was like
   while it ran - the pair is what lets the two questions be asked separately. */
/* `pf` in a tick is a CUMULATIVE page-fault count, not a rate. Binning it directly produced a
   "p95 page faults" of 9,453,937 - a number with the shape of a measurement and no meaning at all,
   since the 95th percentile of a monotonically rising counter is just its value 95% of the way
   through the session. It is differenced into faults/second below and stored under `pfs`; the raw
   counter is never archived, because there is no question it answers. */
const SELF_KEYS = ['cpu', 'mb', 'ioMBs', 'pfs'];
const ENV_KEYS = ['diskQueue', 'hardFaults', 'mem', 'cpuTotal'];

const LABEL = {
  cpu: 'CPU', mb: 'memory', ioMBs: 'disk I/O', pfs: 'page faults',
  diskQueue: 'disk queue', hardFaults: 'hard faults', mem: 'memory pressure', cpuTotal: 'total CPU',
};
const UNIT = { cpu: '%', mb: ' MB', ioMBs: ' MB/s', pfs: '/s', diskQueue: '', hardFaults: '/s', mem: '%', cpuTotal: '%' };

function encodeSet(hists) {
  const out = {};
  for (const [k, h] of Object.entries(hists)) if (h.n) out[k] = h.encode();
  return out;
}
function decodeSet(o) {
  const out = {};
  for (const [k, a] of Object.entries(o || {})) out[k] = Hist.decode(a);
  return out;
}

class Workloads {
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'workloads.jsonl');
    this.open = new Map();          // name -> live session
    this.keepDays = opts.keepDays || 90;
    this.gapMs = opts.gapMs != null ? opts.gapMs : GAP_MS;
    this._closed = null;            // lazily-read history
  }

  /* ---------- ingest ---------- */

  add(tick) {
    if (!tick || !Array.isArray(tick.proc)) return;
    const ts = tick.ts;
    /* The machine's state at this instant, recorded into EVERY open session. This is the half that
       makes B6 possible: contention is attributed to the sessions it happened during, so a later
       comparison can hold the workload fixed and vary only the machine. */
    const env = {
      diskQueue: tick.disk && tick.disk.io ? tick.disk.io.queue : null,
      hardFaults: tick.mem ? tick.mem.pagesSec : null,
      mem: tick.mem ? tick.mem.pct : null,
      cpuTotal: tick.cpu ? tick.cpu.total : null,
    };

    const seen = new Set();
    for (const p of tick.proc) {
      const name = p && p.n;
      if (!name) continue;
      seen.add(name);
      let s = this.open.get(name);

      if (s && ts - s.lastTs > this.gapMs) { this.close(name, s); s = null; }
      if (s && p.pids && p.pids.length && s.pids.length) {
        /* A wholly different pid set means the program genuinely exited and started again. Same
           pids after a gap means it never left, it just went quiet - and stitching those together
           is the difference between "ran three times" and "was open all afternoon". */
        const shared = p.pids.filter((x) => s.pids.includes(x)).length;
        if (shared === 0) { s.restarted = true; this.close(name, s); s = null; }
      }
      if (!s) {
        s = { name, startTs: ts, lastTs: ts, samples: 0, pids: [],
              self: Object.fromEntries(SELF_KEYS.map((k) => [k, new Hist()])),
              env: Object.fromEntries(ENV_KEYS.map((k) => [k, new Hist()])) };
        this.open.set(name, s);
      }

      /* DIFFERENCE THE COUNTER, and refuse the samples that cannot be differenced honestly.
         The group's fault count is a sum over its pids, so a member exiting makes it fall - and a
         negative rate is not a measurement, it is the membership changing underneath. Those
         samples are dropped rather than clamped to zero, which would archive a plausible idle. */
      const dt = (ts - (s.lastTs || ts)) / 1000;
      if (s.lastPf != null && dt > 0 && typeof p.pf === 'number' && p.pf >= s.lastPf) {
        s.self.pfs.add((p.pf - s.lastPf) / dt);
      }
      if (typeof p.pf === 'number') s.lastPf = p.pf;

      s.lastTs = ts;
      s.samples++;
      if (p.pids && p.pids.length) s.pids = p.pids.slice(0, 64);
      s.peakCount = Math.max(s.peakCount || 0, p.count || (p.pids ? p.pids.length : 1));
      for (const k of SELF_KEYS) { if (k !== 'pfs') s.self[k].add(p[k]); }
      for (const k of ENV_KEYS) s.env[k].add(env[k]);
    }

    /* Anything not seen this tick is only CLOSED once the gap has elapsed - see above. */
    for (const [name, s] of [...this.open]) {
      if (!seen.has(name) && ts - s.lastTs > this.gapMs) this.close(name, s);
    }
  }

  close(name, s) {
    this.open.delete(name);
    const dur = s.lastTs - s.startTs;
    /* Too short or too thin to describe anything. Dropped rather than written, because a record
       that cannot support a percentile still gets counted as a session by everything downstream. */
    if (dur < MIN_SESSION_MS || s.samples < MIN_SAMPLES) return null;
    const row = {
      n: name, t0: s.startTs, t1: s.lastTs, samples: s.samples,
      peak: s.peakCount || 1, restart: !!s.restarted,
      self: encodeSet(s.self), env: encodeSet(s.env),
    };
    try {
      fs.appendFileSync(this.file, JSON.stringify(row) + '\n');
      if (this._closed) this._closed.push(row);
    } catch (e) { console.error('[workload] write failed:', e.message); }
    return row;
  }

  /** Close every open session — for shutdown, so the current run is not lost. */
  flush() {
    for (const [name, s] of [...this.open]) this.close(name, s);
  }

  /* ---------- read ---------- */

  sessions() {
    if (this._closed) return this._closed;
    const out = [];
    try {
      const cutoff = Date.now() - this.keepDays * 86400_000;
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { const r = JSON.parse(line); if (r.t1 >= cutoff) out.push(r); }
        catch { /* truncated final line - skip, as everywhere else */ }
      }
    } catch { /* no file yet */ }
    this._closed = out;
    return out;
  }

  /** The live view of a session in progress, shaped like a closed one. */
  liveOf(name) {
    const s = this.open.get(name);
    if (!s || s.samples < MIN_SAMPLES) return null;
    return { n: name, t0: s.startTs, t1: s.lastTs, samples: s.samples, peak: s.peakCount || 1,
             live: true, self: encodeSet(s.self), env: encodeSet(s.env) };
  }

  /**
   * B5: percentiles for one workload, this session and across its history.
   *
   * `baseline` merges every PAST session, so it is what "usual" means for this program on this
   * machine - not a figure from a benchmark, and not an average over the whole machine.
   */
  profile(name) {
    const past = this.sessions().filter((r) => r.n === name);
    const live = this.liveOf(name);
    if (!past.length && !live) return null;

    const merge = (rows, group) => {
      const acc = {};
      for (const r of rows) {
        for (const [k, h] of Object.entries(decodeSet(r[group]))) {
          if (!acc[k]) acc[k] = new Hist();
          acc[k].merge(h);
        }
      }
      return acc;
    };
    const qs = (set) => {
      const out = {};
      for (const [k, h] of Object.entries(set)) {
        if (!h.n) continue;
        /* p99 as well as p95, and the reason is the motivating complaint itself. A workload that
           hitches on 4% of its samples is describable as "it stutters" and is INVISIBLE to p95 by
           construction - the 95th percentile sits below the hitches. p95 answers "is the normal
           case worse"; p99 answers "how bad are the bad moments". Reporting only one of them
           silently picks which kind of slowness the product can see. */
        out[k] = { p50: h.quantile(0.5), p95: h.quantile(0.95), p99: h.quantile(0.99), max: h.max,
                   avg: +h.avg.toFixed(2), n: h.n, label: LABEL[k] || k, unit: UNIT[k] || '' };
      }
      return out;
    };

    const baseSelf = merge(past, 'self'), baseEnv = merge(past, 'env');
    const cur = live || past[past.length - 1];
    const curSelf = decodeSet(cur.self), curEnv = decodeSet(cur.env);

    return {
      name,
      sessions: past.length,
      live: !!live,
      current: { t0: cur.t0, t1: cur.t1, samples: cur.samples, peak: cur.peak,
                 minutes: +((cur.t1 - cur.t0) / 60000).toFixed(1),
                 self: qs(curSelf), env: qs(curEnv) },
      baseline: past.length ? { sessions: past.length,
                                minutes: +(past.reduce((a, r) => a + (r.t1 - r.t0), 0) / 60000).toFixed(1),
                                self: qs(baseSelf), env: qs(baseEnv) } : null,
    };
  }

  /** Every workload with a usable record, heaviest first. */
  list() {
    const names = new Set([...this.open.keys()]);
    for (const r of this.sessions()) names.add(r.n);
    const out = [];
    for (const n of names) {
      const p = this.profile(n);
      if (p) out.push(p);
    }
    out.sort((a, b) => {
      const c = (x) => (x.current.self.cpu ? x.current.self.cpu.p95 : 0);
      return (b.live - a.live) || (c(b) - c(a));
    });
    return out;
  }

  /**
   * B6: THE VERDICT. Two comparisons, reported separately, never merged into one number.
   *
   * Returns null when it cannot honestly answer - too few past sessions, or nothing to compare.
   * That is most of the time early on, and saying nothing is the correct output then: the whole
   * value of this finding is that it distinguishes two cases, and a verdict from one prior run
   * distinguishes nothing while sounding exactly as confident.
   */
  verdict(name) {
    const p = this.profile(name);
    if (!p || !p.baseline || p.baseline.sessions < MIN_BASELINE_SESSIONS) {
      return { name, ok: false,
               reason: !p ? 'no record for this workload'
                 : !p.baseline ? 'this is its first observed session'
                 : `only ${p.baseline.sessions} past session${p.baseline.sessions === 1 ? '' : 's'} — ` +
                   `${MIN_BASELINE_SESSIONS} are needed before "usual" means anything`,
               sessions: p ? p.baseline ? p.baseline.sessions : 0 : 0 };
    }

    const cmp = (group, keys, ratio) => {
      const moved = [];
      for (const k of keys) {
        const a = p.current[group][k], b = p.baseline[group][k];
        if (!a || !b || !(b.p95 > 0)) continue;
        const r = a.p95 / b.p95;
        if (r >= ratio) moved.push({ key: k, label: LABEL[k] || k, unit: UNIT[k] || '',
                                     now: a.p95, was: b.p95, ratio: +r.toFixed(2) });
      }
      moved.sort((x, y) => y.ratio - x.ratio);
      return moved;
    };

    const job = cmp('self', SELF_KEYS, JOB_RATIO);
    const machine = cmp('env', ENV_KEYS, MACHINE_RATIO);

    let call, says;
    if (!job.length && !machine.length) {
      call = 'normal';
      says = `${name} is behaving like its usual self, on a machine behaving like it usually does ` +
             `when ${name} runs.`;
    } else if (job.length && !machine.length) {
      call = 'job';
      says = `This run of ${name} is doing more work than usual — ${job[0].label} at the 95th ` +
             `percentile is ${job[0].ratio}x its normal. The machine is behaving as it normally ` +
             `does while ${name} runs, so this is the job, not the computer.`;
    } else if (!job.length && machine.length) {
      call = 'machine';
      says = `${name} is asking for no more than usual, but the machine is under more pressure ` +
             `than it normally is while ${name} runs — ${machine[0].label} at the 95th percentile ` +
             `is ${machine[0].ratio}x. Something else is competing with it.`;
    } else {
      call = 'both';
      says = `A heavier run of ${name} (${job[0].label} ${job[0].ratio}x) on a machine already ` +
             `under more pressure than usual (${machine[0].label} ${machine[0].ratio}x). Both are ` +
             `real and they have different fixes.`;
    }

    return { name, ok: true, call, says, job, machine,
             sessions: p.baseline.sessions,
             /* Stated so the sentence can be read back to its evidence. A comparison whose
                comparand is invisible is an assertion. */
             against: `${p.baseline.sessions} past sessions, ${p.baseline.minutes} minutes observed`,
             current: { minutes: p.current.minutes, samples: p.current.samples } };
  }

  prune() {
    /* Rewrites the file without expired lines. Cheap - this is one line per session, not per
       minute - and it keeps the 90-day promise the rest of the store makes. */
    try {
      if (!fs.existsSync(this.file)) return 0;
      const cutoff = Date.now() - this.keepDays * 86400_000;
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter((l) => l.trim());
      const keep = lines.filter((l) => { try { return JSON.parse(l).t1 >= cutoff; } catch { return false; } });
      if (keep.length !== lines.length) {
        fs.writeFileSync(this.file + '.tmp', keep.join('\n') + (keep.length ? '\n' : ''));
        fs.renameSync(this.file + '.tmp', this.file);
        this._closed = null;
      }
      return lines.length - keep.length;
    } catch (e) { console.error('[workload] prune failed:', e.message); return 0; }
  }
}

module.exports = { Workloads, MIN_BASELINE_SESSIONS, JOB_RATIO, MACHINE_RATIO, SELF_KEYS, ENV_KEYS, LABEL, UNIT };
