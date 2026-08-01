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

console.log('--- only CRITICAL may interrupt ---');
{
  const { n, outbox, adv } = rig();
  n.capable = true;
  const warnOnly = diag(finding('warn1', 2), finding('note1', 1));
  n.consider(warnOnly); adv(SUSTAIN_MS + 1000);
  return_(n.consider(warnOnly));
  check('warnings and notes never notify', outbox.length === 0, JSON.stringify(outbox));
}
function return_(p) { /* consider() is async; these cases resolve synchronously via the stub */ return p; }

(async () => {

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
