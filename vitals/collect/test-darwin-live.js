/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* END-TO-END test of the macOS collector, ON A MAC.  node collect/test-darwin-live.js
 *
 * This is the file that converts the macOS plug from "written" to "verified". It runs the real
 * collector against the real system and cross-checks every field against an INDEPENDENT source -
 * sysctl, df, ps, pmset - because a collector agreeing with itself proves nothing.
 *
 * IF YOU ARE THE FIRST PERSON TO RUN THIS: expect failures. The collector was written from
 * documented tool output by someone with no Mac. Every failure here is a real finding. Please:
 *   1. Note the failing check names - they say which counter disagreed with which authority.
 *   2. Also run `bash tools/capture-macos-fixtures.sh` and keep that output.
 *   3. Fix collect/darwin.js, or send both back so someone else can.
 * When this passes AND the numbers match Activity Monitor, set `verified` in collect/caps.js and
 * delete the UNVERIFIED banner at the top of collect/darwin.js. Not before.
 */

const os = require('os');
const { execSync } = require('child_process');

if (process.platform !== 'darwin') {
  console.error('This must run ON macOS. Current platform: ' + process.platform);
  console.error('On any platform you can run the logic simulation instead: node collect/test-darwin-sim.js');
  process.exit(2);
}

const { start } = require('./darwin');
let fails = 0, checks = 0;
const failed = [];
function check(label, ok, detail) {
  checks++; if (!ok) { fails++; failed.push(label); }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  [' + detail + ']' : ''}`);
}
function sh(c) { try { return execSync(c, { encoding: 'utf8' }).trim(); } catch { return ''; } }
function near(a, b, tol) { return typeof a === 'number' && Math.abs(a - b) <= tol; }

console.log(`${sh('sw_vers -productName')} ${sh('sw_vers -productVersion')} on ${sh('uname -m')}`);
console.log(`node ${process.versions.node}`);
console.log('collecting for 6 seconds...\n');

let statics = null;
const ticks = [];
const h = start(__dirname + '/..', {
  onStatic: (m) => { statics = m; },
  onTick: (m) => { ticks.push(m); },
  onError: (e) => console.log('  collector error: ' + e),
});

/* Some real load, so a collector returning constants cannot pass by accident. */
const spin = setInterval(() => { let x = 0; for (let i = 0; i < 8e6; i++) x += i; }, 250);

setTimeout(() => {
  clearInterval(spin);
  h.stop();

  console.log('--- static ---');
  check('static event arrived', !!statics);
  if (statics) {
    console.log(`  ${statics.cpu} | ${statics.cores}c/${statics.threads}t | ${statics.ramMB} MB | ${statics.os}`);
    check('cpu brand matches sysctl',
      statics.cpu === sh('sysctl -n machdep.cpu.brand_string'), statics.cpu);
    check('physical cores match sysctl', statics.cores === +sh('sysctl -n hw.physicalcpu'), statics.cores);
    check('logical threads match sysctl', statics.threads === +sh('sysctl -n hw.ncpu'), statics.threads);
    const memMB = Math.round(+sh('sysctl -n hw.memsize') / 1048576);
    check('ramMB matches hw.memsize', statics.ramMB === memMB, `${statics.ramMB} vs ${memMB}`);
    check('hostname matches', statics.host === os.hostname(), statics.host);
  }

  console.log(`\n--- ticks: ${ticks.length} ---`);
  check('at least 3 ticks in 6s', ticks.length >= 3, ticks.length);
  if (!ticks.length) { done(); return; }
  const t = ticks[ticks.length - 1];

  console.log('\n--- cpu (from the iostat stream) ---');
  console.log(`  total ${t.cpu.total}%`);
  check('cpu.total is a number in 0..100',
    typeof t.cpu.total === 'number' && t.cpu.total >= 0 && t.cpu.total <= 100, t.cpu.total);
  check('cpu.total > 0 while a loop is spinning', t.cpu.total > 0,
    'if this fails, iostat parsing is wrong - check the disk column count');
  console.log('  compare against `top -l 2 -n 0` CPU usage line by hand.');

  console.log('\n--- memory ---');
  console.log(`  ${t.mem.usedMB} MB used of ${t.mem.totalMB} (${t.mem.pct}%), cache ${t.mem.cacheMB} MB, faults ${t.mem.pagesSec}/s`);
  const memMB = Math.round(+sh('sysctl -n hw.memsize') / 1048576);
  check('totalMB matches hw.memsize', t.mem.totalMB === memMB, `${t.mem.totalMB} vs ${memMB}`);
  check('usedMB is between 0 and total', t.mem.usedMB > 0 && t.mem.usedMB < t.mem.totalMB, t.mem.usedMB);
  check('pagesSec is a number by the last tick', typeof t.mem.pagesSec === 'number', String(t.mem.pagesSec));
  console.log('  !! COMPARE BY HAND against Activity Monitor > Memory > "Memory Used".');
  console.log('     macOS counts memory unusually; if these differ by more than ~1 GB the');
  console.log('     free/purgeable/file-backed formula in darwin.js needs revisiting.');

  console.log('\n--- volumes ---');
  for (const v of t.disk.vols) console.log(`  ${v.id}  ${v.freeGB}/${v.sizeGB} GB (${v.pct}% used)`);
  check('at least one volume', t.disk.vols.length > 0);
  const root = t.disk.vols.find((v) => v.id === '/');
  check('ROOT VOLUME present', !!root,
    'a df parsing bug once dropped this silently - it is the main disk');
  if (root) {
    const availKB = +(sh("df -kl / | tail -1").split(/\s+/)[3] || 0);
    const dfFreeGB = availKB * 1024 / 1073741824;
    check('root freeGB agrees with df', near(root.freeGB, dfFreeGB, 0.5),
      `collector ${root.freeGB} vs df ${dfFreeGB.toFixed(1)}`);
  }
  check('no /dev volume leaked in', !t.disk.vols.some((v) => v.id === '/dev'));

  console.log('\n--- disk io ---');
  console.log(`  ${JSON.stringify(t.disk.io)}`);
  check('readMBs/writeMBs are NULL not 0 (iostat gives combined only)',
    t.disk.io.readMBs === null && t.disk.io.writeMBs === null);
  check('busyPct NULL not 0', t.disk.io.busyPct === null);
  check('combinedMBs is a number', typeof t.disk.io.combinedMBs === 'number', t.disk.io.combinedMBs);

  console.log('\n--- network ---');
  console.log(`  rx ${t.net.rxMBs}  tx ${t.net.txMBs} MB/s`);
  check('rates are non-negative numbers', t.net.rxMBs >= 0 && t.net.txMBs >= 0);
  console.log(`  interfaces netstat reports: ${sh("netstat -ib | awk 'NR>1{print $1}' | sort -u | tr '\\n' ' '")}`);

  console.log('\n--- processes ---');
  console.log('  ' + t.proc.slice(0, 5).map((p) => `${p.n}(${p.count}) ${p.mb}MB ${p.cpu}%`).join('  |  '));
  check('proc list non-empty', t.proc.length > 0);
  check('sorted by memory descending', t.proc.every((p, i) => i === 0 || t.proc[i - 1].mb >= p.mb));
  check('names are leaf names, not full paths', t.proc.every((p) => !p.n.includes('/')),
    t.proc.find((p) => p.n.includes('/'))?.n || 'ok');
  check('proc.io NULL not 0 (fs_usage needs root)',
    t.proc.every((p) => p.ioMBs === null && p.rMBs === null && p.wMBs === null));
  console.log('  !! COMPARE the top few against Activity Monitor > Memory, sorted by Memory.');

  console.log('\n--- power ---');
  console.log(`  ${JSON.stringify(t.pwr)}`);
  const pmset = sh('pmset -g batt');
  const hasBat = /InternalBattery/.test(pmset);
  check('battery presence matches pmset', t.pwr.bat === hasBat, `reports ${t.pwr.bat}, pmset ${hasBat}`);
  if (hasBat && t.pwr.bat) {
    const pct = +(/(\d+)%/.exec(pmset) || [])[1];
    check('percent matches pmset', t.pwr.pct === pct, `${t.pwr.pct} vs ${pct}`);
    check('remWh/fullWh/designWh are numbers or explicit null',
      [t.pwr.remWh, t.pwr.fullWh, t.pwr.designWh].every((x) => x === null || typeof x === 'number'));
    if (t.pwr.fullWh && t.pwr.designWh) {
      const health = t.pwr.fullWh / t.pwr.designWh * 100;
      console.log(`  derived health: ${health.toFixed(1)}%`);
      check('health is plausible (40-105%)', health > 40 && health < 105, health.toFixed(1) + '%');
      console.log('  !! COMPARE against System Settings > Battery > Battery Health.');
    }
    if (t.pwr.discharging) check('rateW is NEGATIVE while discharging', t.pwr.rateW === null || t.pwr.rateW < 0, t.pwr.rateW);
    if (t.pwr.charging) check('rateW is POSITIVE while charging', t.pwr.rateW === null || t.pwr.rateW > 0, t.pwr.rateW);
  }

  console.log('\n--- gpu (expected absent) ---');
  check('gpu null, not zeroed', t.gpu === null && t.gpus === null);

  console.log('\n--- tick contract ---');
  for (const k of ['t', 'ts', 'cpu', 'mem', 'disk', 'net', 'proc', 'pwr', 'self', 'up']) {
    check(`tick has .${k}`, k in t);
  }
  check('uptime is plausible', near(t.up, os.uptime() / 3600, 0.1), `${t.up}h`);

  done();
}, 6200);

function done() {
  console.log('');
  if (fails) {
    console.log(`${fails} FAILED of ${checks}:`);
    failed.forEach((f) => console.log('  - ' + f));
    console.log('\nEvery one of these is a real finding. Please also run');
    console.log('  bash tools/capture-macos-fixtures.sh');
    console.log('and keep both outputs together.');
  } else {
    console.log(`all ${checks} automated checks passed.`);
    console.log('');
    console.log('BEFORE marking macOS verified in collect/caps.js, confirm BY EYE:');
    console.log('  - memory used vs Activity Monitor > Memory');
    console.log('  - the top processes vs Activity Monitor sorted by Memory');
    console.log('  - battery health vs System Settings > Battery');
    console.log('The automated checks prove internal consistency; only your eyes prove correctness.');
  }
  process.exit(fails ? 1 : 0);
}
