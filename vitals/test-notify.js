/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - ALERTING SUITE (B4).  node test-notify.js   (any platform)
 *
 * What this proves: the GATE. Delivery is a per-platform detail and is stubbed here; what matters
 * is everything that decides whether a human gets interrupted.
 *
 * The failure mode of an alerting feature is not silence, it is CRYING WOLF - a monitor that
 * interrupts too often gets muted, and a muted monitor is worse than none because you still
 * believe it is watching. So almost every check below asserts that something did NOT fire.
 */

const { Notifier, SUSTAIN_MS, COOLDOWN_MS, MIN_GAP_MS, CRIT } = require('./notify');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra !== undefined ? '  [' + extra + ']' : ''}`); }
};

/* A controllable clock and a delivery that records instead of interrupting anyone. */
function rig(opts = {}) {
  let t = 1_000_000_000;
  const outbox = [];
  const n = new Notifier({
    now: () => t,
    deliver: (title, body) => { outbox.push({ title, body }); return opts.deliverOk !== false; },
    ...opts,
  });
  return { n, outbox, adv: (ms) => { t += ms; }, at: () => t };
}

const finding = (id, sev, extra = {}) => ({
  id, sev, title: `${id} is wrong`, short: id, action: 'Do the thing.', ...extra,
});
const diag = (...f) => ({ findings: f });

(async () => {

/* AWAITED, and it was not. This block sat outside the async wrapper below and passed its result
   through a `return_()` helper whose comment claimed consider() "resolves synchronously via the
   stub" — it does not; it is an async method and returns a pending promise either way. So the
   assertion ran before consider() had done anything, and `outbox.length === 0` was true because
   nothing had happened YET rather than because nothing was permitted to. The check would have
   passed just as cheerfully with the severity gate deleted, which is the definition of a test that
   proves nothing. */
console.log('--- only CRITICAL may interrupt ---');
{
  const { n, outbox, adv } = rig();
  n.capable = true;
  const warnOnly = diag(finding('warn1', 2), finding('note1', 1));
  await n.consider(warnOnly);
  adv(SUSTAIN_MS + 1000);
  await n.consider(warnOnly);
  check('warnings and notes never notify', outbox.length === 0, JSON.stringify(outbox));

  /* The control: the identical shape at critical severity DOES get through. Without this, the
     check above is satisfied by a notifier that never sends anything at all. */
  const { n: n2, outbox: out2, adv: adv2 } = rig();
  n2.capable = true;
  const crit = diag(finding('crit1', 3));
  await n2.consider(crit);
  adv2(SUSTAIN_MS + 1000);
  await n2.consider(crit);
  check('while the same thing at CRITICAL does notify — so the gate is a gate, not a mute',
    out2.length === 1, JSON.stringify(out2));
}

console.log('\n--- A TRUTHY VALUE IS NOT A PATH: the bug that made this feature never work ---');
{
  /* THE REAL ONE, found by wiring up delivery evidence and then asking why every send failed.
     bridge.js passed `psHost: PS_HOST`, and PS_HOST is `process.platform === 'win32'` — a boolean.
     deliver() spawns psHost as a program, so Windows ran `spawn(true)`, Node coerced it to the
     string "true", and every notification died with ENOENT. Six failures a minute for the entire
     life of the feature, while the panel showed a healthy green channel — because probe() tested
     the value for TRUTHINESS, and `true` is as truthy as it gets.
     Asserted from the wrong side: the only thing that may be accepted is a string that exists. */
  const boolHost = new Notifier({ psHost: true });
  await boolHost.probe();
  check('a boolean psHost is refused, not treated as a program name',
    boolHost.capable === false, `capable=${boolHost.capable}`);
  check('and status() names what was wrong rather than swallowing it',
    /not a path/.test(boolHost.status().psHostProblem || ''), boolHost.status().psHostProblem);

  const missing = new Notifier({ psHost: 'C:/definitely/not/here/powershell.exe' });
  await missing.probe();
  check('a psHost that does not exist on disk is refused too',
    missing.capable === false && /was not found/.test(missing.status().psHostProblem || ''),
    missing.status().psHostProblem);

  /* And the control — without it the checks above are satisfied by a notifier that refuses
     everything. On non-Windows the branch is unreachable, so it is skipped honestly rather than
     asserted vacuously. */
  if (process.platform === 'win32') {
    const { PS } = require('./pshost');
    const real = new Notifier({ psHost: PS });
    await real.probe();
    check('while the REAL resolved PowerShell path is accepted',
      real.capable === true && !real.status().psHostProblem, `${PS} -> ${real.capable}`);
  } else {
    check('(the win32 psHost branch is unreachable on this platform, so it is not asserted)', true);
  }
}

console.log('\n--- CONCURRENT PASSES: the guarantee was violated LIVE, by 899 ms ---');
{
  /* Review found two `sent` entries for the same finding 899 ms apart in this bridge's own log,
     against a promise of "never two within 15 minutes" that the panel prints verbatim. The rules
     were checked, then `await deliver()` ran for about a second, and `lastAnyAt` was only updated
     afterwards — so two overlapping calls both read the old value and both passed the gap check.
     Overlap is routine, not exotic: currentDiagnosis() calls consider() on a 30 s timer AND on
     every /api/diagnose, /api/quarantine and ask-grounding request.

     Reproduced with a SLOW deliver(), which is what makes the window real. Without the fix both
     calls send; with it, exactly one does. */
  const outbox = [];
  let inFlight = 0, maxConcurrent = 0;
  const n = new Notifier({
    psHost: 'x',
    deliver: async (t) => {
      inFlight++; maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 120));      // a real one-shot takes about a second
      inFlight--;
      outbox.push(t);
      return true;
    },
  });
  n.capable = true;
  const d = diag(finding('spiral', 3));

  await n.consider(d);
  n.seen.get('spiral').firstAt -= SUSTAIN_MS + 1000;     // age it past the sustain bar
  const [a, b] = await Promise.all([n.consider(d), n.consider(d)]);

  check('two concurrent passes send exactly ONE notification, not two',
    outbox.length === 1, `${outbox.length} sent`);
  check('and only one of the two calls reports having sent anything',
    (a.length + b.length) === 1, `${a.length} + ${b.length}`);
  check('deliver() is never entered twice at once', maxConcurrent === 1, `peak ${maxConcurrent}`);
  check('the withheld pass says WHY rather than silently returning empty',
    n.log.some((x) => x.what === 'withheld' && /concurrent/.test(x.detail || '')),
    JSON.stringify(n.log.slice(-3)));

  /* THE TWO LOCKS ARE TESTED SEPARATELY, because the comment in notify.js claims they fail
     differently — and a first cut of this suite proved only one of them. Reverting the claim to
     AFTER the await (the original bug) left every check above green, because the in-flight flag was
     doing all the work. A defence-in-depth claim needs one test per layer or it is one layer with
     two names.

     This drives `_consider` directly: the inner path, with the outer flag deliberately bypassed,
     which is exactly the case the claim-before-await exists for. */
  const outbox2 = [];
  const n3 = new Notifier({
    psHost: 'x',
    deliver: async (t) => { await new Promise((r) => setTimeout(r, 120)); outbox2.push(t); return true; },
  });
  n3.capable = true;
  const d3 = diag(finding('spiral', 3));
  await n3.consider(d3);
  n3.seen.get('spiral').firstAt -= SUSTAIN_MS + 1000;
  await Promise.all([n3._consider(d3, {}), n3._consider(d3, {})]);
  check('even with the in-flight lock BYPASSED, the gap still holds across the await',
    outbox2.length === 1, `${outbox2.length} sent through the inner path`);

  /* And the rollback: a failed send must not consume the gap, or one failure silences the next
     fifteen minutes of real alerts. */
  const n2 = new Notifier({ psHost: 'x', deliver: async () => false });
  n2.capable = true;
  const d2 = diag(finding('spiral', 3));
  await n2.consider(d2);
  n2.seen.get('spiral').firstAt -= SUSTAIN_MS + 1000;
  await n2.consider(d2);
  check('a FAILED send does not consume the minimum gap', n2.lastAnyAt === 0, `lastAnyAt=${n2.lastAnyAt}`);
  check('nor the per-finding cooldown', n2.seen.get('spiral').lastAlertAt === 0,
    `lastAlertAt=${n2.seen.get('spiral').lastAlertAt}`);
}

console.log('\n--- a finding must HOLD before it may interrupt ---');
{
  const { n, outbox, adv } = rig();
  n.capable = true;
  const d = diag(finding('spiral', CRIT));
  await n.consider(d);
  check('a brand-new critical does not interrupt immediately', outbox.length === 0);

  adv(SUSTAIN_MS / 2);
  await n.consider(d);
  check('nor halfway through the sustain window', outbox.length === 0);

  adv(SUSTAIN_MS / 2 + 1000);
  await n.consider(d);
  check('once it has held, it interrupts', outbox.length === 1, JSON.stringify(outbox));
  check('the message names the finding', /spiral/.test(outbox[0].title));
  check('and says how long it has been holding', /Holding for \d+ min/.test(outbox[0].body), outbox[0].body);
  check('and carries the fix', /Do the thing/.test(outbox[0].body));
}

console.log('\n--- it does not repeat itself ---');
{
  const { n, outbox, adv } = rig();
  n.capable = true;
  const d = diag(finding('disk', CRIT));
  await n.consider(d); adv(SUSTAIN_MS + 1000); await n.consider(d);
  check('fires once', outbox.length === 1);

  for (let i = 0; i < 20; i++) { adv(60_000); await n.consider(d); }
  check('and stays quiet for the whole cooldown while the problem persists',
    outbox.length === 1, `${outbox.length} alerts`);

  adv(COOLDOWN_MS * 1.3);
  await n.consider(d);
  check('after the cooldown it may speak again', outbox.length === 2);
}

console.log('\n--- a guaranteed minimum gap between ANY two alerts ---');
{
  const { n, outbox, adv } = rig();
  n.capable = true;
  const two = diag(finding('a', CRIT), finding('b', CRIT));
  await n.consider(two); adv(SUSTAIN_MS + 1000); await n.consider(two);
  check('two simultaneous criticals produce ONE notification, not two',
    outbox.length === 1, JSON.stringify(outbox.map((o) => o.title)));

  adv(MIN_GAP_MS / 2);
  await n.consider(two);
  check('the second waits for the gap', outbox.length === 1);

  adv(MIN_GAP_MS / 2 + 1000);
  await n.consider(two);
  check('and arrives once the gap has passed', outbox.length === 2);
  check('they are different findings', outbox[0].title !== outbox[1].title,
    outbox.map((o) => o.title).join(','));
}

console.log('\n--- nothing while you are already looking at it ---');
{
  const { n, outbox, adv } = rig();
  n.capable = true;
  const d = diag(finding('thrash', CRIT));
  await n.consider(d, { watching: true });
  adv(SUSTAIN_MS + 1000);
  await n.consider(d, { watching: true });
  check('a focused diagnosis page suppresses the notification', outbox.length === 0);
  check('and the suppression is recorded, not silent',
    n.status().recent.some((r) => r.what === 'withheld'), JSON.stringify(n.status().recent));

  /* The important half: being at the screen must not CONSUME the alert. */
  await n.consider(d, { watching: false });
  check('walking away still gets you the alert', outbox.length === 1);
}

console.log('\n--- a finding that clears and returns is a NEW event ---');
{
  const { n, outbox, adv } = rig();
  n.capable = true;
  const d = diag(finding('battery', CRIT));
  await n.consider(d); adv(SUSTAIN_MS + 1000); await n.consider(d);
  check('it fires', outbox.length === 1);

  await n.consider(diag());                       // cleared
  adv(MIN_GAP_MS + 1000);
  await n.consider(d);                            // returns
  check('a recurrence must re-earn its sustain window', outbox.length === 1);
  adv(SUSTAIN_MS + 1000);
  await n.consider(d);
  check('and then interrupts again rather than being suppressed by the old cooldown',
    outbox.length === 2, `${outbox.length}`);
}

console.log('\n--- window-hash scheduling ---');
{
  const { n } = rig();
  const a = n.nextEligible('spiral', 0);
  const b = n.nextEligible('disk_low', 0);
  check('the next slot is at least a full cooldown away', a >= COOLDOWN_MS && b >= COOLDOWN_MS);
  check('and at most a quarter beyond it', a <= COOLDOWN_MS * 1.25 && b <= COOLDOWN_MS * 1.25);
  check('different findings land on different offsets, not all on the hour', a !== b, `${a} vs ${b}`);
  check('it is DETERMINISTIC — a restart must not re-roll the schedule',
    n.nextEligible('spiral', 0) === a);
}

console.log('\n--- refusals ---');
{
  const { n, outbox, adv } = rig({ deliverOk: false });
  n.capable = true;
  const d = diag(finding('x', CRIT));
  await n.consider(d); adv(SUSTAIN_MS + 1000);
  const sent = await n.consider(d);
  check('a delivery that fails reports nothing sent', sent.length === 0);
  check('and is recorded as failed rather than as delivered',
    n.status().recent.some((r) => r.what === 'failed'));
  check('a failed delivery does not consume the cooldown',
    n.seen.get('x').lastAlertAt === 0);

  const off = rig();
  off.n.enabled = false; off.n.capable = true;
  off.adv(SUSTAIN_MS + 1000);
  await off.n.consider(d);
  check('disabled means silent', off.outbox.length === 0);

  const none = rig({ deliver: null });
  none.n.capable = false;
  none.adv(SUSTAIN_MS + 1000);
  const r = await none.n.consider(d);
  check('a host that cannot notify sends nothing rather than throwing', Array.isArray(r));

  const { n: n2 } = rig();
  check('a malformed diagnosis is ignored', (await n2.consider(null)).length === 0);
  check('and so is one with no findings array', (await n2.consider({})).length === 0);
}

console.log('\n--- the status is honest about what it can do ---');
{
  const { n } = rig();
  n.capable = null;
  const s = n.status();
  check('capability is null before it has been probed, not false', s.capable === null);
  check('the rules are published, not implied',
    s.rules.severity === 'critical only' && s.rules.sustainSec > 0 && s.rules.cooldownHours > 0);
}

console.log(`\n${fail ? fail + ' FAILED of ' : 'all '}${pass + fail} checks${fail ? '' : ' passed'} — the bar to interrupt someone is high, and every part of it is stated.`);
process.exit(fail ? 1 : 0);
})();
