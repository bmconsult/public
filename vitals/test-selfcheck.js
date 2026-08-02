/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - SELF-CHECK SUITE.  node test-selfcheck.js   (any platform)
 *
 * What this proves: the FOLD is right - independence gating, the bound invariant, median-based
 * verdicts, the refusal to judge on too few samples, the refusal to invent a reading, and that
 * the tolerances are large enough to survive the collector's own rounding.
 *
 * What it cannot prove: that os.freemem() and the collector really are different code paths on a
 * given kernel. That is a claim about libuv and the OS, and the live suites plus CI are where it
 * gets exercised. Said plainly here so a green run is not mistaken for the stronger claim.
 *
 * Runs with windowMs:0 so the suite does not pay a real second per sample. That is the ONLY thing
 * it stubs about timing - the arithmetic under test is identical either way.
 */

const { SelfCheck, REFS, _cpuPctBetween } = require('./selfcheck');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra !== undefined ? '  [' + extra + ']' : ''}`); }
};

const sc = (plat) => new SelfCheck(plat, { windowMs: 0 });

const tick = (o = {}) => ({
  cpu: { total: o.cpu != null ? o.cpu : 40, cores: [] },
  mem: { freeMB: o.freeMB != null ? o.freeMB : 4000, totalMB: 16000, pct: 75 },
  up: o.up != null ? o.up : 10,
});

async function main() {
console.log('--- independence gating ---');
{
  const lin = sc('linux').plan();
  const win = sc('win32').plan();
  const mac = sc('darwin').plan();
  const ind = (p, k) => p.find((x) => x.key === k).independent;
  check('linux cpu declared DEPENDENT (libuv reads the same /proc/stat)', ind(lin, 'cpuPct') === false);
  check('linux memory still independent (sysinfo vs /proc/meminfo)', ind(lin, 'memAvailMB') === true);
  check('win32 cpu independent (NtQuerySystemInformation vs perf counter)', ind(win, 'cpuPct') === true);
  check('darwin cpu independent (host_processor_info vs iostat)', ind(mac, 'cpuPct') === true);
  check('a dependent source is still DESCRIBED, not hidden',
    lin.find((x) => x.key === 'cpuPct').method.includes('same file'));
}

console.log('\n--- the bound invariant, WHERE IT HOLDS: linux and darwin ---');
{
  /* linux, not win32. On Windows os.freemem() is ullAvailPhys, which already counts the standby
     list - the same quantity the collector reports - so there is no bound there to test, and that
     platform is compared as a delta instead. Written against win32 this test would have stayed
     green while asserting something the product had stopped claiming. */
  const s = sc('linux');
  /* Drive the comparison directly rather than through os.freemem(), so the test controls both
     sides. A test that reads the live machine cannot assert a violation on demand. */
  const os = require('os');
  const realFree = os.freemem;
  os.freemem = () => 8000 * 1048576;              // reference says 8000 MB free

  await s.check(tick({ freeMB: 9000 }));           // available above free: legal
  let r = s.summary().sources.find((x) => x.key === 'memAvailMB');
  check('available > free passes', r.violations === 0 && r.healthy === true, JSON.stringify(r.last));

  await s.check(tick({ freeMB: 100 }));            // available BELOW free: impossible
  r = s.summary().sources.find((x) => x.key === 'memAvailMB');
  check('available < free is a violation', r.violations === 1, JSON.stringify(r.last));
  check('one violation makes the source unhealthy', r.healthy === false);
  check('a bound source reports violations, not a median', r.median === null);

  /* THE CASE CI FOUND, pinned so it cannot come back.
     MemAvailable is roughly MemFree − watermark_low + reclaimable/2. On a machine with little page
     cache the watermark term dominates and available sits legitimately BELOW free. The first cut
     asserted a hard `available ≥ free` and the very first Linux CI run reported 16 violations in
     16 samples, 8–23 MB each — correct kernel behaviour, wrong invariant. The bound is one-sided
     with slack scaled to installed RAM. */
  const s2 = sc('linux');
  os.freemem = () => 14963 * 1048576;
  await s2.check(tick({ freeMB: 14940 }));           // 23 MB below free, exactly as CI measured
  let r2 = s2.summary().sources.find((x) => x.key === 'memAvailMB');
  check('available just below free is the kernel reserve, not a defect',
    r2.violations === 0, JSON.stringify(r2.last));
  check('and the detail says so rather than reporting a bare failure',
    /within the .* reserve/.test((r2.last && r2.last.detail) || ''), r2.last && r2.last.detail);

  const s3 = sc('linux');
  await s3.check(tick({ freeMB: 8000 }));            // 7 GB below free: structural, not a watermark
  const r3 = s3.summary().sources.find((x) => x.key === 'memAvailMB');
  check('but a structural gap is STILL caught', r3.violations === 1, JSON.stringify(r3.last));

  os.freemem = realFree;
}

console.log('\n--- one metric, two comparisons, because it is two quantities ---');
{
  const cmp = (plat) => sc(plat).plan().find((x) => x.key === 'memAvailMB');
  check('linux memory is a bound', cmp('linux').compare === 'bound');
  check('darwin memory is a bound', cmp('darwin').compare === 'bound');
  check('win32 memory is a DELTA (ullAvailPhys already counts standby)', cmp('win32').compare === 'delta');
  check('a bound carries no tolerance - it is exact or it is broken', cmp('linux').tolerance == null);
  check('the delta carries one', cmp('win32').tolerance > 0, cmp('win32').tolerance);

  const os = require('os');
  const realFree = os.freemem;
  os.freemem = () => 1800 * 1048576;

  /* 90 MB BELOW free - the largest excursion seen in the 45-sample measurement on real hardware.
     Must not flag on Windows. Under the old bound this was 21 violations in 45. */
  const s = sc('win32');
  for (let i = 0; i < 14; i++) await s.check(tick({ freeMB: 1710 }));
  let r = s.summary().sources.find((x) => x.key === 'memAvailMB');
  check('a measured-size excursion below free is not a win32 defect', r.healthy === true, `median=${r.median}`);
  check('and it is not counted as a bound violation', r.violations === null);

  /* Reporting TOTAL where available was meant: the structural error the tolerance exists for. */
  const s2 = sc('win32');
  for (let i = 0; i < 14; i++) await s2.check(tick({ freeMB: 16000 }));
  r = s2.summary().sources.find((x) => x.key === 'memAvailMB');
  check('reading the wrong quantity entirely IS caught', r.healthy === false, `median=${r.median}`);

  os.freemem = realFree;
}

console.log('\n--- median verdict, and the refusal to judge too early ---');
{
  const os = require('os');
  const realCpus = os.cpus;
  let idle = 0, busy = 0;
  /* Synthesise a reference CPU that always reports 50%: every call advances idle by 50 and busy by
     50, so ANY two consecutive snapshots difference to exactly 50%. That property is what makes
     this stub valid under the windowed reader, which takes two snapshots per check. */
  os.cpus = () => [{ times: { user: (busy += 50), nice: 0, sys: 0, idle: (idle += 50), irq: 0 } }];

  const s = sc('win32');
  for (let i = 0; i < 6; i++) await s.check(tick({ cpu: 50 }));
  let r = s.summary().sources.find((x) => x.key === 'cpuPct');
  check('below the sample floor the verdict is WITHHELD, not granted',
    r.samples > 0 && r.healthy === null, `samples=${r.samples} healthy=${r.healthy}`);
  check('the numbers are still shown while the verdict waits', r.median !== null);

  for (let i = 0; i < 20; i++) await s.check(tick({ cpu: 50 }));
  r = s.summary().sources.find((x) => x.key === 'cpuPct');
  check('with enough agreeing samples it reports healthy', r.healthy === true, `median=${r.median}`);
  check('median of an agreeing pair is ~0', r.median != null && r.median < 2, r.median);

  /* Now break the collector side: a path reading the wrong CPU set would sit far off, every time. */
  const bad = sc('win32');
  for (let i = 0; i < 26; i++) await bad.check(tick({ cpu: 95 }));
  const b = bad.summary().sources.find((x) => x.key === 'cpuPct');
  check('a structurally wrong path is caught by the median', b.healthy === false, `median=${b.median}`);

  os.cpus = realCpus;
}

console.log('\n--- the reference must span the collector\'s window, not its own ---');
{
  /* The regression this guards. A cumulative-tick reader differenced over a LONG window produces a
     long-window average; the collector reports a one-second sample. Differencing those two is a
     category error that reads as a large disagreement on a healthy machine. Here: a machine that
     was idle for 19 s then busy for 1 s. The one-second window sees ~100%; a twenty-second window
     sees ~5%. Same kernel, same counters, and the wrong one is off by 95 points. */
  const idleThenBusy = (a, b) => _cpuPctBetween(a, b);
  const t0 = { idle: 0, total: 0 };
  const t19 = { idle: 1900, total: 2000 };          // 19 s mostly idle
  const t20 = { idle: 1900, total: 2100 };          // then one fully busy second
  const shortWin = idleThenBusy(t19, t20);
  const longWin = idleThenBusy(t0, t20);
  check('a one-second window sees the busy second', shortWin > 95, shortWin);
  check('a twenty-second window does NOT', longWin < 15, longWin);
  check('the two differ by enough to have looked like a defect',
    Math.abs(shortWin - longWin) > REFS.cpuPct.medianTolerance * 4,
    `${shortWin.toFixed(0)} vs ${longWin.toFixed(0)}`);
}

console.log('\n--- tolerances must clear the collector\'s own rounding ---');
{
  /* tick.up is reported in hours to one decimal, so perfect agreement can still show 180 s of
     difference. A tolerance below that flags arithmetic as a defect - which is exactly what the
     first cut did, at 120 s. */
  const QUANT_SEC = 0.1 * 3600 / 2;                 // half a step, worst case
  check('uptime tolerance clears 0.1 h of quantisation',
    REFS.uptimeSec.medianTolerance > QUANT_SEC, `${REFS.uptimeSec.medianTolerance} vs ${QUANT_SEC}`);

  const s = sc('win32');
  const os = require('os');
  const realUp = os.uptime;
  os.uptime = () => 10 * 3600 + 175;                // 175 s off: pure rounding, must NOT flag
  for (let i = 0; i < 14; i++) await s.check(tick({ up: 10 }));
  let r = s.summary().sources.find((x) => x.key === 'uptimeSec');
  check('a rounding-sized uptime gap is not a disagreement', r.healthy === true, `median=${r.median}`);

  const s2 = sc('win32');
  os.uptime = () => 10 * 3600 + 3600;               // an hour out: a real defect
  for (let i = 0; i < 14; i++) await s2.check(tick({ up: 10 }));
  r = s2.summary().sources.find((x) => x.key === 'uptimeSec');
  check('an hour of disagreement IS caught', r.healthy === false, `median=${r.median}`);
  os.uptime = realUp;
}

console.log('\n--- the cadence warms up, then gets out of the way ---');
{
  const os = require('os');
  const realCpus = os.cpus;
  let idle = 0, busy = 0;
  os.cpus = () => [{ times: { user: (busy += 50), nice: 0, sys: 0, idle: (idle += 50), irq: 0 } }];

  const s = sc('win32');
  const hits = (from, to) => { let n = 0; for (let i = from; i <= to; i++) if (s.due(i)) n++; return n; };
  const cold = hits(1, 60);
  check('cold, it checks often enough to reach a verdict in minutes', cold >= 15, `${cold} in 60 ticks`);

  for (let i = 0; i < 14; i++) await s.check(tick({ cpu: 50 }));
  const warm = hits(1, 60);
  check('warm, it backs off', warm <= 4, `${warm} in 60 ticks`);
  check('but it never stops - a path can come loose later', warm >= 1);

  /* The floor is on the THINNEST source, not the total: three sources at four samples each is not
     twelve samples of evidence about any of them. */
  const s2 = sc('win32');
  await s2.check(tick());
  check('depth counts the weakest source, not the sum', s2.depth() === 1, s2.depth());

  os.cpus = realCpus;
}

console.log('\n--- refusals ---');
{
  const s = sc('win32');
  check('no tick yields null, not an empty verdict', (await s.check(null)) === null);
  const s0 = s.summary();
  check('before any sample the overall verdict is null, not "fine"', s0.healthy === null, s0.healthy);
  check('rate is not reported as 100% with zero samples', s0.samples === 0);

  const missing = await s.check({ cpu: {}, mem: {}, up: undefined });
  check('a tick with nothing comparable produces no sample', missing === null || missing.rows.length === 0);
}

console.log('\n--- every tolerance carries its measurement ---');
for (const [k, r] of Object.entries(REFS)) {
  check(`${k} states where its tolerance came from`, typeof r.measured === 'string' && r.measured.length > 10);
}

console.log('\n--- INDEPENDENCE IS A CLAIM ABOUT SYSCALLS, AND IT IS PINNED HERE ---');
{
  /* darwin's uptime leg was declared independent on the strength of the method string saying
     "sysctl kern.boottime". The collector reaches it with os.uptime() (collect/darwin.js:612) and
     so did the check - one function agreeing with itself, which duly reported a 107 s "agreement"
     against a 240 s tolerance on live CI hardware and read as evidence.
     Nothing in this suite noticed, and flipping it back to `true` still leaves every other check
     green. So the declarations are pinned to literals: changing one has to be deliberate, and the
     comment naming the source file has to be re-read before it can be changed. */
  const ind = REFS.uptimeSec.independent;
  check('darwin uptime is NOT an independent path — both sides are os.uptime()',
    ind.darwin === false, JSON.stringify(ind));
  check('linux uptime likewise — libuv reads the /proc/uptime the collector reads',
    ind.linux === false, JSON.stringify(ind));
  check('win32 uptime IS independent — Win32_OperatingSystem.LastBootUpTime vs GetTickCount64',
    ind.win32 === true, JSON.stringify(ind));
  check('and every declared leg is an explicit boolean, never an absent key read as false',
    ['win32', 'linux', 'darwin'].every((k) => typeof ind[k] === 'boolean'), JSON.stringify(ind));

  /* WHETHER THE CLAIM WAS CHECKED IS ITSELF A CLAIM, and it is tracked separately from whether the
     comparison runs. The linux memory leg reads `independent: true` because the comparison is worth
     running either way; whether the reference route is genuinely separate is NOT established (libuv
     >= 1.45 may read the same /proc/meminfo the collector does), so it carries null and says so.
     Overloading `independent` to express that doubt would have switched the comparison off, which
     throws away the best check on the platform to make a point about a word. */
  const ver = REFS.memAvailMB.independenceVerified;
  check('memory independence is VERIFIED on win32 and darwin', ver.win32 === true && ver.darwin === true,
    JSON.stringify(ver));
  check('and explicitly NOT ESTABLISHED on linux — assumed, not checked', ver.linux === null,
    JSON.stringify(ver));
  check('while the comparison still RUNS there, because it is worth running either way',
    REFS.memAvailMB.independent.linux === true);

  /* AN ABSENT RECORD IS NOT A VERIFIED ONE. plan() defaulted a missing `independenceVerified` map
     to `true` — so cpuPct and uptimeSec, which have no map, were published as "both routes read and
     confirmed different" on the strength of nothing. That is the darwin bug again, one level up, in
     the function that exists to express the distinction. Asserted per row so a new REF cannot
     inherit a claim by omission. */
  /* Asserted on all three platforms, because the default is what leaks and it leaks per-platform. */
  for (const plat of ['win32', 'linux', 'darwin']) {
    const plan = sc(plat).plan();
    const byKey = Object.fromEntries(plan.map((r) => [r.key, r]));
    check(`${plat}: a row with no independenceVerified record reports null, not true`,
      byKey.cpuPct.independenceVerified === null && byKey.uptimeSec.independenceVerified === null,
      JSON.stringify(plan.map((r) => [r.key, r.independenceVerified])));
    check(`${plat}: the row that HAS a record still reports exactly what it says`,
      byKey.memAvailMB.independenceVerified === REFS.memAvailMB.independenceVerified[plat],
      `${byKey.memAvailMB.independenceVerified} vs ${REFS.memAvailMB.independenceVerified[plat]}`);
    check(`${plat}: no row claims verified independence without a record saying so`,
      plan.every((r) => r.independenceVerified !== true || !!REFS[r.key].independenceVerified),
      JSON.stringify(plan.map((r) => [r.key, r.independenceVerified])));
  }
}

console.log(`\n${fail ? fail + ' FAILED of ' : 'all '}${pass + fail} checks${fail ? '' : ' passed'} — the FOLD is right; independence itself is a claim CI exercises.`);
process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
