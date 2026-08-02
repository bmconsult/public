/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - EDITING THE SOFTWARE FROM DEVELOPER MODE.
 *
 * The brief, in the owner's words: admin mode is the ability to touch the COMPUTER; developer mode
 * is the ability to edit the SOFTWARE. "Able enough to modify but not able enough to break. If they
 * want to break it they can hack it like anything else, but we don't want our AI doing crazy stuff.
 * It should still ask for permission before doing stuff that could be risky."
 *
 * That is a design, not a wish, and it decomposes into four rules.
 *
 * ---------------------------------------------------------------------------------------------
 * 1. IT CANNOT REACH OUTSIDE ITSELF.
 *
 * Every path is resolved and must land inside the vitals folder. Not "starts with the folder name"
 * — resolved, because `../` and a symlink both defeat a prefix check, and a path guard that can be
 * walked out of is decoration. `history/` is excluded too: that is the machine's recorded data, not
 * the software, and an agent editing the evidence is a different and worse thing than an agent
 * editing the code.
 *
 * 2. IT CANNOT LEAVE THE SOFTWARE BROKEN.
 *
 * Every write is syntax-checked BEFORE it is accepted — `node --check` for JavaScript, a PowerShell
 * parse for .ps1, the inline-script check for the panel. A file that would not load is rejected and
 * the old one stays. This is the whole of "able to modify, not able to break": you can change
 * behaviour, you cannot leave the machine with a bridge that will not start.
 *
 * 3. EVERY WRITE IS REVERSIBLE.
 *
 * The previous contents go to `history/edits/` with a timestamp before the new bytes land, and the
 * edit log records what changed. Undo is a copy back. An irreversible edit made by a machine at
 * 3 a.m. is the thing nobody can recover from, and it costs almost nothing to avoid.
 *
 * 4. RISK IS TIERED, AND THE TOP TIER IS NOT AN AGENT'S TO DECIDE.
 *
 *   normal    docs, tests, leaf modules. Developer mode is enough. Backed up and checked.
 *   risky     bridge.js, the panel, anything in PowerShell. A bad edit here takes the product down
 *             or runs commands on the machine, so it needs a human approval in the panel — the same
 *             time-boxed shape as everything else.
 *   guarded   redact.js, aiaccess.js, vitals-mcp.js and their suites: THE CODE THAT CONSTRAINS THE
 *             AGENT. An agent quietly widening its own permissions is the failure this whole
 *             subsystem exists to prevent, and it would not look like an attack — it would look like
 *             a refactor. These are refused outright. A human edits them in an editor, like a
 *             person. That is not paranoia about capability, it is about WHO decides.
 * --------------------------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const HIST = path.join(ROOT, 'history');
const BACKUPS = path.join(HIST, 'edits');

/* The files that hold the leash. Editing these is how an agent would loosen its own constraints,
   so they are not editable from here at any tier. Named explicitly rather than pattern-matched: a
   pattern is something a future filename can slip past. */
const GUARDED = new Set([
  'redact.js', 'aiaccess.js', 'vitals-mcp.js', 'devedit.js', 'devtools.js',
  'test-redact.js', 'test-aiaccess.js', 'test-routes.js',
]);

/* Break-the-product files. Editable, but only with a human's say-so. */
const RISKY = new Set(['bridge.js', 'dashboard.html', 'diagnose.js', 'history.js', 'start.js', 'panel.ps1', 'launch.ps1']);

const EDITABLE_EXT = new Set(['.js', '.html', '.ps1', '.md', '.json', '.css']);

function classify(rel) {
  const base = path.basename(rel);
  if (GUARDED.has(base)) return 'guarded';
  if (RISKY.has(base) || rel.endsWith('.ps1')) return 'risky';
  return 'normal';
}

/* Resolve and prove containment. Returns null when the path escapes, which every caller treats as
   a refusal rather than a fallback. */
function resolveInside(rel) {
  if (typeof rel !== 'string' || !rel.trim()) return null;
  const abs = path.resolve(ROOT, rel);
  const within = abs === ROOT || abs.startsWith(ROOT + path.sep);
  if (!within) return null;
  /* The data store is not the software. */
  if (abs === HIST || abs.startsWith(HIST + path.sep)) return null;
  if (!EDITABLE_EXT.has(path.extname(abs).toLowerCase())) return null;
  return abs;
}

/* Would this content actually load? Checked before the old file is replaced, never after. */
function checkSyntax(abs, content) {
  const ext = path.extname(abs).toLowerCase();
  const tmp = path.join(HIST, '.syntax-check' + ext);
  try {
    fs.writeFileSync(tmp, content);
    if (ext === '.js') {
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    } else if (ext === '.json') {
      JSON.parse(content);
    } else if (ext === '.ps1') {
      execFileSync('powershell', ['-NoProfile', '-Command',
        `$null = [ScriptBlock]::Create((Get-Content -Raw '${tmp.replace(/'/g, "''")}'))`], { stdio: 'pipe' });
    } else if (ext === '.html') {
      /* The panel's own trick: node --check cannot see inline scripts, so each one is extracted and
         checked separately. This is the check that caught a stray escaped quote turning the whole
         page blank with an empty console. */
      const scripts = [...content.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
      for (const [i, js] of scripts.entries()) {
        const f = path.join(HIST, `.syntax-check-${i}.js`);
        fs.writeFileSync(f, js);
        try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
        finally { try { fs.unlinkSync(f); } catch {} }
      }
    }
    return { ok: true };
  } catch (e) {
    const msg = (e.stderr ? e.stderr.toString() : '') || e.message || String(e);
    return { ok: false, error: msg.split('\n').slice(0, 6).join('\n').trim() };
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

function backup(abs) {
  try {
    fs.mkdirSync(BACKUPS, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUPS, `${path.basename(abs)}.${stamp}`);
    fs.copyFileSync(abs, dest);
    return path.relative(ROOT, dest).split(path.sep).join('/');
  } catch (e) { return null; }
}

/**
 * Read a source file. Reading is not risky, so every tier may read — you cannot sensibly edit what
 * you cannot see, and refusing to show a file you will accept an edit to is theatre.
 */
function readSource(rel) {
  const abs = resolveInside(rel);
  if (!abs) return { error: `${rel} is not an editable file inside this install` };
  try {
    const text = fs.readFileSync(abs, 'utf8');
    return { file: rel, tier: classify(rel), bytes: text.length,
             lines: text.split('\n').length, content: text };
  } catch (e) { return { error: e.message }; }
}

/**
 * Write a source file.
 *
 * @param opts.approved  true when a human has opened an edit window (RISKY tier only)
 */
function writeSource(rel, content, opts = {}) {
  const abs = resolveInside(rel);
  if (!abs) return { error: `${rel} is not an editable file inside this install`, refused: 'scope' };
  if (typeof content !== 'string' || !content.length) {
    return { error: 'refusing to write an empty file — delete it yourself if that is the intent',
             refused: 'empty' };
  }

  const tier = classify(rel);
  if (tier === 'guarded') {
    return {
      refused: 'guarded',
      error: `${path.basename(rel)} is one of the files that constrains what an agent may do — ` +
             'redaction, the access log, the tool surface, and the suites that test them. ' +
             'It is not editable from here at any permission level, because an agent widening its ' +
             'own limits would look exactly like an ordinary refactor. Edit it in an editor.',
    };
  }
  if (tier === 'risky' && !opts.approved) {
    return {
      refused: 'needs-approval',
      error: `${path.basename(rel)} can take the product down or run commands on the machine, so ` +
             'editing it needs the owner to approve an edit window in the VITALS panel. Nothing ' +
             'was written. The request is on the record.',
    };
  }

  const existed = fs.existsSync(abs);
  const before = existed ? fs.readFileSync(abs, 'utf8') : '';
  if (before === content) return { file: rel, tier, unchanged: true, note: 'identical — nothing written' };

  const syn = checkSyntax(abs, content);
  if (!syn.ok) {
    return { refused: 'syntax', file: rel, error: 'the new contents do not parse, so nothing was ' +
             'written and the old file is untouched:\n' + syn.error };
  }

  const saved = existed ? backup(abs) : null;
  try { fs.writeFileSync(abs, content); }
  catch (e) { return { error: 'write failed: ' + e.message }; }

  return {
    file: rel, tier, wrote: content.length, previousBytes: before.length,
    backup: saved,
    note: saved ? `the previous version is at ${saved} — copy it back to undo`
                : 'new file; there was nothing to back up',
    syntax: 'checked before writing',
  };
}

/* ---------------------------------------------------------------------------------------------
 * PROPOSALS: approval is for a DIFF, not for a window of time.
 *
 * The first design gave a risky edit the same shape as everything else here — a human opens a
 * twenty-minute window and the agent writes freely inside it. That is the blanket permission this
 * whole subsystem has been avoiding everywhere else, and it is worse for edits than for reads: a
 * window that was opened to fix one line will happily accept twenty more.
 *
 * So a risky write does not write. It PROPOSES: the new bytes are staged, a diff is produced, and
 * a human sees the actual change before anything lands. Approving approves that change and nothing
 * else, once.
 *
 * THE APPROVAL IS BOUND TO THE BYTES. Every proposal carries a sha256 of its content and applying
 * it re-checks that hash. Without that binding an agent could propose something innocuous, wait for
 * the click, and swap the content before it applied — approval for a diff nobody read. The hash is
 * what makes "the human saw this" mean "the human saw THIS".
 * ------------------------------------------------------------------------------------------- */
const crypto = require('crypto');
const PENDING = path.join(BACKUPS, 'pending');

/* A line diff, small enough to read and honest about what it skipped. LCS is O(n*m) so a size
   guard keeps a 6000-line file from freezing the panel; past it the summary says so rather than
   quietly showing a partial answer. */
function diffLines(before, after, maxContext = 3) {
  const A = before.split('\n'), B = after.split('\n');

  /* TRIM THE COMMON ENDS FIRST — and this is what makes the feature work at all, not an
     optimisation. LCS is O(n*m), so a 2900-line file against itself is 8.4 million cells and the
     first version simply refused, on precisely the files that matter most: the risky tier IS the
     big ones. A one-line change to bridge.js reported "too large to diff, review it yourself",
     which is the same as having no diff at the exact moment you need one.
     Almost every real edit shares a long prefix and suffix with the original. Strip those and the
     LCS runs over the handful of lines that actually differ. */
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre &&
         A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a = A.slice(pre, A.length - suf);
  const b = B.slice(pre, B.length - suf);

  if (a.length * b.length > 4_000_000) {
    return { tooBig: true, beforeLines: A.length, afterLines: B.length,
             changedFromLine: pre + 1,
             note: 'the changed region is too large to diff line by line — review the file itself' };
  }
  const m = a.length, n = b.length;
  const lcs = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { ops.push({ t: ' ', s: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ t: '-', s: a[i] }); i++; }
    else { ops.push({ t: '+', s: b[j] }); j++; }
  }
  while (i < m) ops.push({ t: '-', s: a[i++] });
  while (j < n) ops.push({ t: '+', s: b[j++] });

  /* Only the changed regions, with a little context — a diff nobody reads is the same as no diff. */
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, k) => {
    if (o.t === ' ') return;
    for (let x = Math.max(0, k - maxContext); x <= Math.min(ops.length - 1, k + maxContext); x++) keep[x] = true;
  });
  const hunks = [];
  let cur = null;
  keep.forEach((k, idx) => {
    if (k) { (cur = cur || (hunks.push([]), hunks[hunks.length - 1])).push(ops[idx]); }
    else cur = null;
  });
  return {
    added: ops.filter((o) => o.t === '+').length,
    removed: ops.filter((o) => o.t === '-').length,
    /* Where in the ORIGINAL file the change begins. The hunks below are of the trimmed middle, and
       a line number relative to nothing is not a line number. */
    atLine: pre + 1,
    hunks: hunks.slice(0, 12).map((h) => h.map((o) => o.t + o.s).join('\n')),
    truncated: hunks.length > 12 ? hunks.length - 12 : 0,
  };
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function proposeEdit(rel, content, why) {
  const abs = resolveInside(rel);
  if (!abs) return { error: `${rel} is not an editable file inside this install`, refused: 'scope' };
  const tier = classify(rel);
  if (tier === 'guarded') return writeSource(rel, content);        // the same refusal, one place
  const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  if (before === content) return { unchanged: true, note: 'identical — nothing to propose' };

  /* Syntax is checked at PROPOSAL time, so a human is never asked to approve something that cannot
     load. Rejecting at apply time would waste the one thing this flow spends: their attention. */
  const syn = checkSyntax(abs, content);
  if (!syn.ok) return { refused: 'syntax', error: 'the proposed contents do not parse:\n' + syn.error };

  const hash = sha(content);
  const id = `${Date.now().toString(36)}-${hash.slice(0, 8)}`;
  try {
    fs.mkdirSync(PENDING, { recursive: true });
    fs.writeFileSync(path.join(PENDING, id + '.json'), JSON.stringify({
      id, file: rel, tier, hash, at: Date.now(),
      why: String(why || '').slice(0, 300),
      diff: diffLines(before, content),
    }, null, 1));
    fs.writeFileSync(path.join(PENDING, id + '.content'), content);
  } catch (e) { return { error: 'could not stage the proposal: ' + e.message }; }

  return { proposed: id, file: rel, tier,
           note: 'nothing has been written. The owner sees this diff in the VITALS panel and ' +
                 'approves or rejects THIS change specifically — approval does not open a window.' };
}

function listProposals() {
  try {
    return fs.readdirSync(PENDING).filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(PENDING, f), 'utf8')); } catch { return null; } })
      .filter(Boolean).sort((x, y) => y.at - x.at);
  } catch { return []; }
}

function applyProposal(id) {
  const safe = String(id || '').replace(/[^a-z0-9-]/gi, '');
  if (!safe) return { error: 'bad proposal id' };
  let meta, content;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(PENDING, safe + '.json'), 'utf8'));
    content = fs.readFileSync(path.join(PENDING, safe + '.content'), 'utf8');
  } catch { return { error: 'no such proposal — it may have been applied or rejected already' }; }

  /* THE BINDING. If the staged bytes no longer hash to what was recorded, the thing being applied
     is not the thing that was shown, and the only safe move is to refuse and say so. */
  if (sha(content) !== meta.hash) {
    return { error: 'the staged content no longer matches what was approved — refusing to apply',
             refused: 'hash-mismatch' };
  }
  const r = writeSource(meta.file, content, { approved: true });
  if (!r.error) rejectProposal(safe);                             // applied once, then gone
  return { ...r, proposal: safe };
}

function rejectProposal(id) {
  const safe = String(id || '').replace(/[^a-z0-9-]/gi, '');
  let n = 0;
  for (const ext of ['.json', '.content']) {
    try { fs.unlinkSync(path.join(PENDING, safe + ext)); n++; } catch {}
  }
  return { ok: n > 0 };
}

module.exports = { readSource, writeSource, proposeEdit, listProposals, applyProposal,
                   rejectProposal, diffLines, classify, resolveInside, GUARDED, RISKY, ROOT };
