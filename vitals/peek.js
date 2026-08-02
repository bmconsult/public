/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - SCREEN PEEK, the Node side.
 *
 * Owns the long-lived peek.ps1 worker and hands out COLOUR grids of a screen rectangle.
 *
 * ===========================================================================================
 * THIS IS THE ONE THING IN VITALS THAT LOOKS AT THE SCREEN. It gets the strictest handling.
 * ===========================================================================================
 *
 *   OFF UNTIL ASKED, AND OFF AGAIN SOON AFTER. The worker is not started at boot; it is started by
 *   the first request and killed after IDLE_MS with none. A capture process that lingers is a
 *   capture process nobody remembers enabling.
 *
 *   IT RETURNS COLOUR, AND THE CEILING IS THE CLAIM. RGB, three bytes a cell, at a grid the ROUTE
 *   clamps to PEEK_MAX_W x PEEK_MAX_H — the same 64x24 the panel asks for, so the API cannot be
 *   talked into more than what ships. That is 4,608 bytes: enough to say "there is a dark region
 *   here and a blue one there", nowhere near enough to read a word. Nothing here writes it
 *   anywhere and no frame is retained — each answer replaces the last.
 *
 *   THIS PARAGRAPH SAID "luminance only" FOR A BUILD AFTER THE CAPTURE BECAME RGB, and the cap it
 *   quoted was 128x128 — 49,152 bytes, icon resolution. The code widened 32x and the sentence
 *   defending it did not move. A privacy label that lags the code is worse than none: it is
 *   specific, reassuring and false, and it sits in the first file anyone auditing a screen-capture
 *   feature opens. Colour was needed because a dark blue and a dark grey are the same luminance,
 *   so a light meter cannot tell water from window chrome — a real reason, which is exactly why it
 *   deserved a rewritten claim rather than a quietly outgrown one.
 *   The distinction being defended is still SENSOR, not CAMERA, and it is defended by the CAP
 *   being enforced in code rather than by a promise about what we do with the data.
 *
 *   IT IS COUNTED. Every sample increments a counter the panel can read, so "is this thing looking
 *   at my screen" is answerable from the UI rather than from trust.
 *
 * WHY NOT getDisplayMedia. The browser API would work and shows a sharing indicator, which is
 * genuinely good. It also prompts, cannot be scoped to a rectangle, and hands the PAGE a real video
 * stream of the desktop - a much larger thing to have created than a 4,608-byte grid. This path
 * gives the page strictly less.
 */

const { spawn } = require('child_process');
const path = require('path');

const IDLE_MS = 20_000;
const REQ_TIMEOUT_MS = 4_000;

class Peek {
  constructor(psPath, here) {
    this.PS = psPath;
    this.script = path.join(here || __dirname, 'peek.ps1');
    this.child = null;
    this.buf = '';
    this.pending = null;      // single-flight: one outstanding request at a time
    this.idle = null;
    this.samples = 0;         // how many times this has looked, for the panel to display
    this.startedAt = 0;
    this.lastErr = null;
  }

  available() { return !!this.PS; }
  status() {
    return { running: !!this.child, samples: this.samples,
             sinceMs: this.startedAt ? Date.now() - this.startedAt : 0, error: this.lastErr };
  }

  _start() {
    if (this.child) return true;
    if (!this.PS) { this.lastErr = 'no PowerShell on this host'; return false; }
    try {
      this.child = spawn(this.PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                                   '-File', this.script],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { this.lastErr = e.message; this.child = null; return false; }
    this.startedAt = Date.now();
    /* ERROR LISTENERS ON THE PIPES, and this one cost the bridge.
       A write to a dead child's stdin does not throw — it emits an asynchronous 'error' event on
       the stream, so the try/catch around the write caught nothing and an unhandled EPIPE took the
       WHOLE PROCESS down. The monitor died, silently, some seconds after a capture worker was
       reaped. pshost.js already records this exact class ("having no 'error' handler, took the
       whole bridge down with it") for spawn; the same rule applies to every pipe on the child.
       A decorative screen-reading feature must not be able to kill the instrument. */
    this.child.stdin.on('error', (e) => { this.lastErr = 'stdin: ' + e.message; });
    this.child.stdout.on('error', (e) => { this.lastErr = 'stdout: ' + e.message; });
    this.child.stderr.on('error', () => {});
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => this._onData(d));
    /* Its stderr is a real diagnostic channel, not noise: a worker that starts and then fails every
       request looks identical to one that was never asked, and that is how a broken capture path
       stays broken.
       DECODED AS UTF-16LE, which is what Windows PowerShell writes to a redirected error stream —
       NOT what it writes to stdout, which is why one stream needed this and the other did not.
       Read as UTF-8 the message came back with a NUL between every character
       ("W\0i\0n\0d\0o\0w\0s\0 \0P\0o..."), so the one field that exists to explain a failure was
       itself unreadable at the moment it mattered. Trimmed of any stray NULs in case a host writes
       plain ASCII here instead. */
    this.child.stderr.on('data', (d) => {
      const txt = Buffer.isBuffer(d)
        ? (d.includes(0) ? d.toString('utf16le') : d.toString('utf8'))
        : String(d);
      const clean = txt.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
      if (clean) this.lastErr = clean.slice(0, 220);
    });
    const die = (why) => {
      this.child = null;
      if (this.pending) { const p = this.pending; this.pending = null; p.reject(new Error(why)); }
    };
    this.child.on('error', (e) => { this.lastErr = e.message; die('peek worker error: ' + e.message); });
    this.child.on('exit', (c) => die('peek worker exited (' + c + ')'));
    return true;
  }

  stop() {
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    const c = this.child;
    this.child = null;                       // cleared FIRST, so nothing races back in mid-teardown
    if (!c) return;
    /* Ask, then insist. `quit` lets it release its bitmaps and exit cleanly; the kill covers a
       worker that is wedged. Both are best-effort — the pipes may already be gone, which is
       precisely the case that used to be fatal. */
    try { if (c.stdin && c.stdin.writable) c.stdin.write('quit\n'); } catch {}
    try { c.kill(); } catch {}
  }

  _armIdle() {
    if (this.idle) clearTimeout(this.idle);
    /* unref, or an idle capture worker keeps the bridge alive past shutdown. */
    this.idle = setTimeout(() => this.stop(), IDLE_MS);
    if (this.idle.unref) this.idle.unref();
  }

  _onData(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      const p = this.pending;
      if (!p) continue;                       // a late answer to a timed-out request: drop it
      this.pending = null;
      clearTimeout(p.timer);
      if (line.startsWith('OK ')) {
        const hex = line.slice(3);
        const want = p.gw * p.gh * 6;          // RGB, three bytes a cell
        /* LENGTH CHECKED. A short line means the worker and this side disagree about the grid, and
           decoding it anyway would silently produce a partly-zero grid - which reads as "the right
           half of your screen is black" rather than as an error. */
        if (hex.length !== want) { p.reject(new Error(`grid was ${hex.length} chars, expected ${want}`)); }
        else {
          const g = new Uint8Array(p.gw * p.gh * 3);
          for (let i = 0; i < g.length; i++) g[i] = parseInt(hex.substr(i * 2, 2), 16);
          this.samples++;
          p.resolve({ gw: p.gw, gh: p.gh, grid: g });
        }
      } else {
        this.lastErr = line.replace(/^ERR\s*/, '').slice(0, 200);
        p.reject(new Error(this.lastErr));
      }
    }
  }

  /* One at a time on purpose. The caller samples on a timer; queueing would let a slow screen build
     a backlog of stale rectangles that are all answered at once, and every one of those answers
     describes a screen that has already changed. Refusing is the honest response to "too fast". */
  sample(x, y, w, h, gw, gh) {
    return new Promise((resolve, reject) => {
      if (this.pending) return reject(new Error('a sample is already in flight'));
      if (!this._start()) return reject(new Error(this.lastErr || 'could not start the peek worker'));
      const req = { gw, gh, resolve, reject, timer: null };
      req.timer = setTimeout(() => {
        if (this.pending === req) { this.pending = null; reject(new Error('the peek worker did not answer')); }
      }, REQ_TIMEOUT_MS);
      if (req.timer.unref) req.timer.unref();
      this.pending = req;
      this._armIdle();
      try {
        if (!this.child.stdin || !this.child.stdin.writable) throw new Error('the peek worker is not accepting requests');
        this.child.stdin.write(`${Math.round(x)} ${Math.round(y)} ${Math.round(w)} ${Math.round(h)} ${gw} ${gh}\n`,
          /* The callback is where a failed write actually surfaces. Without it the request would
             simply never be answered and would sit here until the timeout, reporting "the worker
             did not answer" for something that was refused before it left this process. */
          (err) => { if (err && this.pending === req) { this.pending = null; clearTimeout(req.timer); reject(err); } });
      } catch (e) { this.pending = null; clearTimeout(req.timer); reject(e); }
    });
  }
}

module.exports = { Peek, IDLE_MS };
