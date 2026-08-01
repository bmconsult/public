/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - STORAGE SUBSTRATE SUITE (A2).  node test-history.js   (any platform)
 *
 * What this proves: v2 rollups round-trip through the disk with their distributions intact, v1 rows
 * written by earlier builds are still read, the two formats coexist inside one query window, and
 * compaction never removes a source it has not first read back.
 *
 * The two tests that matter most are the unglamorous ones:
 *   - the MIXED WINDOW. Every machine that upgrades has one day-file in the old format and the next
 *     in the new, sitting inside the same 90-day query. A reader that silently assumed one format
 *     would be wrong for half the range and report no error at all.
 *   - COMPACTION ORDER. Write, verify, then unlink. A compaction that deletes before confirming is
 *     a data-loss bug that only ever appears on a machine you do not own.
 *
 * Runs entirely in a scratch directory. It must never read or write a real history store.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { History } = require('./history');
const { Hist } = require('./hist');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra !== undefined ? '  [' + extra + ']' : ''}`); }
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vitals-hist-'));
const freshDir = () => fs.mkdtempSync(path.join(ROOT, 'd-'));
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

/* A tick shaped like the collector's, so History.add() exercises the real extraction path. */
const tick = (ts, o = {}) => ({
  ts,
  cpu: { total: o.cpu != null ? o.cpu : 10, cores: [o.cpu != null ? o.cpu : 10] },
  mem: { pct: o.mem != null ? o.mem : 60, pagesSec: o.faults != null ? o.faults : 0, pressure: null },
  disk: { vols: [{ id: 'C:', pct: 50, freeGB: 100 }], io: { busyPct: 1, queue: 0, readMBs: 0, writeMBs: 0 } },
  net: { rxMBs: 0, txMBs: 0 },
  gpus: { max: o.gpu != null ? o.gpu : 5 },
  gpu: { util: 5, temp: 50 },
});

let seed = 4242;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

console.log('--- a minute of ticks becomes a v2 row with its distribution intact ---');
{
  const dir = freshDir();
  const h = new History(dir);
  const t0 = Date.now() - 3600_000;
  const raw = [];
  for (let i = 0; i < 120; i++) {
    /* 5% long frames: the shape a mean cannot see and the reason for the format change. */
    const v = rnd() < 0.95 ? 8 + rnd() * 2 : 90 + rnd() * 40;
    raw.push(v);
    h.add(tick(t0 + i * 500, { cpu: v }));
  }
  h.flush();

  const rows = h.range(2);
  check('a row was written', rows.length >= 1, `${rows.length} rows`);
  check('it declares itself v2', rows[0] && rows[0].v === 2, rows[0] && rows[0].v);

  const d = History.distOf(rows[0], 'cpu');
  check('the row yields a distribution', d instanceof Hist && d.n > 0, d && d.n);

  const sorted = [...raw].sort((a, b) => a - b);
  const trueP95 = sorted[Math.floor(0.95 * sorted.length)];
  const gotP95 = d ? d.quantile(0.95) : null;
  check('p95 survives the disk round trip to within 2%',
    gotP95 != null && Math.abs(gotP95 - trueP95) / trueP95 <= 0.02,
    `${gotP95} vs ${trueP95.toFixed(2)}`);

  const t = History.tripleOf(rows[0], 'cpu');
  const trueAvg = raw.reduce((a, b) => a + b, 0) / raw.length;
  check('the v1 triple is still derivable, with an EXACT average',
    t && Math.abs(t[1] - trueAvg) < 0.01, t && `${t[1]} vs ${trueAvg.toFixed(3)}`);
  check('and its min/max are the real extremes',
    t && Math.abs(t[0] - Math.min(...raw)) < 0.01 && Math.abs(t[2] - Math.max(...raw)) < 0.01);
}

console.log('\n--- v1 rows from an earlier build are still read, and never faked into a distribution ---');
{
  const dir = freshDir();
  const yest = Date.now() - 86400_000;
  fs.writeFileSync(path.join(dir, `metrics-${dayKey(yest)}.jsonl`),
    JSON.stringify({ t: yest, n: 58, cpu: [7, 14.76, 24], mem: [80, 80.5, 81.6] }) + '\n');
  const h = new History(dir);
  const rows = h.range(3);
  check('the old row is read, not skipped', rows.length === 1);
  check('its triple comes back verbatim', String(History.tripleOf(rows[0], 'cpu')) === '7,14.76,24');
  check('and it yields NO distribution rather than an invented one',
    History.distOf(rows[0], 'cpu') === null);
}

console.log('\n--- the mixed window: one format either side of the upgrade, inside one query ---');
{
  const dir = freshDir();
  const twoAgo = Date.now() - 2 * 86400_000;
  /* Yesterday in the old format... */
  fs.writeFileSync(path.join(dir, `metrics-${dayKey(twoAgo)}.jsonl`),
    [0, 1, 2].map((i) => JSON.stringify({ t: twoAgo + i * 60000, n: 58, cpu: [5, 10, 15] })).join('\n') + '\n');

  /* ...and today in the new one. */
  const h = new History(dir);
  const now = Date.now() - 600_000;
  for (let i = 0; i < 60; i++) h.add(tick(now + i * 1000, { cpu: 40 + rnd() * 2 }));
  h.flush();

  const p = h.percentiles('cpu', twoAgo - 3600_000, Date.now());
  check('the query spans both formats and still answers', p !== null);
  check('it reports that part of the window had no distribution', p && p.v1Rows === 3, p && p.v1Rows);
  check('and says so plainly rather than implying full coverage', p && p.covered === false);
  check('the percentile it DOES give comes only from v2 rows',
    p && p.q['0.5'] > 35 && p.q['0.5'] < 45, p && p.q['0.5']);

  /* The trap this section exists for: on a v2 row, index 1 is the MAX, not the average. An
     unversioned `r[key][1]` would fit a trend through the wrong statistic and draw a confident
     line describing nothing. */
  const rows = h.range(4);
  const v2row = rows.find((r) => r.v === 2);
  check('index 1 of a raw v2 row is NOT the average (the trap)',
    v2row && Math.abs(v2row.cpu[1] - History.tripleOf(v2row, 'cpu')[1]) > 0.5,
    v2row && `raw[1]=${v2row.cpu[1]} avg=${History.tripleOf(v2row, 'cpu')[1]}`);
  const tr = h.trend('cpu', 4);
  check('trend() reads the average from both formats', tr !== null && tr.n >= 2, tr && tr.n);
}

console.log('\n--- distributions merge across day boundaries, which is the whole substrate ---');
{
  const dir = freshDir();
  const h = new History(dir);
  const all = [];
  /* Three days of minute buckets with varying sample counts, as the real collector's rate drifts. */
  for (let d = 3; d >= 1; d--) {
    for (let m = 0; m < 5; m++) {
      const base = Date.now() - d * 86400_000 + m * 60_000;
      const n = 20 + Math.floor(rnd() * 40);
      for (let i = 0; i < n; i++) {
        const v = rnd() < 0.9 ? rnd() * 30 : 70 + rnd() * 30;
        all.push(v);
        h.add(tick(base + i * 900, { cpu: v }));
      }
      h.flush();
      h.bucketStart = 0;
    }
  }
  const p = h.percentiles('cpu', Date.now() - 4 * 86400_000, Date.now(), [0.5, 0.95]);
  check('every sample across three days is accounted for', p && p.n === all.length,
    p && `${p.n} vs ${all.length}`);
  const sorted = [...all].sort((a, b) => a - b);
  const truth = (q) => sorted[Math.floor(q * sorted.length)];
  check('p50 across the whole span is within 2% of the raw truth',
    p && Math.abs(p.q['0.5'] - truth(0.5)) / truth(0.5) <= 0.02, p && `${p.q['0.5']} vs ${truth(0.5).toFixed(2)}`);
  check('p95 across the whole span is within 2% of the raw truth',
    p && Math.abs(p.q['0.95'] - truth(0.95)) / truth(0.95) <= 0.02, p && `${p.q['0.95']} vs ${truth(0.95).toFixed(2)}`);
  check('min and max are exact across the merge',
    p && Math.abs(p.min - Math.min(...all)) < 0.01 && Math.abs(p.max - Math.max(...all)) < 0.01);
}

console.log('\n--- compaction: yesterday is archived, today is never touched ---');
{
  const dir = freshDir();
  const yest = dayKey(Date.now() - 86400_000);
  const today = dayKey(Date.now());
  const body = [...Array(200)].map((_, i) =>
    JSON.stringify({ t: Date.now() - 86400_000 + i * 60000, n: 58, v: 2, cpu: [5, 25, 58, 900, 0, 0, [80, 4, 20, 30, 4]] })).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, `metrics-${yest}.jsonl`), body);
  fs.writeFileSync(path.join(dir, `metrics-${today}.jsonl`), body);

  const h = new History(dir);                    // compaction runs in the constructor
  check('yesterday was compacted', fs.existsSync(path.join(dir, `metrics-${yest}.jsonl.gz`)));
  check('and its plain file removed', !fs.existsSync(path.join(dir, `metrics-${yest}.jsonl`)));
  check("TODAY'S file is untouched — append-only crash safety outranks 1.5 MB",
    fs.existsSync(path.join(dir, `metrics-${today}.jsonl`))
    && !fs.existsSync(path.join(dir, `metrics-${today}.jsonl.gz`)));
  check('no .tmp is left behind', !fs.readdirSync(dir).some((f) => f.endsWith('.tmp')),
    fs.readdirSync(dir).join(','));

  const packed = fs.statSync(path.join(dir, `metrics-${yest}.jsonl.gz`)).size;
  check('the archive is materially smaller', packed < body.length * 0.5,
    `${packed} vs ${body.length}`);
  check('the archive reads back byte-identical',
    zlib.gunzipSync(fs.readFileSync(path.join(dir, `metrics-${yest}.jsonl.gz`))).toString() === body);

  const rows = h.range(3);
  check('a compacted day is transparent to range()', rows.length === 400, `${rows.length}`);

  /* Idempotent: a second construction must not re-compact or double-archive. */
  const again = new History(dir).compact();
  check('compaction is idempotent', again.files === 0, `${again.files}`);

  /* It must DECLINE when compressing would not help. A gzip header is ~20 bytes, so a day-file of
     one row comes out larger; compacting it spends a rename and a delete to lose bytes and give up
     the plain file's readability. A size optimisation should refuse when it is not one. */
  const tiny = freshDir();
  const tinySrc = path.join(tiny, `metrics-${yest}.jsonl`);
  fs.writeFileSync(tinySrc, '{"t":1,"n":1,"v":2}\n');
  const t = new History(tiny).compact();
  check('a file gzip would ENLARGE is left alone', t.files === 0 && fs.existsSync(tinySrc),
    `files=${t.files} src=${fs.existsSync(tinySrc)}`);
  check('and no archive is written for it', !fs.existsSync(tinySrc + '.gz'));
  check('savings are never reported as negative', t.savedBytes >= 0, t.savedBytes);
}

console.log('\n--- compaction refuses rather than risking the source ---');
{
  const dir = freshDir();
  const yest = dayKey(Date.now() - 86400_000);
  const src = path.join(dir, `metrics-${yest}.jsonl`);
  fs.writeFileSync(src, JSON.stringify({ t: Date.now() - 86400_000, n: 1, v: 2 }) + '\n');

  /* Force the verification to fail, and assert the SOURCE SURVIVES. The order write-verify-unlink
     is the only thing standing between a bad archive and a lost day. */
  const realGunzip = zlib.gunzipSync;
  zlib.gunzipSync = () => Buffer.from('corrupted');
  const r = new History(dir).compact();
  zlib.gunzipSync = realGunzip;

  check('a failed verification compacts nothing', r.files === 0);
  check('and the source file is STILL THERE', fs.existsSync(src));
  check('with no half-written archive left', !fs.existsSync(src + '.gz') && !fs.existsSync(src + '.gz.tmp'),
    fs.readdirSync(dir).join(','));
}

console.log('\n--- pruning covers archives too ---');
{
  const dir = freshDir();
  const old = dayKey(Date.now() - 200 * 86400_000);
  fs.writeFileSync(path.join(dir, `metrics-${old}.jsonl.gz`), zlib.gzipSync('{}\n'));
  fs.writeFileSync(path.join(dir, `metrics-${dayKey(Date.now() - 86400_000)}.jsonl.gz`), zlib.gzipSync('{}\n'));
  new History(dir);
  check('a 200-day-old ARCHIVE is pruned, not just a plain file',
    !fs.existsSync(path.join(dir, `metrics-${old}.jsonl.gz`)));
  check('a recent archive is kept',
    fs.existsSync(path.join(dir, `metrics-${dayKey(Date.now() - 86400_000)}.jsonl.gz`)));
}

console.log('\n--- the live ring fills holes anywhere, not just the tail ---');
{
  /* The regression this guards. A window whose stored rows are v1 - which is every window during an
     upgrade - describes nothing, while the ring holds the same period at full resolution. Skipping
     ring samples "because a stored bucket covers them" threw that away: measured on the real machine
     it answered a one-hour window with 98 samples instead of ~3,600. */
  const dir = freshDir();
  const h = new History(dir);
  const t0 = Date.now() - 1800_000;
  const mins = 20;
  fs.writeFileSync(path.join(dir, `metrics-${dayKey(t0)}.jsonl`),
    [...Array(mins)].map((_, i) => JSON.stringify({ t: t0 + i * 60000, n: 58, cpu: [5, 10, 15] })).join('\n') + '\n');

  const raw = [];
  for (let i = 0; i < mins * 60; i++) {
    const v = 40 + rnd() * 10;
    raw.push(v);
    h.ring.push({ ts: t0 + i * 1000, cpu: v });     // the same period, at full resolution
  }

  const p = h.percentiles('cpu', t0 - 1000, Date.now());
  check('the ring answers a period the stored rows cannot describe',
    p && p.n === raw.length, p && `${p.n} vs ${raw.length}`);
  check('and that period is no longer reported as a hole', p && p.v1Rows === 0, p && p.v1Rows);
  check('so the window reports itself COVERED', p && p.covered === true);
  const sorted = [...raw].sort((a, b) => a - b);
  check('the percentile comes from the ring, not the v1 triple',
    p && Math.abs(p.q['0.5'] - sorted[Math.floor(0.5 * sorted.length)]) / sorted[Math.floor(0.5 * sorted.length)] <= 0.02,
    p && p.q['0.5']);

  /* But a v2 bucket must NOT be double-counted when the ring still holds the same samples. */
  const dir2 = freshDir();
  const h2 = new History(dir2);
  const t1 = Date.now() - 300_000;
  for (let i = 0; i < 60; i++) h2.add(tick(t1 + i * 1000, { cpu: 30 }));
  h2.flush();                                        // 60 samples now stored AND still in the ring
  const p2 = h2.percentiles('cpu', t1 - 1000, Date.now());
  check('samples already in a v2 bucket are not counted twice', p2 && p2.n === 60, p2 && p2.n);
}

console.log('\n--- refusals ---');
{
  const dir = freshDir();
  const h = new History(dir);
  check('percentiles over an empty store is null, not zero',
    h.percentiles('cpu', Date.now() - 3600_000, Date.now()) === null);
  check('dist for an unknown key is null', h.dist('nosuchkey', 0, Date.now()) === null);

  /* A field that is null for the first ticks of a minute and real afterwards must still be
     recorded. Taking the key list from the first sample alone dropped it for the whole minute. */
  const t0 = Date.now();
  h.add(tick(t0, {}));
  const late = tick(t0 + 1000, {});
  late.mem.pressure = 42;
  h.add(late);
  h.flush();
  const row = h.range(1)[0];
  check('a field appearing mid-minute is still recorded',
    row && row.pressure != null, row && Object.keys(row).join(','));

  const unreadable = freshDir();
  fs.writeFileSync(path.join(unreadable, `metrics-${dayKey(Date.now() - 86400_000)}.jsonl.gz`),
    Buffer.from('not actually gzip'));
  const h2 = new History(unreadable);
  check('one corrupt archive costs that day, not the whole range', Array.isArray(h2.range(3)));
}

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* scratch */ }

console.log(`\n${fail ? fail + ' FAILED of ' : 'all '}${pass + fail} checks${fail ? '' : ' passed'} — distributions survive the disk; both formats coexist.`);
process.exit(fail ? 1 : 0);
