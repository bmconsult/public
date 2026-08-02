/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - AI ACCESS LOG + DEVELOPER MODE SUITE.  node test-aiaccess.js   (any platform)
 *
 * The load-bearing check in this file is the LAST one, and it is not about the log at all: it reads
 * vitals-mcp.js and asserts that redaction and logging happen at exactly one place, on the path
 * every tool returns through.
 *
 * That is the whole design. The defect being fixed was `vitals_network` handing over a MAC address
 * because redaction was a thing each tool was supposed to remember to do, and one did not. Moving
 * it into the dispatcher only helps if it STAYS there — so "no tool returns without passing the
 * seam" is asserted against the source, not trusted to a convention.
 *
 * Time is injected throughout, so the dev-window expiry is tested rather than waited for.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { AiAccess, MAX_DEV_HOURS } = require('./aiaccess');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra !== undefined ? '  [' + extra + ']' : ''}`); }
};

const MADE = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vitals-ai-')); MADE.push(d); return d; };
process.on('exit', () => { for (const d of MADE) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

console.log('--- every read leaves a row, and the row never contains the payload ---');
{
  const d = tmp();
  const a = new AiAccess(d, { now: () => 1000 });
  a.record({ tool: 'vitals_network', args: {}, bytes: 511, redacted: 6, kinds: ['ipv4', 'mac'], identifiers: false });
  a.record({ tool: 'vitals_diagnose', args: {}, bytes: 22288, redacted: 0, kinds: [], identifiers: false });

  const rows = a.recent(10);
  check('both reads are recorded', rows.length === 2, rows.length);
  check('newest first', rows[0].tool === 'vitals_diagnose', rows[0].tool);
  check('the row says which tool, how big, and how much was withheld',
    rows[1].tool === 'vitals_network' && rows[1].bytes === 511 && rows[1].redacted === 6);
  /* The point of the file: it must be enough to see the SHAPE of what was read without keeping a
     second copy of the thing the privacy layer just protected. */
  const raw = fs.readFileSync(path.join(d, 'ai-access.jsonl'), 'utf8');
  check('the log contains no payload — only sizes and counts',
    !/adapters|ssid|"ip"/.test(raw), raw.slice(0, 120));
}

console.log('\n--- the summary answers "what has an AI seen about this machine?" ---');
{
  const d = tmp();
  const a = new AiAccess(d, { now: () => 5000 });
  a.record({ tool: 'vitals_network', bytes: 500, redacted: 6, kinds: ['mac'], identifiers: false });
  a.record({ tool: 'vitals_network', bytes: 500, redacted: 0, kinds: [], identifiers: true });
  a.record({ tool: 'vitals_snapshot', bytes: 900, redacted: 0, kinds: [], identifiers: false });

  const s = a.summary();
  check('it counts the reads', s.reads === 3, s.reads);
  check('and breaks them down by tool',
    s.byTool.vitals_network === 2 && s.byTool.vitals_snapshot === 1, JSON.stringify(s.byTool));
  check('THE NUMBER THAT MATTERS: how many answers left with identifiers in them',
    s.readsWithIdentifiers === 1, s.readsWithIdentifiers);
  check('and how many identifiers were removed from the rest', s.identifiersRemoved === 6);
}

console.log('\n--- DEVELOPER MODE: off by default, expires, and an AI cannot open it ---');
{
  const d = tmp();
  const now = { t: 1_000_000 };
  const a = new AiAccess(d, { now: () => now.t });

  check('off by default — the safe state needs no action', a.dev().on === false, JSON.stringify(a.dev()));

  /* The file form is what a human (or the panel) writes. Nothing in the MCP server can create it:
     the access log has no writer for it and the tool list has no verb for it. */
  const devFile = path.join(d, 'dev-mode.json');
  fs.writeFileSync(devFile, JSON.stringify({ until: now.t + 30 * 60_000, why: 'debugging the collector' }));
  const open = a.dev();
  check('a human-written window opens it', open.on === true, JSON.stringify(open));
  check('and it carries the reason, so the log says WHY it was open',
    /debugging the collector/.test(open.via), open.via);
  check('it reports how long is left', open.minutesLeft === 30, open.minutesLeft);

  /* THE PROPERTY THE WHOLE DESIGN RESTS ON. A boolean toggle gets left on; an expiry means the safe
     state is the one that arrives through inaction. */
  now.t += 31 * 60_000;
  check('IT EXPIRES — the window closes by itself', a.dev().on === false, JSON.stringify(a.dev()));
  check('and says it expired rather than pretending it was never open', a.dev().expired === true);

  /* A file asking for a year is capped, not honoured and not silently ignored. */
  fs.writeFileSync(devFile, JSON.stringify({ until: now.t + 365 * 24 * 3600_000 }));
  const capped = a.dev();
  check(`a window longer than ${MAX_DEV_HOURS}h is CAPPED, not granted`,
    capped.on === true && capped.until <= now.t + MAX_DEV_HOURS * 3600_000 + 1000,
    `${Math.round((capped.until - now.t) / 3600_000)}h granted`);

  /* Malformed input must fail CLOSED. */
  fs.writeFileSync(devFile, 'not json at all');
  check('a corrupt dev-mode file leaves it OFF, never on', a.dev().on === false);
  fs.writeFileSync(devFile, JSON.stringify({ until: 'soon' }));
  check('a non-numeric expiry likewise', a.dev().on === false);
}

console.log('\n--- ASKING IS NOT GRANTING: the identifier grant is a separate, human-only window ---');
{
  const d = tmp();
  const now = { t: 3_000_000 };
  const a = new AiAccess(d, { now: () => now.t });
  const gf = path.join(d, 'identifier-grant.json');

  check('no grant by default — an agent that asks gets nothing',
    a.grant().on === false, JSON.stringify(a.grant()));

  fs.writeFileSync(gf, JSON.stringify({ until: now.t + 20 * 60_000, why: 'Ben approved: Wi-Fi drop' }));
  const g = a.grant();
  check('a human-written grant opens it', g.on === true, JSON.stringify(g));
  check('and it records that a HUMAN approved it, and why', /approved/.test(g.via), g.via);
  check('with the time remaining', g.minutesLeft === 20, g.minutesLeft);

  now.t += 21 * 60_000;
  check('IT EXPIRES — the release window closes by itself',
    a.grant().on === false, JSON.stringify(a.grant()));

  fs.writeFileSync(gf, JSON.stringify({ until: now.t + 999 * 3600_000 }));
  check(`a grant longer than ${MAX_DEV_HOURS}h is CAPPED, not granted`,
    a.grant().until <= now.t + MAX_DEV_HOURS * 3600_000 + 1000);

  /* Fail CLOSED. A privacy control whose broken state is "allow" is not a control. */
  fs.writeFileSync(gf, 'not json');
  check('a corrupt grant file leaves it CLOSED, never open', a.grant().on === false);
  fs.writeFileSync(gf, JSON.stringify({ until: 'whenever' }));
  check('a non-numeric expiry likewise', a.grant().on === false);
  fs.unlinkSync(gf);
  check('and deleting the grant file closes it immediately', a.grant().on === false);

  const dev = new AiAccess(d, { now: () => now.t, devFlag: true });
  check('developer mode implies the identifier grant, and says which',
    dev.grant().on === true && /developer/.test(dev.grant().via), dev.grant().via);
}

console.log('\n--- THE THREE TIERS, asserted against the router source ---');
{
  /* The gates live in bridge.js, and what matters is the SHAPE of the rules rather than any one
     handler: viewer never releases, admin needs the passphrase every time, developer needs the
     passphrase AND an explicit confirmation. Pinned here so a future edit that softens one of them
     has to soften this file too. */
  const b = fs.readFileSync(path.join(__dirname, 'bridge.js'), 'utf8');
  const grant = /if \(p === '\/api\/ai\/grant'\)([\s\S]*?)\n  if \(p === /.exec(b);
  const dev = /if \(p === '\/api\/ai\/dev'\)([\s\S]*?)\n  if \(p === /.exec(b);

  check('the identifier-grant and developer routes both exist', !!grant && !!dev);
  check('VIEWER cannot approve identifier release', grant && /MODE === 'viewer'/.test(grant[1]));
  check('VIEWER cannot open developer mode', dev && /MODE === 'viewer'/.test(dev[1]));

  /* The one that regressed once already: "required if configured" is not "required". */
  check('the grant REFUSES when no passphrase is set, rather than waving it through',
    grant && /!hasAdminPass\(\)/.test(grant[1]) && /needsPassphrase/.test(grant[1]),
    'a gate that disappears when unconfigured is not a gate');
  check('and it checks the passphrase on every call', grant && /checkAdminPass/.test(grant[1]));
  check('developer mode refuses without a passphrase too',
    dev && /!hasAdminPass\(\)/.test(dev[1]) && /checkAdminPass/.test(dev[1]));

  /* Developer mode costs MORE than the grant: it also needs the explicit yes. */
  check('developer mode additionally requires an explicit confirmation',
    dev && /confirm !== true/.test(dev[1]),
    'the panel sends confirm:true only after showing the warning');
  check('and it is time-boxed like every other window', dev && /Math\.min\(240/.test(dev[1]));

  check('both are rate-limited, so the passphrase cannot be ground down through the panel',
    grant && /passRateLimited/.test(grant[1]) && dev && /passRateLimited/.test(dev[1]));
}

console.log('\n--- DEVELOPER MODE IS A CAPABILITY SURFACE, not a redaction switch ---');
{
  /* The first reading of "developer mode" was "the same tools, unredacted" — which answers none of
     the questions you actually have when working ON this software: why a rule did not fire, which
     module owns a route, what has been failing. Those needed their own tools. */
  const m = fs.readFileSync(path.join(__dirname, 'vitals-mcp.js'), 'utf8');
  const names = [...m.matchAll(/name: '(vitals_dev_[a-z]+)'/g)].map((x) => x[1]);
  check('developer mode adds TOOLS, not just a flag', names.length >= 3, names.join(', '));
  check('and they cover state, wiring and errors — interpret, navigate, debug',
    ['vitals_dev_state', 'vitals_dev_wiring', 'vitals_dev_errors'].every((n) => names.includes(n)),
    names.join(', '));
  /* DEVELOPER MODE MUST NOT BLANKET-UNREDACT. It buys the dev TOOLS; it does not turn every
     unrelated answer raw for an hour. `raw = dev.on || ...` did exactly that, so a process list
     asked for during a debugging session came back with identifiers nobody wanted — exposure with
     no request behind it, which is the thing this whole layer exists to stop. */
  check('developer mode unlocks the dev TOOLS rather than unredacting everything',
    /const raw = isDevTool \|\| \(asked && \(granted\.on \|\| dev\.on\)\)/.test(m),
    'an ordinary call in dev mode must still be redacted unless identifiers:true was passed');

  check('each one refuses unless the window is open',
    /DEV_NAMES\.has\(name\) && !access\.dev\(\)\.on/.test(m));
  check('and the refusal is RECORDED, so a burst of attempts shows up in the log',
    /refused: 'developer mode is closed'/.test(m));

  /* The brief was: less than a person needed to build it, only what they needed. So the surface
     must not turn into a shell or a file reader by the back door. */
  const dt = fs.readFileSync(path.join(__dirname, 'devtools.js'), 'utf8');
  check('the dev surface cannot spawn processes', !/\bspawn\(|execFile|execSync/.test(dt),
    'a dev tool that runs commands makes the bounded-surface argument moot');
  check('and it cannot write anything', !/writeFileSync|appendFileSync|unlinkSync/.test(dt));
  check('it maps structure rather than handing over file contents',
    /bytes: size/.test(dt) && /line: i \+ 1/.test(dt),
    'names, paths and line numbers — an agent with an editor opens what it was pointed at');
}

console.log('\n--- rows taken during a window are marked, and the window is announced once ---');
{
  const d = tmp();
  const now = { t: 2_000_000 };
  const a = new AiAccess(d, { now: () => now.t });
  fs.writeFileSync(path.join(d, 'dev-mode.json'), JSON.stringify({ until: now.t + 3600_000 }));

  a.record({ tool: 'vitals_network', bytes: 1, redacted: 0, kinds: [], identifiers: false });
  a.record({ tool: 'vitals_snapshot', bytes: 1, redacted: 0, kinds: [], identifiers: false });
  const rows = a.recent(10);
  const reads = rows.filter((r) => r.ev === 'read');
  const opens = rows.filter((r) => r.ev === 'dev-window-open');
  check('every read taken during the window is marked dev:true', reads.every((r) => r.dev === true));
  check('the window is announced ONCE, not per row', opens.length === 1, opens.length);
  check('and the announcement records when it will close', typeof opens[0].until === 'number');
}

console.log('\n--- THE SEAM: no tool can return without passing redaction and the log ---');
{
  /* Asserted against the source, because this is a property of the ARRANGEMENT rather than of any
     one function — and the arrangement is exactly what the original defect got wrong. */
  const src = fs.readFileSync(path.join(__dirname, 'vitals-mcp.js'), 'utf8');
  const calls = [...src.matchAll(/await t\.run\(/g)].length;
  check('there is exactly ONE place a tool is invoked', calls === 1, `${calls} call sites`);

  const seam = /await t\.run\(([\s\S]*?)return ok\(id, \{ content:/.exec(src);
  check('and the reply is built from that same block', !!seam);
  check('redaction happens between the tool and the reply', seam && /redact\(/.test(seam[1]));
  /* Asserting the TEXT is there was not enough: `if (0) access.record(...)` keeps the text and
     passes. Mutation found it. The behavioural version below actually runs the server and looks for
     the row, which no amount of dead code can satisfy. This textual check stays as the cheap first
     signal, but it is not the one that guards the property. */
  check('the access log is called between the tool and the reply (text)', seam && /access\.record\(/.test(seam[1]));
  check('the opt-in is read from the arguments, not from a global',
    seam && /args\.identifiers === true/.test(seam[1]));
  check('dev mode is consulted per call, so an expiry takes effect immediately',
    seam && /access\.dev\(\)/.test(seam[1]));

  /* And the opt-in must be DECLARED, or a strict client rejects it and the escape hatch is fiction. */
  /* The key must be named EXACTLY `identifiers`. A leading-boundary match matters: the first
     version of this check accepted `_identifiers:` as a match, so renaming the key — which breaks
     the opt-in entirely, since `additionalProperties:false` then rejects it — passed green. */
  check('`identifiers` is injected into every tool schema, not written per tool',
    /const S = \([\s\S]{0,900}?[^_\w]identifiers: \{[\s\S]{0,300}?type: 'boolean'/.test(src));

  /* AN AI MUST NOT BE ABLE TO OPEN DEVELOPER MODE FOR ITSELF — and the first version of this check
     tested for the wrong thing. It banned any tool NAMED `vitals_dev*`, which caught the legitimate
     read-only dev tools the moment they existed and said nothing at all about the property that
     matters. The property is that nothing here WRITES the window: no filesystem write to
     dev-mode.json, and no POST to the route that opens it. */
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '');
  check('nothing in the MCP server can WRITE the developer-mode window',
    !/writeFileSync[\s\S]{0,80}dev-mode/.test(noComments) && !/'\/api\/ai\/dev'/.test(noComments),
    'developer mode must be a human action or it is not a control');
  check('and it cannot open the identifier grant either',
    !/writeFileSync[\s\S]{0,80}identifier-grant/.test(noComments) && !/'\/api\/ai\/grant'/.test(noComments));
}

/* ---- BEHAVIOURAL: run the real server and look for the row ----------------------------------
 * Everything above reads source. This spawns the actual MCP server against a THROWAWAY history
 * directory, makes one tool call, and asserts a row landed — which `if (0) access.record(...)`
 * cannot satisfy and a deleted line cannot either. Mutation found that gap in the textual check.
 *
 * It needs the bridge, so it SKIPS honestly when the bridge is down rather than failing for the
 * wrong reason. A suite that goes red because a server is not running teaches people to ignore red.
 * ------------------------------------------------------------------------------------------- */
const { spawn } = require('child_process');
const http = require('http');

const bridgeUp = () => new Promise((res) => {
  const r = http.get({ host: '127.0.0.1', port: +process.env.VITALS_PORT || 8790,
                       path: '/api/caps', timeout: 2500 },
    (x) => { x.resume(); res(x.statusCode === 200); });
  r.on('error', () => res(false));
  r.on('timeout', () => { r.destroy(); res(false); });
});

(async () => {
  console.log('\n--- BEHAVIOURAL: the real server, a real call, a real row ---');
  if (!(await bridgeUp())) {
    console.log('SKIP  the bridge is not running, so the live seam check cannot run');
    console.log('      (a skip, not a pass — start the bridge to exercise it)');
  } else {
    const d = tmp();
    const hist = path.join(d, 'history');
    fs.mkdirSync(hist, { recursive: true });
    /* The server, with its history directory redirected, so the real log is untouched. Its two
       local requires are rewritten to absolute paths because the copy lives elsewhere. */
    const shim = path.join(d, 'mcp.js');
    const abs = (n) => JSON.stringify(path.join(__dirname, n).split(path.sep).join('/'));
    fs.writeFileSync(shim, fs.readFileSync(path.join(__dirname, 'vitals-mcp.js'), 'utf8')
      .replace("path.join(__dirname, 'history')", JSON.stringify(hist.split(path.sep).join('/')))
      /* EVERY local require has to be rewritten, not the two that existed when this was written.
         Adding devtools.js broke the shim silently — it failed to load, no rows appeared, and the
         suite reported "the access log was not written" about a server that never started. */
      .replace(/require\('\.\/([a-z0-9-]+)'\)/g, (m0, n) => `require(${abs(n)})`));

    const p = spawn(process.execPath, [shim], { stdio: ['pipe', 'pipe', 'pipe'] });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    await new Promise((r) => setTimeout(r, 400));
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'vitals_snapshot', arguments: {} } }) + '\n');
    await new Promise((r) => setTimeout(r, 9000));
    try { p.kill(); } catch {}

    const rows = new AiAccess(hist).recent(20).filter((r) => r.ev === 'read');
    check('a real tool call WROTE a row to the access log', rows.length >= 1, `${rows.length} rows`);
    check('and the row names the tool that was called',
      rows.some((r) => r.tool === 'vitals_snapshot'), JSON.stringify(rows.map((r) => r.tool)));
    check('and records how big the answer was',
      rows.every((r) => typeof r.bytes === 'number' && r.bytes > 0));

    /* THE PROPERTY THE WHOLE FEATURE RESTS ON, against the real server: an agent that ASKS, with no
       human grant on disk, must still get tags. A source check cannot prove this — only running it
       can, which is why the mutation "asking alone grants" slipped past the first version of this
       suite entirely. */
    const p2 = spawn(process.execPath, [shim], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out2 = '';
    p2.stdout.on('data', (x) => { out2 += x; });
    p2.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    await new Promise((r) => setTimeout(r, 400));
    p2.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      /* SNAPSHOT, NOT NETWORK, and the difference is flakiness. /api/netinfo shells out to
         PowerShell and takes 7–11 s, so this check failed on one run and passed on the next with
         no code change between them — a test that decides by timing is worse than no test, because
         it teaches you to re-run instead of to look. Snapshot answers in about a second and still
         carries identifiers: process paths contain the username. */
      params: { name: 'vitals_snapshot', arguments: { identifiers: true } } }) + '\n');
    await new Promise((r) => setTimeout(r, 6000));
    try { p2.kill(); } catch {}
    let reply = '';
    for (const line of out2.trim().split('\n')) {
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.id === 2 && j.result) reply = j.result.content[0].text;
    }
    const me = (() => { try { return require('os').userInfo().username; } catch { return null; } })();
    check('an agent that ASKS, with no human grant, still gets tags rather than values',
      reply !== '' && (!me || !reply.includes(me)),
      reply === '' ? '(no reply — the tool did not answer in time)' : `username leaked: ${me}`);
    check('and is told that a human has to approve it — even when nothing was withheld',
      /No human has approved|no human has approved/.test(reply), reply.slice(-170));
    const asked = new AiAccess(hist).recent(30).filter((r) => r.identifiers === true);
    check('the REQUEST is recorded even though nothing was released',
      asked.length >= 1 && asked[0].granted === false, JSON.stringify(asked[0] || null));
  }

  console.log(`\n${fail ? fail + ' FAILED of ' : 'all '}${pass + fail} checks${fail ? '' : ' passed'} — reads are recorded, the window expires, and the seam is single.`);
  process.exit(fail ? 1 : 0);
})();
