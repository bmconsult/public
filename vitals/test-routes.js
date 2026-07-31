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
const DIRECT_PS = /\bps\(|execFile\(PS|spawn\(PS|SCRIPTS\./;
const fnRe = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([\s\S]*?)\n\}/g;
const fns = new Map();
for (const m of src.matchAll(fnRe)) fns.set(m[1], m[2]);

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

function reachesPS(body) {
  if (DIRECT_PS.test(body) || CTL_METHODS.test(body)) return true;
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
  '/api/growth': 'diffs MFT snapshots; without them it reports "nothing grew" forever',
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

/* named regressions, so they cannot quietly return */
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

for (const file of SPAWN_FILES) {
  const t = fs.readFileSync(path.join(HERE, file), 'utf8');
  const spawns = [...t.matchAll(/\bspawn\(/g)]
    .filter((m) => !/spawn\('taskkill'/.test(t.slice(m.index, m.index + 40)));   // fire-and-forget teardown
  const handlers = (t.match(/\.on\('error'/g) || []).length;
  check(`${file}: spawn() calls all have an 'error' handler`, handlers >= spawns.length,
    `${spawns.length} needing, ${handlers} present`);
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
console.log(fails ? `${fails} FAILED` : 'the guard list matches the router');
process.exit(fails ? 1 : 0);
