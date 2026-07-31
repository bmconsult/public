/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - the action layer off Windows: kill, clean, restart-an-app, and the elevation seam.
 *
 * Everything action-shaped in bridge.js is a PowerShell one-shot, which is why every act.* flag is
 * false on macOS and Linux. This module is the native counterpart: same route contracts, same
 * result shapes, same design rules, implemented in Node (plus osascript where macOS owns the
 * consent prompt). bridge.js dispatches here when the host is not Windows.
 *
 * The rules are ported from the PowerShell originals rather than reinvented, because each one was
 * paid for:
 *   - FIXED TARGET TABLES. clean() takes a key, never a path, so nothing reachable over HTTP can
 *     choose what gets deleted - and the ELEVATED table lives inside clean-admin.js itself, so even
 *     a compromised bridge cannot hand root an arbitrary path. (clean-admin.ps1's rule.)
 *   - COUNT DENIALS, never swallow them. ok=true with -EA SilentlyContinue once reported success
 *     while every delete was refused. Here every failure lands in a counted bucket: EACCES/EPERM is
 *     `denied` (a permissions fact -> needsAdmin), anything else is `locked` (expected, harmless).
 *   - MEASURE, don't estimate. freedGB is tree-size-before minus tree-size-after, not a sum of
 *     what we think we deleted.
 *   - THE BRIDGE NEVER RUNS PRIVILEGED. Elevation is a short separate process behind the OS's own
 *     password prompt (`do shell script ... with administrator privileges`), the same split as the
 *     UAC one-shots.
 *
 * UNVERIFIED ON HARDWARE where marked: the osascript paths follow documented behaviour and have
 * never executed on a Mac. caps.js keeps every act.* flag false until the CI live suite proves
 * them; test-actions-posix.js covers the logic - validation, counting, escalation, command
 * construction - from injected seams, which is everything except macOS itself.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const HERE = __dirname;

/* THE INJECTION SEAM, same pattern as collect/darwin.js: every process this module signals and
   every command it runs goes through these two doors, so the whole layer - validation, escalation
   timing, denial counting, osascript quoting - is testable on a machine with no Mac and without
   killing anything real. */
let run = (cmd, args, opts, cb) => execFile(cmd, args, { maxBuffer: 1 << 20, timeout: 15000, ...opts },
  (err, out) => cb(err, String(out || '')));
let signal = (pid, sig) => process.kill(pid, sig);
function _inject(fakeRun, fakeSignal) {
  if (fakeRun) run = fakeRun;
  if (fakeSignal) signal = fakeSignal;
}

/* ---------------- kill ----------------
 * Windows kill is Stop-Process -Force: immediate. POSIX offers something strictly better - a
 * graceful TERM first, then KILL for whatever ignored it - so the port takes the better contract
 * rather than faithfully reproducing the blunter one. Same pid floor as the Windows path: nothing
 * at or below 4, which covers kernel_task/launchd on Darwin and init on Linux with margin.
 */
function kill(pids, cb) {
  const valid = (pids || []).filter((p) => Number.isInteger(p) && p > 4);
  if (!valid.length) return cb(new Error('no valid pids'));
  let terminated = 0, denied = 0;
  const survivors = [];
  for (const pid of valid) {
    try { signal(pid, 'SIGTERM'); survivors.push(pid); }
    catch (e) {
      /* ESRCH means it exited before we got there - the goal state, not a failure. EPERM is a
         REFUSAL and is counted, not swallowed: "I killed it" about a process that is still running
         is the action-layer version of the plausible zero. */
      if (e.code === 'ESRCH') terminated++;
      else denied++;
    }
  }
  if (!survivors.length) {
    return denied === valid.length
      ? cb(new Error(`permission denied for all ${denied} pid(s) - they belong to another user`))
      : cb(null, { ok: true, terminated, forced: 0, denied });
  }
  /* 1.5 s of grace, then KILL. Long enough for an ordinary handler to run its exit path, short
     enough that the button still feels like a button. */
  setTimeout(() => {
    let forced = 0;
    for (const pid of survivors) {
      try { signal(pid, 0); } catch { terminated++; continue; }   // exited during the grace period
      try { signal(pid, 'SIGKILL'); forced++; }
      catch (e) { if (e.code === 'ESRCH') terminated++; else denied++; }
    }
    if (denied === valid.length) return cb(new Error(`permission denied for all ${denied} pid(s)`));
    cb(null, { ok: denied === 0, terminated, forced, denied });
  }, 1500);
}

/* ---------------- clean ----------------
 * Unelevated targets resolve here; elevated ones are only NAMED here - their paths live in
 * clean-admin.js, inside the process that will actually hold root. Same split as CLEANABLE /
 * clean-admin.ps1 on Windows.
 */
const CLEAN_TARGETS = {
  darwin: {
    usertemp:   { dir: () => process.env.TMPDIR || '/tmp',                        elevate: false },
    usercaches: { dir: () => path.join(os.homedir(), 'Library', 'Caches'),        elevate: false },
    userlogs:   { dir: () => path.join(os.homedir(), 'Library', 'Logs'),          elevate: false },
    syscaches:  { admin: 'syscaches',                                             elevate: true },
    systmp:     { admin: 'systmp',                                                elevate: true },
  },
  linux: {
    usertemp:   { dir: () => os.tmpdir(),                                         elevate: false },
    usercaches: { dir: () => process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), elevate: false },
    /* No elevated targets yet: Linux elevation means pkexec/polkit, which cannot be written
       honestly from documentation alone - whether a polkit agent is present decides everything.
       Absent is better than guessed. */
  },
};

function measureTree(p) {
  let bytes = 0, files = 0;
  const stack = [p];
  while (stack.length) {
    const dir = stack.pop();
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of names) {
      const full = path.join(dir, d.name);
      if (d.isSymbolicLink()) continue;      // a cache may legally link elsewhere; never measure through it
      if (d.isDirectory()) stack.push(full);
      else if (d.isFile()) { try { bytes += fs.lstatSync(full).size; files++; } catch {} }
    }
  }
  return { bytes, files };
}

/* Delete the CHILDREN of dir, never dir itself - the OS expects these folders to exist.
   Every failure is bucketed, not swallowed; see the header. */
function sweepChildren(dir) {
  let deleted = 0, denied = 0, locked = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { deleted, denied: 1, locked }; }
  for (const n of names) {
    try { fs.rmSync(path.join(dir, n), { recursive: true, force: false }); deleted++; }
    catch (e) {
      if (e.code === 'EACCES' || e.code === 'EPERM') denied++;
      else if (e.code === 'ENOENT') deleted++;         // raced away; gone is the goal state
      else locked++;
    }
  }
  return { deleted, denied, locked };
}

function clean(key, cb, table) {
  const targets = table || CLEAN_TARGETS[process.platform] || {};
  const t = targets[key];
  if (!t) return cb(new Error('not a cleanable target'));
  if (t.elevate) return cleanElevated(t.admin, cb);

  const dir = t.dir();
  let st;
  try { st = fs.statSync(dir); } catch { st = null; }
  if (!st || !st.isDirectory()) return cb(null, { ok: true, freedGB: 0, leftGB: 0, note: 'path absent' });

  const before = measureTree(dir);
  const { deleted, denied, locked } = sweepChildren(dir);
  const after = measureTree(dir);
  const freed = Math.round(((before.bytes - after.bytes) / 2 ** 30) * 100) / 100;
  cb(null, {
    ok: freed > 0 || (denied === 0 && locked === 0),
    freedGB: freed,
    leftGB: Math.round((after.bytes / 2 ** 30) * 100) / 100,
    entriesDeleted: deleted, entriesDenied: denied, entriesLocked: locked,
    /* A user path can rarely truly need admin (it is the user's own), but root-owned droppings in
       ~/Library/Caches are common enough on a machine that has run installers; the flag lets the
       UI offer the elevated route rather than claiming success. */
    needsAdmin: denied > 0,
  });
}

/* ---------------- elevation (macOS) ----------------
 * `osascript -e 'do shell script ... with administrator privileges'` is Apple's supported way for
 * an unelevated process to request one privileged command; macOS itself raises the password dialog
 * and the user can refuse. The command handed over is ALWAYS this Node binary running
 * clean-admin.js with a target KEY - never a path, never anything a caller composed.
 *
 * Two quoting layers, each handled once:
 *   1. sh: every argv element is single-quoted, with embedded quotes closed-escaped-reopened.
 *   2. AppleScript string literal: backslash and double-quote escaped.
 * Composed in that order, tested in test-actions-posix.js with hostile paths.
 */
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
function osaStr(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

function cleanElevated(adminKey, cb) {
  const out = path.join(HERE, 'history', `clean-${Date.now()}.json`);
  const script = path.join(HERE, 'clean-admin.js');
  const shellCmd = [process.execPath, script, '--targets', adminKey, '--out', out].map(shq).join(' ');
  const osa = `do shell script "${osaStr(shellCmd)}" with administrator privileges`;
  /* 3 minutes, same budget as the UAC poll on Windows: the user may reasonably sit on the password
     dialog for a while, and past that the honest reading is "declined". */
  run('osascript', ['-e', osa], { timeout: 180000 }, (e) => {
    let d = null;
    try { if (fs.existsSync(out)) { d = JSON.parse(fs.readFileSync(out, 'utf8')); fs.unlinkSync(out); } } catch {}
    if (!d) {
      return cb(new Error(e && /-128|canceled|cancelled/i.test(e.message || '')
        ? 'the administrator prompt was declined, so nothing was deleted'
        : 'no result from the elevated run - ' + (e ? e.message : 'it wrote nothing')));
    }
    const r = (d.results || [])[0] || {};
    cb(null, { ok: !!r.ok, freedGB: r.freedGB || 0, leftGB: r.leftGB || 0,
      entriesDeleted: r.entriesDeleted || 0, entriesDenied: r.entriesDenied || 0,
      elevated: !!d.elevated, freeGBAfter: d.freeGBAfter });
  });
}

/* ---------------- restart an app (macOS) ----------------
 * The same contract as the Windows restartApp, step for step: refuse system-critical names, refuse
 * when the relaunch target cannot be RESOLVED (relaunching a guess is worse than not relaunching),
 * graceful quit first, force only what refuses, then relaunch the exact bundle that was resolved.
 *
 * Resolution comes BEFORE the quit, which is a deliberate ordering improvement over the Windows
 * version: there the path is read from the running process, here LaunchServices can answer
 * `path to application` whether or not the app is running - so a name that cannot be relaunched is
 * refused while the app is still up, instead of discovered after it has been killed.
 */
const NEVER_RESTART = new Set(['launchd', 'kernel_task', 'windowserver', 'loginwindow',
  'opendirectoryd', 'securityd', 'coreservicesd', 'node']);   // node hosts this tool

function restartApp(name, cb) {
  const n = String(name || '').replace(/\.app$/i, '').trim();
  /* Same character set the Windows path allows. It excludes quotes and backslashes, which is what
     makes embedding $n inside the AppleScript below safe by construction rather than by escaping. */
  if (!n || !/^[A-Za-z0-9 ._+-]{1,64}$/.test(n)) return cb(new Error('bad app name'));
  if (NEVER_RESTART.has(n.toLowerCase())) {
    return cb(new Error(`${n} is system-critical or hosts this tool; restart it from macOS, not from here`));
  }
  /* 1. resolve the bundle */
  run('osascript', ['-e', `POSIX path of (path to application "${n}")`], {}, (e, out) => {
    const appPath = String(out || '').trim();
    if (e || !appPath) {
      return cb(new Error(`cannot resolve an application named "${n}"; relaunching a guess is worse than not relaunching`));
    }
    /* 2. who is running under that name (pgrep output is bare pids, one per line - not a format
          worth an injection fixture) */
    run('pgrep', ['-x', n], {}, (_pgErr, pgOut) => {
      const pids = String(pgOut || '').split('\n').map((s) => parseInt(s, 10)).filter((p) => p > 4);
      /* 3. graceful quit - the AppleScript route lets the app run its own save/exit path,
            exactly what CloseMainWindow buys on Windows */
      run('osascript', ['-e', `tell application "${n}" to quit`], {}, () => {
        setTimeout(() => {
          /* 4. force only the survivors */
          let forced = 0;
          for (const pid of pids) {
            try { signal(pid, 0); } catch { continue; }          // already exited: the graceful path worked
            try { signal(pid, 'SIGKILL'); forced++; } catch {}
          }
          setTimeout(() => {
            /* 5. relaunch the resolved bundle, not the name */
            run('open', [appPath], {}, (openErr) => {
              if (openErr) return cb(null, { ok: false, name: n, path: appPath, pids, err: 'relaunch failed: ' + openErr.message });
              cb(null, { ok: true, name: n, path: appPath, pids,
                closedGracefully: pids.length - forced, forced, err: '' });
            });
          }, 900);
        }, 2500);
      });
    });
  });
}

module.exports = {
  kill, clean, restartApp, cleanElevated,
  _inject,
  _internal: { measureTree, sweepChildren, shq, osaStr, CLEAN_TARGETS, NEVER_RESTART },
};
