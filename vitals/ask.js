/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - ASK. A Claude conversation inside the panel, grounded in this machine's telemetry.
 *
 * It uses the Claude Code CLI's OWN STORED LOGIN, which is what makes it run on the subscription
 * rather than metered API billing. Two details from the ctrl+glass bridge are load-bearing and are
 * copied deliberately:
 *
 *   1. ANTHROPIC_API_KEY IS DELETED FROM THE CHILD ENV. A stale user-level key sitting in the
 *      environment takes precedence over the stored login and 401s the whole run. Removing it forces
 *      the CLI to authenticate the way the desktop app does.
 *   2. THE PROMPT GOES IN VIA STDIN, never as an argv element. On Windows the CLI is a .cmd shim so
 *      the child has to be spawned through a shell, and anything on that command line is exposed to
 *      shell parsing. stdin has no such surface.
 *
 * What makes this different from a generic chat box: every question is prefixed with a compact,
 * MEASURED description of the machine right now - the ranked diagnosis, the live sample, the top
 * processes. So "why is this slow" is answered against evidence instead of guesses, and the model is
 * told plainly which numbers it was handed and when.
 *
 * The conversation is persisted and resumed by session id, so it is one continuous thread across
 * reloads rather than a series of strangers.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';

/* Tool-permission globs use forward slashes on every platform, including Windows. */
const toGlob = (p) => String(p).split(String.fromCharCode(92)).join('/');

/* WHO THIS MACHINE BELONGS TO, so the grounding block can redact it by value rather than hoping a
   pattern catches it. Computed once: the account name, the home-directory leaf (which is usually the
   same but need not be) and the hostname. See scrub() in context() for why shape matching alone was
   not enough - a bare account name has no shape to match. */
const IDENTIFIERS = (() => {
  const os = require('os');
  const out = new Set();
  try { if (os.userInfo().username) out.add(os.userInfo().username); } catch {}
  /* Split on BOTH separators. Windows homedirs use backslashes, so splitting on '/' alone returns
     the whole path and the "leaf" becomes "C:\Users\name" - which then gets added as an identifier
     and matched as a literal, catching nothing. */
  try { const h = os.homedir(); if (h) out.add(h.split(/[\\/]/).filter(Boolean).pop()); } catch {}
  try { if (os.hostname()) out.add(os.hostname().split('.')[0]); } catch {}
  return [...out].filter(Boolean);
})();

class Ask {
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.logPath = path.join(dir, 'ask-log.json');
    this.cwd = opts.cwd || dir;
    /* RESOLVED PER RUN, not once at construction. The mode can change while the bridge is up, and a
       permission captured at startup means switching to viewer leaves this agent still able to write
       files - the exact hole viewer mode exists to close, left open by the object that was supposed
       to close it. A function is passed in so the answer is always asked for fresh. */
    this._permission = typeof opts.permissionMode === 'function'
      ? opts.permissionMode
      : () => (opts.permissionMode || 'acceptEdits');
    /* THE PRODUCT'S MODE, not the CLI's permission flag. Asked afresh each run for the same reason
       the permission is: it can change while the bridge is up.
       Why it is passed at all: viewer mode already STOPPED the agent acting - `plan` sees to that -
       but the agent had no idea WHY. Told to kill a process it answered "plan mode is active" and
       suggested re-running "outside plan mode", which is both the wrong vocabulary and wrong advice:
       in viewer that needs an admin unlock, not a flag. Enforcement never depends on the model
       knowing; telling it just means the refusal explains itself instead of confusing the user. */
    this._mode = typeof opts.mode === 'function' ? opts.mode : () => (opts.mode || 'admin');
    /* Which bridge the MCP server should talk to. Passed in rather than assumed, so a second
       install on VITALS_PORT=8791 does not hand its agent tools pointed at the first one. */
    this.port = opts.port || 8790;
    this.model = (opts.model || '').trim();
    /* Two AUTH MODES, chosen by whether a key has been saved, and the UI always says which is live:
     *   subscription - the CLI's stored login. ANTHROPIC_API_KEY is stripped from the child env so a
     *                  stale ambient key cannot take precedence and 401 the run.
     *   api key      - a key saved here, exported to the child. This is the path for a machine that
     *                  has the CLI installed but is not logged in, which is the portable-build case.
     * The key lives in its own file, never in the log and never in a support bundle. */
    /* THE SECRETS LIVE OUTSIDE cwd, and this is a structural fix replacing an enumerated one.
     *
     * The API key used to sit in history/ - inside the folder Ask runs in - and was protected by a
     * list of denied tools. That list grew from Read to Read+Edit to six tools, and it was still
     * incomplete: Grep's `path` argument is normally a DIRECTORY, so `Grep(pattern:"sk-ant",
     * path:"history")` never matched a rule naming the file, and `Bash` was not covered at all.
     * Every round added a rule and left a door.
     *
     * Outside `cwd`, no file tool can reach it without an explicit --add-dir that nothing passes.
     * The guarantee stops being "we thought of the tools" and becomes "it is not in scope" - which
     * is the standard every other boundary in this codebase already holds itself to. */
    this.secretDir = Ask.secretDir() || dir;
    this.cfgPath = path.join(this.secretDir, 'ask-config.json');
    /* OFF UNTIL CONNECTED, and off is the shipped default.
     *
     * Ask spawns a real Claude with this folder as its working directory and hands it a description
     * of the machine. That is a reasonable thing to want and an unreasonable thing to assume: a
     * monitor that starts talking to an external service because you installed it has made a
     * decision that was the owner's to make. So `enabled` starts false, the page shows what the
     * feature would do and a Connect button, and nothing is spawned and nothing leaves the machine
     * until someone presses it.
     * It is also the honest default for the free/agent tier, where the whole pitch is that the
     * thing runs offline and phones nobody. */
    this.cfg = { apiKey: '', model: '', effort: '', enabled: false };
    /* ONE-TIME MIGRATION for installs that predate the move. An existing user's key and model sat in
       history/; silently ignoring them would look like the upgrade wiped their settings. Moved
       rather than copied, because leaving the original behind would defeat the point of moving it. */
    try {
      const legacy = path.join(dir, 'ask-config.json');
      if (this.secretDir !== dir && fs.existsSync(legacy) && !fs.existsSync(this.cfgPath)) {
        fs.copyFileSync(legacy, this.cfgPath);
        fs.unlinkSync(legacy);
        console.error('[ask] moved ask-config.json out of the install folder to ' + this.secretDir);
      }
    } catch {}
    try {
      let t = fs.readFileSync(this.cfgPath, 'utf8');
      if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
      Object.assign(this.cfg, JSON.parse(t) || {});
    } catch {}
    this.child = null;
    this.stopped = false;
    this.state = { sessionId: '', messages: [] };
    /* THE RUN BELONGS TO THE BRIDGE, NOT TO WHOEVER ASKED.
     *
     * Originally the reply streamed down the same POST response that started it, and the bridge
     * cancelled the run when that response closed. That is the obvious design and it is wrong: it
     * makes the asker's window a life-support machine. Navigate away, reload the page, or pop the
     * chat into its own window while a diagnostic is running, and the work is destroyed - silently,
     * because a cancelled run and a completed one arrive at the same place.
     *
     * The whole point of asking a question that takes a minute is to go and do something else while
     * it is answered. So: subscribers come and go, the run does not notice. `live` holds the reply
     * as it accumulates so a view that connects halfway through sees the text so far rather than an
     * empty box and a spinner, and every subscriber sees the same stream. Cancelling is now only
     * ever explicit - the Stop button - because that is the only case where the user actually meant
     * to end it. */
    this.subs = new Set();
    this.live = null;   // { q, text, startedAt } while a run is in flight, else null
    try {
      let t = fs.readFileSync(this.logPath, 'utf8');
      if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
      const j = JSON.parse(t);
      if (j && Array.isArray(j.messages)) this.state = j;
    } catch {}
  }

  save() {
    try {
      /* Trim to the last 200 turns. The transcript the CLI keeps is the real archive; this file exists
         so the PANEL can redraw its thread, and an unbounded one would be read on every open. */
      if (this.state.messages.length > 200) this.state.messages = this.state.messages.slice(-200);
      fs.writeFileSync(this.logPath, JSON.stringify(this.state, null, 1));
    } catch {}
  }

  /* Per-user application data, outside the install folder entirely: %LOCALAPPDATA%\vitals on
     Windows, ~/.local/share/vitals or $XDG_DATA_HOME elsewhere. Created on demand. Falls back to the
     install folder ONLY if that cannot be created, because a key that fails to save is worse than a
     key stored somewhere merely imperfect. */
  static secretDir() {
    const os = require('os');
    const base = process.platform === 'win32'
      ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
      : (process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'));
    const dir = path.join(base, 'vitals');
    try { fs.mkdirSync(dir, { recursive: true }); return dir; } catch { return null; }
  }

  permissionMode() { try { return this._permission() || 'acceptEdits'; } catch { return 'plan'; } }
  mode() { try { return this._mode() || 'admin'; } catch { return 'viewer'; } }

  busy() { return !!this.child; }

  /* Any number of views may follow the same run. Returns an unsubscribe. */
  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }

  _emit(ev) { for (const fn of [...this.subs]) { try { fn(ev); } catch {} } }

  /* What a view needs to render the moment it connects, mid-run or not. Without the partial text a
     window opened halfway through a long answer shows nothing until the next delta - which on a
     thinking model can be many seconds of looking broken. */
  snapshot() {
    return {
      busy: this.busy(),
      /* How many views are attached. Exposed because a leak here is otherwise invisible: the Set only
         ever grows, and a missing unsubscribe would show up as a slow memory climb weeks later rather
         than as anything you could point at. A test can now assert it returns to baseline, and the UI
         can honestly say "2 windows watching". */
      watchers: this.subs.size,
      live: this.live ? { q: this.live.q, text: this.live.text, startedAt: this.live.startedAt } : null,
    };
  }

  saveCfg(patch) {
    Object.assign(this.cfg, patch || {});
    try { fs.writeFileSync(this.cfgPath, JSON.stringify(this.cfg, null, 1)); } catch {}
    return this.publicCfg();
  }
  /* The key itself never leaves the machine through this API - only whether one is set and its last
     four characters, which is enough to tell two keys apart without exposing either. */
  enabled() { return !!this.cfg.enabled; }

  publicCfg() {
    const k = this.cfg.apiKey || '';
    return {
      enabled: this.enabled(),
      hasKey: !!k,
      keyTail: k ? '…' + k.slice(-4) : '',
      authMode: k ? 'api key' : 'subscription (CLI login)',
      model: this.cfg.model || '',
      effort: this.cfg.effort || '',
      permissionMode: this.permissionMode(),
    };
  }

  /* The grounding block. Deliberately small and deliberately labelled: an agent handed forty numbers
     with no provenance will quote them with more confidence than they deserve. */
  context(tick, diag) {
    if (!tick) return 'No telemetry sample is available yet.';
    /* The system volume BY ROLE, not by name. `id === 'C:'` finds nothing on a Mac or a Linux box,
       and the resulting `{}` would have fed the model "undefined GB free of undefined GB" - the
       worst possible failure here, because unlike a blank gauge the model will happily reason on
       top of it and produce a confident answer about a disk it was never told the size of. */
    const vols = tick.disk?.vols || [];
    const v = vols.find((x) => x.id === 'C:') || vols.find((x) => x.id === '/')
              || vols.slice().sort((a, b) => (b.sizeGB || 0) - (a.sizeGB || 0))[0] || {};
    /* NO PROCESS NAMES IN THE BASELINE, and no identifiers lifted out of the findings.
     *
     * This block goes out with EVERY question, before the user has asked for anything - so whatever
     * sits in it is the FLOOR of what leaves the machine, not the ceiling. It used to carry six
     * process names and, through the growth finding, the account name. "Why is my disk full" does
     * not require knowing that Chrome is running, and it certainly does not require a username.
     *
     * That was defensible when the paste was the ONLY channel: the model had one shot and no way to
     * ask. It stopped being defensible the moment the MCP tools existed - vitals_processes,
     * vitals_growth and the rest are one call away, so detail can be FETCHED when a question
     * actually needs it. The baseline is anonymous numbers; identity is a deliberate act.
     *
     * The COUNT stays, because "16 processes" is a useful scale cue and names nobody. */
    const procCount = (tick.proc || []).length;

    /* Findings keep severity and title, with anything shaped like a path or a drive letter stripped.
       The titles are generated text rather than user input, but they interpolate MEASURED values -
       the growth rule names the folder that grew, which on a home directory is the account name.
       Redacting by SHAPE means a rule added later cannot leak by being careless.
       The `action` text is dropped entirely: it is advice for the user, not evidence for the model,
       and it is where paths are most likely to appear. */
    const scrub = (t) => {
      let out = String(t || '')
        .replace(/[A-Za-z]:\\[^\s,;]+/g, '<path>')
        .replace(/(?:\/[\w.-]+){2,}/g, '<path>')
        .replace(/\b[A-Za-z]:(?=\s|$)/g, '<volume>');
      /* SHAPE ALONE IS NOT ENOUGH, and this is the case that proved it. The growth rule reports the
         folder that grew, and for a home directory that is a BARE ACCOUNT NAME - no slashes, no
         drive letter, nothing path-shaped to match. "<account> grew 19.52 GB" sailed through every
         pattern above and went out with every question.
         So the identifiers are also redacted BY VALUE: we know what this machine's account and host
         are called, so they can be removed by name regardless of the shape they arrive in. Shape
         catches the paths nobody predicted; value catches the identifiers we already know. */
      for (const id of IDENTIFIERS) {
        if (id.length < 3) continue;                       // too short to match safely
        out = out.replace(new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '<account>');
      }
      return out;
    };
    const f = (diag?.findings || []).slice(0, 5)
      .map((x) => `- [${x.sevName}] ${scrub(x.title)}`).join('\n');
    return [
      `MACHINE STATE (measured ${new Date().toLocaleTimeString()}, one 1 Hz sample):`,
      /* Every field here is null-guarded, not just the disk ones. cpu.total is null on macOS until
         iostat emits its first data line, and pagesSec is null wherever fault counting is absent -
         and a prompt reading "cpu null%" invites the model to treat it as a number. Naming the gap
         is the only version of this that cannot mislead. */
      `cpu ${tick.cpu?.total != null ? tick.cpu.total + '%' : 'not yet measured'}` +
        ` | memory ${tick.mem?.pct}% of ${Math.round((tick.mem?.totalMB || 0) / 1024)}GB` +
        (tick.mem?.pagesSec != null ? ` | hard faults ${tick.mem.pagesSec}/s` : ' | hard faults not measurable here'),
      /* Null-safe on purpose: macOS cannot report disk busy or queue depth, and a literal "null%"
         in the prompt is far better than a fabricated 0 the model would treat as an idle disk. */
      /* A Windows volume id already ends in a colon ("C:"), a POSIX one does not ("/"). */
      `${(v.id || 'system volume').replace(/:$/, '')}: ${v.freeGB}GB free of ${v.sizeGB}GB (${v.pct}% used)` +
        (tick.disk?.io?.busyPct != null ? ` | disk busy ${tick.disk.io.busyPct}%` : ' | disk busy not measurable on this platform') +
        (tick.disk?.io?.queue != null ? ` queue ${tick.disk.io.queue}` : ''),
      tick.gpus?.ads?.length ? `gpu per adapter: ${tick.gpus.ads.map((a) => `${a.n} ${a.util}%`).join(', ')}` : '',
      tick.pwr?.bat ? `battery ${tick.pwr.pct}% ${tick.pwr.ac ? 'on AC' : 'on battery'}` +
        (tick.pwr.fullWh && tick.pwr.designWh ? `, holds ${Math.round(tick.pwr.fullWh / tick.pwr.designWh * 100)}% of design` : '') : '',
      `${procCount} processes running (names withheld from this summary - call vitals_processes if a ` +
        `question needs them)`,
      f ? `\nRANKED DIAGNOSIS (sustained rules, not instantaneous):\n${f}` : '\nDIAGNOSIS: nothing firing.',
      `\nThese are this machine's real numbers. Prefer them over assumptions, say so if they are ` +
      `insufficient to answer, and do not invent measurements you were not given.`,
      /* THE MODE, IN THE PRODUCT'S OWN WORDS. Stated first among the standing instructions because
         it changes what a correct answer even looks like: in viewer, "here is how to fix it" is
         useful and "I have fixed it" is impossible. */
      this.mode() === 'viewer'
        ? `\nMODE: VIEWER. This install reads and reports; it cannot change the machine. Do not ` +
          `attempt to kill processes, clear caches, restart applications, edit files, or alter ` +
          `settings, and do not offer to - the bridge refuses those routes outright, so an attempt ` +
          `wastes a turn and an offer misleads. Diagnose, explain, and say plainly what the user ` +
          `would need to do themselves. If they ask for an action, tell them it is unavailable in ` +
          `viewer mode and that restoring admin needs the passphrase on the FOOTPRINT page, or a ` +
          `relaunch with VITALS_MODE=admin. Do not describe this as a "plan mode" or a CLI flag - ` +
          `that is the mechanism, not the reason, and it invites them to try turning it off.`
        : `\nMODE: ADMIN. Full technician access. You still hold no action tools yourself - the ` +
          `MCP surface here is read-only by construction - so recommend actions and name the panel ` +
          `control that performs them rather than claiming to have done anything.`,
      `\nThis summary is deliberately anonymous - no process names, no account names, no paths. When ` +
      `a question genuinely needs them, fetch them: vitals_processes for what is running, ` +
      `vitals_growth for what grew, vitals_journal for when it changed. Request the specific thing ` +
      `the question needs rather than pulling everything in order to look around.`,
    ].filter(Boolean).join('\n');
  }

  stop() {
    this.stopped = true;
    const c = this.child;
    if (!c) return false;
    try {
      /* On Windows the direct child is cmd.exe (shell:true) and killing it orphans the claude.exe
         grandchild, which keeps streaming into a dead pipe. Kill the tree. */
      if (IS_WIN && c.pid) spawn('taskkill', ['/pid', String(c.pid), '/t', '/f'], { windowsHide: true });
      else c.kill();
    } catch {}
    return true;
  }

  /* Events: {type:'ask'|'session'|'text'|'done'|'error', ...}. `onEvent` is optional and is delivered the
     same stream every subscriber gets; it exists only so a caller can react without subscribing. */
  run(prompt, tick, diag, onEvent) {
    const fire = (ev) => { try { onEvent && onEvent(ev); } catch {} this._emit(ev); };
    /* CHECKED HERE, not only in the page. The button being hidden is a UI state; this is the thing
       that actually prevents a process being spawned and a prompt leaving the machine. */
    if (!this.enabled()) {
      fire({ type: 'error', error: 'Ask is not connected. Enable it on the Ask page first - nothing ' +
                                   'is sent anywhere until you do.' });
      return;
    }
    if (this.child) { fire({ type: 'error', error: 'a question is already running' }); return; }
    this.stopped = false;

    const full = `${this.context(tick, diag)}\n\n---\n\nQUESTION: ${prompt}`;
    this.state.messages.push({ role: 'user', text: prompt, ts: Date.now() });
    this.live = { q: prompt, text: '', startedAt: Date.now() };
    this.save();
    /* Announce the question itself, so a view that was elsewhere when it was asked can render the
       user's turn rather than a reply with nothing above it. */
    fire({ type: 'ask', q: prompt, startedAt: this.live.startedAt });

    const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages',
                  '--verbose', '--permission-mode', this.permissionMode()];

    /* THE PANEL'S OWN MCP SERVER, SUPPLIED BY THE PANEL - not inherited from the host's config.
     *
     * Without this the embedded agent gets exactly one snapshot: the grounding block pasted into its
     * prompt. It cannot look up history, read the journal, diff growth, or re-run the diagnosis - so
     * "when did this start?" is unanswerable, which is most of what anyone actually wants to ask a
     * monitor. It could reach the raw JSONL through the filesystem, but that means an agent parsing
     * storage formats instead of calling a tool designed for the question.
     *
     * Passed EXPLICITLY rather than relying on the user having registered vitals in their global
     * Claude Code config. On this machine that config happens to exist; on a fresh install it will
     * not, and an embedded assistant whose abilities depend on unrelated setup elsewhere is one that
     * silently ships broken. The config is written next to the log so the path is stable and belongs
     * to this install.
     *
     * NOT --strict-mcp-config: the owner's own servers stay available, since the point is to ADD the
     * machine's telemetry to whatever the agent could already do, not to sandbox it away from it. */
    const mcpPath = path.join(this.secretDir || this.dir, 'ask-mcp.json');
    try {
      fs.writeFileSync(mcpPath, JSON.stringify({
        mcpServers: {
          vitals: {
            command: process.execPath,          // the same node running the bridge, not a PATH guess
            args: [path.join(__dirname, 'vitals-mcp.js'), '--port', String(this.port || 8790)],
          },
        },
      }, null, 1));
      args.push('--mcp-config', mcpPath);
      /* AND THE TOOLS MUST BE ALLOWED, which is a separate thing from being loaded.
       *
       * --permission-mode acceptEdits covers file edits only. With the server wired but no allowlist,
       * the agent found the tools, called them, and every call came back "blocked awaiting
       * permission" - so it answered from the pasted snapshot while believing it had queried the
       * machine. Wired-but-blocked looks identical to working right up until the answer is wrong.
       *
       * There is nobody to approve a prompt here: this runs headless behind a panel. So the
       * READ-ONLY tools are pre-approved by name. Naming them beats a wildcard - if the MCP server
       * later grows a tool that should not be automatic, it will not be swept in by a pattern.
       *
       * The action tools (clean, restart_app, bundle) are absent on purpose and doubly so: they are
       * not in this list, AND the server only registers them when launched with --allow-actions,
       * which the config above deliberately omits. Reading the machine is free; changing it is not. */
      /* HARD-DENY THE TWO ARTEFACTS THAT ARE NEVER DIAGNOSTIC.
       *
       * Ask has real file access - it reads and, in admin, writes. That is deliberate and useful:
       * it is how it can be asked for a new tool. But two things in this folder are never needed to
       * explain a machine and are expensive to get wrong:
       *
       *   clipboard-*.jsonl  everything the owner has copied - passwords, messages, whatever
       *   ask-config.json    the Anthropic API key, in plaintext
       *   admin-pass.json    the mode passphrase hash
       *
       * It would not read them unasked - it said as much when probed - but that is the model's
       * judgement, not a boundary, and judgement is the wrong thing to rely on for a clipboard log.
       * Denied at the tool layer so the question never arises. Deny beats allow in the CLI's
       * permission model, so this holds even though the folder is otherwise readable. */
      /* EVERY DOOR TO THE SAME BYTES, not just the obvious one. Denying Read() left Grep and Glob
         wide open - both are read-only tools that need no approval under acceptEdits, and Grep will
         happily print the matching line out of a file Read was forbidden to open. A deny list that
         covers one tool per secret is a deny list with as many holes as there are tools. */
      /* Both locations. The secrets MOVED to secretDir, and the structural boundary (out of cwd) is
         what actually protects them - but this list still named only the old paths, so it protected
         nothing that still exists and nothing that moved. Belt and braces: deny the new absolute
         paths too, so the guarantee does not rest solely on the CLI declining to read outside cwd -
         which is true as far as I know and is not something I have proven. */
      const SECRETS = ['history/clipboard-*', 'history/clips/**',
                       'history/ask-config.json', 'history/admin-pass.json',
                       toGlob(path.join(this.secretDir, 'ask-config.json')),
                       toGlob(path.join(this.secretDir, 'admin-pass.json')),
                       toGlob(path.join(this.secretDir, '**'))].filter(Boolean);
      const denied = [];
      for (const g of SECRETS) {
        for (const tool of ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'NotebookEdit']) denied.push(`${tool}(${g})`);
      }
      args.push('--disallowedTools', ...denied);
      args.push('--allowedTools',
        'mcp__vitals__vitals_snapshot', 'mcp__vitals__vitals_diagnose', 'mcp__vitals__vitals_history',
        'mcp__vitals__vitals_journal', 'mcp__vitals__vitals_processes', 'mcp__vitals__vitals_network',
        'mcp__vitals__vitals_disk', 'mcp__vitals__vitals_growth', 'mcp__vitals__vitals_startup',
        'mcp__vitals__vitals_outcomes');
    } catch (e) {
      /* A missing MCP config must not stop the conversation - it degrades to the pasted snapshot,
         which is what it did before this existed. */
      console.error('[ask] could not write the MCP config: ' + e.message);
    }
    /* Blank means "whatever the CLI defaults to" rather than a hard-coded guess that would silently
       pin the session to a model the account may not even have. --effort takes low|medium|high|xhigh|max. */
    const model = (this.cfg.model || this.model || '').trim();
    const effort = (this.cfg.effort || '').trim();
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (this.state.sessionId) args.push('--resume', this.state.sessionId);

    const env = { ...process.env };
    if (this.cfg.apiKey) env.ANTHROPIC_API_KEY = this.cfg.apiKey;   // explicit key wins
    else delete env.ANTHROPIC_API_KEY;   // otherwise strip: a stale ambient key beats the login and 401s

    let child;
    try {
      child = spawn('claude', args, { cwd: this.cwd, shell: IS_WIN, windowsHide: true, env });
    } catch (e) {
      this.live = null;
      fire({ type: 'error', error: 'could not start the claude CLI: ' + e.message });
      return;
    }
    this.child = child;

    let buf = '', reply = '', stderr = '', announced = false;
    let settled = false;
    /* Tree-kill, not child.kill(). Under `shell: true` the direct child is cmd.exe and killing it
       ORPHANS claude.exe, which keeps the inherited stdout pipe open - so 'close' may not fire until
       the orphan finishes on its own and busy() stays wedged for the duration. stop() already
       learned this; the watchdog had not. */
    const hardKill = () => {
      const c = this.child;
      if (!c) return;
      try {
        if (IS_WIN && c.pid) spawn('taskkill', ['/pid', String(c.pid), '/t', '/f'], { windowsHide: true });
        else c.kill();
      } catch {}
    };
    /* Declared BEFORE the error handler that clears it. The handler only ever runs asynchronously so
       a later `let` would in practice be initialised in time, but relying on that is the kind of
       ordering assumption that breaks silently the next time this block is edited. */
    let watchdog = setTimeout(hardKill, 10 * 60 * 1000);

    /* THE SPAWN FAILURE IS ASYNCHRONOUS, and the try/catch above does not cover it.
     *
     * On Windows `shell: true` routes through cmd.exe, which always exists, so a missing `claude`
     * surfaces as a non-zero exit and the 'close' handler's "not found on PATH" hint runs. On Linux
     * and macOS `shell` is false, so a missing binary is delivered as an 'error' EVENT instead - and
     * an unhandled 'error' on a ChildProcess does not fail the request, it KILLS THE BRIDGE.
     * Telemetry, history, journal and MCP all die with it, from someone typing a question on a fresh
     * machine that has not installed the CLI yet - the single most likely state for a new install.
     *
     * 'close' does NOT fire after a failed spawn, so this handler must do the whole teardown itself:
     * clear the child (or busy() wedges true forever and every later question is refused), clear the
     * live buffer, and emit the error to every subscriber. */
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      this.child = null;
      this.live = null;
      const hint = /ENOENT/i.test(e.code || e.message)
        ? 'the claude CLI was not found on PATH - install it and run `claude` once to log in'
        : 'could not start the claude CLI: ' + e.message;
      fire({ type: 'error', error: hint });
    });

    child.stdin.on('error', () => {});   // the shim can exit before reading stdin; EPIPE must not throw
    try { child.stdin.write(full); child.stdin.end(); } catch {}   // already-dead child: the error event handles it


    child.stdout.on('data', (chunk) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(hardKill, 10 * 60 * 1000);
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (!announced && m.session_id) {
          announced = true;
          this.state.sessionId = m.session_id;      // every reply forks a new id; always take the latest
          fire({ type: 'session', id: m.session_id });
        }
        /* Partial deltas give the panel a live stream; the final assistant message is what gets kept. */
        if (m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event.delta?.text) {
          reply += m.event.delta.text;
          if (this.live) this.live.text += m.event.delta.text;
          fire({ type: 'text', text: m.event.delta.text });
        } else if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
          const t = m.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
          if (t && !reply) { reply = t; if (this.live) this.live.text += t; fire({ type: 'text', text: t }); }
        }
      }
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });

    child.on('close', (code) => {
      /* A failed spawn emits 'error' and never 'close', but a child that dies later can emit both.
         `settled` keeps the teardown to exactly once. */
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      this.child = null;
      if (reply.trim()) {
        /* STOPPED IS CHECKED FIRST when there is partial text. The old order tested `reply.trim()`
           before `this.stopped`, so a run cancelled halfway through saved the fragment as a normal
           completed answer and fired `done` WITHOUT the stopped flag - the transcript then claimed
           the model had finished when the user had actually killed it. The partial text is still
           kept, because it is real and often the useful part; it is just labelled honestly. */
        this.state.messages.push({
          role: 'assistant', text: reply, ts: Date.now(),
          ...(this.stopped ? { stopped: true } : {}),
        });
        this.save();
        this.live = null;
        fire({ type: 'done', code, ...(this.stopped ? { stopped: true, partial: true } : {}) });
      } else if (this.stopped) {
        this.live = null;
        fire({ type: 'done', code, stopped: true });
      } else {
        /* Say what actually went wrong. The most common causes are a CLI that is not installed and a
           login that has expired, and both are actionable if named. */
        const hint = /not recognized|ENOENT/i.test(stderr) ? 'the claude CLI was not found on PATH'
                   : /401|unauthor|login/i.test(stderr) ? 'the CLI is not logged in — run "claude" once in a terminal'
                   : stderr.trim().slice(0, 300) || `claude exited ${code} with no output`;
        this.live = null;
        fire({ type: 'error', error: hint });
      }
    });
  }
}

module.exports = { Ask };
