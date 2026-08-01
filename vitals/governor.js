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
 */

const STALL_FRAME_MS = 34;        // ~2 frames at 60 Hz: a frame this long is a visible hitch
const WINDOW_MS = 4000;           // how much recent evidence a verdict rests on
const SIGNAL_STALE_MS = 6000;     // beyond this, the panel is not reporting and there is NO signal
const JANK_THROTTLE = 0.20;       // a fifth of frames hitching: back off
const JANK_RELEASE = 0.08;        // and only resume well below it, so it cannot oscillate

class Governor {
  constructor(opts = {}) {
    this.now = opts.now || (() => Date.now());
    this.frames = [];             // {at, ms}
    this.lastReportAt = 0;
    this.throttled = false;
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
  stall() {
    const t = this.now();
    if (!this.lastReportAt || t - this.lastReportAt > SIGNAL_STALE_MS) return null;
    const win = this.frames.filter((f) => f.at >= t - WINDOW_MS);
    if (win.length < 20) return null;          // too few frames to characterise anything
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
      return { run: true, why: 'no panel is rendering, so there is no foreground to protect', stall: null };
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
