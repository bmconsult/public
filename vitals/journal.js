/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - the event journal, on disk.
 *
 * Why this exists: the journal was the most useful log in the product and the ONLY one that was not
 * persisted. It lived in the page as SYS.log, capped at 400 entries, and every reload, dock, or close
 * threw the lot away. So the finest-grained record - the individual threshold crossings, the process
 * churn, the stream health - existed solely inside a window that is explicitly disposable. The
 * outcomes ledger records FINDINGS (a diagnosis firing and clearing); it has never recorded the
 * crossings underneath them. A debugger plugging in after the fact could see the shape of the day and
 * the conclusions, but not the moments.
 *
 * Same shape as history.js and outcomes.js on purpose: append-only JSONL, one file per day, pruned by
 * age. Batched by the page (a burst of crossings is one POST, not eight) because the point is a
 * record, not a chat.
 */

const fs = require('fs');
const path = require('path');

const KEEP_DAYS = 90;             // matches history.js - the rollups and the journal age out together
const MAX_BATCH = 200;            // a single POST cannot be used to write an unbounded file
const MAX_MSG = 400;              // one line is a log entry, not a payload

class Journal {
  constructor(dir) {
    this.dir = dir;
    this.n = 0;
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    this.prune();
  }

  dayKey(ms) { return new Date(ms).toISOString().slice(0, 10); }
  fileFor(ms) { return path.join(this.dir, `journal-${this.dayKey(ms)}.jsonl`); }

  /* Entries arrive already shaped by the page: {at, sev, kind, msg}. Everything is clamped here
   * rather than trusted: this is the one endpoint that writes free text to disk.
   *
   * DEDUPED, because the journal describes the MACHINE, not a client. Every open client observes the
   * same threshold crossings and posts them independently, so with the panel and a browser tab both
   * connected each line landed twice - found in the wild at 16,672 lines for a day, roughly double.
   * The key is (second, sev, kind, msg): two clients see the same event within the same second, and a
   * genuinely repeated event (a value oscillating across a threshold) lands in a different second and
   * is kept. Bounded to the last 400 keys so this cannot grow without limit. */
  _seen = new Map();
  _dupe(row) {
    const key = Math.floor(row.at / 1000) + '|' + row.sev + '|' + row.kind + '|' + row.msg;
    if (this._seen.has(key)) return true;
    this._seen.set(key, 1);
    if (this._seen.size > 400) { for (const k of this._seen.keys()) { this._seen.delete(k); if (this._seen.size <= 300) break; } }
    return false;
  }

  write(entries) {
    if (!Array.isArray(entries)) return { written: 0 };
    let written = 0, duped = 0;
    const byFile = new Map();
    for (const e of entries.slice(0, MAX_BATCH)) {
      const at = Number(e && e.at) || Date.now();
      const row = {
        at,
        sev: String((e && e.sev) || 'info').slice(0, 12),
        kind: String((e && e.kind) || 'sys').slice(0, 16),
        msg: String((e && e.msg) || '').slice(0, MAX_MSG),
      };
      if (!row.msg) continue;
      if (this._dupe(row)) { duped++; continue; }
      const f = this.fileFor(at);
      if (!byFile.has(f)) byFile.set(f, []);
      byFile.get(f).push(JSON.stringify(row));
      written++;
    }
    for (const [f, rows] of byFile) {
      try { fs.appendFileSync(f, rows.join('\n') + '\n'); } catch {}
    }
    this.n += written;
    return { written, duped };
  }

  /* Newest first, across the last `days` files - the order the console renders in, so the page can
   * backfill on load without re-sorting. */
  recent(days = 2, limit = 400) {
    const out = [];
    for (let i = 0; i < Math.max(1, Math.min(days, 14)); i++) {
      const f = this.fileFor(Date.now() - i * 86400_000);
      let txt = '';
      try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
      if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);   // PS-written BOM, see the encoding law
      const lines = txt.split('\n');
      for (let j = lines.length - 1; j >= 0; j--) {
        const l = lines[j].trim();
        if (!l) continue;
        try { out.push(JSON.parse(l)); } catch {}
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /* How much record exists, for the SYS header and the support bundle manifest. */
  stats() {
    let files = 0, lines = 0, bytes = 0, oldest = null;
    try {
      for (const f of fs.readdirSync(this.dir)) {
        const m = /^journal-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
        if (!m) continue;
        files++;
        const p = path.join(this.dir, f);
        const st = fs.statSync(p);
        bytes += st.size;
        lines += (fs.readFileSync(p, 'utf8').match(/\n/g) || []).length;
        if (!oldest || m[1] < oldest) oldest = m[1];
      }
    } catch {}
    return { files, lines, bytes, oldest, writtenThisSession: this.n };
  }

  prune() {
    const cutoff = Date.now() - KEEP_DAYS * 86400_000;
    try {
      for (const f of fs.readdirSync(this.dir)) {
        const m = /^journal-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
        if (m && Date.parse(m[1]) < cutoff) fs.unlinkSync(path.join(this.dir, f));
      }
    } catch {}
  }
}

module.exports = { Journal };
