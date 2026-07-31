#!/usr/bin/env node
/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - build a shippable copy.   node pack.js [--out <dir>]
 *
 * WHAT THIS IS FOR. The working folder is not shippable: it holds this machine's telemetry history,
 * the owner's clipboard log, an API key, an admin passphrase hash, forty screenshots, a dozen
 * scratch files and every backup ever taken. Handing someone "the vitals folder" would hand them all
 * of that. So shipping is an explicit build that copies what the product IS and nothing else.
 *
 * ALLOWLIST, NOT DENYLIST. The file set is enumerated rather than filtered. A denylist ships whatever
 * nobody thought to exclude, and the thing nobody thought to exclude is exactly the thing you regret
 * - the same reasoning the support bundle uses, for the same reason.
 *
 * It VERIFIES afterwards rather than trusting itself: the output is scanned for the machine's own
 * identifiers and for any of the known-sensitive filenames, and the build fails loudly if it finds
 * them. A packer that silently ships a secret is worse than no packer.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HERE = __dirname;
const argv = process.argv.slice(2);
const outArg = argv.indexOf('--out');
const VERSION = (() => { try { return require('./package.json').version; } catch { return '0.0.0'; } })();
const OUT = outArg >= 0 ? path.resolve(argv[outArg + 1])
                        : path.join(HERE, 'dist', `vitals-${VERSION}`);

/* ---- what the product IS ----
   The list lives in manifest.js because the public repository needs the same answer. Two copies of
   a security-relevant allowlist is how one of them quietly stops matching the other. ---- */
const { FILES, FIXTURES } = require('./manifest');

/* ---- things that must never appear in the output ---- */
/* The BACKSTOP, and it only earns its name if it covers the things you would most regret.
   Raised twice in review for missing exactly those: mft-*.json is a complete index of every file on
   the owner's drive (bridge.js calls it too sensitive for a support bundle), clips are screenshots
   of whatever was copied, ctl-baseline records their machine settings, panel-spy is a window-message
   trace, and .env / *.key / *.pem are the generic shapes any folder eventually grows.
   The allowlist means none of these ship today. A backstop exists for the day the allowlist grows a
   directory copy and quietly stops being an allowlist. */
const FORBIDDEN_NAMES = [
  /^admin-pass\.json$/, /^ask-config\.json$/, /^ask-log\.json$/, /^ask-mcp\.json$/,
  /^clipboard-.*\.jsonl$/, /^mode\.json$/, /^bundle-.*\.zip$/, /^journal-.*\.jsonl$/,
  /^metrics-.*\.jsonl$/, /^outcomes\.jsonl$/, /^control\.jsonl$/, /^selfcost\.jsonl$/,
  /^panel\.log$/, /^batteryreport\.xml$/,
  /^mft-.*\.json$/, /^clip-.*\.(png|txt)$/, /^ctl-baseline\.json$/, /^panel-spy\.log$/,
  /^scan\.log$/, /^iotrace\.json$/, /^clean-result\.json$/,
  /^\.env(\..*)?$/, /\.(key|pem|pfx|p12)$/i, /^id_(rsa|ed25519|ecdsa)$/,
];
/* Whole directories that must never be copied, whatever they contain. */
const FORBIDDEN_DIRS = [/(^|[\/])clips([\/]|$)/i, /(^|[\/])procsamples-.*/i];
const IDENTIFIERS = (() => {
  const out = new Set();
  try { out.add(os.userInfo().username); } catch {}
  try { out.add(os.homedir().split(/[\\/]/).filter(Boolean).pop()); } catch {}
  try { out.add(os.hostname().split('.')[0]); } catch {}
  return [...out].filter((x) => x && x.length >= 3);
})();

function copy(rel, destRel) {
  const src = path.join(HERE, rel);
  if (!fs.existsSync(src)) return { rel, ok: false };
  const dst = path.join(OUT, destRel || rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return { rel, ok: true, bytes: fs.statSync(dst).size };
}

console.log(`packing VITALS ${VERSION}`);
console.log(`  -> ${OUT}\n`);
/* EMPTY THE DIRECTORY, DO NOT DELETE IT.
 *
 * Testing setup.js means running the built copy, and on Windows any process whose CURRENT WORKING
 * DIRECTORY is a folder holds a handle to it: the contents delete fine, the folder itself answers
 * EBUSY. `rm -rf OUT` therefore failed for a reason that has nothing to do with the build - a
 * terminal left sitting in dist/ is enough - and node's default response was a rimraf stack trace
 * naming an internal file.
 *
 * A packer needs an EMPTY output directory, not a freshly created inode. Clearing the children gets
 * that and cannot be blocked by whoever is standing in the doorway. */
fs.mkdirSync(OUT, { recursive: true });
for (const e of fs.readdirSync(OUT)) {
  try {
    fs.rmSync(path.join(OUT, e), { recursive: true, force: true });
  } catch (err) {
    console.error(`\nCannot clear ${path.join(OUT, e)} - ${err.code || err.message}`);
    console.error('Something is still using the built copy. Find and stop it:\n');
    console.error(process.platform === 'win32'
      ? '  Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" |\n'
        + '    Where-Object { $_.CommandLine -like \'*dist*\' } | Stop-Process -Force'
      : "  pkill -f 'dist/vitals-'");
    console.error('');
    process.exit(1);
  }
}

let missing = [];
let bytes = 0, n = 0;
for (const f of FILES) {
  const r = copy(f);
  if (!r.ok) { missing.push(f); continue; }
  bytes += r.bytes; n++;
}
for (const f of FIXTURES) {
  const r = copy(path.join('history', 'procsamples', f), path.join('history', 'procsamples', f));
  if (r.ok) { bytes += r.bytes; n++; }
}

/* history/ must EXIST in a shipped copy - the bridge writes into it on first run - but it must be
   empty apart from the fixtures. A README says so, so nobody restores a backup into it by accident. */
fs.mkdirSync(path.join(OUT, 'history'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'history', 'README.txt'),
  'This folder is where VITALS writes everything it learns about the machine it is running on:\n' +
  'telemetry history, the event journal, the outcomes ledger and the Ask conversation.\n\n' +
  'Your API key and admin passphrase are NOT in here - they live in %LOCALAPPDATA%\\vitals (or\n' +
  '~/.local/share/vitals), outside the install folder, so that clearing this folder cannot be\n' +
  'mistaken for clearing your credentials.\n\n' +
  'It ships empty of MACHINE DATA on purpose. The only thing in here is procsamples/ - a handful of\n' +
  'captured Linux /proc files that the collector test suite reads.\n\n' +
  'If you are moving an install between machines, do not copy this folder across - it is the\n' +
  'previous machine\'s record, not the product.\n');

console.log(`copied ${n} files, ${(bytes / 1048576).toFixed(1)} MB`);
if (missing.length) console.log(`\nMISSING (not fatal, but check): ${missing.join(', ')}`);

/* ---- verify, do not trust ---- */
console.log('\nverifying the output...');
let fails = 0;

/* A build with no licence is not shippable whatever else is right about it - the recipient has no
   stated permission to run, copy or modify anything.
   THIS USED TO BE A PRINT STATEMENT AND NOTHING ELSE. It pushed onto `missing`, which had already
   been reported four lines earlier and was never read again, and it ran BEFORE `fails` was declared
   - so a build with no licence, no docs and no source announced itself clean and exited 0. In the
   one script whose stated job is "verify, do not trust", the verification was decorative. It now
   increments the counter that decides the exit code, which is also why the block had to move rather
   than be edited where it stood. */
for (const required of ['LICENSE', 'NOTICE.md', 'INSTALL.md', 'USING.md']) {
  if (!fs.existsSync(path.join(OUT, required))) {
    console.log(`  FAIL required document missing: ${required}`);
    fails++;
  }
}
/* Same reasoning for the product itself: an empty directory is not a clean build. */
for (const essential of ['bridge.js', 'dashboard.html', 'start.js', 'collect/caps.js', 'package.json']) {
  if (!fs.existsSync(path.join(OUT, essential))) {
    console.log(`  FAIL essential file missing: ${essential}`);
    fails++;
  }
}
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const shipped = walk(OUT);

for (const f of shipped) {
  const base = path.basename(f);
  const rel = path.relative(OUT, f);
  if (FORBIDDEN_NAMES.some((re) => re.test(base)) || FORBIDDEN_DIRS.some((re) => re.test(rel))) {
    console.log(`  FAIL a forbidden file was shipped: ${rel}`);
    fails++;
  }
}

/* EVERY LOCAL require() MUST LAND ON A SHIPPED FILE.
 *
 * This is the failure an allowlist packer invites by construction: adding a module to the source
 * tree is one edit, adding it to FILES is another, and nothing connected the two. Miss the second
 * and the build is not subtly degraded - it throws MODULE_NOT_FOUND on the first line of the first
 * run, on someone else's machine, having passed every other check here.
 *
 * Literal paths only. A computed require cannot be resolved without running the code, and a check
 * that guesses is worse than one that admits its scope. */
for (const f of shipped.filter((x) => x.endsWith('.js'))) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\brequire\(\s*['"](\.[^'"]*)['"]\s*\)/g)) {
    const target = path.resolve(path.dirname(f), m[1]);
    const found = [target, target + '.js', target + '.json', path.join(target, 'index.js')]
      .some((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
    if (!found) {
      console.log(`  FAIL ${path.relative(OUT, f)} requires '${m[1]}', which was not shipped`);
      fails++;
    }
  }
}

/* Text files only - the DLLs and the icon are binaries and will contain arbitrary byte sequences. */
const TEXT = /\.(js|html|md|ps1|sh|cmd|json|txt|cs)$/i;
for (const f of shipped.filter((x) => TEXT.test(x))) {
  const t = fs.readFileSync(f, 'utf8');
  for (const id of IDENTIFIERS) {
    /* The installer docs legitimately show an example path containing a placeholder name; a real
       account name appearing anywhere else is a leak. */
    if (new RegExp(`\\b${id}\\b`, 'i').test(t)) {
      console.log(`  FAIL "${id}" appears in ${path.relative(OUT, f)}`);
      fails++;
    }
  }
}
console.log(fails ? `\n${fails} PROBLEM(S) - this build is NOT shippable`
                  : '\nclean: no personal data, no secrets, no machine identifiers');
console.log(`\n${OUT}`);
process.exit(fails ? 1 : 0);
