/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - WHAT HAS AN AI SEEN ABOUT THIS MACHINE, AND WHEN.
 *
 * The outcomes ledger records what was DONE - a lever pulled, a delta measured. Nothing recorded
 * what was READ. So the question a person is most likely to ask about an agent with access to their
 * machine - "what does it know?" - had no answer here at all, not even a partial one.
 *
 * Every MCP tool call now leaves a row: which tool, when, the arguments, whether the answer was
 * redacted or handed over raw, how many identifiers were removed, and how big the reply was. That
 * is enough to reconstruct the shape of what an agent learned without keeping a copy of it.
 *
 * THE PAYLOADS ARE NOT STORED, deliberately. A log that mirrors every response is a second copy of
 * everything the privacy layer exists to protect, sitting in a file nobody thinks about - it would
 * make the machine less safe, not more. Sizes and counts are enough to spot a sweep; the payload
 * itself was already delivered and this is not the place to hoard it.
 *
 * ---------------------------------------------------------------------------------------------
 * DEVELOPER MODE, and why it is time-boxed rather than a switch.
 *
 * Redaction makes this system hard to WORK on: an agent iterating on the collector needs the actual
 * numbers, the actual adapter names, the connections. So there is a way to turn it off - and the
 * design question is not whether, it is how you stop it being left on.
 *
 * Three properties, and each one is there because the obvious alternative fails:
 *
 *   IT EXPIRES.        A boolean toggle gets switched on during a debugging session in April and is
 *                      still on in September. An expiry means the safe state is the one that
 *                      happens by DEFAULT, through inaction, which is the only kind that survives.
 *   AN AI CANNOT SET IT. It is a file a human writes, or a flag on the server command line. A
 *                      privacy control an agent can disable on its own behalf is a suggestion.
 *   IT IS LOUD.        Every row taken while it is on is marked `dev: true`, and the window itself
 *                      is logged when it opens. If it was on, the record says so - so "was anything
 *                      read raw?" is answerable afterwards rather than a matter of recollection.
 * --------------------------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');

/* Bounded like the outcomes ledger, and for the same reason - except this one has no long-term
   value, so the bound is much tighter and the window is what matters, not the history. */
const MAX_LINES = 20_000;
const KEEP_LINES = 15_000;

/* A dev window longer than a working session is a toggle wearing a timer. Four hours is long enough
   to iterate through a hard problem and short enough that forgetting costs a day, not a year. */
const MAX_DEV_HOURS = 4;

class AiAccess {
  /**
   * @param dir        history directory
   * @param opts.now   injectable clock
   * @param opts.devFlag  true when the server was started with --dev (a human typed it)
   */
  constructor(dir, opts = {}) {
    this.file = path.join(dir, 'ai-access.jsonl');
    this.devFile = path.join(dir, 'dev-mode.json');
    /* Written by a human or the panel, never by anything in this process. */
    this.grantFile = path.join(dir, 'identifier-grant.json');
    this.now = opts.now || (() => Date.now());
    this.devFlag = !!opts.devFlag;
    this._lines = 0;
    try { this._lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).length; }
    catch { this._lines = 0; }
    this._announced = null;
  }

  /**
   * Is developer mode open right now, and why.
   *
   * The command-line flag has no expiry BY DESIGN: it lasts exactly as long as the process a human
   * started, which is its own bound. The file form is the one that needs a clock, because a file
   * outlives the session that wrote it.
   */
  dev() {
    if (this.devFlag) return { on: true, via: 'the --dev flag on this server process', until: null };
    let j = null;
    try { j = JSON.parse(fs.readFileSync(this.devFile, 'utf8')); } catch { return { on: false }; }
    const until = j && Number(j.until);
    if (!until || !isFinite(until)) return { on: false };
    const now = this.now();
    if (until <= now) return { on: false, expired: true, until };
    /* A file claiming a window longer than the ceiling is treated as the ceiling rather than
       honoured or rejected: honouring it defeats the bound, rejecting it silently would leave a
       developer confused about why their window did not open. */
    const capped = Math.min(until, now + MAX_DEV_HOURS * 3600_000);
    return { on: true, via: j.why ? `dev-mode.json — ${String(j.why).slice(0, 120)}` : 'dev-mode.json',
             until: capped, minutesLeft: Math.round((capped - now) / 60000) };
  }

  /* ---------------------------------------------------------------------------------------------
   * ASKING IS NOT GRANTING, and the first cut of this conflated them.
   *
   * `identifiers: true` was honoured on sight, so the rule had moved from "leaks by default" to
   * "leaks whenever an agent decides it needs to" - which is the same sentence with an extra step.
   * The scenario this whole layer exists for is not an attacker; it is a well-behaved agent
   * innocently deciding a MAC would be useful, and the value landing in a transcript that is
   * uploaded and kept, by nobody's decision in particular. An opt-in the asker controls does not
   * touch that at all.
   *
   * So the flag is a REQUEST. It is always recorded; it discloses nothing on its own. A human opens
   * a grant - the same time-boxed, expires-by-default shape as developer mode - and only then does
   * a request return real values.
   *
   * The cost is friction on a rare path, and the pseudonyms are what make that acceptable: an agent
   * that wants to know whether the adapter CHANGED never needs to ask at all.
   * ------------------------------------------------------------------------------------------- */
  grant() {
    if (this.devFlag) return { on: true, via: 'developer mode (--dev)' };
    let j = null;
    try { j = JSON.parse(fs.readFileSync(this.grantFile, 'utf8')); } catch { return { on: false }; }
    const until = j && Number(j.until);
    if (!until || !isFinite(until)) return { on: false };
    const now = this.now();
    if (until <= now) return { on: false, expired: true, until };
    const capped = Math.min(until, now + MAX_DEV_HOURS * 3600_000);
    return { on: true, via: j.why ? `a human approved it — ${String(j.why).slice(0, 120)}` : 'a human approved it',
             until: capped, minutesLeft: Math.round((capped - now) / 60000) };
  }

  /* Anything worth remembering that is not a read: a grant opened, a grant revoked. Same file, so
     the approval and the reads it enabled sit in one sequence instead of two that have to be
     correlated by timestamp. */
  note(row) { this._write({ at: this.now(), ...row }); }

  /** One row per tool call. Never the payload. */
  record(row) {
    const d = this.dev();
    /* The window is announced ONCE per opening, so a reader scanning the log sees the boundary
       rather than having to infer it from a run of `dev:true` rows. */
    if (d.on && this._announced !== (d.until || 'flag')) {
      this._announced = d.until || 'flag';
      this._write({ ev: 'dev-window-open', at: this.now(), via: d.via, until: d.until || null });
    }
    this._write({ ev: 'read', at: this.now(), ...row, dev: !!d.on });
  }

  _write(r) {
    try {
      fs.appendFileSync(this.file, JSON.stringify(r) + '\n');
      if (++this._lines > MAX_LINES) this._trim();
    } catch (e) { /* a log that breaks the tool it observes is worse than a gap */ }
  }

  _trim() {
    try {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      if (lines.length <= MAX_LINES) { this._lines = lines.length; return; }
      const kept = lines.slice(-KEEP_LINES);
      fs.writeFileSync(this.file, kept.join('\n') + '\n');
      this._lines = kept.length;
    } catch { /* as above */ }
  }

  /** The answer to "what has an AI seen?" — newest first. */
  recent(n = 200) {
    try {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } })
                  .filter(Boolean).reverse();
    } catch { return []; }
  }

  /** A shape a person can read at a glance: what was called, how often, and how much went out raw. */
  summary(sinceMs) {
    const rows = this.recent(MAX_LINES).filter((r) => r.ev === 'read'
      && (!sinceMs || r.at >= sinceMs));
    const byTool = {};
    let raw = 0, redactedValues = 0;
    for (const r of rows) {
      byTool[r.tool] = (byTool[r.tool] || 0) + 1;
      if (r.dev || r.identifiers) raw++;
      redactedValues += r.redacted || 0;
    }
    return {
      reads: rows.length,
      byTool,
      /* The number that matters: how many answers left this machine with identifiers in them. */
      readsWithIdentifiers: raw,
      identifiersRemoved: redactedValues,
      first: rows.length ? rows[rows.length - 1].at : null,
      last: rows.length ? rows[0].at : null,
      dev: this.dev(),
    };
  }
}

module.exports = { AiAccess, MAX_LINES, KEEP_LINES, MAX_DEV_HOURS };
