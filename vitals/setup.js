/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - SETUP.  Double-click Setup.cmd (Windows) or ./setup.sh (macOS, Linux).
 *
 * THE IDEA. Every installer draws a progress bar that is a guess, and most of them are a timer
 * dressed as a measurement. In a product whose one rule is "never show a number you did not
 * measure", that would be the first thing a new user sees us do, and it would be a lie.
 *
 * So this installer measures. Every number on the screen is real work that actually happened:
 * bytes hashed, files verified, the runtime found, the platform's capabilities probed, and then -
 * the part worth building - the machine itself, read live. The install does not finish and THEN
 * offer to run VITALS. Finishing IS running it: the last stage starts the bridge, takes a real
 * sample, and puts your own CPU, memory, disks and battery on the screen. You do not get a
 * checkmark that claims it works, you get the readings that prove it.
 *
 * The pacing is honest too. Stages appear as they complete, so the rhythm of the screen is the
 * rhythm of the actual work - a fast machine feels fast because it IS fast. Nothing is delayed to
 * look busy and nothing is padded to look thorough. (design-principles F5: motion must mean data.)
 *
 * WHAT IT WILL NOT DO. It writes nothing outside this folder unless you tick a box, and every box
 * is off by default with its exact consequence printed next to it. Options that this platform
 * cannot honour are absent with a reason rather than present and broken - the same three-state
 * rule the capability manifest uses (M2: an absent sensor and a zero are different facts).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const HERE = __dirname;
const VERSION = (() => { try { return require('./package.json').version; } catch { return '0.0.0'; } })();
const PORT = +process.env.VITALS_PORT || 8790;
const IS_WIN = process.platform === 'win32';

/* The setup UI gets its own ephemeral port. Sharing the bridge's would mean setup could not run
   before the bridge exists, which is the entire situation setup is for. */
let uiPort = 0;

/* ------------------------------------------------------------------ event bus */

const clients = new Set();
const journal = [];          // replayed to a client that connects late, so nothing is missed

function emit(ev) {
  journal.push(ev);
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) { try { res.write(line); } catch {} }
}

const stage = (id, state, label, detail) => emit({ t: 'stage', id, state, label, detail });
const fact = (group, key, label, value, state) => emit({ t: 'fact', group, key, label, value, state });

/* ------------------------------------------------------------------ stages */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Stage 1. VERIFY THE PAYLOAD.
   Genuinely useful and genuinely measurable: hash every shipped file. A half-extracted zip or a
   truncated download is the most common broken install there is, and it is exactly the failure
   that otherwise surfaces later as an incomprehensible runtime error. The progress here is a real
   fraction - files done over files found - so the bar is entitled to exist. */
async function verifyPayload() {
  stage('payload', 'run', 'Verifying the payload');
  const skip = /^(history|node_modules|\.bundle-cache|dist)$/;
  const files = [];
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!skip.test(e.name)) walk(path.join(dir, e.name), rel + e.name + '/'); continue; }
      files.push({ abs: path.join(dir, e.name), rel: rel + e.name });
    }
  })(HERE, '');

  let bytes = 0, done = 0;
  const h = crypto.createHash('sha256');
  for (const f of files) {
    try {
      const buf = fs.readFileSync(f.abs);
      bytes += buf.length;
      h.update(f.rel); h.update(buf);
    } catch { /* unreadable counts as present-but-unverifiable; the essentials check below decides */ }
    done++;
    if (done % 6 === 0 || done === files.length) {
      emit({ t: 'progress', id: 'payload', done, total: files.length, bytes });
      await sleep(0);       // yield so the stream flushes; not a delay, a scheduling point
    }
  }

  /* A hash of the whole tree is a fingerprint, not a certificate - there is no signature to check
     it against. Say that plainly rather than implying an authenticity we cannot prove. */
  const digest = h.digest('hex').slice(0, 16);
  const essentials = ['bridge.js', 'dashboard.html', 'start.js', 'collect/caps.js', 'LICENSE'];
  const missing = essentials.filter((f) => !fs.existsSync(path.join(HERE, f)));
  if (missing.length) {
    stage('payload', 'fail', 'Payload incomplete', `missing: ${missing.join(', ')}`);
    return false;
  }
  fact('payload', 'files', 'Files', String(files.length), 'ok');
  fact('payload', 'bytes', 'Size', (bytes / 1048576).toFixed(1) + ' MB', 'ok');
  fact('payload', 'digest', 'Fingerprint', digest, 'ok');
  stage('payload', 'ok', 'Payload verified', `${files.length} files, ${(bytes / 1048576).toFixed(1)} MB`);
  return true;
}

/* Stage 2. THE RUNTIME. Which Node is about to run this, and did it come in the box. */
async function checkRuntime() {
  stage('runtime', 'run', 'Locating the runtime');
  const bundled = IS_WIN ? path.join(HERE, 'runtime', 'node.exe') : path.join(HERE, 'runtime', 'bin', 'node');
  const isBundled = process.execPath.toLowerCase().startsWith(path.dirname(bundled).toLowerCase())
    || fs.existsSync(bundled);
  const major = +process.versions.node.split('.')[0];
  fact('runtime', 'node', 'Node', 'v' + process.versions.node, major >= 18 ? 'ok' : 'warn');
  fact('runtime', 'origin', 'Runtime', isBundled ? 'bundled — nothing to install' : 'found on this system', 'ok');
  fact('runtime', 'arch', 'Architecture', `${process.platform} ${os.arch()}`, 'ok');
  if (major < 18) {
    stage('runtime', 'fail', 'Node 18 or newer is required', `this is v${process.versions.node}`);
    return false;
  }
  stage('runtime', 'ok', isBundled ? 'Runtime bundled' : 'Runtime found',
    `Node v${process.versions.node} · ${os.arch()}`);
  return true;
}

/* Stage 3. WHAT THIS INSTALL CAN DO HERE.
   The capability manifest, shown at first contact rather than discovered later. This is the one
   screen in the whole product where a user decides whether to trust it, and handing them the
   limitations unprompted is the strongest thing we can do with that moment. */
async function probePlatform() {
  stage('platform', 'run', 'Probing this platform');
  let m;
  try { m = require('./collect').manifest(); } catch (e) {
    stage('platform', 'fail', 'Could not read the capability manifest', e.message);
    return null;
  }
  fact('platform', 'os', 'System', m.name, 'ok');
  fact('platform', 'collector', 'Collector', m.collector, 'ok');
  for (const k of (m.limited || [])) fact('platform', 'lim:' + k, k, 'limited here', 'warn');
  for (const k of (m.missing || [])) fact('platform', 'mis:' + k, k, 'not available on this platform', 'off');
  const counts = {
    ok: Object.values(m.can || {}).filter(Boolean).length,
    limited: (m.limited || []).length,
    missing: (m.missing || []).length,
  };
  stage('platform', m.supported ? 'ok' : 'warn', m.name,
    `${counts.ok} capabilities measured here` +
    (counts.limited ? `, ${counts.limited} limited` : '') +
    (counts.missing ? `, ${counts.missing} unavailable` : ''));
  return m;
}

/* Stage 4. THE MACHINE. The payoff, and the only honest proof an install worked.
   Identity comes from Node and is instant; the readings come from the bridge and take as long as
   they take. Two-phase on purpose - the wait the user sees is the first real measurement. */
function bridgeUp(cb) {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/caps', timeout: 1200 }, (res) => {
    let b = ''; res.on('data', (c) => b += c);
    res.on('end', () => { try { cb(JSON.parse(b)); } catch { cb(null); } });
  });
  req.on('error', () => cb(null));
  req.on('timeout', () => { req.destroy(); cb(null); });
}

function api(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 20000 }, (res) => {
      let b = ''; res.on('data', (c) => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

let bridgeChild = null;

async function measureMachine() {
  /* Identity: free, instant, and enough to make the screen feel like it knows where it is. */
  const cpus = os.cpus();
  /* "11th Gen Intel(R) Core(TM) i7-1165G7 @ 2.80GHz" is 46 characters of which four are legal
     furniture. Dropping (R)/(TM)/CPU changes no fact and gives the hero line back to the part a
     person actually reads. The model number and clock stay. */
  const model = (cpus[0] && cpus[0].model || 'unknown')
    .replace(/\((R|TM|r|tm)\)/g, '').replace(/\bCPU\b/g, '').replace(/\s+/g, ' ').trim();
  fact('machine', 'cpu', 'Processor', model, 'ok');
  fact('machine', 'cores', 'Logical cores', String(cpus.length), 'ok');
  fact('machine', 'ram', 'Memory installed', (os.totalmem() / 1073741824).toFixed(1) + ' GB', 'ok');

  stage('measure', 'run', 'Taking the first measurement');
  const already = await new Promise((r) => bridgeUp(r));
  if (!already) {
    /* stderr to a file for the same reason start.js does it: a bridge that dies during boot has
       already explained itself, and discarding that leaves the user with a shrug. */
    let errFd = 'ignore';
    try {
      fs.mkdirSync(path.join(HERE, 'history'), { recursive: true });
      errFd = fs.openSync(path.join(HERE, 'history', 'bridge-boot.log'), 'w');
    } catch {}
    bridgeChild = spawn(process.execPath, [path.join(HERE, 'bridge.js')], {
      cwd: HERE, detached: true, stdio: ['ignore', 'ignore', errFd],
    });
    bridgeChild.on('error', (e) => stage('measure', 'fail', 'Could not start the bridge', e.message));
    bridgeChild.unref();
  }

  let caps = null;
  for (let i = 0; i < 40 && !caps; i++) {
    caps = await new Promise((r) => bridgeUp(r));
    if (!caps) await sleep(500);
  }
  if (!caps) {
    let why = '';
    try { why = fs.readFileSync(path.join(HERE, 'history', 'bridge-boot.log'), 'utf8').trim().split('\n').slice(-3).join(' · '); } catch {}
    stage('measure', 'fail', `The bridge did not answer on port ${PORT}`, why || 'it left no error output');
    return false;
  }

  /* The collector needs a couple of ticks before it has rates rather than a single instant. Poll
     for a sample that actually has a CPU figure instead of guessing at a duration. */
  let l = null;
  for (let i = 0; i < 40; i++) {
    l = await api('/api/latest');
    if (l && l.cpu && l.cpu.total != null) break;
    await sleep(500);
  }
  if (!l || !l.cpu || l.cpu.total == null) {
    stage('measure', 'warn', 'The bridge is up but has not produced a sample yet',
      'this is usually a slow first counter load; the panel will fill in as it arrives');
    return true;
  }

  /* Every one of these is a measured value or it is absent. Nothing here is defaulted to zero -
     that is the whole product in one function. */
  fact('machine', 'cpuload', 'CPU right now', l.cpu.total + '%', 'live');
  if (l.mem && l.mem.usedMB != null) {
    fact('machine', 'memuse', 'Memory in use',
      `${(l.mem.usedMB / 1024).toFixed(1)} GB of ${(l.mem.totalMB / 1024).toFixed(1)} GB`, 'live');
  }
  if (l.mem && l.mem.pagesSec != null) fact('machine', 'faults', 'Hard faults/sec', String(l.mem.pagesSec), 'live');
  if (l.disk && Array.isArray(l.disk.vols)) {
    for (const v of l.disk.vols.slice(0, 3)) {
      if (v.sizeGB == null || v.freeGB == null) continue;
      fact('machine', 'vol:' + v.id, (v.label ? v.label + ' (' + v.id + ')' : 'Volume ' + v.id),
        `${Math.round(v.freeGB)} GB free of ${Math.round(v.sizeGB)}`,
        v.pct >= 90 ? 'warn' : 'live');
    }
  }
  if (l.gpu && l.gpu.util != null) fact('machine', 'gpu', 'GPU', l.gpu.util + '% busy', 'live');
  if (l.pwr && l.pwr.pct != null) {
    fact('machine', 'bat', 'Battery', l.pwr.pct + '%' + (l.pwr.ac ? ' · on AC' : ' · on battery'), 'live');
  }

  const d = await api('/api/diagnose');
  if (d && d.summary) fact('machine', 'verdict', 'First read', d.summary, d.findings && d.findings.length ? 'warn' : 'ok');

  stage('measure', 'ok', 'Measured', 'these are your machine, right now');
  return true;
}

/* ------------------------------------------------------------------ options */

/* WHERE EACH OPTION LIVES, in ONE place. Both "is it on?" and "turn it off" need these paths, and
   a detector that computes a path differently from the thing that created it reports confident
   nonsense - it would say "not installed" about a shortcut sitting right there. */
const HOME = os.homedir();
const START_MENU = path.join(HOME, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
const FILE_FOR = {
  startmenu: () => path.join(START_MENU, 'VITALS.lnk'),
  desktop: () => path.join(HOME, 'Desktop', 'VITALS.lnk'),
  startup: () => path.join(START_MENU, 'Startup', 'VITALS.lnk'),
  desktopentry: () => path.join(HOME, '.local', 'share', 'applications', 'vitals.desktop'),
};

/* Only what this platform can actually honour. An option that would fail here is not rendered
   with an apology - it is not rendered.
   EACH ONE REPORTS ITS CURRENT STATE, which is what turns this from a one-shot installer into a
   screen you can come back to. A checkbox that can only ever ADD is half a control: it cannot tell
   you what you already chose, and it gives you no way to change your mind. Re-running setup now
   shows the truth and lets you tick or untick either way. */
async function options() {
  const out = [];
  if (IS_WIN) {
    out.push({ id: 'startmenu', label: 'Add VITALS to the Start menu',
      detail: 'One shortcut in your own Start menu folder. Nothing system-wide. Untick to remove it.' });
    out.push({ id: 'desktop', label: 'Put a shortcut on the desktop',
      detail: 'One .lnk file on your desktop. Untick to remove it.' });
    out.push({ id: 'startup', label: 'Start VITALS when I log in',
      detail: 'A shortcut in your Startup folder. Untick to remove it.' });
  } else if (process.platform === 'linux') {
    out.push({ id: 'desktopentry', label: 'Add VITALS to your applications menu',
      detail: 'Writes ~/.local/share/applications/vitals.desktop. User-level only. Untick to remove it.' });
  }
  out.push({ id: 'mcp', label: 'Let Claude Code read this machine',
    detail: 'Registers the VITALS MCP server with the Claude CLI, read-only. '
          + 'Runs: claude mcp add vitals. Untick to run claude mcp remove vitals.' });
  for (const o of out) o.on = await optionPresent(o.id);
  return out;
}

async function optionPresent(id) {
  if (FILE_FOR[id]) { try { return fs.existsSync(FILE_FOR[id]()); } catch { return false; } }
  if (id === 'mcp') {
    /* Ask the CLI rather than guessing at a config file's location and shape. A missing CLI reads
       as "not registered", which is exactly right - without it there is nothing registered. */
    const r = await claude(['mcp', 'get', 'vitals']);
    return r.ok;
  }
  return false;
}

/* A FAILED LAUNCH IS A RESULT, NOT AN EXCEPTION.
 *
 * execFile can throw SYNCHRONOUSLY - notably EINVAL when asked to run a .cmd or .bat directly,
 * which Node started refusing in the fix for CVE-2024-27980. Inside a promise executor that throw
 * becomes a rejection, and an unhandled rejection in an async request handler is fatal in modern
 * Node. So "is the Claude CLI installed?" was capable of killing the setup server outright.
 *
 * Same shape as the collector bug found earlier today: the consequence of a missing binary should
 * be "we could not run it", never "the process is gone". Every launch failure resolves to ok:false.
 *
 * useShell exists for exactly the .cmd case. It is NOT the default, because most callers here pass
 * PowerShell an entire -Command script and handing that to cmd.exe first would mangle the quoting. */
function shellQuote(a) {
  return /[\s"^&|<>()]/.test(a) ? '"' + String(a).replace(/"/g, '""') + '"' : a;
}

function run(cmd, args, useShell) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, useShell ? args.map(shellQuote) : args,
        { windowsHide: true, timeout: 20000, shell: !!useShell },
        (err, so, se) => resolve({ ok: !err, out: String(so || '') + String(se || '') }));
    } catch (e) {
      resolve({ ok: false, out: String((e && e.message) || e) });
    }
  });
}

function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

async function makeShortcut(lnk) {
  const target = path.join(HERE, 'VITALS.exe');
  const { PS, PS_ARGS } = require('./pshost');
  const script = [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(lnk)})`,
    `$s.TargetPath = ${psQuote(target)}`,
    `$s.WorkingDirectory = ${psQuote(HERE)}`,
    `$s.IconLocation = ${psQuote(path.join(HERE, 'vitals.ico'))}`,
    `$s.Description = 'VITALS system monitor'`,
    `$s.Save()`,
  ].join('; ');
  const r = await run(PS, [...PS_ARGS, '-Command', script]);
  return r.ok && fs.existsSync(lnk) ? { ok: true, where: lnk } : { ok: false, why: r.out.trim().split('\n')[0] || 'shortcut not created' };
}

/* On Windows the Claude CLI is a .cmd shim. Rather than guess between `claude` and `claude.cmd`,
   let the shell resolve it the way a person typing it would - which is also the only way Node will
   start a .cmd at all since the CVE-2024-27980 fix. */
async function claude(args) {
  return run('claude', args, IS_WIN);
}

async function applyOption(id) {
  try {
    if (FILE_FOR[id] && id !== 'desktopentry') {
      const f = FILE_FOR[id]();
      fs.mkdirSync(path.dirname(f), { recursive: true });
      return await makeShortcut(f);
    }
    if (id === 'desktopentry') {
      const f = FILE_FOR.desktopentry();
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f,
        '[Desktop Entry]\nType=Application\nName=VITALS\n'
        + 'Comment=System monitor that measures the machine it runs on\n'
        + `Exec=${path.join(HERE, 'vitals.sh')}\nPath=${HERE}\nTerminal=false\nCategories=System;Monitor;\n`);
      try { fs.chmodSync(f, 0o755); } catch {}
      return { ok: true, where: f };
    }
    if (id === 'mcp') {
      /* The CLI's own command, not a hand-edit of somebody's config file. It is reversible with a
         command we can print, and if the CLI is absent we say so instead of writing JSON into a
         file we were not invited to touch. */
      const r = await claude(['mcp', 'add', 'vitals', '--', process.execPath, path.join(HERE, 'vitals-mcp.js')]);
      if (r.ok) return { ok: true, where: 'claude mcp add vitals' };
      return { ok: false, why: 'the Claude CLI was not found — INSTALL.md has the config to paste' };
    }
  } catch (e) { return { ok: false, why: e.message }; }
  return { ok: false, why: 'unknown option' };
}

/* THE OTHER HALF. Whatever setup can turn on, it can turn off - by deleting the exact file it
   created, not by telling you where to look for it. */
async function removeOption(id) {
  try {
    if (FILE_FOR[id]) {
      const f = FILE_FOR[id]();
      if (!fs.existsSync(f)) return { ok: true, where: 'was not there' };
      fs.unlinkSync(f);
      return { ok: true, where: 'removed ' + f };
    }
    if (id === 'mcp') {
      const r = await claude(['mcp', 'remove', 'vitals']);
      if (r.ok) return { ok: true, where: 'claude mcp remove vitals' };
      /* Already gone is a success, not a failure - the desired state is "not registered". */
      if (/not found|no such|does not exist/i.test(r.out)) return { ok: true, where: 'was not registered' };
      return { ok: false, why: (r.out.trim().split('\n')[0] || 'claude mcp remove failed') };
    }
  } catch (e) { return { ok: false, why: e.message }; }
  return { ok: false, why: 'unknown option' };
}

/* ------------------------------------------------------------------ server */

const PAGE = path.join(HERE, 'setup.html');

function body(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 65536) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

let started = false;

/* EVERY HANDLER IS WRAPPED. An async request handler that rejects is an unhandled rejection, and an
   unhandled rejection is fatal - so any single route could take the whole setup screen down and the
   user would see the window go blank with no explanation. One route failing should cost one
   response, which is the same principle as the collector being allowed to fail alone. */
const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error('[setup] ' + (req.url || '?') + ': ' + ((e && e.stack) || e));
    try { if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }); res.end('setup error: ' + ((e && e.message) || e)); } catch {}
  });
});

async function handle(req, res) {
  /* Loopback only, and same rules as the bridge: a setup page is a more attractive target than a
     dashboard, not less, because it has buttons that write files. */
  const ra = req.socket.remoteAddress || '';
  if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(ra)) { res.writeHead(403).end('local only'); return; }

  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/') {
    let html;
    try { html = fs.readFileSync(PAGE, 'utf8'); } catch { res.writeHead(500).end('setup.html missing'); return; }
    html = html.replace('__VERSION__', VERSION).replace('__PORT__', String(PORT));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    return;
  }

  if (u.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    clients.add(res);
    for (const ev of journal) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    req.on('close', () => clients.delete(res));
    if (!started) { started = true; sequence(); }
    return;
  }

  if (u.pathname === '/options') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await options()));
    return;
  }

  if (u.pathname === '/apply' && req.method === 'POST') {
    /* THE CLIENT SENDS THE DESIRED STATE, not a list of things to do. Sending "do these" makes
       unticking a no-op - the option just stays on and the screen quietly disagrees with reality.
       Sending both sides means the answer to "what happens if I untick this" is "it goes away". */
    const b = await body(req);
    const results = [];
    for (const id of (b.on || [])) {
      if (await optionPresent(id)) continue;          // already true; do not rewrite it
      results.push({ id, ...(await applyOption(id)) });
    }
    for (const id of (b.off || [])) {
      if (!(await optionPresent(id))) continue;
      results.push({ id, ...(await removeOption(id)) });
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ results }));
    return;
  }

  if (u.pathname === '/launch' && req.method === 'POST') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
    setTimeout(() => {
      try {
        if (IS_WIN) {
          const { PS, PS_ARGS } = require('./pshost');
          spawn(PS, [...PS_ARGS, '-File', path.join(HERE, 'launch.ps1'), '-Port', String(PORT)],
            { cwd: HERE, detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
        } else {
          const open = process.platform === 'darwin' ? 'open' : 'xdg-open';
          spawn(open, [`http://127.0.0.1:${PORT}/`], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
        }
      } catch {}
      setTimeout(() => process.exit(0), 1500);
    }, 250);
    return;
  }

  res.writeHead(404).end('no');
}

async function sequence() {
  emit({ t: 'begin', version: VERSION, dir: HERE, port: PORT });
  if (!(await verifyPayload())) return emit({ t: 'done', ok: false });
  if (!(await checkRuntime())) return emit({ t: 'done', ok: false });
  await probePlatform();
  const ok = await measureMachine();
  emit({ t: 'done', ok });
}

/* --no-window serves the page and opens nothing. For a scripted or remote install, and for looking
   at the setup screen without a window appearing on somebody's desk. */
const NO_WINDOW = process.argv.includes('--no-window');

server.listen(0, '127.0.0.1', () => {
  uiPort = server.address().port;
  const url = `http://127.0.0.1:${uiPort}/`;
  console.log(`VITALS ${VERSION} setup  ->  ${url}`);
  if (NO_WINDOW) {
    console.log('  (--no-window: open that address yourself)');
  } else if (IS_WIN) {
    /* The same frameless host the product uses. A setup window that looks like the app is a
       promise kept before it is made. Falls through to the browser if the host cannot start. */
    const { PS, PS_ARGS } = require('./pshost');
    const child = spawn(PS, [...PS_ARGS, '-File', path.join(HERE, 'panel.ps1'),
      '-Port', String(uiPort), '-Path', '/', '-Title', 'VITALS Setup',
      /* FULLY OPAQUE, unlike the panel. panel.ps1 defaults to 0.94 because you GLANCE at a monitor
         and translucency locates it in z-space (design-principles C5/F4). Setup is the opposite:
         you READ it once, it is the first thing anyone sees, and at 0.94 over a bright window
         behind it the body text was legible through the page. Same host, different job. */
      '-Alpha', '1',
      '-Width', '980', '-Height', '680', '-NoTop'], { cwd: HERE, detached: true, stdio: 'ignore' });
    child.on('error', () => spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).on('error', () => {}));
    child.unref();
  } else {
    const open = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(open, [url], { detached: true, stdio: 'ignore' }).on('error', () => {
      console.log('Open that address in a browser to continue.');
    }).unref();
  }
});
