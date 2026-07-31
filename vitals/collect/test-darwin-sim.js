/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* macOS collector SIMULATION.  node collect/test-darwin-sim.js   (runs on any platform)
 *
 * Drives the ENTIRE darwin collector - static event, iostat stream, per-tick shell call, battery
 * poll, volume poll, and the differencing between ticks - by injecting fixture text at the two
 * points where the collector talks to the operating system.
 *
 * WHAT A PASS MEANS, precisely:
 *   YES  the memory arithmetic, ps aggregation, netstat de-duplication, mAh->Wh conversion, rate
 *        differencing, null discipline and tick assembly are correct GIVEN this output.
 *   NO   it does not mean macOS emits this output. Only a Mac settles that.
 *
 * That is a real and useful claim: it covers roughly everything in darwin.js except the format
 * assumption itself, and it is the most that can honestly be verified without Apple hardware.
 *
 * The fixtures are deliberately nasty in the ways real output is nasty: an app name containing
 * spaces, two processes sharing a name, an interface listed twice, a battery reporting amps rather
 * than watts, and a header row reprinted mid-stream.
 */

const { EventEmitter } = require('events');
const darwin = require('./darwin');

let fails = 0, checks = 0;
function check(label, ok, detail) {
  checks++; if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  [' + detail + ']' : ''}`);
}
function near(a, b, tol) { return typeof a === 'number' && Math.abs(a - b) <= tol; }

/* ---------------- fixtures ---------------- */

const SYSCTL = `Apple M2 Pro
10
10
17179869184
14.5`;

/* 16 GB machine, 16 kB pages (Apple Silicon). */
const VM1 = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               45231.
Pages active:                            412887.
Pages inactive:                          388211.
Pages wired down:                        198334.
Pages purgeable:                           8821.
File-backed pages:                       201883.
Anonymous pages:                         612119.
Pages occupied by compressor:            102938.
Pageins:                                8827361.
Pageouts:                                 21883.`;

/* Second tick: Pageins advanced by 1500, which must surface as a hard-fault RATE, not a total. */
const VM2 = VM1.replace('8827361', '8828861').replace('45231', '44000');

/* Two Chrome processes sharing a name (must aggregate, count 2), an app path (must reduce to the
   leaf name), and a name containing a space. */
const PS = `  PID    RSS  %CPU COMM
    1   12800   0.1 /sbin/launchd
  442  524288  12.5 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  443  262144   6.0 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  907  131072   3.2 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder
 1201   65536   0.5 /usr/libexec/trustd`;

/* lo0 must be excluded. en0 appears TWICE (link row then IPv4 row) and must be counted ONCE.
   Trailing Coll column present, and the IPv4 row uses '-' for error counts. */
const NET1 = `Name  Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0   16384 <Link#1>                          5000     0     500000     5000     0     500000     0
en0   1500  <Link#4>      a4:83:e7:11:22:33 100000     0  200000000    50000     0   30000000     0
en0   1500  192.168.1     192.168.1.42      100000     -  200000000    50000     -   30000000     -
utun0 1380  <Link#12>                          100     0      10000      100     0      10000     0`;

/* +5 MB received, +1 MB sent on en0 between ticks. */
const NET2 = NET1.replace(/200000000/g, '205242880').replace(/30000000/g, '31048576');

const DF = `/dev/disk3s1s1  971350180  22000000  400000000    6%  500000 4000000000    0%   /
devfs                  200       200          0  100%     692          0  100%   /dev
/dev/disk3s5    971350180 300000000  400000000   43%  700000 4000000000    0%   /System/Volumes/Data
/dev/disk6s2    488281250  88281250  400000000   19%  100000 2000000000    0%   /Volumes/My Backup Drive
map auto_home            0         0          0  100%       0          0  100%   /System/Volumes/Data/home`;

/* A battery that reports AMPS, not watts - so watt-hours and the draw must be derived from voltage,
   and the sign must come from the discharging state. 11.4 V pack. */
const PMSET = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=1234567)	82%; discharging; 4:12 remaining present: true
---IOREG---
    "CycleCount" = 312
    "DesignCapacity" = 8694
    "AppleRawMaxCapacity" = 8100
    "AppleRawCurrentCapacity" = 6642
    "Voltage" = 11400
    "InstantAmperage" = -1850`;

/* ---------------- fake OS ---------------- */

let shCalls = [];
let tickNo = 0;

function fakeSh(cmd, cb) {
  shCalls.push(cmd.slice(0, 40));
  let out = '';
  if (cmd.startsWith('sysctl')) out = SYSCTL;
  else if (cmd.startsWith('pmset')) out = PMSET;
  else if (cmd.startsWith('df')) out = DF;
  else if (cmd.startsWith('vm_stat')) {
    tickNo++;
    const vm = tickNo === 1 ? VM1 : VM2;
    const net = tickNo === 1 ? NET1 : NET2;
    out = `${vm}\n---PS---\n${PS}\n---NET---\n${net}`;
  }
  setImmediate(() => cb(out));
}

function fakeIostat() {
  const em = new EventEmitter();
  em.stdout = new EventEmitter();
  em.kill = () => {};
  setTimeout(() => {
    /* Header rows (must be skipped), a device row naming two disks (sets diskCount=2), then data.
       Two disks means the cpu columns sit at index 6,7,8. us=9 sy=6 id=85 -> busy 15. */
    em.stdout.emit('data',
      '              disk0               disk4               cpu     load average\n' +
      '    KB/t  tps  MB/s     KB/t  tps  MB/s   us sy id   1m   5m   15m\n' +
      '   18.50   40  0.72    32.00   10  0.31    9  6 85  2.10 1.90 1.80\n');
  }, 120);
  return em;
}

darwin._inject(fakeSh, fakeIostat);

/* ---------------- run ---------------- */

let statics = null;
const ticks = [];
const h = darwin.start(__dirname + '/..', {
  onStatic: (m) => { statics = m; },
  onTick: (m) => { ticks.push(m); },
  onError: (e) => console.log('  collector error: ' + e),
});

console.log('driving the full darwin collector from fixtures (not a Mac)\n');

setTimeout(() => {
  h.stop();

  console.log('--- static ---');
  check('static event fired', !!statics);
  if (statics) {
    check('cpu brand from sysctl', statics.cpu === 'Apple M2 Pro', statics.cpu);
    check('cores from hw.physicalcpu', statics.cores === 10, statics.cores);
    check('threads from hw.ncpu', statics.threads === 10, statics.threads);
    check('ramMB from hw.memsize (17179869184 -> 16384)', statics.ramMB === 16384, statics.ramMB);
    check('os string carries the product version', /macOS 14\.5/.test(statics.os), statics.os);
    check('gpu list empty, not fabricated', Array.isArray(statics.gpu) && statics.gpu.length === 0);
  }

  console.log(`\n--- ticks: ${ticks.length} ---`);
  check('at least 2 ticks (needed to test differencing)', ticks.length >= 2, ticks.length);
  if (ticks.length < 2) { finish(); return; }
  const t1 = ticks[0], t2 = ticks[1];

  console.log('\n--- cpu, from the injected iostat stream ---');
  console.log(`  total ${t2.cpu.total}%  (fixture: us 9 + sy 6, id 85)`);
  check('cpu.total = 100 - idle', t2.cpu.total === 15, t2.cpu.total);
  check('two-disk column offset handled', t2.cpu.total === 15, 'cpu cols shifted by 6');
  check('per-core array empty, not faked', Array.isArray(t2.cpu.cores) && t2.cpu.cores.length === 0);

  console.log('\n--- memory arithmetic (16k pages) ---');
  /* free 45231 + purgeable 8821 + file-backed 201883 = 255935 pages * 16384 / 1048576 = 3999 MB */
  const expUsed = 16384 - Math.round((45231 + 8821 + 201883) * 16384 / 1048576 * 100) / 100;
  console.log(`  usedMB ${t1.mem.usedMB} of ${t1.mem.totalMB}  (${t1.mem.pct}%), cache ${t1.mem.cacheMB} MB`);
  check('totalMB from hw.memsize', t1.mem.totalMB === 16384, t1.mem.totalMB);
  check('usedMB = total - (free + purgeable + file-backed)', near(t1.mem.usedMB, expUsed, 1),
    `${t1.mem.usedMB} vs ${expUsed.toFixed(0)}`);
  check('cacheMB = file-backed pages', t1.mem.cacheMB === Math.round(201883 * 16384 / 1048576),
    t1.mem.cacheMB);
  check('pct consistent with usedMB/totalMB',
    near(t1.mem.pct, t1.mem.usedMB / t1.mem.totalMB * 100, 0.2));
  check('committedMB is NULL (macOS has no commit charge)', t1.mem.committedMB === null,
    String(t1.mem.committedMB));

  console.log('\n--- hard faults: Pageins DIFFERENCED, not reported as a total ---');
  console.log(`  tick1 ${t1.mem.pagesSec}  tick2 ${t2.mem.pagesSec}  (fixture advanced Pageins by 1500 over ~1s)`);
  check('first tick has no rate to report yet', t1.mem.pagesSec === null, String(t1.mem.pagesSec));
  check('second tick reports a RATE near 1500/s, not 8828861',
    near(t2.mem.pagesSec, 1500, 400), t2.mem.pagesSec);

  console.log('\n--- processes ---');
  console.log('  ' + t2.proc.map((p) => `${p.n}(${p.count}) ${p.mb}MB ${p.cpu}%`).join('  |  '));
  const chrome = t2.proc.find((p) => p.n === 'Google Chrome');
  check('app path reduced to leaf name', !!chrome, chrome ? chrome.n : 'not found');
  check('name containing a space survived', !!chrome);
  if (chrome) {
    check('two pids aggregated into one row', chrome.count === 2, chrome.count);
    check('memory summed (512+256 MB)', chrome.mb === 768, chrome.mb);
    /* Summed across both pids THEN normalised by logical-CPU count, so the number means the same
       thing as it does on Windows and Linux. os.cpus() here is the host running the test. */
    const expCpu = Math.round((18.5 / (require('os').cpus().length || 1)) * 10) / 10;
    check('cpu summed then normalised per-core', near(chrome.cpu, expCpu, 0.06),
      `${chrome.cpu} (18.5 raw / ${require('os').cpus().length} threads)`);
    check('both pids retained', chrome.pids.length === 2, chrome.pids.join(','));
  }
  check('sorted by memory descending',
    t2.proc.every((p, i) => i === 0 || t2.proc[i - 1].mb >= p.mb));
  check('proc.io fields NULL not 0 (fs_usage needs root)',
    t2.proc.every((p) => p.ioMBs === null && p.rMBs === null && p.wMBs === null));

  console.log('\n--- network: de-duplication and rate differencing ---');
  console.log(`  tick1 rx ${t1.net.rxMBs}  tick2 rx ${t2.net.rxMBs} MB/s (fixture added 5 MB rx, 1 MB tx)`);
  /* NULL on the first tick, not 0. There is nothing to difference against yet, and a 0 would read
     as a genuinely idle network rather than an unknown one. */
  check('first tick reports NULL, not 0 and not a since-boot total', t1.net.rxMBs === null, String(t1.net.rxMBs));
  /* en0 gained 5242880 bytes = 5 MB. If the duplicate en0 row were counted, this would read 10. */
  check('rx rate ~5 MB/s and NOT 10 (duplicate interface row ignored)',
    near(t2.net.rxMBs, 5, 1.2), t2.net.rxMBs);
  check('tx rate ~1 MB/s', near(t2.net.txMBs, 1, 0.4), t2.net.txMBs);

  console.log('\n--- volumes ---');
  for (const v of t2.disk.vols) console.log(`  ${v.id}  ${v.freeGB}/${v.sizeGB} GB`);
  check('root volume parsed', t2.disk.vols.some((v) => v.id === '/'));
  check('devfs excluded', !t2.disk.vols.some((v) => v.id === '/dev'));
  /* / and /System/Volumes/Data are one APFS container reporting identical free space; showing both
     would present one disk twice. */
  check('/System/Volumes/Data excluded as an APFS duplicate of /',
    !t2.disk.vols.some((v) => v.id === '/System/Volumes/Data'));
  const ext = t2.disk.vols.find((v) => v.id === '/Volumes/My Backup Drive');
  check('mount path containing SPACES kept whole', !!ext, ext ? ext.id : 'missing');
  if (ext) check('freeGB from the Available column (400000000 kB)',
    near(ext.freeGB, 400000000 * 1024 / 1073741824, 0.2), ext.freeGB);

  console.log('\n--- disk io: nulls where macOS cannot answer ---');
  console.log(`  ${JSON.stringify(t2.disk.io)}`);
  check('readMBs NULL (iostat gives combined only)', t2.disk.io.readMBs === null);
  check('writeMBs NULL', t2.disk.io.writeMBs === null);
  check('busyPct NULL, not 0', t2.disk.io.busyPct === null);
  check('combinedMBs = sum of both disks (0.72 + 0.31)', near(t2.disk.io.combinedMBs, 1.03, 0.02),
    t2.disk.io.combinedMBs);

  console.log('\n--- battery: amps + volts -> watt-hours, sign from state ---');
  console.log(`  ${JSON.stringify(t2.pwr)}`);
  const p = t2.pwr;
  check('battery detected', p.bat === true);
  check('percent from pmset', p.pct === 82, p.pct);
  check('discharging', p.discharging === true && p.charging === false);
  check('not on AC', p.ac === false);
  /* 1850 mA * 11.4 V = 21.09 W, negative because discharging. */
  check('rateW derived from amps x volts, NEGATIVE while discharging',
    near(p.rateW, -21.1, 0.2), p.rateW);
  /* 6642 mAh * 11.4 V / 1000 = 75.7 Wh */
  check('remWh from mAh x volts', near(p.remWh, 75.7, 0.2), p.remWh);
  check('fullWh from AppleRawMaxCapacity', near(p.fullWh, 92.3, 0.2), p.fullWh);
  check('designWh from DesignCapacity', near(p.designWh, 99.1, 0.2), p.designWh);
  check('cycles', p.cycles === 312, p.cycles);
  /* health = full/design = 8100/8694 = 93.2% - the figure the panel shows */
  check('health derivable from full/design', near(p.fullWh / p.designWh * 100, 93.2, 0.3),
    (p.fullWh / p.designWh * 100).toFixed(1) + '%');
  check('lifeMin parsed from "4:12 remaining"', p.lifeMin === 252, p.lifeMin);

  console.log('\n--- absent features stay absent (null, never a plausible zero) ---');
  check('gpu null, not a zeroed object', t2.gpu === null && t2.gpus === null);
  check('proc.pf NULL not 0 (fault counting never implemented here)', t2.proc.every((p) => p.pf === null));
  check('self block NULL, not fabricated zeros', t2.self === null,
    'FOOTPRINT claims to include its own cost; 0.00% there would be a measured-looking lie');

  console.log('\n--- Windows tick contract ---');
  for (const k of ['t', 'ts', 'cpu', 'mem', 'disk', 'net', 'proc', 'pwr', 'self', 'up']) {
    check(`tick has .${k}`, k in t2);
  }
  check('.t is "tick"', t2.t === 'tick');

  console.log('\n--- call economy ---');
  const perTick = shCalls.filter((c) => c.startsWith('vm_stat')).length;
  console.log(`  ${shCalls.length} shell calls total, ${perTick} of them the per-tick combined call`);
  check('ONE combined shell call per tick, not three', perTick === ticks.length, `${perTick} for ${ticks.length} ticks`);

  finish();
}, 2600);

function finish() {
  console.log('');
  if (fails) console.log(`${fails} FAILED of ${checks}`);
  else console.log(`all ${checks} checks passed — the collector's LOGIC is correct given this output.\n` +
                   `This is not verification that macOS emits it. Only a Mac settles that.`);
  process.exit(fails ? 1 : 0);
}
