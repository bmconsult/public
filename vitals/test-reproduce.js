/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - REPLAY SUITE (B7).  node test-reproduce.js   (any platform)
 *
 * This is the one module in the product that deliberately makes the machine worse, so the suite is
 * mostly about the BOUNDS rather than about the load. Almost every check below asserts that
 * something was refused, capped, or released.
 *
 * The load itself is exercised briefly and for real at the end - a stress tool that has never been
 * started is not a stress tool - but bounded to a few seconds on one worker, because a test suite
 * has no business saturating the machine it runs on either.
 */

const os = require('os');
const fs = require('fs');
const { Reproducer, profileFrom, MAX_SEC, MAX_DISK_MB, MIN_FREE_DISK_PCT, MAX_MEM_SHARE } = require('./reproduce');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra !== undefined ? '  [' + extra + ']' : ''}`); }
};

const tick = (o = {}) => ({
  ts: Date.now(),
  cpu: { total: 20, cores: [20] },
  mem: { pct: o.memPct != null ? o.memPct : 55, totalMB: 16000, pagesSec: 0 },
  disk: { vols: [{ id: 'C:', pct: o.diskPct != null ? o.diskPct : 40, freeGB: 200, sizeGB: 500 }],
          io: { queue: 0 } },
  net: {},
});

const profile = (o = {}) => ({
  from: Date.now() - 60000, to: Date.now(), seconds: o.seconds || 20,
  cpu: { p50: 40, p95: o.cpu != null ? o.cpu : 60, max: 90, n: 500 },
  mem: o.mem === null ? null : { p50: 60, p95: o.mem != null ? o.mem : 70, max: 80, n: 500 },
  io: o.io === null ? null : { p50: 2, p95: o.io != null ? o.io : 8, max: 40, n: 500 },
  describes: 'test profile',
});

console.log('--- it REFUSES to load a machine that is already in trouble ---');
{
  const r = new Reproducer();
  check('a nearly full disk is refused', /disk is/.test(r.refuse(tick({ diskPct: 95 })) || ''),
    r.refuse(tick({ diskPct: 95 })));
  check('and the refusal says why it would be an incident rather than a measurement',
    /incident, not the measurement/.test(r.refuse(tick({ diskPct: 95 })) || ''));
  check('memory already at the ceiling is refused', /memory is already/.test(r.refuse(tick({ memPct: 95 })) || ''));
  check('no live sample at all is refused', /cannot watch/.test(r.refuse(null) || ''));
  check('a healthy machine is allowed', r.refuse(tick()) === null);
}

console.log('\n--- the bounds are bounds, not suggestions ---');
{
  const r = new Reproducer();
  /* Captured BEFORE the ballast is allocated. The first version compared the ballast against
     os.freemem() read AFTER starting - so the allocation itself moved the number it was being
     judged against, and a correctly-sized ballast failed its own check. A budget measured after
     spending it is not a budget. */
  const freeBeforeMB = os.freemem() / 1048576;
  /* THE CONSTANTS ARE PINNED TO LITERALS FIRST, and that is the whole point of these two lines.
     Every bound below used to be asserted against the constant imported from the module under test
     - `remainingSec <= MAX_SEC` - so raising MAX_SEC to 99999 raised the bar with it and the suite
     stayed green. A section titled "the bounds are bounds, not suggestions" was asserting that the
     module agrees with itself. A bound is a POLICY; changing it should require changing the test
     deliberately, which is what a literal forces. */
  check('the time cap is two minutes, and moving it must break this test', MAX_SEC === 120, MAX_SEC);
  check('the memory share is a quarter of free, likewise', MAX_MEM_SHARE === 0.25, MAX_MEM_SHARE);
  check('and the disk cap is 512 MB', MAX_DISK_MB === 512, MAX_DISK_MB);

  const started = r.start(profile({ seconds: 99999 }), tick(), { seconds: 99999 });
  check('a request for forever is capped', started.ok && started.remainingSec <= 120,
    started.remainingSec);
  check('it never takes every core', r.running.workers <= os.cpus().length - 1,
    `${r.running.workers} of ${os.cpus().length}`);
  check('memory ballast is a share of what was FREE, not of what was recorded',
    r.running.memMB <= Math.round(freeBeforeMB * 0.25) + 1,
    `${r.running.memMB} MB of a ${Math.round(freeBeforeMB * 0.25)} MB budget`);
  const st = r.status();
  check('status reports what it is doing', st.running === true && st.threadsRequested > 0);
  check('and NAMES the requested figure as requested, never as achieved',
    'threadsRequested' in st && !('workers' in st),
    'the old key read as "7 of 8 cores loaded" — a number nothing had measured');
  check('and repeats the caveat in every payload', /resource PRESSURE, not the programs/.test(st.caveat));
  r.stop('test');
  check('stopping releases the ballast', r.running === null);
}

console.log('\n--- one at a time, and always stoppable ---');
{
  const r = new Reproducer();
  r.start(profile(), tick(), { seconds: 10 });
  const second = r.start(profile(), tick(), { seconds: 10 });
  check('a second replay is refused while one runs', second.ok === false && /already running/.test(second.error));
  const s = r.stop('by hand');
  check('stop reports how long it ran and why it ended', s.ok === true && typeof s.ranSec === 'number' && s.why === 'by hand');
  check('stopping twice is harmless', r.stop('again').ok === false);
  check('the last run is remembered for comparison', r.status().last && r.status().last.why === 'by hand');
}

console.log('\n--- a profile is built from percentiles, and refuses without them ---');
{
  const fake = {
    percentiles: (key, a, b) => key === 'cpu'
      ? { q: { '0.5': 30, '0.95': 72 }, max: 95, n: 400 }
      : { q: { '0.5': 1, '0.95': 4 }, max: 9, n: 400 },
  };
  const p = profileFrom(fake, Date.now() - 60000, Date.now());
  check('a profile comes out of the record', p !== null && p.cpu.p95 === 72);
  check('it describes itself in words for the panel', /cpu p95 72%/.test(p.describes), p.describes);
  check('the window length is carried', p.seconds === 60, p.seconds);

  const empty = { percentiles: () => null };
  check('a window with no record yields no profile', profileFrom(empty, 0, 1) === null);
  const thin = { percentiles: () => ({ q: {}, max: 0, n: 0 }) };
  check('and neither does one with zero samples', profileFrom(thin, 0, 1) === null);
}

console.log('\n--- the disk cap is enforced, and the temp file is cleaned up ---');
{
  const r = new Reproducer();
  r.start(profile({ io: 50 }), tick(), { seconds: 8 });
  const f = r.running.tmpFile;
  check('a temp file path is chosen inside the temp directory', !!f && f.includes(os.tmpdir()));
  setTimeout(() => {
    const grew = f && fs.existsSync(f);
    const sizeMB = grew ? fs.statSync(f).size / 1048576 : 0;
    check('the temp file is written to', grew, f);
    check('and never exceeds the hard cap', sizeMB <= 512 + 2, `${sizeMB.toFixed(1)} MB`);
    r.stop('test');
    check('the temp file is deleted on stop', !fs.existsSync(f), f);
    afterDisk();
  }, 1200);
}

function afterDisk() {
  /* THE TWO CHECKS THAT WOULD HAVE CAUGHT THE ORIGINAL BUG, and neither existed.
   *
   * The first version burned CPU with setInterval callbacks on the caller's own event loop. Both
   * failures below are structural, so both assertions are things a single thread CANNOT pass:
   * serialized callbacks cannot exceed 1.0 cores no matter how many "workers" are claimed, and a
   * loop busy burning cannot also be servicing timers.
   *
   * A moderate target on purpose - 4 threads at 50% duty, about 2 cores - because a suite has no
   * business saturating the machine it runs on, and 1.3 cores is already impossible to fake. */
  console.log('\n--- the load is REAL PARALLELISM, which is the bug the first version had ---');
  const r = new Reproducer();
  const p = profile({ cpu: 50, mem: null, io: null });
  const started = r.start(p, tick(), { seconds: 4 });
  check('it starts', started.ok === true);
  check('more than one thread was asked for', r.running.workers > 1, `${r.running.workers} threads`);

  /* Event-loop lag, sampled while the load runs. This is the "the panel keeps rendering" promise,
     asserted instead of asserted-in-a-comment: the bridge serves the dashboard off this loop. */
  let worstLagMs = 0;
  let due = Date.now() + 25;
  const lagTimer = setInterval(() => {
    const now = Date.now();
    worstLagMs = Math.max(worstLagMs, now - due);
    due = now + 25;
  }, 25);

  setTimeout(() => {
    clearInterval(lagTimer);
    const st = r.status();
    check('the load DELIVERS more than one core — impossible on a single event loop',
      st.deliveredCores > 1.3, `${st.deliveredCores} cores delivered, ${st.deliveredPctOfMachine}% of the machine`);
    check('and the event loop stays responsive while it does',
      worstLagMs < 250, `worst timer lag ${worstLagMs} ms (the old version blocked for ~1030 ms)`);
    check('status reports delivered and requested SEPARATELY, so neither is mistaken for the other',
      st.deliveredCores != null && st.threadsRequested != null);
    check('and it repeats the caveat in every payload', /resource PRESSURE, not the programs/.test(st.caveat));

    const s = r.stop('test');
    check('stop reports what was actually delivered, not what was asked for',
      typeof s.deliveredCores === 'number' && s.deliveredCores > 1.3, s.deliveredCores);

    const after0 = process.cpuUsage();
    setTimeout(() => {
      const idle = process.cpuUsage(after0);
      const idleMs = (idle.user + idle.system) / 1000;
      /* process.cpuUsage() is process-wide on both platforms, so a worker thread that outlived
         terminate() would show up here. That is the point of the check. */
      check('and every thread STOPS burning once stopped', idleMs < 200, `${idleMs.toFixed(0)} ms after stop`);
      console.log(`\n${fail ? fail + ' FAILED of ' : 'all '}${pass + fail} checks${fail ? '' : ' passed'} — the bounds hold, and the load is real.`);
      process.exit(fail ? 1 : 0);
    }, 1200);
  }, 3000);
}
