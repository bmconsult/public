/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - REPLAY YOUR OWN BAD MOMENT.  (B7, MARKET_RESEARCH §9)
 *
 * Every settings change in this product is otherwise an act of faith. You turn the field off, the
 * machine feels better, and you have learned nothing - the load was different, the day was
 * different, and the measured noise floor here is about +/-1% CPU, the same order as most of the
 * changes on offer.
 *
 * This makes a change FALSIFIABLE. Take a window out of the record that actually hurt, reproduce
 * the pressure it applied, and run it again after the change. Same load, same duration, two
 * measurements.
 *
 * ---------------------------------------------------------------------------------------------
 * THE LOAD RUNS IN WORKER THREADS, AND THE FIRST VERSION DID NOT. IT WAS THE WORST BUG IN THE FILE.
 *
 * The original burned CPU with `setInterval` callbacks on the BRIDGE'S OWN EVENT LOOP. Serialized
 * callbacks on one thread cannot occupy more than one core, so a run claiming seven workers
 * delivered 0.95 cores - measured - while blocking the loop for up to a second at a time. Three
 * things were wrong at once, and every one of them was a claim this project says it does not make:
 *
 *   - `status()` published `workers: 7, ofCores: 8`, which reads as "7 of 8 cores loaded". That
 *     number was never measured. It is the plausible-figure sin, in the one module whose entire
 *     purpose is to produce a number you can trust twice.
 *   - the comment promised "the machine stays interactive and the panel keeps rendering" while the
 *     bridge serving that panel was the thing being starved.
 *   - "always stoppable" was false: the stop route ran on the loop the load was blocking.
 *
 * A replay at 12% of the recorded pressure does not reproduce the moment, so the comparison the
 * whole feature exists for was invalid. Worker threads fix the cause; reporting the DELIVERED load
 * rather than the requested one fixes the claim.
 *
 * MEASURED HERE, 8 logical cores, asking for 95% CPU (7 threads):
 *
 *                              delivered      worst event-loop lag
 *     setInterval on the loop    0.95 cores          1030 ms
 *     worker threads             5.77 cores            20 ms
 *
 * 5.77 rather than the arithmetic 6.65 because four of those eight cores are SMT siblings, which is
 * exactly the sort of thing a requested figure would have hidden and a measured one cannot.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THIS IS NOT.
 *
 * It reproduces the PRESSURE, not the programs. It does not re-run your compiler and cannot
 * reproduce a stall caused by a driver, a lock, a network round trip or a GPU stage. What it
 * reproduces is the shape of the demand, because that is what the record stored. A replay that
 * feels different from the original is INFORMATION - it means the thing that hurt was not resource
 * pressure - and the status says so rather than letting the reader assume otherwise.
 *
 * SAFETY. This is the only part of VITALS that deliberately makes the machine worse, so every
 * bound is explicit: a hard ceiling on duration that cannot be cancelled from outside, never all
 * cores, memory bounded by what is FREE rather than by what was recorded and released on stop, one
 * temp file with a hard cap, and a refusal to start on a machine already in trouble.
 *
 * The temp file is deleted on stop, on the hard-stop timer, and on SIGINT/SIGTERM. It is NOT
 * deleted on an uncaught throw — this paragraph said "on stop and on crash" until review checked,
 * and there is no `process.on('exit')` or `uncaughtException` handler behind that second word. The
 * file is capped at MAX_DISK_MB and lives in the OS temp directory, so the residue is bounded and
 * the platform sweeps it; the claim is narrowed rather than the handler added, because an exit
 * handler doing filesystem work after an unknown failure is its own hazard. An overclaim inside a
 * SAFETY paragraph is worse than the gap it papers over — it is the paragraph people stop reading at.
 */

const { systemVolume } = require('./diagnose');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

const MAX_SEC = 120;               // hard ceiling, whatever is asked for
const MAX_DISK_MB = 512;           // the temp file never exceeds this
const MIN_FREE_DISK_PCT = 8;       // refuse below this
const MAX_MEM_SHARE = 0.25;        // of what is FREE, not of what was recorded

/* The burner. One per worker thread, duty-cycled rather than spinning flat out: a loop pinned at
   100% cannot reproduce "60% for two minutes", which is the shape most bad moments actually have.
   It deliberately reports NOTHING about CPU - see deliveredCores(). */
const BURN_SRC = `
const { parentPort, workerData } = require('worker_threads');
const { periodMs, duty } = workerData;
let stop = false;
parentPort.on('message', (m) => { if (m === 'stop') stop = true; });
function slice() {
  if (stop) { parentPort.close(); return; }
  const busyMs = periodMs * duty;
  const end = Date.now() + busyMs;
  while (Date.now() < end) { /* the burn */ }
  setTimeout(slice, Math.max(0, periodMs - busyMs));
}
slice();
`;

/* Disk pressure, also off the main thread. The original called fsyncSync on up to 512 MB from the
   bridge's loop, which is a stall in the process that is supposed to be watching for stalls. */
const DISK_SRC = `
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const { file, mbPerSec, capMB } = workerData;
const chunk = Buffer.alloc(1048576, 7);
let wrote = 0, stop = false;
parentPort.on('message', (m) => { if (m === 'stop') stop = true; });
function pass() {
  if (stop) { try { fs.unlinkSync(file); } catch {} parentPort.close(); return; }
  try {
    const n = Math.max(1, Math.round(mbPerSec / 4));
    const fd = fs.openSync(file, 'a');
    for (let i = 0; i < n; i++) {
      /* Cap reached: truncate and continue, so throughput keeps flowing without the file growing.
         A replay that fills the disk has become the problem it was measuring. */
      if (wrote >= capMB) { fs.ftruncateSync(fd, 0); wrote = 0; }
      fs.writeSync(fd, chunk); wrote++;
    }
    fs.fsyncSync(fd);                 // or the OS absorbs it and no I/O actually happens
    fs.closeSync(fd);
    parentPort.postMessage({ wroteMB: wrote });
  } catch (e) { parentPort.postMessage({ error: e.message }); }
  setTimeout(pass, 250);
}
pass();
`;

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
    /* Injectable so the suite can exercise the whole path without spawning real threads. */
    this.WorkerCtor = opts.Worker || Worker;
    this.log = [];
  }

  /** Why this machine must not be loaded right now, or null. */
  refuse(tick) {
    if (this.running) return 'a replay is already running';
    if (!tick) return 'no live sample — refusing to load a machine we cannot watch';
    /* systemVolume(): root by name, then the LARGEST volume - not `vols[0]`, which is whichever
       one the collector happened to enumerate first. This decides whether a stress run is refused
       for lack of disk, so guessing the wrong volume means refusing on a healthy machine or, worse,
       proceeding on a full one. */
    const vol = systemVolume(tick);
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

  start(profile, tick, opts = {}) {
    const no = this.refuse(tick);
    if (no) return { ok: false, error: no };
    if (!profile || !profile.cpu) return { ok: false, error: 'no profile to replay' };

    const seconds = Math.max(5, Math.min(MAX_SEC, opts.seconds || profile.seconds || 30));
    const cores = os.cpus().length;
    const wantCpu = Math.max(0, Math.min(100, profile.cpu.p95 || profile.cpu.p50 || 0));
    /* NEVER ALL CORES. One is always left for the machine to stay interactive on - and now that the
       burn is off the main thread, that promise is actually keepable. */
    const workers = Math.max(1, Math.min(cores - 1, Math.round((wantCpu / 100) * cores)));

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
      ballast: [], threads: [], diskThread: null,
      /* The baseline for deliveredCores(). Taken before a single thread is spawned, so what it
         measures is the load, not the process's history. */
      cpu0: process.cpuUsage(),
      cpuAtEnd: null,
      wroteMB: 0,
      tmpFile: ioMBs > 0 ? path.join(this.tmpDir, `vitals-replay-${process.pid}.tmp`) : null,
      stoppedBecause: null,
    };
    this.running = run;

    /* ---- CPU, in real threads. */
    const duty = Math.max(0, Math.min(1, wantCpu / 100));
    for (let i = 0; i < workers; i++) {
      try {
        const w = new this.WorkerCtor(BURN_SRC, { eval: true, workerData: { periodMs: 100, duty } });
        /* A worker that dies must not take the bridge with it, and must not be silent either. */
        w.on('error', (e) => this.note('worker', e.message));
        w.unref();
        run.threads.push(w);
      } catch (e) { this.note('worker', 'could not start: ' + e.message); }
    }

    /* ---- MEMORY: allocated in slabs and TOUCHED, because an untouched allocation is not resident
       and reproduces no pressure. Spread across ticks of the loop rather than in one blocking
       burst - filling 1.7 GB synchronously is itself a stall. */
    if (memMB > 0) {
      const slab = 16;
      let done = 0;
      const fill = () => {
        if (!this.running || this.running !== run) return;
        for (let k = 0; k < 8 && done < Math.floor(memMB / slab); k++, done++) {
          const b = Buffer.allocUnsafe(slab * 1048576);
          b.fill(done & 0xff);
          run.ballast.push(b);
        }
        if (done < Math.floor(memMB / slab)) setImmediate(fill);
      };
      setImmediate(fill);
    }

    /* ---- DISK, also off the main thread. */
    if (ioMBs > 0 && run.tmpFile) {
      try {
        const w = new this.WorkerCtor(DISK_SRC, { eval: true,
          workerData: { file: run.tmpFile, mbPerSec: ioMBs, capMB: MAX_DISK_MB } });
        w.on('message', (m) => {
          if (m && typeof m.wroteMB === 'number') run.wroteMB = m.wroteMB;
          if (m && m.error) this.note('disk', m.error);
        });
        w.on('error', (e) => this.note('disk', e.message));
        w.unref();
        run.diskThread = w;
      } catch (e) { this.note('disk', 'could not start: ' + e.message); }
    }

    /* The hard stop. Deliberately NOT cancellable from outside: every other bound here can be
       argued with, and this one is what makes the feature safe to offer at all. */
    run.hardStop = setTimeout(() => this.stop('reached its time limit'), seconds * 1000);
    if (run.hardStop.unref) run.hardStop.unref();

    this.note('start', `${workers}/${cores} threads at ${wantCpu.toFixed(0)}% duty, ` +
                       `${memMB} MB ballast, ${ioMBs.toFixed(1)} MB/s disk, ${seconds}s`);
    return { ok: true, ...this.status() };
  }

  stop(why) {
    const run = this.running;
    if (!run) return { ok: false, error: 'nothing running' };
    /* Frozen FIRST, before anything is torn down, so the delivered figure covers the load and not
       the teardown. Both halves of the ratio have to stop at the same instant. */
    run.endedAt = Date.now();
    run.cpuAtEnd = process.cpuUsage(run.cpu0);
    for (const w of run.threads) { try { w.postMessage('stop'); w.terminate(); } catch {} }
    if (run.diskThread) { try { run.diskThread.postMessage('stop'); run.diskThread.terminate(); } catch {} }
    clearTimeout(run.hardStop);
    run.ballast.length = 0;                    // released now, not at the GC's convenience
    if (run.tmpFile) { try { fs.unlinkSync(run.tmpFile); } catch { /* the worker may have got there first */ } }
    run.stoppedBecause = why || 'stopped';
    run.deliveredCores = this.deliveredCores(run);
    this.running = null;
    this.last = run;
    this.note('stop', `${run.stoppedBecause} · delivered ${run.deliveredCores.toFixed(2)} cores`);
    return { ok: true, ranSec: Math.round((run.endedAt - run.startedAt) / 1000),
             why: run.stoppedBecause, deliveredCores: +run.deliveredCores.toFixed(2) };
  }

  /**
   * The load actually DELIVERED, in cores: this process's CPU-seconds per wall-second.
   *
   * This exists because the number the first version published was never measured. A count of
   * threads is a statement of intent; cores-seconds per wall-second is the thing a reader is
   * actually being told, and it is the only one either of us can check.
   *
   * MEASURED ONCE, FROM ONE PLACE, and the first attempt at this got it wrong in a way worth
   * recording. Each worker was asked to report its own `process.cpuUsage()` and the caller summed
   * them - but in Node that call is PROCESS-wide, not thread-wide, so seven workers each reported
   * the same total and the sum read 38.32 cores on an 8-core machine. A 479%-of-the-machine figure
   * is at least obviously broken; the same mistake at two workers would have read 10.9 cores and
   * been believed. One reading, from the main thread, is the whole fix.
   *
   * It is the PROCESS's CPU, so it includes the bridge's own collection work - a rounding error
   * beside the load, and the honest direction to err in, since that work is genuinely part of the
   * pressure this process is applying.
   */
  deliveredCores(run) {
    const r = run || this.running;
    if (!r || !r.cpu0) return 0;
    const wall = ((r.endedAt || Date.now()) - r.startedAt) / 1000;
    if (!(wall > 0)) return 0;
    const u = r.cpuAtEnd || process.cpuUsage(r.cpu0);
    return ((u.user + u.system) / 1e6) / wall;
  }

  status() {
    const r = this.running;
    if (!r) {
      return { running: false, last: this.last ? {
        startedAt: this.last.startedAt, endedAt: this.last.endedAt,
        seconds: this.last.seconds, threads: this.last.workers, memMB: this.last.memMB,
        ioMBs: this.last.ioMBs, why: this.last.stoppedBecause,
        deliveredCores: +(this.last.deliveredCores || 0).toFixed(2),
        describes: this.last.profile && this.last.profile.describes,
      } : null };
    }
    const elapsed = (Date.now() - r.startedAt) / 1000;
    const delivered = this.deliveredCores(r);
    return {
      running: true,
      elapsedSec: Math.round(elapsed),
      remainingSec: Math.max(0, Math.round(r.seconds - elapsed)),
      /* REQUESTED and DELIVERED, side by side and named as such. */
      threadsRequested: r.workers, ofCores: r.cores,
      deliveredCores: +delivered.toFixed(2),
      deliveredPctOfMachine: +((delivered / r.cores) * 100).toFixed(1),
      targetCpuPct: r.wantCpu,
      memMB: r.memMB, ballastMB: r.ballast.length * 16, ioMBs: +r.ioMBs.toFixed(1),
      describes: r.profile.describes,
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
