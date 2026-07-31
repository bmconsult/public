/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* END-TO-END test of the Linux collector on a real Linux kernel.
 *
 * test-linux.js checks the PARSERS against captured text. This one runs the whole plug - timers,
 * statfs, /sys walks, differencing, the lot - and then checks each field against an INDEPENDENT
 * source, because a collector agreeing with itself proves nothing.
 *
 *   node collect/test-linux-live.js
 */
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

if (process.platform !== 'linux') {
  console.error('This must run ON Linux. Current platform: ' + process.platform);
  process.exit(2);
}

const { start } = require('./linux');
let fails = 0, checks = 0;
function check(label, ok, detail) {
  checks++; if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`);
}
function sh(c) { try { return execSync(c, { encoding: 'utf8' }).trim(); } catch { return ''; } }

console.log(`host: ${os.hostname()}  kernel ${os.release()}  node ${process.versions.node}`);
console.log('collecting for 4 seconds...\n');

let statics = null;
const ticks = [];
const h = start(__dirname + '/..', {
  onStatic: (m) => { statics = m; },
  onTick: (m) => { ticks.push(m); },
  onError: (e) => console.log('  collector error: ' + e),
});

/* Generate some genuine load so the counters are not all zero - a collector that reports 0% on an
   idle box is indistinguishable from one that is broken. */
const spin = setInterval(() => { let x = 0; for (let i = 0; i < 6e6; i++) x += i; }, 200);

setTimeout(() => {
  clearInterval(spin);
  h.stop();

  console.log('--- static ---');
  check('static event arrived', !!statics);
  if (statics) {
    console.log(`  cpu: ${statics.cpu}`);
    console.log(`  ${statics.cores} cores / ${statics.threads} threads, ${statics.ramMB} MB, ${statics.os}`);
    const nproc = +sh('nproc') || 0;
    check('threads matches nproc', statics.threads === nproc, `${statics.threads} vs nproc ${nproc}`);
    const memKB = +(/MemTotal:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8')) || [])[1];
    check('ramMB matches /proc/meminfo', Math.abs(statics.ramMB - memKB / 1024) < 2,
      `${statics.ramMB} vs ${Math.round(memKB / 1024)}`);
    check('hostname matches', statics.host === sh('hostname'), statics.host);
  }

  console.log(`\n--- ticks: ${ticks.length} received ---`);
  check('at least 2 ticks', ticks.length >= 2, `${ticks.length} in 4s`);
  if (!ticks.length) { done(); return; }
  const t = ticks[ticks.length - 1];

  console.log('\n--- cpu ---');
  console.log(`  total ${t.cpu.total}%   cores [${t.cpu.cores.join(', ')}]`);
  check('cpu.total in 0..100', t.cpu.total >= 0 && t.cpu.total <= 100, t.cpu.total + '%');
  check('cpu.total > 0 under load', t.cpu.total > 0, 'we were spinning a loop');
  check('per-core count matches nproc', t.cpu.cores.length === (+sh('nproc') || 0));
  check('no core exceeds 100', t.cpu.cores.every((c) => c <= 100));

  console.log('\n--- memory ---');
  console.log(`  ${t.mem.usedMB} MB used of ${t.mem.totalMB} (${t.mem.pct}%), cache ${t.mem.cacheMB} MB, faults ${t.mem.pagesSec}/s`);
  const freeOut = sh('free -m');
  console.log('  free -m says:\n    ' + freeOut.split('\n').slice(0, 2).join('\n    '));
  const fm = /Mem:\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+\S+\s+(\d+)/.exec(freeOut);
  if (fm) {
    /* `free` computes used as total-available too, so the two should land within a few MB of each
       other. A large gap means one of us is using MemFree, and that one is wrong. */
    const freeAvail = +fm[4];
    const freeUsed = +fm[1] - freeAvail;
    check('usedMB agrees with `free -m` (total-available)', Math.abs(t.mem.usedMB - freeUsed) < 40,
      `collector ${t.mem.usedMB} vs free ${freeUsed}`);
  }
  check('pct is consistent with usedMB/totalMB',
    Math.abs(t.mem.pct - (t.mem.usedMB / t.mem.totalMB * 100)) < 0.2);
  check('pagesSec is a number, not null', typeof t.mem.pagesSec === 'number', String(t.mem.pagesSec));

  console.log('\n--- volumes ---');
  for (const v of t.disk.vols) console.log(`  ${v.id}  ${v.freeGB}/${v.sizeGB} GB free (${v.pct}% used) ${v.fs || ''}`);
  check('at least one volume', t.disk.vols.length > 0);
  const root = t.disk.vols.find((v) => v.id === '/');
  check('root volume present', !!root);
  if (root) {
    const dfOut = sh("df -B1 / | tail -1");
    const dp = dfOut.split(/\s+/);
    const dfFreeGB = +dp[3] / 1073741824;
    console.log(`  df says / has ${dfFreeGB.toFixed(1)} GB available`);
    check('root freeGB agrees with df', Math.abs(root.freeGB - dfFreeGB) < 0.5,
      `collector ${root.freeGB} vs df ${dfFreeGB.toFixed(1)}`);
  }
  check('no pseudo-filesystem leaked in',
    !t.disk.vols.some((v) => ['tmpfs', 'devtmpfs', 'proc', 'sysfs'].includes(v.fs)));

  console.log('\n--- disk io ---');
  console.log(`  read ${t.disk.io.readMBs} MB/s  write ${t.disk.io.writeMBs} MB/s  busy ${t.disk.io.busyPct}%  queue ${t.disk.io.queue}`);
  check('io rates are non-negative numbers',
    t.disk.io.readMBs >= 0 && t.disk.io.writeMBs >= 0 && t.disk.io.busyPct >= 0);
  check('busyPct <= 100', t.disk.io.busyPct <= 100);

  console.log('\n--- network ---');
  console.log(`  rx ${t.net.rxMBs} MB/s  tx ${t.net.txMBs} MB/s`);
  check('net rates non-negative', t.net.rxMBs >= 0 && t.net.txMBs >= 0);

  console.log('\n--- processes ---');
  console.log('  ' + t.proc.slice(0, 5).map((p) => `${p.n} ${p.mb}MB ${p.cpu}%`).join('  |  '));
  check('proc list non-empty', t.proc.length > 0);
  check('proc sorted by memory descending',
    t.proc.every((p, i) => i === 0 || t.proc[i - 1].mb >= p.mb));
  check('this node process appears', t.proc.some((p) => p.n === 'node'));
  /* THE CORE HONESTY CHECK: fields this platform cannot measure must be null, never 0. A zero here
     would be a fabricated measurement, which is the exact failure the whole caps design prevents. */
  check('proc.io fields are NULL not 0 (root-only on Linux)',
    t.proc.every((p) => p.ioMBs === null && p.rMBs === null && p.wMBs === null));

  console.log('\n--- power / gpu / temps ---');
  console.log(`  pwr: ${JSON.stringify(t.pwr)}`);
  console.log(`  gpus: ${JSON.stringify(t.gpus)}`);
  console.log(`  temps: ${JSON.stringify(t.temps)}`);
  const hasBat = fs.existsSync('/sys/class/power_supply') &&
    fs.readdirSync('/sys/class/power_supply').length > 0;
  check('battery presence matches /sys reality', t.pwr.bat === hasBat,
    `reports bat=${t.pwr.bat}, /sys has ${hasBat ? 'a supply' : 'none'}`);

  console.log('\n--- uptime ---');
  const upH = parseFloat(fs.readFileSync('/proc/uptime', 'utf8')) / 3600;
  check('uptime matches /proc/uptime', Math.abs(t.up - upH) < 0.1, `${t.up}h vs ${upH.toFixed(2)}h`);

  console.log('\n--- shape compatibility with the Windows contract ---');
  for (const k of ['t', 'ts', 'cpu', 'mem', 'disk', 'net', 'proc', 'pwr', 'self', 'up']) {
    check(`tick has .${k}`, k in t);
  }
  check('.t is "tick"', t.t === 'tick');
  check('.ts is a plausible epoch ms', t.ts > 1.7e12 && t.ts < 2.5e12);

  done();
}, 4200);

function done() {
  console.log(`\n${fails ? fails + ' FAILED of ' + checks : 'all ' + checks + ' checks passed'}`);
  process.exit(fails ? 1 : 0);
}
