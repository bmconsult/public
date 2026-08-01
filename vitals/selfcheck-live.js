/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - THE AGREEMENT RECORD, taken on a real machine.
 *
 *   node selfcheck-live.js [--samples 16]
 *
 * `test-selfcheck.js` proves the fold is right using stubs, and says so at the top: it can be green
 * on a platform where the two sources are secretly the same file. THIS runs the real collector
 * against the real second source and publishes what they actually did.
 *
 * That distinction is why `self.verify` is false for darwin in collect/caps.js despite the code
 * being complete there. A flag in that file means OBSERVED WORKING on that platform, and the thing
 * to observe is this output - not the suite passing, and not the code existing.
 *
 * Exit status: nonzero if any independent source reported a disagreement, OR if too few samples
 * arrived to say anything. "We could not check" and "we checked and it was fine" are different
 * results and only one of them is worth a green tick.
 */

const { collector } = require('./collect');
const { SelfCheck } = require('./selfcheck');

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d;
};
const SAMPLES = arg('samples', 16);

const c = collector();
const sc = new SelfCheck();
let latest = null, taken = 0, done = false;

console.log(`VITALS self-check, live on ${process.platform} (${c.caps.name})`);
console.log(`capability self.verify: ${JSON.stringify(c.caps.caps['self.verify'])}  (declared before this run — the point is whether it holds)`);
console.log('\nplan:');
for (const p of sc.plan()) {
  console.log(`  ${p.independent ? 'RUN ' : 'SKIP'}  ${p.label.padEnd(18)} ${p.method}`);
}
console.log(`\ncollecting ${SAMPLES} samples...\n`);

const handle = c.start(process.cwd(), {
  onTick: (t) => { latest = t; },
  onError: (e) => console.log('  collector error: ' + e),
});

/* Sequential, never overlapping: each check spans a second of its own, and two in flight would be
   sampling each other's window. */
(async () => {
  const t0 = Date.now();
  while (taken < SAMPLES && Date.now() - t0 < 180000) {
    await new Promise((r) => setTimeout(r, 700));
    if (!latest) continue;
    const r = await sc.check(latest);
    if (r) {
      taken++;
      const line = r.rows.map((x) => `${x.label}: ${x.detail}`).join('   ');
      console.log(`  ${String(taken).padStart(2)}  ${line}`);
    }
  }
  done = true;
  finish();
})();

function finish() {
  try { handle.stop(); } catch {}
  const s = sc.summary();
  let bad = 0, ran = 0;

  console.log('\n--- agreement record ---');
  for (const src of s.sources) {
    if (!src.independent) {
      console.log(`  SKIP  ${src.label.padEnd(18)} not independent here — ${src.method}`);
      continue;
    }
    ran++;
    const verdict = src.healthy === true ? 'AGREES' : src.healthy === false ? 'DISAGREES' : 'too few samples';
    const nums = src.compare === 'bound'
      ? `${src.violations} violations in ${src.samples}`
      : `median ${src.median != null ? src.median.toFixed(1) : '—'} · p95 ${src.p95 != null ? src.p95.toFixed(1) : '—'} · tolerance ${src.tolerance} (n=${src.samples})`;
    console.log(`  ${src.healthy === false ? 'FAIL' : src.healthy === true ? 'PASS' : 'WAIT'}  ${src.label.padEnd(18)} ${verdict.padEnd(16)} ${nums}`);
    if (src.healthy !== true) bad++;
  }

  if (!ran) {
    console.log('\nNo independent comparison exists on this platform. Nothing was checked, and that\n' +
                'is the honest result — not a pass.');
    process.exit(1);
  }
  console.log(`\n${bad ? bad + ' of ' + ran + ' sources did not report agreement' : 'all ' + ran + ' independent sources agree'}` +
              ` — ${taken} samples on ${process.platform}.`);
  console.log(bad
    ? 'Do NOT flip self.verify on the strength of this run.'
    : 'This output is the evidence for self.verify in collect/caps.js. Paste the run URL beside it.');
  process.exit(bad ? 1 : 0);
}

/* A collector that never ticks must not hang CI forever. */
setTimeout(() => { if (!done) { console.log('\nTIMED OUT waiting for ticks.'); finish(); } }, 190000).unref();
