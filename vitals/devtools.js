/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - DEVELOPER MODE: what an agent needs to WORK ON this software.
 *
 * Not "the same tools with redaction off". That was the first reading of developer mode and it was
 * wrong: unredacting `vitals_network` tells you the MAC, which is no help at all when the question
 * is "why did this rule not fire" or "which module owns that route". Those are different questions
 * and they need different answers.
 *
 * ---------------------------------------------------------------------------------------------
 * THE BRIEF, and it is a constraint rather than a wish list: give an agent LESS than a person
 * needed in order to build this, and only what they needed - but everything required to interpret
 * what it is doing and iterate on it.
 *
 * So what is deliberately NOT here:
 *
 *   no shell, no arbitrary file reads   an agent that can run commands does not need VITALS at all,
 *                                       and the whole argument for this product as a safety layer
 *                                       is that it is a bounded surface rather than a machine.
 *   no source dumps                     structure, names and line numbers - not file contents. An
 *                                       agent with its own editor can open the file it was pointed
 *                                       at; one without should not be handed the codebase.
 *   no write path                       every tool here is a read. Changing VITALS is done by
 *                                       editing files, which is a thing a person or an editor does.
 *
 * And what IS here, chosen because each one answers a question you cannot currently answer without
 * reading the whole codebase:
 *
 *   vitals_dev_state    every live number at once, unformatted and unredacted - the tick as the
 *                       collector emitted it, next to what each subsystem currently believes.
 *   vitals_dev_wiring   which module owns which route, what reaches PowerShell, what writes to
 *                       disk. The map you would otherwise build by grepping for an hour.
 *   vitals_dev_errors   what has actually gone wrong recently, in one place, rather than three logs.
 *
 * Every one of them refuses unless developer mode is open, and every call is recorded like any
 * other read.
 * --------------------------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');

const HERE = __dirname;

/* Derived from the source rather than maintained by hand, for the reason test-routes.js already
   learned twice: a list of routes written beside a router drifts from it, and the drift is
   invisible until something depends on it. */
function wiring() {
  const src = fs.readFileSync(path.join(HERE, 'bridge.js'), 'utf8');
  const lines = src.split('\n');

  const routes = [];
  lines.forEach((l, i) => {
    const m = /p === '(\/api\/[^']+)'/.exec(l);
    if (m) routes.push({ route: m[1], line: i + 1,
                         postOnly: /req\.method === 'POST'/.test(l) });
  });

  /* Which modules the bridge actually pulls in, and where each one lives. Names and paths only —
     an agent that wants the contents can open the file it was just pointed at. */
  const modules = [...src.matchAll(/require\('\.\/([a-z0-9-]+)'\)/gi)]
    .map((m) => m[1])
    .filter((v, i, a) => a.indexOf(v) === i)
    .map((name) => {
      const f = path.join(HERE, name + '.js');
      let size = null, first = null;
      try {
        size = fs.statSync(f).size;
        /* Every file here opens with the licence banner and then its own one-line summary, both
           starting `/* VITALS`. The SECOND one is the summary — cheaper than reading the file and
           more accurate than anything a map maintained by hand would say. Skipping the first is the
           whole trick: matching the first gives every module the identical licence sentence, which
           is a map that describes nothing. */
        const head = fs.readFileSync(f, 'utf8').split('\n').slice(0, 16);
        const banners = head.filter((x) => /^\/\*+ VITALS/.test(x.trim()) || /^ \* VITALS/.test(x));
        const pick = banners.find((x) => !/a system monitor that measures/.test(x));
        first = pick ? pick.replace(/^\s*\/?\*+\s*/, '').trim() : null;
      } catch { /* a module that is not a sibling file, e.g. a collector */ }
      return { module: name, file: name + '.js', bytes: size, summary: first };
    });

  const scripts = fs.readdirSync(HERE).filter((f) => f.endsWith('.ps1'));
  const suites = fs.readdirSync(HERE).filter((f) => /^test-.*\.js$/.test(f));

  return {
    what: 'the shape of this install, derived from bridge.js at read time — not a maintained list',
    routes: { count: routes.length, postOnly: routes.filter((r) => r.postOnly).length, list: routes },
    modules,
    powershell: scripts,
    suites,
    dataPath: [
      'metrics.ps1 / collect/*.js  — reads the counters, emits one tick',
      'bridge.js                   — holds the ring, serves /api/*, runs the 30 s diagnosis loop',
      'diagnose.js                 — turns a tick + history into ranked findings',
      'history.js + hist.js        — the ring, the minute rollups, the mergeable histograms',
      'dashboard.html              — the panel; talks to the bridge over /api/stream (SSE)',
      'vitals-mcp.js               — the AI surface; wraps the same reads, redacts, logs',
    ],
  };
}

/* Everything gone wrong recently, in one place. Three sources because the failures land in three
   different files and correlating them by hand is the tax this tool exists to remove. */
function errors(histDir, n = 40) {
  const out = [];
  const push = (source, at, text) => out.push({ source, at, text: String(text).slice(0, 400) });

  /* The journal records the engine's own events, including errors it caught. */
  try {
    const today = new Date().toISOString().slice(0, 10);
    for (const f of [`journal-${today}.jsonl`]) {
      const p = path.join(histDir, f);
      for (const l of fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(-400)) {
        let j; try { j = JSON.parse(l); } catch { continue; }
        if (j.kind === 'error' || j.sev === 'error' || /error|failed|refused/i.test(j.what || ''))
          push('journal', j.at || j.t || null, j.what || JSON.stringify(j));
      }
    }
  } catch { /* no journal today */ }

  /* The host log is where a crashing collector or a PowerShell parse failure ends up. */
  for (const name of ['host.log', 'bridge.log']) {
    try {
      const p = path.join(histDir, name);
      const txt = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(-200);
      for (const l of txt) if (/error|exception|failed|ENOENT|cannot/i.test(l)) push(name, null, l);
    } catch { /* absent is normal */ }
  }

  return {
    what: 'recent failures from the journal and host logs, newest last',
    count: out.length,
    note: out.length ? null : 'nothing has failed recently — this is a real answer, not an empty read',
    errors: out.slice(-n),
  };
}

module.exports = { wiring, errors };
