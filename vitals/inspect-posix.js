/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - the inspection layer off Windows: sockets-with-owners and the startup scan.
 *
 * These are the READ half of what actions-posix.js is to actions: routes that bridge.js implements
 * as PowerShell one-shots (`SCRIPTS.conns`, `SCRIPTS.startup`), reimplemented natively so the SYS
 * socket card and the BOOT page work on macOS and Linux. Same route contracts, same row shapes, so
 * the page does not need a platform branch. The macOS half shells out (netstat, plutil); the Linux
 * half reads /proc directly for sockets and shells out once for the startup scan.
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
const fs = require('fs');
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

/* ---------------- Linux sockets: /proc/net/tcp + tcp6, read directly ----------------
 *
 * No subprocess: the kernel publishes every TCP socket as hex text, and the pid join comes from
 * readlink over /proc/<pid>/fd - the same source `ss -tanp` uses. Written against the CI capture
 * from ubuntu-24.04 (kernel 6.17.0-1020-azure), cross-checked row for row against the ss output
 * captured beside it: 3500007F:0035 is 127.0.0.53:53, DB01010A:958C<->E0CA4B14:01BB is
 * 10.1.1.219:38284 <-> 20.75.202.224:443 ESTAB, and 0000000000000000FFFF0000DB01010A:CF50 is
 * [::ffff:10.1.1.219]:53072.
 *
 * THE OWNERSHIP CEILING, verified in that same capture: /proc/<pid>/fd is readable only for your
 * own processes, and ss -tanp shows the identical limit - its Process column was populated for the
 * runner user's own pids (hosted-compute, Runner.Listener) and empty for root's sshd and
 * systemd-resolved. So unelevated, the owner join covers this session; every OTHER socket still
 * appears, with pid null rather than dropped - hiding root's listeners would defeat the card
 * ("what is talking"). This is why caps.js will call net.sockets partial here, where Windows
 * (Get-NetTCPConnection names every owner unprivileged) is true. */

const TCP_STATES = { '0A': 'Listen', '01': 'Established', '06': 'TimeWait', '08': 'CloseWait', '02': 'SynSent' };

function hexV4(h) {
  /* 8 hex chars, one 32-bit word in LITTLE-endian byte order: DB01010A -> 10.1.1.219 */
  const b = [];
  for (let i = 6; i >= 0; i -= 2) b.push(parseInt(h.slice(i, i + 2), 16));
  return b.join('.');
}

function hexV6(h) {
  /* 32 hex chars: four 32-bit words, each word's BYTES reversed (little-endian within the word).
     Rendered like ss renders it: v4-mapped addresses as ::ffff:a.b.c.d, else grouped hex with the
     longest zero run compressed. */
  const bytes = [];
  for (let w = 0; w < 4; w++) {
    for (let i = 6; i >= 0; i -= 2) bytes.push(parseInt(h.slice(w * 8 + i, w * 8 + i + 2), 16));
  }
  if (bytes.slice(0, 10).every((x) => x === 0) && bytes[10] === 255 && bytes[11] === 255) {
    return '::ffff:' + bytes.slice(12).join('.');
  }
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  /* longest run of zero groups -> '::' (prefer the first of equal runs, like inet_ntop) */
  let best = -1, bestLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] !== '0') continue;
    let j = i; while (j < 8 && groups[j] === '0') j++;
    if (j - i > bestLen) { best = i; bestLen = j - i; }
    i = j;
  }
  if (bestLen < 2) return groups.join(':');
  return groups.slice(0, best).join(':') + '::' + groups.slice(best + bestLen).join(':');
}

function parseProcNetTcp(txt, v6) {
  const lines = String(txt || '').split('\n');
  /* Shape gate: the header names the columns we index. A kernel that changes this file changes
     everything downstream, so refuse rather than misread. */
  if (!lines.length || !/local_address/.test(lines[0]) || !/inode/.test(lines[0])) return null;
  const addr = (a) => {
    const i = a.lastIndexOf(':');
    return (v6 ? hexV6(a.slice(0, i)) : hexV4(a.slice(0, i))) + ':' + parseInt(a.slice(i + 1), 16);
  };
  const rows = [];
  for (const line of lines.slice(1)) {
    const p = line.trim().split(/\s+/);
    if (p.length < 10) continue;
    const st = TCP_STATES[p[3]];
    if (!st) continue;                         // states the Windows card also omits
    rows.push({ l: addr(p[1]), r: addr(p[2]), st, inode: +p[9] || 0 });
  }
  return rows;
}

/* socket inode -> owning pid, for every pid whose /proc/<pid>/fd this user may read. */
function ownSocketInodes() {
  const map = new Map();
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return map; }
  for (const d of pids) {
    let fds;
    try { fds = fs.readdirSync(`/proc/${d}/fd`); } catch { continue; }   // not ours: the ceiling above
    for (const fd of fds) {
      try {
        const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${d}/fd/${fd}`));
        if (m) map.set(+m[1], +d);
      } catch { /* fd closed between readdir and readlink */ }
    }
  }
  return map;
}

function linuxConns(cb) {
  let tcp4, tcp6;
  try { tcp4 = fs.readFileSync('/proc/net/tcp', 'utf8'); } catch { tcp4 = ''; }
  try { tcp6 = fs.readFileSync('/proc/net/tcp6', 'utf8'); } catch { tcp6 = ''; }
  const r4 = parseProcNetTcp(tcp4, false);
  const r6 = parseProcNetTcp(tcp6, true);
  if (r4 === null && r6 === null) {
    return cb(new Error('/proc/net/tcp did not have the expected header; refusing to guess at columns'));
  }
  const owners = ownSocketInodes();
  const rows = [...(r4 || []), ...(r6 || [])].map((row) => {
    const pid = owners.get(row.inode) || null;
    let pn = null;
    if (pid) { try { pn = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() || null; } catch {} }
    return { l: row.l, r: row.r, st: row.st, pid, pn };
  });
  cb(null, rows);
}

function conns(cb) {
  if (process.platform === 'linux') return linuxConns(cb);
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

/* ---------------- Linux startup scan ----------------
 *
 * Three sources, every one written against the CI capture rather than documentation:
 *   kind 'service'  systemctl list-unit-files --type=service --state=enabled  (what boots)
 *                   joined to systemd-analyze blame                           (what it COST)
 *   kind 'login'    /etc/xdg/autostart and ~/.config/autostart .desktop files (desktop session)
 * Mapped onto the same row contract as the Windows and macOS scans, and onto kinds the BOOT page
 * already draws ('service', 'login') - a new kind would be counted in the total yet rendered
 * nowhere, which is how a scan looks like it lost entries.
 *
 * NOT covered, on purpose: `systemctl --user` needs a user session bus a headless box lacks, and
 * cron @reboot lines were not in the capture - both are absent rather than guessed at. The blame
 * join is best-effort: on a long-running box systemd-analyze may refuse ("still running") and the
 * rows simply carry no cost, which is a missing enrichment, not a missing entry. */

function parseUnitFiles(txt) {
  const lines = String(txt || '').split('\n');
  if (!lines.some((l) => /^UNIT FILE\s+STATE/.test(l))) return null;   // shape gate: refuse, never guess
  const out = [];
  for (const l of lines) {
    const m = /^(\S+\.(?:service|timer))\s+(enabled|enabled-runtime)\b/.exec(l.trim());
    if (m) out.push(m[1]);
  }
  return out;
}

function parseBlame(txt) {
  /* "14.844s primer.service" / " 1min 2.3s foo.service" / "820ms bar.service" */
  const cost = new Map();
  for (const l of String(txt || '').split('\n')) {
    const m = /^\s*(?:(\d+)min\s+)?([\d.]+)(ms|s)\s+(\S+)\s*$/.exec(l);
    if (!m) continue;
    const secs = (m[1] ? +m[1] * 60 : 0) + (+m[2]) * (m[3] === 'ms' ? 0.001 : 1);
    cost.set(m[4], Math.round(secs * 1000) / 1000);
  }
  return cost;
}

function parseDesktopEntry(txt) {
  /* freedesktop .desktop: INI-ish, [Desktop Entry] section. First occurrence of each key wins. */
  const get = (k) => {
    const m = new RegExp('^' + k + '=(.*)$', 'm').exec(String(txt || ''));
    return m ? m[1].trim() : '';
  };
  return {
    name: get('Name'),
    exec: get('Exec'),
    disabled: /^true$/i.test(get('Hidden')) || /^false$/i.test(get('X-GNOME-Autostart-enabled')),
  };
}

function parseLinuxStartup(out) {
  const rows = [];
  let units = null, blame = new Map();
  const sections = String(out || '').split(/^=====/m);
  for (const s of sections) {
    if (s.startsWith('UNITS')) units = parseUnitFiles(s.slice('UNITS'.length));
    else if (s.startsWith('BLAME')) blame = parseBlame(s.slice('BLAME'.length));
    else if (s.startsWith('DESKTOP ')) {
      const nl = s.indexOf('\n');
      const file = s.slice('DESKTOP '.length, nl).trim();
      const d = parseDesktopEntry(s.slice(nl + 1));
      rows.push({
        kind: 'login',
        where: file.startsWith(os.homedir()) ? 'UserAutostart' : 'XDGAutostart',
        name: d.name || (file.split('/').pop() || file).replace(/\.desktop$/, ''),
        cmd: d.exec,
        state: d.disabled ? 'disabled' : 'enabled',
        suspect: SUSPECT_RE.test(d.exec),
      });
    }
  }
  for (const u of units || []) {
    const secs = blame.get(u);
    rows.push({
      kind: 'service', where: 'systemd', name: u,
      /* cmd carries the measured boot cost where systemd measured one - the question a BOOT page
         answers is "what is this costing me", and blame is the kernel-adjacent truth of it. */
      cmd: secs != null ? `${secs}s at boot` : '',
      state: 'enabled', suspect: false,
    });
  }
  return { rows, unitsParsed: units !== null };
}

function linuxStartup(cb) {
  const cmd = `
echo "=====UNITS"
systemctl list-unit-files --type=service --state=enabled --no-pager 2>/dev/null
echo "=====BLAME"
systemd-analyze blame --no-pager 2>/dev/null
for d in /etc/xdg/autostart "$HOME/.config/autostart"; do
  for f in "$d"/*.desktop; do
    [ -e "$f" ] || continue
    printf '=====DESKTOP %s\\n' "$f"
    cat "$f" 2>/dev/null
    echo
  done
done`;
  sh(cmd, (out) => {
    const { rows, unitsParsed } = parseLinuxStartup(out);
    if (!rows.length && !unitsParsed) {
      /* systemctl absent or unrecognised AND no autostart files: refuse rather than render a
         fabricated "nothing starts here" over what is actually an unreadable machine. */
      return cb(new Error('systemctl did not answer and no autostart entries were found; this does not look like a systemd host'));
    }
    cb(null, rows, null);
  });
}

function startup(cb) {
  if (process.platform === 'linux') return linuxStartup(cb);
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
  _internal: {
    parseNetstatAnv, parseStartup, parseLaunchctlList, addrPort, SUSPECT_RE, STATE_MAP,
    /* linux */
    parseProcNetTcp, hexV4, hexV6, parseUnitFiles, parseBlame, parseDesktopEntry,
    parseLinuxStartup, TCP_STATES,
  },
};
