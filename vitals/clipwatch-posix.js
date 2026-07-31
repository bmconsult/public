/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - clipboard history watcher, macOS.
 *
 *   node clipwatch-posix.js --out history/clipboard-2026-07-31.jsonl [--poll 1200] [--max 2000]
 *
 * THE COST IS STATED, NOT HIDDEN. The Windows watcher polls GetClipboardSequenceNumber(), an O(1)
 * counter, and only reads the clipboard on the ticks where it moved. macOS offers the same
 * primitive (NSPasteboard.changeCount) but NOT to a shell - reaching it needs a compiled helper.
 * Until the native host grows one, this watcher forks `pbpaste` per poll and hashes the result:
 * one process spawn + one full clipboard read every --poll ms. That is strictly more expensive
 * than the Windows design, which is why the default poll is 1.2 s rather than 0.9, and why the
 * cost is written here instead of discovered. An entry is only LOGGED when the hash moves.
 *
 * WHAT THIS CANNOT SEE, honestly:
 *   - images and file drops: pbpaste serves text. The row kinds 'image'/'files' never occur here.
 *   - the source app: the frontmost-app question goes through System Events, which requires
 *     automation consent and raises a TCC prompt from a background process. A monitoring tool
 *     must not spring permission dialogs, so src is '' on every row rather than sometimes-a-prompt.
 *   - the source URL: CF_HTML's SourceURL header is a Windows clipboard format; url is ''.
 * caps.js declares clip.history 'partial' at best on this platform, and only after CI has seen
 * this watcher log a real copy.
 *
 * PRIVACY: identical policy to clipwatch.ps1, same heuristics ported line for line. Everything is
 * stored including the secret-shaped (the owner asked for exactly that); the secret FLAG decides
 * how long the text survives, because the bridge scrubs flagged rows after 24 h. Off unless
 * explicitly started, capped length, pruned by age - all enforced by the bridge, as on Windows.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

/* ---- args ---- */
const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
}
const OUT = arg('out', '');
const POLL_MS = Math.max(300, parseInt(arg('poll', '1200'), 10) || 1200);
const MAX_CHARS = Math.max(100, parseInt(arg('max', '2000'), 10) || 2000);

/* Heuristics, not guarantees - ported from clipwatch.ps1's Looks-Secret so the two platforms flag
   the same shapes. A password that looks like a word still gets stored, which is exactly why this
   feature is opt-in rather than clever. */
function looksSecret(s) {
  if (!s || !s.trim()) return true;
  const t = s.trim();
  if (/^(-----BEGIN|ssh-rsa|ssh-ed25519|xox[baprs]-|sk-[A-Za-z0-9]{16,}|ghp_|github_pat_|AKIA[0-9A-Z]{16})/i.test(t)) return true;
  if (/\b(password|passwd|secret|api[_-]?key|token|bearer|private[_-]?key)\b\s*[:=]/i.test(t)) return true;
  if (/^\D*(\d[ -]?){13,19}\D*$/.test(t)) return true;                    // card-shaped
  if (t.length >= 24 && !/\s/.test(t) && /[a-z]/.test(t) && /[A-Z]/.test(t) && /\d/.test(t)) return true;
  return false;
}

function sha12(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 12).toUpperCase();
}

/* THE INJECTION SEAM: reading the pasteboard goes through one replaceable door, so the loop -
   dedupe, truncation, secret flagging, row shape - is testable off-Mac (test-inspect-posix.js). */
let readClipboard = (cb) => execFile('pbpaste', [], { maxBuffer: 4 << 20, timeout: 4000 },
  (err, out) => cb(err ? null : String(out || '')));
function _inject(fakeRead) { readClipboard = fakeRead || readClipboard; }

function makeRow(text, maxChars) {
  return {
    at: Date.now(),
    chars: text.length,
    lines: text.split('\n').length,
    src: '',                                  // see the header: no TCC prompts from a watcher
    secret: looksSecret(text),
    kind: 'text',
    text: text.slice(0, maxChars),
    url: '',
    sha: sha12(text),
  };
}

function main() {
  if (!OUT) { console.error('usage: node clipwatch-posix.js --out <file.jsonl> [--poll ms] [--max chars]'); process.exit(2); }
  const dir = path.dirname(OUT);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}

  let lastSha = null;
  let baselined = false;

  console.log(JSON.stringify({ ev: 'started', at: Date.now(), pollMs: POLL_MS }));

  const timer = setInterval(() => {
    readClipboard((text) => {
      if (text === null || text === '') return;          // empty or unreadable: nothing to record
      const sha = sha12(text);
      if (sha === lastSha) return;                       // the cheap path, taken almost every tick
      lastSha = sha;
      /* Whatever was ALREADY on the clipboard when the watcher started predates the record and is
         not a copy the user made while being watched - baseline it silently, exactly as the
         Windows watcher seeds its sequence number before the loop. */
      if (!baselined) { baselined = true; return; }
      const row = makeRow(text, MAX_CHARS);
      const json = JSON.stringify(row);
      try { fs.appendFileSync(OUT, json + '\n'); } catch {}
      console.log(json);                                 // the bridge tails this for the live view
    });
  }, POLL_MS);

  const stop = () => { clearInterval(timer); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (require.main === module) main();

module.exports = { _inject, _internal: { looksSecret, makeRow, sha12 } };
