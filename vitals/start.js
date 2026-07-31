#!/usr/bin/env node
/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - UNIVERSAL ENTRY POINT.  `node start.js`  on any of the three platforms.
 *
 * WHY THIS EXISTS. The Windows launcher (launch.ps1) is genuinely good and is not being replaced:
 * it builds a native WinForms + WebView2 host, which is the only way to get a truly frameless,
 * always-on-top, translucent panel on Windows. But it is PowerShell, so it is Windows-only, and it
 * was also the only way to start the product. That made "run VITALS" and "run VITALS on Windows"
 * the same sentence.
 *
 * This file separates them. It starts the bridge, then hands the window off to whatever host the
 * platform actually has:
 *
 *   Windows  -> launch.ps1, unchanged. Native frameless host.
 *   macOS    -> Chrome/Edge/Brave in --app mode if present, else `open` in the default browser.
 *   Linux    -> the same --app probe, else xdg-open.
 *
 * The non-Windows window WILL have a title bar, and edge-docking and always-on-top are the window
 * manager's business rather than ours. caps.js declares host.frameless as partial on those platforms
 * for exactly this reason. Saying so is better than a launcher that silently delivers less than the
 * screenshots promised.
 *
 * NO HARD-CODED PATHS. Everything resolves from __dirname, so the folder can live on a USB stick,
 * under a different user name, or on a different drive letter and still work.
 */

const { spawn, spawnSync, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const HERE = __dirname;
const PORT = +process.env.VITALS_PORT || 8790;
/* Where a bridge that dies during boot leaves its explanation. Overwritten every launch - it is a
   crash note, not a log, and a stale one from last week is worse than none. */
const BOOT_LOG = path.join(HERE, 'history', 'bridge-boot.log');
const URL_ = `http://127.0.0.1:${PORT}/`;
const args = new Set(process.argv.slice(2));
const NO_WINDOW = args.has('--no-window') || args.has('--headless');

/* ---------------- preflight ----------------
 * Fail with a sentence a person can act on, not a stack trace. A missing runtime and a missing
 * collector are completely different problems and deserve different messages. */
function preflight() {
  const major = +process.versions.node.split('.')[0];
  if (major < 18) {
    console.error(`VITALS needs Node 18 or newer (this is ${process.versions.node}).`);
    console.error(`Node 18.15+ is the floor for fs.statfsSync, which the Linux and macOS collectors use.`);
    process.exit(1);
  }
  const { manifest } = require('./collect/caps');
  const caps = manifest();
  if (!caps.supported) {
    console.error(`VITALS has no collector for "${process.platform}".`);
    console.error(`Supported: Windows, macOS, Linux. The panel would load but stay empty.`);
    process.exit(1);
  }
  console.log(`VITALS on ${caps.name}  (${os.arch()}, Node ${process.versions.node})`);
  console.log(`  collector: ${caps.collector}`);
  if (caps.verified === false) {
    console.log('');
    console.log(`  !! ${caps.verifyNote}`);
    console.log('');
  }
  if (caps.limited.length) console.log(`  limited here: ${caps.limited.join(', ')}`);
  if (caps.missing.length) console.log(`  unavailable here: ${caps.missing.join(', ')}`);
  return caps;
}

/* ---------------- bridge ----------------
 * Reuse a bridge that is already up rather than fighting it for the port. Two bridges on one machine
 * means two collectors sampling the same counters, which is both wasteful and confusing to debug. */
function bridgeAlive(cb) {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/caps', timeout: 900 },
    (res) => { res.resume(); cb(res.statusCode === 200); });
  req.on('error', () => cb(false));
  req.on('timeout', () => { req.destroy(); cb(false); });
}

function startBridge(cb) {
  bridgeAlive((up) => {
    if (up) { console.log(`  bridge: already running on ${PORT}`); return cb(); }
    /* KEEP THE BRIDGE'S DYING WORDS. This used to be stdio:'ignore', which is right for a detached
       long-running server and catastrophic for one that fails during boot: the process wrote a
       perfectly clear stack trace to a stderr nobody was holding, and the user got "the bridge did
       not answer on port 8790" with no cause and nowhere to look. Diagnosing it needed the bridge
       run by hand in a terminal - which is precisely the step a launcher exists to remove.
       Now stderr goes to a file we can quote back when the poll below gives up. */
    let errFd = 'ignore';
    try {
      fs.mkdirSync(path.dirname(BOOT_LOG), { recursive: true });
      errFd = fs.openSync(BOOT_LOG, 'w');
    } catch { /* an unwritable history/ must not stop the bridge from starting */ }
    const child = spawn(process.execPath, [path.join(HERE, 'bridge.js')], {
      cwd: HERE, detached: true, stdio: ['ignore', 'ignore', errFd],
    });
    /* process.execPath always exists, so ENOENT is not the risk here - EAGAIN, EMFILE and EACCES
       are. Any of them would have been an unhandled 'error' event, and an unhandled 'error' event
       on a ChildProcess takes down the launcher rather than the launch. */
    child.on('error', (e) => {
      console.error(`  bridge: could not be started - ${e && e.message || e}`);
    });
    child.unref();
    /* "startING". It has been spawned, not proven; the poll below is what decides. Announcing
       success before the evidence is in is the habit this whole product exists to argue against,
       and it read as a lie in exactly the case that matters - the run where it did not come up. */
    console.log(`  bridge: starting on ${PORT}…`);
    /* Poll rather than sleep a fixed amount: the first collector sample costs ~2 s on Windows
       (perf-counter metadata load) and almost nothing on Linux, and a fixed wait is wrong on both. */
    let tries = 0;
    (function wait() {
      bridgeAlive((ok) => {
        if (ok) return cb();
        /* Do NOT open a window onto a bridge that never answered. The old code called cb() anyway,
           so a port held by an unrelated server - or by a pre-port VITALS with no /api/caps route,
           which 404s and therefore reads as "not alive" - produced a second bridge that died
           instantly on EADDRINUSE (stdio is ignored, so silently), twenty seconds of polling, one
           terse line, and then a browser pointed at a stranger's service. Fail loudly instead. */
        if (++tries > 40) {
          console.error('');
          console.error(`  The bridge did not answer on port ${PORT} within 20s.`);
          /* THE CAUSE, IF THE BRIDGE LEFT ONE. A process that crashed on boot has already explained
             itself; the old code discarded that and offered a port-conflict theory instead, which
             sends the reader to netstat for a problem that was never about the port. Quote what it
             actually said first, and keep the theory for when there is nothing to quote. */
          let said = '';
          try { said = fs.readFileSync(BOOT_LOG, 'utf8').trim(); } catch {}
          if (said) {
            console.error('');
            console.error('  The bridge wrote this before it stopped:');
            for (const line of said.split('\n').slice(-14)) console.error('    ' + line.replace(/\s+$/, ''));
            console.error('');
            console.error(`  Full output: ${BOOT_LOG}`);
          } else {
            console.error(`  It left no error output, so something else may be holding that port. Check with:`);
            console.error(process.platform === 'win32'
              ? `    netstat -ano | findstr :${PORT}`
              : `    lsof -i :${PORT}`);
            console.error(`  Or run VITALS on a different port:  VITALS_PORT=8791 node start.js`);
          }
          console.error('');
          return cb(new Error('bridge unreachable'));
        }
        setTimeout(wait, 500);
      });
    })();
  });
}

/* ---------------- window ---------------- */
function firstExisting(list) { return list.find((p) => { try { return fs.existsSync(p); } catch { return false; } }); }

function openWindows() {
  /* One resolver, shared. This file had the right answer first and kept it to itself; bridge.js and
     collect/win32.js carried the bare name until a portable build with a trimmed PATH found out. */
  const ps = require('./pshost').PS;
  /* NO `detached: true` for a process that has to put a window on screen. On Windows that flag means
     DETACHED_PROCESS, so the child gets no console, PowerShell exits immediately, and launch.ps1
     never reaches the line that starts the panel host - `node start.js` printed "window: native
     WebView2 host" and produced nothing. The same defect was found and fixed in the bridge's
     /api/window/open route; it was still sitting here, because fixing the instance you are looking
     at is not the same as fixing the class. `unref()` is what actually detaches the parent's event
     loop, and Windows does not kill children when a parent exits. */
  /* THE LAUNCHER IS AWAITED, NOT DETACHED - and both obvious alternatives are wrong on Windows:
   *
   *   detached: true   -> DETACHED_PROCESS, so PowerShell gets no console, exits 0 immediately, and
   *                       never reaches the line that starts the panel host.
   *   detached: false  -> the child shares THIS process's console. start.js spawns and exits within
   *      + unref()        milliseconds, console teardown takes the child with it, and again the
   *                       panel never starts. This one is nastier because it looks correct and works
   *                       in any test that happens to keep the parent alive.
   *
   * launch.ps1 itself is short-lived: it hands off to panel.ps1 via Start-Process, which is an
   * INDEPENDENT process that outlives everything here, then prints its summary and exits. So the
   * right move is simply to let it finish - a few seconds - rather than trying to orphan it. No
   * unref(), so node stays up until the handoff is genuinely done. */
  const child = spawn(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(HERE, 'launch.ps1'), '-Port', String(PORT)],
    { cwd: HERE, stdio: 'ignore', windowsHide: true });
  child.on('error', (e) => console.error('  window: could not start the host - ' + e.message));
  child.on('exit', (code) => {
    if (code) console.error(`  window: launch.ps1 exited ${code}`);
  });
  console.log('  window: native WebView2 host (launch.ps1)');
}

/* Chromium's --app removes the browser chrome but not the OS title bar. That is as frameless as we
   get without writing a native host per platform, and it is stated rather than glossed. */
function chromiumApp() {
  const home = os.homedir();
  const mac = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ];
  const lin = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
    '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/usr/bin/brave-browser',
    '/snap/bin/chromium', '/var/lib/flatpak/exports/bin/com.google.Chrome'];
  return firstExisting(process.platform === 'darwin' ? mac : lin);
}

function openUnix() {
  const bin = chromiumApp();
  if (bin) {
    /* A dedicated profile dir keeps the panel out of the user's browsing session: no shared cookies,
       no "restore tabs?" prompt, and closing it never disturbs their real window. */
    const profile = path.join(os.tmpdir(), 'vitals-panel-profile');
    const child = spawn(bin, [`--app=${URL_}`, `--user-data-dir=${profile}`,
      '--window-size=1080,720', '--no-first-run', '--no-default-browser-check'],
      { detached: true, stdio: 'ignore' });
    child.unref();
    console.log(`  window: ${path.basename(bin)} in app mode (it will have a title bar)`);
    return;
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  execFile(opener, [URL_], () => {});
  console.log(`  window: default browser via ${opener} (no app mode found)`);
}

/* ---------------- go ---------------- */
preflight();
startBridge((err) => {
  if (err) process.exit(1);          // no window onto a bridge that is not there
  if (NO_WINDOW) {
    console.log(`  window: skipped (--no-window). Panel is at ${URL_}`);
    return;
  }
  if (process.platform === 'win32') openWindows(); else openUnix();
  console.log(`\nVITALS is at ${URL_}`);
});
