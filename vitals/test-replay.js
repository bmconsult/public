/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - REWIND SUITE (B1).  node test-replay.js   (any platform)
 *
 * What this proves: the rule engine runs unmodified against the archive, a rewound diagnosis
 * reports what it COULD NOT ask, and the view refuses rather than fabricates.
 *
 * The tests that carry the weight are the negative ones. Rewind's failure mode is not a wrong
 * finding - it is a SHORT LIST that reads as a healthy machine, because every rule whose input was
 * never archived skips in silence. So the suite asserts the caveats exist as hard as it asserts the
 * findings do, and asserts that a moment with no record says so instead of returning an all-clear.
 *
 * Runs in a scratch directory against synthesised history. It must never read a real store.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { History } = require('./history');
const { diagnoseAt, tickAt, PastView } = require('./replay');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra !== undefined ? '  [' + extra + ']' : ''}`); }
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vitals-replay-'));
const freshDir = () => fs.mkdtempSync(path.join(ROOT, 'd-'));
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

const tick = (ts, o = {}) => ({
  ts,
  cpu: { total: o.cpu != null ? o.cpu : 10, cores: [o.core != null ? o.core : (o.cpu != null ? o.cpu : 10)] },
  mem: { pct: o.mem != null ? o.mem : 50, pagesSec: o.faults != null ? o.faults : 0, pressure: null,
         totalMB: 16000, committedMB: 8000, freeMB: 4000 },
  disk: { vols: [{ id: o.vol || 'C:', pct: o.diskPct != null ? o.diskPct : 40, freeGB: 200, sizeGB: 500 }],
          io: { busyPct: 1, queue: o.queue != null ? o.queue : 0, readMBs: 0, writeMBs: 0 } },
  net: { rxMBs: 0, txMBs: 0 },
  gpus: { max: 5 },
  gpu: { util: 5, temp: 50 },
});

/** Record `mins` minutes of history ending at `endMs`, at ~1 Hz. */
function record(h, endMs, mins, shape) {
  for (let m = mins; m >= 1; m--) {
    const base = endMs - m * 60_000;
    for (let i = 0; i < 58; i++) h.add(tick(base + i * 1000, shape(m, i)));
    h.flush();
    h.bucketStart = 0;
  }
}

console.log('--- a moment with no record says so, and does NOT report good health ---');
{
  const dir = freshDir();
  const h = new History(dir);
  const r = diagnoseAt(h, Date.now() - 10 * 86400_000);
  check('ok is false', r.ok === false);
  check('no findings are invented', r.findings.length === 0);
  check('the summary names the absence', /nothing was recorded/i.test(r.summary), r.summary);
  check('and it says plainly that absence is not health',
    /not a finding of good health|absence of evidence/i.test(r.note || ''), r.note);
}

console.log('\n--- the engine runs unmodified at a past moment and fires a real finding ---');
{
  const dir = freshDir();
  const h = new History(dir);
  const then = Date.now() - 4 * 3600_000;
  /* A disk that was genuinely full four hours ago, with memory sustained above the threshold -
     the compound spiral, which needs BOTH a tick field and a sustained-condition test. */
  record(h, then, 8, () => ({ diskPct: 96, mem: 88, faults: 400 }));

  const r = diagnoseAt(h, then - 60_000, { liveVolId: 'C:' });
  check('ok is true', r.ok === true, r.summary);
  check('it is marked as a rewind', r.rewind === true);
  check('it landed near the moment asked for', Math.abs(r.driftSec) < 180, r.driftSec);
  check('a finding fired from the archive', r.findings.length > 0,
    r.findings.map((f) => f.id).join(','));
  check('the COMPOUND rule fired — a sustained test answered from histograms',
    r.findings.some((f) => f.id === 'spiral'), r.findings.map((f) => f.id).join(','));
  check('history span is reported from the rows, not from zero', r.historySec > 60, r.historySec);
  check('and the warm-up gate passes on a well-recorded moment', r.ready === true);
}

console.log('\n--- it reports what it could NOT ask (the failure mode is silence) ---');
{
  const dir = freshDir();
  const h = new History(dir);
  const then = Date.now() - 2 * 3600_000;
  record(h, then, 8, () => ({ cpu: 20, mem: 40 }));
  const r = diagnoseAt(h, then - 60_000, { liveVolId: 'C:' });

  const has = (f) => r.unavailable.some((u) => u.field === f);
  check('the process list is declared unavailable', has('proc'));
  check('battery state is declared unavailable', has('pwr'));
  check('committed bytes are declared unavailable', has('mem.committedMB'));
  check('every entry says which rules it silences',
    r.unavailable.every((u) => typeof u.silences === 'string' && u.silences.length > 10));
  check('distributions ARE available here, so that caveat is absent',
    !has('distributions') && r.coverage.hasDistributions === true);
  check('a quiet result does not claim the machine was fine',
    !/nothing wrong that i can measure/i.test(r.summary), r.summary);
}

console.log('\n--- a pre-A2 moment loses the sustained rules, and is TOLD so ---');
{
  /* The upgrade case, and the sharpest version of the silence problem: v1 rows carry min/avg/max,
     from which a fraction-of-samples cannot be recovered at all. Every "has this held" rule skips.
     Measured on the real machine: two moments eighteen minutes apart gave a full compound finding
     and a single disk finding, purely because of which side of the upgrade they fell on. */
  const dir = freshDir();
  const then = Date.now() - 6 * 3600_000;
  const lines = [];
  for (let m = 8; m >= 1; m--) {
    lines.push(JSON.stringify({
      t: then - m * 60_000, n: 58,
      cpu: [10, 20, 30], mem: [86, 88, 90], hardFaults: [100, 400, 900],
      diskPct: [96, 96, 96], diskFreeGB: [9, 9, 9], diskQueue: [0, 0, 1], cpuMax: [20, 30, 40],
    }));
  }
  fs.writeFileSync(path.join(dir, `metrics-${dayKey(then)}.jsonl`), lines.join('\n') + '\n');

  const h = new History(dir);
  const r = diagnoseAt(h, then - 60_000, { liveVolId: 'C:' });
  check('the moment is still readable', r.ok === true, r.summary);
  check('coverage reports no distributions', r.coverage.hasDistributions === false,
    JSON.stringify(r.coverage));
  const d = r.unavailable.find((u) => u.field === 'distributions');
  check('and the report NAMES the loss rather than going quiet', !!d);
  check('the caveat explains what it silences', d && /sustained/i.test(d.silences), d && d.silences);
  check('the sustained-only rule (thrash) did NOT fire, as it cannot',
    !r.findings.some((f) => f.id === 'thrash'), r.findings.map((f) => f.id).join(','));
  check('but tick-based rules still do — the disk was measurably full',
    r.findings.some((f) => f.id === 'disk_low' || f.id === 'spiral'),
    r.findings.map((f) => f.id).join(','));
}

console.log('\n--- the volume label never reaches the prose as "null" ---');
{
  const dir = freshDir();
  const then = Date.now() - 3 * 3600_000;
  /* A v1-era row: numbers archived, the volume they describe not. */
  fs.writeFileSync(path.join(dir, `metrics-${dayKey(then)}.jsonl`),
    [...Array(6)].map((_, i) => JSON.stringify({
      t: then - (6 - i) * 60_000, n: 58, diskPct: [96, 96, 96], diskFreeGB: [9, 9, 9], mem: [40, 40, 40],
    })).join('\n') + '\n');
  const h = new History(dir);

  const withLive = diagnoseAt(h, then - 60_000, { liveVolId: 'D:' });
  check('the current mount is used when offered',
    withLive.findings.every((f) => !/null/.test(f.title)) && /D:/.test(withLive.summary),
    withLive.summary);
  check('and the inference is disclosed', /inferred/i.test(withLive.volFrom || ''), withLive.volFrom);

  const without = diagnoseAt(h, then - 60_000, {});
  check('with nothing to infer from, the prose stays readable and true',
    !/null/.test(without.summary) && /system volume/i.test(without.summary), without.summary);
  check('and that is disclosed too', /not archived/i.test(without.volFrom || ''), without.volFrom);

  /* Rows written after the label was archived should carry it. */
  const dir2 = freshDir();
  const h2 = new History(dir2);
  const t2 = Date.now() - 3600_000;
  record(h2, t2, 4, () => ({ vol: 'X:', diskPct: 96 }));
  const arch = diagnoseAt(h2, t2 - 60_000, {});
  check('a row written today carries its own volume label', arch.volFrom === 'archived', arch.volFrom);
  check('and the finding names it', /X:/.test(arch.summary), arch.summary);
}

console.log('\n--- no measured number is ever printed beside an unmeasured one ---');
{
  /* "22.6 GB free of undefined GB" reached the panel on the first rewind. Total capacity is not
     archived, and the evidence line interpolated it anyway - a real figure and a hole, rendered
     with identical confidence. The percentage IS archived and says the same thing. */
  const dir = freshDir();
  const h = new History(dir);
  const then = Date.now() - 2 * 3600_000;
  record(h, then, 6, () => ({ diskPct: 96 }));
  const r = diagnoseAt(h, then - 60_000, { liveVolId: 'C:' });
  const text = JSON.stringify(r.findings);
  check('no finding says "undefined"', !/undefined/.test(text), text.slice(0, 160));
  check('and the evidence still quantifies the disk', /GB free/.test(text));
}

console.log('\n--- the view refuses rather than fabricating a correlation ---');
{
  const dir = freshDir();
  const h = new History(dir);
  const then = Date.now() - 3600_000;
  record(h, then, 4, () => ({ cpu: 90, mem: 90 }));
  const v = new PastView(h, then - 60_000);

  const single = v.sustained('cpu', (x) => x >= 50, 120, 0.5);
  check('a single-metric predicate is answered', single !== null && single.frac >= 0.5, single && single.frac);
  check('and is marked as coming from the archive', single && single.fromArchive === true);

  /* Per-metric histograms cannot supply readings observed TOGETHER. Answering would invent a
     pairing nobody measured, so the view must decline and say why. */
  const joint = v.sustained('cpu', (x, s) => x >= 50 && s.mem >= 50, 120, 0.5);
  check('a two-metric predicate is REFUSED, not guessed', joint === null);
  check('and the refusal is recorded with a reason',
    v.refusals.length === 1 && /more than one metric/i.test(v.refusals[0].why),
    JSON.stringify(v.refusals));
}

console.log('\n--- the fraction recovered from bins matches the real one ---');
{
  const dir = freshDir();
  const h = new History(dir);
  const then = Date.now() - 3600_000;
  let seed = 99, rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const raw = [];
  for (let m = 4; m >= 1; m--) {
    const base = then - m * 60_000;
    for (let i = 0; i < 58; i++) {
      const v = rnd() < 0.65 ? 85 + rnd() * 10 : 40 + rnd() * 30;
      raw.push(v);
      h.add(tick(base + i * 1000, { mem: v }));
    }
    h.flush(); h.bucketStart = 0;
  }
  const v = new PastView(h, then);
  const got = v.sustained('mem', (x) => x >= 80, 300, 0.0);
  const want = raw.filter((x) => x >= 80).length / raw.length;
  check('the sustained fraction is within the histogram bound of the truth',
    got && Math.abs(got.frac - want) <= 0.02, got && `${got.frac.toFixed(4)} vs ${want.toFixed(4)}`);
  check('and it counts every archived sample', got && got.samples === raw.length,
    got && `${got.samples} vs ${raw.length}`);
}

console.log('\n--- refusals and edges ---');
{
  const dir = freshDir();
  const h = new History(dir);
  const then = Date.now() - 3600_000;
  record(h, then, 3, () => ({ cpu: 10 }));

  check('a moment far after the last row is not answered from it',
    diagnoseAt(h, Date.now()).ok === false || diagnoseAt(h, Date.now()).driftSec < 3600);
  check('tickAt returns null when nothing is near enough',
    tickAt(h, then - 10 * 86400_000) === null);
  const rec = tickAt(h, then - 60_000);
  check('the reconstructed tick omits what was never archived, rather than zeroing it',
    rec && rec.tick.mem.committedMB === undefined && rec.tick.proc === undefined,
    rec && JSON.stringify(Object.keys(rec.tick)));
  check('and populates what was', rec && typeof rec.tick.cpu.total === 'number');
}

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* scratch */ }

console.log(`\n${fail ? fail + ' FAILED of ' : 'all '}${pass + fail} checks${fail ? '' : ' passed'} — rewind answers from the record, and names what the record cannot answer.`);
process.exit(fail ? 1 : 0);
