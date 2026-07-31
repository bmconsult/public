/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* STIMULUS test: does the Linux collector actually MOVE when the machine does?
 *
 * The live test proves the collector agrees with df, free and nproc while the box is idle. That is
 * necessary but weak: a collector hard-wired to return plausible constants would pass it. This one
 * applies a KNOWN load and checks the number goes where it should - the difference between "reads
 * something" and "reads reality".
 *
 * Three stimuli, each with an independent expectation:
 *   CPU   - saturate every logical core for 3 s. Expect total to climb near 100 and stay there.
 *   DISK  - write and fsync ~200 MB. Expect writeMBs > 0 while it happens.
 *   NET   - pull a few MB over HTTPS. Expect rxMBs > 0 while it happens.
 *
 *   node collect/test-linux-stimulus.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const https = require('https');

if (process.platform !== 'linux') { console.error('Linux only.'); process.exit(2); }

const { start } = require('./linux');
let fails = 0, checks = 0;
function check(label, ok, detail) {
  checks++; if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`);
}

const ticks = [];
const h = start(path.join(__dirname, '..'), {
  onStatic: () => {}, onTick: (m) => ticks.push(m), onError: (e) => console.log('  err ' + e),
});
const mark = () => ticks.length;
const since = (i) => ticks.slice(i);

/* Burn every core in child processes, so the collector's own event loop is not the thing being
   measured - a busy parent would inflate the reading through the very process doing the reading. */
function burnCPU(ms) {
  const kids = [];
  const script = path.join(os.tmpdir(), 'vitals-burn.js');
  fs.writeFileSync(script, 'const e=Date.now()+ +process.argv[2];let x=0;while(Date.now()<e){x+=Math.sqrt(x+1)}');
  for (let i = 0; i < os.cpus().length; i++) kids.push(fork(script, [String(ms)], { stdio: 'ignore' }));
  return new Promise((r) => setTimeout(() => { kids.forEach((k) => { try { k.kill(); } catch {} }); r(); }, ms + 300));
}

function burnDisk(mb) {
  return new Promise((r) => {
    const f = path.join(os.tmpdir(), 'vitals-io-test.bin');
    const buf = Buffer.alloc(4 << 20, 7);
    const fd = fs.openSync(f, 'w');
    for (let i = 0; i < mb / 4; i++) fs.writeSync(fd, buf);
    fs.fsyncSync(fd);            // force it to the device, or the page cache absorbs everything
    fs.closeSync(fd);
    try { fs.unlinkSync(f); } catch {}
    setTimeout(r, 200);
  });
}

function burnNet() {
  return new Promise((r) => {
    let got = 0;
    const req = https.get('https://nodejs.org/dist/index.json', (res) => {
      res.on('data', (c) => { got += c.length; });
      res.on('end', () => setTimeout(() => r(got), 200));
    });
    req.on('error', () => r(0));
    req.setTimeout(15000, () => { req.destroy(); r(got); });
  });
}

(async () => {
  console.log(`${os.cpus().length} logical cores, kernel ${os.release()}\n`);
  await new Promise((r) => setTimeout(r, 2500));     // baseline + let the first diff settle

  const idle = ticks.slice(-2).map((t) => t.cpu.total);
  console.log(`idle cpu samples: ${idle.join(', ')}%`);

  console.log('\n--- CPU: saturating all cores for 3s ---');
  let m = mark();
  await burnCPU(3000);
  const during = since(m).map((t) => t.cpu.total);
  const peak = Math.max(...during, 0);
  const base = Math.max(...idle, 0);
  console.log(`  cpu during load: ${during.join(', ')}%   peak ${peak}%   (baseline ${base}%)`);
  check('cpu rose above 70% under full load', peak > 70, `peak ${peak}%`);
  /* HEADROOM-AWARE, and this took two flaky runs to get right. The original assertion was
     `peak > baseline + 40`, which is unsatisfiable whenever the baseline is already above 60 -
     peak is capped at 100. That happens for a real reason here: this box is a VM sharing physical
     cores with a Windows host, so when the host is saturated the guest's own idle reading is
     genuinely high. The collector was correct on every one of those runs; the TEST was asserting
     something arithmetically impossible.
     Requiring the climb to reach toward the CEILING rather than a fixed distance above the floor
     keeps the check meaningful on a quiet machine and honest on a contended one. */
  const target = Math.min(95, base + 40);
  check('cpu climbed toward the ceiling from its baseline', peak >= target,
    `peak ${peak}% vs target ${target}% (baseline ${base}%)`);
  if (base > 50) {
    console.log(`  NOTE  baseline was ${base}% - this host is contended, so the CPU headroom check ` +
                `was correspondingly relaxed. On a quiet machine it demands baseline+40.`);
  }
  const cores = since(m).map((t) => Math.min(...t.cpu.cores));
  check('EVERY core registered load (min core > 40%)', Math.max(...cores, 0) > 40,
    `best-case min-core ${Math.max(...cores, 0)}%`);

  await new Promise((r) => setTimeout(r, 2200));

  console.log('\n--- DISK: writing + fsyncing 200 MB ---');
  m = mark();
  await burnDisk(200);
  /* OBSERVATION WINDOWS ARE DELIBERATELY GENEROUS. The collector samples at 1 Hz, so a burst that
     finishes just after a tick boundary is attributed to the NEXT tick. Waiting only ~1 interval
     means a burst can land outside the window and the check fails while the collector is perfectly
     correct - a flaky test that would eventually be "fixed" by loosening a threshold that was never
     wrong. Two full intervals plus slack removes the race instead of hiding it. */
  await new Promise((r) => setTimeout(r, 2600));
  const w = since(m).map((t) => t.disk.io.writeMBs);
  const busy = since(m).map((t) => t.disk.io.busyPct);
  console.log(`  writeMBs: ${w.join(', ')}   busyPct: ${busy.join(', ')}`);
  check('writeMBs registered the write', Math.max(...w, 0) > 1, `peak ${Math.max(...w, 0)} MB/s`);
  check('busyPct registered the write', Math.max(...busy, 0) > 0, `peak ${Math.max(...busy, 0)}%`);

  await new Promise((r) => setTimeout(r, 1500));

  console.log('\n--- NET: downloading over HTTPS ---');
  m = mark();
  const bytes = await burnNet();
  await new Promise((r) => setTimeout(r, 2600));       // same boundary race as the disk window above
  const rx = since(m).map((t) => t.net.rxMBs);
  console.log(`  fetched ${(bytes / 1048576).toFixed(2)} MB   rxMBs: ${rx.join(', ')}`);
  if (bytes > 200000) {
    check('rxMBs registered the download', Math.max(...rx, 0) > 0, `peak ${Math.max(...rx, 0)} MB/s`);
  } else {
    console.log('  SKIP  network check - fetched too little to be measurable');
  }

  h.stop();
  console.log(`\n${fails ? fails + ' FAILED of ' + checks : 'all ' + checks + ' stimulus checks passed'}`);
  process.exit(fails ? 1 : 0);
})();
