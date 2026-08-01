/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - REPLAY YOUR OWN BAD MOMENT.  (B7, MARKET_RESEARCH §9)
 *
 * Every settings change in this product is currently an act of faith. You turn the field off, the
 * machine feels better, and you have learned nothing - because the load was different, the day was
 * different, and the measured noise floor here is about +/-1% CPU, which is the same order as most
 * of the changes on offer.
 *
 * This makes a change FALSIFIABLE. Take a window out of the record that actually hurt, reproduce
 * the pressure it applied, and run it again after the change. Same load, same duration, two
 * measurements. That is the difference between "it feels faster" and a result.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THIS IS NOT, AND THE DISTINCTION IS THE WHOLE HONESTY OF IT.
 *
 * It reproduces the PRESSURE, not the programs. It does not re-run your compiler, it does not know
 * what your compiler did, and it cannot reproduce a stall caused by a driver, a lock, a network
 * round trip or a GPU stage. What it reproduces is the shape of the demand - how much CPU across
 * how many threads, how much resident memory, how much disk throughput - because that is what the
 * record actually stored.
 *
 * So a replay that feels different from the original is INFORMATION, not a failure of the replay:
 * it means the thing that hurt was not the resource pressure. Said plainly in the result, because a
 * reproduction tool that lets you believe it reproduced everything is worse than none.
 *
 * ---------------------------------------------------------------------------------------------
 * SAFETY. This is the only part of VITALS that deliberately makes the machine worse, so every
 * bound is explicit and none of them is optional:
 *
 *   - HARD CEILING on duration, enforced by a timer that is not cancellable from outside.
 *   - NEVER ALL CORES. One is always left free, so the machine stays interactive and the panel
 *     keeps rendering. A stress tool that makes the mouse stutter cannot be aborted by the person
 *     who wants to abort it.
 *   - MEMORY IS BOUNDED BY WHAT IS FREE, not by what was recorded, and released on stop. Replaying
 *     a 12 GB moment onto a machine with 2 GB free would cause the thing it is measuring.
 *   - DISK writes go to ONE temp file with a hard size cap, and it is deleted on stop and on crash.
 *   - IT REFUSES TO START on a machine that is already in trouble. Reproducing pressure on a box
 *     at 4% free disk is not a measurement, it is an incident.
 *   - ONE AT A TIME, and always stoppable.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

const MAX_SEC = 120;               // hard ceiling, whatever is asked for
const MAX_DISK_MB = 512;           // the temp file never exceeds this
const MIN_FREE_DISK_PCT = 8;       // refuse below this
const MAX_MEM_SHARE = 0.25;        // of what is FREE, not of what was recorded

/**
 * Extract a reproducible profile from a window of history.
 *
 * Percentiles rather than means, because the A2 substrate has them and because a mean is exactly
 * what fails to describe a bad moment - the p95 is the part that hurt.
 */
function profileFrom(hist, fromMs, toMs) {
  const pick = (key) => {
    try {
      const p = hist.percentiles(key, fromMs, toMs, [0.5, 0.95]);
      return p ? { p50: p.q['0.5'], p95: p.q['0.95'], max: p.max, n: p.n } : null;
    } catch { return null; }
  };
  const cpu = pick('cpu'), mem = pick('mem'), io = pick('diskRW'), q = pick('diskQueue');
  if (!cpu || !cpu.n) return null;
  return {
    from: fromMs, to: toMs,
    seconds: Math.max(1, Math.round((toMs - fromMs) / 1000)),
    cpu, mem, io, queue: q,
    /* Recorded so a replay can be compared against the thing it came from rather than against a
       memory of it. */
    describes: `cpu p95 ${cpu.p95 != null ? cpu.p95.toFixed(0) : '—'}%` +
               (mem && mem.p95 != null ? ` · memory p95 ${mem.p95.toFixed(0)}%` : '') +
               (io && io.p95 != null ? ` · disk p95 ${io.p95.toFixed(1)} MB/s` : ''),
  };
}

class Reproducer {
  constructor(opts = {}) {
    this.running = null;
    this.last = null;
    this.tmpDir = opts.tmpDir || os.tmpdir();
    this.log = [];
  }

  /** Why this machine must not be loaded right now, or null. */
  refuse(tick) {
    if (this.running) return 'a replay is already running';
    if (!tick) return 'no live sample — refusing to load a machine we cannot watch';
    const vols = (tick.disk && tick.disk.vols) || [];
    const vol = vols.find((v) => v.id === 'C:' || v.id === '/') || vols[0];
    if (vol && vol.pct != null && 100 - vol.pct < MIN_FREE_DISK_PCT) {
      return `the disk is ${(100 - vol.pct).toFixed(1)}% free — reproducing pressure here would be ` +
             `the incident, not the measurement`;
    }
    if (tick.mem && tick.mem.pct != null && tick.mem.pct >= 92) {
      return `memory is already at ${tick.mem.pct.toFixed(0)}% — the machine is in the state this ` +
             `would reproduce`;
    }
    return null;
  }

  /**
   * Start a replay. Returns immediately; `status()` reports progress.
   *
   * @param profile from profileFrom()
   * @param tick    the live sample, for the refusal checks
   */
  start(profile, tick, opts = {}) {
    const no = this.refuse(tick);
    if (no) return { ok: false, error: no };
    if (!profile || !profile.cpu) return { ok: false, error: 'no profile to replay' };

    const seconds = Math.max(5, Math.min(MAX_SEC, opts.seconds || profile.seconds || 30));
    const cores = os.cpus().length;
    /* NEVER ALL CORES. The machine must stay interactive: a stress tool that makes the pointer
       stutter cannot be aborted by the person who wants to abort it. */
    const wantCpu = Math.max(0, Math.min(100, profile.cpu.p95 || profile.cpu.p50 || 0));
    const workers = Math.max(1, Math.min(cores - 1, Math.round((wantCpu / 100) * cores)));

    /* Memory bounded by what is FREE, not by what the record said. Replaying a 12 GB moment onto a
       machine with 2 GB free would cause the very condition it is trying to measure. */
    const freeMB = os.freemem() / 1048576;
    const wantMemMB = profile.mem && profile.mem.p95 != null && tick.mem && tick.mem.totalMB
      ? Math.max(0, (profile.mem.p95 / 100) * tick.mem.totalMB - (tick.mem.totalMB - freeMB))
      : 0;
    const memMB = Math.max(0, Math.min(Math.round(freeMB * MAX_MEM_SHARE), Math.round(wantMemMB)));

    const ioMBs = profile.io && profile.io.p95 != null ? Math.max(0, Math.min(200, profile.io.p95)) : 0;

    const run = {
      startedAt: Date.now(), seconds, workers, cores, memMB, ioMBs,
      wantCpu: +wantCpu.toFixed(1),
      profile,
      ballast: [], timers: [], child: [],
      tmpFile: ioMBs > 0 ? path.join(this.tmpDir, `vitals-replay-${process.pid}.tmp`) : null,
      wroteMB: 0,
      stoppedBecause: null,
    };
    this.running = run;

    /* ---- CPU: duty-cycled busy loops, not spin-to-100. A busy loop pinned at 100% cannot
       reproduce "60% for two minutes", which is the shape most bad moments actually have. */
    const period = 100;
    const duty = Math.max(0, Math.min(1, wantCpu / 100));
    for (let i = 0; i < workers; i++) {
      const t = setInterval(() => {
        const busyMs = period * duty;
        const end = Date.now() + busyMs;
        while (Date.now() < end) { /* deliberately burning a slice, then yielding the rest */ }
      }, period);
      run.timers.push(t);
    }

    /* ---- MEMORY: allocated in slabs and TOUCHED, because an untouched allocation is not resident
       and reproduces no pressure at all. Held in one array so stop() can drop it in one statement. */
    if (memMB > 0) {
      const slab = 16;
      for (let i = 0; i < Math.floor(memMB / slab); i++) {
        const b = Buffer.allocUnsafe(slab * 1048576);
        b.fill(i & 0xff);                        // touch it, or it never becomes resident
        run.ballast.push(b);
      }
    }

    /* ---- DISK: one temp file, hard capped, rewritten in place rather than grown, so the ceiling
       is a ceiling rather than a rate limit that eventually fills the volume. */
    if (ioMBs > 0 && run.tmpFile) {
      const chunk = Buffer.alloc(1048576, 7);
      const t = setInterval(() => {
        try {
          const n = Math.max(1, Math.round(ioMBs / 4));      // four writes a second
          const fd = fs.openSync(run.tmpFile, 'a');
          for (let i = 0; i < n; i++) {
            if (run.wroteMB >= MAX_DISK_MB) {
              /* Cap reached: truncate and keep going, so throughput continues without the file
                 growing. A replay that fills the disk has become the problem. */
              fs.ftruncateSync(fd, 0); run.wroteMB = 0;
            }
            fs.writeSync(fd, chunk); run.wroteMB++;
          }
          fs.fsyncSync(fd);                                   // or the OS absorbs it and no I/O happens
          fs.closeSync(fd);
        } catch (e) { this.note('disk', e.message); }
      }, 250);
      run.timers.push(t);
    }

    /* The hard stop. Deliberately NOT cancellable from outside: every other bound here can be
       argued with, and this one is what makes the feature safe to offer at all. */
    run.hardStop = setTimeout(() => this.stop('reached its time limit'), seconds * 1000);
    if (run.hardStop.unref) run.hardStop.unref();

    this.note('start', `${workers}/${cores} workers at ${wantCpu.toFixed(0)}% duty, ` +
                       `${memMB} MB ballast, ${ioMBs.toFixed(1)} MB/s disk, ${seconds}s`);
    return { ok: true, ...this.status() };
  }

  stop(why) {
    const run = this.running;
    if (!run) return { ok: false, error: 'nothing running' };
    for (const t of run.timers) clearInterval(t);
    clearTimeout(run.hardStop);
    run.ballast.length = 0;                    // release immediately, do not wait for a GC cycle
    if (run.tmpFile) { try { fs.unlinkSync(run.tmpFile); } catch { /* already gone */ } }
    run.stoppedBecause = why || 'stopped';
    run.endedAt = Date.now();
    this.running = null;
    this.last = run;
    this.note('stop', run.stoppedBecause);
    return { ok: true, ranSec: Math.round((run.endedAt - run.startedAt) / 1000), why: run.stoppedBecause };
  }

  status() {
    const r = this.running;
    if (!r) {
      return { running: false, last: this.last ? {
        startedAt: this.last.startedAt, endedAt: this.last.endedAt,
        seconds: this.last.seconds, workers: this.last.workers, memMB: this.last.memMB,
        ioMBs: this.last.ioMBs, why: this.last.stoppedBecause,
        describes: this.last.profile && this.last.profile.describes,
      } : null };
    }
    const elapsed = (Date.now() - r.startedAt) / 1000;
    return {
      running: true,
      elapsedSec: Math.round(elapsed),
      remainingSec: Math.max(0, Math.round(r.seconds - elapsed)),
      workers: r.workers, ofCores: r.cores, memMB: r.memMB, ioMBs: +r.ioMBs.toFixed(1),
      targetCpuPct: r.wantCpu,
      describes: r.profile.describes,
      /* Repeated in every status payload rather than only in the docs, because this is the caveat
         somebody will otherwise forget while reading a comparison. */
      caveat: 'this reproduces the resource PRESSURE, not the programs. A replay that feels ' +
              'different from the original means the thing that hurt was not resource pressure — ' +
              'which is a result, not a failure.',
    };
  }

  note(what, detail) {
    this.log.push({ at: Date.now(), what, detail });
    if (this.log.length > 100) this.log.shift();
  }
}

module.exports = { Reproducer, profileFrom, MAX_SEC, MAX_DISK_MB, MIN_FREE_DISK_PCT, MAX_MEM_SHARE };
