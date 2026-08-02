/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - AUTOMATIONS SUITE.  node test-automate.js   (any platform)
 *
 * What this proves, in order of how much it would cost to get wrong:
 *
 *   1. A DISRUPTIVE AUTOMATION NEVER ACTS. Armed, triggered, unthrottled, with a working lever
 *      sitting right there in the injected map — and it still only proposes. If one assertion in
 *      this file matters more than the others it is that one.
 *   2. AN UNEARNED AUTOMATION CANNOT BE ARMED. Without that refusal the entire design is a
 *      wishlist with extra steps.
 *   3. The evidence is counted the way the page CLAIMS it is counted: median not mean, manual
 *      pulls only, pulls during the trigger only, nulls excluded rather than zeroed.
 *   4. It disarms itself when it stops paying.
 *
 * Nothing here touches the machine: levers arrive injected, the clock is injected, and the state
 * file lives in a scratch directory removed on exit however the run ends.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Automations, MIN_FIRES, MIN_PULLS, DEMOTE_AFTER } = require('./automate');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra !== undefined ? '  [' + extra + ']' : ''}`); }
};

/* A FRESH STATE DIRECTORY PER INSTANCE. These all shared one, which made the suite depend on its
   own execution ORDER: adding a block near the top left runs in automations.json that tripped a
   later block's min-gap, and four unrelated checks went red for a reason none of them named. A
   suite whose cases can poison each other is measuring the order it happens to be written in. */
const DIRS = [];
function freshDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vitals-auto-'));
  DIRS.push(d); return d;
}
const DIR = freshDir();
process.on('exit', () => DIRS.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }));

/* A fake ledger: the real one reads a JSONL file, and what this module actually depends on is the
   two-method shape. Driving it here means the suite can pose any history in a line of code. */
const DAY = 86400_000;
let NOW = 1_800_000_000_000;
const clock = () => NOW;
function ledger(rows) {
  return {
    rows, written: [],
    recent() { return this.rows; },
    metricsOf() { return { cpu: 10, mem: 50, freeGB: 20, flt: 0 }; },
    _write(r) { this.written.push(r); },
  };
}
/* A history that earns clean_temp_on_pressure: the trigger recurring, manual sweeps DURING it,
   each returning well over the 0.2 GB floor. */
function earnedHistory() {
  const rows = [];
  for (let i = 0; i < MIN_FIRES; i++) rows.push({ ev: 'fired', id: 'disk_low', at: NOW - (i + 1) * DAY });
  for (let i = 0; i < MIN_PULLS; i++) {
    rows.push({ ev: 'lever', kind: 'clean', detail: { key: 'usertemp', freedGB: 1.4 }, during: ['disk_low'], at: NOW - (i + 1) * DAY });
  }
  return rows;
}
const mk = (rows, opts) => new Automations(freshDir(), ledger(rows), { now: clock, ...opts });
/* A host that HAS PowerShell. capture_on_critical needs it, and the engine now refuses to offer
   a candidate whose platform requirement is unmet — so a suite that never says what the host has
   is testing a Mac. Declared once, used wherever that candidate is armed. */
const WIN = { has: { powershell: true } };
const D = (ids) => ({ ready: true, findings: ids.map((id) => ({ id })) });

console.log('--- THE REFUSAL THE WHOLE DESIGN RESTS ON ---');
{
  const a = mk([]);
  const r = a.arm('clean_temp_on_pressure');
  check('an automation with no record behind it CANNOT be armed', r.refused === 'unearned', JSON.stringify(r).slice(0, 90));
  check('and the refusal names every missing piece, not just the first',
    r.evidence.need.length === 3, JSON.stringify(r.evidence.need));
  check('the state file records nothing', !a.list(WIN).items.find((i) => i.id === 'clean_temp_on_pressure').armed);

  const b = mk(earnedHistory());
  const ok = b.arm('clean_temp_on_pressure');
  check('with the record behind it, it arms', ok.ok === true && ok.armed === true, JSON.stringify(ok).slice(0, 80));
  check('and the reason it was allowed carries the numbers',
    /fired 5 times/.test(ok.evidence.why) && /1\.4/.test(ok.evidence.why), ok.evidence.why);
}

console.log('\n--- THE EVIDENCE IS COUNTED THE WAY THE PAGE SAYS IT IS ---');
{
  /* A pull OUTSIDE the trigger must not count: "you once emptied temp on a quiet Sunday" is not
     an answer to disk pressure. This is the check that failed first when written the obvious way. */
  const rows = [];
  for (let i = 0; i < MIN_FIRES; i++) rows.push({ ev: 'fired', id: 'disk_low', at: NOW - (i + 1) * DAY });
  for (let i = 0; i < 5; i++) rows.push({ ev: 'lever', kind: 'clean', detail: { freedGB: 3 }, during: [], at: NOW - i * DAY });
  const ev = mk(rows).evidenceFor('clean_temp_on_pressure');
  check('five sweeps with the trigger CLOSED count as zero', ev.pulls === 0, `pulls=${ev.pulls}`);
  check('and it is refused', !ev.earned);

  /* Median, not mean. Four sweeps that freed nothing and one that freed 8 GB: the mean says 1.6
     and passes the floor, the median says 0 and fails it. The mean would arm an automation on the
     strength of a single lucky run. */
  const rows2 = [];
  for (let i = 0; i < MIN_FIRES; i++) rows2.push({ ev: 'fired', id: 'disk_low', at: NOW - (i + 1) * DAY });
  [0, 0, 0, 0, 8].forEach((g, i) => rows2.push({ ev: 'lever', kind: 'clean', detail: { freedGB: g }, during: ['disk_low'], at: NOW - i * DAY }));
  const ev2 = mk(rows2).evidenceFor('clean_temp_on_pressure');
  check('the benefit is a MEDIAN — one lucky 8 GB run does not carry four empty ones',
    ev2.median === 0 && !ev2.earned, `median=${ev2.median} mean would be 1.6`);

  /* A lever that reports no delta at all is not a lever that freed zero. */
  const rows3 = earnedHistory().map((r) => (r.ev === 'lever' ? { ...r, detail: { key: 'usertemp' } } : r));
  const ev3 = mk(rows3).evidenceFor('clean_temp_on_pressure');
  check('an unmeasured result is null, never zero', ev3.median === null, `median=${ev3.median}`);
  check('and that blocks arming with a DIFFERENT reason than "too small"',
    /no measured result/.test(ev3.need.join(' ')), ev3.need.join(' '));

  /* Anything older than the window is not evidence about now. */
  const old = earnedHistory().map((r) => ({ ...r, at: NOW - 90 * DAY }));
  check('evidence outside the window does not count', mk(old).evidenceFor('clean_temp_on_pressure').pulls === 0);
}

console.log('\n--- DISRUPTIVE MEANS IT ASKS. IT DOES NOT ACT. ---');
{
  const a = mk([{ ev: 'lever', kind: 'restart-app', during: ['mem_hog'], at: NOW - DAY },
                { ev: 'lever', kind: 'restart-app', during: ['mem_hog'], at: NOW - 2 * DAY },
                ...Array.from({ length: MIN_FIRES }, (_, i) => ({ ev: 'fired', id: 'mem_hog', at: NOW - (i + 1) * DAY }))]);
  const armed = a.arm('restart_hog_on_leak');
  check('the disruptive one arms once earned', armed.ok === true, JSON.stringify(armed).slice(0, 70));
  check('and arming reports that it does NOT act alone', armed.actsAlone === false,
    'a page that says "on" without saying "asks first" is the most dangerous imprecision here');

  /* The lever is present and callable. It must still not be called. */
  let restarted = 0, proposed = 0;
  const levers = { 'restart-app': async () => { restarted++; return { ok: true }; }, propose: () => { proposed++; return { asked: true }; } };
  return (async () => {
    const r = await a.consider(D(['mem_hog']), null, levers);
    check('TRIGGERED, ARMED, LEVER AVAILABLE — and it still did not act', restarted === 0,
      `the restart lever was called ${restarted} times`);
    check('it proposed instead', proposed === 1 && r.ran[0] && r.ran[0].proposed === true, JSON.stringify(r.ran));
    const b = mk([]); b.arm('restart_hog_on_leak', { force: true });
    let r2 = await b.consider(D(['mem_hog']), null, { 'restart-app': async () => { restarted++; return {}; } });
    check('no propose channel → skipped, not escalated to acting', restarted === 0 && r2.skipped.length === 1,
      JSON.stringify(r2.skipped));
    await rest();
  })();
}

async function rest() {
  console.log('\n--- IT RUNS, AND EVERY RUN IS ON THE RECORD ---');
  {
    const led = ledger(earnedHistory());
    const a = new Automations(freshDir(), led, { now: clock });
    a.arm('clean_temp_on_pressure');
    let called = null;
    const r = await a.consider(D(['disk_low']), { cpu: {}, mem: {} },
      { clean: async (p) => { called = p; return { freedGB: 1.1 }; } });
    check('an armed, triggered, reversible automation runs', r.ran.length === 1 && r.ran[0].ok, JSON.stringify(r.ran));
    check('and it is handed the params from the table, not improvised ones',
      called && called.keys.join(',') === 'usertemp,ctmp', JSON.stringify(called));
    check('the run is written to the SAME ledger as a manual pull', led.written.length === 1);
    check('tagged so the two can never be confused',
      led.written[0].ev === 'auto' && led.written[0].id === 'clean_temp_on_pressure', JSON.stringify(led.written[0]));
    check('carrying what it actually returned', led.written[0].benefit === 1.1);

    /* An automation must not be able to keep itself armed by running. */
    const ev = a.evidenceFor('clean_temp_on_pressure');
    check('its OWN runs are not counted as "you did it by hand"', ev.pulls === MIN_PULLS,
      `pulls=${ev.pulls} — if this grows, an armed automation is voting for itself`);
  }

  console.log('\n--- THE CEILINGS, and each says which one stopped it ---');
  {
    const a = new Automations(freshDir(), ledger(earnedHistory()), { now: clock });
    a.arm('clean_temp_on_pressure');
    const lever = { clean: async () => ({ freedGB: 1 }) };
    await a.consider(D(['disk_low']), null, lever);
    const r = await a.consider(D(['disk_low']), null, lever);
    check('a second run inside the minimum gap is refused', r.skipped[0] && r.skipped[0].why === 'min-gap', JSON.stringify(r.skipped));
    NOW += 61 * 60_000;
    const r2 = await a.consider(D(['disk_low']), null, lever);
    check('and allowed once the gap has passed', r2.ran.length === 1, JSON.stringify(r2.skipped));
    for (let i = 0; i < 4; i++) { NOW += 61 * 60_000; await a.consider(D(['disk_low']), null, lever); }
    const r3 = await a.consider(D(['disk_low']), null, lever);
    check('the daily ceiling stops it', r3.skipped[0] && r3.skipped[0].why === 'daily-ceiling', JSON.stringify(r3.skipped));
    check('"it did not fire" and "it was not allowed to" stay different facts',
      r3.ran.length === 0 && r3.skipped[0].detail.includes('of 4 today'), JSON.stringify(r3.skipped));
    NOW += DAY;
  }

  console.log('\n--- A STALLING MACHINE, and the difference that matters ---');
  {
    const a = new Automations(freshDir(), ledger([{ ev: 'lever', kind: 'growthscan', at: NOW - DAY },
                                           { ev: 'lever', kind: 'growthscan', at: NOW - 2 * DAY }]), { now: clock });
    check('a cadence automation needs no trigger evidence', a.evidenceFor('growth_scan_daily').earned === true,
      JSON.stringify(a.evidenceFor('growth_scan_daily').need));
    a.arm('growth_scan_daily');
    let scans = 0;
    const r = await a.consider(D([]), null, { growthscan: async () => { scans++; return {}; } }, { stalling: true });
    check('an OBSERVE scan waits while the foreground is stalling', scans === 0 && r.skipped.length === 1, JSON.stringify(r.skipped));

    const b = new Automations(freshDir(), ledger(earnedHistory()), { now: clock });
    b.arm('clean_temp_on_pressure');
    let cleans = 0;
    await b.consider(D(['disk_low']), null, { clean: async () => { cleans++; return { freedGB: 1 }; } }, { stalling: true });
    check('but a RESPONSE does not — deferring it would defer the fix for the stall',
      cleans === 1, 'the disk pressure may be what is causing the stall');
  }

  console.log('\n--- IT DISARMS ITSELF WHEN IT STOPS PAYING ---');
  {
    const a = new Automations(freshDir(), ledger(earnedHistory()), { now: clock });
    a.arm('clean_temp_on_pressure');
    const poor = { clean: async () => ({ freedGB: 0.01 }) };

    /* THE EMPTY WELL. Three runs an hour apart inside ONE sustained incident: the first emptied
       the folder, so the next two find nothing. Per-RUN median would disarm the automation in the
       middle of the incident it was earned for, and say "it stopped paying" about a lever that had
       just worked. Three ticks inside one incident is a description of it succeeding. */
    for (let i = 0; i < DEMOTE_AFTER + 1; i++) {
      NOW += 61 * 60_000;
      await a.consider(D(['disk_low']), null, poor);
    }
    check('four thin runs inside ONE incident do NOT disarm it',
      a.list(WIN).items.find((i) => i.id === 'clean_temp_on_pressure').armed === true,
      'the first run emptied the well — the later ones finding nothing is what success looks like');

    /* Three SEPARATE incidents where its best run achieved nothing is a real verdict.
       A DAY between them, not an hour: maxPerDay is 4, and the first attempt at this test put six
       runs inside one day, so the ceiling — not the demotion rule — was what stopped them. The
       test then passed for the wrong reason in one direction and failed in the other. */
    for (let i = 0; i < DEMOTE_AFTER; i++) {
      NOW += DAY;
      await a.consider(D([]), null, poor);            // the trigger clears — episode ends
      NOW += 61 * 60_000;
      await a.consider(D(['disk_low']), null, poor);  // and fires again — a new incident
    }
    const item = a.list(WIN).items.find((i) => i.id === 'clean_temp_on_pressure');
    check(`after ${DEMOTE_AFTER} runs that returned nothing, it disarms itself`, item.armed === false,
      'a lever that runs clean and returns nothing is exactly what a success/failure count calls healthy');
    check('and says why, with both numbers', /0\.01/.test(item.demotedWhy.why) && /0\.2/.test(item.demotedWhy.why),
      item.demotedWhy && item.demotedWhy.why);
    let ran = 0;
    await a.consider(D(['disk_low']), null, { clean: async () => { ran++; return {}; } });
    check('and it really has stopped running', ran === 0);

    /* A CRASH LEAVES A PENDING ROW ON DISK. The slot is reserved before the lever is awaited, so a
       process that dies mid-lever persists a run with no result — and on the next boot the demotion
       arithmetic reads it. It must be skipped, not scored: an incomplete run is not a failed one,
       and counting it would let a single crash start a phantom episode. (Mutation found this branch
       untested; it is unreachable in a healthy process, which is exactly why it needed a case.) */
    const c = new Automations(freshDir(), ledger(earnedHistory()), { now: clock });
    c.arm('clean_temp_on_pressure');
    c.state.armed.clean_temp_on_pressure.runs = [
      { at: NOW - 3 * DAY, episode: 1, benefit: 5 },
      { at: NOW - 2 * DAY, episode: 2, pending: true, benefit: null },   // the crash
      { at: NOW - DAY, episode: 3, benefit: 4 },
    ];
    const eps = c._episodes(c.state.armed.clean_temp_on_pressure);
    check('a run left pending by a crash is not counted as an episode',
      eps.length === 2 && eps.every((e) => e.best != null), JSON.stringify(eps));
    check('and it does not split the episodes around it',
      eps.map((e) => e.best).join(',') === '5,4', JSON.stringify(eps.map((e) => e.best)));

    /* Demotion is on BENEFIT, so a tier with nothing to measure must never be demoted by it. */
    const b = new Automations(freshDir(), ledger([{ ev: 'lever', kind: 'growthscan', at: NOW }, { ev: 'lever', kind: 'growthscan', at: NOW - DAY }]), { now: clock });
    b.arm('growth_scan_daily');
    for (let i = 0; i < DEMOTE_AFTER + 2; i++) { NOW += 25 * 3600_000; await b.consider(D([]), null, { growthscan: async () => ({}) }); }
    check('an observe automation is never demoted for a benefit it never claimed',
      b.list(WIN).items.find((i) => i.id === 'growth_scan_daily').armed === true);
  }

  console.log('\n--- A MISSING LEVER IS REPORTED, NOT CRASHED THROUGH ---');
  {
    const a = new Automations(freshDir(), ledger(earnedHistory()), { now: clock });
    a.arm('clean_temp_on_pressure');
    NOW += DAY;
    const r = await a.consider(D(['disk_low']), null, {});
    check('a host without the lever skips and says so', r.ran.length === 0 && /not available/.test(r.skipped[0].why),
      JSON.stringify(r.skipped));
    const r2 = await a.consider(D(['disk_low']), null, { clean: async () => { throw new Error('access denied'); } });
    check('a lever that throws is recorded as a failed run, not a silent one',
      r2.ran[0] && r2.ran[0].ok === false && /access denied/.test(r2.ran[0].err), JSON.stringify(r2.ran));

    /* A LEVER CAN RESOLVE AND STILL HAVE FAILED. The clean lever stopped rejecting so it could keep
       partial results across targets — which meant an all-targets-failed sweep arrived as a resolved
       promise and got filed as a success that measured nothing, with the failure sitting unread
       inside `detail`. "It ran and found nothing" and "it could not run" are different facts and
       the ledger has to be able to tell them apart. */
    const b3 = new Automations(freshDir(), ledger(earnedHistory()), { now: clock });
    b3.arm('clean_temp_on_pressure');
    NOW += DAY;
    const r3 = await b3.consider(D(['disk_low']), null,
      { clean: async () => ({ ok: false, freedGB: null, errors: [{ key: 'usertemp', error: 'denied' }] }) });
    check('a lever that RESOLVES with ok:false is still a failed run',
      r3.ran[0] && r3.ran[0].ok === false, JSON.stringify(r3.ran));
    check('and its benefit is null, not zero', r3.ran[0] && r3.ran[0].benefit === null,
      'a blocked lever measured nothing; it did not measure nothing freed');
  }

  console.log('\n--- WHAT IS REFUSED IS STATED, NOT OMITTED ---');
  {
    const l = new Automations(freshDir(), ledger([]), { now: clock }).list();
    check('the UAC-gated cleanup is listed as unautomatable', l.unautomatable.length === 1);
    check('with the reason a human has to be at the keyboard', /UAC/.test(l.unautomatable[0].why));
    check('an unearned candidate still appears, showing what it is waiting for',
      l.items.length === 4 && l.items.every((i) => i.evidence && Array.isArray(i.evidence.need)));
  }

  console.log('\n--- A LEVER THAT REACHES BACK INTO THE LOOP ---');
{
  /* THE ONE THE SEAM HID. Injected levers are what make this module testable, and every lever in
     the suite was polite — none of them called back into consider(). The real bundle lever did:
     buildBundle asked for a fresh diagnosis, currentDiagnosis ran the automations, and one of the
     automations was the bundle. Review reproduced 830 nested calls from ONE 30-second tick, each
     level spawning Compress-Archive against the same paths, on a 99%-full disk, during the
     disk-pressure incident that triggered it. The ceiling could not stop it because a run was only
     recorded AFTER its lever resolved, so every level saw an untouched ceiling and a fresh trigger.
     The caller was fixed as well (buildBundle now takes the diagnosis it already has), but this is
     the assertion that stops the next lever re-opening it. */
  const a = mk([]);
  a.arm('capture_on_critical', WIN);
  let depth = 0, maxDepth = 0, calls = 0;
  const levers = {
    bundle: async () => {
      calls++; depth++; maxDepth = Math.max(maxDepth, depth);
      await a.consider(D(['spiral']), null, levers);      // the lever re-enters the loop
      depth--;
      return { ok: true };
    },
  };
  return (async () => {
    await a.consider(D(['spiral']), null, levers);
    check('a lever that calls consider() again runs EXACTLY ONCE', calls === 1, `${calls} calls`);
    check('and the recursion never goes a second level deep', maxDepth === 1, `depth ${maxDepth}`);
    /* NAME THE GUARD THAT STOPPED IT. `calls === 1` above passes with the re-entrancy guard
       DELETED, because reserving the run slot before the await already trips the min-gap on the
       nested pass — mutation testing found exactly that, and a check that cannot tell which of two
       guards saved it is not testing either. So the nested call is inspected directly: it must be
       refused for being re-entrant, not for being too soon. Two independent guards, two assertions;
       either one alone would still be caught here. */
    let inner = null;
    const b2 = mk([]);
    b2.arm('capture_on_critical', WIN);
    const nested = {
      bundle: async () => { inner = await b2.consider(D(['spiral']), null, nested); return {}; },
    };
    await b2.consider(D(['spiral']), null, nested);
    check('the nested pass is refused BY THE RE-ENTRANCY GUARD specifically',
      inner && inner.skipped[0] && /re-entered/.test(inner.skipped[0].why),
      JSON.stringify(inner && inner.skipped));

    /* The slot must be reserved BEFORE the await, or the ceiling is a check-then-act across it. */
    const b = mk([]);
    b.arm('capture_on_critical', WIN);
    let seen = null;
    await b.consider(D(['spiral']), null, {
      bundle: async () => { seen = (b.state.armed.capture_on_critical.runs || []).length; return {}; },
    });
    check('the run is on the books BEFORE the lever is awaited', seen === 1,
      `${seen} runs visible mid-lever — anything reaching the gate during a slow lever must see it`);
    await stdClass();
  })();
}
}

async function stdClass() {
  console.log('\n--- THE STANDARD CLASS, and the guard that stops it being a loophole ---');
  {
    const { CANDIDATES } = require('./automate');
    /* THE ONE THAT MATTERS. "Offered without the record earning it" is only defensible while it is
       also "cannot change the machine". If those ever come apart, klass:'standard' is just a way to
       ship a toggle nobody asked for. Asserted over the real table, not a fixture. */
    const bad = CANDIDATES.filter((c) => c.klass === 'standard' && c.tier !== 'observe');
    check('NO standard automation is allowed to change the machine', bad.length === 0,
      bad.map((c) => `${c.id} is ${c.tier}`).join(', '));
    check('and every candidate declares a class at all',
      CANDIDATES.every((c) => c.klass === 'earned' || c.klass === 'standard'));
    /* THE GUARD MUST BE LIVE, NOT DECORATIVE — and the first version of this check was itself
       decorative, which is a specific embarrassment given what it is guarding.
       It mutated the in-memory CANDIDATES array and then re-required the module. A fresh require
       re-reads the SOURCE table, so the mutation could never reach assertClasses: `threw` was
       always null, and the condition `threw === null || /standard/.test(threw)` passed on the first
       clause every time. Review proved it by printing `threw`. Deleting assertClasses entirely left
       the whole suite green.
       Now the source itself is mutated: a copy of automate.js with one candidate flipped to a
       standard-but-acting entry is written to a scratch dir and required from there. If the module
       loads, the guard is gone. `|| null` on the condition, never a passing default. */
    const scratch = freshDir();
    const src = fs.readFileSync(path.join(__dirname, 'automate.js'), 'utf8');
    const mutated = src.replace("    klass: 'earned',\n    tier: 'reversible',",
                                "    klass: 'standard',\n    tier: 'reversible',");
    check('the mutation actually applied (a no-op replace would pass this vacuously)',
      mutated !== src, 'anchor not found in automate.js — this check proves nothing as written');
    const copy = path.join(scratch, 'automate.js');
    fs.writeFileSync(copy, mutated);
    let threw = null;
    try { require(copy); } catch (e) { threw = e.message; }
    check('a standard automation that ACTS refuses to load at all', !!threw && /standard/.test(threw),
      threw === null ? 'the module loaded — assertClasses is not running' : threw);
    check('and the refusal names the offending candidate and its tier',
      !!threw && /reversible/.test(threw), threw);

    const a = new Automations(freshDir(), ledger([]), { now: clock });
    const std = a.list(WIN).items.find((i) => i.id === 'capture_on_critical');
    check('a standard automation is armable with NO manual precedent at all',
      std.evidence.earned === true && std.evidence.need.length === 0, JSON.stringify(std.evidence.need));
    check('and says why it did not have to be earned',
      /does not depend on your habits/.test(std.evidence.why), std.evidence.why);
    check('it still reports how often the situation has come up',
      std.evidence.fires === 0 && std.evidence.minFires === null,
      'evidence and permission are different jobs — the count is useful even when it is not a gate');
    check('an EARNED one is still refused with nothing behind it',
      a.arm('clean_temp_on_pressure').refused === 'unearned');
    check('and the standard one arms straight away', a.arm('capture_on_critical', WIN).ok === true);
  }

  console.log('\n--- A HOST THAT CANNOT RUN IT IS TOLD SO AT THE OFFER ---');
  {
    /* THE GAP THIS CLOSES. capture_on_critical zips with Compress-Archive, so off Windows it can be
       armed and will then fail on every single incident it exists to document. consider() already
       skipped a missing lever honestly — but far too late: by then the owner has switched on a
       thing that will never work, which is precisely the "toggle that silently never fires" the
       UNAUTOMATABLE list refuses to ship. A platform limit must be stated where the offer is made. */
    const mac = new Automations(freshDir(), ledger([]), { now: clock });   // no `has`, i.e. no PowerShell
    const item = mac.list({}).items.find((i) => i.id === 'capture_on_critical');
    check('a host without the requirement sees it marked unavailable', !!item.blocked, JSON.stringify(item.blocked));
    check('and is told WHY, in terms of the missing thing',
      /Compress-Archive/.test(item.blocked.why), item.blocked.why);
    const r = mac.arm('capture_on_critical');
    check('arming it there is refused', r.refused === 'unavailable', JSON.stringify(r).slice(0, 90));
    /* `force` must not open this door. It exists so the suite can skip a month of history; no
       amount of history makes Compress-Archive exist on a Mac. */
    check('and force does NOT override a platform limit',
      mac.arm('capture_on_critical', { force: true }).refused === 'unavailable',
      'force is for skipping evidence, not for inventing capabilities');
    check('while a host that HAS it is offered normally',
      !mac.list(WIN).items.find((i) => i.id === 'capture_on_critical').blocked);
    check('and the platform-free candidates are unaffected either way',
      !mac.list({}).items.find((i) => i.id === 'growth_scan_daily').blocked,
      'growthscan is pure Node — blocking it would be the guard overreaching');
  }

  console.log('\n--- CAPTURE FIRES ON THE BREAK, NOT ON EVERY TICK IT STAYS BROKEN ---');
  {
    const a = new Automations(freshDir(), ledger([]), { now: clock });
    a.arm('capture_on_critical', WIN);
    let shots = 0;
    const lev = { bundle: async () => { shots++; return { ok: true }; } };
    await a.consider(D(['spiral']), null, lev);
    check('the moment it breaks, evidence is captured', shots === 1);
    NOW += 60 * 60_000;
    await a.consider(D(['spiral']), null, lev);
    check('and NOT again while the same finding simply stays open', shots === 1,
      `${shots} snapshots — a critical open for six hours must not mint one every 30 s`);
    NOW += 60 * 60_000;
    await a.consider(D(['spiral', 'thrash']), null, lev);
    check('but a NEW finding appearing alongside it is a new incident', shots === 2);
  }

  console.log('\n--- CHOOSING WHICH FOLDERS IT MAY TOUCH ---');
  {
    const a = new Automations(freshDir(), ledger(earnedHistory()), { now: clock });
    const item = () => a.list(WIN).items.find((i) => i.id === 'clean_temp_on_pressure');
    check('both targets are offered, and both are on by default',
      item().options.length === 2 && item().targets.join(',') === 'usertemp,ctmp', JSON.stringify(item().targets));
    check('each target says how it differs, since that is the whole reason to choose',
      item().options.every((o) => o.what && o.what.length > 20));
    a.setTargets('clean_temp_on_pressure', ['usertemp']);
    check('a narrowed selection sticks', item().targets.join(',') === 'usertemp');
    const empty = a.setTargets('clean_temp_on_pressure', []);
    check('choosing NONE is refused rather than stored', empty.refused === 'empty-selection',
      'an armed automation with no targets would run, do nothing, and report success');
    check('and it says that turning it off is what "none" means', /turn it off/i.test(empty.error), empty.error);
    check('the refusal did not quietly wipe the previous choice', item().targets.join(',') === 'usertemp');
    check('an invented target key is dropped, not passed through',
      (a.setTargets('clean_temp_on_pressure', ['usertemp', 'C:/Windows']), item().targets.join(',')) === 'usertemp');

    /* THE POINT OF ALL OF THAT: the choice has to reach the lever. */
    a.arm('clean_temp_on_pressure');
    let got = null;
    NOW += DAY;
    await a.consider(D(['disk_low']), null, { clean: async (p) => { got = p; return { freedGB: 1 }; } });
    check('and the LEVER is handed only what was chosen', got && got.keys.join(',') === 'usertemp',
      JSON.stringify(got) + ' — a selection the page shows but the lever ignores is worse than no selection');

    a.disarm('clean_temp_on_pressure');
    check('the choice survives being turned off and on again',
      (a.arm('clean_temp_on_pressure'), item().targets.join(',')) === 'usertemp',
      'it is a preference about HOW, not a permission about WHETHER');
  }

  console.log(`\n${fail ? fail + ' FAILED of ' : 'all '}${pass + fail} checks${fail ? '' : ' passed'} — nothing is offered that was not earned, and nothing disruptive acts alone.`);
  process.exit(fail ? 1 : 0);
}
