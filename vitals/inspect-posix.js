/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - the inspection layer off Windows: sockets-with-owners and the startup scan.
 *
 * These are the READ half of what actions-posix.js is to actions: routes that bridge.js implements
 * as PowerShell one-shots (`SCRIPTS.conns`, `SCRIPTS.startup`), reimplemented natively so the SYS
 * socket card and the BOOT page work on macOS. Same route contracts, same row shapes, so the page
 * does not need a platform branch.
 *
 * UNVERIFIED ON HARDWARE. Every parser below is written from documented tool output, the exact
 * practice that has produced every previous macOS defect in this project - which is why each one
 * parses BY SHAPE with a validation gate, and why the fixtures in test-inspect-posix.js are due to
 * be replaced by CI-captured real output (tools/capture-macos-fixtures.sh already banks
 * `netstat -anv` and the LaunchAgents/plutil/launchctl set on every run). caps.js keeps
 * net.sockets and scan.startup false until the live run proves them.
 *
 * WHY netstat -anv AND NOT lsof: lsof -i without root shows only processes belonging to this user.
 * netstat -anv reads the socket list via sysctl and reports the owning pid for EVERY socket,
 * unprivileged - which is the whole point of the SYS card ("what is talking, and as whom").
 */

const os = require('os');
const { execFile } = require('child_process');

/* THE INJECTION SEAM, same pattern as collect/darwin.js: all knowledge of the machine arrives as
   text through this one door, so both inspectors are testable on a machine that is not a Mac. */
let sh = (cmd, cb) => execFile('/bin/sh', ['-c', cmd], { maxBuffer: 8 << 20, timeout: 10000 },
  (err, out) => cb(err ? '' : String(out || '')));
function _inject(fakeSh) { sh = fakeSh || sh; }

/* ---------------- sockets with owning process (the Windows SCRIPTS.conns shape) ----------------
 *
 * macOS netstat data rows have ONE token per address while the header spells "Local Address" as
 * two words - so a column name's data index is its header index minus one per multi-word column
 * before it (two: Local Address, Foreign Address). Computing pid's position from the header rather
 * than hard-coding it survives the extra columns some releases append; a row whose computed pid
 * cell is not numeric is dropped rather than guessed at. */

const STATE_MAP = {
  LISTEN: 'Listen', ESTABLISHED: 'Established', TIME_WAIT: 'TimeWait',
  CLOSE_WAIT: 'CloseWait', SYN_SENT: 'SynSent',
};

/* "127.0.0.1.8790" -> "127.0.0.1:8790". The port is everything after the LAST dot, which also
   handles IPv6 forms like "fe80::1%en0.546" and the wildcard "*.*". */
function addrPort(a) {
  const i = String(a || '').lastIndexOf('.');
  if (i < 0) return String(a || '');
  return a.slice(0, i) + ':' + a.slice(i + 1);
}

function parseNetstatAnv(netTxt, names) {
  const lines = String(netTxt || '').split('\n');
  /* Locate the header and compute where pid lives in DATA rows. */
  const hdr = lines.find((l) => /\bProto\b/.test(l) && /\bpid\b/i.test(l));
  if (!hdr) return null;                       // not the format we know; null, never a guessed table
  const toks = hdr.trim().split(/\s+/);
  const pidHdr = toks.findIndex((t) => t.toLowerCase() === 'pid');
  if (pidHdr < 0) return null;
  /* Each two-word column BEFORE pid ("Local Address", "Foreign Address") occupies two header
     tokens but one data token. */
  let twoWord = 0;
  for (let i = 0; i < pidHdr; i++) if (toks[i] === 'Address') twoWord++;
  const pidIdx = pidHdr - twoWord;

  const rows = [];
  for (const line of lines) {
    const p = line.trim().split(/\s+/);
    if (!p.length || !/^tcp/.test(p[0])) continue;
    const st = STATE_MAP[p[5]];
    if (!st) continue;                         // states the Windows card also omits
    const pid = /^\d+$/.test(p[pidIdx] || '') ? +p[pidIdx] : null;
    if (pid === null) continue;                // shape mismatch: drop the row, not invent an owner
    rows.push({ l: addrPort(p[3]), r: addrPort(p[4]), st, pid, pn: names.get(pid) || null });
  }
  return rows;
}

function conns(cb) {
  if (process.platform !== 'darwin') return cb(new Error('sockets-with-owners is not ported to ' + process.platform));
  sh('netstat -anv -p tcp 2>/dev/null; echo "---PS---"; ps -Ao pid,comm', (out) => {
    const [netTxt = '', psTxt = ''] = String(out || '').split('---PS---');
    const names = new Map();
    for (const line of psTxt.split('\n')) {
      const m = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (m) names.set(+m[1], (m[2].split('/').pop() || m[2]).trim());
    }
    const rows = parseNetstatAnv(netTxt, names);
    if (rows === null) {
      return cb(new Error('netstat -anv did not emit the expected header; refusing to guess at column positions'));
    }
    cb(null, rows);
  });
}

/* ---------------- startup scan (the Windows SCRIPTS.startup shape) ----------------
 *
 * macOS's autostart hiding places, mapped onto the same row contract the BOOT page renders:
 *   kind 'agent'   ~/Library/LaunchAgents and /Library/LaunchAgents  (run as the user)
 *   kind 'daemon'  /Library/LaunchDaemons                            (run as root at boot)
 *   kind 'login'   System Events login items                         (the Login Items pane)
 * /System is Apple's own and is excluded the same way the Windows scan excludes \Microsoft\ tasks.
 *
 * plutil converts Apple's (often binary) plists to JSON, so there is no plist parser to write.
 * Login items go through osascript, which on a locked-down machine may need (and be refused)
 * automation consent - a refusal yields no login rows and a note, never a fabricated empty. */

const SUSPECT_RE = /\/(?:private\/)?(?:tmp|var\/tmp)\/|\/Downloads\/|\/Users\/Shared\//;

function parseLaunchctlList(txt) {
  const running = new Map();                   // label -> pid
  for (const line of String(txt || '').split('\n')) {
    const m = /^\s*(\d+|-)\s+(-?\d+)\s+(\S+)/.exec(line);
    if (m) running.set(m[3], m[1] === '-' ? null : +m[1]);
  }
  return running;
}

function parseStartup(out) {
  const rows = [];
  let loginNote = null;
  const sections = String(out || '').split(/^=====/m);
  let launchctl = new Map();
  const plists = [];
  for (const s of sections) {
    if (s.startsWith('LAUNCHCTL')) launchctl = parseLaunchctlList(s.slice('LAUNCHCTL'.length));
    else if (s.startsWith('LOGINITEMS')) {
      const body = s.slice('LOGINITEMS'.length).trim();
      if (!body || /error|not allowed|execution error/i.test(body)) {
        loginNote = 'login items unavailable (System Events automation consent was not granted)';
      } else {
        for (const name of body.split(',').map((x) => x.trim()).filter(Boolean)) {
          rows.push({ kind: 'login', where: 'LoginItems', name, cmd: '', state: 'enabled', suspect: false });
        }
      }
    } else if (s.startsWith('PLIST ')) plists.push(s);
  }
  for (const s of plists) {
    const nl = s.indexOf('\n');
    const file = s.slice('PLIST '.length, nl).trim();
    let d = {};
    try { d = JSON.parse(s.slice(nl + 1)); } catch { /* unreadable plist: the row still appears, by filename */ }
    const kind = /LaunchDaemons/.test(file) ? 'daemon' : 'agent';
    const where = file.startsWith(os.homedir()) ? 'UserLaunchAgents'
      : /LaunchDaemons/.test(file) ? 'LaunchDaemons' : 'LaunchAgents';
    const name = d.Label || (file.split('/').pop() || file).replace(/\.plist$/, '');
    const cmd = typeof d.Program === 'string' ? d.Program
      : Array.isArray(d.ProgramArguments) ? d.ProgramArguments.join(' ') : '';
    rows.push({
      kind, where, name, cmd,
      state: d.Disabled === true ? 'disabled' : 'enabled',
      running: launchctl.has(d.Label) && launchctl.get(d.Label) != null || undefined,
      suspect: SUSPECT_RE.test(cmd),
    });
  }
  return { rows, loginNote };
}

function startup(cb) {
  if (process.platform !== 'darwin') return cb(new Error('the startup scan is not ported to ' + process.platform));
  const cmd = `
for d in "$HOME/Library/LaunchAgents" "/Library/LaunchAgents" "/Library/LaunchDaemons"; do
  for f in "$d"/*.plist; do
    [ -e "$f" ] || continue
    printf '=====PLIST %s\\n' "$f"
    plutil -convert json -o - "$f" 2>/dev/null || echo '{}'
    echo
  done
done
echo "=====LAUNCHCTL"
launchctl list 2>/dev/null
echo "=====LOGINITEMS"
osascript -e 'tell application "System Events" to get the name of every login item' 2>/dev/null || true`;
  sh(cmd, (out) => {
    const { rows, loginNote } = parseStartup(out);
    /* The consent refusal is passed SEPARATELY, not attached to the array - a property set on an
       array does not survive JSON.stringify, so "riding along" would silently vanish at the route.
       The bridge logs it; a denied read must at least leave a trace, because a denied read
       rendered as an empty list is a fabricated "nothing starts here". */
    cb(null, rows, loginNote);
  });
}

module.exports = {
  conns, startup, _inject,
  _internal: { parseNetstatAnv, parseStartup, parseLaunchctlList, addrPort, SUSPECT_RE, STATE_MAP },
};
