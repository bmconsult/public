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

class Outcomes {
  constructor(dir) {
    this.file = path.join(dir, 'outcomes.jsonl');
    this.active = {};   // id -> {firedAt, title, sev, m, levers[]}
    this.last = {};     // id -> most recent COMPLETED cycle {firedAt, clearedAt, durSec, m0, m1, levers[]}
    this._replay();
  }

  _replay() {
    let lines = [];
    try { lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean); } catch { return; }
    for (const ln of lines) { let r; try { r = JSON.parse(ln); } catch { continue; } this._fold(r); }
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
    try { fs.appendFileSync(this.file, JSON.stringify(r) + '\n'); }
    catch (e) { console.error('[outcomes]', e.message); }
    this._fold(r);
  }

  /* The metric snapshot taken at fire and at clear — the delta between them is the "measured
   * delta" column of the ledger. Small on purpose: only values a clear could plausibly move. */
  metricsOf(tick) {
    if (!tick) return {};
    const c = tick.disk.vols.find((v) => v.id === 'C:') || {};
    return { cpu: tick.cpu.total, mem: tick.mem.pct, freeGB: c.freeGB, flt: tick.mem.pagesSec || 0 };
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

  recent(n) {
    let lines = [];
    try { lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean); } catch {}
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
}

module.exports = { Outcomes };
