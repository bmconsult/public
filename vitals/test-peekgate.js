/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - THE SCREEN-READ GATE.  node test-peekgate.js   (any platform)
 *
 * This is the guard that decides whether the software may LOOK at the display, and until this file
 * existed it was pinned by NOTHING — no suite in the tree referenced screenGrant, screenTokenOk,
 * SCREEN_MAX_MIN or not-your-window. That is the same defect review had found one round earlier on
 * a smaller guard (/api/peek sitting in VIEWER_PRIVATE_ROUTES with no test), repeated immediately
 * on a bigger one. A guard nobody tests is a guard that survives exactly until someone refactors.
 *
 * WHY IT ASSERTS AGAINST SOURCE RATHER THAN A LIVE BRIDGE. Opening a real window needs the owner's
 * admin passphrase, which a suite must never contain and cannot ask for. So this proves the
 * PROPERTIES that make the gate sound — the ones whose absence caused the incidents:
 *
 *   1. there is nothing on disk to forge          (the old grant was a file; writing it WAS opening it)
 *   2. the cap is applied on READ, not just write (a hand-written far-future expiry used to stand)
 *   3. a window is not public                     (one caller's grant used to be everyone's)
 *   4. the token never appears in a status payload
 *   5. the read path checks the window BEFORE the token, so a guess never reaches a comparison
 *
 * Each check names the mechanism, so deleting the mechanism fails the check that describes it
 * rather than something vague three files away.
 */

const fs = require('fs');
const path = require('path');

const raw = fs.readFileSync(path.join(__dirname, 'bridge.js'), 'utf8');
/* CODE ONLY. The first run of this suite failed twice against its own subject matter: the comment
   explaining WHY the grant file was removed contains the filename, and prose about the token
   contains the word. test-routes.js already records this exact trap — "prose naming a route in an
   explanation is not an entry" — and a guard that reads its own documentation as evidence is
   worse than none, because the better the comment the greener it goes. */
const src = (() => {
  /* Stripped by scanning, not by regex: this is the third time today a shell round-trip has eaten
     the escapes out of a comment-stripping pattern and left a literal that will not compile. */
  let out = '', i = 0;
  while (i < raw.length) {
    if (raw[i] === '/' && raw[i + 1] === '*') { const e = raw.indexOf('*/', i + 2); i = e < 0 ? raw.length : e + 2; continue; }
    if (raw[i] === '/' && raw[i + 1] === '/') { const e = raw.indexOf('\n', i); i = e < 0 ? raw.length : e; continue; }
    out += raw[i++];
  }
  return out;
})();
let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra !== undefined ? '  [' + extra + ']' : ''}`); }
};
/* The read handler, bounded by the next route so a neighbouring body cannot satisfy a check. */
const peekBody = (() => {
  const a = src.indexOf("if (p === '/api/peek') {");
  const b = src.indexOf("p === '/api/", a + 30);
  return a < 0 ? '' : src.slice(a, b < 0 ? a + 4000 : b);
})();

console.log('--- NOTHING ON DISK TO FORGE ---');
{
  check('the grant is held in memory, not in a file',
    /let SCREEN = null/.test(src) && !/screen-grant\.json/.test(src),
    'a file grant is writable by anything with disk access — writing it IS opening the window');
  check('and no route writes a grant to disk', !/writeFileSync\([^)]*SCREEN/.test(src));
  check('only /open and /close ever assign it',
    (src.match(/^\s*SCREEN = /gm) || []).length === 2,
    'every extra assignment is another way in');
}

console.log('\n--- THE CAP IS APPLIED ON READ ---');
{
  const gr = (() => { const a = src.indexOf('function screenGrant()'); return src.slice(a, src.indexOf('\n}', a)); })();
  check('screenGrant clamps against SCREEN_MAX_MIN every time it is read',
    /Math\.min\(SCREEN\.until,\s*SCREEN\.openedAt \+ SCREEN_MAX_MIN/.test(gr),
    'enforced only at write, a far-future expiry stands forever');
  /* NOTHING MAY RETURN BEFORE THE CLAMP. Review escaped the previous version by adding an early
     `if (SCREEN) return { screenOpen: true };` above it — the Math.min TEXT was still present, so
     the check passed while a two-minute grant became permanent. Proving a line exists is not
     proving control reaches it; the same lesson as the deleted `return`, one function over. */
  check('and no early return can skip the clamp',
    gr.indexOf('return') > gr.indexOf('Math.min(SCREEN.until')
    || gr.slice(0, gr.indexOf('Math.min(SCREEN.until')).split('return').length - 1 <= 1,
    'an early return above the clamp makes every window permanent');
  check('and expiry nulls the window rather than merely reporting it',
    /SCREEN = null;\s*return \{ screenOpen: false, expired: true \}/.test(gr),
    'a window that reports closed but stays set is a window');
  check('the clamp is measured from openedAt, which nothing can set from the wire',
    !/openedAt\s*[:=]/.test(peekBody) && /openedAt: now/.test(src));
}

console.log('\n--- A WINDOW IS NOT PUBLIC ---');
{
  /* THE SHAPE, NOT THE SUBSTRING. The first version tested `/screenTokenOk\(/` and my own mutation
     run defeated it in one line: `if (false && !screenTokenOk(...))` still contains the call, so the
     check stayed green with the guard disabled. A test that proves a name appears is not a test that
     proves a guard runs — the failure this whole file exists to prevent, committed inside it.
     Anchored on the statement now: a bare `if (!screenTokenOk(` with nothing short-circuiting it.
     A textual assertion can always be worked around by someone determined; what it must not do is
     fall to the FIRST thing a careless refactor would produce. */
  check('the read path requires a token, in a branch that can actually be reached',
    /\n\s*if \(!screenTokenOk\(/.test(peekBody),
    'THE incident: a window opened for one caller made the screen readable by every client on the port');
  /* THE CONDITION IS EXACTLY THE GUARD, nothing else in the parentheses. Review defeated the
     previous version with a TRAILING short-circuit — `if (!screenTokenOk(...) && false)` — which the
     leading-only pattern never looked at. Pinning the whole condition beats enumerating the ways to
     neuter it, because the enumeration is always one idea short of the next person's. */
  check('and the condition is the guard alone, with nothing appended to it',
    /if \(!screenTokenOk\(url\.searchParams\.get\('token'\)\)\) \{/.test(peekBody),
    'a trailing `&& false` neuters a guard just as well as a leading one');
  /* IT MUST RETURN. Deleting one keyword makes the refusal fall through to the sample — the single
     most likely thing a careless refactor produces, and the mutant that escaped with all checks
     green and the suite printing that the software may not look at the screen. */
  /* Located by index rather than by one regex: the condition contains its own parentheses and the
     payload its own braces, so a `[^)]*`/`[^}]*` window stops in the wrong place — which is how the
     first version of THIS check failed against correct code. */
  check('and the refusal actually returns rather than falling through to the read',
    (() => {
      const i = peekBody.indexOf('if (!screenTokenOk(');
      if (i < 0) return false;
      const body = peekBody.slice(i, peekBody.indexOf('SCREEN.reads', i));
      return /\breturn json\(/.test(body);
    })(),
    'without the return, a refused caller is refused and then served anyway');
  /* AND IT MUST COME FIRST. The old ordering check compared the window against the token — both of
     which moved together — so hoisting the SAMPLE above both kept the inequality true and escaped.
     It asserted a relationship it did not care about. This is the one that matters. */
  check('and both gates precede the sample, which is the relationship that matters',
    peekBody.indexOf('screenOpen') < peekBody.indexOf('peek.sample(')
    && peekBody.indexOf('screenTokenOk') < peekBody.indexOf('peek.sample('),
    'a guard below the read is decoration');
  check('and refuses with a reason that says whose window it is',
    /not-your-window/.test(peekBody));
  check('the window is checked BEFORE the token, so a guess never reaches a comparison',
    peekBody.indexOf('screenOpen') < peekBody.indexOf('screenTokenOk'),
    'order matters: it keeps a closed window from becoming a token oracle');
  check('the token is generated from crypto, not from a clock or a counter',
    /randomBytes\(\d+\)\.toString\('hex'\)/.test(src));
  const bytes = (/randomBytes\((\d+)\)/.exec(src) || [])[1];
  check('with at least 128 bits of entropy', Number(bytes) * 8 >= 128, `${bytes} bytes`);
  check('and comparison fails closed when no window is open',
    /function screenTokenOk\(t\) \{ return !!SCREEN &&/.test(src),
    'a null SCREEN must not make an empty token match');
}

console.log('\n--- THE TOKEN NEVER LEAVES BY ANY OTHER DOOR ---');
{
  const statusBody = (() => {
    const a = src.indexOf("if (p === '/api/peek/status')");
    return a < 0 ? '' : src.slice(a, a + 500);
  })();
  check('the status payload does not carry the token', !/token/.test(statusBody),
    'a status endpoint that hands out the credential IS the permission');
  check('screenGrant does not return the token either',
    !/token/.test((() => { const a = src.indexOf('function screenGrant()'); return src.slice(a, src.indexOf('\n}', a)); })()),
    'it is spread into several payloads; leaking there leaks everywhere');
  /* RESPONSES, not occurrences. The first version counted every mention and failed on the line
     that STORES the token — which is not a leak, it is the point. What matters is how many replies
     carry it to a caller: exactly one, the /open that just checked a passphrase. */
  /* LINE-SCOPED. A `[^}]*` window ran past the payload it was meant to bound and counted a second,
     imaginary reply — a matcher that over-captures does not make a guard stricter, it makes it
     noise. test-routes.js already records that lesson; this file re-learned it the same hour. */
  const replies = src.split('\n').filter((l) => /json\(res/.test(l) && /\btoken\b/.test(l));
  check('exactly one response in the whole router carries the token',
    replies.length === 1, `${replies.length} — every extra one is another way to collect it`);
  check('and it is the reply to /open',
    src.indexOf(replies[0] || ' ') > src.indexOf("p === '/api/peek/open'"));
}

console.log('\n--- OPENING IT NEEDS A HUMAN ---');
{
  const openBody = (() => {
    const a = src.indexOf("p === '/api/peek/open'");
    return a < 0 ? '' : src.slice(a, src.indexOf("p === '/api/peek/close'", a));
  })();
  check('/open demands the admin passphrase', /checkAdminPass\(/.test(openBody));
  check('and an explicit confirmation', /confirm !== true/.test(openBody));
  check('and is rate limited', /passRateLimited\(/.test(openBody));
  check('and refuses outright when no passphrase is set', /hasAdminPass\(\)/.test(openBody),
    'otherwise the gate is a formality on a machine that never set one');
  check('the duration is capped at the door as well as on read',
    /Math\.min\(SCREEN_MAX_MIN/.test(openBody));
}

console.log('\n--- THE GRID CEILING IS ENFORCED, NOT ASSERTED ---');
{
  check('the route clamps the grid to PEEK_MAX_W/H', /Math\.min\(PEEK_MAX_W/.test(peekBody) && /Math\.min\(PEEK_MAX_H/.test(peekBody),
    'peek.js claims a 64x24 ceiling; this is what makes the claim true');
  const w = (/const PEEK_MAX_W = (\d+), PEEK_MAX_H = (\d+)/.exec(src) || []);
  check('and the ceiling is the size the panel actually uses', w[1] === '64' && w[2] === '24',
    `${w[1]}x${w[2]} — an API ceiling nobody uses is the number an auditor holds you to`);
  check('no stale "luminance only" claim survives in the peek modules',
    !/returns luminance only/i.test(fs.readFileSync(path.join(__dirname, 'peek.js'), 'utf8')),
    'a privacy label that lags the code is specific, reassuring and false');
}

console.log(`\n${fail ? fail + ' FAILED of ' : 'all '}${pass + fail} checks${fail ? '' : ' passed'} — the software may not look at the screen because it wants to.`);
process.exit(fail ? 1 : 0);
