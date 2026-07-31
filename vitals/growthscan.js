/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - portable growth walker. The non-NTFS answer to mftscan.ps1.
 *
 * WHY THIS EXISTS. Growth attribution ("Downloads grew 12 GB since last week") is the feature that
 * turns "your disk is full" into something actionable, and on Windows it rides the MFT scanner.
 * The MFT is an NTFS structure, so that scanner can never port. This walks the directory tree with
 * plain fs calls instead - slower, but it works on ANY filesystem, which is why caps.js has been
 * promising exactly this walker for both Linux and macOS since the manifest was written. This file
 * makes that sentence true.
 *
 * IT PRODUCES THE SAME SNAPSHOT SHAPE the MFT scanner writes ({entries:[{path,bytes,own}], ...}),
 * because History.growth() and everything above it already knows how to diff that shape. A new
 * format would have meant porting the diff, the route and the page; speaking the existing one means
 * porting nothing. Two deliberate differences, both declared in the snapshot itself:
 *   - `scanner: 'walk-1'` (the MFT scanner stamps a number). History.growth() refuses to diff
 *     snapshots from different scanners, so a walk can never be silently compared against an MFT
 *     index - they measure different things (a walk sees only what this user may read).
 *   - `sep: path.sep`, because the diff's parent/child test needs to know the separator and the
 *     MFT snapshots got away with assuming '\\'.
 *
 * RUNS AS ITS OWN PROCESS (the bridge spawns `node growthscan.js ...`). A full home-directory walk
 * is minutes of blocking I/O; doing it on the bridge's thread would freeze the 1 Hz tick, which is
 * the same reason mftscan.ps1 is a separate process and not a route body.
 *
 * A DENIED DIRECTORY IS COUNTED, NOT SILENTLY ZEROED. Every unreadable subtree increments `denied`
 * and contributes nothing to its parent's total. The snapshot carries the count so a reader can see
 * how much of the tree the number rests on - a walk that was refused 4,000 times is a different
 * claim than one refused twice, and hiding the difference is the "plausible zero" failure again.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/* Directories below this size are not recorded individually (their bytes still roll up into every
   ancestor). History.growth() ignores deltas under 0.25 GB, so recording every 4 kB folder would
   cost megabytes of snapshot to feed a diff that discards them. 32 MB keeps an order of magnitude
   of headroom under the diff's own floor. */
const MIN_RECORD_BYTES = 32 * 1024 * 1024;
/* Entry cap, largest kept. A pathological tree (a node_modules farm) could otherwise produce a
   snapshot too big to read back comfortably; the MFT snapshots sit around 2.4 MB and this respects
   the same budget. */
const MAX_ENTRIES = 20000;

function scan(root, opts = {}) {
  const minBytes = opts.minBytes != null ? opts.minBytes : MIN_RECORD_BYTES;
  const t0 = Date.now();
  const entries = [];
  let files = 0, dirs = 0, denied = 0;

  /* Recursive post-order: a directory's bytes are its own files plus its children's totals.
     lstat, never stat - following symlinks turns a loop in the filesystem into a walk that never
     ends, and counts linked trees twice. A symlink is a pointer, not payload. */
  function walk(dir) {
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { denied++; return 0; }
    dirs++;
    let total = 0, own = 0;
    for (const d of names) {
      const full = path.join(dir, d.name);
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        const sub = walk(full);
        total += sub;
        if (sub >= minBytes && entries.length < MAX_ENTRIES * 2) {
          entries.push({ path: full, bytes: sub, own: null });
        }
      } else if (d.isFile()) {
        let st;
        try { st = fs.lstatSync(full); } catch { denied++; continue; }
        files++; own += st.size;
      }
      /* sockets, fifos, devices: not storage, skipped without comment in the numbers */
    }
    total += own;
    return total;
  }

  const totalBytes = walk(root);
  entries.push({ path: root, bytes: totalBytes, own: null });
  /* Largest first, then capped - so if the cap ever bites, it sheds the folders the diff would
     have ignored anyway, not the ones the user is looking for. */
  entries.sort((a, b) => b.bytes - a.bytes);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;

  return {
    scanner: 'walk-1',
    sep: path.sep,
    drive: root,
    takenAt: new Date().toISOString(),
    scanMs: Date.now() - t0,
    files, dirs, denied,
    totalBytes,
    entries,
    note: denied
      ? `${denied} entries were unreadable and contribute nothing to these totals - the numbers ` +
        'cover what this user may read, not the whole tree.'
      : 'complete: every entry under the root was readable.',
  };
}

/* ---------------- CLI ----------------
 * node growthscan.js --root <dir> --out <file> [--min <MB>]
 * Spawned by the bridge; also runnable by hand. Writes the snapshot and prints one summary line.
 */
function main() {
  const argv = process.argv.slice(2);
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const root = arg('--root') || os.homedir();
  const out = arg('--out');
  const minMB = +arg('--min');
  if (!out) { console.error('usage: node growthscan.js --root <dir> --out <file> [--min <MB>]'); process.exit(2); }
  let st;
  try { st = fs.statSync(root); } catch { st = null; }
  if (!st || !st.isDirectory()) { console.error(`root is not a readable directory: ${root}`); process.exit(2); }

  const snap = scan(root, Number.isFinite(minMB) && minMB > 0 ? { minBytes: minMB * 1048576 } : {});
  fs.writeFileSync(out, JSON.stringify(snap));
  console.log(`walked ${snap.dirs} dirs / ${snap.files} files in ${snap.scanMs} ms; ` +
              `${(snap.totalBytes / 2 ** 30).toFixed(2)} GB total, ${snap.denied} denied, ` +
              `${snap.entries.length} entries -> ${out}`);
}

if (require.main === module) main();

module.exports = { scan, MIN_RECORD_BYTES };
