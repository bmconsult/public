/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* macOS parser test.  node collect/test-darwin.js   (runs on any platform)
 *
 * ###########################################################################################
 * ##  READ THIS BEFORE TRUSTING A PASS.                                                    ##
 * ##                                                                                       ##
 * ##  These fixtures are SYNTHETIC. They were written from documented tool output, not      ##
 * ##  captured from a Mac. So this file proves exactly one thing: that the parsing code     ##
 * ##  handles the format I BELIEVE these tools emit.                                        ##
 * ##                                                                                        ##
 * ##  It cannot prove that belief is correct. If vm_stat's real output differs from the      ##
 * ##  fixture, every test here passes and the collector is still wrong on a real Mac.       ##
 * ##                                                                                        ##
 * ##  Contrast with test-linux.js, whose fixtures were captured from a running kernel, and  ##
 * ##  test-linux-live.js, which runs the collector and cross-checks it against df and free. ##
 * ##  Those verify. This one only catches my own parsing mistakes - worth having, worth not ##
 * ##  overselling.                                                                          ##
 * ##                                                                                        ##
 * ##  ON A REAL MAC: run the real commands, diff their output against these fixtures, fix   ##
 * ##  whichever is wrong, then run test-darwin-live.js.                                     ##
 * ###########################################################################################
 */

const { _internal } = require('./darwin');
const { parseVmStat, parseIostatLine, parseTopFaults, parseBlockStats } = _internal;

let fails = 0, checks = 0;
function check(label, got, want) {
  checks++;
  const ok = String(got) === String(want);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${got}${ok ? '' : `  want ${want}`}`);
}

console.log('SYNTHETIC FIXTURES - see the banner. A pass here is not verification.\n');

/* ---- vm_stat. Apple Silicon page size, and the trailing periods that break naive parsing. ---- */
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               45231.
Pages active:                            412887.
Pages inactive:                          388211.
Pages speculative:                        12904.
Pages throttled:                              0.
Pages wired down:                        198334.
Pages purgeable:                           8821.
"Translation faults":                 998372611.
Pages copy-on-write:                   14882901.
Pages zero filled:                    711238841.
Pages reactivated:                     22019388.
Pages purged:                           1998231.
File-backed pages:                       201883.
Anonymous pages:                         612119.
Pages stored in compressor:              388211.
Pages occupied by compressor:            102938.
Decompressions:                         9182773.
Compressions:                          12008812.
Pageins:                                8827361.
Pageouts:                                 21883.
Swapins:                                      0.
Swapouts:                                     0.`;

const vm = parseVmStat(VM_STAT);
check('page size (Apple Silicon 16k)', vm.pageSize, 16384);
check('Pages free (trailing period stripped)', vm['Pages free'], 45231);
check('Pages wired down (name has spaces)', vm['Pages wired down'], 198334);
check('File-backed pages (hyphenated name)', vm['File-backed pages'], 201883);
check('Pageins (the hard-fault source)', vm['Pageins'], 8827361);
check('quoted key parsed', vm['Translation faults'], 998372611);
check('Pages purgeable', vm['Pages purgeable'], 8821);

/* The memory maths the collector performs, checked by hand at 16k pages against 16 GB installed. */
{
  const pg = vm.pageSize, mb = (p) => (p * pg) / 1048576;
  const totalMB = 16384;
  const freeish = mb(vm['Pages free']) + mb(vm['Pages purgeable']) + mb(vm['File-backed pages']);
  const used = Math.round(totalMB - freeish);
  console.log(`      -> free ${mb(vm['Pages free']).toFixed(0)} + purgeable ${mb(vm['Pages purgeable']).toFixed(0)}` +
              ` + file-backed ${mb(vm['File-backed pages']).toFixed(0)} = ${freeish.toFixed(0)} MB reclaimable`);
  check('derived usedMB is in a sane range', used > 0 && used < totalMB, true);
}

/* Intel page size must be picked up too - hard-coding either value is wrong on half the fleet. */
check('page size (Intel 4k)', parseVmStat('(page size of 4096 bytes)\nPages free: 100.').pageSize, 4096);

/* ---- iostat. Columns are 3 per disk (KB/t, tps, MB/s) then us, sy, id, then load averages. ---- */
console.log('');
{
  //            KB/t   tps  MB/s   us sy id    1m   5m  15m
  const one = ' 20.86     5  0.10    4  3 93  1.99 2.14 2.17';
  const r = parseIostatLine(one, 1);
  check('1 disk: us', r.us, 4);
  check('1 disk: sy', r.sy, 3);
  check('1 disk: id', r.id, 93);
  check('1 disk: busy = 100 - id', r.busy, 7);
  check('1 disk: MB/s', r.mbs, 0.1);
  check('1 disk: per-device row kept', r.disks.length, 1);
  check('1 disk: per-device tps', r.disks[0].tps, 5);
}
{
  // two disks: their MB/s columns must be summed, and the cpu columns shift right by 3
  const two = ' 20.86  5  0.10   16.00  9  1.40    12 7 81  0.50 0.60 0.70';
  const r = parseIostatLine(two, 2);
  check('2 disks: summed MB/s', Math.round(r.mbs * 100) / 100, 1.5);
  check('2 disks: us (offset shifted)', r.us, 12);
  check('2 disks: id (offset shifted)', r.id, 81);
  check('2 disks: busy', r.busy, 19);
  /* The columns were always parsed per device and then summed away - disk.perDevice was never a
     platform limit, only a discard. Each triple must survive individually. */
  check('2 disks: both per-device rows kept', r.disks.length, 2);
  check('2 disks: first device MB/s', r.disks[0].mbs, 0.1);
  check('2 disks: second device MB/s', r.disks[1].mbs, 1.4);
  check('2 disks: second device tps', r.disks[1].tps, 9);
}
{
  check('header line rejected', parseIostatLine('    KB/t  tps  MB/s  us sy id', 1), null);
  check('short line rejected', parseIostatLine(' 1 2', 1), null);
  check('blank line rejected', parseIostatLine('   ', 1), null);
}

/* ---- top faults: exact-header gate, "+" decoration, preamble ignored. ---- */
{
  const top = 'Processes: 500 total\nLoad Avg: 1.0\n\nPID    FAULTS\n1      2000\n442    120000+\n907    5000-\n';
  const m = parseTopFaults(top);
  check('faults parsed for 3 pids', m && m.size, 3);
  check('"+" changing-value decoration stripped', m && m.get(442), 120000);
  check('"-" decoration stripped too', m && m.get(907), 5000);
  /* The gate, which is the point: a reordered or widened stats list must refuse, not misread. */
  check('reordered columns (FAULTS first) refused', parseTopFaults('FAULTS  PID\n2000  1\n'), null);
  check('extra column (CPU) refused rather than misread as faults',
    parseTopFaults('PID  CPU  FAULTS\n1  0.5  2000\n'), null);
  check('empty table refused', parseTopFaults('PID    FAULTS\n'), null);
  check('garbage refused', parseTopFaults('no table here'), null);
}

/* ---- block-storage statistics: summed across drivers, absent keys refuse. ---- */
{
  const two = '"Statistics" = {"Bytes (Read)"=1000,"Bytes (Written)"=500}\n' +
              '"Statistics" = {"Bytes (Read)"=200,"Bytes (Written)"=100,"Errors (Read)"=0}';
  const s = parseBlockStats(two);
  check('read bytes summed across drivers', s && s.read, 1200);
  check('written bytes summed', s && s.written, 600);
  check('no Bytes keys at all -> null (never a zero pretending to be idle disks)',
    parseBlockStats('"Statistics" = {"Operations (Read)"=12}'), null);
  check('empty input -> null', parseBlockStats(''), null);
}

console.log('');
console.log(fails ? `${fails} FAILED of ${checks}`
                  : `all ${checks} parser checks passed against SYNTHETIC fixtures - ` +
                    `this is not verification, see the banner`);
process.exit(fails ? 1 : 0);
