/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS — outcomes ledger.
 *
 * The diagnosis engine states causes; this file records what happened next: finding FIRED →
 * lever PULLED (clean / kill / task toggle) → measured DELTA → finding CLEARED. Durable and
 * server-side (history/outcomes.jsonl), because the page is disposable — it reloads, docks,
 * closes — and the record must survive all of that.
 *
 * The point is the FEEDBACK: diagnose.js asks pastFor(id) when a finding fires again, so the
 * engine can say "last time this fired, clearing Tier 1 returned 2.3 GB and it stayed clear
 * for 6 days" — what worked ON THIS MACHINE, not generic advice. That sentence is the reason
 * this ledger lives in the bridge and not in localStorage.
 *
 * Append-only JSONL like everything else in history/: survives a crash mid-write, greppable,
 * and the whole state (open findings + last cycle per finding) rebuilds by replaying the file.
 */

const fs = require('fs');
const path = require('path');

/* A compound finding suppresses its parts (diagnose.js rule 2). When `spiral` takes over from
 * `disk_low`, disk_low vanishes from the findings list — but the condition did not clear, it got
 * WORSE. Without this map the ledger would record a lie ("disk_low cleared") at the exact moment
 * the machine deteriorated. */
const SUPPRESSORS = {
  disk_low: ['spiral'], ram_tight: ['spiral'],
  /* B3: the prediction stops firing at the exact moment the wall arrives (its gate is pct < 90,
   * disk_low's trigger). Recording that as "cleared" would be the same lie in the other
   * direction - the forecast did not clear, it CAME TRUE. Absorbed, not cleared. */
  disk_fill_ahead: ['disk_low', 'spiral'],
};

const { systemVolume } = require('./diagnose');

/* A CEILING, NOT A RETENTION POLICY — and the difference is the whole point.
   This ledger is the product's long-term memory: "last time this fired, here is what you did and
   what it measurably changed." Its value is precisely that it is OLD, so the usual answer to
   unbounded growth — keep 30 days — would delete the feature to save a rounding error of disk.
   Measured on this machine: 195 KB across four days of continuous running, about 17 MB a year. So
   the bound sits where a file stops being a file and becomes a problem, which at that rate is on
   the order of eight years. Trimming drops to KEEP_LINES so the rewrite happens once per 50k
   entries rather than on every append.
   Review ranked this unbounded-but-not-urgent, which is right — it is fixed anyway, because "no
   urgency" is how a file reaches 4 GB in year three. */
const MAX_LINES = 200_000;
const KEEP_LINES = 150_000;

class Outcomes {
  /* @param opts.maxLines/keepLines  overrides for the suite. A test that had to seed 200,000 real
     rows to reach the ceiling wrote 10 MB per run and leaked it whenever the run was interrupted —
     on a machine this product's own diagnosis reports as 97% full. Injecting the bound lets the
     suite exercise the identical code path at a scale that costs nothing, which is the same rule
     test-reproduce.js states for the stress tool: a suite has no business straining the machine it
     runs on. */
  constructor(dir, opts = {}) {
    this.maxLines = opts.maxLines || MAX_LINES;
    this.keepLines = opts.keepLines || KEEP_LINES;
    this.file = path.join(dir, 'outcomes.jsonl');
    this.active = {};   // id -> {firedAt, title, sev, m, levers[]}
    this.last = {};     // id -> most recent COMPLETED cycle {firedAt, clearedAt, durSec, m0, m1, levers[]}
    this._lines = 0;
    this._replay();
  }

  _replay() {
    let lines = [];
    try { lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean); } catch { return; }
    this._lines = lines.length;
    for (const ln of lines) { let r; try { r = JSON.parse(ln); } catch { continue; } this._fold(r); }
  }

  /* Oldest-first, and only once the ceiling is crossed. Counted rather than stat-ed, so the common
     path stays a single append. */
  _trim() {
    try {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      if (lines.length <= this.maxLines) { this._lines = lines.length; return; }
      const kept = lines.slice(-this.keepLines);
      fs.writeFileSync(this.file, kept.join('\n') + '\n');
      this._lines = kept.length;
      console.error(`[outcomes] ledger reached ${lines.length} entries; trimmed to the most recent ${this.keepLines}`);
    } catch (e) { console.error('[outcomes] trim failed', e.message); }
  }

  _fold(r) {
    if (r.ev === 'fired') {
      this.active[r.id] = { firedAt: r.at, title: r.title, sev: r.sev, m: r.m, levers: [] };
    } else if (r.ev === 'cleared') {
      const a = this.active[r.id]; delete this.active[r.id];
      this.last[r.id] = {
        firedAt: r.firedAt ?? (a && a.firedAt), clearedAt: r.at, durSec: r.durSec,
        m0: r.m0, m1: r.m, levers: (a && a.levers && a.levers.length ? a.levers : r.levers) || [],
      };
    } else if (r.ev === 'lever') {
      for (const id of r.during || []) if (this.active[id]) this.active[id].levers.push({ kind: r.kind, detail: r.detail, at: r.at });
    }
  }

  _write(r) {
    try {
      fs.appendFileSync(this.file, JSON.stringify(r) + '\n');
      /* THE LINE THAT MAKES THE CEILING REAL, and it was missing for a whole review round. `_trim()`
         and its constants existed, and the "verification" behind them called `_trim()` directly on a
         250k-line file — which proves the trimmer works and proves nothing about whether anything
         ever invokes it. It did not: `_lines` was written at replay and read nowhere, so a ledger
         at 210k lines took 50 more appends and stayed at 210,050.
         Testing the function instead of the path is the failure this codebase keeps catching in
         other people's work; here it shipped a bounded-growth claim on an unbounded file. */
      if (++this._lines > this.maxLines) this._trim();
    } catch (e) { console.error('[outcomes]', e.message); }
    this._fold(r);
  }

  /* The metric snapshot taken at fire and at clear — the delta between them is the "measured
   * delta" column of the ledger. Small on purpose: only values a clear could plausibly move. */
  metricsOf(tick) {
    if (!tick) return {};
    /* THE SAME SELECTOR THE ENGINE USES, imported rather than re-typed. The line here was
       `vols.find(v => v.id === 'C:')`, which matches nothing on Linux or macOS - so on those
       platforms every ledger entry recorded `freeGB: undefined` while looking like a full record,
       and the "measured delta" column for every disk rule was a subtraction of two holes. */
    const c = systemVolume(tick) || {};
    return {
      cpu: tick.cpu ? tick.cpu.total : null,
      mem: tick.mem ? tick.mem.pct : null,
      freeGB: c.freeGB != null ? c.freeGB : null,
      /* `?? null`, NOT `|| 0`. A hard-fault rate of zero is a real and common reading — an idle
         machine genuinely faults zero times a second — so `|| 0` collapsed "not measured on this
         platform" into the single most plausible measurement there is, in the one column the
         ledger uses to decide whether a fix worked. Null travels; zero lies. */
      flt: tick.mem && tick.mem.pagesSec != null ? tick.mem.pagesSec : null,
    };
  }

  /* Called with every fresh diagnosis (the bridge runs one every 30 s whether or not any page is
   * open — the ledger must not depend on a window existing). Warm-up guard: after a bridge
   * restart the history ring is empty, so the engine reports no findings for ~90 s; recording
   * "cleared" for everything replayed as active would be jitter, not truth. Skip until ready. */
  observe(d, tick) {
    if (!d || !d.ready) return;
    const now = Date.now();
    const ids = new Set((d.findings || []).map((f) => f.id));
    for (const f of d.findings || []) {
      if (!this.active[f.id]) this._write({ ev: 'fired', id: f.id, sev: f.sevName, title: f.title, at: now, m: this.metricsOf(tick) });
    }
    for (const id of Object.keys(this.active)) {
      if (ids.has(id)) continue;
      if ((SUPPRESSORS[id] || []).some((s) => ids.has(s))) continue;   // absorbed by a compound, not cleared
      const a = this.active[id];
      this._write({
        ev: 'cleared', id, at: now, firedAt: a.firedAt,
        durSec: Math.round((now - a.firedAt) / 1000),
        m0: a.m, m: this.metricsOf(tick), levers: a.levers,
      });
    }
  }

  /* Record a lever pull, tagged with whichever findings were open at that moment — that linkage
   * is what lets a future firing say "during it you cleared Tier 1". */
  lever(kind, detail, tick) {
    this._write({ ev: 'lever', kind, detail, at: Date.now(), during: Object.keys(this.active), m: this.metricsOf(tick) });
  }

  /* The feedback read: the most recent completed cycle for a finding that is firing right now. */
  pastFor(id) {
    const l = this.last[id];
    if (!l || !l.clearedAt) return null;
    return {
      firedAt: l.firedAt, clearedAt: l.clearedAt, durSec: l.durSec,
      clearDays: +((Date.now() - l.clearedAt) / 86400000).toFixed(1),
      levers: l.levers, m0: l.m0, m1: l.m1,
    };
  }

  /* ---------- B18: THE SELF-QUARANTINING FINDING ----------
   *
   * A rule that keeps firing on this machine and keeps turning out not to matter is worse than a
   * rule that does not exist, because it trains the reader to skim. The outcomes ledger already
   * knows which findings those are - it records every cycle and how long each took to clear - and
   * nothing was reading it back to judge the rules themselves.
   *
   * A finding QUARANTINES ITSELF here when this machine's own record says it is noise:
   *
   *   - it has fired at least MIN_CYCLES times, so this is a pattern rather than an anecdote, and
   *   - the median cycle cleared in under NOISE_SEC, meaning it went away on its own before
   *     anybody could plausibly have acted on it.
   *
   * A finding that clears in forty seconds, thirty times, did not describe a problem. It described
   * a machine doing its job. Demoting it is not hiding it: the finding still appears, one severity
   * lower, carrying the reason and the count - and it RE-TESTS itself, because a rule that was
   * noise last month can be the real thing this month and a permanent silence would be the worse
   * error. The quarantine is computed from a rolling window, so it lifts by itself the moment the
   * pattern changes.
   *
   * This is per-machine on purpose. The same rule can be signal on one box and noise on another,
   * which is exactly why the judgement has to be made from the local record rather than shipped
   * as a threshold in the source.
   */
  quarantine(id) {
    const MIN_CYCLES = 6;
    const NOISE_SEC = 90;
    const WINDOW_DAYS = 14;

    const cutoff = Date.now() - WINDOW_DAYS * 86400_000;
    const durs = [];
    for (const r of this.recent(4000)) {
      if (r.ev !== 'cleared' || r.id !== id) continue;
      if (!r.at || r.at < cutoff) continue;
      if (typeof r.durSec === 'number') durs.push(r.durSec);
    }
    if (durs.length < MIN_CYCLES) {
      return { id, quarantined: false, cycles: durs.length,
               why: `only ${durs.length} completed cycle${durs.length === 1 ? '' : 's'} in the ` +
                    `last ${WINDOW_DAYS} days — ${MIN_CYCLES} are needed before this machine's ` +
                    `record may judge a rule` };
    }
    durs.sort((a, b) => a - b);
    const median = durs[Math.floor((durs.length - 1) / 2)];
    if (median >= NOISE_SEC) {
      return { id, quarantined: false, cycles: durs.length, medianSec: median,
               why: `median cycle ${Math.round(median)} s — long enough to have mattered` };
    }
    return {
      id, quarantined: true, cycles: durs.length, medianSec: median,
      windowDays: WINDOW_DAYS,
      /* The sentence the panel prints. It has to carry the evidence, because "we decided to trust
         this less" without the number behind it is indistinguishable from a bug. */
      why: `on this machine it has fired ${durs.length} times in ${WINDOW_DAYS} days and the ` +
           `median cycle cleared in ${Math.round(median)} s — faster than anyone could act, so ` +
           `the record says it is describing normal behaviour rather than a problem`,
    };
  }

  recent(n) {
    let lines = [];
    try { lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean); } catch {}
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
}

module.exports = { Outcomes, MAX_LINES, KEEP_LINES };
