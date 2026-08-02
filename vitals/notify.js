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
const fs = require('fs');
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
    /* A PATH, OR NOTHING. `opts.psHost || null` accepted anything truthy, and the bridge was
       handing it `PS_HOST` — which is `process.platform === 'win32'`, a boolean. deliver() spawns
       this value as a program, so every notification on Windows ran `spawn(true)`, Node coerced it
       to the string "true", and the send died with ENOENT. Six failures a minute, for the whole
       life of the feature, while the panel showed a healthy channel.
       The type check is the fix for the CLASS, not just the instance: a truthy value is not a path,
       and the only place that distinction can be enforced cheaply is where the value arrives. */
    this.psHost = (typeof opts.psHost === 'string' && opts.psHost.trim()) ? opts.psHost : null;
    this.psHostRejected = (opts.psHost && typeof opts.psHost !== 'string')
      ? `psHost was ${typeof opts.psHost} (${String(opts.psHost)}), not a path — ignored`
      : null;
    this._deliver = opts.deliver || null;
    this.now = opts.now || (() => Date.now());
    this.seen = new Map();          // finding id -> { firstAt, lastAlertAt }
    this.lastAnyAt = 0;
    this.log = [];                  // what was sent, and what was withheld and why
    this.enabled = opts.enabled !== false;
    this.capable = null;            // null until probed
    this.how = null;
    /* INITIALISED, and it was not. `inferred` was only ever assigned inside probe(), so before the
       first probe it was `undefined` - which fell through the ternary in status() into the LINUX
       arm, and made a Windows host report "the notifier binary was found". Nothing was found;
       nothing was looked for; there is no notifier binary on Windows at all. A fabricated capability
       sentence, emitted by the function added to stop fabricated capability sentences, on the most
       ordinary code path there is: asking before probing. */
    this.inferred = null;
    /* The one piece of real evidence this class ever gets. A delivery that FAILED is worth more
       than the whole probe, and it was being discarded - see deliver(). */
    this.lastDeliveryFailedAt = null;
    this.lastDeliveryOkAt = null;
    /* null = never attempted. true = the notification centre recorded receiving one. */
    this.accepted = null;
    /* THE GAP IS ONLY A GAP IF NOTHING ELSE IS MID-FLIGHT. See consider(). */
    this._inFlight = false;
  }

  /* ---------- capability ---------- */

  /**
   * IS THERE A CHANNEL HERE - which is a weaker question than "will a human see this", and the
   * docstring that used to sit here claimed the stronger one.
   *
   * It said this was "answered by TRYING, once, rather than by inferring from the platform", and
   * listed the exact cases that make the distinction matter: a headless Linux box, a Windows
   * install with notifications off by policy, a Mac in Do Not Disturb. It then inferred from the
   * platform. On Windows and macOS nothing was tried at all - `process.platform` was the whole
   * test - so every one of the cases the comment named as the reason for the design was a case it
   * reported as capable.
   *
   * A LATER ROUND FOUND THAT THE STRONGER QUESTION IS PARTLY ANSWERABLE AFTER ALL, and the sentence
   * that used to sit here - "there is no supported API on any of them that reports the user saw it"
   * - was true of the API surface and false as a statement about what could be measured. Windows
   * keeps `LastNotificationAddedTime` per AppId in the registry, and it advances when the
   * notification centre ACCEPTS a toast. deliver() now reads it either side of Show() in the same
   * one-shot, so acceptance is measured rather than assumed. See the script.
   *
   * That is still not "a human saw it": Focus Assist can file a toast without drawing it, and the
   * registry cannot tell the difference. But it is far stronger than an exit code, which succeeds
   * happily with the app's notifications turned off in Settings - the exact case that used to be
   * reported as healthy.
   *
   * So three things are named separately instead of one being made to stand for all of them:
   *   `capable`          a channel exists, and the interpreter it needs is on disk (checked below)
   *   `deliveryVerified` the notification centre RECORDED receiving one. Measured, per send.
   *   seen by a human    not modelled, not claimed, and no platform here reports it.
   *
   * On macOS and Linux the original limit still stands: osascript exits 0 under Do Not Disturb, and
   * notify-send only fails when no daemon answers D-Bus. Their `deliveryVerified` stays false.
   */
  async probe() {
    if (this.capable !== null) return this.capable;
    if (this._deliver) { this.capable = true; this.how = 'injected'; return true; }
    try {
      if (process.platform === 'win32' && this.psHost) {
        /* SOMETHING IS ACTUALLY CHECKED HERE NOW. It is still not proof that a toast appears — see
           the docstring — but "the interpreter we are about to spawn exists" is a real test, it is
           the exact test that would have caught the boolean, and it costs one stat(). Truthiness
           was doing this job before, and truthiness cannot fail. */
        const ok = (() => { try { return fs.existsSync(this.psHost); } catch { return false; } })();
        this.capable = ok;
        this.how = ok ? 'toast (Windows notification centre)' : null;
        this.inferred = ok ? true : false;
        if (!ok) this.psHostRejected = `PowerShell was not found at ${this.psHost}`;
      } else if (process.platform === 'darwin') {
        this.capable = true;
        this.how = 'osascript display notification';
        this.inferred = true;
      } else if (process.platform === 'linux') {
        /* The one platform where something is genuinely checked - and even here it is the presence
           of the binary, not the presence of a daemon to answer it. */
        this.capable = await new Promise((res) => {
          const p = spawn('which', ['notify-send'], { stdio: 'ignore' });
          p.on('error', () => res(false));
          p.on('close', (c) => res(c === 0));
        });
        this.how = this.capable ? 'notify-send (libnotify)' : null;
        this.inferred = false;
      } else { this.capable = false; this.inferred = false; }
    } catch { this.capable = false; this.inferred = false; }
    return this.capable;
  }

  status() {
    return {
      enabled: this.enabled,
      capable: this.capable,
      how: this.how,
      /* WHAT `capable` ACTUALLY MEANS HERE, spelled out rather than left to be assumed from a
         boolean. See probe(): on Windows and macOS this is the platform having a channel, not a
         notification having been shown, and there is no API on either that would tell us the
         difference. */
      capableMeans: this.capable === null
        ? 'NOT PROBED YET — nothing has been established either way, which is different from ' +
          'having looked and found nothing'
        : this.capable === false ? 'no channel was found on this host'
        : this.inferred
          ? 'a channel exists and the call returns success — NOT that a notification was displayed. ' +
            'Focus Assist, Do Not Disturb, or notifications disabled for the app all suppress it ' +
            'silently, and no API here reports that'
          : 'the notifier binary was found; whether a daemon answers it is still not established',
      /* NO LONGER ALWAYS FALSE ON WINDOWS. `LastNotificationAddedTime` advancing is real evidence
         that the notification centre accepted the toast: weaker than "a human saw it", which nothing
         on this platform reports, and far stronger than an exit code. */
      deliveryVerified: this.accepted === true,
      deliveryVerifiedMeans: this.accepted === true
        ? 'the Windows notification centre recorded receiving it — acceptance, not proof anyone saw ' +
          'it, since Focus Assist can file a toast without ever drawing it'
        : this.accepted === false
          ? 'the send returned success but the notification centre did NOT record receiving it, ' +
            'which usually means notifications are turned off for this app'
          : 'no delivery has been attempted yet',
      /* Set when the host was handed something that could not be a PowerShell path. Surfaced rather
         than swallowed, because the whole failure was invisible for want of one sentence. */
      psHostProblem: this.psHostRejected,
      /* The evidence, such as it is. A `lastDeliveryFailedAt` newer than `lastDeliveryOkAt` is the
         strongest statement this module can make about itself, and it outranks `capable`. */
      lastDeliveryOkAt: this.lastDeliveryOkAt,
      lastDeliveryFailedAt: this.lastDeliveryFailedAt,
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
  /* ONE PASS AT A TIME. THE GUARANTEE ON THE PANEL WAS BEING VIOLATED, LIVE, BY 899 ms.
   *
   * The rules above are checked, and only then is `await deliver()` entered — a real ~1 s round
   * trip through a PowerShell one-shot. `lastAnyAt` was not updated until AFTER it returned, so two
   * overlapping calls both read the OLD value, both passed `now - lastAnyAt < MIN_GAP_MS`, and both
   * sent. And overlap is not exotic: currentDiagnosis() calls this on a 30 s timer AND on every
   * /api/diagnose, /api/quarantine and ask-grounding request, so any open panel produces it
   * routinely. Found in this bridge's own log — two `sent` entries for `spiral`, 899 ms apart,
   * against a promise of "never two within 15 minutes" that the panel prints verbatim.
   *
   * Two locks, because they fail differently. The re-entrancy flag stops concurrent passes outright
   * (which also stops two toast one-shots racing to read the same registry value — see deliver()).
   * Claiming the slot BEFORE the await, and rolling it back if the send fails, protects the rule
   * itself even if some future caller reaches the inner path another way. A check-then-act across
   * an await is not a check.
   */
  async consider(diag, opts = {}) {
    if (this._inFlight) {
      this.note('gate', 'withheld', 'another pass was still delivering — the minimum gap is ' +
                                    'enforced across concurrent calls, not just sequential ones');
      return [];
    }
    this._inFlight = true;
    try { return await this._consider(diag, opts); }
    finally { this._inFlight = false; }
  }

  async _consider(diag, { watching = false } = {}) {
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

      /* CLAIM THE SLOT FIRST, ROLL BACK IF THE SEND FAILS. The clock is re-read here rather than
         reusing `now` from the top of the pass, because a slow pass would otherwise stamp an alert
         with a timestamp from before its own delivery. */
      const at = this.now();
      const prevAny = this.lastAnyAt, prevAlert = s.lastAlertAt;
      s.lastAlertAt = at;
      this.lastAnyAt = at;

      let ok = false;
      try { ok = await this.deliver(title, body); }
      catch (e) {
        this.lastAnyAt = prevAny; s.lastAlertAt = prevAlert;   // a failure must not consume the gap
        this.note(f.id, 'failed', e.message);
        continue;
      }

      if (ok) {
        this.note(f.id, 'sent', title);
        sent.push({ id: f.id, title, body, at });
        /* One per pass. Two notifications arriving together are read as one and dismissed as one,
           so the second finding waits for the next gap rather than being spent. */
        break;
      } else {
        this.lastAnyAt = prevAny; s.lastAlertAt = prevAlert;   // likewise
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

  /* RECORDS WHAT HAPPENED. probe() can only ever infer on two of three platforms; an actual
     delivery attempt is the one piece of real evidence this class ever obtains, and it was being
     thrown away. Observed live during review: `/api/alerts/test` returned `{"ok":false,
     "capable":true}` - the send failed and `capable` stayed true, unrecorded, so the next reader
     was told the channel works by a class that had just watched it not work.
     `capable` is NOT demoted on a failure, deliberately: one failed toast can be a transient
     COM hiccup, and a monitor that silently marks itself deaf is the failure mode this whole file
     exists to avoid. The timestamps go in status() and let a reader judge for themselves. */
  deliver(title, body) {
    const record = (ok) => {
      if (ok) this.lastDeliveryOkAt = this.now();
      else this.lastDeliveryFailedAt = this.now();
      return ok;
    };
    if (this._deliver) return Promise.resolve(this._deliver(title, body)).then(record);
    if (this.capable === false) return Promise.resolve(record(false));

    if (process.platform === 'darwin') {
      return this.run('osascript', ['-e',
        `display notification ${q(body)} with title ${q('VITALS')} subtitle ${q(title)}`]).then(record);
    }
    if (process.platform === 'linux') {
      return this.run('notify-send', ['-u', 'critical', '-a', 'VITALS', `VITALS — ${title}`, body]).then(record);
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
        /* DELIVERY, MEASURED — and this file spent a whole review explaining why it could not be.
           Windows keeps `LastNotificationAddedTime` per AppId under Notifications\\Settings, and it
           advances when the NOTIFICATION CENTRE ACCEPTS a toast. Read either side of Show() in the
           same one-shot, so it costs nothing extra, and it is strictly stronger than "the call
           returned 0" — which succeeds happily with the app's notifications turned off.
           What it still does not prove is that a human saw it: Focus Assist can file a toast
           without ever drawing it. So this establishes ACCEPTANCE, and status() uses that word. */
        '$key = "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\$appId"',
        '$before = try { (Get-ItemProperty -Path $key -Name LastNotificationAddedTime -ErrorAction Stop).LastNotificationAddedTime } catch { 0 }',
        '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)',
        'Start-Sleep -Milliseconds 600',
        '$after = try { (Get-ItemProperty -Path $key -Name LastNotificationAddedTime -ErrorAction Stop).LastNotificationAddedTime } catch { 0 }',
        'if ($after -gt $before) { Write-Output "VITALS_ACCEPTED" } else { Write-Output "VITALS_UNCONFIRMED" }',
      ].join('\n');
      const enc = Buffer.from(script, 'utf16le').toString('base64');
      return this.run(this.psHost, ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], {
        VITALS_TITLE: `VITALS — ${title}`, VITALS_BODY: body,
      }, /* captureStdout */ true).then((r) => {
        /* The script prints its own verdict; an exit code of 0 only says the script ran. */
        if (r.ok) this.accepted = /VITALS_ACCEPTED/.test(r.out || '');
        return record(r.ok);
      });
    }
    return Promise.resolve(record(false));
  }

  /** Spawn, never shell. Detached and unref'd so a hung notifier cannot hold the bridge open. */
  /* Resolves to a boolean normally, or to {ok, out} when the caller asks for stdout. The win32
     toast path needs it, because the script reports whether the notification centre accepted the
     toast. Everything else keeps `stdio:'ignore'`, so nothing changes for the other platforms. */
  run(cmd, args, env, captureStdout) {
    return new Promise((res) => {
      let done = false;
      let out = '';
      const finish = (ok) => { if (!done) { done = true; res(captureStdout ? { ok, out } : ok); } };
      let p;
      try {
        p = spawn(cmd, args, { windowsHide: true,
                               stdio: captureStdout ? ['ignore', 'pipe', 'ignore'] : 'ignore',
                               env: env ? { ...process.env, ...env } : process.env });
      } catch { return finish(false); }
      if (captureStdout && p.stdout) p.stdout.on('data', (d) => { out += d; });
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
