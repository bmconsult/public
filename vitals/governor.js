/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - THE SYMPTOM-ORACLE GOVERNOR.  (B12, MARKET_RESEARCH §9)
 *
 * Throttle background work against MEASURED FOREGROUND STALL, not against CPU percentage.
 *
 * CPU load is a cause, and a bad proxy for the thing anyone cares about. A machine at 90% CPU that
 * still repaints smoothly is fine; a machine at 30% that hitches every second is not. Backing off
 * on load means backing off exactly when the user is doing something demanding and deliberate,
 * which is the moment the record is most worth keeping. Backing off on STALL means backing off when
 * the machine is actually failing to keep up - which is the symptom, and the only signal that
 * justifies the instrument getting out of the way.
 *
 * ---------------------------------------------------------------------------------------------
 * WHERE THE SIGNAL COMES FROM, AND WHAT WAS RULED OUT FIRST.
 *
 * PresentMon was the obvious source and it is not usable here. `PresentMonSharedService` IS running
 * on the reference machine - the research note was right about that - but it exposes NO performance
 * counter set, and no PresentMon binary is installed alongside it. Its frame data travels over ETW
 * and its own IPC, which needs the SDK or a kernel trace session. Checked, 2026-08-01, rather than
 * assumed in either direction.
 *
 * So the signal is one this product can measure honestly and completely: THE PANEL'S OWN FRAME
 * INTERVALS. The panel is a real foreground GUI process on this machine, driven by requestAnimation-
 * Frame. When the desktop stalls, its frames stretch. That is not a proxy for foreground stall - it
 * IS foreground stall, observed in the one foreground process this product owns and is entitled to
 * instrument.
 *
 * ITS HONEST LIMIT, enforced rather than footnoted: when no panel is rendering - closed, docked,
 * hidden, occluded - there is NO SIGNAL. Not "no stall". The governor therefore does NOT throttle
 * when the signal is absent, because "we cannot see" must never be read as "everything is fine",
 * and a background job deferred on the strength of no evidence is a job that never runs.
 *
 * JANK RATIO, not average frame time. An average hides the hitch: sixty frames at 16 ms with four
 * at 300 ms averages 35 ms, which sounds survivable and is not. The measure is the FRACTION of
 * frames that overran their budget - the same p95-over-mean argument the storage substrate is
 * built on, applied to the thing the user actually perceives.
 *
 * ---------------------------------------------------------------------------------------------
 * AND THAT EXAMPLE IS BELOW THIS GOVERNOR'S OWN THRESHOLD, which the header did not use to say.
 *
 * Four hitches in sixty-four frames is 6.3% jank. JANK_THROTTLE is 20%. So the case written above
 * to motivate the design is a case this governor watches go past and does nothing about - it
 * reports "foreground is keeping up (6% jank, p95 300 ms)", a sentence containing both its verdict
 * and the evidence against it. The example was right about the METRIC and silent about the BAR,
 * and read as though it justified both.
 *
 * Reconciled by saying what the bar is for. Jank ratio is the right measure, and 20% is not a
 * perceptual claim - nobody has established that a fifth of frames is where a person notices. It is
 * a claim about the COST OF BEING WRONG, and the two directions are not symmetric:
 *
 *   throttle when the machine was fine   background work stops, maintenance silently never runs,
 *                                        and the user never learns why. Invisible and permanent.
 *   don't throttle when it was janky     a background job keeps running through some stutter the
 *                                        user was having anyway. Visible and over in seconds.
 *
 * So the bar is set high on purpose, and the honest consequence is stated rather than buried: a
 * panel hitching four times a second WILL NOT defer background work here. What this governor
 * protects against is a sustained stall - a fifth of frames or more, for seconds - which is the
 * regime where continuing to run maintenance turns bad into unusable. Occasional hitching is left
 * alone deliberately, because the remedy costs more than the symptom.
 * ---------------------------------------------------------------------------------------------
 */

const STALL_FRAME_MS = 34;        // ~2 frames at 60 Hz: a frame this long is a visible hitch
const WINDOW_MS = 4000;           // how much recent evidence a verdict rests on
const SIGNAL_STALE_MS = 6000;     // beyond this, the panel is not reporting and there is NO signal
/* NOT a perceptual threshold - see the header. A deliberate bias toward letting work run, because
   a wrongly-deferred background job is invisible and permanent while a wrongly-continued one is
   visible and brief. */
const JANK_THROTTLE = 0.20;
const JANK_RELEASE = 0.08;        // and only resume well below it, so it cannot oscillate

class Governor {
  constructor(opts = {}) {
    this.now = opts.now || (() => Date.now());
    this.frames = [];             // {at, ms}
    this.lastReportAt = 0;
    this.throttled = false;
    /* Which absence stall() last hit, so allow() and status() can say which one rather than
       printing the same sentence for two different situations. */
    this.lastAbsence = null;
    this.since = 0;
    this.deferred = 0;
    this.log = [];
  }

  /**
   * The panel reports what it just measured. Frame intervals, not a verdict - the decision belongs
   * in one place and the panel is not it.
   */
  report(intervalsMs) {
    if (!Array.isArray(intervalsMs) || !intervalsMs.length) return;
    const t = this.now();
    this.lastReportAt = t;
    for (const ms of intervalsMs) {
      if (typeof ms === 'number' && isFinite(ms) && ms > 0 && ms < 10_000) this.frames.push({ at: t, ms });
    }
    const cutoff = t - WINDOW_MS;
    while (this.frames.length && this.frames[0].at < cutoff) this.frames.shift();
    if (this.frames.length > 4000) this.frames.splice(0, this.frames.length - 4000);
  }

  /** The measurement, or null when there is no signal at all. */
  /* TWO DIFFERENT ABSENCES, AND THEY USED TO SHARE ONE RETURN VALUE - this file's own
     render-loop-settle-law, committed inside the module that quotes it. `null` meant both "no panel
     is reporting" and "a panel is reporting but has sent fewer than 20 frames", and allow() printed
     the first sentence for both. So a panel rendering and hitching on EVERY frame was described as
     "no panel is rendering, so there is no foreground to protect" - the most confident possible
     wording for the case where the evidence points the other way. Verified: 19 all-janky frames
     produced exactly that sentence; the 20th flipped it to a refusal.
     `why` now distinguishes them. Both still decline to throttle, which is correct - too few frames
     is genuinely too little evidence - but the reader is told which of the two they are looking at. */
  stall() {
    const t = this.now();
    if (!this.lastReportAt || t - this.lastReportAt > SIGNAL_STALE_MS) {
      this.lastAbsence = 'no panel is rendering, so there is no foreground to protect';
      return null;
    }
    const win = this.frames.filter((f) => f.at >= t - WINDOW_MS);
    if (win.length < 20) {
      this.lastAbsence = `a panel IS rendering but has only sent ${win.length} frames in the last ` +
        `${WINDOW_MS / 1000}s — too few to characterise, so this is not evidence that it is smooth`;
      return null;
    }
    this.lastAbsence = null;
    const janky = win.filter((f) => f.ms >= STALL_FRAME_MS).length;
    const sorted = win.map((f) => f.ms).sort((a, b) => a - b);
    return {
      frames: win.length,
      jank: +(janky / win.length).toFixed(3),
      p50: +sorted[Math.floor(sorted.length * 0.5)].toFixed(1),
      p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1),
      worst: +sorted[sorted.length - 1].toFixed(1),
    };
  }

  /**
   * Bring the throttle state up to date with the current measurement.
   *
   * SEPARATED FROM allow() DELIBERATELY. The first version only ever transitioned inside allow(),
   * which is called by a deferrable job — and those run on a ten-minute period. So under total
   * stall the status page reported `throttled: false` until some job happened to ask, which is a
   * verdict lagging its own evidence by up to ten minutes and reads on screen as the governor
   * simply not working. Measured live: 100% of frames hitching, still reporting not-throttled.
   * The state now follows the measurement, and every reader gets the same answer.
   */
  evaluate() {
    const s = this.stall();
    const t = this.now();

    if (!s) {
      /* NO SIGNAL IS NOT A GREEN LIGHT AND IT IS NOT A RED ONE. It means the panel is not
         rendering, which is precisely when background work is least disruptive. */
      if (this.throttled) { this.throttled = false; this.note('release', 'the signal went away'); }
      return null;
    }

    /* HYSTERESIS. One threshold would let a machine hovering at the line flap between throttled and
       not, which is worse than either state: the work happens in bursts at exactly the wrong
       moments, and the log becomes unreadable. */
    if (!this.throttled && s.jank >= JANK_THROTTLE) {
      this.throttled = true; this.since = t;
      this.note('throttle', `${(s.jank * 100).toFixed(0)}% of frames over ${STALL_FRAME_MS} ms`);
    } else if (this.throttled && s.jank <= JANK_RELEASE) {
      this.throttled = false;
      this.note('release', `jank back to ${(s.jank * 100).toFixed(0)}%`);
    }
    return s;
  }

  /**
   * Should a deferrable background job run right now?
   *
   * Returns {run, why} — never a bare boolean, because every deferral has to be explainable. A job
   * that silently did not happen is indistinguishable from a bug.
   */
  allow(job) {
    const s = this.evaluate();

    if (!s) {
      return { run: true,
               why: this.lastAbsence || 'no panel is rendering, so there is no foreground to protect',
               stall: null };
    }

    if (this.throttled) {
      this.deferred++;
      return {
        run: false, stall: s,
        why: `the foreground is stalling — ${(s.jank * 100).toFixed(0)}% of the last ${s.frames} ` +
             `frames took over ${STALL_FRAME_MS} ms (p95 ${s.p95} ms). ` +
             `${job || 'this job'} is deferred until it clears.`,
      };
    }
    return { run: true, why: `foreground is keeping up (${(s.jank * 100).toFixed(0)}% jank, p95 ${s.p95} ms)`, stall: s };
  }

  note(what, detail) {
    this.log.push({ at: this.now(), what, detail });
    if (this.log.length > 100) this.log.shift();
  }

  status() {
    /* Evaluated, not merely read. A status that reports a state nobody has recomputed is reporting
       when something last asked, not what is true now. */
    const s = this.evaluate();
    return {
      signal: s ? 'live' : 'none',
      /* Said in as many words, because "none" would otherwise be read as "no stall". */
      signalNote: s ? 'measured from the panel\'s own frame intervals'
        : (this.lastAbsence && /only sent/.test(this.lastAbsence))
          ? this.lastAbsence + '. This is an ABSENCE of evidence, not evidence of smoothness, so ' +
            'nothing is deferred on the strength of it.'
        : 'no panel is rendering, so foreground stall cannot be measured. This is an ABSENCE of ' +
          'evidence, not evidence of smoothness — and background work proceeds, because a job ' +
          'deferred on no evidence is a job that never runs.',
      stall: s,
      throttled: this.throttled,
      throttledForSec: this.throttled ? Math.round((this.now() - this.since) / 1000) : 0,
      deferrals: this.deferred,
      thresholds: { stallFrameMs: STALL_FRAME_MS, throttleAt: JANK_THROTTLE, releaseAt: JANK_RELEASE,
                    windowMs: WINDOW_MS },
      recent: this.log.slice(-15),
    };
  }
}

module.exports = { Governor, STALL_FRAME_MS, JANK_THROTTLE, JANK_RELEASE, SIGNAL_STALE_MS, WINDOW_MS };
