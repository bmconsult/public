/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - EDIT SURFACE SUITE.  node test-devedit.js   (any platform)
 *
 * This guards the most consequential code in the product: the path by which an agent changes the
 * software it is running inside. Almost every check below asserts that something was REFUSED.
 *
 * The one that is not theoretical: while this was being built, a probe called writeSource on
 * bridge.js with `approved:true` and eleven bytes of content. It passed the syntax check — because
 * `const x=1;` is perfectly valid JavaScript — and the 166 KB server was replaced. Recovery took
 * one copy from history/edits/, which is exactly why the backup rule exists and why it is asserted
 * here rather than assumed.
 *
 * That incident is also the honest limit of the syntax gate, and it is worth stating plainly: it
 * proves a file LOADS, not that it is the right file. "Able to modify, not able to break" means the
 * bridge will still start; it does not mean the change was correct. The backup covers the gap.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const dev = require('./devedit');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra !== undefined ? '  [' + extra + ']' : ''}`); }
};

/* Everything writes to a scratch file inside the install, removed on exit however the run ends. */
const SCRATCH = 'test-devedit-scratch.md';
const SCRATCH_JS = 'test-devedit-scratch.js';
process.on('exit', () => {
  for (const f of [SCRATCH, SCRATCH_JS, 'test-devedit-scratch.ps1']) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }
  try {
    const p = path.join(__dirname, 'history', 'edits');
    for (const f of fs.readdirSync(p)) if (/test-devedit/.test(f)) fs.unlinkSync(path.join(p, f));
  } catch {}
});

console.log('--- IT CANNOT REACH OUTSIDE ITSELF ---');
{
  /* Resolved, not prefix-matched: `../` and a symlink both walk out of a prefix check. */
  for (const bad of ['../secrets.js', '../../.claude/CLAUDE.md', 'C:/Windows/win.ini',
                     '/etc/passwd', 'history/outcomes.jsonl', 'history/edits/anything.js']) {
    check(`refuses ${bad}`, dev.resolveInside(bad) === null);
  }
  /* AN ABSOLUTE PATH OUTSIDE THE FOLDER, WITH AN EDITABLE EXTENSION. Every case above is also
     rejected by the extension check or by containing "..", so a scope guard weakened to a naive
     `indexOf('..')` still passed this whole section — mutation found it. Only actually resolving
     the path and proving containment catches this one. */
  check('an absolute path outside the install is refused even with a source extension',
    dev.resolveInside('C:/Windows/Temp/payload.js') === null
    && dev.resolveInside('/tmp/payload.js') === null,
    'the case a prefix or substring check lets straight through');
  check('and refuses a non-source extension inside the folder', dev.resolveInside('history.jsonl') === null);
  check('but accepts an ordinary source file', dev.resolveInside('diagnose.js') !== null);
  check('the data store is NOT the software — history/ is out of scope',
    dev.resolveInside('history/metrics-2026-08-01.jsonl') === null,
    'an agent editing the evidence is worse than one editing the code');
}

console.log('\n--- THE TIERS, and who decides each one ---');
{
  check('docs and tests are normal', dev.classify('README.md') === 'normal'
    && dev.classify('test-hist.js') === 'normal');
  check('the bridge and the panel are risky', dev.classify('bridge.js') === 'risky'
    && dev.classify('dashboard.html') === 'risky');
  check('EVERY PowerShell script is risky, whatever it is called',
    dev.classify('anything-at-all.ps1') === 'risky',
    'a .ps1 runs commands on the machine — the tier follows the capability, not the filename');
  check('the code that constrains the agent is GUARDED',
    ['redact.js', 'aiaccess.js', 'vitals-mcp.js', 'devedit.js'].every((f) => dev.classify(f) === 'guarded'));
  check('and so are the suites that test it', dev.classify('test-redact.js') === 'guarded',
    'passing tests are part of the constraint; editable tests are not a constraint');
}

console.log('\n--- GUARDED IS REFUSED AT EVERY LEVEL, approval included ---');
{
  const r = dev.writeSource('redact.js', '// nope\n', { approved: true });
  check('even WITH approval, a guarded file is refused', r.refused === 'guarded', JSON.stringify(r).slice(0, 90));
  check('and the refusal explains why rather than just saying no',
    /widening its own limits/.test(r.error || ''), r.error);
  const p = dev.proposeEdit('vitals-mcp.js', '// nope\n', 'trying');
  check('and it cannot be routed around by proposing instead', p.refused === 'guarded', JSON.stringify(p).slice(0, 80));
}

console.log('\n--- IT CANNOT LEAVE THE SOFTWARE BROKEN ---');
{
  fs.writeFileSync(path.join(__dirname, SCRATCH_JS), 'const a = 1;\nmodule.exports = { a };\n');
  const before = fs.readFileSync(path.join(__dirname, SCRATCH_JS), 'utf8');
  const r = dev.writeSource(SCRATCH_JS, 'const a = ((( not javascript;');
  check('content that does not parse is refused', r.refused === 'syntax', JSON.stringify(r).slice(0, 70));
  check('and the ORIGINAL file is untouched',
    fs.readFileSync(path.join(__dirname, SCRATCH_JS), 'utf8') === before);
  check('the refusal quotes the parser, so the agent can fix it', /SyntaxError|Unexpected/.test(r.error || ''));

  const ok = dev.writeSource(SCRATCH_JS, 'const a = 2;\nmodule.exports = { a };\n');
  check('valid content IS written', ok.wrote > 0 && !ok.refused, JSON.stringify(ok).slice(0, 70));
  check('and the syntax check is reported, not assumed', ok.syntax === 'checked before writing');
}

console.log('\n--- EVERY WRITE IS REVERSIBLE — the rule that saved bridge.js ---');
{
  const p = path.join(__dirname, SCRATCH);
  fs.writeFileSync(p, '# one\n');
  const r = dev.writeSource(SCRATCH, '# two\n');
  check('a backup path is returned', !!r.backup, JSON.stringify(r).slice(0, 100));
  check('and the previous contents are actually in it',
    fs.readFileSync(path.join(__dirname, r.backup), 'utf8') === '# one\n');
  check('the new contents landed', fs.readFileSync(p, 'utf8') === '# two\n');
  check('an empty write is refused outright', dev.writeSource(SCRATCH, '').refused === 'empty',
    'truncating a file is not an edit');
  check('an identical write does nothing rather than churning a backup',
    dev.writeSource(SCRATCH, '# two\n').unchanged === true);
}

console.log('\n--- RISKY FILES ARE PROPOSED, NOT WRITTEN ---');
{
  /* Through writeSource DIRECTLY, not only through proposeEdit. The suite tested the polite path
     and never the blunt one, so removing the risky gate from writeSource passed everything —
     an agent calling the lower-level function would have written to the bridge unchallenged.
     A .ps1 is used because every .ps1 is risky by rule, which asserts the gate without putting a
     real product file behind a failing test. */
  const RISKY_SCRATCH = 'test-devedit-scratch.ps1';
  fs.writeFileSync(path.join(__dirname, RISKY_SCRATCH), 'Write-Output 1\n');
  const direct = dev.writeSource(RISKY_SCRATCH, 'Write-Output 2\n');
  check('writeSource REFUSES a risky file without approval',
    direct.refused === 'needs-approval', JSON.stringify(direct).slice(0, 90));
  check('and the file is unchanged',
    fs.readFileSync(path.join(__dirname, RISKY_SCRATCH), 'utf8') === 'Write-Output 1\n');
  const approved = dev.writeSource(RISKY_SCRATCH, 'Write-Output 3\n', { approved: true });
  check('and writes it once a human has approved', approved.wrote > 0 && !approved.refused,
    JSON.stringify(approved).slice(0, 80));
  try { fs.unlinkSync(path.join(__dirname, RISKY_SCRATCH)); } catch {}

  const src = fs.readFileSync(path.join(__dirname, 'diagnose.js'), 'utf8');
  const before = src.length;
  const p = dev.proposeEdit('diagnose.js', src + '\n// a proposed comment\n', 'testing');
  check('a risky edit returns a proposal id', !!p.proposed, JSON.stringify(p).slice(0, 80));
  check('and NOTHING was written', fs.readFileSync(path.join(__dirname, 'diagnose.js'), 'utf8').length === before);

  const list = dev.listProposals();
  const mine = list.find((x) => x.id === p.proposed);
  check('the proposal is listed for the panel', !!mine);
  check('with a readable diff rather than a whole file',
    mine && mine.diff && (mine.diff.added > 0 || mine.diff.tooBig), JSON.stringify(mine && mine.diff).slice(0, 80));
  check('and the reason the agent gave', mine && mine.why === 'testing');

  /* THE BINDING. Approval must mean "the human saw THESE bytes". */
  const pend = path.join(__dirname, 'history', 'edits', 'pending', p.proposed + '.content');
  fs.writeFileSync(pend, src + '\n// something else entirely\n');
  const applied = dev.applyProposal(p.proposed);
  check('swapping the staged bytes after proposal is REFUSED',
    applied.refused === 'hash-mismatch', JSON.stringify(applied).slice(0, 90));
  check('and diagnose.js is still untouched',
    fs.readFileSync(path.join(__dirname, 'diagnose.js'), 'utf8').length === before);
  dev.rejectProposal(p.proposed);
  check('rejecting clears the proposal', !dev.listProposals().some((x) => x.id === p.proposed));
}

console.log('\n--- THE DIFF IS USABLE ON THE FILES THAT MATTER ---');
{
  /* The risky tier IS the big files, so a diff that gives up on them gives up when it counts. */
  const src = fs.readFileSync(path.join(__dirname, 'bridge.js'), 'utf8');
  const t0 = Date.now();
  const d = dev.diffLines(src, src.replace("const http = require('http');", "const http = require('http'); // x"));
  const ms = Date.now() - t0;
  check('a one-line change in a 2900-line file still produces a real diff', !d.tooBig, JSON.stringify(d).slice(0, 80));
  check('with the right counts', d.added === 1 && d.removed === 1, `+${d.added} -${d.removed}`);
  check('and the line number in the ORIGINAL file', d.atLine > 1 && d.atLine < src.split('\n').length, d.atLine);
  check('fast enough to render in a panel', ms < 500, `${ms} ms`);
  check('identical content produces no hunks', dev.diffLines(src, src).added === 0);
}

console.log(`\n${fail ? fail + ' FAILED of ' : 'all '}${pass + fail} checks${fail ? '' : ' passed'} — it can modify, it cannot break, and it cannot touch its own leash.`);
process.exit(fail ? 1 : 0);
