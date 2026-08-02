/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS bridge — zero dependencies, Node 22.
 *
 * Design notes:
 *  - ONE long-lived PowerShell child (metrics.ps1) streams JSON lines. Spawning a fresh
 *    powershell.exe per sample costs ~250 ms of process startup; at 1 Hz that would burn a
 *    measurable slice of a CPU doing nothing but boot .NET. One process, forever, instead.
 *  - Transport is Server-Sent Events, not WebSocket: SSE is ~15 lines of raw Node, auto-reconnects
 *    in the browser for free, and metrics are strictly server->client so the duplex half of a
 *    WebSocket would go unused. Actions ride ordinary POSTs.
 *  - Binds to 127.0.0.1 only. This process can kill processes and delete caches; it must never be
 *    reachable off-box.
 */

const http = require('http');
const https = require('https');            // speed test only — nothing else leaves the box
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { History, readJsonFile, readTextFile } = require('./history');
const { diagnose, systemVolume } = require('./diagnose');
const { diagnoseAt } = require('./replay');
const { Workloads } = require('./workload');
const { Notifier } = require('./notify');
const { correlate } = require('./correlate');
const { Scheduler, BootTrial } = require('./schedule');
const { Reproducer, profileFrom } = require('./reproduce');
const { Governor } = require('./governor');
const { Sweep } = require('./sweep');
const { Outcomes } = require('./outcomes');
const { Ctl } = require('./ctl');
const { collector } = require('./collect');

/* 8790 by default; ctrl+glass owns 8787, so keep clear of it. VITALS_PORT lets a second install run
   alongside the first without a fight - which is exactly how the portable copy gets tested, and how
   this default got caught hard-coded in the first place. start.js reads the same variable, and the
   two MUST agree or the launcher waits forever on a port nothing is listening to. */
const PORT = +process.env.VITALS_PORT || 8790;
const HERE = __dirname;
/* OVERRIDABLE, so the store can be pointed somewhere disposable. Not a feature for users — it is
   what makes a BEHAVIOURAL test of the screen-read gate possible at all. That gate needs an admin
   passphrase to exercise, a suite must never contain the owner's, and the credential store lives
   here — so with this path hard-coded the only provable-by-driving guard in the product could
   never be driven, and it was pinned by source inspection alone. Review found the obstacle was
   never the passphrase; it was this line. */
const HIST_DIR = process.env.VITALS_HIST_DIR
  ? path.resolve(process.env.VITALS_HIST_DIR)
  : path.join(HERE, 'history');
const hist = new History(HIST_DIR);
/* B5/B6. Sessions are periods of OBSERVED activity per named executable, not process lifetimes -
   `tick.proc` is a top-16, so a program going quiet drops off it and absence is not an exit. */
const work = new Workloads(HIST_DIR);
work.prune();

/* Close the open sessions on the way out, so the run in progress is not lost. Without this, a
   machine that is only ever shut down normally would accumulate a baseline of nothing. */
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { work.flush(); hist.flush(); } catch {} process.exit(0); });
}
const outcomes = new Outcomes(HIST_DIR);
/* Automations read the ledger above and nothing else — what this machine has earned the right to
   do without being asked. Constructed here because its evidence IS the outcomes record. */
const { Automations } = require('./automate');
const automations = new Automations(HIST_DIR, outcomes);
/* Constructed, not started. The worker process only exists between the first sample request and
   twenty seconds after the last — see peek.js for why that matters more here than elsewhere. */
const { Peek } = require('./peek');
let peek = null;   // real instance assigned once PS is resolved below
/* An open window to read the screen: on disk so it survives nothing — a bridge restart is a fresh
   process, and the file carries only an expiry, so a crashed panel cannot leave the door open
   indefinitely. Capped hard: this is not a setting, it is a window. */
/* ---- THE SCREEN-READ WINDOW: IN MEMORY, AND SCOPED TO ONE CALLER ----
 * This was a file, `history/screen-grant.json`, and the file WAS the vulnerability. Ask runs with
 * `acceptEdits` and cwd at the install, so anything with disk access could write itself a grant and
 * never touch the passphrase at all — writing the file IS turning it on. The cap was checked when
 * writing and never when reading, so a hand-written `until` in the year 3000 was honoured forever.
 * Both problems are gone by construction here: there is nothing on disk to forge, and the clamp is
 * applied on every read rather than once at the door.
 *
 * A restart now CLOSES the window, and that is the correct direction. The old file survived a crash,
 * which meant a crash could leave the door open; a permission to look at somebody's screen should
 * need re-asking after the process that was granted it has died.
 *
 * SCOPED TO A CALLER, which is the fix for the incident that prompted all of this. A window opened
 * for the FX strip used to be a window for every client that could reach 127.0.0.1:8790 — a
 * reviewing agent read the screen BY ACCIDENT because a different agent had opened one. The token
 * is issued at /open, required by /api/peek, and counted per holder, so one human's permission is
 * one caller's permission and the counter can finally answer "who".
 */
const SCREEN_MAX_MIN = 120;
/* The largest grid the screen read will ever return — exactly what the panel asks for. */
const PEEK_MAX_W = 64, PEEK_MAX_H = 24;
let SCREEN = null;   // { until, token, why, reads }
function screenGrant() {
  if (!SCREEN) return { screenOpen: false };
  const now = Date.now();
  /* CLAMPED ON READ, not only on write. */
  const until = Math.min(SCREEN.until, SCREEN.openedAt + SCREEN_MAX_MIN * 60_000);
  if (until <= now) { SCREEN = null; return { screenOpen: false, expired: true }; }
  return { screenOpen: true, until, minutesLeft: Math.round((until - now) / 60000),
           why: (SCREEN.why || '').slice(0, 200), reads: SCREEN.reads };
}
/* The token never appears in a status payload — /api/peek/status is readable by anything, and a
   status endpoint that hands out the credential is a status endpoint that grants the permission. */
function screenTokenOk(t) { return !!SCREEN && !!t && t === SCREEN.token; }
let ctl = null;   // constructed after ps() is defined below
/* Resolved to an absolute path, not left to PATH - see pshost.js for the failure that taught us. */
const { PS, PS_ARGS } = require('./pshost');

/* ------------------------------------------------------------------ PLATFORM REALITY
 * The COLLECTOR is ported to three platforms. Everything else in this file is not: every action,
 * scan and one-shot below runs powershell.exe. That is a legitimate state to be in - the collector
 * is the hard part and the rest is scheduled work - but it must be STATED, not discovered.
 *
 * Two failures were shipped by not stating it:
 *   1. `spawn()` with no 'error' handler throws an unhandled ChildProcess error when the binary is
 *      absent, which does not fail the request - it KILLS THE BRIDGE. Telemetry, history, journal
 *      and the MCP server all die with it, from clicking a clipboard toggle.
 *   2. caps.js declared act.kill / scan.startup / net.sockets and friends TRUE on Linux and macOS,
 *      because the manifest was written from intent rather than from this file.
 *
 * WHY THIS WAS NOT CAUGHT: the Linux test host was WSL, and `spawn('powershell.exe')` SUCCEEDS from
 * WSL through Windows interop. The one Linux available was the one Linux where every PowerShell
 * dependency is invisible. A passing suite there proves nothing about a real Linux desktop. */
const PS_HOST = process.platform === 'win32';

/* B4: proactive alerting. Constructed HERE rather than beside the other stores, because it
   reads PS_HOST and `const` bindings are in the temporal dead zone until their declaration
   executes - placing it earlier threw "Cannot access 'PS_HOST' before initialization" and
   took the whole bridge down at require time. Server-side, because the entire point is the moments when no window is
   open to journal them. Capability is PROBED rather than assumed - a Linux box without libnotify
   and a Windows install with notifications disabled by policy are both "supported platforms" that
   cannot deliver, and the panel reports which. */
/* PS, THE RESOLVED PATH — not PS_HOST, which is a BOOLEAN (`process.platform === 'win32'`).
   That one-word mistake was the whole reason notifications never appeared on this machine: the
   Notifier spawns `psHost` as a program, so it was running `spawn(true)`, Node coerced it to the
   string "true", and every send died with ENOENT. Nothing caught it because `probe()` only tested
   the value for TRUTHINESS — `true` is extremely truthy — so the panel reported a healthy channel
   while delivery was impossible. A boolean passed where a path was expected, and both ends agreed
   it looked fine. See notify.js's constructor, which now refuses a non-string. */
const notifier = new Notifier({ psHost: PS });
/* The read log the AI surface writes, read here so the panel can answer "what has it seen?" and
   "what is it asking for?" without a second store. */
const { AiAccess } = require('./aiaccess');
const aiAccess = new AiAccess(HIST_DIR);
/* The staged-edit store. The bridge only lists, applies and rejects — it never proposes; that is
   the agent's side, and keeping the two apart is what makes "the owner decides" structural. */
const devedit = require('./devedit');
notifier.probe().then((ok) => {
  console.error('[notify] ' + (ok ? 'can raise notifications via ' + notifier.how
                                  : 'this host cannot raise notifications; alerts stay on the page'));
});
/* Set by the panel's beacon: someone is looking at the diagnosis RIGHT NOW, so telling them again
   would be telling them what is already on their screen. Stale after 15 s on purpose - a closed
   panel stops beaconing and cannot leave the bridge permanently muted. */
let watchingAt = 0, watchingView = null;
/* The native action layer for the other two platforms: kill / clean / restart-an-app in Node and
   osascript, same route contracts as the PowerShell one-shots. Loaded only off Windows - on
   Windows the PowerShell paths below remain the reference implementation, untouched. */
const posixActs = PS_HOST ? null : require('./actions-posix');
/* The native INSPECTION layer: sockets-with-owners and the startup scan, the read half of the
   same port. Same split as posixActs, same reason for loading it only off Windows. */
const posixInspect = PS_HOST ? null : require('./inspect-posix');

/* ================= MODE: what this install is allowed to DO =================
 *
 * Two modes, and the difference is not cosmetic:
 *
 *   admin   (default)  the technician's tool. Everything: kill a process, clear caches, restart an
 *                      app, pull the machine's own dials, toggle scheduled tasks.
 *   viewer             reads the machine and explains it. Reports, history, diagnosis, exports -
 *                      and nothing that changes the box it is running on.
 *
 * ENFORCED HERE, NOT IN THE PAGE. Hiding buttons is theatre: the bridge listens on a port, and
 * anything that can reach it can call the route the button would have called. A mode that only the
 * UI respects is a mode that anyone with curl can leave. So the router refuses, the manifest reports
 * `act.*` false so the panel hides the controls as a CONSEQUENCE rather than as the mechanism, and
 * the two cannot disagree because both read this one list.
 *
 * VIEWER IS ONE-WAY FROM THE UI. Dropping to viewer can be done from the panel; going back to admin
 * cannot, because a switch the viewer can flip is not a restriction. Admin is restored by launching
 * with VITALS_MODE=admin - deliberately outside the surface being restricted.
 *
 * The mode is remembered in history/mode.json so it survives a restart; a machine set to viewer
 * should not quietly become an admin console because someone rebooted. */
const MODE_FILE = path.join(HIST_DIR, 'mode.json');
function readMode() {
  const env = String(process.env.VITALS_MODE || '').trim().toLowerCase();
  if (env === 'admin' || env === 'viewer') {
    /* AN EXPLICIT LAUNCH PERSISTS. VITALS_MODE=admin is the documented way back from viewer, so it
       has to actually stick - otherwise "restored" lasts until the next ordinary launch from the
       taskbar, which reads the old file and silently drops back to viewer. A restore that quietly
       expires is worse than none, because you stop checking for it. */
    try { fs.writeFileSync(MODE_FILE, JSON.stringify({ mode: env, at: Date.now(), via: 'VITALS_MODE' }, null, 1)); } catch {}
    return env;
  }
  try {
    const j = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8'));
    if (j && (j.mode === 'admin' || j.mode === 'viewer')) return j.mode;
  } catch {}
  return 'admin';
}
let MODE = readMode();

/* Every route that CHANGES the machine. A report is not an action: it observes and writes its own
   output. Changing the panel's own appearance is not an action either - viewer mode is about the
   machine, not about forbidding someone from picking a theme.
   Kept as one list so caps.js, the router and the UI cannot drift into three different answers. */
const ACTION_ROUTES = new Set([
  '/api/kill',          // end a process
  '/api/quarantine/act',// the graduated ladder: priority, affinity, suspend, and their reversal
  '/api/replay',        // DELIBERATELY LOADS THE MACHINE — the one action here that makes it worse
  '/api/clean',         // delete caches
  '/api/restartapp',    // stop and restart an application
  '/api/ctl',           // write the machine's own settings
  '/api/ctl/restore',
  '/api/task',          // enable or disable a scheduled task
  '/api/reveal',        // open Explorer at a path
  '/api/openrecycle',
  '/api/mftscan',       // spawns an ELEVATED scan
  '/api/growthscan',    // walks the tree and writes a snapshot of the owner's folders
  /* peek.js spawns PowerShell itself rather than going through ps(), which is exactly why the
     call-graph check in test-routes.js could not see it: that guard only walks bridge.js. It
     degraded honestly without this entry, but this list is the INVENTORY of what the Windows
     build does that the others cannot, and a capability missing from the inventory is one that
     nobody reviews and no port ever gets written for. */
  '/api/iotrace',       // spawns an ELEVATED trace
  '/api/clip',          // starts a background clipboard watcher
  '/api/files',         // filetools: reveal / lock-holder actions
  '/api/ai/grant',      // release this machine's identifiers to an agent
  '/api/ai/revoke',
  '/api/ai/dev',        // the widest permission: stop redacting anything at all
  '/api/ai/devoff',
  '/api/ai/edit/apply', // change this install's own source
  '/api/ai/edit/reject',
  /* ARMING IS A WIDER PERMISSION THAN THE LEVER IT ARMS, and this list is where that has to be
     said. Review found these gated for CSRF (MUTATES) but not for MODE: a viewer who is refused
     POST /api/clean — "viewer reports the machine, it does not change it" — could still arm
     clean_temp_on_pressure, which is EARNED on this machine right now, and let the bridge's own
     30-second loop delete the files on their behalf. A standing grant handed to a role that is
     denied the one-off act is the gap inverted.
     Two gates, two questions: MUTATES asks "did a page ask for this properly", ACTION_ROUTES asks
     "is this install allowed to do it at all". Adding to one is never adding to the other. */
  /* Opening the screen-read window is the widest permission here, and viewer is the build you
     hand to somebody else. Reading /api/peek is refused to viewer as a privacy-sensitive read;
     being able to OPEN that door has to be refused too, or the first gate is decoration. */
  /* /close is NOT here on purpose: a revocation must never be harder than the grant. Viewer mode
     may always shut the window it cannot open — refusing that would mean handing someone a build
     that can watch a door stay open and do nothing about it. */
  '/api/peek/open',
  '/api/automations/arm',
  '/api/automations/disarm',
  '/api/automations/targets',
  '/api/automations/dismiss',
]);

/* ================= EVERY ROUTE THAT CHANGES SOMETHING MUST BE ASKED FOR BY POST =================
 *
 * REVIEW FOUND THIS FILE ASSERTING IT ALREADY DID. The comment on /api/quarantine/act read "Every
 * other mutating route in this file is POST-gated; these two were added without it." That sentence
 * was false when it was written. Seventeen more were reachable by GET, verified with plain curl and
 * no headers at all:
 *
 *   /api/panel/{mode,theme,view,top,alpha,blur}   200 {"ok":true}
 *   /api/watching                                 200   ← tells VITALS a human is looking, which
 *                                                         SUPPRESSES a critical notification
 *   /api/alerts/test                              200   ← spends a real notification
 *   /api/win/{min,close,rect,top,alpha,attach,...} 200  ← including close
 *
 * A GET is what an <img src> makes. Any page in any tab could close this window.
 *
 * AND `Sec-Fetch-Site` DOES NOT COVER IT, which is the part worth being clear about, because adding
 * that header check is what made this look solved. It FAILS OPEN by design: absent is allowed,
 * because absent is how curl, the MCP tool and the suites arrive. But absent is also Safari before
 * 16.4, Firefox before 90, and embedded Chromium old enough to still ship without it - and this
 * product has a FINISH_ON_A_MAC.md, so that is not a hypothetical browser. On a Mac running Safari
 * 16.2 an <img src="http://127.0.0.1:8790/api/win/close"> still worked.
 *
 * Method gating is the control that does not fail open: a cross-origin <img>, <script>, <iframe> or
 * <form> cannot issue a POST with a JSON content type, and cannot read the response whatever it
 * issues. Sec-Fetch-Site stays as the second layer, which is what it should have been all along.
 *
 * ONE DECLARED TABLE, not seventeen edits, so this cannot drift again - and test-routes.js asserts
 * the table against the live router, which is what turns it from a comment into a guard. Adding a
 * route that writes anything means adding it here; the suite fails if a listed route answers a GET.
 */
const MUTATES = new Map([
  /* Panel and window state. Not "the machine", so viewer mode deliberately allows them (see
     ACTION_ROUTES) - but a foreign page must not drive them either. Two different questions. */
  ['/api/panel/mode', null], ['/api/panel/theme', null], ['/api/panel/view', null],
  ['/api/panel/top', null], ['/api/panel/alpha', null], ['/api/panel/blur', null],
  ['/api/watching', null],
  ['/api/alerts/test', null],
  ['/api/frames', null],
  /* Releasing identifiers to an agent is a change to what leaves this machine. */
  ['/api/ai/grant', null], ['/api/ai/revoke', null],
  ['/api/ai/dev', null], ['/api/ai/devoff', null],
  ['/api/ai/edit/apply', null], ['/api/ai/edit/reject', null],
  /* Arming changes what this machine may do WITHOUT BEING ASKED, which is a larger change than
     any single lever pull — it is a standing grant rather than an act. Gated accordingly. */
  ['/api/peek/open', null], ['/api/peek/close', null],
  ['/api/automations/arm', null], ['/api/automations/disarm', null], ['/api/automations/dismiss', null],
  ['/api/automations/targets', null],
  /* Conditional: these serve a READ and an ACTION off one path, so the predicate decides. A route
     that is sometimes a read cannot be gated by its name alone. */
  ['/api/quarantine/act', (u) => (u.searchParams.get('do') || 'state') !== 'state'],
  ['/api/replay', (u) => u.searchParams.get('go') === '1' || u.searchParams.get('stop') === '1'],
]);
/* Prefix form, for the /api/win/ verb map — ten verbs behind one handler. */
const MUTATING_PREFIXES = ['/api/win/'];

function mutatesTheMachine(p, url) {
  if (MUTATES.has(p)) {
    const pred = MUTATES.get(p);
    return pred ? pred(url) : true;
  }
  return MUTATING_PREFIXES.some((x) => p.startsWith(x));
}

function methodGate(req, res, p, url) {
  if (req.method === 'POST') return true;
  if (!mutatesTheMachine(p, url)) return true;
  json(res, 405, {
    error: 'this route changes something, so it requires POST',
    detail: 'GET is for reads. A state-changing GET can be fired by an image tag on any page in ' +
            'any tab, which is why this is a method check and not only a header check.',
    route: p,
  });
  return false;
}

/* ---- THE ADMIN PASSPHRASE ----
 *
 * WHAT THIS IS. A guardrail, so viewer mode can be left deliberately rather than by accident, and so
 * handing someone the machine does not hand them the kill button. It turns "you cannot go back" into
 * "you have to mean it".
 *
 * WHAT IT IS NOT. A security boundary. Anyone with a shell on this machine can set VITALS_MODE=admin,
 * edit history/mode.json, or delete the hash below - all of which are ordinary file operations by the
 * same user this process runs as. Saying otherwise would be the exact dishonesty the rest of this
 * codebase exists to avoid. A real boundary means OS-level separation: run the bridge under an
 * account the viewer cannot write as, and ACL this folder.
 *
 * STORED AS A SALTED SCRYPT HASH, never as the passphrase. scrypt because it is deliberately slow
 * and memory-hard, so the file being readable does not make it cheap to reverse. Node ships it, so
 * this costs no dependency.
 *
 * The env var deliberately still works. It is the documented recovery path, and a forgotten
 * passphrase must not brick the tool - the trade is that the same door is also the bypass, which is
 * why the paragraph above says what it says. */
const crypto = require('crypto');
/* Same reasoning as the Ask key: outside the folder Ask runs in, so no file tool can reach it
   without an explicit --add-dir that nothing passes. `Ask.secretDir()` is the one implementation. */
const { Ask: _AskCls } = require('./ask');
/* OVERRIDABLE for the same reason HIST_DIR is, and this is the one that actually mattered. Review
   identified HIST_DIR as the obstacle to a behavioural test of the screen-read gate; it was one
   level off. The admin passphrase lives in the SECRET dir — %LOCALAPPDATA%\vitals on Windows, far
   outside the history folder — so isolating HIST_DIR alone still left a suite unable to set a
   credential it was allowed to know, and the gate still untestable by driving it. */
const SECRET_DIR = process.env.VITALS_SECRET_DIR
  ? path.resolve(process.env.VITALS_SECRET_DIR)
  : ((_AskCls.secretDir && _AskCls.secretDir()) || HIST_DIR);
const PASS_FILE = path.join(SECRET_DIR, 'admin-pass.json');
/* Same one-time migration for the passphrase, for the same reason: an upgrade that silently forgets
   someone's admin passphrase locks them out of their own install. */
try {
  const legacyPass = path.join(HIST_DIR, 'admin-pass.json');
  if (SECRET_DIR !== HIST_DIR && fs.existsSync(legacyPass) && !fs.existsSync(PASS_FILE)) {
    fs.copyFileSync(legacyPass, PASS_FILE);
    fs.unlinkSync(legacyPass);
    console.error('[mode] moved admin-pass.json out of the install folder to ' + SECRET_DIR);
  }
} catch {}

function setAdminPass(plain) {
  if (!plain) { try { fs.unlinkSync(PASS_FILE); } catch {} return { set: false }; }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, 64);
  fs.writeFileSync(PASS_FILE, JSON.stringify({
    salt: salt.toString('hex'), hash: hash.toString('hex'), at: Date.now(),
  }, null, 1));
  return { set: true };
}
function hasAdminPass() { try { return !!JSON.parse(fs.readFileSync(PASS_FILE, 'utf8')).hash; } catch { return false; } }
function checkAdminPass(plain) {
  let j; try { j = JSON.parse(fs.readFileSync(PASS_FILE, 'utf8')); } catch { return false; }
  if (!j || !j.salt || !j.hash) return false;
  const want = Buffer.from(j.hash, 'hex');
  const got = crypto.scryptSync(String(plain || ''), Buffer.from(j.salt, 'hex'), want.length);
  /* Constant time. A plain === would leak the length of the correct prefix through timing, which is
     a small thing here but a free thing to get right. */
  try { return crypto.timingSafeEqual(want, got); } catch { return false; }
}

/* Guessing has to be expensive in wall-clock terms too, or a slow hash just moves the bottleneck.
   Five tries, then a minute of silence - enough to be unnoticeable to someone who knows it. */
const passAttempts = { n: 0, until: 0 };
function passRateLimited() {
  if (Date.now() < passAttempts.until) return Math.ceil((passAttempts.until - Date.now()) / 1000);
  if (passAttempts.until && Date.now() >= passAttempts.until) { passAttempts.n = 0; passAttempts.until = 0; }
  return 0;
}
function notePassFailure() {
  if (++passAttempts.n >= 5) { passAttempts.until = Date.now() + 60000; passAttempts.n = 0; }
}

/* VIEWER RESTRICTS READING TOO, for the routes where reading IS the exposure.
 *
 * Viewer was built to stop the machine being CHANGED, and the docs then pointed it at the case where
 * you hand the machine to someone else - which invites reading it as a privacy control. It was not
 * one: an MFT snapshot is a complete index of every file on the owner's drive, `/api/files` answers
 * questions about their folders, and the support bundle packages a lot of it up in one download.
 * Metrics stay open - CPU, memory, disk pressure, the journal and the diagnosis are the whole point
 * of handing someone a monitor, and none of them names a file. */
const VIEWER_PRIVATE_ROUTES = new Set([
  '/api/mft',        // a full index of the filesystem
  '/api/scanlog',    // the scan's own log, which names paths
  '/api/growth',     // which of the owner's folders grew
  '/api/bigdirs',    // the largest folders by name
  '/api/files',      // file tools: sizes, owners, who has what open
  '/api/clip/img',   // saved clipboard images
  '/api/bundle',     // packages several of the above into one file
  /* The most sensitive read in the product: the pixels of whatever is on screen. It changes
     nothing, so it is not an ACTION — but viewer mode exists to be the build you can hand to
     somebody else, and 'cannot change the machine, may photograph your screen' is not a coherent
     description of a restricted mode. It belongs with the other reads that expose the owner
     rather than the machine. */
  '/api/peek',
]);
/* Redaction for anything a viewer-mode session may still see. Identical reasoning to ask.js: SHAPE
   catches the paths no rule author anticipated, VALUE catches the identifiers this machine already
   knows about itself. A bare account name has no shape, which is exactly how "&lt;account&gt; grew 19.5 GB"
   escaped a purely pattern-based scrub the first time. */
const OWN_IDENTIFIERS = (() => {
  const os = require('os');
  const out = new Set();
  try { out.add(os.userInfo().username); } catch {}
  try { out.add(os.homedir().split(/[\\/]/).filter(Boolean).pop()); } catch {}
  try { out.add(os.hostname().split('.')[0]); } catch {}
  return [...out].filter((x) => x && x.length >= 3);
})();
function scrubText(t) {
  let out = String(t == null ? '' : t)
    .replace(/[A-Za-z]:\\[^\s,;"']+/g, '<path>')
    .replace(/(?:\/[\w.-]+){2,}/g, '<path>');
  for (const id of OWN_IDENTIFIERS) {
    out = out.replace(new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '<account>');
  }
  return out;
}
/* EVERY STRING, not a list of field names.
 *
 * The first version scrubbed title/action/detail/evidence and missed `short` - a field added later
 * for the compact rail, carrying the same sentence. That is the identical mistake as denying Read
 * but not Grep: enumerating the doors you can think of, in a structure that grows.
 *
 * So this walks the whole object and scrubs every string it finds. Numbers, booleans and keys are
 * untouched - the numbers were never the exposure, and the severity/key fields have to stay literal
 * for the UI to match on them. A field added next month is covered without anyone remembering. */
const LITERAL_KEYS = new Set(['sev', 'sevName', 'key', 'id', 'kind', 'lever', 'page', 'go']);
function scrubDeep(v, keyName) {
  if (typeof v === 'string') return LITERAL_KEYS.has(keyName) ? v : scrubText(v);
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, keyName));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = scrubDeep(val, k);
    return out;
  }
  return v;
}
function scrubFindings(d) {
  if (!d || typeof d !== 'object') return d;
  /* SCRUB THE WHOLE OBJECT, not just `findings`. The first version mapped over `d.findings` and left
     everything beside it - and diagnose.js sets a top-level `summary` from the top finding's RAW
     title, so the scrubbed copy sat inside the array while the unscrubbed one sat next to it.
     Scoping a recursive fix to one branch is the same mistake as enumerating fields inside it. */
  return scrubDeep(d);
}

function viewerPrivacyRefusal(res, route) {
  return json(res, 403, {
    error: 'viewer mode does not expose the filesystem',
    mode: MODE, route,
    detail: 'Viewer reports on how the machine is PERFORMING - CPU, memory, disk pressure, the ' +
            'journal, the ranked diagnosis - but not on what is stored on it. File listings, the ' +
            'MFT index and the support bundle all name the files themselves, so they are withheld here.',
  });
}

function modeRefusal(res, route) {
  return json(res, 403, {
    error: 'this install is in viewer mode',
    mode: MODE,
    route,
    detail: 'Viewer mode reads the machine and reports on it, but cannot change it. Restart with ' +
            'VITALS_MODE=admin to restore the technician tools - deliberately not something the ' +
            'viewer can switch on for itself.',
  });
}

/* ---- CHILD WINDOWS ----
 * The panel and its pop-outs are VIEWS of one application, not separate programs. The bridge is the
 * application: it holds the collector, the history, the journal and the Ask thread, and it keeps
 * running with no windows open at all - that is the documented "close the window, keep the record"
 * behaviour and it is deliberate.
 * But the UI should still behave like one thing, so the bridge remembers the windows it opened:
 * keyed by view path, so a second "pop out" raises the existing window instead of starting a rival,
 * and so closing the panel can take its children with it rather than stranding a chat window that
 * has no rail and no way back to anything. */
const childWindows = new Map();   // '/?view=ask' -> { pid, title }

function isAlive(pid) {
  if (!pid) return false;
  /* Signal 0 tests for existence without delivering anything. */
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function closeWindow(pid) {
  try { spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    .on('error', () => {}); } catch {}
}
/* Raising someone else's window needs Win32, and a background process has no foreground rights - so
   the same brief topmost flip the host uses on first show, applied from outside. */
function raiseWindow(pid) {
  if (!PS_HOST) return;
  const ps1 = `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p -and $p.MainWindowHandle -ne 0){` +
    `Add-Type -Name W -Namespace R -MemberDefinition '[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int c);` +
    `[DllImport("user32.dll")]public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int cx,int cy,uint f);';` +
    `[R.W]::ShowWindow($p.MainWindowHandle,9)|Out-Null;` +          // SW_RESTORE, in case it is minimised
    `[R.W]::SetWindowPos($p.MainWindowHandle,[IntPtr]-1,0,0,0,0,0x0003)|Out-Null;` +   // HWND_TOPMOST
    `[R.W]::SetWindowPos($p.MainWindowHandle,[IntPtr]-2,0,0,0,0,0x0003)|Out-Null }`;   // back to NOTOPMOST
  try { spawn(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps1],
    { windowsHide: true, stdio: 'ignore' }).on('error', () => {}); } catch {}
}

/* THE INVENTORY. Every route below is implemented as a PowerShell one-shot and therefore does not
   work off Windows in this build. Written out rather than pattern-matched so that adding a route
   forces a decision about it, and so collect/caps.js can import the same list instead of restating
   it from memory - which is exactly how the manifest came to claim capabilities the code lacked. */
const WINDOWS_ONLY_ROUTES = new Set([
  '/api/startup', '/api/processes', '/api/conns', '/api/netinfo', '/api/nettest',
  '/api/battreport', '/api/bigdirs', '/api/reclaim', '/api/clean', '/api/kill', '/api/restartapp',
  '/api/quarantine/act',
  '/api/mft', '/api/mftscan', '/api/scanlog', '/api/iotrace', '/api/files',
  '/api/task', '/api/clip', '/api/reveal', '/api/openrecycle',
  /* '/api/growth' LEFT THIS LIST 2026-07-31: it is pure Node (it diffs snapshots), it answers an
     honest {need:2, have:N} when no snapshots exist, and growthscan.js now produces snapshots on
     any platform - so the dependency argument that once justified gating it is gone. */
  /* The CTRL page has three routes, not one. Listing only '/api/ctl' left the page's own state
     fetch and its restore action falling through to a raw ENOENT 500. */
  '/api/ctl', '/api/ctl/state', '/api/ctl/restore',
  /* The support bundle zips with Compress-Archive, so it is PowerShell too - and the MCP
     vitals_bundle tool hits the same wall. */
  '/api/bundle',
  /* DELIBERATELY ABSENT: '/api/speedtest'. It was in this list and should not have been - speedTest()
     is pure Node https and works everywhere. Gating it disabled a working cross-platform feature and
     told the user a lie about why. '/api/nettest' IS PowerShell and stays.
     Also removed: '/api/recycle', a route that does not exist. A phantom entry protected nothing
     while the real '/api/openrecycle' went unguarded - the hazard of writing this list from memory
     instead of from the router. */
  /* THE SCREEN READ. peek.js spawns powershell.exe itself rather than going through ps(),
     which is why the call-graph check could not see it — that graph walked bridge.js and this
     product spans thirty files. It sat in NEITHER platform list, green, for as long as it
     existed. open/close are here too: a window authorising a capability the host does not
     have is a door onto a wall. */
  '/api/peek', '/api/peek/status', '/api/peek/open', '/api/peek/close',
]);

/* Routes from the set above that now have a NATIVE implementation on a non-Windows platform.
   The route stays in WINDOWS_ONLY_ROUTES - that list is the inventory of what the WINDOWS build
   implements as PowerShell, and test-routes.js audits it against the router - and this map is the
   per-platform exception: listed here, the gate lets the request through to the handler, whose
   helper dispatches to actions-posix.js. A platform absent from this map, or a route absent from
   its set, still gets the honest 501.
   NOT wired to caps.js on purpose: a flag there means "verified on this platform", and these
   implementations have never run on their platforms. Route reachable, capability unclaimed -
   that is the same two-act split cpu.perCore documents in the darwin manifest. */
const PORTED_ROUTES = {
  darwin: new Set(['/api/kill', '/api/clean', '/api/restartapp',
    /* 2026-07-31, the inspection + clipboard set: conns and startup dispatch to inspect-posix.js,
       clip to clipwatch-posix.js. Same rule as the actions - route reachable, capability
       unclaimed until the CI live run sees real rows. */
    '/api/conns', '/api/startup', '/api/clip']),
  linux: new Set(['/api/kill', '/api/clean',
    /* 2026-07-31: conns (native /proc/net/tcp + fd-inode join) and startup (systemctl + blame +
       XDG autostart) in inspect-posix.js, written against CI-captured bytes. Route reachable,
       capability unclaimed until the live run sees real rows - the same two-act split as darwin. */
    '/api/conns', '/api/startup']),   // restartApp needs osascript; no Linux equivalent yet
};
const PORTED_HERE = PORTED_ROUTES[process.platform] || new Set();

/* A route that cannot work here says so, with the reason and what would be needed - rather than
   surfacing `spawn powershell.exe ENOENT` as a 500 and letting the page look broken. */
function psOnly(res, feature) {
  return json(res, 501, {
    error: `${feature} is Windows-only in this build`,
    platform: process.platform,
    detail: 'This route is implemented as a PowerShell one-shot. The telemetry collector is ported ' +
            'to this platform; the action and scan layer is not yet. See collect/caps.js.',
  });
}

let latest = null;         // most recent tick

/* THE COLLECTOR THAT CHECKS ITSELF (B17). caps.js declares what a host CANNOT answer; nothing
   declared what happens when it answers WRONGLY. This compares the fast path against an
   independent one on a duty cycle and publishes the agreement - see selfcheck.js for why that is
   agreement and deliberately not an error bar. */
const { SelfCheck } = require('./selfcheck');
const selfCheck = new SelfCheck();
let selfTick = 0;
let staticInfo = null;     // one-time machine description
/* One walker at a time. Two concurrent walks of the same tree would race each other's snapshots
   and halve each other's I/O; the route answers 409 instead. */
let growthScanState = { running: false, startedAt: 0, root: null, last: null };
let lhm = null;            // LibreHardwareMonitor sensors, if it's running
const clients = new Set();

/* ---------------- metrics child ----------------
 * The platform-specific part now lives behind collect/, which picks the plug that fits the host and
 * hands back the SAME tick shape regardless. On Windows this is still metrics.ps1, byte for byte;
 * the indirection costs one function call and buys the macOS and Linux ports. */

const COLLECT = collector();
const CAPS = COLLECT.caps;
/* Module-scope, because the VETO has to reach the ROUTE and not only the panel. It was applied in
   onStatic() alone, so /api/caps still answered with the raw manifest - and /api/caps is precisely
   what INSTALL_FOR_CLAUDE tells an installing agent to check. The panel was honest and the API was
   not, which is the worse half to get wrong. */
let COUNTERS_OK = true;
/* THE MANIFEST FOLLOWS THE MODE. In viewer mode every act.* capability is false, so the panel hides
   the controls for the same reason it hides an unmeasurable gauge - because the install genuinely
   cannot do it, not because someone remembered to add a check to a button. One source, two
   consumers, no way for the router and the UI to disagree. */
function applyMode(caps) {
  const out = { ...caps, mode: MODE, can: { ...caps.can }, caps: { ...caps.caps } };
  /* The collector's veto, applied HERE so it reaches every consumer of the manifest rather than
     only the static event. See COUNTERS_OK above. */
  if (!COUNTERS_OK) {
    out.verified = false;
    out.countersOK = false;
    out.verifyNote = 'The English performance-counter names did not resolve on this machine, which ' +
                     'usually means a non-English Windows. .NET resolves counters by localized name, ' +
                     'so CPU, memory, disk and network are NOT being measured here.';
    for (const k of Object.keys(out.can)) {
      if (/^(cpu|mem|disk|net|proc|gpu)\./.test(k)) { out.can[k] = false; out.caps[k] = false; }
    }
  }
  if (MODE === 'viewer') {
    for (const k of Object.keys(out.can)) {
      if (k.startsWith('act.')) { out.can[k] = false; out.caps[k] = false; }
    }
    out.missing = [...new Set([...(caps.missing || []),
      ...Object.keys(out.can).filter((k) => k.startsWith('act.'))])];
    out.limited = (caps.limited || []).filter((k) => !k.startsWith('act.'));
    out.modeNote = 'Viewer mode: this install reads and reports on the machine but cannot change it.';
  }
  return out;
}

function startMetrics() {
  return COLLECT.start(HERE, {
    onStatic(msg) {
      /* Capabilities ride along with the machine description so the page knows what it may draw
         before the first tick arrives, rather than discovering gaps as missing fields. */
      msg.caps = applyMode(CAPS);
      /* THE COLLECTOR GETS A VETO. metrics.ps1 probes whether the English performance-counter names
         resolve, because .NET looks them up by LOCALIZED name - on a non-English Windows every
         counter returns null and the collector reads nothing while the manifest cheerfully reports
         Windows as the fully-verified platform. A manifest that outranks the collector's own report
         of itself is exactly the lie this file exists to prevent, so the flag wins. */
      if (msg.countersOK === false) COUNTERS_OK = false;
      if (msg.countersOK === false) {
        msg.caps = { ...msg.caps, verified: false,
          verifyNote: 'The English performance-counter names did not resolve on this machine, which ' +
                      'usually means a non-English Windows. .NET resolves counters by localized name, ' +
                      'so CPU, memory, disk and network are NOT being measured here. This is a known ' +
                      'gap, not a fault in your machine.',
          countersOK: false };
        for (const k of Object.keys(msg.caps.can)) {
          if (/^(cpu|mem|disk|net|proc|gpu)\./.test(k)) { msg.caps.can[k] = false; msg.caps.caps[k] = false; }
        }
        msg.caps.missing = Object.keys(msg.caps.can).filter((k) => !msg.caps.can[k]);
      }
      staticInfo = msg;
      broadcast('static', msg);
    },
    onTick(msg) {
      if (lhm) msg.sensors = lhm;
      latest = msg;
      try { hist.add(msg); } catch (e) { console.error('[history]', e.message); }
      /* B5/B6: per-workload sessions. Wrapped for the same reason history is - an accounting
         layer that can take the collector down is worse than no accounting layer. */
      try { work.add(msg); } catch (e) { console.error('[workload]', e.message); }
      /* SELF-CHECK, on a duty cycle. The collector's reading is compared against a second,
         independent path into the kernel (see selfcheck.js), which owns the cadence: fast until it
         has enough samples to say anything, sparse thereafter. It runs server-side with the rest of
         the record for the same reason the diagnosis does: an audit that only happens while someone
         is looking is an audit of the moments nobody needed it.
         Wrapped, because a verification that can take the bridge down is worse than no
         verification - the whole point of it is to be the thing that never lies. */
      if (selfCheck.due(++selfTick)) {
        /* Fire and forget: the check spans a second of its own and must never delay a tick or
           take the bridge down with it. Both the throw and the rejection are caught - it is a
           diagnostic, and a diagnostic that can kill the thing it diagnoses is a liability. */
        try {
          Promise.resolve(selfCheck.check(msg))
            .catch((e) => console.error('[selfcheck]', e && e.message));
        } catch (e) { console.error('[selfcheck]', e.message); }
      }
      broadcast('tick', msg);
    },
    onError(text) { process.stderr.write(String(text)); },
  });
}

/* ---------------- window agent ----------------
 * Persistent Win32 helper over stdin/stdout. Requests are serialised through a queue because the
 * agent is a single-threaded REPL: it reads one line, does the work, writes one line. Overlapping
 * two commands would interleave their replies and desynchronise every subsequent one. */

let winProc = null;
const winQueue = [];
let winBusy = false;

function startWinAgent() {
  if (!PS_HOST) { winProc = null; return; }
  winProc = spawn(PS, [...PS_ARGS, '-File', path.join(HERE, 'winagent.ps1')], { windowsHide: true });
  /* MUST be present. An unhandled 'error' on a ChildProcess does not fail the request, it throws out
     of the event loop and takes the whole bridge down. */
  winProc.on('error', (e) => {
    console.error('[winagent] could not start: ' + e.message);
    winProc = null;
    while (winQueue.length) { const j = winQueue.shift(); try { j.cb(e); } catch {} }
    winBusy = false;
  });
  let buf = '';
  winProc.stdout.on('data', (c) => {
    buf += c.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const job = winQueue.shift();
      winBusy = false;
      if (job) { try { job.cb(null, JSON.parse(line)); } catch (e) { job.cb(e); } }
      pumpWin();
    }
  });
  winProc.stderr.on('data', (d) => process.stderr.write('[winagent] ' + d));
  winProc.on('exit', () => { winProc = null; setTimeout(startWinAgent, 2000); });
}

function pumpWin() {
  if (winBusy || !winQueue.length || !winProc) return;
  winBusy = true;
  winProc.stdin.write(JSON.stringify(winQueue[0].cmd) + '\n');
}

/* Spawned LAZILY, on first use. The native panel host (panel.ps1) owns its own window and talks to
 * the page directly over WebView2's message channel, so the agent is only needed by the Edge --app
 * fallback. Starting it unconditionally cost ~35 MB of resident PowerShell that nothing would ever
 * call — which on a machine already at 78% RAM is exactly the kind of waste this tool exists to find. */
function win(cmd, cb = () => {}) {
  if (!winProc) startWinAgent();
  if (!winProc) return cb(new Error('window agent unavailable'));
  winQueue.push({ cmd, cb });
  pumpWin();
}

/* ------------- LibreHardwareMonitor (optional) -------------
 * LHM's built-in web server exposes a sensor tree at :8085/data.json. Windows itself cannot report
 * CPU temperature, fan RPM or package power through WMI at all, so this is the only free way to get
 * real thermals. Absent = the UI just hides the thermal panel.                                    */

function flattenSensors(node, out, trail) {
  if (!node) return out;
  const name = [...trail, node.Text].filter(Boolean);
  if (node.Value && node.Value !== '-' && (!node.Children || !node.Children.length)) {
    out.push({ path: name.join(' / '), text: node.Text, value: node.Value, min: node.Min, max: node.Max });
  }
  (node.Children || []).forEach((c) => flattenSensors(c, out, name));
  return out;
}

function pollLHM() {
  const req = http.get({ host: '127.0.0.1', port: 8085, path: '/data.json', timeout: 1200 }, (res) => {
    let d = '';
    res.on('data', (c) => (d += c));
    res.on('end', () => {
      try {
        const flat = flattenSensors(JSON.parse(d), [], []);
        const pick = (re) => flat.filter((s) => re.test(s.path));
        lhm = {
          available: true,
          temps: pick(/Temperature/i).filter(s => /°C/.test(s.value)).slice(0, 14),
          fans:  pick(/Fan|RPM/i).slice(0, 6),
          power: pick(/Power/i).slice(0, 6),
          clocks: pick(/Clock/i).slice(0, 8),
        };
      } catch { lhm = null; }
    });
  });
  req.on('error', () => { lhm = null; });
  req.on('timeout', () => { req.destroy(); lhm = null; });
}
setInterval(pollLHM, 4000);
pollLHM();

/* ---------------- SSE ---------------- */

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) { try { c.write(frame); } catch { clients.delete(c); } }
}

/* ---------------- PowerShell one-shots for on-demand panels ----------------
 * These are genuinely expensive (recursive directory sizing walks hundreds of thousands of files),
 * so they are NEVER on the 1 Hz path — the UI asks for them explicitly and shows a spinner.      */

function ps(script, cb) {
  execFile(PS, [...PS_ARGS, '-Command', script],
    { maxBuffer: 24 * 1024 * 1024, windowsHide: true },
    (err, stdout, stderr) => {
      if (err && !stdout) return cb(err, null);
      try { cb(null, JSON.parse(stdout || 'null')); }
      catch (e) { cb(new Error('bad JSON from PowerShell: ' + (stderr || e.message)), null); }
    });
}
ctl = new Ctl(HIST_DIR, ps);
/* Here rather than at the top because it needs the RESOLVED PowerShell path — `PS`, not the bare
   name. pshost.js exists because three files once each resolved it their own way; passing the
   resolved value is how a fourth avoids joining them. A host without PowerShell gets a Peek that
   reports itself unavailable rather than one that throws on first use. */
peek = new Peek(PS_HOST ? PS : null, HERE);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { peek.stop(); } catch {} });
const { Journal } = require('./journal');
const journal = new Journal(HIST_DIR);
const { Ask } = require('./ask');
/* cwd is the vitals folder on purpose: asked to change something, it should be looking at this
   product's own source. permissionMode is acceptEdits so "change the design" actually can - the same
   setting ctrl+glass runs, and worth knowing rather than discovering. */
/* ASK IS THE HOLE VIEWER MODE WOULD OTHERWISE LEAVE WIDE OPEN.
 *
 * It runs a real Claude with `acceptEdits` and cwd set to this folder - it can rewrite dashboard.html,
 * and through its MCP tools it reaches the same bridge every action route lives on. Blocking the
 * buttons while leaving an agent that can edit the software and call the API would be a lock on the
 * door of a building with no walls.
 *
 * So in viewer mode it drops to `plan`: it can still read everything, diagnose, and explain - which
 * is the entire point of asking it - but it cannot write. The read-only MCP tools are unaffected,
 * because reading was never the thing being restricted. */
/* A FUNCTION, so it is evaluated when a question runs rather than when the bridge booted. Switching
   to viewer at runtime used to leave Ask on acceptEdits until a restart - and the switch cheerfully
   reported "Ask drops to read-only on its next question", which was simply untrue. */
const askPermission = () => (MODE === 'viewer'
  ? 'plan'
  : (process.env.VITALS_PERMISSION_MODE || 'acceptEdits'));
const ask = new Ask(HIST_DIR, { cwd: HERE, port: PORT, permissionMode: askPermission, mode: () => MODE });
let cachedMaint = null;

/* ---------------- clipboard history (2026-07-30, opt-in) ----------------
 * OFF unless started, and it is not started by default anywhere. The watcher polls
 * GetClipboardSequenceNumber, which measured 0.0064 ms per call against 1.67 ms for an actual
 * Get-Clipboard - 260x - so the idle cost is a rounding error and the clipboard is only opened on the
 * ticks where it genuinely changed.
 * Retention is deliberately long (the owner asked for a long history) but bounded, and the file is
 * NEVER added to a support bundle by default: a clipboard log is the most sensitive artefact this tool
 * can hold. */
const CLIP_KEEP_DAYS = 120;
let clipProc = null;
const clipFile = (ms) => path.join(HIST_DIR, `clipboard-${new Date(ms || Date.now()).toISOString().slice(0, 10)}.jsonl`);

function clipStart() {
  if (clipProc) return { running: true, already: true };
  /* Two watchers, one contract: same jsonl rows, same file, same scrub/prune pipeline above.
     The macOS one is text-only and polls pbpaste - clipwatch-posix.js states the cost and the
     blind spots in its header. Linux would need xclip/wl-clipboard and a running session, which
     cannot be assumed from here: still honestly unsupported. */
  if (!PS_HOST && process.platform !== 'darwin') {
    return { running: false, unsupported: true, reason: 'clipboard history needs a pasteboard the bridge can read; not ported to ' + process.platform };
  }
  const [wcmd, wargs] = PS_HOST
    ? [PS, [...PS_ARGS, '-File', path.join(HERE, 'clipwatch.ps1'), '-Out', clipFile()]]
    : [process.execPath, [path.join(HERE, 'clipwatch-posix.js'), '--out', clipFile()]];
  const p = spawn(wcmd, wargs, { windowsHide: true });
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', () => {});          // the watcher writes its own file; stdout is just a heartbeat
  /* Same rule as the window agent: no 'error' handler means a missing binary kills the bridge, not
     the feature. This one was reachable from a toggle on the TOOLS page. */
  p.on('error', (e) => { console.error('[clipwatch] could not start: ' + e.message); clipProc = null; });
  p.on('exit', () => { clipProc = null; });
  clipProc = p;
  return { running: true };
}
function clipStop() {
  if (!clipProc) return { running: false };
  try { clipProc.kill(); } catch {}
  clipProc = null;
  return { running: false };
}
function clipRead(days, limit) {
  const out = [];
  for (let i = 0; i < Math.max(1, Math.min(days || 7, 60)); i++) {
    const f = clipFile(Date.now() - i * 86400_000);
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);
    const lines = txt.split('\n');
    for (let j = lines.length - 1; j >= 0; j--) {
      const l = lines[j].trim(); if (!l) continue;
      try { out.push(JSON.parse(l)); } catch {}
      if (out.length >= (limit || 200)) return out;
    }
  }
  return out;
}
/* THE SCRUB PASS. This is what makes "keep everything" safe rather than reckless.
 * Secret-shaped entries keep their full text for SECRET_HOURS so the owner can go back for the token
 * he just copied, and after that the text is blanked in place while the row survives - you can still
 * see that something was copied from that app at that minute, you just cannot read it any more.
 * Ordinary entries keep their text for the full retention.
 * Rewrites in place and only when something actually changed, so it is a no-op on every pass but the
 * first after a window rolls over. */
const SECRET_HOURS = 24;
function clipScrub() {
  const cutoff = Date.now() - SECRET_HOURS * 3600_000;
  let scrubbed = 0;
  try {
    for (const f of fs.readdirSync(HIST_DIR)) {
      if (!/^clipboard-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
      const p = path.join(HIST_DIR, f);
      let txt = fs.readFileSync(p, 'utf8');
      if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);
      let changed = false;
      const out = txt.split('\n').map((l) => {
        if (!l.trim()) return l;
        let r; try { r = JSON.parse(l); } catch { return l; }
        if (r.secret && r.text && r.at < cutoff) { r.text = ''; r.scrubbed = true; changed = true; scrubbed++; return JSON.stringify(r); }
        return l;
      });
      if (changed) fs.writeFileSync(p, out.join('\n'));
    }
  } catch {}
  return scrubbed;
}
setInterval(clipScrub, 900_000);      // every 15 min; cheap because it only writes when something aged out

/* Saved clip images live in history/clips. Bounded TWO ways because either alone fails: by age, so an
 * idle machine does not keep last spring's screenshots, and by total size, so one busy afternoon of
 * copying screenshots cannot quietly eat the disk this whole tool exists to protect. Oldest goes first. */
const CLIPS_DIR = path.join(HIST_DIR, 'clips');
const CLIPS_MAX_MB = 400, CLIPS_KEEP_DAYS = 30;
function clipsPrune() {
  try {
    if (!fs.existsSync(CLIPS_DIR)) return { files: 0, mb: 0 };
    let items = fs.readdirSync(CLIPS_DIR).filter((f) => /^clip-[\w-]+\.png$/.test(f))
      .map((f) => { const st = fs.statSync(path.join(CLIPS_DIR, f)); return { f, mtime: st.mtimeMs, size: st.size }; })
      .sort((a, b) => b.mtime - a.mtime);
    const cutoff = Date.now() - CLIPS_KEEP_DAYS * 86400_000;
    let total = 0;
    for (const it of items) {
      total += it.size;
      if (it.mtime < cutoff || total > CLIPS_MAX_MB * 1048576) {
        try { fs.unlinkSync(path.join(CLIPS_DIR, it.f)); total -= it.size; } catch {}
      }
    }
    items = fs.readdirSync(CLIPS_DIR).filter((f) => /\.png$/.test(f));
    return { files: items.length, mb: +(items.reduce((s, f) => s + fs.statSync(path.join(CLIPS_DIR, f)).size, 0) / 1048576).toFixed(1) };
  } catch { return { files: 0, mb: 0 }; }
}

function clipStats() {
  clipScrub();
  let files = 0, lines = 0, bytes = 0, oldest = null;
  try {
    for (const f of fs.readdirSync(HIST_DIR)) {
      const m = /^clipboard-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (!m) continue;
      files++;
      const st = fs.statSync(path.join(HIST_DIR, f)); bytes += st.size;
      lines += (fs.readFileSync(path.join(HIST_DIR, f), 'utf8').match(/\n/g) || []).length;
      if (!oldest || m[1] < oldest) oldest = m[1];
      if (Date.parse(m[1]) < Date.now() - CLIP_KEEP_DAYS * 86400_000) fs.unlinkSync(path.join(HIST_DIR, f));
    }
  } catch {}
  const clips = clipsPrune();
  return { files, lines, bytes, oldest, keepDays: CLIP_KEEP_DAYS, secretHours: SECRET_HOURS,
           running: !!clipProc, clips, clipsMaxMB: CLIPS_MAX_MB, clipsKeepDays: CLIPS_KEEP_DAYS };
}

/* ---------------- restart an app (2026-07-29, owner-approved) ----------------
 * The blocklist is not paranoia theatre: ending any of these takes the session or the box down, and
 * "restart" on them means a reboot, which is a different decision the user gets to make explicitly.
 * Everything else is fair game because the caller is unelevated - it can only touch its own user's
 * processes anyway, which is the real safety boundary here. */
const NEVER_RESTART = new Set(['system', 'registry', 'idle', 'csrss', 'wininit', 'winlogon', 'services',
  'lsass', 'smss', 'svchost', 'dwm', 'explorer', 'fontdrvhost', 'memory compression', 'secure system',
  'audiodg', 'conhost', 'node', 'powershell']);

function restartApp(name, cb) {
  /* Off Windows: resolve-the-bundle-first / graceful-quit / force-survivors / relaunch, via
     osascript in actions-posix. Only reachable on darwin (see PORTED_ROUTES). */
  if (!PS_HOST) return posixActs.restartApp(name, cb);
  const n = name.replace(/\.exe$/i, '').trim();
  if (!n || !/^[A-Za-z0-9 ._+-]{1,64}$/.test(n)) return cb(new Error('bad process name'));
  if (NEVER_RESTART.has(n.toLowerCase())) {
    return cb(new Error(`${n} is system-critical or hosts this tool; restart it from Windows, not from here`));
  }
  /* $ErrorActionPreference is left at Continue on purpose: a process that exits between the two
     lookups is a race, not a failure. The report says what actually happened either way. */
  const script = `
    $n='${n}'
    $ps=@(Get-Process -Name $n -ErrorAction SilentlyContinue)
    if(-not $ps.Count){ @{ok=$false;err='not running'} | ConvertTo-Json -Compress; exit }
    $path=$null
    foreach($p in $ps){ try{ if($p.Path){ $path=$p.Path; break } }catch{} }
    if(-not $path){ @{ok=$false;err='cannot resolve the image path (likely elevated or protected); relaunching a guess is worse than not relaunching'} | ConvertTo-Json -Compress; exit }
    $pids=@($ps | ForEach-Object { $_.Id })
    # graceful first - CloseMainWindow lets the app run its own save/exit path
    foreach($p in $ps){ try{ [void]$p.CloseMainWindow() }catch{} }
    Start-Sleep -Milliseconds 2500
    $left=@(Get-Process -Name $n -ErrorAction SilentlyContinue)
    $forced=0
    foreach($p in $left){ try{ Stop-Process -Id $p.Id -Force -ErrorAction Stop; $forced++ }catch{} }
    Start-Sleep -Milliseconds 900
    $relaunched=$false; $err=''
    try{ Start-Process -FilePath $path -ErrorAction Stop; $relaunched=$true }catch{ $err="$_" }
    @{ok=$relaunched; name=$n; path=$path; pids=$pids; closedGracefully=($pids.Count-$forced); forced=$forced; err=$err} |
      ConvertTo-Json -Compress -Depth 3`;
  ps(script, (e, d) => {
    if (e) return cb(e);
    if (!d || !d.ok) return cb(new Error((d && d.err) || 'restart failed'));
    cb(null, d);
  });
}

/* ---------------- support bundle (2026-07-29) ----------------
 * What a debugger plugging in cold would ask for, gathered in one place: the ledgers, the last two
 * days of per-minute rollups, the host log, and a manifest saying what machine and what versions
 * produced them. Compress-Archive because Node has no bundled zip and PowerShell is already here.
 * Deliberately NOT included: the MFT snapshots (2.4 MB each, and they are a full filesystem index of
 * the owner's drive - that is his to hand over on purpose, not by default). */
/* Redaction is a TEXT pass over the copied files, not a filter on the way in, so what ships is exactly
 * what was reviewed. Two levels, separated on purpose:
 *   identifiers - the Windows username (which is also embedded in every path), IPv4/IPv6 literals, MAC
 *                 addresses, and the machine name. Cheap to remove and nothing diagnostic is lost.
 *   procNames   - masking process names as well. OFF by default and labelled, because the process name
 *                 IS the diagnosis here ("claude is thrashing the pagefile" becomes "proc_a91f is").
 *                 A bundle nobody can read is not privacy, it is just a smaller file. */
/* Words that are also process names on Windows. Masking these across free prose would mangle the
 * sentences instead of protecting anything, so they are skipped and the manifest says so. */
const NAME_STOPLIST = new Set(['system', 'registry', 'idle', 'explorer', 'code', 'node', 'search',
  'host', 'client', 'service', 'services', 'runtime', 'setup', 'install', 'update', 'default',
  'memory compression', 'secure system', 'total']);

/* Process names appear in FREE PROSE, not only in structured fields - the journal writes sentences
 * like "Disk is congested and claude is the main cause". A first attempt only rewrote `name.exe` and
 * `"n":"..."`, so the manifest said MASKED while the prose still named the app: a label asserting
 * something the data does not do, which is worse than not offering the feature. So masking is now a
 * TWO-PASS operation - gather the real names first, then replace them as whole words everywhere. */
function collectNames(texts, liveProcs) {
  const names = new Set();
  const add = (n) => {
    if (!n) return;
    const c = String(n).replace(/\.exe$/i, '').trim();
    /* Under four characters the collision risk with ordinary words outweighs the benefit. */
    if (c.length < 4 || NAME_STOPLIST.has(c.toLowerCase())) return;
    names.add(c);
  };
  for (const p of liveProcs || []) add(p && p.n);
  for (const t of texts) {
    for (const m of t.matchAll(/"n":"([^"]{1,40})"/g)) add(m[1]);
    for (const m of t.matchAll(/"name":"([^"]{1,40})"/g)) add(m[1]);
    for (const m of t.matchAll(/\b([A-Za-z0-9_+-]{2,40})\.exe\b/g)) add(m[1]);
  }
  return [...names].sort((a, b) => b.length - a.length);   // longest first: "msedgewebview2" before "msedge"
}

function redactor(opts) {
  const user = process.env.USERNAME || '';
  const machine = process.env.COMPUTERNAME || '';
  const crypto = require('crypto');
  const tag = (n) => 'proc_' + crypto.createHash('sha1').update(n.toLowerCase()).digest('hex').slice(0, 6);
  const names = opts.procNames ? (opts.names || []) : [];
  const masked = new Map(names.map((n) => [n, tag(n)]));
  const fn = (txt) => {
    let t = txt;
    if (user) t = t.split(user).join('<user>');
    if (machine) t = t.split(machine).join('<machine>');
    t = t.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ipv4>')
         .replace(/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, '<ipv6>')
         .replace(/\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, '<mac>');
    for (const [n, m] of masked) {
      t = t.replace(new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'), m);
    }
    return t;
  };
  fn.maskedCount = masked.size;
  fn.skipped = 'names under 4 characters and common words (system, explorer, node, code, ...) are left alone: masking them would mangle prose without protecting anything';
  return fn;
}

const BUNDLE_SECTIONS = {
  ledgers:   { files: ['outcomes.jsonl', 'control.jsonl', 'selfcost.jsonl'], what: 'findings fired/cleared, dial pulls, cost measurements' },
  journal:   { days: true, prefix: 'journal-', what: 'the event journal (threshold crossings, churn, stream health)' },
  rollups:   { days: true, prefix: 'metrics-', what: 'per-minute min/avg/max of every metric' },
  hostlog:   { files: ['panel.log'], what: 'window host events: dock, autohide, theme, navigation' },
  extras:    { files: ['ctl-baseline.json', 'scan.log', 'iotrace.json'], what: 'bottled baseline, scan log, last io trace' },
  diagnosis: { manifestOnly: true, what: 'the current ranked findings, inside the manifest' },
};

/* Headroom a capture requires before it may write. Review's finding, and it is the right shape of
   guard: capture_on_critical triggers on disk_low and spiral, so the one moment it wants to run is
   the moment the machine can least afford a few hundred MB. */
const BUNDLE_MIN_FREE_GB = 3;
/* Per-process counter so two bundles in the same second cannot collide (see stamp, below). */
let BUNDLE_SEQ = 0;
/* HOW MANY BUNDLES THIS INSTALL KEEPS. Nothing pruned these before — they were created and never
   removed, which is fine while a human clicks the button occasionally and is not fine once an
   automation makes up to six a day forever on a disk this product reports as 99% full. The product
   maintaining its OWN artifacts is unconditional housekeeping, not something to ask permission for:
   there is no version of "keep every diagnostic zip ever made" that anybody wants. */
const BUNDLE_KEEP = 12;
function pruneBundles() {
  try {
    const zips = fs.readdirSync(HIST_DIR).filter((f) => /^bundle-.*\.zip$/.test(f))
      .map((f) => ({ f, t: (() => { try { return fs.statSync(path.join(HIST_DIR, f)).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => b.t - a.t);
    for (const z of zips.slice(BUNDLE_KEEP)) {
      try { fs.unlinkSync(path.join(HIST_DIR, z.f)); } catch {}
    }
    return zips.length - Math.min(zips.length, BUNDLE_KEEP);
  } catch { return 0; }
}

function buildBundle(opts, cb) {
  opts = opts || {};
  const sections = opts.sections && typeof opts.sections === 'object' ? opts.sections : null;
  const on = (k) => (sections ? !!sections[k] : true);          // no selection given = everything
  /* the redactor is built in PASS 2 below, once the real name set is known */
  /* THE STAMP MUST BE UNIQUE, not merely time-ordered. One-second resolution meant an automatic
     capture and a manual bundle click in the same second shared a staging directory AND an output
     path — so one run's Remove-Item deleted the other's staging tree mid-Compress-Archive. A
     counter costs nothing and removes the whole class. */
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + (++BUNDLE_SEQ);
  const outZip = path.join(HIST_DIR, `bundle-${stamp}${opts.redact ? '-redacted' : ''}.zip`);
  const staging = path.join(HIST_DIR, `.bundle-${stamp}`);
  const dropped = [];
  const manifest = {
    createdAt: new Date().toISOString(),
    tool: 'VITALS', bridgePid: process.pid, node: process.version, port: PORT,
    machine: opts.redact ? '<machine>' : ((latest && latest.host) || null),
    static: opts.redact ? '<redacted>' : (staticInfo || null),
    tickCadenceHz: hist.ring.length > 1 ? +(hist.ring.length / Math.max(hist.spanSec(), 1)).toFixed(2) : 0,
    historySpanSec: Math.round(hist.spanSec()),
    journal: journal.stats(),
    /* `opts.diagnosis` FIRST, and this is a correctness fix rather than an optimisation.
       currentDiagnosis() drives the automation loop, and one of the automations calls buildBundle —
       so a bundle that asks for a fresh diagnosis re-enters the loop that asked for the bundle.
       Review reproduced it: ONE 30-second tick produced 830 nested buildBundle calls, recursing
       until the stack blew, each level spawning Compress-Archive against the same staging dir while
       other levels deleted it, on the disk-pressure incident that triggered it. The daily ceiling
       could not stop it because a run is only recorded after its lever resolves, so every level saw
       an untouched ceiling.
       A caller that already HAS a diagnosis passes it. The automation lever does exactly that, so
       the cycle cannot form; the re-entrancy guard in automate.js is the second line, not the first.
       (Kept lazy for every other caller: the manual bundle button still wants a fresh one.) */
    diagnosis: on('diagnosis')
      ? (opts.diagnosis !== undefined ? opts.diagnosis
        : (() => { try { return currentDiagnosis(); } catch { return null; } })())
      : '<not included>',
    /* Stated so the recipient knows what they are NOT looking at, instead of inferring absence. */
    included: Object.keys(BUNDLE_SECTIONS).filter(on),
    omitted: Object.keys(BUNDLE_SECTIONS).filter((k) => !on(k)),
    redaction: opts.redact
      ? { identifiers: 'username, machine name, IPv4/IPv6, MAC removed', processNames: opts.redactProcNames ? 'MASKED - findings will name proc_xxxxxx instead of the real app' : 'kept (they are the diagnostic content)' }
      : 'none - this bundle contains your username, paths, and network addresses',
    excluded: ['mft-*.json (a full index of the filesystem - share deliberately, never by default)'],
  };
  try {
    fs.mkdirSync(staging, { recursive: true });
    const today = new Date(), yday = new Date(Date.now() - 86400_000);
    const dk = (d) => d.toISOString().slice(0, 10);
    const want = [];
    for (const [key, sec] of Object.entries(BUNDLE_SECTIONS)) {
      if (sec.manifestOnly) continue;
      if (!on(key)) { dropped.push(key); continue; }
      /* `.jsonl.gz` TOO. Rotation gzips a day file once it is no longer today's, so asking only for
         `<prefix>-<yday>.jsonl` asked for a name that reliably does not exist — and the missing-file
         path is a silent `continue`, so every bundle quietly shipped without yesterday. That is the
         one span an incident capture most needs: the before. Both names are requested and whichever
         exists is taken; asking for both is how a rotation boundary stops being a cliff. */
      if (sec.days) {
        want.push(`${sec.prefix}${dk(today)}.jsonl`, `${sec.prefix}${dk(today)}.jsonl.gz`,
                  `${sec.prefix}${dk(yday)}.jsonl`, `${sec.prefix}${dk(yday)}.jsonl.gz`);
      }
      else want.push(...sec.files);
    }
    /* PASS 1: read everything, so names can be gathered across all files before any is rewritten. */
    let bytesIn = 0;
    const loaded = [];
    for (const f of want) {
      const src = path.join(HIST_DIR, f);
      try {
        if (!fs.existsSync(src)) continue;
        /* A .gz IS NOT TEXT, and reading it as UTF-8 does not fail — it SUBSTITUTES. Every byte
           that is not valid UTF-8 becomes U+FFFD, so the real 283,801-byte rollup came back out at
           516,639 bytes and gunzip refused it: "incorrect header check". That arrived as part of a
           fix for bundles silently omitting yesterday, and it made the bug worse — a recipient who
           believes they have the "before" and is holding noise is worse off than one who can see
           the file is missing. Decompressed here so the content is real text from this point on:
           it can then be redacted like everything else, and it lands in the zip readable, which is
           what someone opening a support bundle actually wants. */
        if (f.endsWith('.gz')) {
          const name = f.replace(/\.gz$/, '');
          /* Both can exist across a rotation boundary. The plain file is the live one, so it wins;
             without this the archive would silently overwrite it under the same name in staging.
             `continue` BEFORE the stat, so a file that ships once is counted once. */
          if (loaded.some(([n]) => n === name)) continue;
          bytesIn += fs.statSync(src).size;
          loaded.push([name, require('zlib').gunzipSync(fs.readFileSync(src)).toString('utf8')]);
        } else {
          bytesIn += fs.statSync(src).size;
          loaded.push([f, fs.readFileSync(src, 'utf8')]);
        }
      } catch (e) {
        /* A CORRUPT ARCHIVE IS NOT AN ABSENT ONE. gunzip throwing here used to land in a bare
           `catch {}`, which reinstated the exact silent omission this whole change set out to fix —
           for the one case where the reader most needs telling, because a truncated .gz is what a
           crash mid-rotation leaves behind. Recorded so the manifest says the file was meant to be
           here and could not be read, rather than the bundle simply not containing it. */
        dropped.push(`${f} — unreadable: ${e.message}`);
      }
    }
    /* TWO NUMBERS, BECAUSE ONE OF THEM STOPPED MEANING WHAT IT SAID. `sourceBytes` counts bytes
       READ FROM DISK, and once a day file may arrive gzipped that is no longer the size of what
       ships: measured on the reference machine, 411,510 read became 1,403,543 staged — a 3.4×
       divergence under a name that reads like "how big is this bundle". Rather than redefine the
       field (someone's script may already read it) both are stated, each labelled. */
    manifest.sourceBytes = bytesIn;
    manifest.sourceBytesNote = 'bytes read from disk; a rotated day file is counted COMPRESSED, so '
      + 'this is smaller than the content shipped whenever a .gz was expanded';
    manifest.stagedBytes = loaded.reduce((n, [, t]) => n + Buffer.byteLength(t, 'utf8'), 0);
    manifest.decompressed = want.filter((f) => f.endsWith('.gz')
      && loaded.some(([n]) => n === f.replace(/\.gz$/, '')));
    /* `dropped` WAS A DEAD ARRAY. It has been pushed to since this function was written and read
       by nothing, so every section the caller deselected — and, once the load loop could fail, every
       file that could not be read — was recorded and then discarded. Surfaced now, which is the
       whole point of the array: a recipient who can see WHY something is absent is in a different
       position from one staring at a bundle that simply does not contain it. */
    manifest.dropped = dropped;
    /* PASS 2: build the redactor with the real name set, then write.
       The name set must NOT depend on the live tick. The first version harvested from `latest.proc`,
       which is null for the first few seconds after a bridge restart, so a bundle taken in that window
       reported "MASKED" having masked nothing - silent degradation, which is the worst possible failure
       mode for a privacy control. Get-Process is authoritative and always answers, so it leads;
       the tick and the file contents only add to it. execFileSync deliberately: this is an explicit
       user action, ~300 ms of blocking is cheaper than restructuring the write path around a callback,
       and it cannot interleave with a second bundle request. */
    let rd = null;
    if (opts.redact) {
      let names = [];
      if (opts.redactProcNames) {
        let live = [];
        try {
          const out = require('child_process').execFileSync(PS,
            [...PS_ARGS, '-Command', '@(Get-Process | Select-Object -ExpandProperty ProcessName -Unique) | ConvertTo-Json -Compress'],
            { timeout: 15000, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
          const arr = JSON.parse(out || '[]');
          live = (Array.isArray(arr) ? arr : [arr]).filter(Boolean).map((n) => ({ n }));
        } catch {}
        names = collectNames(loaded.map(([, t]) => t), [...live, ...((latest && latest.proc) || [])]);
      }
      rd = redactor({ procNames: !!opts.redactProcNames, names });
      if (opts.redactProcNames) {
        /* If nothing could be resolved, SAY the bundle is effectively unmasked rather than let the
           label imply protection that is not there. */
        manifest.redaction.processNames = rd.maskedCount
          ? `MASKED - ${rd.maskedCount} name(s) replaced with proc_xxxxxx everywhere, including inside prose. ${rd.skipped}`
          : 'REQUESTED BUT NOTHING WAS MASKED - no process names could be resolved, so treat this bundle as UNMASKED';
      }
    }
    for (const [f, txt] of loaded) {
      try { fs.writeFileSync(path.join(staging, f), rd ? rd(txt) : txt); } catch {}
    }
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(staging, 'README.txt'),
      `VITALS support bundle\n${manifest.createdAt}\n\n` +
      Object.entries(BUNDLE_SECTIONS).map(([k, v]) => `${on(k) ? '[x]' : '[ ]'} ${k}: ${v.what}`).join('\n') +
      `\n\nRedaction: ${typeof manifest.redaction === 'string' ? manifest.redaction : JSON.stringify(manifest.redaction)}\n` +
      `Excluded always: ${manifest.excluded.join('; ')}\n`);
  } catch (e) { return cb(e); }
  const q = (s) => s.replace(/'/g, "''");
  ps(`Compress-Archive -Path '${q(staging)}\\*' -DestinationPath '${q(outZip)}' -Force
      Remove-Item -LiteralPath '${q(staging)}' -Recurse -Force -ErrorAction SilentlyContinue
      $i=Get-Item -LiteralPath '${q(outZip)}'
      @{ok=$true;path=$i.FullName;kb=[math]::Round($i.Length/1KB,1)} | ConvertTo-Json -Compress`,
    (e, d) => {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
      if (e) return cb(e);
      /* Pruned AFTER a successful write, not before: trimming first would delete old evidence to
         make room for a bundle that then fails, which is the worst possible order. */
      const pruned = pruneBundles();
      cb(null, { ...d, manifest, pruned });
    });
}

/* ---------------- speed test (2026-07-29) ----------------
 * EXPLICIT-ONLY, never automatic, one at a time. It spends the user's bandwidth (~33 MB per run,
 * printed on the button before the press) — metered connections exist, so nothing here fires
 * without a click. Endpoint: Cloudflare's public speed service. This is the ONE deliberate
 * exception to "nothing leaves the box", and it exists because the owner asked for internet
 * speed; the honest form is opt-in with the price on the label. */
let speedBusy = false;
function speedTest(cb) {
  if (speedBusy) return cb(new Error('a speed test is already running'));
  speedBusy = true;
  const done = (e, d) => { speedBusy = false; cb(e, d); };
  const DOWN = 25 * 1024 * 1024, UP = 8 * 1024 * 1024;
  const t0 = Date.now(); let bytes = 0, ttfb = 0;
  const req = https.get(`https://speed.cloudflare.com/__down?bytes=${DOWN}`, { timeout: 20000 }, (res) => {
    res.on('data', (c) => { if (!bytes) ttfb = Date.now() - t0; bytes += c.length; });
    res.on('end', () => {
      const downSec = Math.max(0.05, (Date.now() - t0 - ttfb) / 1000);
      const out = {
        downMbps: +((bytes * 8 / 1e6) / downSec).toFixed(1),
        ttfbMs: ttfb, downMB: +(bytes / 1048576).toFixed(1),
        server: 'speed.cloudflare.com',
      };
      const buf = Buffer.alloc(UP, 65);
      const u0 = Date.now();
      const ur = https.request({
        host: 'speed.cloudflare.com', path: '/__up', method: 'POST',
        headers: { 'Content-Length': buf.length, 'Content-Type': 'application/octet-stream' }, timeout: 25000,
      }, (ures) => {
        ures.resume();
        ures.on('end', () => {
          const upSec = Math.max(0.05, (Date.now() - u0) / 1000);
          out.upMbps = +((UP * 8 / 1e6) / upSec).toFixed(1);
          out.upMB = +(UP / 1048576).toFixed(1);
          done(null, out);
        });
      });
      ur.on('error', (e) => { out.upErr = e.message; done(null, out); });
      ur.on('timeout', () => ur.destroy(new Error('upload timeout')));
      ur.end(buf);
    });
  });
  req.on('error', (e) => done(e));
  req.on('timeout', () => req.destroy(new Error('download timeout')));
}

/* ---------------- battery report (2026-07-29) ----------------
 * powercfg /batteryreport /xml — ~2 s, on-demand only. The report holds the one thing live
 * telemetry cannot: the capacity-decline HISTORY (weekly FullChargeCapacity vs DesignCapacity
 * back to first boot — 266 weeks deep on this machine). Parsed with regex on attributes; the
 * schema is flat self-closed elements, no XML library needed. */
function battReport(cb) {
  const xmlPath = path.join(HIST_DIR, 'batteryreport.xml');
  execFile(PS, [...PS_ARGS, '-Command',
    `powercfg /batteryreport /xml /output '${xmlPath.replace(/'/g, "''")}' | Out-Null; if(Test-Path '${xmlPath.replace(/'/g, "''")}'){'ok'}else{'fail'}`],
    { windowsHide: true }, (err) => {
      if (err) return cb(err);
      let xml;
      try { xml = fs.readFileSync(xmlPath, 'utf8'); } catch (e) { return cb(e); }
      const attrs = (tag) => {
        const out = [];
        const re = new RegExp(`<${tag}\\b([^>]*?)/>`, 'gs');
        let m;
        while ((m = re.exec(xml))) {
          const o = {};
          for (const am of m[1].matchAll(/([A-Za-z]+)="([^"]*)"/g)) o[am[1]] = am[2];
          out.push(o);
        }
        return out;
      };
      const hist = attrs('HistoryEntry').map((h) => ({
        d: (h.LocalStartDate || h.StartDate || '').slice(0, 10),
        full: +h.FullChargeCapacity || 0,
        design: +h.DesignCapacity || 0,
        cycles: +h.CycleCount || 0,
      })).filter((h) => h.full > 0);
      // downsample to <=48 points, always keeping first and last
      const step = Math.max(1, Math.ceil(hist.length / 48));
      const ds = hist.filter((_, i) => i % step === 0);
      if (hist.length && ds[ds.length - 1] !== hist[hist.length - 1]) ds.push(hist[hist.length - 1]);
      const usage = attrs('UsageEntry').map((u) => ({
        t: u.LocalTimestamp || u.Timestamp, type: u.EntryType,
        ac: u.Ac === '1', cap: +u.ChargeCapacity || 0, drain: +u.Discharge || 0,
      })).slice(-16);
      cb(null, { history: ds, weeks: hist.length, usage });
    });
}

/* Reclaim targets. Sizing these is genuinely slow — recursively walking C:\$Recycle.Bin and the
 * update cache is a multi-minute file-by-file traversal — so they are sized ONE AT A TIME via
 * /api/reclaim?key=, and the UI fills each row as its answer lands. A single blocking call that
 * returns everything at once leaves the page on a spinner long enough to look hung. */
const TARGETS = [
  { key:'usertemp', name:'User temp',            ps:`$env:TEMP`,                                        tier:1, safe:true  },
  { key:'wintemp',  name:'Windows temp',         ps:`'C:\\Windows\\Temp'`,                              tier:1, safe:true  },
  { key:'winupdate',name:'Windows Update cache', ps:`'C:\\Windows\\SoftwareDistribution\\Download'`,    tier:1, safe:true  },
  { key:'winre',    name:'Update staging',       ps:`'C:\\$WinREAgent'`,                                tier:1, safe:true  },
  { key:'ctmp',     name:'Stray C:\\tmp',        ps:`'C:\\tmp'`,                                        tier:1, safe:true  },
  { key:'recycle',  name:'Recycle Bin',          ps:`'C:\\$Recycle.Bin'`,                               tier:2, safe:false },
  { key:'hiber',    name:'hiberfil.sys',         ps:`'C:\\hiberfil.sys'`,                               tier:2, safe:false },
  { key:'page',     name:'pagefile.sys',         ps:`'C:\\pagefile.sys'`,                               tier:2, safe:false },
];

const SCRIPTS = {
  /* B13/B14/B15, as a file rather than an inline string: it is long, it has real comments about
     what each section may and may not claim, and those comments are the load-bearing part. */
  hardware: `& '${HERE.replace(/'/g, "''")}\\hardware.ps1'`,
  // NOTE the deliberate absence of a Test-Path guard. pagefile.sys and hiberfil.sys are ACL'd to
  // SYSTEM, so BOTH Test-Path and Get-Item fail on them (verified: Test-Path returns False on a
  // 6.28 GB hiberfil.sys) — they need permission on the file itself. Enumerating the PARENT
  // directory needs only list permission, and NTFS serves the size straight from the directory
  // entry without opening the file. So: try the direct read, then fall back to the parent listing.
  sizeOne: (t) => `
    $p=${t.ps}
    $b=0
    $i=Get-Item -LiteralPath $p -Force -EA SilentlyContinue
    if(-not $i){
      $par=Split-Path -Parent $p; $leaf=Split-Path -Leaf $p
      if($par){ $i=Get-ChildItem -LiteralPath $par -Force -File -EA SilentlyContinue | Where-Object { $_.Name -eq $leaf } | Select-Object -First 1 }
    }
    if($i -and $i.PSIsContainer){
      $b=(Get-ChildItem -LiteralPath $p -Recurse -File -Force -EA SilentlyContinue | Measure-Object Length -Sum).Sum
    } elseif($i){ $b=$i.Length }
    if(-not $b){$b=0}
    @{ key='${t.key}'; gb=[math]::Round($b/1GB,2); path=$p } | ConvertTo-Json -Compress`,

  // Every non-Microsoft autostart, across all five hiding places (see playbook 3.1).
  startup: `
    $o=@()
    foreach($k in @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run')){
      if(Test-Path $k){
        (Get-ItemProperty $k).PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' -and $_.Name -ne '(default)' } | ForEach-Object {
          $cmd=[string]$_.Value
          $sus = $cmd -match '\\\\Temp\\\\|\\\\Downloads\\\\|\\\\Public\\\\'
          $o+=@{kind='run'; where=(($k -split ':')[0]); name=$_.Name; cmd=$cmd; state='enabled'; suspect=$sus}
        }
      }
    }
    foreach($f in @("$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup","C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup")){
      if(Test-Path $f){ Get-ChildItem $f -Force -EA SilentlyContinue | Where-Object { $_.Name -ne 'desktop.ini' } | ForEach-Object {
        $o+=@{kind='folder'; where='StartupFolder'; name=$_.Name; cmd=$_.FullName; state='enabled'; suspect=$false} } }
    }
    Get-ScheduledTask | Where-Object { $_.TaskPath -notmatch '^\\\\Microsoft\\\\' } | ForEach-Object {
      $o+=@{kind='task'; where=$_.TaskPath; name=$_.TaskName; cmd=''; state=$(if($_.State -eq 'Disabled'){'disabled'}else{'enabled'}); suspect=$false}
    }
    Get-CimInstance Win32_Service -Filter "StartMode='Auto'" | Where-Object { $_.PathName -notmatch 'Windows\\\\System32|Windows\\\\SysWOW64' } | ForEach-Object {
      $o+=@{kind='service'; where='Service'; name=$_.Name; cmd=$_.DisplayName; state=$(if($_.State -eq 'Running'){'enabled'}else{'stopped'}); suspect=$false}
    }
    $o | ConvertTo-Json -Compress -Depth 4`,

  /* Full process list, grouped by name — ON DEMAND only. The 1 Hz tick deliberately carries just
   * the top 16 (metrics.ps1 caps it to keep the streaming payload cheap); this one-shot serves the
   * "show all" expansion and runs only when the user asks.
   *
   * DEFINITIONS MUST MATCH metrics.ps1 EXACTLY or the expanded list contradicts the live table
   * (first version used Get-Process/WorkingSet64 — shared pages inflated node by 4 GB and
   * reshuffled the top rows; owner caught it immediately). Matching means:
   *   - the same bulk PerformanceCounterCategory('Process').ReadCategory() source,
   *   - memory = 'Working Set - Private' (NOT WorkingSet64),
   *   - name-grouped with the '#N' instance suffix stripped,
   *   - CPU% = delta of the cumulative '% Processor Time' raw counter between TWO samples
   *     (~900 ms apart) / wall time / logical threads — Task Manager's formula, like the tick,
   *   - same rounding, same mb-descending sort.
   * Also carries per-instance {pid, mb} (capped 40, same as the tick's pid cap) for drill-down. */
  processes: `
    $logical=[Environment]::ProcessorCount
    $cat=New-Object System.Diagnostics.PerformanceCounterCategory('Process')
    $a=$cat.ReadCategory()
    $t0=[DateTime]::UtcNow
    Start-Sleep -Milliseconds 900
    $b=$cat.ReadCategory()
    $elapsed=([DateTime]::UtcNow - $t0).TotalSeconds
    $idc=$b['ID Process']; $wsc=$b['Working Set - Private']
    $cpub=$b['% Processor Time']; $cpua=$a['% Processor Time']
    # IO too (2026-07-29): the snapshot now carries read/write rates as well as cpu and memory, so ONE
    # endpoint can back "Show all" on the cpu, memory AND network pages. These are cumulative byte
    # totals, so they need the same two-sample difference the cpu figure already does - reading a raw
    # value as a rate is how you get numbers in the billions. Same category read, no extra cost.
    $rdb=$b['IO Read Bytes/sec']; $rda=$a['IO Read Bytes/sec']
    $wrb=$b['IO Write Bytes/sec']; $wra=$a['IO Write Bytes/sec']
    $agg=@{}
    foreach($i in $idc.Keys){
      if($i -eq '_Total' -or $i -eq 'Idle'){continue}
      $p=[int]$idc[$i].RawValue
      if($p -le 0){continue}
      $name=$i -replace '#\\d+$',''
      $d=0.0
      if($cpua.Contains($i)){ $d=[double]$cpub[$i].RawValue-[double]$cpua[$i].RawValue }
      if($d -lt 0){$d=0}
      $rd=0.0; if($rdb -and $rda -and $rda.Contains($i)){ $rd=[double]$rdb[$i].RawValue-[double]$rda[$i].RawValue }
      $wr=0.0; if($wrb -and $wra -and $wra.Contains($i)){ $wr=[double]$wrb[$i].RawValue-[double]$wra[$i].RawValue }
      if($rd -lt 0){$rd=0}; if($wr -lt 0){$wr=0}
      $wmb=[double]$wsc[$i].RawValue/1MB
      if(-not $agg.ContainsKey($name)){ $agg[$name]=@{n=$name;mb=0.0;c=0.0;r=0.0;w=0.0;count=0;pids=@();inst=@()} }
      $agg[$name].mb+=$wmb
      $agg[$name].c+=$d
      $agg[$name].r+=$rd
      $agg[$name].w+=$wr
      $agg[$name].count+=1
      if($agg[$name].pids.Count -lt 40){ $agg[$name].pids+=$p; $agg[$name].inst+=@{pid=$p;mb=[math]::Round($wmb,0)} }
    }
    $out=$agg.Values | ForEach-Object {
      @{ n=$_.n; mb=[math]::Round($_.mb,0)
         cpu=[math]::Round((($_.c/1e7)/$elapsed/$logical)*100,1)
         rMBs=[math]::Round(($_.r/1MB)/$elapsed,2)
         wMBs=[math]::Round(($_.w/1MB)/$elapsed,2)
         count=$_.count; pids=$_.pids; inst=$_.inst }
    } | Sort-Object { $_.mb } -Descending
    ,$out | ConvertTo-Json -Compress -Depth 5`,

  /* Maintenance signals (2026-07-29): the evidence behind the remedy-shaped findings - is a restart
   * genuinely pending, how long has it been up, what is sitting in the bin, is this SSD or spinning
   * rust, and has Windows' own weekly optimization stopped running. All unelevated, all read-only,
   * refreshed every 10 minutes because none of it changes second to second.
   * The four reboot flags are reported SEPARATELY rather than OR-ed into a boolean, because two of
   * them are present benignly on healthy machines and diagnose.js must be able to tell strong from
   * weak. Measured on this box: Services\\Pending set, both strong flags clear, no restart pending. */
  maint: `
    $rp=[ordered]@{}
    $rp.wuau   = Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'
    $rp.cbs    = Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending'
    $rp.wupend = Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Services\\Pending'
    try{ $v=(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager' -Name PendingFileRenameOperations -ErrorAction Stop).PendingFileRenameOperations
         $rp.fileRename = ($v -ne $null -and @($v).Count -gt 0) }catch{ $rp.fileRename=$false }
    $o=[ordered]@{}
    $o.reboot=$rp
    $os=Get-CimInstance Win32_OperatingSystem
    $o.uptimeH=[math]::Round(((Get-Date)-$os.LastBootUpTime).TotalHours,1)
    try{ $sh=New-Object -ComObject Shell.Application
         $sum=0.0; $n=0
         foreach($i in $sh.Namespace(0xA).Items()){ $sum+=[double]$i.ExtendedProperty('Size'); $n++ }
         $o.recycleGB=[math]::Round($sum/1GB,2); $o.recycleItems=$n }catch{ $o.recycleGB=$null; $o.recycleItems=$null }
    try{ $pd=Get-PhysicalDisk -ErrorAction Stop | Select-Object -First 1 MediaType,FriendlyName
         $o.mediaType=[string]$pd.MediaType; $o.disk=[string]$pd.FriendlyName }catch{ $o.mediaType='unknown'; $o.disk=$null }
    try{ $t=Get-ScheduledTask -TaskName 'ScheduledDefrag' -ErrorAction Stop | Get-ScheduledTaskInfo
         if($t.LastRunTime){ $o.lastOptimize=$t.LastRunTime.ToString('s')
                             $o.optimizeDaysAgo=[math]::Round(((Get-Date)-$t.LastRunTime).TotalDays,1) }
         else { $o.lastOptimize=$null; $o.optimizeDaysAgo=$null }
         $o.optimizeResult=$t.LastTaskResult }catch{ $o.lastOptimize=$null; $o.optimizeDaysAgo=$null; $o.optimizeResult=$null }
    $o | ConvertTo-Json -Depth 4 -Compress`,

  /* SYS console socket snapshot (2026-07-29): Get-NetTCPConnection joined to process names.
   * Unelevated on purpose (like everything long-lived here); needs no admin for the states we
   * show. A SNAPSHOT, refreshed on demand — polling netstat at 1 Hz would be cost with no story. */
  conns: `
    $names=@{}; Get-Process | ForEach-Object { $names[[int]$_.Id]=$_.ProcessName }
    $rows=Get-NetTCPConnection -ErrorAction SilentlyContinue |
      Where-Object { $_.State -in 'Listen','Established','TimeWait','CloseWait','SynSent' } |
      ForEach-Object {
        @{ l=('{0}:{1}' -f $_.LocalAddress,$_.LocalPort)
           r=('{0}:{1}' -f $_.RemoteAddress,$_.RemotePort)
           st=[string]$_.State; pid=[int]$_.OwningProcess
           pn=$names[[int]$_.OwningProcess] } }
    ,@($rows) | ConvertTo-Json -Compress -Depth 3`,

  /* NET page adapter truth (2026-07-29). All local reads — nothing leaves the box. On-demand
   * because Get-NetAdapter costs ~1 s cold (measured); polling it at 1 Hz would be pure waste
   * for numbers that change on the order of hours. */
  netinfo: `
    $out=@{}
    $ads=@(Get-NetAdapter -Physical -ErrorAction SilentlyContinue | ForEach-Object {
      @{ name=$_.Name; desc=$_.InterfaceDescription; status=[string]$_.Status; link=[string]$_.LinkSpeed; mac=[string]$_.MacAddress; idx=[int]$_.ifIndex } })
    $out.adapters=$ads
    $up = $ads | Where-Object { $_.status -eq 'Up' } | Select-Object -First 1
    if($up){
      $cfg = Get-NetIPConfiguration -InterfaceIndex $up.idx -ErrorAction SilentlyContinue
      if($cfg){
        $out.ip = @($cfg.IPv4Address | ForEach-Object { $_.IPAddress }) -join ', '
        if($cfg.IPv4DefaultGateway){ $out.gw = @($cfg.IPv4DefaultGateway)[0].NextHop }
      }
      $dns = Get-DnsClientServerAddress -InterfaceIndex $up.idx -AddressFamily IPv4 -ErrorAction SilentlyContinue
      if($dns){ $out.dns = @($dns.ServerAddresses) }
      $st = Get-NetAdapterStatistics -Name $up.name -ErrorAction SilentlyContinue
      if($st){ $out.rxGB=[math]::Round($st.ReceivedBytes/1GB,2); $out.txGB=[math]::Round($st.SentBytes/1GB,2) }
    }
    $w = netsh wlan show interfaces 2>$null
    if($w -and (($w -join ' ') -match 'SSID')){
      function GetLine($re){ $m = $w | Select-String $re | Select-Object -First 1
        if($m -and $m.Line -match ':\\s*(.+)$'){ return $matches[1].Trim() }; return $null }
      $out.wifi=@{ ssid=(GetLine '^\\s*SSID'); band=(GetLine '^\\s*Band'); chan=(GetLine '^\\s*Channel')
                   radio=(GetLine 'Radio type'); signal=(GetLine '^\\s*Signal')
                   rx=(GetLine 'Receive rate'); tx=(GetLine 'Transmit rate'); auth=(GetLine 'Authentication') }
    }
    $out.estab = @(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue).Count
    $out | ConvertTo-Json -Compress -Depth 5`,

  /* Latency test — EXPLICIT button only, never automatic. Sends ~12 ICMP echoes + 1 DNS query
   * (~1 KB total). The page prints that cost on the button before the user presses it. */
  nettest: `
    $p=New-Object System.Net.NetworkInformation.Ping
    function PingN($target,$n){
      $times=@(); $lost=0
      for($i=0;$i -lt $n;$i++){ try{ $r=$p.Send($target,1500); if($r.Status -eq 'Success'){ $times+=[int]$r.RoundtripTime } else { $lost++ } }catch{ $lost++ } }
      if($times.Count){ @{ min=($times|Measure-Object -Minimum).Minimum; avg=[math]::Round(($times|Measure-Object -Average).Average,1); max=($times|Measure-Object -Maximum).Maximum; loss=$lost; n=$n } }
      else { @{ loss=$lost; n=$n } }
    }
    $gwc = Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1
    $out=@{}
    if($gwc){ $gw=@($gwc.IPv4DefaultGateway)[0].NextHop; $out.gwip=$gw; $out.gw = PingN $gw 4 }
    $out.inet = PingN '1.1.1.1' 4
    $dsw=[System.Diagnostics.Stopwatch]::StartNew()
    try{ $null=Resolve-DnsName 'example.com' -DnsOnly -ErrorAction Stop; $dsw.Stop(); $out.dnsMs=[int]$dsw.ElapsedMilliseconds }catch{ $out.dnsMs=$null }
    $out | ConvertTo-Json -Compress -Depth 4`,

  /* Recursive bisection, one level down from a given root (playbook 2.1).
   *
   * Uses an explicit stack over [System.IO.Directory]::EnumerateDirectories/Files rather than
   * Get-ChildItem -Recurse. GCI constructs a full PSObject per file with an ETS property bag;
   * across a 259 GB tree that overhead dominates and turns a seconds-long walk into minutes.
   *
   * TWO things this MUST get right, both of which GCI handles for you and raw .NET does not:
   *   1. Reparse points are skipped. C:\Users\<u>\AppData\Local\Application Data is a junction
   *      pointing at its own parent — following it recurses forever.
   *   2. Every enumeration is individually try/caught. .NET Framework 4.x has no
   *      IgnoreInaccessible option (that arrived in .NET Core 3.0), so ONE protected directory
   *      anywhere in the tree aborts the entire walk with an exception.                        */
  bigdirs: (root) => `
    $r='${root.replace(/'/g, "''")}'
    if(-not (Test-Path -LiteralPath $r)){ '[]'; exit }
    $RP=[System.IO.FileAttributes]::ReparsePoint
    function Get-TreeSize([string]$start){
      $total=0
      $stack=New-Object System.Collections.Generic.Stack[string]
      $stack.Push($start)
      while($stack.Count -gt 0){
        $d=$stack.Pop()
        # DirectoryInfo.EnumerateFiles() yields FileInfo objects whose Length is already populated
        # from the directory entry the OS returned. Directory.EnumerateFiles() yields bare strings,
        # and casting each one back to [FileInfo] costs an extra stat syscall PER FILE.
        try{ foreach($f in ([System.IO.DirectoryInfo]$d).EnumerateFiles()){ $total += $f.Length } }catch{}
        try{ foreach($s in ([System.IO.DirectoryInfo]$d).EnumerateDirectories()){
               if(($s.Attributes -band $RP) -ne $RP){ $stack.Push($s.FullName) } } }catch{}
      }
      $total
    }
    $o=@()
    try{
      foreach($d in ([System.IO.DirectoryInfo]$r).EnumerateDirectories()){
        $o += @{ name=$d.Name; full=$d.FullName; gb=[math]::Round((Get-TreeSize $d.FullName)/1GB,2) }
      }
    }catch{}
    $lf=0
    try{ foreach($f in ([System.IO.DirectoryInfo]$r).EnumerateFiles()){ $lf += $f.Length } }catch{}
    if($lf -gt 0){ $o += @{ name='(loose files here)'; full=''; gb=[math]::Round($lf/1GB,2) } }
    if($o.Count -eq 0){ '[]'; exit }
    $o | Sort-Object { $_.gb } -Descending | Select-Object -First 18 | ConvertTo-Json -Compress -Depth 4`,
};

/* ---------------- actions ----------------
 * Deliberately NOT implemented: emptying the Recycle Bin. That permanently destroys user data and
 * belongs behind Explorer's own confirmation, not a button on a dashboard. The UI links out instead.
 */

function killProcess(pids, cb) {
  /* Off Windows: SIGTERM then SIGKILL via actions-posix, with denials counted. Same route
     contract; the PowerShell path below stays the Windows reference implementation. */
  if (!PS_HOST) return posixActs.kill(pids, cb);
  const list = pids.filter((p) => Number.isInteger(p) && p > 4).join(',');   // never PID 0-4 (System)
  if (!list) return cb(new Error('no valid pids'));
  execFile(PS, [...PS_ARGS, '-Command',
    `Stop-Process -Id ${list} -Force -EA SilentlyContinue; @{ok=$true} | ConvertTo-Json -Compress`],
    { windowsHide: true }, (e, out) => cb(e, out));
}

/* `elevate` marks the targets an UNELEVATED bridge physically cannot touch (2026-07-30).
 * The bug this closes: the owner clicked clear on the update cache, the ledger recorded
 * "freedGB: -0.02", and the UI reported success. The bridge is deliberately not elevated - it can end
 * processes, so a long-lived admin server is a liability - so every delete under C:\Windows was
 * access-denied, and the old implementation hard-coded ok=$true with -EA SilentlyContinue swallowing
 * each denial. Elevated targets now go through clean-admin.ps1 as a UAC one-shot, the same split
 * mftscan.ps1 uses, and the result reports what was actually deleted AND what was denied. */
const CLEANABLE = {
  usertemp:  { ps: `$env:TEMP`,                                     elevate: false },
  ctmp:      { ps: `'C:\\tmp'`,                                     elevate: false },
  wintemp:   { admin: 'wintemp',                                    elevate: true },
  winupdate: { admin: 'winupdate',                                  elevate: true },
  winre:     { admin: 'winre',                                      elevate: true },
  thumbs:    { admin: 'thumbs',                                     elevate: true },
};

function clean(key, cb) {
  /* Off Windows: the Node sweep in actions-posix (same fixed-table, count-the-denials contract);
     elevated targets go through clean-admin.js behind macOS's own administrator prompt. */
  if (!PS_HOST) return posixActs.clean(key, cb);
  const t = CLEANABLE[key];
  if (!t) return cb(new Error('not a cleanable target'));
  if (t.elevate) return cleanElevated(t.admin, cb);
  /* Unelevated path, now honest: every failure is COUNTED instead of silenced, and ok reflects whether
     anything actually moved. A target that frees nothing and hits denials reports needsAdmin so the UI
     can offer the elevated route instead of claiming it worked. */
  /* LOCKED and DENIED are different facts and must not be summed into one "it failed". A first pass
     counted both as `denied` and inferred needsAdmin from "freed nothing + something refused", which
     labelled %TEMP% as needing admin when the truth was 17 files held open by running apps - a user
     path can never need admin, since it is the user's own. UnauthorizedAccessException is the only
     thing that means permissions; everything else is a lock, and a lock is expected and harmless. */
  ps(`$p=${t.ps}
      $before=(Get-ChildItem -LiteralPath $p -Recurse -File -Force -EA SilentlyContinue | Measure-Object Length -Sum).Sum
      $locked=0; $denied=0; $deleted=0
      foreach($i in (Get-ChildItem -LiteralPath $p -Force -EA SilentlyContinue)){
        try{ Remove-Item -LiteralPath $i.FullName -Recurse -Force -EA Stop; $deleted++ }
        catch{ if($_.Exception -is [UnauthorizedAccessException]){ $denied++ } else { $locked++ } }
      }
      $after=(Get-ChildItem -LiteralPath $p -Recurse -File -Force -EA SilentlyContinue | Measure-Object Length -Sum).Sum
      $freed=[math]::Round((($before-$after)/1GB),2)
      @{ ok=($freed -gt 0 -or ($denied -eq 0 -and $locked -eq 0)); freedGB=$freed; leftGB=[math]::Round(($after/1GB),2)
         entriesDeleted=$deleted; entriesDenied=$denied; entriesLocked=$locked
         needsAdmin=($denied -gt 0) } | ConvertTo-Json -Compress`, cb);
}

/* UAC one-shot. Waits for the result file the script writes rather than parsing stdout, because an
   elevated Start-Process is a different session with no pipe back to here. */
function cleanElevated(target, cb) {
  const out = path.join(HIST_DIR, `clean-${Date.now()}.json`);
  const script = path.join(HERE, 'clean-admin.ps1');
  const q = (s) => s.replace(/'/g, "''");
  try { fs.existsSync(out) && fs.unlinkSync(out); } catch {}
  ps(`Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${q(script)}','-Targets','${q(target)}','-Out','${q(out)}')
      @{started=$true} | ConvertTo-Json -Compress`, (e) => {
    if (e) return cb(new Error('could not raise the UAC prompt: ' + e.message));
    let waited = 0;
    const poll = setInterval(() => {
      waited += 700;
      let d = null;
      try { if (fs.existsSync(out)) d = readJsonFile(out); } catch {}
      if (d) {
        clearInterval(poll);
        try { fs.unlinkSync(out); } catch {}
        const r = (d.results || [])[0] || {};
        return cb(null, { ok: !!r.ok, freedGB: r.freedGB || 0, leftGB: r.leftGB || 0,
          entriesDeleted: r.entriesDeleted || 0, entriesDenied: r.entriesDenied || 0,
          elevated: !!d.elevated, freeGBAfter: d.freeGBAfter, servicesStopped: r.servicesStopped || [] });
      }
      if (waited > 180000) {
        clearInterval(poll);
        /* No result file means the prompt was declined or the run died. Either way: say so. */
        cb(new Error('no result after 3 minutes - the UAC prompt was probably declined, so nothing was deleted'));
      }
    }, 700);
  });
}

function toggleTask(name, enable, cb) {
  const verb = enable ? 'Enable-ScheduledTask' : 'Disable-ScheduledTask';
  ps(`try { ${verb} -TaskName '${name.replace(/'/g, "''")}' -EA Stop | Out-Null; @{ok=$true} | ConvertTo-Json -Compress }
      catch { @{ok=$false; err=$_.Exception.Message} | ConvertTo-Json -Compress }`, cb);
}

/* ---------------- diagnosis + outcomes loop ----------------
 * One diagnosis path for everything: the /api/diagnose route, and a 30 s server-side loop so the
 * outcomes ledger records fired/cleared transitions even when no page exists to ask. Growth is
 * refreshed at most every 10 min — it is file I/O over MFT snapshots that change only when the
 * user scans, so per-call recomputation was cost with no new information. */
let cachedGrowth = null;
/* B3 (2026-07-31): the disk-free trend for the predictive rule. Cached on the same 10 min clock
 * as growth and for the same reason - it is file I/O over the rollup day-files, and free space
 * does not develop a new multi-day trend between two 30 s diagnosis passes. */
let cachedTrend = null;
let cachedWl = [];
/* B13/B14/B15. Drive health, interrupt share and NPU on a slow clock: none of them can change
   second to second, and two of the three are process spawns. Ten minutes, like the other
   derived signals. */
let cachedHw = null;
/* B8. Every periodic job now goes through ONE scheduler instead of an inline `Date.now() - xAt >
   600000` check inside the diagnosis. Two things change and both matter:

   - They no longer all fire on the same ten-minute boundary. The old checks were evaluated
     together, on the same 30 s pass, with the same period - so the growth read, the trend fit, the
     hardware one-shot and the maintenance probes stacked into one spike of work, every ten minutes,
     forever. Stratified placement spreads them across the window with a guaranteed gap.
   - They no longer depend on the diagnosis running. An inline check inside currentDiagnosis() only
     fires when something asks for a diagnosis, which couples the refresh rate of every derived
     signal to an unrelated caller. */
const jobs = new Scheduler({ minGapMs: 4000 });

/* B12 in force: the deferrable jobs ask the governor first. The diagnosis loop and the self-check
   are NOT deferrable and are not routed through it - an instrument that stops measuring when the
   machine gets bad is measuring only the good times. What defers is the expensive, optional work:
   filesystem diffs, process spawns, trend fits. */
function deferrable(name, periodMs, fn) {
  jobs.every(name, periodMs, async () => {
    const d = gov.allow(name);
    if (!d.run) { govDeferrals.push({ at: Date.now(), name, why: d.why }); if (govDeferrals.length > 50) govDeferrals.shift(); return; }
    return fn();
  });
}
let govDeferrals = [];

deferrable('growth', 600_000, () => {
  const snaps = hist.snapshots();
  cachedGrowth = snaps.length >= 2 ? hist.growth(snaps[0].file, snaps[snaps.length - 1].file) : null;
});

deferrable('trend', 600_000, () => {
  cachedTrend = { diskFree: hist.trend('diskFreeGB', 14) };
});

/* Windows-only, and SKIPPED rather than attempted-and-ignored. Off Windows the old code spawned a
   process that could not exist, every ten minutes, forever, and binned the failure in a callback
   that discarded its error. */
if (PS_HOST) {
  deferrable('hardware', 600_000, () => new Promise((res) => {
    ps(SCRIPTS.hardware, (e, d2) => { if (!e && d2) cachedHw = d2; res(); });
  }));
  deferrable('maintenance', 600_000, () => new Promise((res) => {
    ps(SCRIPTS.maint, (e, d2) => { if (!e && d2) cachedMaint = d2; res(); });
  }));
}

/* B6 verdicts. Only workloads with a LIVE session are asked: a verdict about a program that is not
   running is a finding nobody can act on. */
jobs.every('workload-verdicts', 120_000, () => {
  cachedWl = work.list()
    .filter((w) => w.live)
    .map((w) => work.verdict(w.name))
    .filter((v) => v && v.ok && v.call !== 'normal');
});

jobs.start(1000);

/* B11. Measured once, held for the session, never written to disk. */
/* B7. Constructed here beside the other long-lived subsystems; it holds no resources until asked. */
const replay = new Reproducer();
/* If the bridge is going down, so is the load. A stress loop that outlives the thing that started
   it is the worst possible bug in this module. */
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { replay.stop('the bridge is shutting down'); } catch {} });

/* B12. The panel reports its own frame intervals; the decision lives here, once, so every job asks
   the same question of the same evidence. */
const gov = new Governor();

const boot = new BootTrial();
boot.run({
  /* How expensive is a PowerShell one-shot HERE? It is the unit of cost for most of what this
     product does on Windows, it varies by an order of magnitude between machines, and nothing was
     measuring it - the ten-minute periods were chosen on the assumption it is cheap. */
  psSpawn: () => new Promise((res, rej) => {
    if (!PS_HOST) return rej(new Error('no PowerShell on this platform'));
    const t0 = Date.now();
    ps('1', (e) => {
      if (e) return rej(e);
      const ms = Date.now() - t0;
      res({ value: ms, verdict: ms > 600 ? 'slow' : ms > 200 ? 'normal' : 'fast',
            why: `an empty PowerShell one-shot returned in ${ms} ms` });
    });
  }),
  /* Cores and memory decide how much of this machine a background job may reasonably take. */
  capacity: async () => {
    /* Required here rather than assumed in scope. bridge.js has `os` only inside two functions, so
       the first version of this probe threw "os is not defined" — and the trial reported it as
       UNMEASURED rather than inventing a pessimistic verdict, which is the behaviour the design
       exists for and how the bug was visible at all. */
    const os = require('os');
    const cores = os.cpus().length, gb = os.totalmem() / 2 ** 30;
    return { value: { cores, gb: +gb.toFixed(1) },
             verdict: cores >= 8 && gb >= 16 ? 'roomy' : cores >= 4 ? 'modest' : 'tight',
             why: `${cores} logical cores, ${gb.toFixed(1)} GB installed` };
  },
}).then(() => {
  const r = boot.results;
  console.error('[trial] ' + Object.entries(r)
    .map(([k, v]) => k + '=' + (v.ok ? v.verdict : 'unmeasured')).join(' '));
});

function currentDiagnosis() {
  const d = diagnose(latest, hist, { growth: cachedGrowth, outcomes, maint: cachedMaint,
                                     trend: cachedTrend, workloads: cachedWl, hw: cachedHw });
  outcomes.observe(d, latest);
  /* Offered to the notifier on the same 30 s clock the diagnosis already runs on. It decides
     whether anything has earned an interruption; nothing about that decision lives here, so the
     rules stay in one readable place. */
  const watching = (Date.now() - watchingAt < 15_000) && (watchingView === 'diag' || watchingView === 'ov');
  notifier.consider(d, { watching }).catch((e) => console.error('[notify]', e.message));
  /* Automations run on the same 30 s clock, AFTER observe() — so the ledger already contains this
     tick's firings when the automation asks whether it has earned the right to act on them.
     Levers are injected rather than imported, which is what lets the suite drive every branch
     without deleting a file; it is also the list of what an automation may reach, in one place
     that can be read in five seconds. Anything not named here is not reachable, by construction. */
  automations.consider(d, latest, {
    /* ACTUALLY sequential. The first version said "Sequential" in this comment and used forEach,
       which launches every target at once — two concurrent recursive-delete PowerShells during a
       disk-pressure incident, which is the worst moment to double the I/O. It also rejected the
       whole run if ANY target failed, discarding the other target's real freedGB and recording the
       automation's benefit as null: a run that genuinely returned a gigabyte was filed as "no
       measured result", which is the one column the demotion rule reads.
       Now: one at a time, partial results kept, per-target errors carried alongside them. A
       failure is a fact about that target, not about the run. */
    clean: (params) => new Promise((resolve) => {
      const keys = (params && params.keys) || [];
      if (!keys.length) return resolve({ keys, freedGB: 0, errors: [] });
      const errors = [];
      let freed = 0, i = 0;
      const next = () => {
        if (i >= keys.length) {
          /* EVERY TARGET FAILED IS NOT "IT FREED NOTHING". Resolving with 0 filed a lever that was
             blocked — PowerShell broken, every entry denied — as a successful run that measured
             zero, which then fed the episode arithmetic as a real observation. Null travels, zero
             lies: with no target reached there is no measurement, and the run records as
             unmeasured rather than as a success worth nothing. */
          const allFailed = errors.length === keys.length;
          return resolve({ keys, errors, ok: !allFailed,
                           freedGB: allFailed ? null : Math.round(freed * 100) / 100 });
        }
        const k = keys[i++];
        clean(k, (e, r) => {
          if (e) errors.push({ key: k, error: e.message });
          else if (r && typeof r.freedGB === 'number') freed += r.freedGB;
          next();
        });
      };
      next();
    }),
    growthscan: () => new Promise((resolve, reject) => {
      if (growthScanState.running) return reject(new Error('a growth scan is already running'));
      const root = require('os').homedir();
      const out = path.join(HIST_DIR, `walk-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
      growthScanState = { running: true, startedAt: Date.now(), root, last: null };
      execFile(process.execPath, [path.join(HERE, 'growthscan.js'), '--root', root, '--out', out],
        { timeout: 15 * 60_000, maxBuffer: 1 << 20 }, (e) => {
          growthScanState = { running: false, startedAt: null, root, last: e ? null : out };
          e ? reject(e) : resolve({ out });
        });
    }),
    /* Incident capture. The bundle builder already exists for the support button; the only thing
       an automation adds is being there at the moment it breaks, which is the part a human
       reliably cannot do. Reads only — it collects what has already been measured. */
    /* `diagnosis: d` is what breaks the cycle — see buildBundle. It is also simply more correct:
       this bundle is meant to capture the incident that triggered it, and `d` IS that diagnosis.
       Re-deriving it a moment later would describe a slightly different machine. */
    bundle: () => new Promise((resolve, reject) => {
      /* A CAPTURE MUST NOT BE THE THING THAT FILLS THE DISK. Its triggers include disk_low and
         spiral, so the one moment it wants to run is the moment the machine can least afford a
         few hundred MB. Refused below the floor, and the refusal is recorded like any other. */
      const sv = systemVolume(latest);
      const freeGB = sv && sv.freeGB != null ? sv.freeGB : null;
      if (freeGB != null && freeGB < BUNDLE_MIN_FREE_GB) {
        return reject(new Error(`only ${freeGB} GB free — a capture needs ${BUNDLE_MIN_FREE_GB} GB `
          + `of headroom, and writing one here would make the incident it is documenting worse`));
      }
      buildBundle({ reason: 'automatic capture — a critical finding appeared', diagnosis: d },
        (e, r) => (e ? reject(e) : resolve(r)));
    }),
    /* The disruptive tier's ONLY channel. It cannot act; it can put the finding in front of a
       human.

       IT DOES NOT NOTIFY, and the comment here used to claim it did ("routed through the notifier
       so it obeys the same suppression rules") — which was false the moment it was written. A
       comment describing a guard that is not in the code below it is worse than no comment: it is
       the thing a reviewer trusts instead of reading.

       Not notifying is the right behaviour, which is why the fix is the comment rather than the
       code. A proposal waits on the Automations page; it interrupts nothing, so there is nothing
       for the notifier's suppression rules to protect. The moment this DOES grow a notification —
       and "your editor is leaking, restart it?" is a plausible thing to want raised — it must go
       through notifier.consider() and inherit every rule there, because an automation is not
       entitled to a louder voice than a critical finding. */
    propose: (payload) => {
      pendingProposals = pendingProposals.filter((x) => x.id !== payload.id);
      pendingProposals.push({ ...payload, at: Date.now() });
      return { asked: true, queued: pendingProposals.length };
    },
    /* gov.allow() is the same question every deferrable job asks, so an observe automation defers
       on exactly the evidence the rest of the product defers on — and inherits its honest limit:
       with no panel rendering there is no stall SIGNAL, and the governor answers "run", because
       "we cannot see" must never be read as "the machine is struggling". */
  }, { stalling: !gov.allow('automation').run })
    .catch((e) => console.error('[automate]', e.message));
  return d;
}
/* Proposals a disruptive automation has raised and a human has not answered. In memory on
   purpose: an unanswered "shall I restart Chrome?" from four days ago is noise, not a task, and
   the condition will simply re-raise it if it still holds. */
let pendingProposals = [];
setInterval(currentDiagnosis, 30000);

/* ---------------- server ---------------- */

/* PowerShell 5.1's ConvertTo-Json is not shape-stable: a single result serializes as a bare object
 * instead of a one-element array, and some collection types serialize as {"value":[...]}. Normalize
 * once here so no caller has to care. */
function asArray(d) {
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.value)) return d.value;
  return d ? [d] : [];
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, cb) {
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(b || '{}')); } catch { cb({}); } });
}

/* ---- IS THIS REQUEST ACTUALLY FROM THIS MACHINE'S OWN UI? ----
 *
 * Binding to 127.0.0.1 keeps the port off the network. It does NOT keep it away from a WEB PAGE the
 * owner happens to be viewing: a browser on this machine can reach loopback, and a cross-origin
 * `fetch` with Content-Type text/plain is a CORS *simple* request - no preflight, the browser sends
 * it, the handler runs. The response being unreadable to the attacker is irrelevant when the point
 * of the request was the side effect: kill a process, clear caches, raise a UAC prompt, start the
 * clipboard watcher, or hand attacker-chosen text to an Ask run that can write files.
 *
 * The second half is DNS rebinding: a hostile name resolved to 127.0.0.1 makes the page same-origin
 * with us, and then it can READ - history, journal, clipboard log, the Ask thread. The Host header is
 * what distinguishes that from a genuine local request, so it has to be checked, not assumed.
 *
 * Two rules, both cheap:
 *   ORIGIN - if present and not loopback, refuse. Same-origin requests from our own page send either
 *            no Origin or a loopback one; a hostile page always sends its own.
 *   HOST   - must be loopback. Our page asks for 127.0.0.1; a rebound name arrives as itself.
 *
 * This is the difference between "not reachable off-box" as a claim and as a fact - the docs stake
 * the whole security story on that sentence, so it had better be true. */
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1|0:0:0:0:0:0:0:1)$/i;
function localOnly(req, res) {
  const origin = req.headers.origin;
  /* `null` IS NOT A PASS. Exempting it was exactly backwards: an opaque origin is what a SANDBOXED
     IFRAME sends, which is the cheapest way for a hostile page to reach loopback -
     <iframe sandbox="allow-scripts" srcdoc="...fetch..."> sends `Origin: null` and a genuine
     `Host: 127.0.0.1`, so it satisfied both checks and the mode actually changed. Our own panel
     never sends it - the panel is always http://127.0.0.1:PORT - so refusing it costs nothing and
     closes the case an attacker would actually reach for. */
  if (origin) {
    let host = '';
    try { host = new URL(origin).hostname; } catch { host = origin === 'null' ? 'an opaque (sandboxed) origin' : 'unparseable'; }
    if (!LOOPBACK.test(host)) {
      json(res, 403, {
        error: 'cross-origin requests are refused',
        detail: 'VITALS answers only its own local panel. A page served from ' + host +
                ' cannot drive this machine.',
      });
      return false;
    }
  }
  /* AN ABSENT Origin WAS A PASS, AND THAT WAS THE HOLE.
     Only `if (origin)` was checked, so anything a browser sends WITHOUT an Origin sailed through
     on a genuine loopback Host: an <img src>, a <script src>, an <iframe>, a form GET. Verified
     against the running bridge during review - a no-Origin GET to a state-changing route returned
     200 while the same request with a hostile Origin was correctly refused. The guard was only ever
     stopping the attacker who volunteered their name.

     `Sec-Fetch-Site` closes it. Every current browser sends it on every request, JavaScript cannot
     forge it, and it says what Origin omits: `cross-site` for that <img>, `same-origin` for our own
     panel, `none` for a URL the user typed. Absent means a non-browser client - curl, the MCP tool,
     the suites - which is not the threat this guard is for and is left alone. */
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site && site !== 'same-origin' && site !== 'none') {
    json(res, 403, {
      error: 'cross-site requests are refused',
      detail: `This request arrived as "${site}" — it was made by a page on another site, not by ` +
              'the VITALS panel. Loading an image or a script cannot be allowed to drive this machine.',
    });
    return false;
  }

  /* Strip the port, and the brackets an IPv6 literal arrives in. */
  const hostHeader = String(req.headers.host || '').replace(/:\d+$/, '');
  if (hostHeader && !LOOPBACK.test(hostHeader)) {
    json(res, 403, {
      error: 'unexpected Host header',
      detail: `This bridge serves 127.0.0.1 only. A request addressed to "${hostHeader}" reached it, ` +
              'which is what DNS rebinding looks like.',
    });
    return false;
  }
  return true;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  /* FIRST, before the page, before any route. A check that some paths skip is a check with a hole. */
  if (!localOnly(req, res)) return;
  if (!methodGate(req, res, p, url)) return;

  if (p === '/' || p === '/index.html') {
    fs.readFile(path.join(HERE, 'dashboard.html'), (e, d) => {
      if (e) { res.writeHead(500); return res.end('dashboard.html missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(d);
    });
    return;
  }

  if (p === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    if (staticInfo) res.write(`event: static\ndata: ${JSON.stringify(staticInfo)}\n\n`);
    if (latest) res.write(`event: tick\ndata: ${JSON.stringify(latest)}\n\n`);
    req.on('close', () => clients.delete(res));
    return;
  }

  /* ------- ONE GATE for every Windows-only route -------
   * Guarding twenty handlers individually guarantees the twenty-first is forgotten. The set below is
   * the honest inventory of what this build implements as PowerShell, and it is the SAME list
   * collect/caps.js derives its action/scan capabilities from - so the manifest and the router
   * cannot drift apart and tell a user two different stories. */
  if (!PS_HOST && WINDOWS_ONLY_ROUTES.has(p) && !PORTED_HERE.has(p)) return psOnly(res, p);

  /* THE MODE GATE, next to the platform gate and for the same reason: one place, checked before any
     handler runs, so a route added later cannot forget to ask. */
  if (MODE === 'viewer' && ACTION_ROUTES.has(p)) return modeRefusal(res, p);
  if (MODE === 'viewer' && VIEWER_PRIVATE_ROUTES.has(p)) return viewerPrivacyRefusal(res, p);

  if (p === '/api/reclaim') {
    const key = url.searchParams.get('key');
    // No key: return the target LIST instantly so the UI can paint its table skeleton, then ask
    // for each size separately.
    if (!key) return json(res, 200, TARGETS.map(({ key, name, tier, safe }) => ({ key, name, tier, safe })));
    const t = TARGETS.find((x) => x.key === key);
    if (!t) return json(res, 404, { error: 'unknown target' });
    return ps(SCRIPTS.sizeOne(t), (e, d) =>
      json(res, e ? 500 : 200, e ? { key, error: e.message } : { ...t, ...d, ps: undefined }));
  }
  if (p === '/api/startup') {
    if (!PS_HOST) {
      return posixInspect.startup((e, d, note) => {
        /* A refused login-items read must leave a trace - rendered as an empty group it would be a
           fabricated "nothing starts here". The array is the page's contract; the note is logged. */
        if (note) console.error('[startup] ' + note);
        json(res, e ? 500 : 200, e ? { error: e.message } : d);
      });
    }
    return ps(SCRIPTS.startup, (e, d) => json(res, e ? 500 : 200, e ? { error: e.message } : asArray(d)));
  }
  if (p === '/api/processes') return ps(SCRIPTS.processes, (e, d) => json(res, e ? 500 : 200, e ? { error: e.message } : asArray(d)));
  if (p === '/api/conns') {
    if (!PS_HOST) return posixInspect.conns((e, d) => json(res, e ? 500 : 200, e ? { error: e.message } : d));
    return ps(SCRIPTS.conns, (e, d) => json(res, e ? 500 : 200, e ? { error: e.message } : asArray(d)));
  }
  if (p === '/api/netinfo') return ps(SCRIPTS.netinfo, (e, d) => json(res, e ? 500 : 200, e ? { error: e.message } : d));
  /* Latency + speed tests are POST on purpose: they cost the user's bandwidth, so they must never
   * be triggered by a prefetch, a cache-warmer, or anything that GETs URLs speculatively. */
  if (req.method === 'POST' && p === '/api/nettest') {
    return ps(SCRIPTS.nettest, (e, d) => json(res, e ? 500 : 200, e ? { error: e.message } : d));
  }
  if (req.method === 'POST' && p === '/api/speedtest') {
    return speedTest((e, d) => json(res, e ? 500 : 200, e ? { error: e.message } : d));
  }
  if (req.method === 'POST' && p === '/api/battreport') {
    return battReport((e, d) => json(res, e ? 500 : 200, e ? { error: e.message } : d));
  }
  if (p === '/api/bigdirs') {
    const root = url.searchParams.get('root') || 'C:\\';
    return ps(SCRIPTS.bigdirs(root), (e, d) => json(res, e ? 500 : 200, e ? { error: e.message } : { root, dirs: asArray(d) }));
  }

  /* ---------- history / growth / diagnosis ---------- */

  /* Dock the native panel from outside it. The bridge cannot talk to the host directly, so it
   * broadcasts over the SSE stream the page is already holding open and the page relays it on. */
  if (p === '/api/panel/mode') {
    const m = url.searchParams.get('m') || 'panel';
    if (!['panel', 'sidebar-left', 'sidebar-right', 'topbar'].includes(m)) {
      return json(res, 400, { error: 'bad mode' });
    }
    broadcast('panelmode', { mode: m });
    return json(res, 200, { ok: true, mode: m, listeners: clients.size });
  }

  // Switch the panel's theme from outside it (same relay trick as /api/panel/mode).
  if (p === '/api/panel/theme') {
    const t = url.searchParams.get('t') || 'dark';
    if (!['dark', 'light', 'pro', 'beast'].includes(t)) return json(res, 400, { error: 'bad theme' });
    broadcast('paneltheme', { theme: t });
    return json(res, 200, { ok: true, theme: t, listeners: clients.size });
  }

  // Switch the panel's view from outside it (same relay trick as /api/panel/mode).
  if (p === '/api/panel/view') {
    const view = url.searchParams.get('v') || 'ov';
    broadcast('panelview', { view });
    return json(res, 200, { ok: true, view, listeners: clients.size });
  }

  // Topmost + window opacity from outside (harness/automation) — page relays to the host.
  if (p === '/api/panel/top') {
    const on = url.searchParams.get('on') !== '0';
    broadcast('paneltop', { on });
    return json(res, 200, { ok: true, on, listeners: clients.size });
  }
  if (p === '/api/panel/alpha') {
    const a = Math.max(60, Math.min(255, +url.searchParams.get('a') || 240));
    broadcast('panelalpha', { a });
    return json(res, 200, { ok: true, a, listeners: clients.size });
  }
  // Shell backdrop-blur on/off (persisted in the page's localStorage) — cost lever + harness hook.
  if (p === '/api/panel/blur') {
    const on = url.searchParams.get('on') !== '0';
    broadcast('panelblur', { on });
    return json(res, 200, { ok: true, on, listeners: clients.size });
  }

  /* The most recent full tick (incl. per-process rows + self block) as plain REST — for native
   * clients (badge.ps1, future docked strips) that poll rather than hold an SSE stream open. */
  if (p === '/api/latest') return json(res, 200, latest || { none: true });

  /* What THIS host can honestly answer. The panel gates features on it, the installer prints it, and
     the support bundle embeds it - so a bug report from a Mac carries the fact that its collector
     has never been verified, rather than leaving someone to wonder why the GPU ring is missing. */
  if (p === '/api/caps') return json(res, 200, applyMode(CAPS));
  /* The instrument's own agreement record. Read-only and safe in viewer mode - it describes the
     measuring, not the machine. */
  if (p === '/api/selfcheck') return json(res, 200, selfCheck.summary());

  /* ---- MODE ----
     GET reports it. POST can only ever tighten: admin -> viewer is allowed, viewer -> admin is not,
     because a restriction the restricted party can lift is not a restriction. Admin comes back by
     launching with VITALS_MODE=admin, which is outside the surface viewer mode governs. */
  if (p === '/api/mode' && req.method !== 'POST') {
    /* `hasPass` only ever reports EXISTENCE - the hash and salt never leave this process, the same
       rule the Ask API key follows. */
    return json(res, 200, { mode: MODE, actions: MODE === 'admin' ? [...ACTION_ROUTES] : [],
                            askPermission: askPermission(), hasPass: hasAdminPass(),
                            canRestoreAdminHere: hasAdminPass(),
                            restoreWith: 'VITALS_MODE=admin' });
  }

  /* Set or clear the passphrase. ADMIN ONLY, and that is not a formality: allowing it from viewer
     would let the restricted party set their own way out, which is the whole thing this prevents. */
  if (req.method === 'POST' && p === '/api/mode/password') {
    if (MODE !== 'admin') return json(res, 403, { error: 'only an admin session can set the passphrase' });
    return readBody(req, (b) => {
      const pw = String((b && b.password) || '');
      if (pw && pw.length < 6) return json(res, 400, { error: 'use at least 6 characters' });
      const r = setAdminPass(pw);
      console.error('[mode] admin passphrase ' + (r.set ? 'set' : 'cleared'));
      return json(res, 200, { hasPass: r.set });
    });
  }
  if (req.method === 'POST' && p === '/api/mode') {
    return readBody(req, (b) => {
      const want = String((b && b.mode) || '').toLowerCase();
      if (want !== 'viewer' && want !== 'admin') return json(res, 400, { error: 'mode must be viewer or admin' });
      if (want === 'admin' && MODE === 'viewer') {
        /* Without a passphrase this stays impossible from here - that was the original design and it
           remains the default. A passphrase turns "you cannot" into "you have to mean it", which is
           the honest description of what it buys. */
        if (!hasAdminPass()) {
          return json(res, 403, {
            error: 'viewer mode cannot promote itself to admin',
            detail: 'No admin passphrase is set on this install. Restart with VITALS_MODE=admin.',
          });
        }
        const wait = passRateLimited();
        if (wait) return json(res, 429, { error: `too many attempts - wait ${wait}s` });
        if (!checkAdminPass(b && b.password)) {
          notePassFailure();
          console.error('[mode] failed admin passphrase attempt');
          return json(res, 403, { error: 'wrong passphrase' });
        }
        passAttempts.n = 0;
      }
      MODE = want;
      try { fs.writeFileSync(MODE_FILE, JSON.stringify({ mode: MODE, at: Date.now() }, null, 1)); } catch {}
      /* Tell every open window at once, so a second panel does not keep offering buttons that now
         refuse. The manifest rides along, which is what the UI actually gates on. */
      /* Update the STORED static too, not just the broadcast. staticInfo is what every new client
         receives on connect, and it was frozen with the caps the collector started with - so a
         window opened after a mode switch got the OLD manifest and showed the wrong badge and the
         wrong buttons, while windows that had been open all along were correct. Broadcasting
         without updating the thing new arrivals read is a half-applied change. */
      staticInfo = { ...(staticInfo || { t: 'static' }), caps: applyMode(CAPS) };
      broadcast('static', staticInfo);
      console.error('[mode] now ' + MODE);
      return json(res, 200, { mode: MODE, note: MODE === 'viewer'
        ? 'Actions are refused by the bridge. Ask drops to read-only on its next question.'
        : 'Full technician access.' });
    });
  }

  if (p === '/api/recent') return json(res, 200, hist.recent(+url.searchParams.get('n') || 300));
  /* HISTORY SPEAKS v1 BY DEFAULT, and that is a compatibility decision rather than laziness.
     Its consumer is the MCP `vitals_history` tool, whose output goes to a language model as raw
     JSON. A v2 row's index 1 is the MAXIMUM where v1's was the average, so shipping the new shape
     unannounced would not error - it would have the model confidently narrate peak values as
     typical ones. `?dist=1` returns the rows verbatim for anything that knows the difference. */
  if (p === '/api/history') {
    const days = +url.searchParams.get('days') || 7;
    const rows = hist.range(days);
    if (url.searchParams.get('dist') === '1') return json(res, 200, rows);
    return json(res, 200, rows.map((r) => {
      const out = { t: r.t, n: r.n };
      for (const k of Object.keys(r)) {
        if (k === 't' || k === 'n' || k === 'v') continue;
        const tri = History.tripleOf(r, k);
        if (tri) out[k] = tri;
      }
      return out;
    }));
  }

  /* B5: what each program costs, in percentiles rather than an average — and B6, the verdict on
     whether a given workload is behaving unusually, or the machine is.
     `?name=` returns one workload's full profile plus its verdict; bare returns the list. */
  if (p === '/api/workloads') {
    const name = url.searchParams.get('name');
    if (name) {
      const prof = work.profile(name);
      if (!prof) return json(res, 404, { error: 'no record for that workload', name });
      return json(res, 200, { ...prof, verdict: work.verdict(name) });
    }
    const list = work.list();
    return json(res, 200, {
      /* The sampling caveat travels with the data rather than living only in the docs: everything
         here is drawn from a top-16-by-memory list, so a program that never enters it has no
         record at all, and one that drops out has a gap rather than an ending. */
      note: 'sessions are periods of OBSERVED activity — tick.proc is a top-16 by memory, so a ' +
            'program dropping off that list is a gap in observation, not an exit',
      workloads: list.map((w) => ({ ...w, verdict: work.verdict(w.name) })),
    });
  }

  /* B1: the log-time band — one column per pixel across the whole record, each a histogram merge.
     Cheap for the same reason the substrate exists: every zoom level comes from one stored
     resolution, so a quarter and a minute cost the same query. */
  if (p === '/api/band') {
    const key = url.searchParams.get('key') || 'cpu';
    const cols = +url.searchParams.get('cols') || 160;
    const oldestSec = +url.searchParams.get('oldest') || 90 * 86400;
    return json(res, 200, hist.band(key, { cols, oldestSec }));
  }

  /* A2: percentiles over any span, merged from the stored minute buckets plus the live ring.
     `covered` and `v1Rows` ride along because a p95 drawn from the half of a window that happens
     to carry distributions, presented as though it covered the whole window, is the confident
     wrong number this substrate exists to stop producing. */
  if (p === '/api/percentiles') {
    const key = url.searchParams.get('key') || 'cpu';
    const to = +url.searchParams.get('to') || Date.now();
    const from = +url.searchParams.get('from') || (to - 3600_000);
    const qs = (url.searchParams.get('q') || '0.5,0.95,0.99').split(',').map(Number)
      .filter((q) => q > 0 && q < 1);
    if (!qs.length) return json(res, 400, { error: 'no valid quantiles requested' });
    const out = hist.percentiles(key, from, to, qs);
    return json(res, 200, out || { key, from, to, n: 0, note: 'nothing recorded in that window' });
  }
  if (p === '/api/snapshots') return json(res, 200, hist.snapshots());

  if (p === '/api/growth') {
    const snaps = hist.snapshots();
    if (snaps.length < 2) return json(res, 200, { need: 2, have: snaps.length, snapshots: snaps });
    const a = url.searchParams.get('new') || snaps[0].file;
    const b = url.searchParams.get('old') || snaps[snaps.length - 1].file;
    return json(res, 200, hist.growth(a, b) || { error: 'could not read snapshots' });
  }

  /* ---- portable growth snapshot: the walker (growthscan.js) ----
   * The non-NTFS counterpart of /api/mftscan: walks a tree with plain fs calls and writes a
   * walk-*.json snapshot that /api/growth diffs. Its own process, because a home-directory walk is
   * minutes of blocking I/O and the 1 Hz tick must not stall behind it. Pure Node - deliberately
   * NOT in WINDOWS_ONLY_ROUTES - and an ACTION_ROUTE, so viewer mode refuses it: it writes an
   * index of the owner's folder sizes, which is exactly the class of thing viewer must not mint. */
  if (req.method === 'POST' && p === '/api/growthscan') {
    return readBody(req, (b) => {
      if (growthScanState.running) {
        return json(res, 409, { error: 'a growth scan is already running', startedAt: growthScanState.startedAt });
      }
      const root = b && b.root ? String(b.root) : require('os').homedir();
      let st = null;
      try { st = fs.statSync(root); } catch {}
      if (!st || !st.isDirectory()) return json(res, 400, { error: 'root is not a readable directory', root });
      const out = path.join(HIST_DIR, `walk-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
      growthScanState = { running: true, startedAt: Date.now(), root, last: null };
      /* Recorded as a lever, like every other thing you choose to do. Without this the automations
         page could never earn the daily scan: "you have run this by hand N times" has to be counted
         somewhere, and a manual scan that leaves no trace is a choice the record never saw. */
      outcomes.lever('growthscan', { root, manual: true }, latest);
      /* 15 minutes of budget: a first walk over a large spinning-disk home can genuinely take
         that. execFile, not spawn - its callback IS the error handler, so a missing binary cannot
         re-create the crash class test-routes.js hunts for. */
      execFile(process.execPath, [path.join(HERE, 'growthscan.js'), '--root', root, '--out', out],
        { timeout: 15 * 60_000, maxBuffer: 1 << 20 }, (e, stdout) => {
          growthScanState = {
            running: false, startedAt: growthScanState.startedAt, root,
            last: e ? { ok: false, err: e.message }
                    : { ok: true, file: path.basename(out), summary: String(stdout || '').trim() },
          };
          if (e) console.error('[growthscan]', e.message);
        });
      return json(res, 200, { started: true, root, note: 'walking; minutes on a large tree. Poll GET /api/growthscan, then diff via /api/growth.' });
    });
  }
  if (p === '/api/growthscan') return json(res, 200, growthScanState);

  /* B4. The panel says what it is showing and whether it has focus; the bridge uses it only to
     SUPPRESS. A beacon that fails, or a panel that is closed, therefore makes alerting more
     talkative rather than less - which is the correct direction for a signal you cannot trust. */
  if (p === '/api/watching') {
    watchingAt = Date.now();
    watchingView = url.searchParams.get('view') || null;
    if (url.searchParams.get('focus') === '0') watchingAt = 0;
    return json(res, 200, { ok: true });
  }

  /* B13/B14/B15: whatever this host will actually tell us about its hardware. Served even when
     empty, because "we asked and it refused" is a different answer from "we never asked". */
  /* B16: every declared relationship, measured over the live ring — including the ones that did
     NOT qualify. A table of what was looked at is more useful than a filtered list of hits, and it
     is what makes the absence of a correlation legible rather than invisible. */
  /* B8/B11: what is scheduled, when it next runs, and what the boot trial decided. Published
     because a scheduler nobody can inspect is indistinguishable from a pile of timers. */
  /* B10: the graduated quarantine. A reversible ladder in place of the one irreversible lever most
     monitors offer.

     VIEWER MODE CANNOT CLIMB IT. Viewer reports how the machine is performing and changes nothing
     about it, and de-prioritising someone's compiler is a change. `state` is a read and is allowed,
     which is what lets the panel show the rung a process is already on. */
  if (p === '/api/quarantine/act') {
    if (!PS_HOST) return json(res, 501, { error: 'the quarantine ladder is Windows-only for now' });
    const act = url.searchParams.get('do') || 'state';
    /* Reads may be GET; actions may not. `state` only reports which rung a process is on, so this
       route is in the MUTATES table with a predicate rather than a flat entry - the gate ran before
       routing and this handler is only reached once it has passed. */
    const target = +url.searchParams.get('pid');
    const cores = +url.searchParams.get('cores') || 2;
    if (!['state', 'priority', 'affinity', 'suspend', 'release'].includes(act)) {
      return json(res, 400, { error: 'unknown rung' });
    }
    if (!Number.isInteger(target) || target <= 4) {
      return json(res, 400, { error: 'need a real ?pid=' });
    }
    if (act !== 'state' && MODE === 'viewer') {
      return json(res, 403, { error: 'viewer mode reports the machine, it does not change it' });
    }
    const script = `& '${HERE.replace(/'/g, "''")}\\quarantine.ps1' -Action ${act} ` +
                   `-TargetPid ${target} -Cores ${Math.max(1, Math.min(64, cores))}`;
    return ps(script, (e, d) => {
      if (e && !d) return json(res, 500, { ok: false, error: e.message });
      /* Journalled, because every rung is a change to how the machine behaves and the ledger is
         what makes a change reviewable later. A silent fence is indistinguishable from a bug. */
      if (d && d.ok && act !== 'state') {
        /* `write([entry])`, not a `push` helper — there isn't one. The first version called
           journal.push() inside a try/catch, which would have swallowed the TypeError and left
           every quarantine action unjournalled while reporting success. A catch around a call you
           have not checked is a way to not find out. */
        const r = journal.write([{
          sev: 'info', kind: 'act',
          msg: `quarantine ${act}: ${d.name || target}` + (d.note ? ' — ' + d.note : ''),
        }]);
        if (!r || !r.written) console.error('[quarantine] the action was not journalled');
      }
      json(res, 200, d || { ok: false, error: 'no answer from the one-shot' });
    });
  }

  /* B7: replay a moment out of the record.
     `?profile=` reads a window and returns what would be reproduced WITHOUT doing it, so the panel
     can show the load before anyone agrees to it. `?go=1` starts it, `?stop=1` ends it. */
  if (p === '/api/replay') {
    /* Same shape: status and `?profile=1` are reads, starting and stopping a load are not. Gated by
       predicate in MUTATES, above, before routing. */
    if (url.searchParams.get('stop') === '1') return json(res, 200, replay.stop('asked to stop'));

    const to = +url.searchParams.get('to') || Date.now();
    const from = +url.searchParams.get('from') || (to - 300_000);

    if (url.searchParams.get('go') === '1') {
      /* Loading someone's machine is a change to how it behaves, so viewer mode may not. */
      if (MODE === 'viewer') {
        return json(res, 403, { error: 'viewer mode reports the machine, it does not load it' });
      }
      const prof = profileFrom(hist, from, to);
      if (!prof) return json(res, 400, { error: 'nothing recorded in that window to replay' });
      const r = replay.start(prof, latest, { seconds: +url.searchParams.get('seconds') || prof.seconds });
      if (r.ok) {
        journal.write([{ sev: 'warn', kind: 'act',
          msg: `replaying a recorded moment: ${prof.describes} for ${r.remainingSec}s` }]);
      }
      return json(res, r.ok ? 200 : 400, r);
    }

    if (url.searchParams.get('profile') === '1') {
      const prof = profileFrom(hist, from, to);
      return json(res, 200, prof || { error: 'nothing recorded in that window' });
    }
    return json(res, 200, replay.status());
  }

  /* B12: the panel posts the frame intervals it just measured. Intervals, not a verdict — the
     decision belongs in one place and the panel is not it. */
  /* B9. The sweep's statistics — the multiple-comparison correction and the calibrated bar — live
     in exactly ONE file, and the panel needs them too. Serving the module rather than porting it is
     what stops the browser copy and the Node copy drifting apart, which for a significance bar
     would mean two different definitions of "measurable" with no way to tell which produced a
     receipt. The shim below adapts CommonJS to a global; the arithmetic is untouched. */
  if (p === '/sweep.js') {
    try {
      const src = require('fs').readFileSync(require('path').join(HERE, 'sweep.js'), 'utf8');
      const wrapped = [
        '(function(){const module={exports:{}};const exports=module.exports;',
        src,
        'window.__SweepCtor=module.exports.Sweep;',
        'window.__sweepStats={median:module.exports.median,mad:module.exports.mad};',
        '})();',
      ].join('\n');
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8',
                           'Cache-Control': 'no-store' });
      return res.end(wrapped);
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (p === '/api/frames') {
    return readBody(req, (b) => {
      try { gov.report(b && b.intervals); } catch (e) { console.error('[gov]', e.message); }
      json(res, 200, { ok: true });
    });
  }

  /* ================= THE CONSENT LOOP FOR AI IDENTIFIER ACCESS =================================
   *
   * The MCP server replaces identifiers with stable local tags and treats `identifiers:true` as a
   * REQUEST rather than a grant. These three routes are the other half: the place a human sees the
   * request and answers it. Without them the answer is always "no", which is safe and useless — a
   * locked door is not a consent loop.
   *
   * A pending request is not a new file. The access log already records every ask with
   * `identifiers:true, granted:false`, so "what is waiting" is a QUERY over the record rather than
   * a second store that can disagree with it.
   * =========================================================================================== */
  if (p === '/api/ai/access') {
    const since = Date.now() - (+url.searchParams.get('mins') || 30) * 60_000;
    const rows = aiAccess.recent(400);
    /* An ask older than the window is not pending, it is history: answering a request from
       yesterday would hand data to a task that finished long ago. */
    const pending = rows.filter((r) => r.ev === 'read' && r.identifiers === true
                                    && r.granted === false && r.at >= since);
    return json(res, 200, {
      summary: aiAccess.summary(),
      recent: rows.slice(0, 40),
      pending: pending.slice(0, 10),
      grant: aiAccess.grant(),
      dev: aiAccess.dev(),
      /* NAMED FOR WHAT IT IS. It was `passphraseRequired`, which reads as "a passphrase is
         needed" — and the passphrase is ALWAYS needed, so the flag looked like a policy switch
         rather than a fact about this install. It is "one exists". The panel branches on it to
         decide whether to show the input or tell you to set one first. */
      hasPassphrase: hasAdminPass(),
      mode: MODE,
    });
  }

  /* THREE TIERS, AND EACH ONE COSTS MORE THAN THE LAST.
   *
   *   viewer      never releases identifiers. Not with a passphrase, not with a toggle. The mode
   *               exists to say "this install does not act on the machine", and handing out its
   *               MAC is acting on it.
   *   admin       may release identifiers, but the PASSPHRASE IS REQUIRED every time. Not "if one
   *               is set" — required. If none is set the request is refused with an instruction to
   *               set one, because a gate that disappears when unconfigured is not a gate, and the
   *               first version of this quietly became one on a machine with no passphrase.
   *   developer   the widest door: nothing is redacted at all, because an agent WORKING ON the
   *               software needs the real numbers. Passphrase, an explicit confirmation, and a
   *               clock. See /api/ai/dev.
   */
  if (p === '/api/ai/grant') {
    if (MODE === 'viewer') return json(res, 403, { error: 'viewer mode cannot approve identifier access' });
    return readBody(req, (b) => {
      if (!hasAdminPass()) {
        /* Refused, not waved through. The alternative — allowing it because no passphrase exists —
           makes the strength of the control depend on whether anyone got round to configuring it,
           which is exactly backwards for a control that releases data. */
        return json(res, 403, {
          error: 'set an admin passphrase first',
          detail: 'Releasing this machine\'s identifiers requires the passphrase every time. ' +
                  'There is no passphrase on this install yet — set one on the SYS page, then ' +
                  'approve the request.',
          needsPassphrase: true,
        });
      }
      if (passRateLimited()) return json(res, 429, { error: 'too many attempts — wait a minute' });
      if (!checkAdminPass(b && b.pass)) { notePassFailure(); return json(res, 403, { error: 'wrong passphrase' }); }
      /* THE SAME EXPLICIT YES DEVELOPER MODE NEEDS. Releasing identifiers is smaller in scope but
         identical in kind — data about this machine leaves it — and a passphrase alone proves only
         that the right person clicked, not that they knew what the click did. Both tiers now cost:
         passphrase, confirmation, and a clock. */
      if (b && b.confirm !== true) {
        return json(res, 400, {
          error: 'confirmation required',
          detail: 'Approving this releases the real MAC, IP, gateway, DNS and Wi-Fi name to the ' +
                  'agent for the window you choose. Send confirm:true once that has been shown.',
        });
      }
      const mins = Math.max(1, Math.min(240, +(b && b.minutes) || 20));
      const why = String((b && b.why) || '').slice(0, 200);
      const until = Date.now() + mins * 60_000;
      try {
        fs.writeFileSync(path.join(HIST_DIR, 'identifier-grant.json'),
                         JSON.stringify({ until, why, at: Date.now() }, null, 1));
      } catch (e) { return json(res, 500, { error: 'could not write the grant: ' + e.message }); }
      /* Logged in the same record the reads are in, so the approval and what it enabled read as one
         sequence rather than two files someone has to correlate. */
      aiAccess.note({ ev: 'grant-opened', minutes: mins, why, until });
      return json(res, 200, { ok: true, until, minutes: mins });
    });
  }

  /* DEVELOPER MODE — the widest permission in the product, and the only one that turns redaction
   * off wholesale. An agent iterating on the collector needs the real numbers, the real adapter
   * names and the real connections; that is a legitimate need and it is also the most dangerous
   * thing this panel can hand out, so it costs the most to open:
   *
   *   a deliberate toggle   it is not a side effect of anything else
   *   the passphrase        the same bar as releasing identifiers, because it releases more
   *   an explicit YES       `confirm: true`, which the panel only sends after showing the warning
   *   a clock               capped like every other window, so forgetting costs hours not months
   */
  if (p === '/api/ai/dev') {
    if (MODE === 'viewer') return json(res, 403, { error: 'viewer mode cannot open developer mode' });
    return readBody(req, (b) => {
      if (!hasAdminPass()) {
        return json(res, 403, {
          error: 'set an admin passphrase first',
          detail: 'Developer mode turns redaction off entirely. It requires the admin passphrase, ' +
                  'and this install does not have one yet — set it on the SYS page.',
          needsPassphrase: true,
        });
      }
      if (passRateLimited()) return json(res, 429, { error: 'too many attempts — wait a minute' });
      if (!checkAdminPass(b && b.pass)) { notePassFailure(); return json(res, 403, { error: 'wrong passphrase' }); }
      /* The confirmation is a FLAG THE PANEL SENDS ONLY AFTER SHOWING THE WARNING. It is not
         security — anything that can POST can set it — it is a guarantee that the sentence
         explaining what this does was on screen before it happened. */
      if (b && b.confirm !== true) {
        return json(res, 400, {
          error: 'confirmation required',
          detail: 'Developer mode stops redacting anything an agent reads from this machine. ' +
                  'Send confirm:true once the warning has actually been shown.',
        });
      }
      const mins = Math.max(1, Math.min(240, +(b && b.minutes) || 60));
      const until = Date.now() + mins * 60_000;
      try {
        fs.writeFileSync(path.join(HIST_DIR, 'dev-mode.json'),
                         JSON.stringify({ until, why: String((b && b.why) || 'opened from the panel').slice(0, 160), at: Date.now() }, null, 1));
      } catch (e) { return json(res, 500, { error: 'could not open developer mode: ' + e.message }); }
      console.error('[ai] DEVELOPER MODE opened for ' + mins + ' min — nothing is redacted while it lasts');
      aiAccess.note({ ev: 'dev-opened', minutes: mins, until });
      return json(res, 200, { ok: true, until, minutes: mins });
    });
  }

  /* ---- PROPOSED EDITS: approval is for a DIFF, not a window ------------------------------------
   * Every other permission here is time-boxed, which is right for reading and wrong for writing: a
   * window opened to fix one line will happily accept twenty more. So a risky edit is staged, the
   * owner sees the actual change, and approving approves THAT change once. The apply path re-checks
   * the content hash, so what lands is what was on screen. */
  if (p === '/api/ai/edits') {
    return json(res, 200, { pending: devedit.listProposals(), mode: MODE, hasPassphrase: hasAdminPass() });
  }

  if (p === '/api/ai/edit/apply') {
    if (MODE === 'viewer') return json(res, 403, { error: 'viewer mode cannot approve edits' });
    return readBody(req, (b) => {
      if (!hasAdminPass()) return json(res, 403, { error: 'set an admin passphrase first',
        detail: 'Applying an edit to this install requires the passphrase.', needsPassphrase: true });
      if (passRateLimited()) return json(res, 429, { error: 'too many attempts — wait a minute' });
      if (!checkAdminPass(b && b.pass)) { notePassFailure(); return json(res, 403, { error: 'wrong passphrase' }); }
      if (!b || b.confirm !== true) return json(res, 400, { error: 'confirmation required',
        detail: 'Send confirm:true once the diff has actually been shown.' });
      const r = devedit.applyProposal(b.id);
      aiAccess.note({ ev: r.error ? 'edit-apply-failed' : 'edit-applied', id: b.id,
                      file: r.file || null, detail: r.error || null });
      return json(res, r.error ? 400 : 200, r);
    });
  }

  if (p === '/api/ai/edit/reject') {
    return readBody(req, (b) => {
      const r = devedit.rejectProposal(b && b.id);
      aiAccess.note({ ev: 'edit-rejected', id: (b && b.id) || null });
      return json(res, 200, r);
    });
  }

  if (p === '/api/ai/devoff') {
    try { fs.unlinkSync(path.join(HIST_DIR, 'dev-mode.json')); } catch {}
    aiAccess.note({ ev: 'dev-closed' });
    return json(res, 200, { ok: true, dev: aiAccess.dev() });
  }

  if (p === '/api/ai/revoke') {
    try { fs.unlinkSync(path.join(HIST_DIR, 'identifier-grant.json')); } catch {}
    aiAccess.note({ ev: 'grant-revoked' });
    return json(res, 200, { ok: true, grant: aiAccess.grant() });
  }

  if (p === '/api/governor') {
    return json(res, 200, { ...gov.status(), deferred: govDeferrals.slice(-15) });
  }

  /* B9: sweep a setting and keep the receipt. The sweep itself is driven by the PANEL, which is the
     only thing that can apply a rendering dial and measure its own cost — the bridge stores the
     receipt so it survives the page being closed and can be compared against later. */
  if (p === '/api/sweep') {
    if (req.method === 'POST') {
      if (MODE === 'viewer') return json(res, 403, { error: 'viewer mode does not run experiments' });
      return readBody(req, (b) => {
        const r = b && b.receipt;
        if (!r || !r.name) return json(res, 400, { error: 'need a receipt' });
        try {
          journal.write([{ sev: 'info', kind: 'act',
            msg: `sweep "${r.name}": ${r.distinguishable ? 'best ' + JSON.stringify(r.best) : 'no measurable difference'}` }]);
          const line = JSON.stringify({ ...r, trace: undefined, at: Date.now() });
          require('fs').appendFileSync(require('path').join(HIST_DIR, 'sweeps.jsonl'), line + '\n');
        } catch (e) { return json(res, 500, { error: e.message }); }
        return json(res, 200, { ok: true });
      });
    }
    let rows = [];
    try {
      rows = require('fs').readFileSync(require('path').join(HIST_DIR, 'sweeps.jsonl'), 'utf8')
        .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch { /* none yet */ }
    return json(res, 200, { receipts: rows.slice(-40) });
  }

  if (p === '/api/schedule') {
    return json(res, 200, { scheduler: jobs.status(), trial: boot.status() });
  }

  if (p === '/api/correlate') {
    const win = Math.max(60, Math.min(3600, +url.searchParams.get('n') || 1200));
    return json(res, 200, correlate(hist.recent(win)));
  }

  /* B18: what this machine's own outcomes ledger says about each rule that is firing. */
  if (p === '/api/quarantine') {
    const d = currentDiagnosis();
    const ids = [...new Set((d.findings || []).map((f) => f.id))];
    return json(res, 200, { rules: ids.map((id) => outcomes.quarantine(id)) });
  }

  if (p === '/api/hardware') return json(res, 200, cachedHw || { pending: true,
    note: PS_HOST ? 'not collected yet' : 'this platform has no hardware one-shot' });

  /* ---- automations ----
     GET is a read of what this machine has earned; the two POSTs change what it may do unasked,
     so they sit behind the same mutating-method gate as every other lever. */
  /* COUNTS ONLY, for the nav badge. The badge poll runs every 10 s forever, and answering it with
     the full list() meant four evidenceFor() calls, each reading and parsing the whole outcomes
     ledger — 237 KB today, growing ~17 MB a year — four times, every ten seconds, to produce one
     integer. The badge needs a number; this returns the number. */
  if (p === '/api/automations' && url.searchParams.get('counts') === '1') {
    return json(res, 200, { proposals: pendingProposals.length });
  }
  if (p === '/api/automations') {
    /* WHAT IT ACTUALLY DID, on the same page that offers to let it. An automations screen with no
       record of its own automatic runs asks for a standing permission and then never reports on
       it — which is the shape of every background process anyone has ever regretted enabling. */
    return json(res, 200, {
      ...automations.list({ aiGranted: aiAccess.grant().on, has: { powershell: !!PS_HOST } }),
      proposals: pendingProposals,
      history: outcomes.recent(4000).filter((r) => r.ev === 'auto').slice(-60).reverse(),
    });
  }
  if (req.method === 'POST' && (p === '/api/automations/arm' || p === '/api/automations/disarm')) {
    return readBody(req, (b) => {
      const id = b && b.id ? String(b.id) : '';
      if (p === '/api/automations/disarm') return json(res, 200, automations.disarm(id));
      /* NO `force` FROM THE WIRE. The suite uses it to reach paths that would otherwise need a
         month of history; exposing it over HTTP would make the earning rule optional, which is
         the same as not having it. The only way past the record is to build the record. */
      const r = automations.arm(id, { aiGranted: aiAccess.grant().on, has: { powershell: !!PS_HOST } });
      return json(res, r.error ? 400 : 200, r);
    });
  }
  if (req.method === 'POST' && p === '/api/automations/targets') {
    return readBody(req, (b) => {
      const r = automations.setTargets(b && b.id ? String(b.id) : '', (b && b.keys) || []);
      return json(res, r.error ? 400 : 200, r);
    });
  }
  if (req.method === 'POST' && p === '/api/automations/dismiss') {
    return readBody(req, (b) => {
      const id = b && b.id ? String(b.id) : '';
      pendingProposals = pendingProposals.filter((x) => x.id !== id);
      return json(res, 200, { ok: true, remaining: pendingProposals.length });
    });
  }

  /* ---- screen peek: the only thing in VITALS that looks at the display ----
     A brightness grid of one screen rectangle, for the FX strip's thermal read. GET because it
     changes nothing — but it READS something more sensitive than anything else here, so it carries
     its own rules rather than inheriting the ordinary read path:
       · the worker starts on the first request and dies 20 s after the last;
       · the grid is capped, luminance-only, and never written to disk;
       · every sample is counted, and /api/peek/status reports the count, so "is it looking at my
         screen" is answerable from the panel instead of taken on trust.
     Viewer mode is allowed it: viewer's rule is that it may not CHANGE the machine, and this does
     not. The control that matters here is the owner's toggle, which is off by default. */
  /* ---- THE SCREEN-READ WINDOW ----
     Every rule written for this feature guarded the OWNER'S switch: off by default, counted, named
     in the caption, refused to viewer. None of them guarded the SOFTWARE. The route was reachable
     by anything that could talk to the bridge, so an agent was handed the endpoint and sampled the
     owner's screen 2,129 times before he noticed — not by exploiting anything, just by asking. The
     disclosure worked; the permission did not exist.
     So a request to read the screen now needs an open WINDOW, opened by a human with the admin
     passphrase, confirmed, and self-expiring — the same shape as developer mode, and for a stronger
     reason: that one widens what an agent may be TOLD, this one decides whether the software may
     LOOK. An agent can still ask. It just cannot be the one who says yes. */
  if (p === '/api/peek/status') {
    /*  lets the panel HIDE the control on a host that cannot do this, instead of
       prompting for an admin passphrase and a duration and then 501-ing. A control that asks you to
       authenticate for something it cannot do is worse than an absent one. */
    return json(res, 200, { available: !!PS_HOST, ...peek.status(), ...screenGrant() });
  }
  if (req.method === 'POST' && p === '/api/peek/open') {
    return readBody(req, (b) => {
      if (!hasAdminPass()) {
        return json(res, 400, { error: 'set an admin passphrase first',
          detail: 'Reading the screen is the one thing this software does that looks outside '
                + 'itself. It is not available without a passphrase to gate it.' });
      }
      if (passRateLimited()) return json(res, 429, { error: 'too many attempts — wait a minute' });
      if (!checkAdminPass(b && b.pass)) { notePassFailure(); return json(res, 403, { error: 'wrong passphrase' }); }
      if (!b || b.confirm !== true) return json(res, 400, { error: 'not confirmed' });
      const mins = Math.max(1, Math.min(SCREEN_MAX_MIN, parseInt(b.minutes, 10) || 15));
      const now = Date.now();
      /* The token is the permission. Returned ONCE, here, to the caller who proved the passphrase —
         and never repeated by any other route, so possessing it means having been through this door
         rather than having asked politely afterwards. */
      const token = require('crypto').randomBytes(24).toString('hex');
      SCREEN = { openedAt: now, until: now + mins * 60_000, token, why: String(b.why || '').slice(0, 200), reads: 0 };
      aiAccess.note({ ev: 'screen-opened', minutes: mins, until: SCREEN.until });
      return json(res, 200, { ok: true, token, ...screenGrant() });
    });
  }
  if (req.method === 'POST' && p === '/api/peek/close') {
    SCREEN = null;
    try { peek.stop(); } catch {}
    aiAccess.note({ ev: 'screen-closed' });
    return json(res, 200, { ok: true, ...screenGrant() });
  }
  if (p === '/api/peek') {
    /* THE GATE, before anything else in this handler. Refused with the reason and the way to open
       it, because an agent that is told "no" and why can report that to its owner, whereas one
       that gets an opaque 403 will reasonably conclude the feature is broken and try harder. */
    const gr = screenGrant();
    if (!gr.screenOpen) {
      return json(res, 200, { error: 'the screen-read window is closed', refused: 'not-open',
        detail: 'Reading the screen needs a window opened by a human: POST /api/peek/open with the '
              + 'admin passphrase and confirm:true. It expires by itself, and it closes when this '
              + 'process does. This cannot be opened by the thing that wants to read.' });
    }
    /* AND THE TOKEN. An open window is not a public window — that was the whole defect: a window
       opened for the FX strip made the screen readable by every client that could reach this port,
       and a reviewing agent read it by accident on somebody else's grant. The permission belongs to
       the caller who proved the passphrase, not to the socket. */
    if (!screenTokenOk(url.searchParams.get('token'))) {
      return json(res, 200, { error: 'a screen-read window is open, but not for you',
        refused: 'not-your-window',
        detail: 'The token issued when the window was opened must be presented as ?token=. Another '
              + 'caller holding a window does not make the screen readable by anyone else.' });
    }
    SCREEN.reads++;
    const n = (k, d) => { const v = parseInt(url.searchParams.get(k), 10); return Number.isFinite(v) ? v : d; };
    /* CLAMPED TO WHAT SHIPS. The cap was 128x128 = 49,152 bytes of colour — icon resolution,
       recognisable — while the panel has only ever asked for 64x24 = 4,608. An API ceiling nobody
       uses is not a spare capability, it is the number an auditor is entitled to hold you to. The
       header in peek.js now claims this bound; here is where the claim is made true. */
    const gw = Math.max(1, Math.min(PEEK_MAX_W, n('gw', 64))), gh = Math.max(1, Math.min(PEEK_MAX_H, n('gh', 24)));
    return peek.sample(n('x', 0), n('y', 0), n('w', 0), n('h', 0), gw, gh)
      .then((r) => json(res, 200, { gw: r.gw, gh: r.gh, grid: Buffer.from(r.grid).toString('base64') }))
      /* 200 with an `error`, not a 5xx: "the screen could not be read" is a normal answer here (the
         worker is starting, a sample is already in flight, the host has no PowerShell) and the
         caller's correct response to all of them is the same — carry on without a reading. */
      .catch((e) => json(res, 200, { error: e.message }));
  }

  if (p === '/api/alerts') {
    if (req.method === 'POST') {
      /* Viewer mode may not change how the machine behaves, and silencing the alarm is a change
         to how the machine behaves. */
      if (MODE === 'viewer') return json(res, 403, { error: 'viewer mode cannot change alerting' });
      notifier.enabled = url.searchParams.get('on') !== '0';
      return json(res, 200, notifier.status());
    }
    return json(res, 200, notifier.status());
  }

  /* A one-shot so someone can find out whether notifications actually reach them on THIS machine,
     rather than discovering the answer during the incident the feature exists for. */
  if (p === '/api/alerts/test') {
    if (MODE === 'viewer') return json(res, 403, { error: 'viewer mode cannot send notifications' });
    return notifier.probe()
      .then(() => notifier.deliver('Test notification',
        'If you can read this, VITALS can reach you when the panel is closed.'))
      .then((ok) => json(res, 200, { ok, how: notifier.how, capable: notifier.capable }))
      .catch((e) => json(res, 500, { ok: false, error: e.message }));
  }

  if (p === '/api/diagnose') {
    const d = currentDiagnosis();
    /* VIEWER STRIPS PATHS FROM THE FINDINGS. The 403 on the file routes promised that viewer reports
       "how the machine is performing, not what is stored on it" - and then the growth rule handed
       over `evidence: [absolute paths]` and a title that is the bare account name, through the one
       route deliberately left open. The promise was false whenever an MFT snapshot existed.
       Same redaction ask.js uses for the same reason: shape for the paths nobody predicted, value
       for the identifiers we already know. */
    return json(res, 200, MODE === 'viewer' ? scrubFindings(d) : d);
  }

  /* B1: REWIND. The same engine, pointed at a past moment instead of the live ring.
     `t` is epoch ms. The response always carries `unavailable` - the archive holds what was
     archived, and a rewound diagnosis is systematically shorter than a live one, so a quiet list
     without that caveat would read as a quiet machine. Viewer redaction applies identically:
     history is not a loophole in a promise made about the present. */
  if (p === '/api/diagnose/at') {
    const t = +url.searchParams.get('t');
    if (!Number.isFinite(t) || t <= 0) return json(res, 400, { error: 'need ?t=<epoch ms>' });
    if (t > Date.now()) return json(res, 400, { error: 'that moment has not happened yet' });
    /* systemVolume(), not a two-name find. This one had no fallback at all, so a Windows install on
       D: or an unusual mount layout produced `undefined` rather than a volume - the same class of
       Windows assumption diagnose.js and outcomes.js were already fixed for, found by grepping the
       tree after the second one. */
    const liveVol = systemVolume(latest);
    let d;
    try {
      d = diagnoseAt(hist, t, { outcomes, liveVolId: liveVol ? liveVol.id : null });
    } catch (e) {
      console.error('[rewind]', e.message);
      return json(res, 500, { error: 'rewind failed', detail: e.message });
    }
    return json(res, 200, MODE === 'viewer' ? { ...scrubFindings(d), unavailable: d.unavailable } : d);
  }

  /* The outcomes ledger, readable: open findings with their lever history, plus the raw tail. */
  /* /api/outcomes persists the same finding titles, so it needs the same scrub for the same reason. */
  if (p === '/api/outcomes') {
    const payload = { active: outcomes.active, recent: outcomes.recent(+url.searchParams.get('n') || 120) };
    /* THE COMMENT ABOVE THIS ROUTE USED TO CLAIM THIS SCRUB WITHOUT DOING IT. The ledger persists
       finding TITLES and lever records - the live one currently holds an account name in
       active.growth.title, and kill/ctl entries carry process names and parameters - and it was
       served verbatim to viewer sessions. I fixed the neighbouring route and wrote a note here
       instead of code, which is worse than having done neither: a reader trusts the note.
       scrubDeep walks everything, so a field added later is covered without anyone remembering. */
    return json(res, 200, MODE === 'viewer' ? scrubDeep(payload) : payload);
  }

  /* MFT-backed disk browser. Once a snapshot exists the explorer is pure lookup — no rescan per
   * level, so descending is instant instead of the multi-second walk it replaces. */
  if (p === '/api/mft') {
    const snaps = hist.snapshots();
    if (!snaps.length) return json(res, 200, { none: true });
    const snap = hist.readSnapshot(url.searchParams.get('file') || snaps[0].file);
    if (!snap) return json(res, 500, { error: 'snapshot unreadable' });
    const root = (url.searchParams.get('path') || snap.drive + '\\').replace(/\\+$/, '') + '\\';
    const depth = root.split('\\').filter(Boolean).length;
    const kids = snap.entries.filter((e) => {
      if (!e.path.startsWith(root)) return false;
      return e.path.split('\\').filter(Boolean).length === depth + 1;
    }).sort((a, b) => b.bytes - a.bytes).slice(0, 40);
    const self = snap.entries.find((e) => e.path + '\\' === root || e.path === root.slice(0, -1));
    return json(res, 200, {
      takenAt: snap.takenAt, scanMs: snap.scanMs, files: snap.files, dirs: snap.dirs,
      totalGB: +(snap.totalBytes / 2 ** 30).toFixed(1),
      root, selfGB: self ? +(self.bytes / 2 ** 30).toFixed(2) : null,
      ownGB: self ? +(self.own / 2 ** 30).toFixed(2) : null,
      kids: kids.map((k) => ({ name: k.path.split('\\').pop(), path: k.path, gb: +(k.bytes / 2 ** 30).toFixed(2) })),
    });
  }

  /* Triggers the elevated scanner. The bridge itself stays unelevated — this hands the privilege
   * request to Windows, which shows the user a UAC prompt they can refuse. */
  if (req.method === 'POST' && p === '/api/mftscan') {
    const script = path.join(HERE, 'mftscan.ps1');
    const log = path.join(HIST_DIR, 'scan.log');
    execFile(PS, [...PS_ARGS, '-Command',
      `Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-Command',"& '${script}' *> '${log}'")`],
      { windowsHide: true }, (e) => { if (e) console.error('[mftscan]', e.message); });
    return json(res, 200, { started: true, note: 'accept the UAC prompt; ~10s for a 476 GB volume' });
  }

  if (p === '/api/scanlog') {
    /* readTextFile, not readFileSync(...,'utf8'): mftscan's log is written by a PowerShell `*>`
       redirection, which in PS 5.1 is UTF-16LE with a BOM. Read as utf8 it served mojibake. */
    try { return json(res, 200, { log: readTextFile(path.join(HIST_DIR, 'scan.log')) }); }
    catch { return json(res, 200, { log: '' }); }
  }

  if (req.method === 'POST' && p === '/api/iotrace') {
    const script = path.join(HERE, 'iotrace.ps1');
    const out = path.join(HIST_DIR, 'iotrace.json');
    const secs = 10;
    execFile(PS, [...PS_ARGS, '-Command',
      `Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${script}','-Seconds','${secs}','-Out','${out}')`],
      { windowsHide: true }, (e) => { if (e) console.error('[iotrace]', e.message); });
    return json(res, 200, { started: true, seconds: secs });
  }

  if (p === '/api/iotrace') {
    try { return json(res, 200, readJsonFile(path.join(HIST_DIR, 'iotrace.json'))); }
    catch (e) { return json(res, 200, { none: true, why: e.message }); }
  }

  /* ---------- window control ---------- */
  if (p.startsWith('/api/win/')) {
    const verb = p.slice(9);
    const q = url.searchParams;
    const map = {
      attach:    { cmd: 'attach' },
      frameless: { cmd: 'frameless' },
      round:     { cmd: 'round', r: +q.get('r') || 14 },
      alpha:     { cmd: 'alpha', a: Math.max(60, Math.min(255, +q.get('a') || 240)) },
      top:       { cmd: 'top', on: q.get('on') !== '0' },
      drag:      { cmd: 'drag' },
      min:       { cmd: 'min' },
      close:     { cmd: 'close' },
      rect:      { cmd: 'rect' },
      size:      { cmd: 'size', w: +q.get('w') || 1120, h: +q.get('h') || 740, r: +q.get('r') || 14 },
    };
    if (!map[verb]) return json(res, 404, { error: 'unknown window verb' });
    return win(map[verb], (e, d) => json(res, e ? 500 : 200, e ? { error: e.message } : d));
  }

  /* Every actuation is a LEVER in the outcomes ledger, tagged with whichever findings were open
   * when it was pulled — that linkage is what lets the next firing of the same finding say what
   * worked last time, with the measured delta attached. */
  /* ---- CTRL: the machine's own dials (2026-07-29). Whitelisted, probe-verified actions only;
   * baseline captured before the first write of any key; every pull ledgered with a metric
   * snapshot. The bridge stays unelevated — anything behind the elevation wall is NOT here. */
  if (p === '/api/ctl/state') {
    return ctl.state((e, d) => json(res, e ? 500 : 200, e ? { error: e.message }
      : { state: d, baseline: ctl.baseline, recent: ctl.recent(8) }));
  }
  if (req.method === 'POST' && p === '/api/ctl') {
    return readBody(req, (b) => ctl.act(b.act, b, latest, (e, d) => {
      if (!e) outcomes.lever('ctl', { act: b.act, params: d && d.before !== undefined ? { ...b, before: d.before } : b }, latest);
      json(res, e ? 400 : 200, e ? { error: e.message } : d);
    }));
  }
  if (req.method === 'POST' && p === '/api/ctl/restore') {
    return readBody(req, (b) => ctl.restore(b.act || null, latest, (e, d) =>
      json(res, e ? 500 : 200, e ? { error: e.message } : d)));
  }

  if (req.method === 'POST' && p === '/api/kill') {
    return readBody(req, (b) => killProcess(b.pids || [], (e) => {
      if (!e) outcomes.lever('kill', { pids: b.pids || [], name: b.name || '' }, latest);
      json(res, e ? 500 : 200, e ? { error: e.message } : { ok: true });
    }));
  }
  if (req.method === 'POST' && p === '/api/clean') {
    return readBody(req, (b) => clean(b.key, (e, d) => {
      if (!e && d && d.ok) outcomes.lever('clean', { key: b.key, freedGB: d.freedGB }, latest);
      json(res, e ? 500 : 200, e ? { error: e.message } : d);
    }));
  }
  if (req.method === 'POST' && p === '/api/task') {
    return readBody(req, (b) => toggleTask(b.name || '', !!b.enable, (e, d) => {
      if (!e && d && d.ok) outcomes.lever('task', { name: b.name || '', enable: !!b.enable }, latest);
      json(res, e ? 500 : 200, e ? { error: e.message } : d);
    }));
  }

  /* ---- the journal, persisted (2026-07-29) ----
   * POST is a BATCH: the page queues crossings and flushes, so a burst of eight threshold events is
   * one request. GET backfills the console on load, which is the whole point - before this the record
   * died with the window. */
  if (req.method === 'POST' && p === '/api/journal') {
    return readBody(req, (b) => json(res, 200, journal.write(b && b.entries)));
  }
  if (p === '/api/journal') {
    const days = Math.max(1, Math.min(14, parseInt(url.searchParams.get('days') || '2', 10)));
    const limit = Math.max(1, Math.min(2000, parseInt(url.searchParams.get('limit') || '400', 10)));
    return json(res, 200, { entries: journal.recent(days, limit), stats: journal.stats() });
  }

  /* ---- support bundle: everything a second pair of eyes would ask for, in one folder ---- */
  if (req.method === 'POST' && p === '/api/bundle') {
    return readBody(req, (b) => buildBundle(b || {}, (e, d) => json(res, e ? 500 : 200, e ? { error: e.message } : d)));
  }
  /* So the UI (and an agent) can render the section list without hard-coding it here and there. */
  if (p === '/api/bundle') {
    return json(res, 200, { sections: Object.entries(BUNDLE_SECTIONS).map(([k, v]) => ({ key: k, what: v.what })) });
  }

  /* ---- restart an app (owner-approved) ----
   * Graceful first (CloseMainWindow, which lets the app run its own save/exit path), force only if it
   * refuses, then relaunch from the SAME image path it was running. Refuses anything on the
   * system-critical list and anything whose path cannot be resolved - relaunching a guess is worse
   * than not relaunching. */
  if (req.method === 'POST' && p === '/api/restartapp') {
    return readBody(req, (b) => restartApp(String(b && b.name || ''), (e, d) => {
      if (!e && d && d.ok) outcomes.lever('restart-app', { name: d.name, pids: d.pids || [] }, latest);
      json(res, e ? 500 : 200, e ? { error: e.message } : d);
    }));
  }

  /* ---- open the Recycle Bin (NON-destructive on purpose) ----
   * The owner asked to keep this style: the tool surfaces the size and the reasoning, Explorer owns
   * the click that destroys data. So this opens the folder and does nothing else. */
  /* ---- ASK: a Claude conversation grounded in this machine ----
   * Streams over SSE so the answer types out instead of arriving as a wall after a silent minute.
   * The reply is written to ask-log.json by the Ask class, so the thread survives a reload. */
  /* ASKING AND WATCHING ARE NOW SEPARATE.
   *
   * The old handler streamed the reply down the same POST that started it and cancelled the run when
   * that response closed. That made the asking window life support: reload it, navigate away, or pop
   * the chat into its own window mid-answer, and the work died - silently, because a cancelled run
   * and a finished one arrived at the same place.
   *
   * POST now only STARTS the run and returns immediately. Every viewer - the main panel, a popped-out
   * chat window, a second machine's window later - watches /api/ask/stream instead, and none of them
   * owns the run's lifetime. Stopping is explicit, via /api/ask/stop, because that is the only case
   * where the user actually meant to end it. */
  if (req.method === 'POST' && p === '/api/ask') {
    return readBody(req, (b) => {
      const q = String((b && b.q) || '').trim();
      if (!q) return json(res, 400, { error: 'empty question' });
      if (ask.busy()) return json(res, 409, { error: 'a question is already running' });
      /* Refused HERE as well as inside run(). The engine check is the one that actually prevents a
         process being spawned; this one exists so the caller gets a real status code instead of a
         cheerful 202 followed by an error arriving on a stream it may not be watching. */
      if (!ask.enabled()) {
        return json(res, 409, {
          error: 'Ask is not connected',
          detail: 'Nothing is sent anywhere until Ask is enabled on its page. Connect it there first.',
        });
      }
      let diag = null; try { diag = currentDiagnosis(); } catch {}
      ask.run(q, latest, diag);          // events reach every subscriber; nobody here waits
      json(res, 202, { started: true });
    });
  }

  /* OPEN A SECOND NATIVE WINDOW onto this same bridge.
   *
   * Only a PATH is accepted, never a URL. The caller sends "/?view=ask" and the host builds
   * http://127.0.0.1:<our port><path> itself, so this route cannot be talked into opening a window
   * onto anything but the local bridge - not a remote host, not a file:// path, not another origin -
   * regardless of what asks it to. The page is the only caller today, but a route that opens windows
   * on demand is exactly the kind of thing that gets reached by something else later.
   *
   * Returns opened:false rather than an error when there is no native host, because the page has a
   * perfectly good window.open fallback and a browser-hosted panel should not see a failure for
   * using the path that is correct for it. */
  if (req.method === 'POST' && p === '/api/window/open') {
    return readBody(req, (b) => {
      if (!PS_HOST) return json(res, 200, { opened: false, reason: 'no native host on ' + process.platform });
      let rel = String((b && b.url) || '/');
      /* Accept a full URL only to extract its path+query; anything absolute is reduced to its path,
         and a path that does not start with a single slash is rejected outright rather than
         normalised, since "//evil.example" is a protocol-relative URL wearing a path's clothing. */
      try { const u = new URL(rel, 'http://127.0.0.1'); rel = u.pathname + u.search; } catch {}
      if (!/^\/[^/\\]*/.test(rel)) return json(res, 400, { error: 'bad path' });

      /* ONE WINDOW PER VIEW. Clicking "pop out" twice used to start a second host: two chat windows
         on the same thread, both live, neither wrong - just pointless clutter you then have to close
         one at a time. A view is a place to look at something, and there is only one of each. */
      const existing = childWindows.get(rel);
      if (existing && isAlive(existing.pid)) {
        raiseWindow(existing.pid);
        return json(res, 200, { opened: true, path: rel, already: true, pid: existing.pid });
      }

      const w = Math.max(320, Math.min(3840, parseInt(b && b.w, 10) || 520));
      const h = Math.max(320, Math.min(2160, parseInt(b && b.h, 10) || 680));
      const title = String((b && b.title) || 'VITALS').replace(/[^\w .·+-]/g, '').slice(0, 40) || 'VITALS';
      /* Match the parent's always-on-top band. A non-topmost window cannot be drawn above a topmost
         one at all, so with the panel pinned the pop-out appeared behind it no matter how it was
         raised - the fix is not more raising, it is the same band. */
      const wantTop = !!(b && b.top);

      try {
        /* TWO SPAWN DETAILS, both found by isolating options one at a time after the route cheerfully
           reported {opened:true} while nothing appeared on screen - the worst failure shape there is,
           because it looks like the click did nothing rather than like an error.
             NO `detached: true`. On Windows that means DETACHED_PROCESS, so the child gets no
           console, PowerShell exits 0 immediately and the WinForms message loop never runs. Measured:
           detached -> exit 0, no window; not detached -> window every time. `unref()` is what actually
           frees the bridge's event loop.
             NOT PS_ARGS: it carries -NonInteractive, which is correct for every other script here and
           wrong for a process that has to pump UI. launch.ps1 has always omitted it. */
        const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass',
          '-File', path.join(HERE, 'panel.ps1'),
          '-Port', String(PORT), '-Path', rel, '-Width', String(w), '-Height', String(h),
          '-Title', title];
        if (!wantTop) args.push('-NoTop');
        const child = spawn(PS, args, { stdio: 'ignore', windowsHide: true });
        child.on('error', (e) => { console.error('[window] ' + e.message); childWindows.delete(rel); });
        child.on('exit', () => { childWindows.delete(rel); });
        child.unref();
        childWindows.set(rel, { pid: child.pid, title });
        json(res, 200, { opened: true, path: rel, pid: child.pid });
      } catch (e) {
        json(res, 200, { opened: false, reason: e.message });
      }
    });
  }

  /* CLOSE THE CHILD WINDOWS. Called by the main panel as it closes.
   *
   * The windows are views of one application, not separate programs, so leaving a chat window
   * behind after its panel is gone strands it: no rail, no way back to the rest, and nothing on
   * screen explaining what it still belongs to. The BRIDGE deliberately keeps running - that is the
   * documented "close the window, keep the record" behaviour, and history, journal and diagnosis
   * carry on - but the UI closes as one thing. */
  if (req.method === 'POST' && p === '/api/window/close-children') {
    let closed = 0;
    for (const [rel, info] of [...childWindows]) {
      if (isAlive(info.pid)) { closeWindow(info.pid); closed++; }
      childWindows.delete(rel);
    }
    return json(res, 200, { closed });
  }

  /* The shared stream. Any number of windows may hold this open, and closing one has no effect on
     the run or on the others. */
  if (p === '/api/ask/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
                         Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    const send = (o) => { try { res.write(`data: ${JSON.stringify(o)}\n\n`); } catch {} };
    /* THE SERVER OWNS THE THREAD, and says so on every connect.
     *
     * Sending only the in-flight reply was not enough. EventSource reconnects on its own after any
     * drop - a sleeping laptop, a proxy timeout, a bridge restart - and if a run STARTED AND FINISHED
     * during that gap, the window missed the text and done events and had no way to learn about them:
     * the next hello carried a null `live`, because by then nothing was in flight. That window was
     * then permanently missing an exchange the other windows had, which is exactly "not the same
     * thread".
     *
     * So hello carries the canonical message list. A reconnecting window resyncs to the server rather
     * than trusting whatever it had accumulated locally, and every window converges on identical
     * content no matter what it missed or when it joined. */
    send({ type: 'hello', ...ask.snapshot(), messages: ask.state.messages.slice(-60) });
    /* The same reasoning applies at the END of a run: the saved message is the canonical one (it
       carries the stopped marker and the trimmed history), so `done` re-broadcasts the thread and
       every window lands on the same bytes rather than on its own reconstruction of the stream. */
    const off = ask.subscribe((ev) => {
      if (ev && (ev.type === 'done' || ev.type === 'error')) {
        send({ ...ev, messages: ask.state.messages.slice(-60) });
      } else send(ev);
    });
    /* MUST unsubscribe. Without this every reload leaks a callback that keeps writing to a dead
       response for the life of the process - the subscriber Set only ever grows. */
    const bye = () => { off(); clearInterval(ka); };
    res.on('close', bye);
    res.on('error', bye);
    /* A comment line every 25 s so proxies and sleeping laptops do not silently drop an idle stream;
       EventSource reconnects on its own, but a half-open socket looks alive and never fires. */
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { bye(); } }, 25000);
    return;
  }
  if (req.method === 'POST' && p === '/api/ask/stop') return json(res, 200, { stopped: ask.stop() });
  /* Model, effort and the optional API key. The key is write-only over this API: it can be set and
     cleared, and the response only ever reports that one EXISTS plus its last four characters. */
  if (req.method === 'POST' && p === '/api/ask/config') {
    /* ADMIN ONLY. Connecting Ask is the single control in this product that sends anything off the
       machine and spends the owner's subscription - and it was the one such control the restricted
       party could still flip. The whole point of making it opt-in was that the decision belongs to
       the owner, which viewer mode is explicitly not. */
    if (MODE === 'viewer') return json(res, 403, {
      error: 'viewer mode cannot connect Ask or change its credentials',
      detail: 'Connecting Ask sends machine data to an external service and spends a subscription. ' +
              'That decision belongs to whoever holds admin.',
    });
    return readBody(req, (b) => {
      const patch = {};
      if (typeof b.model === 'string') patch.model = b.model.trim().slice(0, 60);
      if (typeof b.effort === 'string') patch.effort = ['', 'low', 'medium', 'high', 'xhigh', 'max'].includes(b.effort) ? b.effort : '';
      if (typeof b.apiKey === 'string') patch.apiKey = b.apiKey.trim().slice(0, 200);
      /* Connecting and disconnecting are both explicit. Disconnecting does not clear the key or the
         model - turning a thing off should not also discard how you had it set up. */
      if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
      json(res, 200, ask.saveCfg(patch));
    });
  }
  /* The full thread for a window that has just opened. `live` carries an in-flight reply so the
     initial paint already shows work in progress, before the stream delivers its first delta. */
  if (p === '/api/ask') return json(res, 200, { messages: ask.state.messages.slice(-60),
                                                sessionId: ask.state.sessionId,
                                                ...ask.snapshot(),
                                                ...ask.publicCfg() });

  /* ---- file tools: biggest, newest, and who has it open ----
   * All three are one script and all three are ON DEMAND. None of them belongs on a tick: a tree walk
   * is seconds of disk, and "what has this file open" is a question, not a metric. */
  if (p === '/api/files') {
    const mode = (url.searchParams.get('mode') || 'big').replace(/[^a-z]/g, '');
    if (!['big', 'new', 'locked'].includes(mode)) return json(res, 400, { error: 'bad mode' });
    const a = ['-Mode', mode];
    const root = url.searchParams.get('root'); if (root) a.push('-Root', root);
    const fp = url.searchParams.get('path');   if (fp) a.push('-Path', fp);
    const mins = parseInt(url.searchParams.get('minutes') || '0', 10); if (mins) a.push('-Minutes', String(mins));
    const top = parseInt(url.searchParams.get('top') || '0', 10);      if (top) a.push('-Top', String(top));
    return execFile(PS, [...PS_ARGS, '-File', path.join(HERE, 'filetools.ps1'), ...a],
      { maxBuffer: 24 * 1024 * 1024, windowsHide: true, timeout: 60000 },
      (e, so, se) => {
        if (e && !so) return json(res, 500, { error: (se || e.message || '').slice(0, 400) });
        try { json(res, 200, JSON.parse(so || 'null')); }
        catch { json(res, 500, { error: 'bad JSON from filetools: ' + (se || '').slice(0, 300) }); }
      });
  }

  /* ---- clipboard history: opt-in, and the status always says which it is ---- */
  if (req.method === 'POST' && p === '/api/clip') {
    return readBody(req, (b) => {
      const r = b && b.on ? clipStart() : clipStop();
      json(res, 200, { ...r, stats: clipStats() });
    });
  }
  if (p === '/api/clip') {
    const days = parseInt(url.searchParams.get('days') || '7', 10);
    const limit = parseInt(url.searchParams.get('limit') || '200', 10);
    return json(res, 200, { entries: clipRead(days, limit), stats: clipStats() });
  }
  /* Serve a saved clip image. The filename is matched against a STRICT pattern and then joined to the
     clips directory - never taken as a path - so nothing outside that folder is reachable however the
     parameter is dressed up. */
  if (p === '/api/clip/img') {
    const f = url.searchParams.get('f') || '';
    if (!/^clip-[\w-]+\.png$/.test(f)) { res.writeHead(400); return res.end('bad name'); }
    const full = path.join(CLIPS_DIR, f);
    if (!full.startsWith(CLIPS_DIR) || !fs.existsSync(full)) { res.writeHead(404); return res.end('gone'); }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' });
    return fs.createReadStream(full).pipe(res);
  }
  /* Reveal a file or folder in Explorer. Used by the clipboard's file-drop rows, which are already
     paths the user themselves put on the clipboard. */
  if (req.method === 'POST' && p === '/api/reveal') {
    return readBody(req, (b) => {
      /* A saved clip is referred to by NAME and resolved here, so the page never has to know or guess
         where the clips folder is - and cannot ask for anything outside it. */
      let t = String((b && b.path) || '');
      if (b && b.clip) {
        if (!/^clip-[\w-]+\.png$/.test(b.clip)) return json(res, 400, { error: 'bad clip name' });
        t = path.join(CLIPS_DIR, b.clip);
      }
      if (!t || /["`|;&]/.test(t)) return json(res, 400, { error: 'bad path' });
      ps(`if(Test-Path -LiteralPath '${t.replace(/'/g, "''")}'){ Start-Process explorer.exe -ArgumentList '/select,"${t.replace(/'/g, "''")}"'; '{"ok":true}' } else { '{"ok":false,"err":"not found"}' }`,
        (e, d) => json(res, e ? 500 : 200, e ? { error: e.message } : d));
    });
  }

  if (req.method === 'POST' && p === '/api/openrecycle') {
    return ps(`Start-Process 'shell:RecycleBinFolder'; '{"ok":true}'`,
      (e) => json(res, e ? 500 : 200, e ? { error: e.message } : { ok: true }));
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`VITALS bridge  ->  http://127.0.0.1:${PORT}`);
  startMetrics();
  // startWinAgent() is deliberately NOT called here — see win() above.
});
