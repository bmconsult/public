#!/usr/bin/env node
/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - MCP server. Lets an AI agent read this machine's telemetry as typed tools.
 *
 * Why it exists: the bridge was already an agent interface (I diagnosed a hybrid-GPU misread, a dead
 * battery and a 1-pixel window artifact this week by reading /api/latest, /api/diagnose and
 * /api/processes directly). But that requires knowing the URLs and the shapes. This wraps the READ
 * endpoints as discoverable tools so any MCP client sees them in its tool list.
 *
 * TWO RULES THAT ARE NOT NEGOTIABLE:
 *
 *  1. READ-ONLY BY DEFAULT. The bridge has 14 endpoints that kill processes, delete caches, write
 *     registry dials, spend bandwidth on a speed test, or trigger a UAC prompt. Handing an agent that
 *     set by default would be reckless. Actions require --allow-actions on the command line, chosen
 *     by the human who starts the server, and even then the genuinely destructive ones
 *     (empty the bin, reboot, registry dials, mftscan/UAC, bandwidth tests) are NOT exposed at all.
 *
 *  2. EVERY TOOL CARRIES ITS CAVEATS. A number handed to an agent with no context gets quoted with
 *     more confidence than it earned. So the descriptions say what is a per-minute rollup vs a live
 *     sample, that GPU is per-adapter on hybrid machines, that the process snapshot costs ~1 s, and
 *     that an empty result can mean "nothing to report" rather than "not measured".
 *
 * Transport: stdio, newline-delimited JSON-RPC 2.0. Zero dependencies, like everything else here.
 *
 *   node vitals-mcp.js [--port 8790] [--allow-actions] [--autostart]
 *
 * Claude Desktop / Claude Code config:
 *   { "mcpServers": { "vitals": { "command": "node",
 *       "args": ["C:\\Users\\<you>\\Downloads\\code\\vitals\\vitals-mcp.js"] } } }
 */

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
/* --port wins, then VITALS_PORT, then the default - so an MCP client started from a shell that
   already knows which install it is talking to needs no extra flag. */
const PORT = (() => {
  const i = argv.indexOf('--port');
  if (i >= 0) return parseInt(argv[i + 1], 10) || 8790;
  return +process.env.VITALS_PORT || 8790;
})();
const ALLOW_ACTIONS = argv.includes('--allow-actions');
/* --dev hands answers over UNREDACTED for the life of this process. A human types it; an agent
   cannot. See aiaccess.js for why the file form expires and this one does not need to. */
const DEV_FLAG = argv.includes('--dev');

const { redact } = require('./redact');
const { AiAccess } = require('./aiaccess');
/* The log lives beside the other ledgers. If the directory is missing the recorder degrades to a
   no-op rather than taking the server down — a broken log must not break the tool it observes. */
const access = new AiAccess(path.join(__dirname, 'history'), { devFlag: DEV_FLAG });

/* Arguments are recorded, but a future tool could take a passphrase, so the same shape rule applies
   here as everywhere else: log what was asked for, not secrets that rode along. */
function safeArgs(a) {
  const out = {};
  for (const [k, v] of Object.entries(a || {})) {
    if (/pass|secret|token|key/i.test(k)) { out[k] = '[omitted]'; continue; }
    out[k] = typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v;
  }
  return out;
}
const VITALS_VERSION = (() => {
  try { return require('./package.json').version; } catch { return '0.0.0-unknown'; }
})();
/* AUTOSTART IS OPT-IN, and the default flipped deliberately.
 *
 * It used to be on: the first tool call that found nothing listening would spawn a detached bridge -
 * which also starts a collector, a PowerShell child, and a process that keeps running after the
 * conversation ends. Convenient, and not the MCP server's decision to make. Registering a read-only
 * telemetry tool should not be how a background service gets installed on someone's machine.
 * Off by default, so a tool call on a cold machine returns "the bridge is not running, start it" and
 * the user starts it. `--autostart` restores the old behaviour for anyone who wants it.
 * `--no-autostart` still works so existing configs do not break; it is now simply the default. */
const AUTOSTART = argv.includes('--autostart') && !argv.includes('--no-autostart');
const NO_AUTOSTART = !AUTOSTART;
const PROTOCOL_VERSION = '2024-11-05';
const HERE = __dirname;

/* ---------- keeping the bridge available ----------
 * The bridge is NOT a service. It starts with the panel and does not survive a reboot, so "is the
 * bridge running" would otherwise be a question the user has to think about before every conversation.
 * SINCE 0.9.0 THIS IS OPT-IN and the paragraph below describes what --autostart does, not the default.
 * With the flag, the first tool call that finds nothing listening starts it, detached, and retries once. Cost of
 * that: the bridge plus its collector, about 2% of one core and ~120 MB, which is the price of the
 * telemetry existing at all. --no-autostart opts out and returns the plain "go start it" message
 * instead. Guarded by a single in-flight promise so ten concurrent tool calls start one bridge. */
let starting = null;

/* Two different questions, and conflating them cost me a wrong result: `up` means the HTTP server is
   listening, `ready` means a telemetry tick has actually arrived. The bridge answers /api/latest with
   {"none":true} the instant it binds, about 1 s after spawn, while the collector is still priming its
   performance counters. Waiting on `up` therefore handed back "none" as if it were an answer. */
function probe() {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/latest', method: 'GET', timeout: 2000 },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          let j = null; try { j = JSON.parse(b || 'null'); } catch {}
          resolve({ up: res.statusCode < 500, ready: !!(j && !j.none && j.cpu) });
        });
      });
    req.on('error', () => resolve({ up: false, ready: false }));
    req.on('timeout', () => { req.destroy(); resolve({ up: false, ready: false }); });
    req.end();
  });
}

async function startBridge() {
  if (starting) return starting;
  starting = (async () => {
    try {
      const child = spawn(process.execPath, [path.join(HERE, 'bridge.js')],
        { cwd: HERE, detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    } catch (e) { return false; }
    /* Up to 20 s, waiting for READY not merely up: node binds in about a second, but the first tick
       waits on PowerShell priming its performance counters. Returning as soon as the port answered
       handed the caller {"none":true}. */
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if ((await probe()).ready) return true;
    }
    return false;
  })().finally(() => { starting = null; });
  return starting;
}

/* ---------- bridge access ---------- */
function call(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: apiPath, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      timeout: 120000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          let msg = buf;
          try { msg = JSON.parse(buf).error || buf; } catch {}
          return reject(new Error(`bridge ${res.statusCode}: ${msg}`));
        }
        try { resolve(JSON.parse(buf || 'null')); } catch (e) { reject(new Error('bad JSON from bridge: ' + e.message)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('bridge timed out')));
    /* The most likely failure by far is that the bridge is not running. Say so plainly instead of
       surfacing ECONNREFUSED, which reads like a bug in the tool rather than a thing to go start. */
    req.on('error', (e) => reject(new Error(
      e.code === 'ECONNREFUSED'
        ? `nothing is listening on 127.0.0.1:${PORT}. The VITALS bridge is not running - start it with "node bridge.js" in the vitals folder (or launch the panel, which starts it).`
        : e.message)));
    if (data) req.write(data);
    req.end();
  });
}
/* Every tool goes through here: try, and if nothing is listening, start the bridge and try once more.
   Cheaper than probing before each call - when the bridge is up (the normal case) this is a no-op. */
async function withBridge(fn) {
  try { return await fn(); }
  catch (e) {
    if (NO_AUTOSTART || !/nothing is listening/.test(e.message)) throw e;
    const up = await startBridge();
    if (!up) throw new Error(
      `the VITALS bridge is not running and could not be started automatically. Start it by hand: ` +
      `"node bridge.js" in ${HERE}, or launch the panel.`);
    return await fn();
  }
}
const GET = (p) => withBridge(() => call('GET', p));
const POST = (p, b) => withBridge(() => call('POST', p, b));

/* ---------- tools ---------- */
/* EVERY TOOL GETS `identifiers`, injected here rather than written on each one.
 *
 * Two reasons it belongs in the helper. `additionalProperties: false` means a strict client REJECTS
 * an undeclared argument, so an opt-in that is not in the schema is not an opt-in at all — it is a
 * flag the model is told about in prose and then forbidden from using. And declaring it per tool
 * is the same arrangement that let `vitals_network` be the one place redaction was forgotten: any
 * list a human maintains beside a set of tools will eventually disagree with it. */
const S = (props = {}, required = []) => ({
  type: 'object',
  properties: {
    ...props,
    identifiers: {
      type: 'boolean',
      description: 'Include this machine\'s identifiers — MAC, IP, gateway, DNS, Wi-Fi SSID, ' +
                   'hostname, username — which are withheld by default. Ask only when the task ' +
                   'genuinely needs them; the request is recorded in the access log either way.',
    },
  },
  required,
  additionalProperties: false,
});

const READ_TOOLS = [
  {
    name: 'vitals_snapshot',
    description:
      'The current 1 Hz telemetry sample: CPU total and per-core, memory (used %, available, committed, hard-fault rate), ' +
      'disk capacity/throughput/queue per volume, network rates, per-adapter GPU utilisation, battery/power, and the top ~16 ' +
      'processes by CPU and memory. CAVEATS: this is ONE instant, so do not call a spike a problem - use vitals_diagnose for ' +
      'sustained judgements. GPU is reported PER ADAPTER (gpus.ads[]) because a laptop with an iGPU and a dGPU has no single ' +
      'honest "GPU %"; gpus.max is the busiest adapter. The legacy gpu.* fields are nvidia-smi only and read 0 on machines ' +
      'whose work is on the integrated chip. Temperature and fan data appear only if LibreHardwareMonitor is running.',
    inputSchema: S(),
    run: () => GET('/api/latest'),
  },
  {
    name: 'vitals_diagnose',
    description:
      'Ranked, evidenced statements of CAUSE, not symptoms - this is the tool to use when asked "why is this machine slow". ' +
      'Each finding carries: severity, title, a because-explanation, measured evidence strings, a recommended action, a ' +
      'confidence rating, sometimes a `lever` naming a concrete remedy (restart-app / reboot / recycle-open / optimize), and ' +
      'sometimes `past` describing what happened last time this same finding fired on this machine. Compound findings ' +
      'SUPPRESS the symptoms they explain, so "disk full BECAUSE ram exhausted" replaces the two separate findings rather ' +
      'than adding to them. Nothing fires on an instant; every rule tests a sustained window against recorded history. ' +
      'If `ready` is false the engine has not collected its warm-up window yet and the empty list means "not yet", not "fine".',
    inputSchema: S(),
    run: () => GET('/api/diagnose'),
  },
  {
    name: 'vitals_processes',
    description:
      'Every process on the machine, grouped by name, with CPU %, private working set MB, read/write MB/s, instance count and ' +
      'PIDs. COSTS ~1 SECOND: it samples the performance counters twice to compute real deltas, so do not poll it. CPU % is ' +
      'Task-Manager style (CPU-seconds over wall-clock, divided by logical processors). For the cheap live top-16 use ' +
      'vitals_snapshot instead. Use sort/limit to keep the response small.',
    inputSchema: S({
      sort: { type: 'string', enum: ['cpu', 'mem', 'io'], description: 'ranking key, default mem' },
      limit: { type: 'integer', minimum: 1, maximum: 400, description: 'rows to return, default 25' },
    }),
    run: async (a) => {
      const all = await GET('/api/processes');
      const rows = Array.isArray(all) ? all : [];
      const key = a.sort || 'mem';
      const val = (r) => key === 'cpu' ? (r.cpu || 0) : key === 'io' ? ((r.rMBs || 0) + (r.wMBs || 0)) : (r.mb || 0);
      return { sortedBy: key, total: rows.length, rows: [...rows].sort((x, y) => val(y) - val(x)).slice(0, a.limit || 25) };
    },
  },
  {
    name: 'vitals_history',
    description:
      'Historical shape of every metric as PER-MINUTE [min, avg, max] rollups, retained 90 days. This is the tool that answers ' +
      '"when did this start" and "is it getting worse". Not raw samples: a minute with avg 20 and max 100 contained a spike, ' +
      'and quoting the average alone would hide it. Pass days for the rollup range, or recent=true for the last few hundred ' +
      'raw in-memory samples at ~1 Hz (useful only for the last several minutes).',
    inputSchema: S({
      days: { type: 'integer', minimum: 1, maximum: 90, description: 'days of per-minute rollups, default 2' },
      recent: { type: 'boolean', description: 'instead return the recent raw ~1 Hz ring' },
    }),
    run: (a) => a.recent ? GET('/api/recent') : GET(`/api/history?days=${a.days || 2}`),
  },
  {
    name: 'vitals_journal',
    description:
      'The event journal: individual threshold crossings ("hard faults 890/s crossed 400/s"), process churn, stream health, ' +
      'diagnosis lines and dial pulls, newest first, persisted to disk and retained 90 days. This is the finest-grained ' +
      'record of what actually happened and when. Distinct from vitals_outcomes, which records whole findings rather than ' +
      'the crossings underneath them. A quiet machine genuinely writes very little here.',
    inputSchema: S({
      days: { type: 'integer', minimum: 1, maximum: 14, description: 'days back, default 2' },
      limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'max entries, default 200' },
      kind: { type: 'string', description: 'filter by kind, e.g. thres, proc, diag, stream, sys' },
    }),
    run: async (a) => {
      const r = await GET(`/api/journal?days=${a.days || 2}&limit=${a.limit || 200}`);
      let e = r.entries || [];
      if (a.kind) e = e.filter((x) => x.kind === a.kind);
      return { stats: r.stats, count: e.length, entries: e };
    },
  },
  {
    name: 'vitals_outcomes',
    description:
      'The outcomes ledger: every diagnosis finding that has fired and cleared on this machine, with how long it lasted, the ' +
      'metrics at both moments, and which levers were pulled while it was open. This is what lets a claim be checked against ' +
      'history rather than asserted, e.g. "last time this fired, clearing Tier 1 returned 2.3 GB and it stayed clear for 4 days".',
    inputSchema: S(),
    run: () => GET('/api/outcomes'),
  },
  {
    name: 'vitals_disk',
    description:
      'Where the space actually went. With no path: the reclaim targets with their measured sizes and safety tiers. With a ' +
      'path: that directory\'s children by size, from the MFT snapshot (instant, but as of the snapshot time - check takenAt, ' +
      'it can be hours old, and run vitals_bundle or the panel\'s Rescan for a fresh one). Sizes come from parsing $MFT, so ' +
      'each file record is counted ONCE - this deliberately does not double-count MSIX-virtualised AppData the way a naive ' +
      'directory walk does.',
    inputSchema: S({ path: { type: 'string', description: 'e.g. "C:\\" or "C:\\Users\\me\\Downloads"' } }),
    run: (a) => a.path ? GET('/api/mft?path=' + encodeURIComponent(a.path)) : GET('/api/reclaim'),
  },
  {
    name: 'vitals_growth',
    description:
      'What grew or shrank between two whole-volume MFT snapshots, deepest-directory-first, with a net change for the volume. ' +
      'The question no live monitor can answer: "when did this start". Only the deepest directory accounting for a change is ' +
      'listed, so a culprit is not buried under its own ancestors. Needs at least two snapshots to exist.',
    inputSchema: S(),
    run: () => GET('/api/growth'),
  },
  {
    name: 'vitals_network',
    description:
      'Network state: the adapter and link speed, Wi-Fi SSID/band/channel/signal/PHY rate, IPv4 and gateway, DNS servers, ' +
      'bytes since boot, and optionally the full TCP socket table joined to owning process names. All LOCAL reads - nothing ' +
      'is sent anywhere. Deliberately does NOT include latency or a speed test: those spend the user\'s bandwidth and stay ' +
      'behind an explicit click in the UI.',
    inputSchema: S({ sockets: { type: 'boolean', description: 'also return the TCP socket table (can be several hundred rows)' } }),
    run: async (a) => {
      const info = await GET('/api/netinfo');
      if (!a.sockets) return info;
      const conns = await GET('/api/conns');
      return { adapter: info, sockets: Array.isArray(conns) ? conns : [] };
    },
  },
  {
    name: 'vitals_startup',
    description:
      'Everything that runs at boot: registry Run keys, startup folders, scheduled tasks and auto-start services, with the ' +
      'command line, current enabled state, and a suspect flag for entries launching from world-writable locations such as ' +
      'Temp or Downloads (the most common place persistence hides). A suspect flag is a REASON TO VERIFY the signature, not ' +
      'a verdict - plenty of legitimate installers leave stale entries there.',
    inputSchema: S(),
    run: () => GET('/api/startup'),
  },
];

/* Actions: only the reversible or non-destructive ones, and only with --allow-actions.
 * Deliberately absent even then: emptying the Recycle Bin, rebooting, registry dials (/api/ctl),
 * the elevated MFT rescan, and the bandwidth-spending latency/speed tests. Those are the user's to
 * choose in front of the machine, not an agent's to trigger. */
const ACTION_TOOLS = [
  {
    name: 'vitals_restart_app',
    description:
      'ACTION. Restart a named process: it is asked to close normally first so it can save, forced only if it refuses, then ' +
      'relaunched from the same executable path. UNSAVED WORK IN THAT APP MAY BE LOST - confirm with the user before calling. ' +
      'Refuses system-critical processes and refuses when the image path cannot be resolved.',
    inputSchema: S({ name: { type: 'string', description: 'process name without .exe, e.g. "chrome"' } }, ['name']),
    run: (a) => POST('/api/restartapp', { name: a.name }),
  },
  {
    name: 'vitals_clean',
    description:
      'ACTION. Delete one Tier-1 reclaim target (caches and temp files that regenerate). Get valid keys and their measured ' +
      'sizes from vitals_disk first. Only safe targets are accepted; the Recycle Bin is not one of them by design.',
    inputSchema: S({ key: { type: 'string', description: 'reclaim target key from vitals_disk' } }, ['key']),
    run: (a) => POST('/api/clean', { key: a.key }),
  },
  {
    name: 'vitals_bundle',
    description:
      'ACTION. Write a support bundle zip: the ledgers, per-minute rollups, journal, host log and a manifest. Set redact to ' +
      'strip username, machine name and network addresses. CONTAINS PERSONAL DATA unless redacted - paths embed the ' +
      'username and the journal names the apps in use. The full filesystem index (MFT snapshots) is never included.',
    inputSchema: S({
      redact: { type: 'boolean', description: 'strip username, machine name, IPv4/IPv6, MAC' },
      redactProcNames: { type: 'boolean', description: 'also mask app names - removes most diagnostic value' },
    }),
    run: (a) => POST('/api/bundle', { redact: !!a.redact, redactProcNames: !!a.redactProcNames }),
  },
];

/* ---- DEVELOPER TOOLS -------------------------------------------------------------------------
 * Present in the list always, refusing unless developer mode is open. Hiding them until the window
 * opens was the first design and it is worse: tools/list is read once at connection, so an agent
 * that had dev mode granted mid-session would never learn these exist, and the refusal message is
 * where it finds out how to ask. Their NAMES are not the secret; what they return is.
 *
 * The brief they are built to: less than a person needed to build VITALS, only what that person
 * needed, but everything required to interpret what it is doing and iterate on it. So: no shell, no
 * file contents, no writes — structure, live numbers, and what has actually gone wrong.
 * ------------------------------------------------------------------------------------------- */
const { wiring, errors } = require('./devtools');
const { readSource, writeSource, proposeEdit, classify } = require('./devedit');
const HIST = path.join(__dirname, 'history');

const DEV_TOOLS = [
  {
    name: 'vitals_dev_state',
    description:
      'DEVELOPER MODE ONLY. Every live number at once, unformatted and unredacted: the raw tick as ' +
      'the collector emitted it, plus what each subsystem currently believes — the diagnosis, the ' +
      'governor, the scheduler, the self-check, the capability manifest. The single call to make ' +
      'when the question is "what does it actually think right now".',
    inputSchema: S({}),
    run: async () => {
      const [latest, diag, gov, sched, self, caps] = await Promise.all([
        GET('/api/latest').catch((e) => ({ error: e.message })),
        GET('/api/diagnose').catch((e) => ({ error: e.message })),
        GET('/api/governor').catch((e) => ({ error: e.message })),
        GET('/api/schedule').catch((e) => ({ error: e.message })),
        GET('/api/selfcheck').catch((e) => ({ error: e.message })),
        GET('/api/caps').catch((e) => ({ error: e.message })),
      ]);
      return { what: 'the live state, unformatted — developer mode', tick: latest,
               diagnosis: diag, governor: gov, scheduler: sched, selfCheck: self, capabilities: caps };
    },
  },
  {
    name: 'vitals_dev_wiring',
    description:
      'DEVELOPER MODE ONLY. The map of this install, derived from the source at read time: every ' +
      'route with the line it is declared on and whether it is POST-only, every module with its ' +
      'own one-line summary, the PowerShell scripts, the test suites, and the data path from ' +
      'counter to panel. Names, paths and line numbers — NOT file contents.',
    inputSchema: S({}),
    run: async () => wiring(),
  },
  {
    name: 'vitals_dev_read',
    description:
      'DEVELOPER MODE ONLY. Read one of this install\'s own source files. Scope is the vitals ' +
      'folder and source extensions only — history/ is the machine\'s recorded data, not the ' +
      'software, and is not readable here. Returns the file with its risk tier, so you know before ' +
      'you edit whether a change will land directly or need the owner to approve it.',
    inputSchema: S({ file: { type: 'string', description: 'path relative to the vitals folder, e.g. "diagnose.js"' } }, ['file']),
    run: async (a) => readSource(a.file),
  },
  {
    name: 'vitals_dev_write',
    description:
      'DEVELOPER MODE ONLY. Change one of this install\'s source files. What happens depends on the ' +
      'file: NORMAL files (docs, tests, leaf modules) are written straight away, backed up first and ' +
      'syntax-checked before the old bytes are replaced. RISKY files (bridge.js, the panel, anything ' +
      'PowerShell) are PROPOSED, not written — the owner sees the actual diff in the panel and ' +
      'approves that specific change. GUARDED files (the redaction, access-log and tool-surface code, ' +
      'and their suites) are refused at every level, because an agent editing its own constraints is ' +
      'the failure this whole subsystem exists to prevent. Nothing outside the vitals folder is ' +
      'reachable, and content that does not parse is rejected before anything is overwritten.',
    inputSchema: S({
      file: { type: 'string', description: 'path relative to the vitals folder' },
      content: { type: 'string', description: 'the COMPLETE new contents of the file' },
      why: { type: 'string', description: 'one line the owner will read next to the diff' },
    }, ['file', 'content']),
    run: async (a) => {
      const tier = classify(a.file);
      /* Normal files land; anything riskier becomes a proposal a human answers. Deciding here rather
         than in the tool description means an agent cannot pick the gentler path by asking for it. */
      return tier === 'normal' ? writeSource(a.file, a.content)
                               : proposeEdit(a.file, a.content, a.why);
    },
  },
  {
    name: 'vitals_dev_errors',
    description:
      'DEVELOPER MODE ONLY. What has actually gone wrong recently, gathered from the journal and ' +
      'the host logs into one list. Answers "is it broken, and where" without reading three files. ' +
      'An empty result is a real answer — it means nothing has failed, not that nothing was read.',
    inputSchema: S({ n: { type: 'number', description: 'how many to return (default 40)' } }),
    run: async (a) => errors(HIST, Math.max(1, Math.min(200, +a.n || 40))),
  },
];

const TOOLS = (ALLOW_ACTIONS ? [...READ_TOOLS, ...ACTION_TOOLS] : READ_TOOLS).concat(DEV_TOOLS);
const DEV_NAMES = new Set(DEV_TOOLS.map((t) => t.name));
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/* ---------- JSON-RPC over stdio ---------- */
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(m) {
  const { id, method, params } = m;
  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      /* Read from package.json rather than hard-coded, so the MCP server cannot claim a version the
         product does not have. It said 1.0.0 while the product was 0.9.0 - a small lie, but this
         string is what a client displays when asked what it is talking to. */
      serverInfo: { name: 'vitals', version: VITALS_VERSION },
      instructions:
        `Local machine telemetry from VITALS on 127.0.0.1:${PORT}. ` +
        (ALLOW_ACTIONS
          ? 'Actions are ENABLED: vitals_restart_app, vitals_clean and vitals_bundle change state or write files - confirm with the user before calling them. '
          : 'READ-ONLY: no tool here changes the machine. ') +
        'Start with vitals_diagnose for "why is it slow" (it gives ranked causes with evidence), vitals_snapshot for "what is ' +
        'it doing right now", and vitals_history or vitals_journal for "when did this start". Prefer the engine\'s findings ' +
        'over re-deriving conclusions from raw numbers: the rules test sustained windows, and a single sample cannot ' +
        'distinguish a spike from a problem.',
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;   // no reply
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') {
    return ok(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const t = BY_NAME.get(name);
    if (!t) {
      /* Naming an action that exists but is gated is a different problem from a typo, so say which. */
      const gated = !ALLOW_ACTIONS && ACTION_TOOLS.some((x) => x.name === name);
      return ok(id, {
        isError: true,
        content: [{ type: 'text', text: gated
          ? `${name} is an action tool and this server was started read-only. Restart it with --allow-actions if you intend to let an agent change the machine.`
          : `unknown tool: ${name}` }],
      });
    }
    try {
      const args = (params && params.arguments) || {};

      /* A developer tool refuses unless the window is open, and the refusal is where an agent
         learns the mechanism exists at all. Recorded like any other call, so a burst of attempts
         shows up in the log rather than only in the model's context. */
      if (DEV_NAMES.has(name) && !access.dev().on) {
        access.record({ tool: name, args: safeArgs(args), bytes: 0, redacted: 0, kinds: [],
                        identifiers: false, refused: 'developer mode is closed' });
        return ok(id, { isError: true, content: [{ type: 'text', text:
          `${name} needs developer mode, which is closed. It is the widest permission VITALS has — ` +
          'it stops redacting anything and exposes this install\'s internals — so the owner opens ' +
          'it deliberately in the panel: a toggle, the admin passphrase, an explicit confirmation, ' +
          'and it closes itself after an hour. Nothing here can open it for you.' }] });
      }

      const out = await t.run(args);

      /* ---- THE ONE SEAM. Redaction and the access log both live here, after every tool and before
         every reply, so a tool added later inherits both without its author having to remember. The
         alternative — redacting inside each `run` — is precisely the arrangement that produced the
         defect this fixes: `vitals_network` simply never did it. ---- */
      const dev = access.dev();
      /* ASKING IS NOT GRANTING. `identifiers:true` is a request the agent makes; `grant` is the
         answer a HUMAN gave. Only the second one discloses anything — otherwise the rule would be
         "leaks whenever an agent decides it needs to", which is the original problem with a step
         in front of it. The request is recorded whether or not it was honoured. */
      const asked = args.identifiers === true;
      const granted = access.grant();
      /* DEVELOPER MODE DOES NOT BLANKET-UNREDACT, and the first version did exactly that.
       *
       * `raw = dev.on || …` meant every ordinary call — a process list, a diagnosis — came back
       * unredacted for the whole hour, whether or not the task had anything to do with identifiers.
       * That is exposure for no reason: the developer opened a door to work ON the software and got
       * a machine that volunteered its own details on every unrelated question.
       *
       * What developer mode actually buys is the DEV TOOLS, which return internals because that is
       * their entire purpose and because asking for one is a deliberate act. Everything else stays
       * redacted. A developer who genuinely needs an ordinary tool unredacted passes
       * `identifiers:true` — and developer mode already implies the grant, so it costs one argument
       * rather than another prompt. Needed and asked for, instead of always. */
      const isDevTool = DEV_NAMES.has(name);
      const raw = isDevTool || (asked && (granted.on || dev.on));

      let payload = out, removed = 0, kinds = [];
      if (!raw) {
        const r = redact(out);
        payload = r.value; removed = r.count; kinds = r.kinds;
      }
      const text = JSON.stringify(payload, null, 1);
      access.record({ tool: name, args: safeArgs(args), bytes: text.length,
                      redacted: removed, kinds,
                      identifiers: asked, granted: asked ? !!granted.on : undefined });

      /* THE MODEL IS TOLD WHEN SOMETHING WAS WITHHELD, and how to ask for it. Silent redaction
         would leave it reasoning over holes it cannot see — the same failure as a plausible zero,
         one layer up. `[redacted:mac]` says a MAC exists; this says how to get it. */
      /* A REFUSED REQUEST IS ALWAYS ANSWERED, even when there was nothing to withhold. The first
         version only spoke when `removed > 0`, so an agent that asked for identifiers on a payload
         which happened to contain none got silence — learning nothing about the refusal, the
         mechanism, or how to get an answer. Being told "no, and here is how to ask properly" is the
         entire point; going quiet because the payload was boring throws it away. */
      const note = raw
        ? (isDevTool
          ? `\n\n[developer tool — returned in full (${dev.via}). Ordinary tools stay redacted ` +
            'unless you pass identifiers:true; developer mode does not change that.]'
          : `\n\n[identifiers were included — you asked, and ${dev.on ? dev.via : granted.via}.]`)
        : (asked && !removed)
          ? '\n\n[you asked for this machine\'s identifiers. No human has approved that, so nothing ' +
            'was released — and this particular answer contained none anyway. The request is on the ' +
            'record; the owner can approve it in the VITALS panel, which opens a short window.]'
        : removed
          ? `\n\n[${removed} identifier${removed === 1 ? '' : 's'} replaced with stable local tags ` +
            `(${kinds.join(', ')}). A tag is the same every time for the same value, so you can tell ` +
            'whether something CHANGED without being told what it is — which is what most tasks ' +
            'actually need.' +
            (asked
              ? ' You asked for the real values and no human has approved that, so nothing was ' +
                'disclosed. The request is on the record; ask the owner to approve it in the panel.'
              : ' If you genuinely need the real values, pass identifiers:true — that records a ' +
                'request, and a human has to approve it before anything is released.') + ']'
          : '';
      return ok(id, { content: [{ type: 'text', text: text + note }] });
    } catch (e) {
      /* isError, not a protocol error: the model should see the reason and be able to act on it. */
      return ok(id, { isError: true, content: [{ type: 'text', text: `${name} failed: ${e.message}` }] });
    }
  }
  if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }        // a malformed line must not kill the server
    Promise.resolve(handle(msg)).catch((e) => {
      if (msg && msg.id !== undefined) fail(msg.id, -32603, e.message);
    });
  }
});
process.stdin.on('end', () => process.exit(0));
process.stderr.write(`vitals-mcp: ${TOOLS.length} tools (${ALLOW_ACTIONS ? 'reads + actions' : 'read-only'}), ` +
  `bridge 127.0.0.1:${PORT}, ` +
  `${DEV_FLAG ? 'DEVELOPER MODE — answers are NOT redacted' : 'identifiers redacted by default'}\n`);
