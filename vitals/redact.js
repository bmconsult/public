/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - WHAT AN AI IS ALLOWED TO SEE WITHOUT ASKING.
 *
 * THE ASYMMETRY THIS FIXES. `ask.js` - VITALS' own chat - already scrubs identifiers out of the
 * grounding block by shape and by value before a single token reaches a model. The MCP server did
 * not. So an external agent, whose transcript LEAVES THIS MACHINE, was handed the MAC address, the
 * IPv4, the gateway, the DNS servers and the Wi-Fi SSID on the first call to `vitals_network`, with
 * no flag and no prompt, while the local chat was treated carefully. That is backwards: the one
 * whose output travels is the one that should be redacted by default.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THIS IS NOT, STATED FIRST because the honest version is easy to overclaim.
 *
 * This is NOT a security boundary. The bridge answers on loopback and anything with a shell on this
 * machine can curl `/api/netinfo` and read the same bytes unredacted - which is exactly how the
 * defect above was found. A determined caller is not stopped by this and was never going to be.
 *
 * What it IS: a rule that identifiers are not VOLUNTEERED. The realistic failure is not an attacker,
 * it is an agent innocently calling a read tool and a MAC address landing in a transcript that gets
 * uploaded, logged, and kept - by nobody's decision in particular. Redacting by default turns that
 * from the path of least resistance into a thing someone has to ask for, per call, on the record.
 *
 * REDACTED IS NOT ABSENT, and the marker says so. A redacted field reads `[redacted:mac]`, never
 * null and never an empty string, because this codebase's founding rule is that a plausible
 * substitute for a measurement is worse than a blank. A reader who sees null concludes "this host
 * has no MAC"; a reader who sees `[redacted:mac]` knows there is one and that they may ask.
 *
 * BOTH BY SHAPE AND BY VALUE, for the reason ask.js already learned: shape alone misses anything
 * unusual (a hostname that looks like an ordinary word), and value alone misses anything new (a
 * second adapter's MAC nobody enumerated). Shape catches the classes; value catches THIS machine's
 * specific identifiers wherever they appear, including inside a sentence.
 * --------------------------------------------------------------------------------------------- */

const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* ---------------------------------------------------------------------------------------------
 * PSEUDONYMS, WHICH ARE BETTER THAN BLANKS BECAUSE THEY REMOVE THE REASON TO ASK.
 *
 * Blanking a MAC protects it and breaks four of the five things an agent legitimately wants one
 * for. The real questions are almost never "what is the MAC" - they are "did the adapter change
 * since last time", "is this the same Wi-Fi as when it was fast", "which NIC vendor is this", "is
 * this machine on a private LAN". Only the last of those needs any part of the true value, and only
 * the part that identifies nothing.
 *
 * So an identifier becomes a STABLE LOCAL TAG plus whatever part of it is not identifying:
 *
 *     A4-C3-F0-11-22-33   ->  [mac:A4-C3-F0#7d2e]     vendor kept, device hashed
 *     192.168.1.47        ->  [ipv4:private#3a91]     "it is a LAN address" kept
 *     BT-HOME-9F2X        ->  [ssid:#5c1f]            nothing about an SSID is safe to keep
 *
 * The tag is sha256(local salt + kind + value) truncated. Same value, same tag, forever, on this
 * machine only - so "the adapter is the one from yesterday" is answerable and "which adapter is
 * that" is not. The salt is 32 random bytes generated once, stored beside the ledgers, and never
 * sent anywhere; without it the tag is not reversible or linkable to anything off this machine.
 *
 * WHAT THIS DELIBERATELY LEAKS: whether two values are the SAME. That is the entire point, and it
 * is worth naming - an agent can learn "this machine has seen three networks" without learning
 * which. That is the trade, made on purpose, and it is a far smaller disclosure than the value.
 * ------------------------------------------------------------------------------------------- */
let SALT = null;
function salt(dir) {
  if (SALT) return SALT;
  const f = path.join(dir || path.join(__dirname, 'history'), 'redact-salt');
  try { SALT = fs.readFileSync(f); if (SALT.length >= 16) return SALT; } catch { /* first run */ }
  SALT = crypto.randomBytes(32);
  /* A salt that cannot be persisted must NOT silently become a per-process one: tags would change
     on every restart and "the adapter changed" would be a lie the tool told itself. Fall back to a
     value derived from the machine so stability survives, and accept the weaker secrecy. */
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, SALT, { mode: 0o600 });
  } catch {
    SALT = crypto.createHash('sha256').update('vitals-fallback|' + os.hostname() + '|' + (os.userInfo().username || '')).digest();
  }
  return SALT;
}

const tag = (kind, value, dir) =>
  crypto.createHash('sha256').update(salt(dir)).update(kind).update(String(value)).digest('hex').slice(0, 4);

/* The part of each identifier that identifies nothing, and is worth keeping. */
function keepable(kind, value) {
  const v = String(value);
  if (kind === 'mac') {
    /* The OUI - first three bytes - is the vendor. Millions of devices share one, so it says
       "Intel" and nothing about WHICH Intel adapter. Genuinely useful for a driver diagnosis. */
    const m = /^([0-9a-f]{2})[:-]([0-9a-f]{2})[:-]([0-9a-f]{2})/i.exec(v);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }
  if (kind === 'ipv4') {
    /* RFC1918 or not is a real diagnostic fact - "you are behind a router" vs "you are routable" -
       and it is shared by hundreds of millions of machines. */
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(v) ? 'private' : 'public';
  }
  return null;
}

/* The marker for a value we are not handing over. `mode` is 'blank' or 'tag'. */
function marker(kind, value, mode, dir) {
  if (mode !== 'tag') return `[redacted:${kind}]`;
  const keep = keepable(kind, value);
  return `[${kind}:${keep ? keep : ''}#${tag(kind, value, dir)}]`;
}

/* Identifier classes, each with the marker it leaves behind.
   ORDER MATTERS AND THE FIRST ATTEMPT GOT IT BACKWARDS. IPv6 was placed first, on the reasoning that
   a loose MAC pattern would eat an address's colon-separated hex groups. The reverse happened:
   IPv6's `{1,4}` groups happily match a MAC's two-character ones, so `A4:C3:F0:11:22:33` came out
   labelled `[redacted:ipv6]` - redacted correctly, described wrongly, which is its own small lie in
   a file about not telling them.
   MAC runs first and is STRICT: exactly six groups of exactly two hex digits. A real IPv6 cannot
   match that (it needs `::` or a group longer than two), so nothing is eaten in either direction. */
const SHAPES = [
  { kind: 'mac', re: /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi },
  /* FOUR GROUPS MINIMUM, because three is a CLOCK. `{2,7}` matched `12:34:56` and turned every
     timestamp in the journal into `[redacted:ipv6]` - a redactor that eats the times out of a log
     has destroyed more than it protected. A real IPv6 in any form worth redacting has four or more
     groups or a `::`; HH:MM:SS has three and no `::`. */
  { kind: 'ipv6', re: /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b|\b[0-9a-f]{0,4}::[0-9a-f:]*[0-9a-f]\b/gi },
  /* Loopback and the unspecified address are deliberately NOT redacted: 127.0.0.1 and 0.0.0.0
     identify nothing about this machine, and blanking them makes bridge diagnostics unreadable for
     no privacy gain at all. */
  { kind: 'ipv4', re: /\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)(?:\d{1,3}\.){3}\d{1,3}\b/g },
  { kind: 'serial', re: /\b[A-Z0-9]{8,}-[A-Z0-9]{4,}-[A-Z0-9]{4,}[A-Z0-9-]*\b/g },
];

/* Keys whose VALUE is an identifier whatever it looks like. `ssid` is the motivating case: a
   network called "kitchen" is not caught by any shape, and it locates the machine as precisely as
   a coordinate. */
const KEYS = {
  ssid: 'ssid', bssid: 'mac', mac: 'mac', macaddress: 'mac', physicaladdress: 'mac',
  ip: 'ipv4', ipv4: 'ipv4', ipv6: 'ipv6', gw: 'ipv4', gateway: 'ipv4',
  dns: 'ipv4', dnsservers: 'ipv4',
  serial: 'serial', serialnumber: 'serial', uuid: 'serial',
  hostname: 'host', computername: 'host', machinename: 'host',
  username: 'user', user: 'user', owner: 'user',
};

/* THIS machine's own identifiers, redacted by value wherever they appear - including embedded in a
   sentence, a path or a process command line, which is where shape matching cannot reach. */
function selfValues() {
  const out = [];
  const push = (v, kind) => { if (v && String(v).length >= 3) out.push({ v: String(v), kind }); };
  push(os.hostname(), 'host');
  push(os.userInfo && (() => { try { return os.userInfo().username; } catch { return null; } })(), 'user');
  push(process.env.USERNAME, 'user');
  push(process.env.COMPUTERNAME, 'host');
  push(process.env.USERDOMAIN, 'host');
  /* Longest first, so a hostname that contains the username does not leave a fragment behind. */
  return out.sort((a, b) => b.v.length - a.v.length);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Redact a JSON-shaped value in place of a copy. Returns { value, count, kinds }.
 *
 * @param input   any JSON value
 * @param opts.self  override the machine identifiers (tests)
 */
function redact(input, opts = {}) {
  const self = opts.self || selfValues();
  /* 'tag' is the default because a pseudonym answers more questions than a blank while disclosing
     less than a value. 'blank' remains available for the bundle, where the output is a file a
     person may hand to a stranger and stability across calls buys nothing. */
  const mode = opts.mode === 'blank' ? 'blank' : 'tag';
  const dir = opts.dir;
  const counts = new Map();
  const hit = (kind) => counts.set(kind, (counts.get(kind) || 0) + 1);

  const scrubString = (s, forcedKind) => {
    if (typeof s !== 'string' || !s) return s;
    let out = s;
    /* By value first: these are exact and cannot be mistaken for anything else. */
    for (const { v, kind } of self) {
      const re = new RegExp(esc(v), 'gi');
      if (re.test(out)) { out = out.replace(re, marker(kind, v, mode, dir)); hit(kind); }
    }
    for (const { kind, re } of SHAPES) {
      out = out.replace(re, (m) => { hit(kind); return marker(kind, m, mode, dir); });
    }
    /* A key like `ssid` whose value survived both passes is still an identifier. */
    if (forcedKind && out === s && !/^\[/.test(out)) {
      hit(forcedKind);
      return marker(forcedKind, s, mode, dir);
    }
    return out;
  };

  const walk = (v, forcedKind) => {
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') return scrubString(v, forcedKind);
    /* Numbers are left alone on purpose. A redacted measurement is a broken measurement, and this
       product's whole value is in the numbers; identifiers here are strings. The one exception a
       reader might expect - a numeric serial - is not worth blanking every byte count for. */
    if (typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, forcedKind));
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = walk(val, KEYS[k.toLowerCase()] || undefined);
    }
    return out;
  };

  const value = walk(input, undefined);
  return { value, count: [...counts.values()].reduce((a, b) => a + b, 0),
           kinds: [...counts.keys()].sort() };
}

module.exports = { redact, SHAPES, KEYS, selfValues, marker, keepable };
