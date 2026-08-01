/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - PROACTIVE ALERTING.  (B4, MARKET_RESEARCH §6.3)
 *
 * Everything else this product does requires you to be looking at it. That is the difference
 * between "a thing you look at" and "a thing that tells you", and it is the whole of this file.
 *
 * The panel already journals threshold crossings - but only while it is open, in memory, on a page
 * nobody is watching. A machine that starts thrashing while docked, minimised or closed produces a
 * perfect record that is read hours later, which is the moment the record stops being useful.
 *
 * THE DECISION LIVES IN THE BRIDGE, not the panel. The bridge runs whether or not a window exists,
 * so alerting has to be server-side for the same reason the diagnosis loop is: an audit that only
 * happens while someone is looking is an audit of the moments nobody needed it.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT IT WILL AND WILL NOT INTERRUPT YOU FOR. This is the entire design risk.
 *
 * A monitor that cries wolf gets muted, and a muted monitor is worse than none - it is a monitor
 * you believe is watching. So the bar is deliberately high and every part of it is stated:
 *
 *   1. CRITICAL ONLY. Warnings and notes never notify. They are on the page when you look.
 *   2. IT MUST HAVE HELD. A finding has to survive SUSTAIN_MS of consecutive diagnoses before it
 *      is allowed to interrupt - the same "sustained, not a spike" discipline the rule engine
 *      itself runs on, applied one level up.
 *   3. ONE ALERT PER FINDING PER COOLDOWN. Re-notifying about a disk that is still full teaches
 *      people to dismiss without reading.
 *   4. A GUARANTEED MINIMUM GAP between any two alerts, whatever fired them.
 *   5. NOTHING WHILE YOU ARE LOOKING AT IT. If the panel is focused and showing the diagnosis, the
 *      notification is redundant and it is suppressed - you are already being told.
 *
 * WINDOW-HASH SCHEDULING. The cooldown is not a bare timer. Every alert's next-eligible moment is
 * derived from a hash of (finding id + machine), which spreads re-alerts deterministically across
 * the cooldown window instead of bunching them on round numbers. On one machine that is a small
 * politeness; the reason it is built this way is that the same scheduler is what stops a fleet of
 * machines from all reporting the same power-cut at the same second. Same rule, one machine or a
 * thousand, and it costs one hash.
 * ---------------------------------------------------------------------------------------------
 *
 * DELIVERY IS A CAPABILITY, NOT AN ASSUMPTION. Each platform has a different mechanism and some
 * hosts have none. Rather than pretend, `probe()` establishes what actually works ON THIS MACHINE
 * and the panel reports the answer - including "this host cannot raise a notification", which is a
 * useful thing to know before you rely on being told.
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');

const SUSTAIN_MS = 90_000;        // a finding must hold this long before it may interrupt
const COOLDOWN_MS = 6 * 3600_000; // per finding
const MIN_GAP_MS = 15 * 60_000;   // between any two alerts, whatever fired them

/* Severity 3 is CRIT in diagnose.js. Named here rather than imported so a change to the engine's
   numbering cannot silently widen what is allowed to interrupt someone. */
const CRIT = 3;

class Notifier {
  /**
   * @param opts.psHost   resolved PowerShell path on Windows, or null
   * @param opts.deliver  override for tests: (title, body) => Promise<boolean>
   * @param opts.now      override for tests
   */
  constructor(opts = {}) {
    this.psHost = opts.psHost || null;
    this._deliver = opts.deliver || null;
    this.now = opts.now || (() => Date.now());
    this.seen = new Map();          // finding id -> { firstAt, lastAlertAt }
    this.lastAnyAt = 0;
    this.log = [];                  // what was sent, and what was withheld and why
    this.enabled = opts.enabled !== false;
    this.capable = null;            // null until probed
    this.how = null;
  }

  /* ---------- capability ---------- */

  /**
   * Can this host actually raise a notification? Answered by TRYING, once, rather than by
   * inferring from the platform - a headless Linux box, a Windows install with notifications
   * disabled by policy and a Mac with Do Not Disturb are all "supported platforms" that cannot
   * deliver, and the difference matters to someone deciding whether to rely on this.
   */
  async probe() {
    if (this.capable !== null) return this.capable;
    if (this._deliver) { this.capable = true; this.how = 'injected'; return true; }
    try {
      if (process.platform === 'win32' && this.psHost) {
        this.capable = true; this.how = 'toast (Windows notification centre)';
      } else if (process.platform === 'darwin') {
        this.capable = true; this.how = 'osascript display notification';
      } else if (process.platform === 'linux') {
        this.capable = await new Promise((res) => {
          const p = spawn('which', ['notify-send'], { stdio: 'ignore' });
          p.on('error', () => res(false));
          p.on('close', (c) => res(c === 0));
        });
        this.how = this.capable ? 'notify-send (libnotify)' : null;
      } else { this.capable = false; }
    } catch { this.capable = false; }
    return this.capable;
  }

  status() {
    return {
      enabled: this.enabled,
      capable: this.capable,
      how: this.how,
      rules: {
        severity: 'critical only',
        sustainSec: SUSTAIN_MS / 1000,
        cooldownHours: COOLDOWN_MS / 3600_000,
        minGapMin: MIN_GAP_MS / 60_000,
      },
      lastAnyAt: this.lastAnyAt || null,
      recent: this.log.slice(-25),
    };
  }

  /* ---------- the gate ---------- */

  /**
   * Offer a diagnosis. Returns the alerts actually sent.
   *
   * `watching` is true when a human is demonstrably looking at the diagnosis right now, in which
   * case nothing is sent - the notification would be telling someone what is already on their
   * screen, which is how a channel gets muted.
   */
  async consider(diag, { watching = false } = {}) {
    if (!this.enabled || !diag || !Array.isArray(diag.findings)) return [];
    const now = this.now();
    const crit = diag.findings.filter((f) => f.sev >= CRIT);
    const live = new Set(crit.map((f) => f.id));

    /* A finding that cleared loses its history, so if it returns tomorrow it is a NEW event and
       gets to interrupt again. Keeping the old timestamp would silently suppress a genuine
       recurrence, which is the failure nobody ever notices. */
    for (const id of [...this.seen.keys()]) if (!live.has(id)) this.seen.delete(id);

    const sent = [];
    for (const f of crit) {
      let s = this.seen.get(f.id);
      if (!s) { s = { firstAt: now, lastAlertAt: 0 }; this.seen.set(f.id, s); }

      const held = now - s.firstAt;
      if (held < SUSTAIN_MS) continue;                          // not yet proven, stay quiet
      if (s.lastAlertAt && now < this.nextEligible(f.id, s.lastAlertAt)) continue;
      if (now - this.lastAnyAt < MIN_GAP_MS) continue;
      if (watching) {
        /* Deliberately does NOT set lastAlertAt: being at the screen now must not consume the
           alert you would have wanted when you walked away. */
        this.note(f.id, 'withheld', 'the panel was focused on the diagnosis');
        continue;
      }

      const title = f.short || f.title;
      const body = this.body(f, held);
      let ok = false;
      try { ok = await this.deliver(title, body); }
      catch (e) { this.note(f.id, 'failed', e.message); continue; }

      if (ok) {
        s.lastAlertAt = now;
        this.lastAnyAt = now;
        this.note(f.id, 'sent', title);
        sent.push({ id: f.id, title, body, at: now });
        /* One per pass. Two notifications arriving together are read as one and dismissed as one,
           so the second finding waits for the next gap rather than being spent. */
        break;
      } else {
        this.note(f.id, 'failed', 'the host declined to display it');
      }
    }
    return sent;
  }

  /** The sentence someone reads on a lock screen, with the fix if the finding carries one. */
  body(f, heldMs) {
    const mins = Math.round(heldMs / 60000);
    const bits = [];
    if (f.title && f.short && f.title !== f.short) bits.push(f.title);
    bits.push(`Holding for ${mins} min.`);
    if (f.action) bits.push(f.action);
    return bits.join(' ').slice(0, 300);
  }

  /**
   * WINDOW-HASH SCHEDULING. Next eligible moment for this finding: the cooldown, plus a stable
   * per-(finding, machine) offset spread across a quarter of it. Deterministic, so it survives a
   * restart without re-rolling and without needing to be stored.
   */
  nextEligible(id, lastAt) {
    const h = crypto.createHash('sha1').update(id + ' ' + os.hostname()).digest();
    const frac = h.readUInt32BE(0) / 0xffffffff;
    return lastAt + COOLDOWN_MS + Math.round(frac * COOLDOWN_MS * 0.25);
  }

  note(id, what, detail) {
    this.log.push({ at: this.now(), id, what, detail });
    if (this.log.length > 200) this.log.shift();
  }

  /* ---------- delivery ---------- */

  deliver(title, body) {
    if (this._deliver) return Promise.resolve(this._deliver(title, body));
    if (this.capable === false) return Promise.resolve(false);

    if (process.platform === 'darwin') {
      return this.run('osascript', ['-e',
        `display notification ${q(body)} with title ${q('VITALS')} subtitle ${q(title)}`]);
    }
    if (process.platform === 'linux') {
      return this.run('notify-send', ['-u', 'critical', '-a', 'VITALS', `VITALS — ${title}`, body]);
    }
    if (process.platform === 'win32' && this.psHost) {
      /* WinRT toast through the shell's own AppId. No third-party module, nothing installed, and
         it outlives the panel because the notification is owned by the notification centre rather
         than by a window.

         PASSED AS -EncodedCommand, and that is not fussiness. A script handed to `-Command` is
         parsed TWICE - once when the launching process builds the command line and once by
         PowerShell itself - so the inner quotes are eaten on the way through. The first version of
         this arrived as `GetElementsByTagName(text)`, unquoted, and failed to parse: silently, in a
         detached process whose output goes nowhere, reported only as "the host declined". Base64
         UTF-16LE gets exactly one parser.

         The two pieces of text ride in the ENVIRONMENT rather than being interpolated into the
         script, so a finding whose title contains a quote or an ampersand cannot break it. */
      const script = [
        '$ErrorActionPreference = "Stop"',
        '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
        '[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]',
        '$tpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
        '$n = $tpl.GetElementsByTagName("text")',
        '$n.Item(0).AppendChild($tpl.CreateTextNode($env:VITALS_TITLE)) | Out-Null',
        '$n.Item(1).AppendChild($tpl.CreateTextNode($env:VITALS_BODY)) | Out-Null',
        '$toast = [Windows.UI.Notifications.ToastNotification]::new($tpl)',
        '$appId = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"',
        '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)',
      ].join('\n');
      const enc = Buffer.from(script, 'utf16le').toString('base64');
      return this.run(this.psHost, ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], {
        VITALS_TITLE: `VITALS — ${title}`, VITALS_BODY: body,
      });
    }
    return Promise.resolve(false);
  }

  /** Spawn, never shell. Detached and unref'd so a hung notifier cannot hold the bridge open. */
  run(cmd, args, env) {
    return new Promise((res) => {
      let done = false;
      const finish = (ok) => { if (!done) { done = true; res(ok); } };
      let p;
      try {
        p = spawn(cmd, args, { windowsHide: true, stdio: 'ignore',
                               env: env ? { ...process.env, ...env } : process.env });
      } catch { return finish(false); }
      p.on('error', () => finish(false));
      p.on('close', (code) => finish(code === 0));
      /* A notifier that never returns must not become a permanent pending promise. */
      const t = setTimeout(() => { try { p.kill(); } catch {} finish(false); }, 15_000);
      if (t.unref) t.unref();
    });
  }
}

/** AppleScript string literal: the only escaping that matters is the backslash and the quote. */
function q(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

module.exports = { Notifier, SUSTAIN_MS, COOLDOWN_MS, MIN_GAP_MS, CRIT };
