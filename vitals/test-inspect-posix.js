/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* Inspection layer + clipboard watcher, logic only.   node test-inspect-posix.js  (any platform)
 *
 * Drives inspect-posix.js and clipwatch-posix.js from fixture text through their injection seams.
 * WHAT A PASS MEANS: the parsing, joining, flagging and row shapes are correct GIVEN this output.
 * It does NOT mean macOS emits this output - the fixtures below were written from documentation,
 * and the CI fixture capture (tools/capture-macos-fixtures.sh banks `netstat -anv`, launchctl and
 * a plutil'd plist every run) exists precisely so they can be corrected against real bytes.
 *
 * The fixtures are nasty the way real output is nasty: an extra column a future macOS might add,
 * a socket state the card must omit, a plist that plutil could not read, a login-items refusal,
 * an app path with spaces, and clipboard text shaped like every kind of secret.
 */

const inspect = require('./inspect-posix');
const clip = require('./clipwatch-posix');

let fails = 0, checks = 0;
function check(label, ok, detail) {
  checks++; if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  [' + detail + ']' : ''}`);
}

const I = inspect._internal;

/* ================= sockets ================= */
console.log('--- netstat -anv: pid column found from the header, not assumed ---');

const NETSTAT = `Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)     rhiwat  shiwat    pid   epid  state    options
tcp4       0      0  127.0.0.1.8790         *.*                    LISTEN      131072  131072    512      0  0x0080 0x00000106
tcp4       0      0  192.168.1.42.52741     140.82.114.22.443      ESTABLISHED 131072  131072    843      0  0x0102 0x00000206
tcp6       0      0  fe80::1%lo0.1024       fe80::1%lo0.443        ESTABLISHED 131072  131072    843      0  0x0102 0x00000206
tcp4       0      0  192.168.1.42.52802     17.57.146.52.5223      CLOSE_WAIT  131072  131072    901      0  0x0102 0x00000206
tcp4       0      0  127.0.0.1.63110        127.0.0.1.63111        FIN_WAIT_2  131072  131072    901      0  0x0102 0x00000206
udp4       0      0  *.5353                 *.*                                 786896       0    377      0  0x0000 0x00000000`;

const names = new Map([[512, 'node'], [843, 'Google Chrome'], [901, 'apsd']]);
const rows = I.parseNetstatAnv(NETSTAT, names);

check('rows parsed', Array.isArray(rows) && rows.length === 4, rows && rows.length);
if (rows) {
  const listen = rows.find((r) => r.st === 'Listen');
  check('LISTEN row: local address dot -> colon', listen && listen.l === '127.0.0.1:8790', listen && listen.l);
  check('wildcard foreign kept as *:*', listen && listen.r === '*:*', listen && listen.r);
  check('pid read from the computed column', listen && listen.pid === 512, listen && listen.pid);
  check('name joined from ps', listen && listen.pn === 'node', listen && listen.pn);
  const v6 = rows.find((r) => r.l.startsWith('fe80'));
  check('IPv6 address with %zone: port split on the LAST dot', v6 && v6.l === 'fe80::1%lo0:1024', v6 && v6.l);
  check('ESTABLISHED mapped to the Windows spelling', rows.some((r) => r.st === 'Established'));
  check('CLOSE_WAIT mapped', rows.some((r) => r.st === 'CloseWait'));
  check('FIN_WAIT_2 omitted (the Windows card omits it too)', !rows.some((r) => /Fin/i.test(r.st)));
  check('udp rows excluded', rows.every((r) => !r.l.includes('5353')));
}

/* A header with EXTRA columns before pid must still resolve, because computing beats assuming. */
const NETSTAT_WIDE = `Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)     gencnt  rhiwat  shiwat    pid   epid
tcp4       0      0  10.0.0.5.22            10.0.0.9.61000         ESTABLISHED 0x1a2   131072  131072    77      0`;
const wide = I.parseNetstatAnv(NETSTAT_WIDE, new Map([[77, 'sshd']]));
check('extra header column before pid still resolves', wide && wide.length === 1 && wide[0].pid === 77,
  JSON.stringify(wide));

check('unrecognised header refuses (null), never guesses a column',
  I.parseNetstatAnv('Proto Recv-Q Send-Q Local Foreign\ntcp4 0 0 a.1 b.2 LISTEN', new Map()) === null);

/* ================= startup ================= */
console.log('\n--- startup: plists, launchctl, login items ---');

const HOME = require('os').homedir();
const STARTUP = `=====PLIST ${HOME}/Library/LaunchAgents/com.dropbox.agent.plist
{"Label":"com.dropbox.agent","ProgramArguments":["/Applications/Dropbox.app/Contents/MacOS/Dropbox","--agent"],"RunAtLoad":true}
=====PLIST /Library/LaunchAgents/com.broken.plist
{}
=====PLIST /Library/LaunchDaemons/com.updater.daemon.plist
{"Label":"com.updater.daemon","Program":"/tmp/updater/run.sh","RunAtLoad":true}
=====PLIST /Library/LaunchDaemons/com.disabled.thing.plist
{"Label":"com.disabled.thing","Program":"/usr/local/bin/thing","Disabled":true}
=====LAUNCHCTL
PID	Status	Label
512	0	com.dropbox.agent
-	0	com.updater.daemon
=====LOGINITEMS
Dropbox, Rectangle`;

const s1 = I.parseStartup(STARTUP);
check('all rows present (4 plists + 2 login items)', s1.rows.length === 6, s1.rows.length);
const dbx = s1.rows.find((r) => r.name === 'com.dropbox.agent');
check('user agent: kind/where', dbx && dbx.kind === 'agent' && dbx.where === 'UserLaunchAgents',
  dbx && `${dbx.kind}/${dbx.where}`);
check('cmd joined from ProgramArguments (path with spaces intact)',
  dbx && dbx.cmd === '/Applications/Dropbox.app/Contents/MacOS/Dropbox --agent', dbx && dbx.cmd);
const upd = s1.rows.find((r) => r.name === 'com.updater.daemon');
check('daemon kind from its directory', upd && upd.kind === 'daemon' && upd.where === 'LaunchDaemons');
check('SUSPECT: a daemon running from /tmp is flagged', upd && upd.suspect === true);
check('legitimate app path NOT flagged', dbx && dbx.suspect === false);
const dis = s1.rows.find((r) => r.name === 'com.disabled.thing');
check('Disabled=true -> state disabled', dis && dis.state === 'disabled');
const broken = s1.rows.find((r) => r.name === 'com.broken');
check('unreadable plist still appears, named from its file', !!broken, broken && broken.name);
check('login items rows', s1.rows.filter((r) => r.kind === 'login').length === 2);
check('no login note when consent worked', s1.loginNote === null, String(s1.loginNote));

const s2 = I.parseStartup(STARTUP.replace('Dropbox, Rectangle', 'execution error: Not authorized. (-1743)'));
check('consent refusal -> note, and NOT an empty-but-silent login group',
  !!s2.loginNote && s2.rows.filter((r) => r.kind === 'login').length === 0, s2.loginNote);

/* ================= Linux sockets: /proc/net/tcp against CAPTURED kernel bytes =================
 * These rows are pasted verbatim from the 2026-07-31 CI capture (ubuntu-24.04, kernel
 * 6.17.0-1020-azure), and every expected decode below was cross-checked against the `ss -tanp`
 * output captured in the same run - two independent renderings of the same socket table. */
console.log('\n--- /proc/net/tcp: hex decode against captured bytes, cross-checked vs ss ---');

const PROC_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 9597 1 0000000000000000 100 0 0 10 0
   1: 3500007F:0035 00000000:0000 0A 00000000:00000000 00:00000000 00000000   991        0 6464 1 0000000000000000 100 0 0 10 5
   3: DB01010A:AE1C 10813FA8:0050 06 00000000:00000000 03:00000BED 00000000     0        0 0 3 0000000000000000
   5: DB01010A:958C E0CA4B14:01BB 01 00000000:00000000 02:00000509 00000000  1001        0 14047 2 0000000000000000 23 4 29 30 -1                    `;

const T = I.parseProcNetTcp(PROC_TCP, false);
check('rows parsed', Array.isArray(T) && T.length === 4, T && T.length);
if (T) {
  check('sshd listener: 00000000:0016 -> 0.0.0.0:22 Listen', T[0].l === '0.0.0.0:22' && T[0].st === 'Listen', T[0].l);
  check('inode carried for the owner join', T[0].inode === 9597, T[0].inode);
  check('resolved-stub: 3500007F:0035 -> 127.0.0.53:53 (little-endian bytes)', T[1].l === '127.0.0.53:53', T[1].l);
  check('TIME_WAIT decoded: DB01010A:AE1C -> 10.1.1.219:44572', T[2].l === '10.1.1.219:44572' && T[2].st === 'TimeWait', T[2].l);
  check('remote decoded: 10813FA8:0050 -> 168.63.129.16:80 (matches ss)', T[2].r === '168.63.129.16:80', T[2].r);
  check('ESTABLISHED remote: E0CA4B14:01BB -> 20.75.202.224:443 (matches ss)',
    T[3].r === '20.75.202.224:443' && T[3].st === 'Established', T[3].r);
}

const PROC_TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:0016 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 9599 1 0000000000000000 100 0 0 10 0
   1: 0000000000000000FFFF0000DB01010A:CF50 0000000000000000FFFF000069825514:01BB 01 00000000:00000000 00:00000000 00000000  1001        0 13308 1 0000000000000000 23 4 28 10 -1`;

const T6 = I.parseProcNetTcp(PROC_TCP6, true);
check('tcp6 rows parsed', Array.isArray(T6) && T6.length === 2, T6 && T6.length);
if (T6) {
  check('all-zero v6 compresses to :: (ss shows [::]:22)', T6[0].l === ':::22', T6[0].l);
  check('v4-mapped decoded: ...FFFF0000DB01010A:CF50 -> ::ffff:10.1.1.219:53072 (matches ss)',
    T6[1].l === '::ffff:10.1.1.219:53072', T6[1].l);
  check('v4-mapped remote: 69825514 -> ::ffff:20.85.130.105 (matches ss)',
    T6[1].r === '::ffff:20.85.130.105:443', T6[1].r);
}

check('unrecognised header refuses (null), never a guessed table',
  I.parseProcNetTcp('sl local rem st\n0: 00000000:0016 00000000:0000 0A x x x', false) === null);
check('a state the card omits (FIN_WAIT1 = 04) is skipped',
  (I.parseProcNetTcp(PROC_TCP.replace(' 06 ', ' 04 '), false) || []).length === 3);

/* ================= Linux startup: systemctl + blame + XDG, captured bytes ================= */
console.log('\n--- linux startup: unit files, blame join, .desktop entries ---');

/* The UNITS and BLAME sections are verbatim from the CI capture; the .desktop body is the one
   shape NOT captured (only filenames were), so the workflow now cats the real files - correct
   this fixture if they disagree. */
const LINUX_STARTUP = `=====UNITS
UNIT FILE                              STATE   PRESET
apparmor.service                       enabled enabled
chrony.service                         enabled enabled
containerd.service                     enabled enabled
cron.service                           enabled enabled
docker.service                         enabled enabled
getty@.service                         enabled enabled

6 unit files listed.
=====BLAME
14.844s primer.service
 2.905s cloud-init-local.service
 1.700s docker.service
  820ms fictional-fast.service
=====DESKTOP /etc/xdg/autostart/snap-userd-autostart.desktop
[Desktop Entry]
Type=Application
Name=Snap user application autostart helper
Exec=/usr/bin/snap userd --autostart
X-GNOME-Autostart-Delay=15
=====DESKTOP ${HOME}/.config/autostart/dropper.desktop
[Desktop Entry]
Name=Totally Fine Helper
Exec=/tmp/.x/helper --quiet
Hidden=true`;

const LS = I.parseLinuxStartup(LINUX_STARTUP);
check('unit files parsed by shape (header demanded)', LS.unitsParsed === true);
check('all rows present (6 services + 2 desktop)', LS.rows.length === 8, LS.rows.length);
const dkr = LS.rows.find((r) => r.name === 'docker.service');
check('service row: kind/where/state', dkr && dkr.kind === 'service' && dkr.where === 'systemd' && dkr.state === 'enabled');
check('blame joined onto its unit as measured boot cost', dkr && dkr.cmd === '1.7s at boot', dkr && dkr.cmd);
const chr = LS.rows.find((r) => r.name === 'chrony.service');
check('unit with no blame line carries no cost, not a zero', chr && chr.cmd === '', chr && JSON.stringify(chr.cmd));
check('template unit kept (getty@ IS enabled)', LS.rows.some((r) => r.name === 'getty@.service'));
const snap = LS.rows.find((r) => /Snap user/.test(r.name));
check('xdg entry: kind login, Name= wins over filename', snap && snap.kind === 'login' && snap.where === 'XDGAutostart',
  snap && `${snap.kind}/${snap.where}`);
check('xdg Exec carried', snap && snap.cmd === '/usr/bin/snap userd --autostart', snap && snap.cmd);
const drp = LS.rows.find((r) => r.name === 'Totally Fine Helper');
check('user autostart: where from the home prefix', drp && drp.where === 'UserAutostart', drp && drp.where);
check('Hidden=true -> disabled', drp && drp.state === 'disabled');
check('SUSPECT: autostart running from /tmp is flagged', drp && drp.suspect === true);
check('legitimate packaged path NOT flagged', snap && snap.suspect === false);

check('blame minutes form parses', I.parseBlame(' 1min 2.5s slow.service').get('slow.service') === 62.5);
check('garbage systemctl output refuses (null), never an empty-but-confident list',
  I.parseUnitFiles('command not found') === null);
const GS = I.parseLinuxStartup('=====UNITS\nno such command\n=====BLAME\n');
check('nothing parseable -> no rows AND unitsParsed false (the route errors rather than fabricates)',
  GS.rows.length === 0 && GS.unitsParsed === false);

/* ================= clipboard watcher ================= */
console.log('\n--- clipwatch: secret shapes, truncation, row contract ---');
const C = clip._internal;

const secretShaped = [
  ['-----BEGIN RSA PRIVATE KEY-----', 'PEM key'],
  ['ghp_abcdefghijklmnopqrstuvwxyz012345', 'GitHub token'],
  ['AKIAIOSFODNN7EXAMPLE', 'AWS key id'],
  ['password: hunter2', 'password assignment'],
  ['4111 1111 1111 1111', 'card-shaped'],
  ['aB3dE6gH9jK2mN5pQ8sT1vW4yZ', 'high-entropy token'],
];
for (const [s, why] of secretShaped) check(`secret: ${why}`, C.looksSecret(s) === true);

const ordinary = [
  ['the quarterly report is due friday', 'plain sentence'],
  ['C:\\Users\\example\\Downloads\\code', 'a path'],
  ['555-0142', 'a short number'],
];
for (const [s, why] of ordinary) check(`not secret: ${why}`, C.looksSecret(s) === false);

const long = 'x'.repeat(5000) + '\nline2';
const row = C.makeRow(long, 2000);
check('text truncated to max, chars reports the FULL length', row.text.length === 2000 && row.chars === 5006,
  `${row.text.length}/${row.chars}`);
check('lines counted from the full text', row.lines === 2, row.lines);
check('sha is 12 hex chars (matches the Windows watcher)', /^[0-9A-F]{12}$/.test(row.sha), row.sha);
check('kind is text; src and url honestly empty (see the watcher header)',
  row.kind === 'text' && row.src === '' && row.url === '');
for (const k of ['at', 'chars', 'lines', 'src', 'secret', 'kind', 'text', 'url', 'sha']) {
  check(`row has .${k} (the clipwatch.ps1 contract)`, k in row);
}

console.log('');
if (fails) { console.log(`${fails} FAILED of ${checks}`); process.exit(1); }
console.log(`all ${checks} checks passed - the LOGIC is right given this output.\n` +
            'Not verification that macOS emits it: CI\'s captured fixtures correct these when they disagree.');
