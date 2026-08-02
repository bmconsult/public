/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* Does the platform guard actually cover every PowerShell-backed route?   node test-routes.js
 *
 * WHY THIS EXISTS. The first WINDOWS_ONLY_ROUTES list was written by reading the router and typing
 * out what I saw. It was wrong three ways at once: four PS-backed routes missing (/api/bundle,
 * /api/ctl/state, /api/ctl/restore, /api/openrecycle), one entry naming a route that does not exist
 * (/api/recycle, while the real /api/openrecycle went unguarded), and one pure-Node route gated by
 * mistake (/api/speedtest) - disabling a working cross-platform feature and giving a false reason.
 *
 * A hand-maintained list beside a growing router will drift again, so the router is the source of
 * truth and this asserts against it.
 *
 * TWO THINGS THAT MADE EARLIER ATTEMPTS AT THIS CHECK LIE:
 *
 *  1. A route's body must end where the NEXT route begins. A fixed-size window bleeds into the
 *     following handler and flags innocent routes - it accused /api/journal and /api/clip/img, both
 *     pure Node, because a PowerShell route sat underneath them.
 *
 *  2. Routes reach PowerShell INDIRECTLY. `/api/clean` never writes `ps(`; it calls clean(), which
 *     does. Grepping route bodies for a direct call finds almost nothing and passes vacuously. So a
 *     small call graph is built: seed with functions containing a direct PS call, then close over
 *     callers until it stops growing.
 */

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const src = fs.readFileSync(path.join(HERE, 'bridge.js'), 'utf8');

let fails = 0;
function check(label, ok, detail) {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`);
}

/* ---- the declared list. Strip comments first: prose naming a route in an explanation is not an
   entry, and the previous checker reported a phantom that was only ever my own commentary. ---- */
const setBlock = /const WINDOWS_ONLY_ROUTES = new Set\(\[([\s\S]*?)\n\]\);/.exec(src);
if (!setBlock) { console.error('could not find WINDOWS_ONLY_ROUTES'); process.exit(2); }
const guarded = new Set(
  setBlock[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
             .match(/'(\/api\/[^']+)'/g)?.map((s) => s.slice(1, -1)) || []);

/* ---- routes, each with the body that belongs to it ---- */
const hits = [...src.matchAll(/p === '(\/api\/[^']+)'/g)];
const bodies = new Map();
hits.forEach((m, i) => {
  const end = i + 1 < hits.length ? hits[i + 1].index : src.length;
  bodies.set(m[1], (bodies.get(m[1]) || '') + src.slice(m.index, end));
});

/* ---- call graph: which functions end up in powershell.exe ---- */
/* `spawn(this.PS` added, and it is not a nicety: peek.js spawns PowerShell that way, and this
   pattern matched `spawn(PS` only — so the one route in the product that reads the SCREEN was
   invisible to the check that exists to find PowerShell-backed routes. */
const DIRECT_PS = /\bps\(|execFile\(PS|spawn\(PS|spawn\(this\.PS|SCRIPTS\./;
const fnRe = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([\s\S]*?)\n\}/g;
/* ARROW AND CONST HELPERS COUNT AS FUNCTIONS TOO, and matching only `function name()` was a blind
   spot in BOTH call graphs below — the PowerShell one and the writes one. A route calling
   `const doWipe = (f) => unlinkSync(f)` reached neither, so both guards passed it green. Review
   found it by writing exactly that. Harmless today (bridge.js has three trivial arrow helpers) and
   precisely the shape that bites once someone refactors, which is the moment a guard is least
   likely to be re-read. One matcher, two guards fixed.

   TWO PATTERNS, BOTH BOUNDED. A first attempt used one loose regex whose body ran to the next
   top-level declaration; it swallowed hundreds of lines per helper and took the PowerShell-reaching
   count from 11 to 21, flagging eleven innocent routes. A matcher that over-captures does not make
   a guard stricter, it makes it noise — so a braced arrow must close on its own `};` at column 0,
   and an unbraced one ends at its line. */
const arrowBlockRe = /(?:^|\n)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{([\s\S]*?)\n\};/g;
const arrowLineRe  = /(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*([^\n]{0,300})/g;
const fns = new Map();
for (const m of src.matchAll(fnRe)) fns.set(m[1], m[2]);
for (const re of [arrowBlockRe, arrowLineRe]) {
  for (const m of src.matchAll(re)) if (!fns.has(m[1])) fns.set(m[1], m[2]);
}

const psFns = new Set();
for (const [name, body] of fns) if (DIRECT_PS.test(body)) psFns.add(name);
/* ctl.js is a separate module whose every method shells out. */
const CTL_METHODS = /\bctl\.\w+/;
let grew = true;
while (grew) {
  grew = false;
  for (const [name, body] of fns) {
    if (psFns.has(name)) continue;
    for (const p of psFns) {
      if (new RegExp('\\b' + p + '\\s*\\(').test(body)) { psFns.add(name); grew = true; break; }
    }
  }
}

/* ---- POWERSHELL REACHED THROUGH A SIBLING MODULE -------------------------------------------
 * The call graph above walks bridge.js and nothing else, so a route that reaches PowerShell by
 * calling into another file was invisible to it. That is not hypothetical: /api/peek spawns
 * powershell.exe from peek.js and sat in NEITHER platform list, green, for as long as it existed.
 * The guard was looking in one file for a product that spans thirty.
 * So: find every sibling module that spawns PowerShell itself, find the identifiers bridge.js
 * binds them to, and require any route mentioning one of those to be declared. */
const PS_MODULES = new Map();          // local identifier in bridge.js -> module file
for (const f of fs.readdirSync(HERE)) {
  if (!f.endsWith('.js') || f === 'bridge.js' || f.startsWith('test-')) continue;
  let body = '';
  try { body = fs.readFileSync(path.join(HERE, f), 'utf8'); } catch { continue; }
  if (!DIRECT_PS.test(body)) continue;
  /* How bridge.js names it: `const { Peek } = require('./peek')` then `peek = new Peek(...)`.
     Both the class and the instance are looked for, because a route may mention either. */
  const base = f.replace(/\.js$/, '');
  const re = new RegExp(`(?:const|let|var)\\s*\\{?\\s*([A-Za-z_$][\\w$]*)[^=]*=\\s*require\\(['"]\\./${base}['"]\\)`);
  const m = re.exec(src);
  if (!m) continue;
  PS_MODULES.set(m[1], f);
  const inst = new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*new\\s+${m[1]}\\b|^\\s*([A-Za-z_$][\\w$]*)\\s*=\\s*new\\s+${m[1]}\\b`, 'm');
  const mi = inst.exec(src);
  if (mi) PS_MODULES.set(mi[1] || mi[2], f);
}

function reachesPS(body) {
  if (DIRECT_PS.test(body) || CTL_METHODS.test(body)) return true;
  /* A sibling module that shells out counts, and this is the line whose absence let the screen
     read sit in neither platform list. */
  for (const ident of PS_MODULES.keys()) if (new RegExp('\\b' + ident + '\\s*\\.').test(body)) return true;
  for (const p of psFns) if (new RegExp('\\b' + p + '\\s*\\(').test(body)) return true;
  return false;
}

/* ---- routes guarded for a reason OTHER than shelling out ----
   These are pure Node but read artifacts only the PowerShell scans produce. Left ungated they would
   return an empty result forever, which is a fabricated "nothing found" - the same failure as a
   zeroed gauge. Each needs a stated reason, so nobody widens this list casually. */
const GUARDED_BY_DEPENDENCY = {
  '/api/mft': 'reads MFT snapshots that only mftscan.ps1 creates',
  '/api/scanlog': 'reads the log mftscan.ps1 writes',
  /* Not a PS pattern-match since clipStart() grew a per-platform dispatch (2026-07-31), but still
     rightly guarded: the watcher exists on Windows (clipwatch.ps1) and darwin (clipwatch-posix.js,
     via PORTED_ROUTES), and a platform with neither - linux, until someone writes the xclip/
     wl-clipboard one - must 501 rather than answer "running" about a watcher that cannot read
     any pasteboard. */
  '/api/clip': 'dispatches to a per-platform clipboard watcher; platforms without one must refuse honestly',
  /* Genuinely pure Node — it writes an expiry to a file and touches nothing else. Gated anyway,
     and this is the honest place to say why rather than leaving it looking like an oversight: it
     authorises /api/peek, which cannot work without PowerShell. A window granting a capability the
     host does not have is a door onto a wall, and worse than useless — it would let someone believe
     they had switched something on. */
  '/api/peek/open': 'authorises the screen read, which needs PowerShell; granting it elsewhere would '
                  + 'be a permission for a capability that does not exist',
  /* '/api/growth' left this list 2026-07-31: growthscan.js now produces snapshots on any platform,
     and the route already answers an honest {need:2, have:N} when none exist - so its dependency
     argument is gone and gating it would 501 a working cross-platform feature. */
};

console.log(`router: ${bodies.size} routes | guard list: ${guarded.size} | PS-reaching helpers: ${psFns.size}\n`);

const phantom = [...guarded].filter((g) => !bodies.has(g));
check('every guarded route exists in the router', phantom.length === 0, phantom.join(', ') || 'none');

/* ---- routes that TOUCH PowerShell but must NOT be gated ----
   Reaching PS is not the same as depending on it. These call a PS helper on a path that already
   discards its failure, and their core work is pure Node, so they are fully functional off Windows
   with one optional enrichment missing. Gating them would remove the two most valuable
   cross-platform features in the product to protect against a failure that cannot happen. */
const DEGRADES_GRACEFULLY = {
  '/api/diagnose': 'the diagnosis engine is pure Node; only the Windows maintenance signals ' +
                   '(pending reboot, recycle bin, defrag) are absent, and those are Windows remedies',
  '/api/ask': 'reaches PS only through currentDiagnosis() when grounding the prompt; the Claude ' +
              'CLI itself is not PowerShell',
  '/api/quarantine': 'reads the outcomes ledger, which is pure Node JSONL. It touches PowerShell ' +
                     'only by calling currentDiagnosis() to learn which rules are firing — the ' +
                     'same indirection /api/diagnose is exempted for, and gating it would remove ' +
                     'a working feature from every non-Windows host',
  '/api/window/open': 'checks PS_HOST itself and answers {opened:false} off Windows. It MUST NOT ' +
                      '501 — the page needs that answer to fall back to window.open, and a 501 ' +
                      'would break the pop-out on exactly the platforms that have no native host',
};

const unguarded = [...bodies.keys()].filter((r) =>
  reachesPS(bodies.get(r)) && !guarded.has(r) && !(r in DEGRADES_GRACEFULLY));
check('every PowerShell-dependent route is guarded', unguarded.length === 0, unguarded.join(', ') || 'none');
/* And the exceptions must stay exceptions - if one is ever added to the guard list, that is a
   regression removing a working feature, exactly like /api/speedtest was. */
const wronglyGated = Object.keys(DEGRADES_GRACEFULLY).filter((r) => guarded.has(r));
check('gracefully-degrading routes stay ungated', wronglyGated.length === 0, wronglyGated.join(', ') || 'none');

const overGated = [...guarded].filter((g) =>
  bodies.has(g) && !reachesPS(bodies.get(g)) && !(g in GUARDED_BY_DEPENDENCY));
check('no pure-Node route is falsely gated', overGated.length === 0,
  overGated.length ? overGated.join(', ') + ' — these work everywhere and must not 501' : 'none');

/* ---- the ported exceptions (2026-07-31) ----
   PORTED_ROUTES lets a guarded route through on a platform where actions-posix.js implements it.
   Two invariants keep that honest: every ported route must still BE in the guard list (the gate
   expression only consults PORTED for routes the guard would otherwise refuse - an entry outside
   the list is dead configuration), and must exist in the router. */
const portedBlock = /const PORTED_ROUTES = \{([\s\S]*?)\n\};/.exec(src);
check('PORTED_ROUTES declared', !!portedBlock);
const ported = portedBlock
  ? (portedBlock[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      .match(/'(\/api\/[^']+)'/g) || []).map((s) => s.slice(1, -1))
  : [];
check('every ported route is in the guard list (else the exception is dead)',
  ported.every((r) => guarded.has(r)), ported.filter((r) => !guarded.has(r)).join(', ') || 'all listed');
check('every ported route exists in the router',
  ported.every((r) => bodies.has(r)), ported.filter((r) => !bodies.has(r)).join(', ') || 'all exist');
check('the platform gate consults PORTED_HERE', /WINDOWS_ONLY_ROUTES\.has\(p\) && !PORTED_HERE\.has\(p\)/.test(src));

/* named regressions, so they cannot quietly return */
check('/api/growth NOT guarded (pure Node; honest empty state; walker feeds it everywhere)', !guarded.has('/api/growth'));
check('/api/growthscan NOT guarded (pure Node walker)', !guarded.has('/api/growthscan'));
check('/api/speedtest NOT guarded (pure Node https)', !guarded.has('/api/speedtest'));
check('/api/nettest IS guarded (genuinely PowerShell)', guarded.has('/api/nettest'));
check('/api/openrecycle guarded (the real route name)', guarded.has('/api/openrecycle'));
check('/api/recycle absent (never existed)', !guarded.has('/api/recycle'));
for (const r of ['/api/bundle', '/api/ctl/state', '/api/ctl/restore']) check(`${r} guarded`, guarded.has(r));

/* ---- bare spawn() with no 'error' handler kills the PROCESS, not the request. This is the crash
   class that took two review rounds to clear from bridge.js and then ask.js.
   THE FILE LIST IS DISCOVERED, NOT WRITTEN DOWN. It used to read ['bridge.js','ask.js','ctl.js'] -
   the three files where the bug had already been found - so collect/win32.js shipped the same crash
   under a green suite. A hand-kept list of what to check always lags the list of what exists, and
   it is most out of date exactly when new code arrives. Enumerating means new files are covered by
   default and someone has to opt OUT, which is the correct direction for a safety check. ---- */
const SPAWN_FILES = [
  ...fs.readdirSync(HERE).filter((f) => f.endsWith('.js')),
  ...fs.readdirSync(path.join(HERE, 'collect')).filter((f) => f.endsWith('.js')).map((f) => 'collect/' + f),
].filter((f) => !/(^|\/)(test-|bundle\.js|pack\.js)/.test(f));

/* COMMENTS ARE NOT CODE, and counting them as code produced a false failure the moment a comment
   explained a spawn bug. notify.js gained the sentence "every notification ran spawn(true)" while
   documenting a real defect, and this check counted that prose as a third call site needing a third
   error handler. A guard that fires on its own documentation trains people to ignore it.
   Deliberately a scanner, not a parser: block comments, line comments, and the three string forms
   so a `//` inside a URL literal cannot open a comment. Good enough for counting call sites, and it
   errs toward leaving code in rather than removing it. */
function stripComments(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') { out += src[i]; i++; }
        out += src[i]; i++;
      }
      out += src[i] || ''; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

for (const file of SPAWN_FILES) {
  const t = stripComments(fs.readFileSync(path.join(HERE, file), 'utf8'));
  const spawns = [...t.matchAll(/\bspawn\(/g)]
    .filter((m) => !/spawn\('taskkill'/.test(t.slice(m.index, m.index + 40)));   // fire-and-forget teardown
  const handlers = (t.match(/\.on\('error'/g) || []).length;
  check(`${file}: spawn() calls all have an 'error' handler`, handlers >= spawns.length,
    `${spawns.length} needing, ${handlers} present`);
}

/* ---- THE METHOD GATE, ASSERTED AGAINST A LIVE BRIDGE ----------------------------------------
 *
 * WHY THIS IS A LIVE CHECK AND NOT A GREP. The defect this replaces was a COMMENT claiming every
 * mutating route was POST-gated. Seventeen were not. A static check of the table would only prove
 * the table agrees with itself - the same category of proof that failed. So this boots a real
 * bridge on a spare port and actually issues the GET an <img> tag would issue.
 *
 * Both directions, because only one of them is a guard:
 *   every route in MUTATES must answer 405 to a GET   - the gate exists
 *   known reads must NOT answer 405                    - the gate is not a mute
 *
 * The table is read out of bridge.js rather than retyped here, so a route added to one and not the
 * other cannot pass. ---------------------------------------------------------------------------- */
const { spawnSync, spawn: spawnProc } = require('child_process');
const http = require('http');

const mutTable = (() => {
  const m = /const MUTATES = new Map\(\[([\s\S]*?)\]\);/.exec(src);
  const pre = /const MUTATING_PREFIXES = \[([^\]]*)\]/.exec(src);
  /* `[a-z/]` would silently skip any future route with a digit, hyphen or underscore in it — the
     table reader must not be narrower than the router it is auditing. */
  const routes = m ? [...m[1].matchAll(/'(\/api\/[a-z0-9/_-]+)'/g)].map((x) => x[1]) : [];
  const prefixes = pre ? [...pre[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
  return { routes: [...new Set(routes)], prefixes };
})();

check('the MUTATES table was found in bridge.js', mutTable.routes.length > 0, JSON.stringify(mutTable));
/* THE FULL EXPECTED SET, NOT JUST THE EIGHT REVIEW HAPPENED TO FIND. The first version of this
   check pinned only the routes named in the review that prompted it — so `/api/frames` and both
   predicate entries could be DELETED from MUTATES and the whole suite stayed green. Review caught
   it by mutation. "A route added to one and not the other cannot pass" was true for additions and
   false for removals, which is the direction that actually loses a guard.
   Listed in full and compared both ways: a missing entry fails, and an unexpected one fails too so
   that adding a route means deliberately declaring it here. */
const EXPECTED_MUTATORS = [
  '/api/panel/mode', '/api/panel/theme', '/api/panel/view', '/api/panel/top', '/api/panel/alpha',
  '/api/panel/blur', '/api/watching', '/api/alerts/test', '/api/frames',
  '/api/quarantine/act', '/api/replay',
  '/api/ai/grant', '/api/ai/revoke', '/api/ai/dev', '/api/ai/devoff',
  '/api/ai/edit/apply', '/api/ai/edit/reject',
  /* Arming grants a STANDING permission — what this machine may do without being asked again —
     which is a wider change than any one lever pull it will later make. Dismiss is here because
     clearing a pending proposal is answering a question on the owner's behalf. */
  /* Opening the screen-read window is the single widest permission in the product: it decides
     whether the software may LOOK at the display, not merely what it may be told about the machine.
     Passphrase, confirmation and a self-expiring window, same as developer mode. */
  '/api/peek/open', '/api/peek/close',
  '/api/automations/arm', '/api/automations/disarm', '/api/automations/dismiss',
  /* Narrowing which folders a cleanup may touch is a change to what it will do unattended. */
  '/api/automations/targets',
];
/* ---- AND THE SAME QUESTION ASKED OF THE ROUTER, NOT OF A SECOND HAND LIST ------------------
 *
 * EXPECTED_MUTATORS above and MUTATES in bridge.js are both hand-maintained, so comparing them
 * catches drift BETWEEN them and is blind to the original defect: a mutating route declared in
 * neither. Review proved it by adding `/api/panel/scale` to the router — it broadcast a state
 * change, answered a GET with 200 on a live mutant, and the whole suite stayed green.
 *
 * So this derives the answer from the router the same way the PowerShell guard above does: seed
 * with the calls that actually CHANGE something, close over their callers, then require that every
 * route whose body reaches one is either declared in MUTATES, POST-gated in its own handler, or
 * exempt with a written reason. Adding a mutating route now fails the suite by default, which is
 * the correct direction for a safety check.
 * ------------------------------------------------------------------------------------------- */
/* DELETION AND RENAME BELONG HERE TOO — review found the seed named only write* and append*,
   so a route calling fs.unlinkSync passed the guard green. Deletion is the most destructive
   mutation class in the product; leaving it out of a list of "calls that change something"
   was the wrong kind of incomplete. */
const WRITES = /\bbroadcast\(|\bjournal\.write\(|\boutcomes\.(lever|observe)\(|\bctl\.(act|restore)\(|\bwin\(|\bnotifier\.deliver\(|\bgov\.report\(|\breplay\.(start|stop)\(|fs\.(write|append)FileSync|\bwriteFileSync\(|\bappendFileSync\(|fs\.(unlink|rm|rename|rmdir|truncate)(Sync)?\(|\bunlinkSync\(|\brmSync\(|\brenameSync\(/;
const writeFns = new Set();
for (const [name, body] of fns) if (WRITES.test(body)) writeFns.add(name);
{
  let g = true;
  while (g) {
    g = false;
    for (const [name, body] of fns) {
      if (writeFns.has(name)) continue;
      for (const w of writeFns) if (new RegExp('\\b' + w + '\\s*\\(').test(body)) { writeFns.add(name); g = true; break; }
    }
  }
}
function reachesWrite(body) {
  if (WRITES.test(body)) return true;
  for (const w of writeFns) if (new RegExp('\\b' + w + '\\s*\\(').test(body)) return true;
  return false;
}

/* Routes that reach a write but are NOT state-changing requests. Each needs a reason, so nobody
   widens this casually — the same discipline as DEGRADES_GRACEFULLY above. */
const WRITES_BUT_IS_A_READ = {
  '/api/diagnose': 'produces a diagnosis; the ledger write is currentDiagnosis() recording that the ' +
                   'diagnosis happened. An audit trail of a read is not a change the caller asked ' +
                   'for, and the bridge writes the same rows every 30 s with no request at all',
  '/api/quarantine': 'reads the outcomes ledger and calls currentDiagnosis() for the same reason — ' +
                     'the identical indirection, and gating it would break the panel',
};

const routerBodies = new Map(bodies);
{
  const pm = /if \(p\.startsWith\('\/api\/win\/'\)\) \{[\s\S]*?\n  \}/.exec(src);
  if (pm) routerBodies.set('/api/win/*', pm[0]);
}
const undeclaredMutators = [];
for (const [r, body] of routerBodies) {
  if (!reachesWrite(body)) continue;
  if (mutTable.routes.includes(r) || r === '/api/win/*') continue;
  /* The POST gate is looked for in the WHOLE SOURCE, not in the sliced body, because the common
     idiom puts it BEFORE the path test — `if (req.method === 'POST' && p === '/api/clip')` — and a
     body sliced from the `p === ` match begins after it. Testing the body alone reported /api/clip
     as an undeclared mutator when its GET handler is a pure read and its POST handler is gated. */
  const esc = r.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  if (new RegExp("req\\.method === 'POST' && p === '" + esc + "'").test(src)) continue;
  if (/req\.method === 'POST'/.test(body) || /req\.method !== 'POST'/.test(body)) continue;
  if (r in WRITES_BUT_IS_A_READ) continue;
  undeclaredMutators.push(r);
}
check('every route that CHANGES something is declared or POST-gated — derived from the router',
  undeclaredMutators.length === 0,
  undeclaredMutators.join(', ') + ' — add to MUTATES, POST-gate it, or exempt it with a reason');
check('and the write-reaching call graph actually found something (it must not pass by finding nothing)',
  writeFns.size > 0, `${writeFns.size} helpers`);

const missing = EXPECTED_MUTATORS.filter((r) => !mutTable.routes.includes(r));
const unexpected = mutTable.routes.filter((r) => !EXPECTED_MUTATORS.includes(r));
check('every expected mutating route is still in the table', missing.length === 0,
  `missing: ${JSON.stringify(missing)}`);
check('and nothing appeared in it undeclared', unexpected.length === 0,
  `unexpected: ${JSON.stringify(unexpected)} — add it here on purpose, or it is not reviewed`);
check('the /api/win/ prefix is covered', mutTable.prefixes.includes('/api/win/'),
  JSON.stringify(mutTable.prefixes));

/* The table reader must not fail OPEN. If the regex ever stops matching — a route with a digit or
   a hyphen would do it — the probe list silently empties and every check below passes vacuously. */
check('the table reader found a plausible number of routes', mutTable.routes.length >= EXPECTED_MUTATORS.length,
  `${mutTable.routes.length} parsed`);

/* The conditional ones need a query string that actually selects the mutating branch, or the GET
   is a legitimate read and 405 would be wrong. */
/* EVERY MUTATING VALUE, NOT ONE PER ROUTE. Probing a single query string means any predicate that
   covers that one string passes — review demonstrated it: narrowing the replay predicate to
   `go === '1'` (dropping the `stop` clause) left the suite fully green while a live mutant answered
   `GET /api/replay?stop=1` with 200. The probe was testing the string it had chosen, not the guard.
   So each predicated route lists all of its mutating branches, and the guard has to refuse them
   all. The read branch of the same route is checked separately in READS, below. */
const QUERY = {
  '/api/quarantine/act': ['?do=suspend&pid=999999', '?do=priority&pid=999999',
                          '?do=affinity&pid=999999', '?do=release&pid=999999'],
  '/api/replay': ['?go=1', '?stop=1'],
};
const PROBE = [
  ...mutTable.routes.flatMap((r) => (QUERY[r] || ['']).map((q) => r + q)),
  /* Every verb in the prefix map, not just one — the prefix guard is one branch, but a future
     refactor could easily make it per-verb without anyone noticing here. */
  ...mutTable.prefixes.flatMap((x) => ['close', 'min', 'rect', 'top', 'alpha', 'attach',
                                       'frameless', 'round', 'drag', 'size'].map((v) => x + v)),
];
/* Reads, to prove the gate is a gate rather than a blanket. Includes the READ side of both
   conditional routes — the branch that must stay GET-able. */
const READS = ['/api/caps', '/api/latest', '/api/governor', '/api/quarantine/act?do=state&pid=1',
               '/api/replay', '/api/panel/mode'];

const PORT = 8799;
const boot = spawnProc(process.execPath, [path.join(HERE, 'bridge.js')],
  { env: { ...process.env, VITALS_PORT: String(PORT) }, stdio: 'ignore' });

const get = (route) => new Promise((resolve) => {
  const r = http.request({ host: '127.0.0.1', port: PORT, path: route, method: 'GET' },
    (res) => { res.resume(); resolve(res.statusCode); });
  r.on('error', () => resolve(0));
  r.setTimeout(4000, () => { r.destroy(); resolve(0); });
  r.end();
});

const waitUp = async () => {
  for (let i = 0; i < 60; i++) {
    if (await get('/api/caps')) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

(async () => {
  const up = await waitUp();
  check('a bridge booted on a spare port for the method-gate check', up, `port ${PORT}`);
  if (up) {
    for (const route of PROBE) {
      const code = await get(route);
      check(`GET ${route} is refused (405)`, code === 405, `HTTP ${code}`);
    }
    /* The last READS entry is '/api/panel/mode' WITHOUT a query — still a mutator, so it must be
       405 too. Kept in the list deliberately as a canary: if a future refactor makes reads and
       writes share a path, this line is where it shows up. */
    for (const route of READS.slice(0, -1)) {
      const code = await get(route);
      check(`GET ${route} still works (not 405)`, code !== 405 && code !== 0, `HTTP ${code}`);
    }
  }
  try { boot.kill(); } catch {}
  finish();
})();

function finish() {

/* ---- NO INVISIBLE CORRUPTION IN THE SOURCE ------------------------------------------------
 * A shell heredoc collapsed `\b` into a literal BACKSPACE byte inside this file's own WRITES
 * regex, so the pattern silently required a 0x08 before every name and matched nothing. The suite
 * stayed green while the guard it powers was inert — and the bug was invisible in every editor and
 * every diff. `cat -A` found it; eyes did not.
 * A second copy landed in history.js, in a comment that was describing exactly this failure.
 * Control characters other than tab, CR and LF have no business in this source tree, so they are
 * now a test rather than a thing someone might notice. ------------------------------------------ */
const CTRL = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]');
{
  const files = fs.readdirSync(HERE).filter((f) => /\.(js|html|ps1|json|md)$/.test(f))
    .concat(fs.readdirSync(path.join(HERE, 'collect')).filter((f) => f.endsWith('.js')).map((f) => 'collect/' + f));
  const dirty = [];
  for (const f of files) {
    const t = fs.readFileSync(path.join(HERE, f), 'utf8');
    if (CTRL.test(t)) {
      /* String.fromCharCode(10), not a '\n' literal — this file is the one place where writing an
         escape sequence has repeatedly produced the wrong bytes, and a split on a literal
         backslash-n silently reports every hit as line 1. Verified by planting a backspace on a
         known line and checking the reported number. */
      const line = t.split(String.fromCharCode(10)).findIndex((l) => CTRL.test(l)) + 1;
      dirty.push(`${f}:${line}`);
    }
  }
  check('no control characters (backspace, NUL, escape) anywhere in the source',
    dirty.length === 0, dirty.join(', ') || 'none');
}

/* ---- TWO GATES, TWO QUESTIONS, AND THEY ARE NOT THE SAME LIST ----------------------------
 * MUTATES asks "did a page ask for this properly" (method / CSRF). ACTION_ROUTES asks "is this
 * install allowed to do it at all" (viewer mode). Review found the automations routes in the
 * first and not the second: a viewer who is refused POST /api/clean could still POST
 * /api/automations/arm for the cleanup — earned on the reference machine — and let the bridge's
 * own 30-second loop delete the files for them. A standing grant handed to a role denied the
 * one-off act is the gap inverted, and it passed every check in this file.
 * So: anything that changes the MACHINE must be in both. Panel/window state is deliberately in
 * MUTATES only — viewer keeps its own theme and layout, which is a different question again. */
{
  const setB = /const ACTION_ROUTES = new Set\(\[([\s\S]*?)\n\]\);/.exec(src);
  check('ACTION_ROUTES is findable', !!setB);
  if (setB) {
    const actions = new Set(setB[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      .match(/'(\/api\/[^']+)'/g)?.map((s) => s.slice(1, -1)) || []);
    /* Panel/window/telemetry state: mutating, but not a change to the MACHINE, so viewer allows it.
       `/api/replay` and `/api/quarantine/act` were in this list under that description and do not
       belong — they are machine actions. They happen to be in ACTION_ROUTES already, so nothing was
       broken, but exempting them meant their future REMOVAL would pass this check silently, and the
       comment mislabelled them into the bargain. Pinned below instead, like the automations routes. */
    const NOT_THE_MACHINE = new Set(['/api/panel/mode', '/api/panel/theme', '/api/panel/view',
      '/api/panel/top', '/api/panel/alpha', '/api/panel/blur', '/api/watching', '/api/alerts/test',
      '/api/frames',
      /* Closing the screen-read window REVOKES a permission; it cannot change the machine and it
         cannot grant anything. A revocation must never be harder than the grant, so viewer — the
         build you hand to somebody else — may always shut a door it is forbidden to open. Refusing
         it would mean shipping someone a panel that can see the window is open and do nothing. */
      '/api/peek/close']);
    const missing = EXPECTED_MUTATORS.filter((r) => !NOT_THE_MACHINE.has(r) && !actions.has(r));
    check('every mutating route that changes the MACHINE is also refused in viewer mode',
      missing.length === 0,
      missing.join(', ') + ' — in MUTATES but not ACTION_ROUTES, so viewer mode would allow it');
    /* THE SCREEN READ, pinned. It was in VIEWER_PRIVATE_ROUTES and referenced by NO suite in the
       tree — delete the entry and every check stayed green. The most sensitive read in the product
       was the one with no guard on its guard. */
    {
      /* Parsed by string boundaries rather than a regex: a shell round-trip ate the escapes out of
         the regex version and left a literal that could not compile — the same corruption class the
         control-character sweep further down exists to catch. */
      const a = src.indexOf('const VIEWER_PRIVATE_ROUTES = new Set([');
      const b2 = a >= 0 ? src.indexOf(']);', a) : -1;
      const priv = new Set(a < 0 ? [] :
        (src.slice(a, b2).match(/'\/api\/[^']+'/g) || []).map((x) => x.slice(1, -1)));
      check('viewer mode refuses /api/peek (the screen read is a privacy-sensitive read)',
        priv.has('/api/peek'), [...priv].join(', ') || 'list not found');
    }
    for (const r of ['/api/automations/arm', '/api/automations/disarm', '/api/automations/targets',
                     '/api/replay', '/api/quarantine/act']) {
      check(`viewer mode refuses ${r}`, actions.has(r),
        'a machine action must be refused by MODE, not only gated by METHOD');
    }
  }
}

{
  const missed = [];
  for (const [route, body] of bodies) {
    if (guarded.has(route) || GUARDED_BY_DEPENDENCY[route] || DEGRADES_GRACEFULLY[route]) continue;
    for (const [ident, file] of PS_MODULES) {
      if (new RegExp(`\\b${ident}\\s*\\.`).test(body)) { missed.push(`${route} (via ${file})`); break; }
    }
  }
  check(`routes reaching PowerShell through a MODULE are guarded [${[...new Set(PS_MODULES.values())].join(', ') || 'none found'}]`,
    missed.length === 0, missed.join(', '));
}

console.log('');
if (Object.keys(DEGRADES_GRACEFULLY).length) {
  console.log('reaches PowerShell but deliberately NOT gated (degrades gracefully):');
  for (const [r, why] of Object.entries(DEGRADES_GRACEFULLY)) console.log(`  ${r} — ${why}`);
  console.log('');
}
if (Object.keys(GUARDED_BY_DEPENDENCY).length) {
  console.log('guarded by dependency rather than by direct call:');
  for (const [r, why] of Object.entries(GUARDED_BY_DEPENDENCY)) console.log(`  ${r} — ${why}`);
  console.log('');
}
console.log(fails ? `${fails} FAILED` : 'the guard list matches the router, and every mutating route refuses a GET');
process.exit(fails ? 1 : 0);
}
