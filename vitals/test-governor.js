/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - GOVERNOR SUITE (B12).  node test-governor.js   (any platform)
 *
 * What this proves: it throttles on the SYMPTOM rather than on load, it cannot oscillate, and — the
 * one that matters most — it does not treat an ABSENT signal as a good one.
 *
 * That last case is the whole risk of a symptom oracle. When the panel is closed there are no
 * frames to measure, and a governor that reads "no stall reported" as "no stall" would defer
 * background work forever on a machine nobody is even looking at. The failure would be invisible:
 * the record simply stops being kept, and nothing reports an error.
 */

const { Governor, STALL_FRAME_MS, JANK_THROTTLE, JANK_RELEASE, SIGNAL_STALE_MS } = require('./governor');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra !== undefined ? '  [' + extra + ']' : ''}`); }
};

function rig() {
  let t = 1_000_000;
  const g = new Governor({ now: () => t });
  return { g, adv: (ms) => { t += ms; }, at: () => t };
}

/** `n` frame intervals of which `jankFrac` overran the budget. */
const frames = (n, jankFrac) => Array.from({ length: n }, (_, i) =>
  (i / n) < jankFrac ? STALL_FRAME_MS + 20 : 16.7);

console.log('--- an ABSENT signal is not a good signal ---');
{
  const { g, adv } = rig();
  const a = g.allow('growth');
  check('with no report ever, work is ALLOWED', a.run === true);
  check('and the reason says there is no foreground to protect',
    /no foreground to protect/.test(a.why), a.why);
  check('the measurement is null, not zero', a.stall === null);

  const st = g.status();
  check('status calls the signal "none"', st.signal === 'none');
  check('and says plainly that absence is not smoothness',
    /ABSENCE of\s+evidence, not evidence of smoothness/.test(st.signalNote.replace(/\s+/g, ' ')
      .replace('ABSENCE of evidence', 'ABSENCE of\n evidence')) || /not evidence of smoothness/.test(st.signalNote),
    st.signalNote.slice(0, 80));

  /* And the stale case: a panel that WAS reporting and then stopped (closed, docked, hidden). */
  g.report(frames(120, 0.9));
  check('while reporting badly, it throttles', g.allow('x').run === false);
  adv(SIGNAL_STALE_MS + 1000);
  const after = g.allow('x');
  check('once the reports stop, throttling is RELEASED rather than latched', after.run === true,
    after.why);
  check('and it is recorded as the signal going away',
    g.status().recent.some((r) => r.what === 'release' && /signal went away/.test(r.detail)));
}

console.log('\n--- it throttles on the SYMPTOM ---');
{
  const { g } = rig();
  g.report(frames(200, 0.02));
  const smooth = g.allow('trend');
  check('a smooth foreground allows work', smooth.run === true, smooth.why);
  check('and reports the jank it measured', /jank/.test(smooth.why), smooth.why);

  const { g: g2 } = rig();
  g2.report(frames(200, 0.35));
  const janky = g2.allow('trend');
  check('a stalling foreground defers it', janky.run === false);
  check('the reason NAMES the job and the measurement',
    /trend is deferred/.test(janky.why) && /% of the last/.test(janky.why), janky.why);
  check('and carries the p95, not just an average', janky.stall.p95 >= STALL_FRAME_MS, janky.stall.p95);
}

console.log('\n--- jank ratio, not average frame time ---');
{
  /* The motivating case, made concrete. Sixty frames at 16 ms with four at 300 ms average about
     35 ms — which sounds survivable and is not. What the user feels is the four. */
  const { g } = rig();
  const f = Array.from({ length: 60 }, (_, i) => (i % 15 === 0 ? 300 : 16.7));
  g.report(f);
  const s = g.stall();
  const mean = f.reduce((a, b) => a + b, 0) / f.length;
  check('the mean of a hitchy second looks survivable', mean < 40, mean.toFixed(1));
  check('but the jank ratio sees it', s.jank >= 0.06, s.jank);
  check('and p95 sees it', s.p95 > 200, s.p95);
  check('while p50 stays honest about the typical frame', s.p50 < 20, s.p50);

  /* AND THE DECISION, which is the thing this module actually produces. The checks above assert
     that the METRIC noticed; none of them asserted what the governor DID, and what it does here is
     nothing — 4 hitches in 60 frames is 6.7%, a third of JANK_THROTTLE. Asserting the number and
     stopping is how a module comes to have a motivating example it does not act on. Pinned in both
     directions so the bar cannot drift without this failing. */
  const d = g.allow('maintenance');
  check('the motivating example does NOT trip the governor, and the suite says so',
    d.run === true && s.jank < JANK_THROTTLE,
    `${(s.jank * 100).toFixed(1)}% jank against a ${(JANK_THROTTLE * 100).toFixed(0)}% bar`);
  check('and the reason it gives repeats the evidence against itself rather than hiding it',
    /p95 300/.test(d.why), d.why);

  /* What the bar IS for: a sustained stall, not occasional hitching. */
  const { g: g2 } = rig();
  g2.report(Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? 300 : 16.7)));
  const d2 = g2.allow('maintenance');
  check('a third of frames hitching DOES defer the work', d2.run === false,
    `${(g2.stall().jank * 100).toFixed(0)}% jank — ${d2.why}`);
}

console.log('\n--- hysteresis: it cannot oscillate ---');
{
  const { g, adv } = rig();
  /* Sit exactly between the two thresholds — the value that would make a single-threshold
     governor flap on every call, doing background work in bursts at the worst moments. */
  const mid = (JANK_THROTTLE + JANK_RELEASE) / 2;

  g.report(frames(200, 0.4));
  check('it throttles when clearly bad', g.allow('a').run === false);

  adv(500); g.report(frames(200, mid));
  const flips = [];
  for (let i = 0; i < 8; i++) { adv(200); g.report(frames(200, mid)); flips.push(g.allow('a').run); }
  check('between the thresholds it STAYS throttled rather than flapping',
    flips.every((f) => f === false), flips.join(','));

  /* Release requires the WINDOW to be clean, not merely the latest report — so the janky frames
     have to age out first. The first version of this advanced 500 ms and expected an immediate
     release, which would only have passed if the governor were judging on the last report rather
     than on its window. The test was wrong; the behaviour is the point. */
  for (let i = 0; i < 6; i++) { adv(900); g.report(frames(200, 0.01)); }
  check('and only releases well below the throttle line, once the window has cleared',
    g.allow('a').run === true, JSON.stringify(g.stall()));

  /* And the mirror: hovering below the throttle line must not start throttling. */
  const { g: g3, adv: adv3 } = rig();
  const flips3 = [];
  for (let i = 0; i < 8; i++) { adv3(200); g3.report(frames(200, mid)); flips3.push(g3.allow('a').run); }
  check('approaching from below, it stays permissive', flips3.every((f) => f === true), flips3.join(','));
}

console.log('\n--- it refuses to judge on too little evidence ---');
{
  const { g } = rig();
  g.report([16, 16, 300]);
  check('three frames is not a measurement', g.stall() === null);
  check('and work proceeds rather than being deferred on it', g.allow('x').run === true);

  g.report(frames(200, 0.5));
  check('with enough frames it judges', g.stall() !== null && g.allow('x').run === false);
}

console.log('\n--- the verdict follows the MEASUREMENT, not the last time something asked ---');
{
  /* The regression this guards, found live rather than reasoned about. The transition used to
     happen only inside allow(), which deferrable jobs call on a ten-minute period — so under total
     stall the status reported "not throttled" until some job happened to ask. A verdict lagging its
     own evidence by ten minutes reads, correctly, as the governor not working at all. */
  const { g } = rig();
  g.report(frames(300, 1.0));                     // every single frame hitching
  const st = g.status();                          // status alone, with no job asking
  check('reading status ALONE updates the verdict', st.throttled === true, JSON.stringify(st.stall));
  check('and the stall it reports is total', st.stall.jank === 1, st.stall.jank);
  check('the transition is logged from that status read',
    g.status().recent.some((r) => r.what === 'throttle'));

  /* And the reverse: recovery must be visible without a job asking either. */
  const { g: g2, adv } = rig();
  g2.report(frames(300, 1.0));
  g2.status();
  check('throttled after a bad window', g2.throttled === true);
  for (let i = 0; i < 6; i++) { adv(900); g2.report(frames(300, 0)); }
  check('and released by a status read once it recovers', g2.status().throttled === false);
}

console.log('\n--- refusals and bookkeeping ---');
{
  const { g } = rig();
  g.report(null); g.report([]); g.report(['x', NaN, -5, 99999]);
  check('junk reports are ignored entirely', g.stall() === null);
  g.report(frames(200, 0.6));
  g.allow('a'); g.allow('b'); g.allow('c');
  const st = g.status();
  check('deferrals are counted', st.deferrals >= 3, st.deferrals);
  check('the thresholds it used are published, not implied',
    st.thresholds.throttleAt === JANK_THROTTLE && st.thresholds.releaseAt === JANK_RELEASE);
  check('and how long it has been throttled', st.throttled === true && st.throttledForSec >= 0);
}

console.log(`\n${fail ? fail + ' FAILED of ' : 'all '}${pass + fail} checks${fail ? '' : ' passed'} — it throttles on the symptom, and never mistakes silence for smoothness.`);
process.exit(fail ? 1 : 0);
