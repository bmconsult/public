/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - WORKLOAD SUITE (B5 + B6).  node test-workload.js   (any platform)
 *
 * What this proves: sessions are bounded honestly, percentiles per workload are right, and - the
 * one that matters - the verdict SEPARATES a heavy job from a degraded machine in two scenarios
 * that are indistinguishable from any machine-wide average.
 *
 * That separation is the entire feature. Both cases look the same from outside: high CPU, high
 * I/O, slow. They have opposite fixes, and getting it backwards wastes an afternoon in either
 * direction. So the suite constructs both, plus the case where both moved, plus the case where
 * neither did, and asserts a different call for each.
 *
 * The refusals are asserted just as hard. A verdict from one prior run distinguishes nothing while
 * sounding exactly as confident as one from twenty, so the bar is checked from below.
 *
 * Runs in a scratch directory. It must never read a real store.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Workloads, MIN_BASELINE_SESSIONS } = require('./workload');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra !== undefined ? '  [' + extra + ']' : ''}`); }
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vitals-wl-'));
const freshDir = () => fs.mkdtempSync(path.join(ROOT, 'd-'));

let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

/* A tick carrying one workload plus the machine state around it. */
const tick = (ts, o = {}) => ({
  ts,
  cpu: { total: o.cpuTotal != null ? o.cpuTotal : 30, cores: [30] },
  mem: { pct: o.mem != null ? o.mem : 50, pagesSec: o.faults != null ? o.faults : 10 },
  disk: { vols: [{ id: 'C:', pct: 40, freeGB: 200, sizeGB: 500 }],
          io: { busyPct: 5, queue: o.queue != null ? o.queue : 0.2, readMBs: 1, writeMBs: 1 } },
  net: { rxMBs: 0, txMBs: 0 },
  gpus: { max: 5 }, gpu: { util: 5, temp: 50 },
  proc: o.proc || [],
});

const job = (n, cpu, extra = {}) => ({
  n, cpu, mb: extra.mb != null ? extra.mb : 500, ioMBs: extra.io != null ? extra.io : 2,
  rMBs: 1, wMBs: 1, pf: 1000, count: 1, pids: extra.pids || [100],
});

/** Run one session of `name` lasting `mins`, with given job load and machine environment. */
function session(w, startTs, mins, opts) {
  const n = mins * 60;
  for (let i = 0; i < n; i++) {
    const jitter = 1 + (rnd() - 0.5) * 0.10;
    w.add(tick(startTs + i * 1000, {
      proc: [job(opts.name, opts.cpu * jitter, { io: opts.io * jitter, pids: opts.pids })],
      queue: opts.queue * jitter,
      faults: opts.faults * jitter,
      cpuTotal: opts.cpuTotal != null ? opts.cpuTotal * jitter : 30,
    }));
  }
  return startTs + n * 1000;
}

console.log('--- B5: a session records the workload\'s own percentiles ---');
{
  const w = new Workloads(freshDir());
  const t0 = Date.now() - 3600_000;
  /* 12% of samples are a spike - comfortably above the 95th percentile rather than sitting on it.
     The first draft used exactly 5%, which puts p95 precisely at the boundary between the quiet
     band and the spikes, so the answer was decided by sampling noise and the convention for
     nearest-rank. A test on a discontinuity measures the discontinuity, not the code. */
  for (let i = 0; i < 300; i++) {
    const cpu = rnd() < 0.88 ? 20 + rnd() * 3 : 88 + rnd() * 8;
    w.add(tick(t0 + i * 1000, { proc: [job('render', cpu)] }));
  }
  const p = w.profile('render');
  check('a live session is profiled', p && p.live === true);
  check('p50 sits in the quiet band', p && p.current.self.cpu.p50 > 18 && p.current.self.cpu.p50 < 25,
    p && p.current.self.cpu.p50);
  check('p95 finds the spike a mean would bury',
    p && p.current.self.cpu.p95 > 60, p && p.current.self.cpu.p95);
  check('the average is NOT what the complaint is about',
    p && p.current.self.cpu.avg < 40, p && p.current.self.cpu.avg);
  check('memory and I/O are profiled too', p && p.current.self.mb && p.current.self.ioMBs);
  check('the machine around it is profiled separately', p && p.current.env && p.current.env.diskQueue);
  check('no baseline yet, and it says so', p && p.baseline === null);

  /* THE DIVISION OF LABOUR BETWEEN p95 AND p99, which is why both are reported.
     A workload that hitches on 3% of its samples is exactly what people describe as "it stutters",
     and p95 cannot see it - the 95th percentile sits below the hitches by construction. Reporting
     only p95 would silently choose which kind of slowness this product is able to notice. */
  const w2 = new Workloads(freshDir());
  const t1 = Date.now() - 3600_000;
  for (let i = 0; i < 400; i++) {
    const cpu = (i % 33 === 0) ? 95 : 20;          // ~3% hitches
    w2.add(tick(t1 + i * 1000, { proc: [job('stutter', cpu)] }));
  }
  const q = w2.profile('stutter').current.self.cpu;
  check('p95 CANNOT see a 3% hitch rate — by construction, not by defect', q.p95 < 40, q.p95);
  check('p99 can, which is why both are reported', q.p99 > 60, q.p99);
  check('and the maximum is carried exactly', q.max >= 95, q.max);

  /* A CUMULATIVE COUNTER IS NOT A DISTRIBUTION. `pf` in a tick is a running total, so binning it
     directly yields a "p95 page faults" in the millions - a number shaped exactly like a
     measurement that answers no question at all. It has to be differenced into a rate first. */
  const w3 = new Workloads(freshDir());
  const t2 = Date.now() - 3600_000;
  for (let i = 0; i < 120; i++) {
    const p3 = job('grow', 10);
    p3.pf = 1000000 + i * 250;                      // a counter climbing at 250/s
    w3.add(tick(t2 + i * 1000, { proc: [p3] }));
  }
  const f = w3.profile('grow').current.self;
  check('the raw cumulative counter is never archived', f.pf === undefined,
    f.pf && JSON.stringify(f.pf));
  check('page faults are stored as a RATE', f.pfs && f.pfs.p50 > 200 && f.pfs.p50 < 300, f.pfs && f.pfs.p50);
  check('and the rate is not in the millions', f.pfs && f.pfs.max < 1000, f.pfs && f.pfs.max);

  /* A group member exiting makes the summed counter FALL. A negative rate is the membership
     changing, not a measurement, so those samples are dropped rather than clamped to a plausible
     zero - which would archive an idle period that never happened. */
  const w4 = new Workloads(freshDir());
  const t3 = Date.now() - 3600_000;
  for (let i = 0; i < 60; i++) {
    const p4 = job('shrink', 10);
    p4.pf = i < 30 ? 1000000 + i * 300 : 400000 + i * 300;   // a pid leaves at i=30
    w4.add(tick(t3 + i * 1000, { proc: [p4] }));
  }
  const g = w4.profile('shrink').current.self.pfs;
  check('a counter going backwards contributes no sample', g && g.n < 60, g && g.n);
  check('and no zero is invented in its place', g && g.p50 > 200, g && g.p50);
}

console.log('\n--- sessions are periods of OBSERVED activity, not process lifetimes ---');
{
  const w = new Workloads(freshDir(), { gapMs: 60_000 });
  let t = Date.now() - 7200_000;
  t = session(w, t, 2, { name: 'app', cpu: 20, io: 2, queue: 0.2, faults: 10, pids: [42] });

  /* A short absence: the program dropped out of the top-16, it did not exit. Same pids after. */
  t += 30_000;
  t = session(w, t, 2, { name: 'app', cpu: 20, io: 2, queue: 0.2, faults: 10, pids: [42] });
  check('a short gap does NOT split the session', w.sessions().length === 0,
    `${w.sessions().length} closed`);
  check('and the live session spans the whole period',
    w.liveOf('app') && (w.liveOf('app').t1 - w.liveOf('app').t0) > 240_000);

  /* A long absence closes it. */
  t += 120_000;
  t = session(w, t, 2, { name: 'app', cpu: 20, io: 2, queue: 0.2, faults: 10, pids: [42] });
  check('a gap beyond the threshold DOES close it', w.sessions().length === 1,
    `${w.sessions().length}`);

  /* A wholly new pid set means it genuinely restarted, even with no gap at all. */
  const w2 = new Workloads(freshDir(), { gapMs: 600_000 });
  let u = Date.now() - 3600_000;
  u = session(w2, u, 2, { name: 'app', cpu: 20, io: 2, queue: 0.2, faults: 10, pids: [1, 2] });
  u = session(w2, u + 1000, 2, { name: 'app', cpu: 20, io: 2, queue: 0.2, faults: 10, pids: [9, 8] });
  check('a wholly new pid set is a restart, even with no gap', w2.sessions().length === 1,
    `${w2.sessions().length}`);
  check('and the restart is recorded as such', w2.sessions()[0].restart === true);
}

console.log('\n--- too short or too thin to describe anything is DROPPED, not written ---');
{
  const w = new Workloads(freshDir(), { gapMs: 1000 });
  const t = Date.now() - 3600_000;
  for (let i = 0; i < 3; i++) w.add(tick(t + i * 1000, { proc: [job('blip', 90)] }));
  w.add(tick(t + 60_000, { proc: [] }));            // gap closes it
  check('a three-sample appearance writes no session', w.sessions().length === 0,
    `${w.sessions().length}`);
  check('and profile() reports nothing rather than a percentile from three points',
    w.profile('blip') === null);
}

console.log('\n--- B6: the refusals, checked from below ---');
{
  const w = new Workloads(freshDir(), { gapMs: 1000 });
  let t = Date.now() - 20 * 3600_000;
  const one = { name: 'build', cpu: 40, io: 5, queue: 0.3, faults: 20, cpuTotal: 45, pids: [7] };

  check('an unknown workload gets no verdict', w.verdict('nope').ok === false);

  t = session(w, t, 2, one); t += 60_000;
  w.add(tick(t, { proc: [] }));
  check('one past session is not a baseline',
    w.verdict('build').ok === false && /first observed|1 past/i.test(w.verdict('build').reason),
    w.verdict('build').reason);

  for (let k = 0; k < MIN_BASELINE_SESSIONS - 2; k++) {
    t = session(w, t, 2, one); t += 60_000; w.add(tick(t, { proc: [] }));
  }
  check(`below ${MIN_BASELINE_SESSIONS} sessions it still refuses`,
    w.verdict('build').ok === false, JSON.stringify(w.verdict('build')));
  check('and the refusal states the bar rather than just failing',
    /needed before/i.test(w.verdict('build').reason || ''), w.verdict('build').reason);
}

/** Build a workload with `n` normal past sessions, then one live session shaped by `now`. */
function scenario(normal, now, sessions = 6) {
  const w = new Workloads(freshDir(), { gapMs: 1000 });
  let t = Date.now() - 40 * 3600_000;
  for (let k = 0; k < sessions; k++) {
    t = session(w, t, 3, normal);
    t += 60_000;
    w.add(tick(t, { proc: [] }));                    // the gap closes the session
  }
  session(w, t + 60_000, 3, now);                    // left OPEN: this is the run being judged
  return w;
}

const NORMAL = { name: 'export', cpu: 40, io: 5, queue: 0.3, faults: 20, cpuTotal: 45, pids: [7] };

console.log('\n--- B6: the same machine-wide picture, three different answers ---');
{
  /* 1. THE JOB GOT HEAVIER. The program asks for more; the machine around it is unchanged. */
  const jobHeavy = scenario(NORMAL, { ...NORMAL, cpu: 78, io: 11 });
  const v1 = jobHeavy.verdict('export');
  check('a heavier job is called THE JOB', v1.ok && v1.call === 'job', JSON.stringify(v1.call));
  check('it names which measure moved', v1.job.length > 0 && v1.job[0].ratio > 1.35, v1.job[0]);
  check('it says the machine is fine, in words', /this is the job, not the computer/i.test(v1.says));
  check('and it cites what it compared against', /past sessions/.test(v1.against), v1.against);

  /* 2. THE MACHINE GOT WORSE. The program asks for exactly what it always does; contention around
        it has risen. From a machine-wide average this is indistinguishable from case 1. */
  const machBad = scenario(NORMAL, { ...NORMAL, queue: 2.4, faults: 260, cpuTotal: 88 });
  const v2 = machBad.verdict('export');
  check('a contended machine is called THE MACHINE', v2.ok && v2.call === 'machine', v2.call);
  check("it reports the workload's own demand as unchanged", v2.job.length === 0,
    JSON.stringify(v2.job));
  check('it names the contention that moved', v2.machine.length > 0 && v2.machine[0].ratio > 1.5,
    v2.machine[0]);
  check('and says explicitly that something else is competing',
    /something else is competing/i.test(v2.says), v2.says);

  /* 3. BOTH. Two problems with two fixes; collapsing them into one fixes at most half. */
  const both = scenario(NORMAL, { ...NORMAL, cpu: 78, io: 11, queue: 2.4, faults: 260 });
  const v3 = both.verdict('export');
  check('both moving is called BOTH', v3.ok && v3.call === 'both', v3.call);
  check('and both are named', v3.job.length > 0 && v3.machine.length > 0);
  check('and it says they have different fixes', /different fixes/i.test(v3.says));

  /* 4. NEITHER. The commonest case, and it must produce no finding at all. */
  const calm = scenario(NORMAL, { ...NORMAL });
  const v4 = calm.verdict('export');
  check('an ordinary run is called NORMAL', v4.ok && v4.call === 'normal', v4.call);
  check('and normal says nothing alarming', /usual self/i.test(v4.says));

  /* THE POINT, asserted directly: cases 1 and 2 are the ones every other tool conflates. */
  check('THE SEPARATION: heavy-job and degraded-machine get opposite calls',
    v1.call === 'job' && v2.call === 'machine');
}

console.log('\n--- the verdict compares against the workload\'s OWN past, not the machine\'s ---');
{
  /* The subtle failure this guards. If contention were compared against the machine's all-time
     average rather than against past sessions OF THIS WORKLOAD, then any program that is simply
     heavy would look like a degraded machine every single time it ran. Here the baseline itself is
     a contended one - this program always runs while the disk is busy - so a run at that same
     contention must read as NORMAL. */
  const alwaysBusy = { name: 'encode', cpu: 60, io: 20, queue: 3.0, faults: 300, cpuTotal: 85, pids: [3] };
  const w = scenario(alwaysBusy, { ...alwaysBusy });
  const v = w.verdict('encode');
  check('a program that always runs under load is NOT called degraded', v.ok && v.call === 'normal',
    JSON.stringify({ call: v.call, machine: v.machine }));

  /* And the same program on a genuinely quieter machine is not called "improved" either - the
     verdict fires on degradation, not on any change. */
  const better = scenario(alwaysBusy, { ...alwaysBusy, queue: 0.2, faults: 10 });
  check('and a quieter-than-usual machine raises no alarm',
    better.verdict('encode').call === 'normal', better.verdict('encode').call);
}

console.log('\n--- persistence ---');
{
  const dir = freshDir();
  const w = new Workloads(dir, { gapMs: 1000 });
  let t = Date.now() - 10 * 3600_000;
  for (let k = 0; k < 4; k++) {
    t = session(w, t, 2, NORMAL); t += 60_000; w.add(tick(t, { proc: [] }));
  }
  check('closed sessions are on disk', fs.existsSync(path.join(dir, 'workloads.jsonl')));

  const w2 = new Workloads(dir);
  check('a fresh instance reads them back', w2.sessions().length === 4, w2.sessions().length);
  check('and can build a baseline from them',
    w2.profile('export') && w2.profile('export').baseline.sessions === 4);

  /* Open sessions must survive a shutdown, or a machine that is only ever closed cleanly would
     accumulate a baseline of nothing. */
  const dir3 = freshDir();
  const w3 = new Workloads(dir3, { gapMs: 600_000 });
  session(w3, Date.now() - 3600_000, 3, NORMAL);
  check('an open session is not yet on disk', w3.sessions().length === 0);
  w3.flush();
  check('flush() closes it so the run is not lost', w3.sessions().length === 1);

  const old = freshDir();
  const wOld = new Workloads(old, { keepDays: 30 });
  fs.writeFileSync(path.join(old, 'workloads.jsonl'),
    JSON.stringify({ n: 'x', t0: 1, t1: Date.now() - 200 * 86400_000, self: {}, env: {} }) + '\n' +
    JSON.stringify({ n: 'y', t0: 1, t1: Date.now() - 86400_000, self: {}, env: {} }) + '\n');
  const dropped = wOld.prune();
  check('pruning drops expired sessions', dropped === 1, dropped);
  check('and keeps recent ones', new Workloads(old).sessions().length === 1);
}

console.log('\n--- the verdict reaches the DIAGNOSIS as three distinct findings ---');
{
  /* The suite above proves the verdict is right. This proves it is wired: a verdict that never
     reaches a finding is a correct answer nobody is shown. Driven through the real engine, because
     the seam between them is exactly where a rename or a shape change goes unnoticed. */
  const { diagnose } = require('./diagnose');
  const hist = { sustained: () => null, stat: () => null, spanSec: () => 600, ring: { length: 600 } };
  const base = { ts: Date.now(), cpu: { total: 20, cores: [20] },
    mem: { pct: 50, pagesSec: 10, totalMB: 16000, committedMB: 8000, freeMB: 4000 },
    disk: { vols: [{ id: 'C:', pct: 40, freeGB: 200, sizeGB: 500 }], io: { busyPct: 5, queue: 0.2 } },
    net: {}, gpus: { max: 5 }, gpu: { util: 5, temp: 50 }, proc: [] };

  const run = (v) => diagnose(base, hist, { workloads: v ? [v] : [] })
    .findings.filter((f) => f.id.startsWith('wl_'));

  const mk = (call, extra = {}) => ({
    name: 'export', ok: true, call, sessions: 9, against: '9 past sessions, 40 minutes observed',
    says: 'x', job: [{ key: 'cpu', label: 'CPU', unit: '%', now: 78, was: 40, ratio: 1.95 }],
    machine: [{ key: 'diskQueue', label: 'disk queue', unit: '', now: 2.4, was: 0.3, ratio: 8 }],
    ...extra,
  });

  check('a JOB verdict produces one finding', run(mk('job')).length === 1);
  check('and it names the program, not the machine',
    /heavier than usual/i.test(run(mk('job'))[0].title) && /machine is fine/i.test(run(mk('job'))[0].title),
    run(mk('job'))[0].title);
  check('a MACHINE verdict produces the opposite finding',
    /not by its own work/i.test(run(mk('machine'))[0].title), run(mk('machine'))[0].title);
  check('they are DIFFERENT finding ids, so the ledger can tell them apart',
    run(mk('job'))[0].id !== run(mk('machine'))[0].id);
  /* Asserted on MEANING rather than on one phrasing: that it names both measures and says the two
     are separate. The first draft grepped for the literal words "different fixes" while the finding
     said "separate problems with separate fixes" - a test failing the code for a synonym. */
  const both = run(mk('both'))[0];
  check('a BOTH verdict names the job measure and the machine measure',
    /CPU/.test(both.evidence.join(' ')) && /disk queue/.test(both.evidence.join(' ')),
    JSON.stringify(both.evidence));
  check('and says in words that they are two problems with two fixes',
    /separate problems with separate fixes/i.test(both.because), both.because.slice(0, 90));
  check('a NORMAL verdict fires nothing at all', run(mk('normal')).length === 0);
  check('a refused verdict fires nothing', run({ name: 'x', ok: false, reason: 'too few' }).length === 0);
  check('no workloads at all fires nothing', run(null).length === 0);
  check('every finding cites what it compared against',
    run(mk('machine'))[0].evidence.some((e) => /past sessions/.test(e)),
    JSON.stringify(run(mk('machine'))[0].evidence));
  check('the machine finding is a warning, the job finding only a note',
    run(mk('machine'))[0].sev > run(mk('job'))[0].sev,
    `${run(mk('machine'))[0].sev} vs ${run(mk('job'))[0].sev}`);
}

console.log('\n--- refusals ---');
{
  const w = new Workloads(freshDir());
  w.add(null); w.add({}); w.add({ ts: 1, proc: null });
  check('a malformed tick is ignored, not counted', w.list().length === 0);
  w.add(tick(Date.now(), { proc: [{ cpu: 5 }] }));   // no name
  check('a nameless process makes no workload', w.list().length === 0);
  check('list() on an empty store is an empty array', Array.isArray(w.list()));
}

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* scratch */ }

console.log(`\n${fail ? fail + ' FAILED of ' : 'all '}${pass + fail} checks${fail ? '' : ' passed'} — the job and the machine are told apart, against the workload's own past.`);
process.exit(fail ? 1 : 0);
