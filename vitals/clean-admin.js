/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - elevated reclaim for macOS, run as an osascript admin one-shot.
 *
 * The direct port of clean-admin.ps1, contract for contract. The bridge is deliberately NOT
 * elevated - it can end processes and delete caches, so a long-lived root server is a liability.
 * The few operations that genuinely need root are short, explicit, and go through the OS's own
 * consent prompt: UAC on Windows, the administrator-password dialog that `do shell script ... with
 * administrator privileges` raises here.
 *
 * THE RULE THIS FILE ENFORCES: paths are resolved HERE, from a fixed table, never passed in. An
 * elevated process that accepts a path argument is a machine for deleting anything as root; one
 * that accepts only a key from this table can delete exactly what the table says and nothing else.
 * The caller chooses a key or nothing happens.
 *
 * And the same honesty rule as the PowerShell original: every entry that could NOT be deleted is
 * COUNTED and reported. The bug the original fixed - deletions silently denied, result hard-coded
 * ok=true - is precisely reproducible with `rm -rf` and `|| true`, so it is precisely avoided.
 *
 *   node clean-admin.js --targets syscaches,systmp --out result.json
 */

const fs = require('fs');
const path = require('path');

/* macOS targets. Deliberately short:
 *   - /System and /System/Library/Caches are SIP-protected; root cannot touch them and should not
 *     try. Not listed, on purpose.
 *   - ~/Library/Caches needs no elevation and is handled by the unelevated sweep in
 *     actions-posix.js; an elevated pass over a user path would only create root-owned leftovers.
 */
const MAP = {
  syscaches: { path: '/Library/Caches', what: 'system-level application caches' },
  systmp:    { path: '/private/tmp',    what: 'system temp (world-writable; unelevated can only remove its own)' },
};

/* Iterative, not recursive: a deep tree must not become a stack overflow inside an elevated
   process. Symlinks are never followed - a link into /Users from a cache folder must not let a
   cache sweep measure (or later delete through) someone's home. */
function measureTree(p) {
  let bytes = 0, files = 0;
  const stack = [p];
  while (stack.length) {
    const dir = stack.pop();
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of names) {
      const full = path.join(dir, d.name);
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) stack.push(full);
      else if (d.isFile()) { try { bytes += fs.lstatSync(full).size; files++; } catch {} }
    }
  }
  return { bytes, files };
}

function cleanOne(key) {
  if (!MAP[key]) return { key, ok: false, err: 'unknown target' };
  const p = MAP[key].path;
  let st;
  try { st = fs.statSync(p); } catch { st = null; }
  if (!st || !st.isDirectory()) return { key, ok: true, freedGB: 0, note: 'path absent' };

  const before = measureTree(p);
  /* Delete children, not the folder itself: the OS expects these directories to exist. */
  let deleted = 0, denied = 0, locked = 0;
  let names = [];
  try { names = fs.readdirSync(p); } catch { denied++; }
  for (const n of names) {
    /* force:false on purpose - force swallows errors, and a swallowed denial is the exact lie
       this script exists to stop telling. Each failure lands in a counted bucket instead. */
    try { fs.rmSync(path.join(p, n), { recursive: true, force: false }); deleted++; }
    catch (e) {
      if (e.code === 'EACCES' || e.code === 'EPERM') denied++;
      else if (e.code === 'ENOENT') deleted++;        // raced away between readdir and rm: gone is gone
      else locked++;
    }
  }

  const after = measureTree(p);
  const freed = Math.round(((before.bytes - after.bytes) / 2 ** 30) * 100) / 100;
  return {
    key, what: MAP[key].what, path: p,
    ok: (denied === 0 || freed > 0),   // honest: partial success is still reported with the denial count
    freedGB: freed,
    leftGB: Math.round((after.bytes / 2 ** 30) * 100) / 100,
    filesBefore: before.files, filesAfter: after.files,
    entriesDeleted: deleted, entriesDenied: denied, entriesLocked: locked,
  };
}

function run(targetsCsv) {
  const results = targetsCsv.split(',').map((s) => s.trim()).filter(Boolean).map(cleanOne);
  let freeGBAfter = null;
  try { const s = fs.statfsSync('/'); freeGBAfter = Math.round((s.bavail * s.bsize) / 2 ** 30 * 100) / 100; } catch {}
  return {
    ranAt: new Date().toISOString(),
    /* getuid is absent on Windows; guarded so the module stays loadable by the cross-platform
       test suite, which exercises the table and the counting without elevation. */
    elevated: typeof process.getuid === 'function' ? process.getuid() === 0 : false,
    results,
    freeGBAfter,
    totalFreedGB: Math.round(results.reduce((a, r) => a + (r.freedGB || 0), 0) * 100) / 100,
    totalDenied: results.reduce((a, r) => a + (r.entriesDenied || 0), 0),
  };
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const targets = arg('--targets');
  const out = arg('--out');
  if (!targets || !out) {
    console.error('usage: node clean-admin.js --targets key[,key] --out result.json');
    process.exit(2);
  }
  const r = run(targets);
  fs.writeFileSync(out, JSON.stringify(r));
  console.log(`freed ${r.totalFreedGB} GB across ${r.results.length} target(s), ${r.totalDenied} denied`);
}

if (require.main === module) main();

module.exports = { MAP, run, cleanOne, measureTree };
