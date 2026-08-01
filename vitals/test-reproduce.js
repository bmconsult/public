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
  const started = r.start(profile({ seconds: 99999 }), tick(), { seconds: 99999 });
  check('a request for forever is capped', started.ok && started.remainingSec <= MAX_SEC,
    started.remainingSec);
  check('it never takes every core', r.running.workers <= os.cpus().length - 1,
    `${r.running.workers} of ${os.cpus().length}`);
  check('memory ballast is a share of what is FREE, not of what was recorded',
    r.running.memMB <= Math.round((os.freemem() / 1048576) * MAX_MEM_SHARE) + 1,
    `${r.running.memMB} MB`);
  const st = r.status();
  check('status reports what it is doing', st.running === true && st.workers > 0);
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
    check('and never exceeds the hard cap', sizeMB <= MAX_DISK_MB + 2, `${sizeMB.toFixed(1)} MB`);
    r.stop('test');
    check('the temp file is deleted on stop', !fs.existsSync(f), f);
    afterDisk();
  }, 1200);
}

function afterDisk() {
  console.log('\n--- it actually applies load, briefly and on one worker ---');
  const r = new Reproducer();
  /* A modest, short burst: enough to prove the loop runs, bounded so the suite is not itself a
     stress test. A stress tool that has never been started is not a stress tool. */
  const p = profile({ cpu: 25, mem: null, io: null });
  const started = r.start(p, tick(), { seconds: 3 });
  check('it starts', started.ok === true);
  const t0 = process.cpuUsage();
  setTimeout(() => {
    const used = process.cpuUsage(t0);
    const cpuMs = (used.user + used.system) / 1000;
    check('measurable CPU was actually burned', cpuMs > 150, `${cpuMs.toFixed(0)} ms of CPU in 1.5 s`);
    r.stop('test');
    const after0 = process.cpuUsage();
    setTimeout(() => {
      const idle = process.cpuUsage(after0);
      const idleMs = (idle.user + idle.system) / 1000;
      check('and it STOPS burning once stopped', idleMs < 120, `${idleMs.toFixed(0)} ms after stop`);
      console.log(`\n${fail ? fail + ' FAILED of ' : 'all '}${pass + fail} checks${fail ? '' : ' passed'} — the bounds hold, and the load is real.`);
      process.exit(fail ? 1 : 0);
    }, 1200);
  }, 1500);
}
