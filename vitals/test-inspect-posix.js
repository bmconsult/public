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
