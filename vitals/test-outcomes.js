/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - OUTCOMES LEDGER SUITE (B18).  node test-outcomes.js   (any platform)
 *
 * THIS FILE EXISTS BECAUSE THE MODULE HAD NO SUITE AT ALL, and that absence let a bounded-growth
 * claim ship on an unbounded file.
 *
 * `_trim()` and its constants were written, and the evidence offered for them was a script that
 * called `_trim()` directly on a 250k-line ledger. It trimmed correctly. Nothing invoked it: the
 * line in `_write()` that increments the counter and fires the ceiling was lost when a patch failed
 * its own assertion, so a ledger at 210,000 lines took fifty more appends and reached 210,050.
 * Review found it by appending through the real path rather than calling the function.
 *
 * So every check below drives the PUBLIC path — construct, record, replay — and never reaches for a
 * private helper to prove a public promise. That is the whole point of the file.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Outcomes } = require('./outcomes');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra !== undefined ? '  [' + extra + ']' : ''}`); }
};

/* EVERY TEMP DIR IS REGISTERED AND REMOVED ON EXIT, however the run ends. The first version relied
   on an rmSync at the end of each block, so an interrupted run leaked its ledgers — three abandoned
   copies totalling 26 MB were found afterwards on a disk this product itself reports at 97% full,
   and they were enough to make a later batch run fail. A suite that can leave rubbish behind when
   it is killed will eventually be killed. */
const MADE = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vitals-oc-')); MADE.push(d); return d; };
process.on('exit', () => { for (const d of MADE) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

/* The trim logs to stderr by design — useful in production, noise here where the ceiling is 200 and
   fires on nearly every append. Silenced only around the block that provokes it. */
const quiet = (fn) => { const e = console.error; console.error = () => {}; try { return fn(); } finally { console.error = e; } };
const lines = (d) => {
  try { return fs.readFileSync(path.join(d, 'outcomes.jsonl'), 'utf8').trim().split('\n').filter(Boolean); }
  catch { return []; }
};

console.log('--- THE CEILING, EXERCISED THROUGH _write() AND NEVER BY CALLING _trim() ---');
{
  const d = tmp();
  /* Seeded just under the ceiling so a handful of ordinary appends must cross it. Reading the
     constants from the module would let a mutation move the goalposts, so this asserts the SHAPE:
     the file must stop growing, whatever the numbers are. */
  const { MAX_LINES: SHIPPED_MAX, KEEP_LINES: SHIPPED_KEEP } = require('./outcomes');
  check('the SHIPPED ceiling is the one the module documents',
    SHIPPED_MAX === 200_000 && SHIPPED_KEEP === 150_000 && SHIPPED_KEEP < SHIPPED_MAX,
    `${SHIPPED_MAX} / ${SHIPPED_KEEP}`);

  /* THE SAME CODE PATH AT A SCALE THAT COSTS NOTHING. Seeding 200,000 real rows to reach the
     shipped ceiling wrote 10 MB per run and leaked it whenever the run was interrupted — three
     abandoned copies totalling 26 MB were found on a disk this product itself reports at 97% full,
     and they were enough to make the suite fail in a batch run. The bound is injected instead: the
     append path, the counter, the trim and the replay are all identical, only the numbers are
     small. */
  const MAX_LINES = 200, KEEP_LINES = 150;

  const seed = Array.from({ length: MAX_LINES - 5 },
    (_, i) => JSON.stringify({ ev: 'fired', id: 'old' + i, at: 1 })).join('\n') + '\n';
  fs.writeFileSync(path.join(d, 'outcomes.jsonl'), seed);

  const o = new Outcomes(d, { maxLines: MAX_LINES, keepLines: KEEP_LINES });
  check('replay counts what is already on disk', o._lines === MAX_LINES - 5, o._lines);

  /* Through the PUBLIC path — observe() is what the bridge calls every 30 s. Each pass presents one
     new finding, so each writes one `fired` row. */
  quiet(() => {
    for (let i = 0; i < 50; i++) {
      o.observe({ ready: true, findings: [{ id: 'x' + i, title: 't', sevName: 'critical' }] }, null);
    }
  });
  /* Each pass writes TWO rows: the new finding fires, and the previous one — now absent from the
     list — clears. So 50 passes is about 100 rows, which is why the bound is stated as "below the
     ceiling and near the trim target" rather than as an exact count. */
  /* BOUNDED ON BOTH SIDES. Review pointed out that an upper bound alone lets a trim-to-empty
     mutation (`kept = []`) pass green — the file would "stop growing" by being destroyed, which is
     a far worse outcome than the unbounded growth this was added to prevent. A ledger that trims
     itself to nothing is not a ceiling working, it is the product's memory being deleted. */
  const after = lines(d).length;
  check('appending past the ceiling TRIMS — the growth is actually bounded',
    after < MAX_LINES && after <= KEEP_LINES + 60,
    `${after} lines · ceiling ${MAX_LINES} · target ${KEEP_LINES}`);
  check('and the trim KEPT the history rather than emptying the file',
    after > KEEP_LINES - 5 && after > KEEP_LINES / 2,
    `${after} lines — a trim to near-zero is data loss, not a working ceiling`);
  const all = lines(d).join('\n');
  check('the OLDEST entries are the ones dropped', !/"old0"/.test(all));
  check('and the newest survived', /x49/.test(all));
  check('the in-memory counter agrees with the file afterwards', o._lines === after,
    `${o._lines} vs ${after}`);

  /* And the ledger must still be readable — a trim that corrupts the store is worse than growth. */
  const reopened = new Outcomes(d, { maxLines: MAX_LINES, keepLines: KEEP_LINES });
  check('the trimmed ledger still replays without throwing', reopened._lines === after, reopened._lines);
  fs.rmSync(d, { recursive: true, force: true });
}

console.log('\n--- an ordinary ledger is NOT trimmed ---');
{
  const d = tmp();
  const o = new Outcomes(d);
  for (let i = 0; i < 200; i++) {
    o.observe({ ready: true, findings: [{ id: 'a' + i, title: 't', sevName: 'critical' }] }, null);
  }
  /* 200 fired + 199 cleared = 399 rows, every one kept. The exact number matters less than the
     property: nothing below the ceiling is ever discarded. */
  const n = lines(d).length;
  check('an ordinary ledger keeps every row — the ceiling is a ceiling, not a retention policy',
    n === 399 && n < require('./outcomes').MAX_LINES, `${n} rows`);
  fs.rmSync(d, { recursive: true, force: true });
}

console.log('\n--- the metric snapshot is null-honest, on every platform shape ---');
{
  const d = tmp();
  const o = new Outcomes(d);
  const linuxTick = { cpu: { total: 12 }, mem: { pct: 44, pagesSec: 0 },
                      disk: { vols: [{ id: '/', freeGB: 87, sizeGB: 500 }], io: { queue: 1 } } };
  const m = o.metricsOf(linuxTick);
  /* The Windows-only `id === 'C:'` selector recorded freeGB: undefined for every row on Linux and
     macOS while the record looked complete. */
  check('a Linux-shaped tick resolves the ROOT volume, not a hard-coded C:', m.freeGB === 87,
    JSON.stringify(m));
  check('a hard-fault rate of ZERO is preserved as zero — it is a real, common reading',
    m.flt === 0, JSON.stringify(m));

  const noFaults = o.metricsOf({ cpu: { total: 12 }, mem: { pct: 44 },
                                 disk: { vols: [{ id: '/', freeGB: 87 }], io: { queue: 1 } } });
  check('but an ABSENT hard-fault rate is null, never 0 — `|| 0` collapsed the two',
    noFaults.flt === null, JSON.stringify(noFaults));

  check('no volume at all yields null rather than a fabricated figure',
    o.metricsOf({ cpu: { total: 1 }, mem: { pct: 2 }, disk: { vols: [], io: {} } }).freeGB === null);
  check('and no tick at all yields an empty record', JSON.stringify(o.metricsOf(null)) === '{}');
  fs.rmSync(d, { recursive: true, force: true });
}

console.log('\n--- a fire/clear cycle is recorded and replays identically ---');
{
  const d = tmp();
  const o = new Outcomes(d);
  const tick = { cpu: { total: 50 }, mem: { pct: 80, pagesSec: 5 },
                 disk: { vols: [{ id: 'C:', freeGB: 20, sizeGB: 500 }], io: { queue: 2 } } };
  o.observe({ ready: true, findings: [{ id: 'disk_low', title: 'C: is low', sevName: 'critical' }] }, tick);
  o.observe({ ready: true, findings: [] },
            { ...tick, disk: { vols: [{ id: 'C:', freeGB: 60, sizeGB: 500 }], io: { queue: 0 } } });

  const before = o.last.disk_low;
  check('a completed cycle is remembered', !!before && typeof before.durSec === 'number');
  const reopened = new Outcomes(d);
  check('and survives a restart with the same shape',
    JSON.stringify(reopened.last.disk_low) === JSON.stringify(before),
    JSON.stringify(reopened.last.disk_low));
  fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\n${fail ? fail + ' FAILED of ' : 'all '}${pass + fail} checks${fail ? '' : ' passed'} — the ceiling is exercised through the append path, not by calling the trimmer.`);
process.exit(fail ? 1 : 0);
