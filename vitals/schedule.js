/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - WHEN WORK HAPPENS.  (B8 collision-free scheduling · B11 the boot capability trial)
 *
 * Two problems that look unrelated and are the same problem: doing something at the wrong moment
 * costs more than the something itself.
 *
 * ---------------------------------------------------------------------------------------------
 * B8 - THE COLLISION-FREE SCHEDULER.
 *
 * VITALS runs a growing number of periodic jobs: the diagnosis loop, the maintenance probes, the
 * hardware one-shot, the trend fit, the workload verdicts. Each was given its own `setInterval` with
 * a round number, and round numbers COLLIDE. Ten-minute jobs all fire on the ten-minute boundary,
 * so the machine sees a spike of process spawns every ten minutes instead of a trickle - and the
 * user, who is trying to work, sees the monitor become the thing worth monitoring.
 *
 * The fix is one stateless timer and STRATIFIED window hashing. Each job's start time inside its
 * period comes from a hash of (job name + machine id), so the schedule is deterministic - a restart
 * must not re-roll it, or a machine that restarts often gets a different collision every time - and
 * per-machine, so a fleet does not synchronise.
 *
 * Plain hashing is NOT enough, and the suite is what established that. Uniform-random points
 * cluster: seven jobs hashed into ten minutes put two of them 1 SECOND apart. That is not a
 * collision-free scheduler, it is one that is usually fine, which is the same thing as one that
 * fails while you are watching. So the period is cut into one slot per job and each sits in the
 * central band of its own slot - separation by construction rather than by luck. See stratify().
 *
 * A minimum gap is then enforced at FIRE time as well, because jobs on different periods drift
 * through each other no matter how well each group is stratified. That check is why the scheduler
 * owns every job rather than each job owning its own timer.
 *
 * ---------------------------------------------------------------------------------------------
 * B11 - THE BOOT CAPABILITY TRIAL: "first run gets the verdict, not the experiment".
 *
 * Some questions about a host can only be answered by trying: can this machine hold 60 fps with the
 * field on, is the WebView2 compositor accelerated, does spawning a PowerShell one-shot cost 80 ms
 * or 900 ms. Answering them CONTINUOUSLY - degrading when the machine is momentarily busy, restoring
 * when it is not - produces a surface that changes character while you use it, which reads as
 * instability rather than as adaptation.
 *
 * So the trial runs ONCE, at boot, and its verdict fixes the operating mode for the session. The
 * first run gets the answer; it does not get the experiment.
 *
 * WHAT MAKES THIS HONEST RATHER THAN A CACHE. The verdict is LEARNED STATE, and A6's rule is that
 * learned state must never be persisted - a machine that was busy during one boot would otherwise
 * carry a permanent verdict about hardware it judged on a bad day. It lives in memory, it dies with
 * the process, and every boot re-earns it. That is the difference between adapting and guessing.
 */

const crypto = require('crypto');
const os = require('os');

/* A job's stable position in [0,1), from its name and this machine. Deterministic across restarts,
   different on every machine. */
function hashFrac(name, salt) {
  const h = crypto.createHash('sha1').update(name + '|' + (salt || os.hostname())).digest();
  return h.readUInt32BE(0) / 0x100000000;
}

/* Bare hashing, kept for callers that want one job's position and nothing else. */
function offsetFor(name, periodMs, salt) {
  return Math.floor(hashFrac(name, salt) * periodMs);
}

/**
 * STRATIFIED PLACEMENT, and this is the difference between spreading and guaranteeing.
 *
 * Hashing N jobs into a period gives a uniform-random distribution, and uniform-random points
 * CLUSTER: with seven jobs in ten minutes the expected closest pair is a few seconds apart, and the
 * suite duly found two landing 1 second apart. That is not a collision-free scheduler, it is a
 * scheduler that is usually fine - which is the same thing as one that fails when you are watching.
 *
 * Instead the period is cut into one slot per job, jobs are assigned to slots in hash order (stable,
 * per-machine, so a restart does not reshuffle and two machines do not agree), and each sits in the
 * CENTRAL BAND of its own slot. Separation is then at least the slot width minus the band, by
 * construction rather than by luck.
 *
 * Stratifying is only meaningful among jobs sharing a period, so it is done per period group - two
 * jobs on different periods drift through each other no matter what, which is what the minimum-gap
 * check at fire time is for.
 */
function stratify(jobs, salt) {
  const groups = new Map();
  for (const j of jobs) {
    if (!groups.has(j.periodMs)) groups.set(j.periodMs, []);
    groups.get(j.periodMs).push(j);
  }
  for (const [periodMs, list] of groups) {
    list.sort((a, b) => hashFrac(a.name, salt) - hashFrac(b.name, salt) || (a.name < b.name ? -1 : 1));
    const slot = periodMs / list.length;
    list.forEach((j, i) => {
      /* The central band: 25%-75% of the slot, so a job never sits on a slot boundary where
         rounding could put it adjacent to its neighbour. */
      const within = 0.25 + hashFrac(j.name + '#pos', salt) * 0.5;
      const off = Math.floor(i * slot + within * slot);
      /* Preserve where the job is in its current cycle when it is re-stratified by a later
         registration, so adding a job does not restart every other one. */
      const shift = off - j.offset;
      j.offset = off;
      if (j.runs === 0) j.nextAt += shift;
    });
  }
  return jobs;
}

class Scheduler {
  /**
   * @param opts.minGapMs  guaranteed separation between any two jobs firing
   * @param opts.now       injectable clock, for tests
   * @param opts.salt      machine identity for the hash, injectable so tests are deterministic
   */
  constructor(opts = {}) {
    this.jobs = [];
    this.minGapMs = opts.minGapMs != null ? opts.minGapMs : 4000;
    this.now = opts.now || (() => Date.now());
    this.salt = opts.salt || os.hostname();
    this.lastFireAt = 0;
    this.timer = null;
    this.log = [];
  }

  /**
   * @param name     stable identity — the hash is taken from it, so renaming a job reschedules it
   * @param periodMs how often
   * @param fn       the work. May return a promise; a rejection is logged, never thrown onward.
   * @param opts.jitterPct  additional random spread, for jobs where exact periodicity is not wanted
   */
  every(name, periodMs, fn, opts = {}) {
    const off = offsetFor(name, periodMs, this.salt);
    const start = this.now();
    this.jobs.push({
      name, periodMs, fn, offset: off,
      jitterPct: opts.jitterPct || 0,
      /* First run is deliberately NOT at boot+0. Everything wants to run at startup, which is the
         single busiest moment of the process's life and the one where the user is waiting. */
      nextAt: start + off,
      runs: 0, lastMs: 0, errors: 0,
    });
    /* Re-stratified on every registration: the slot width depends on how many jobs share the
       period, so it cannot be decided until they have all been declared. */
    stratify(this.jobs, this.salt);
    return this;
  }

  /** The tightest spacing the schedule actually achieves, per period group. For the status page and
      for the suite - a guarantee nobody measures is a hope. */
  tightestGapMs() {
    const groups = new Map();
    for (const j of this.jobs) {
      if (!groups.has(j.periodMs)) groups.set(j.periodMs, []);
      groups.get(j.periodMs).push(j.offset);
    }
    let worst = Infinity;
    for (const [, offs] of groups) {
      if (offs.length < 2) continue;
      const o = [...offs].sort((a, b) => a - b);
      for (let i = 1; i < o.length; i++) worst = Math.min(worst, o[i] - o[i - 1]);
    }
    return worst === Infinity ? null : worst;
  }

  /** Which job is due, or null. Exposed so a test can advance a clock instead of waiting. */
  due() {
    const t = this.now();
    if (t - this.lastFireAt < this.minGapMs) return null;   // the guaranteed gap
    let best = null;
    for (const j of this.jobs) {
      if (j.nextAt > t) continue;
      /* Most overdue first, so a job that was nudged repeatedly cannot starve. */
      if (!best || j.nextAt < best.nextAt) best = j;
    }
    return best;
  }

  async tick() {
    const j = this.due();
    if (!j) return null;
    const t0 = this.now();
    this.lastFireAt = t0;
    j.runs++;
    try {
      await j.fn();
    } catch (e) {
      j.errors++;
      /* A scheduled job that throws must not take the scheduler down with it. The whole point of
         one timer is that it is a single point of failure, so it is also the one place where a
         failure has to be contained. */
      this.note(j.name, 'error', e && e.message);
    }
    j.lastMs = this.now() - t0;
    const jitter = j.jitterPct ? (Math.random() - 0.5) * 2 * j.jitterPct * j.periodMs : 0;
    j.nextAt = this.now() + j.periodMs + jitter;
    this.note(j.name, 'ran', j.lastMs + ' ms');
    return j;
  }

  start(intervalMs = 1000) {
    if (this.timer) return this;
    /* ONE timer for every job. Not a nicety: N timers is N independent things that can drift into
       phase with each other, and the phase is precisely what this exists to control. */
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, intervalMs);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } return this; }

  note(name, what, detail) {
    this.log.push({ at: this.now(), name, what, detail });
    if (this.log.length > 200) this.log.shift();
  }

  status() {
    const t = this.now();
    return {
      minGapMs: this.minGapMs,
      tightestGapMs: this.tightestGapMs(),
      jobs: this.jobs.map((j) => ({
        name: j.name, periodSec: Math.round(j.periodMs / 1000),
        offsetSec: Math.round(j.offset / 1000),
        inSec: Math.max(0, Math.round((j.nextAt - t) / 1000)),
        runs: j.runs, lastMs: j.lastMs, errors: j.errors,
      })).sort((a, b) => a.inSec - b.inSec),
      recent: this.log.slice(-20),
    };
  }
}

/* ---------------------------------------------------------------- B11 */

/**
 * The boot trial. Runs each probe once, records what it measured, and fixes a verdict for the
 * session.
 *
 * IN MEMORY ONLY, and that is the load-bearing decision. Persisting it would make one bad boot -
 * a machine that happened to be compiling something while the trial ran - into a permanent belief
 * about the hardware, with no path back and nothing on screen to say where it came from. A6's rule
 * is intent yes, learned state no, and a capability verdict is learned state.
 */
class BootTrial {
  constructor(opts = {}) {
    this.now = opts.now || (() => Date.now());
    this.results = {};
    this.ranAt = null;
  }

  /**
   * @param name  what is being decided
   * @param probe async () => ({ value, verdict, why }) — MUST return its measurement, not just a
   *              verdict, so the page can show what the decision was made on
   */
  async run(probes) {
    this.ranAt = this.now();
    for (const [name, probe] of Object.entries(probes)) {
      const t0 = this.now();
      try {
        const r = await probe();
        this.results[name] = {
          ...r, ms: this.now() - t0, ok: true,
          /* Stamped so a reader can tell a verdict from THIS boot from one carried over. There is
             no carrying over, and the timestamp is how that is demonstrated rather than claimed. */
          at: this.ranAt,
        };
      } catch (e) {
        /* A probe that fails yields NO VERDICT rather than a pessimistic default. "We could not
           measure this" and "we measured this and it was bad" lead to different behaviour, and
           collapsing them is how a capable machine ends up permanently degraded. */
        this.results[name] = { ok: false, verdict: null, why: 'the trial could not run: ' + (e && e.message),
                               ms: this.now() - t0, at: this.ranAt };
      }
    }
    return this.results;
  }

  verdict(name, dflt) {
    const r = this.results[name];
    return r && r.ok && r.verdict != null ? r.verdict : dflt;
  }

  status() {
    return {
      ranAt: this.ranAt,
      persisted: false,
      note: 'measured once at boot and held for the session. Never written to disk: a verdict ' +
            'reached on a machine that happened to be busy would otherwise outlive its evidence, ' +
            'and every boot re-earns it.',
      results: this.results,
    };
  }
}

module.exports = { Scheduler, BootTrial, offsetFor, hashFrac, stratify };
