/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* Verifies the Linux parsers against REAL /proc text captured from Ubuntu 22.04 (kernel 6.6.87.2),
 * by intercepting fs reads and serving the captured files. This tests the part most likely to be
 * silently wrong - field offsets - without needing a Linux host.
 *
 * It does NOT test the runtime plumbing (timers, statfs, /sys walks). caps.js says so out loud.
 *
 *   node collect/test-linux.js
 */
const fs = require('fs');
const path = require('path');

const S = path.join(__dirname, '..', 'history', 'procsamples');
const MAP = {
  '/proc/stat': 'stat.txt', '/proc/meminfo': 'meminfo.txt',
  '/proc/diskstats': 'diskstats.txt', '/proc/net/dev': 'net_dev.txt',
  '/proc/uptime': 'uptime.txt', '/proc/cpuinfo': 'cpuinfo.txt',
  '/proc/vmstat': 'vmstat.txt',
  /* PSI fixtures are REAL bytes from the 2026-07-31 CI capture (ubuntu-24.04, kernel
     6.17.0-1020-azure), where all three resources were populated - io hardest, because the runner
     was mid-checkout. */
  '/proc/pressure/cpu': 'pressure_cpu.txt', '/proc/pressure/memory': 'pressure_memory.txt',
  '/proc/pressure/io': 'pressure_io.txt',
};
const realRead = fs.readFileSync;
fs.readFileSync = function (p, ...rest) {
  if (typeof p === 'string' && MAP[p]) return realRead(path.join(S, MAP[p]), ...rest);
  if (typeof p === 'string' && p.startsWith('/proc')) { const e = new Error('ENOENT'); throw e; }
  return realRead(p, ...rest);
};

/* /sys MUST be stubbed too, not just /proc. diskstats() asks the kernel whether a device is a whole
   disk by testing membership in /sys/block - which is the correct question precisely BECAUSE it is
   name-agnostic, but it means the parser can no longer be exercised from text alone. On the Windows
   host running this suite every such probe fails and every device is filtered out, so the fixture
   below stands in for the /sys/block of the machine the /proc samples came from. */
const SYS_BLOCK = new Set(['sda', 'sdb', 'sdc', 'sdd']);
const realAccess = fs.accessSync;
fs.accessSync = function (p, ...rest) {
  if (typeof p === 'string' && p.startsWith('/sys/block/')) {
    if (SYS_BLOCK.has(p.slice('/sys/block/'.length))) return undefined;
    const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
  }
  if (typeof p === 'string' && p.startsWith('/sys')) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
  return realAccess(p, ...rest);
};

const { _internal } = require('./linux');
const { cpuStat, meminfo, diskstats, netdev, pctOf, psiRead } = _internal;

let fails = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${got}${ok ? '' : `  want ${want}`}`);
}

/* --- CPU. Real line: cpu  64 0 312 22017 169 0 49 0 0 0
   idle = idle(22017) + iowait(169) = 22186 ; busy = sum(64,0,312,0,49) = 425 --- */
const c = cpuStat();
check('cpu total busy', c.total.busy, 425);
check('cpu total idle', c.total.idle, 22186);
check('per-core count', c.cores.length, 8);
check('cpu0 busy (5+0+104+32)', c.cores[0].busy, 141);

/* pctOf: contrive a delta of 50 busy / 50 idle -> exactly 50% */
check('pctOf 50/50', pctOf({ busy: 100, idle: 100 }, { busy: 50, idle: 50 }), 50);
check('pctOf no movement', pctOf({ busy: 100, idle: 100 }, { busy: 100, idle: 100 }), 0);

/* --- memory. MemTotal 7975128 kB, MemAvailable 7557604 kB --- */
const m = meminfo();
check('MemTotal kB', m.MemTotal, 7975128);
check('MemAvailable kB', m.MemAvailable, 7557604);
const usedMB = Math.round((m.MemTotal - m.MemAvailable) / 1024);
check('used MB (total-available)', usedMB, 408);
console.log(`      -> reports ${usedMB} MB used of ${Math.round(m.MemTotal / 1024)} MB. ` +
            `Using MemFree instead would claim ${Math.round((m.MemTotal - m.MemFree) / 1024)} MB.`);

/* --- diskstats. sdd: sectors read 63404, sectors written 1528, ms doing I/O 840 --- */
const d = diskstats();
check('sdd sectors read', d.sdd && d.sdd.rd, 63404);
check('sdd sectors written', d.sdd && d.sdd.wr, 1528);
check('sdd busy ms', d.sdd && d.sdd.busyMs, 840);
check('sda sectors read', d.sda && d.sda.rd, 146898);
check('loop devices excluded', Object.keys(d).some((k) => k.startsWith('loop')), false);

/* --- REGRESSION: whole-disk vs partition across every naming scheme in use ---
   The original filter stripped trailing digits and asked whether the remainder was a known disk.
   That works for sdaN and fails for nvme0n1p1 ("nvme0n1p" is not a disk), so NVMe and eMMC
   PARTITIONS were kept and summed alongside their parents - roughly doubling disk throughput on
   nearly every modern laptop. WSL never caught it because WSL's disks have no partitions.
   Re-driven here against a synthetic /proc/diskstats and /sys/block so it cannot come back. */
{
  const io = require('fs');
  const dsPath = path.join(S, 'diskstats-mixed.txt');
  const row = (n) => `   8       0 ${n} 100 0 2000 10 50 0 1000 5 0 40 15 0 0 0 0 0`;
  /* (readFileSync is patched at the top of this file) */
  io.writeFileSync(dsPath, [
    row('sda'), row('sda1'), row('nvme0n1'), row('nvme0n1p1'), row('nvme0n1p2'),
    row('mmcblk0'), row('mmcblk0p1'), row('loop0'), row('dm-0'),
  ].join('\n'));
  MAP['/proc/diskstats'] = 'diskstats-mixed.txt';
  ['sda', 'nvme0n1', 'mmcblk0'].forEach((d) => SYS_BLOCK.add(d));   // whole disks only
  const mixed = diskstats();
  const kept = Object.keys(mixed).sort();
  check('whole disks kept', kept.join(','), 'mmcblk0,nvme0n1,sda');
  check('NVMe partition dropped (the double-counting bug)', 'nvme0n1p1' in mixed, false);
  check('second NVMe partition dropped', 'nvme0n1p2' in mixed, false);
  check('eMMC partition dropped', 'mmcblk0p1' in mixed, false);
  check('SATA partition dropped', 'sda1' in mixed, false);
  check('loop excluded', 'loop0' in mixed, false);
  check('device-mapper excluded (physical device reports it)', 'dm-0' in mixed, false);
  const total = Object.values(mixed).reduce((a, d) => a + d.rd, 0);
  check('read sectors summed ONCE per disk (3 x 2000)', total, 6000);
  MAP['/proc/diskstats'] = 'diskstats.txt';
  try { io.unlinkSync(dsPath); } catch {}
}

/* --- PSI, against the captured pressure files. The io fixture matters most: an earlier reading of
   the capture suggested io came back empty, and these are the actual bytes proving it did not on
   THIS kernel - while the parser must still answer null, never zero, wherever it truly is. --- */
check('psi cpu some avg10', psiRead('cpu') && psiRead('cpu').some, 1.91);
check('psi cpu full avg10', psiRead('cpu') && psiRead('cpu').full, 0);
check('psi memory some avg10', psiRead('memory') && psiRead('memory').some, 0);
check('psi io some avg10', psiRead('io') && psiRead('io').some, 6.17);
check('psi io full avg10', psiRead('io') && psiRead('io').full, 5.31);
check('absent PSI file -> null, never a fabricated calm', psiRead('nonexistent'), null);
{
  /* Older kernels publish no `full` line for cpu: some parses, full is null - not 0. */
  const fs2 = require('fs');
  const p = path.join(S, 'pressure-someonly.txt');
  fs2.writeFileSync(p, 'some avg10=3.50 avg60=1.00 avg300=0.10 total=99\n');
  MAP['/proc/pressure/someonly'] = 'pressure-someonly.txt';
  const r = psiRead('someonly');
  check('some-only PSI: some parsed', r && r.some, 3.5);
  check('some-only PSI: full is null, not 0', r && r.full, null);
  try { fs2.unlinkSync(p); } catch {}
}

/* --- network. eth0 rx 35635, tx 1012; lo must be excluded --- */
const n = netdev();
check('net rx bytes (lo excluded)', n.rx, 35635);
check('net tx bytes (lo excluded)', n.tx, 1012);
check('interfaces kept', n.per.length, 1);

/* --- /proc/pid/stat offsets. Synthetic line with a name containing spaces AND parens, which is the
   case that breaks naive whitespace splitting. Fields set so each one is identifiable. --- */
const raw = '1234 (my (weird) name) S 1 1234 1234 0 -1 4194304 ' +
  ['111', '0', '222', '0',        // 10 minflt, 11 cminflt, 12 majflt, 13 cmajflt
   '500', '250', '0', '0',        // 14 utime, 15 stime, 16 cutime, 17 cstime
   '20', '0', '4', '0',           // 18 prio, 19 nice, 20 threads, 21 itrealvalue
   '99999', '123456789',          // 22 starttime, 23 vsize
   '4096'].join(' ');             // 24 rss (pages)
{
  const close = raw.lastIndexOf(')'), open = raw.indexOf('(');
  const name = raw.slice(open + 1, close);
  const f = raw.slice(close + 2).trim().split(/\s+/);
  check('pid name with parens', name, 'my (weird) name');
  check('majflt (field 12)', +f[9], 222);
  check('utime (field 14)', +f[11], 500);
  check('stime (field 15)', +f[12], 250);
  check('rss pages (field 24)', +f[21], 4096);
  check('rss -> MB @4k pages', Math.round(4096 * 4096 / 1048576), 16);
}

console.log(fails ? `\n${fails} FAILED` : '\nall parser checks passed against real kernel output');
process.exit(fails ? 1 : 0);
