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

  console.log('\n--- per-device rows (disk.perDevice) ---');
  console.log('  ' + JSON.stringify(t.disk.devices));
  /* The 2026-07-31 bridge sample proved these arrays are EMITTED; these checks demand the rows
     themselves, cross-named against /sys/block - the last step before caps.js may say true. */
  const wholeDisks = fs.readdirSync('/sys/block').filter((d) => !/^(loop|ram|zram|dm-|sr)/.test(d));
  check('devices array is populated (this host has ' + wholeDisks.length + ' whole disks)',
    Array.isArray(t.disk.devices) && t.disk.devices.length === wholeDisks.length,
    `${t.disk.devices.length} rows`);
  check('every device row is named from /sys/block, with numeric rates',
    t.disk.devices.every((d) => wholeDisks.includes(d.id)
      && d.readMBs >= 0 && d.writeMBs >= 0 && d.busyPct >= 0 && d.busyPct <= 100));

  console.log('\n--- network ---');
  console.log(`  rx ${t.net.rxMBs} MB/s  tx ${t.net.txMBs} MB/s   ifaces ${JSON.stringify(t.net.ifaces)}`);
  check('net rates non-negative', t.net.rxMBs >= 0 && t.net.txMBs >= 0);
  /* Same promotion test for net.perInterface: rows present, named from /proc/net/dev, and every
     rate either measured or null (a NIC's first sample) - never the string "undefined". */
  const kernelNics = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)
    .map((l) => (/^\s*([\w.@-]+):/.exec(l) || [])[1]).filter(Boolean)
    .filter((n) => n !== 'lo' && !/^(docker|veth|br-|virbr)/.test(n));
  check('ifaces array is populated (kernel shows ' + kernelNics.length + ' real NICs)',
    Array.isArray(t.net.ifaces) && t.net.ifaces.length === kernelNics.length, `${t.net.ifaces.length} rows`);
  check('every iface row named from /proc/net/dev, rates numeric or null',
    t.net.ifaces.every((i) => kernelNics.includes(i.id)
      && (i.rxMBs === null || i.rxMBs >= 0) && (i.txMBs === null || i.txMBs >= 0)));
  check('a settled tick has MEASURED iface rates, not all-null',
    t.net.ifaces.every((i) => i.rxMBs !== null && i.txMBs !== null));

  console.log('\n--- pressure (PSI) ---');
  console.log(`  mem.pressure: ${JSON.stringify(t.mem.pressure)}`);
  if (fs.existsSync('/proc/pressure/memory')) {
    check('PSI present on this kernel -> mem.pressure measured',
      t.mem.pressure && typeof t.mem.pressure.some === 'number' && t.mem.pressure.some >= 0);
  } else {
    check('no PSI on this kernel -> mem.pressure null, never zero', t.mem.pressure === null);
  }

  console.log('\n--- self-attribution ---');
  console.log(`  self: ${JSON.stringify(t.self)}`);
  check('self measured: cpu is a number, mb > 0',
    t.self && typeof t.self.cpu === 'number' && t.self.cpu >= 0 && t.self.mb > 0);
  check('self has the one honest component (bridge), n=1',
    t.self && Array.isArray(t.self.comps) && t.self.comps.length === 1 && t.self.comps[0].k === 'bridge');

  console.log('\n--- processes ---');
  console.log('  ' + t.proc.slice(0, 5).map((p) => `${p.n} ${p.mb}MB ${p.cpu}%`).join('  |  '));
  check('proc list non-empty', t.proc.length > 0);
  check('proc sorted by memory descending',
    t.proc.every((p, i) => i === 0 || t.proc[i - 1].mb >= p.mb));
  check('this node process appears', t.proc.some((p) => p.n === 'node'));
  /* THE CORE HONESTY CHECK, updated for the 2026-07-31 own-session io: /proc/<pid>/io reads only
     for this user's processes, so a row is either MEASURED (all three numbers, >= 0) or NULL (all
     three) - and never a fabricated 0 standing in for "not allowed". */
  check('proc.io per row: measured-or-null, never a plausible zero for a denied read',
    t.proc.every((p) => (p.ioMBs === null && p.rMBs === null && p.wMBs === null)
      || (p.ioMBs >= 0 && p.rMBs >= 0 && p.wMBs >= 0)));
  const ownNode = t.proc.find((p) => p.n === 'node');
  check('our own node processes carry measured io (same-uid is readable)',
    ownNode && ownNode.ioMBs !== null, ownNode && JSON.stringify({ r: ownNode.rMBs, w: ownNode.wMBs }));
  check('some rows are honestly null (root\'s processes are not ours to read)',
    process.getuid && process.getuid() !== 0 ? t.proc.some((p) => p.ioMBs === null) : true);

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
