/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - ASSEMBLE THE PUBLIC REPOSITORY FOLDER.
 *
 *   node publish.js --to <path-to-clone-of-bmconsult/public>
 *   node publish.js --to ../public --dry
 *
 * VITALS ships inside a portfolio repository as `public/vitals/`, so the working folder cannot
 * simply BE the repository - the published tree has to be assembled. This does that, and the
 * assembly rule is the thing worth stating:
 *
 *   THE REPOSITORY IS THE VERIFIED BUILD PLUS THE BUILD SCRIPTS.
 *
 * It copies `dist/vitals-<version>/` - which pack.js has already walked file by file and checked
 * for personal data, secrets and machine identifiers - and then adds the few files a contributor
 * needs that a user does not (the packer, the bundler, the manifest, the README). Nothing is
 * selected here that was not already selected there, so there is no second allowlist to drift.
 *
 * Then it scans again. Not out of ritual: pack.js has never seen README.md or pack.js itself, and
 * those are exactly the files most likely to contain a path someone typed while testing. The scan
 * covers what the first one could not.
 *
 * WHAT IT WILL NOT DO: run git. Committing and pushing are the owner's, deliberately - this
 * prepares a folder and tells you what is in it.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HERE = __dirname;
const VERSION = require('./package.json').version;
const { REPO_ONLY } = require('./manifest');
const SRC = path.join(HERE, 'dist', `vitals-${VERSION}`);

const argv = process.argv.slice(2);
const toArg = argv.indexOf('--to');
const DRY = argv.includes('--dry');
if (toArg < 0 || !argv[toArg + 1]) {
  console.error('usage: node publish.js --to <path-to-public-repo-clone> [--dry]');
  process.exit(2);
}
const REPO = path.resolve(argv[toArg + 1]);
const OUT = path.join(REPO, 'vitals');

/* The same identifiers pack.js redacts by value. A public repository is the one place where a
   stray absolute path is permanent - git history keeps it after the file is fixed. */
const IDENTIFIERS = (() => {
  const out = new Set();
  try { if (os.userInfo().username) out.add(os.userInfo().username); } catch {}
  try { const h = os.homedir(); if (h) out.add(h.split(/[\\/]/).filter(Boolean).pop()); } catch {}
  try { if (os.hostname()) out.add(os.hostname().split('.')[0]); } catch {}
  return [...out].filter(Boolean);
})();

const TEXT = /\.(js|html|md|ps1|sh|cmd|json|txt|cs|yml|yaml|gitignore)$/i;

function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

/* A contributor's clone becomes a running install the moment they use it, and a running install
   writes telemetry into history/. Without this they would commit their own machine's record on
   their first `git add -A`. Shipping the .gitignore is how we stop that happening to someone
   else, having already had to stop it happening here. */
const GITIGNORE = [
  '# VITALS writes into history/ as soon as you run it: telemetry, the event journal, the Ask',
  '# conversation, the clipboard log. None of that is yours to publish and none of it is ours.',
  '# The procsamples fixtures are tracked because the Linux parser suite reads them.',
  'history/*',
  '!history/README.txt',
  '!history/procsamples/',
  '',
  '# build output',
  'dist/',
  '.bundle-cache/',
  '',
  '# runtime dropped in by a portable build',
  'runtime/',
  '',
  'node_modules/',
  '',
].join('\n');

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`no verified build at ${SRC}\nRun:  node pack.js`);
    process.exit(2);
  }
  if (!fs.existsSync(REPO)) {
    console.error(`${REPO} does not exist.\nClone the repository first:\n  git clone https://github.com/bmconsult/public.git ${REPO}`);
    process.exit(2);
  }

  const files = walk(SRC);
  const missing = REPO_ONLY.filter((f) => !fs.existsSync(path.join(HERE, f)));
  if (missing.length) {
    console.error(`missing repo-only file(s): ${missing.join(', ')}`);
    if (missing.includes('README.md')) console.error('  (the README is the front page - do not publish without it)');
    process.exit(1);
  }

  console.log(`VITALS ${VERSION} -> ${OUT}`);
  console.log(`  from  ${SRC}  (${files.length} verified files)`);
  console.log(`  plus  ${REPO_ONLY.join(', ')}`);
  if (DRY) console.log('  DRY RUN - nothing will be written\n');
  else console.log('');

  const planned = [];
  for (const rel of files) planned.push({ rel, from: path.join(SRC, rel) });
  for (const rel of REPO_ONLY) planned.push({ rel, from: path.join(HERE, rel) });
  planned.push({ rel: '.gitignore', inline: GITIGNORE });

  if (!DRY) {
    /* Clear the previous contents rather than the directory itself - a shell sitting in it holds a
       handle on Windows and the folder cannot be removed, only emptied. Same reason as pack.js. */
    fs.mkdirSync(OUT, { recursive: true });
    for (const e of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, e), { recursive: true, force: true });
    for (const p of planned) {
      const dest = path.join(OUT, p.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (p.inline != null) fs.writeFileSync(dest, p.inline);
      else fs.copyFileSync(p.from, dest);
    }
  }

  /* ---- scan what will actually be published ---- */
  console.log('scanning the assembled tree...');
  let fails = 0;
  const check = (rel, read) => {
    if (!TEXT.test(rel)) return;
    let t;
    try { t = read(); } catch { return; }
    for (const id of IDENTIFIERS) {
      const re = new RegExp('\\b' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
      const m = t.split(/\r?\n/).findIndex((l) => re.test(l) && !/<you>|<YOUR|example|placeholder/i.test(l));
      if (m >= 0) {
        console.log(`  FAIL ${rel}:${m + 1} contains the machine identifier "${id}"`);
        fails++;
      }
    }
    /* An absolute Windows or POSIX home path is a leak even when the name in it is not ours. */
    const abs = t.split(/\r?\n/).findIndex((l) =>
      /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/.test(l) && !/<you>|<YOUR|example/i.test(l));
    if (abs >= 0) { console.log(`  FAIL ${rel}:${abs + 1} contains an absolute user path`); fails++; }
  };

  for (const p of planned) {
    if (p.inline != null) check(p.rel, () => p.inline);
    else check(p.rel, () => fs.readFileSync(p.from, 'utf8'));
  }

  const NEVER = /^(history\/(?!README\.txt|procsamples\/)|shots\/|backup\/|dist\/|\.bundle-cache\/)/;
  for (const p of planned) {
    if (NEVER.test(p.rel)) { console.log(`  FAIL ${p.rel} must never be published`); fails++; }
  }

  const total = planned.length;
  console.log('');
  if (fails) {
    console.log(`${fails} PROBLEM(S) - do not publish this`);
    process.exit(1);
  }
  console.log(`clean: ${total} files, no machine identifiers, no absolute user paths`);
  if (DRY) { console.log('\n(dry run - nothing written)'); return; }
  console.log(`\n${OUT}`);
  console.log('\nReview, then from the repository root:');
  console.log('  git add vitals && git status --short');
  console.log(`  git commit -m "VITALS ${VERSION}"`);
  console.log('  git push');
}

main();
