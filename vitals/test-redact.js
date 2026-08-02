/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - PRIVACY SUITE.  node test-redact.js   (any platform)
 *
 * Two halves, and the second is the one that matters.
 *
 * A redactor is easy to test from the side where it works: throw a MAC at it, watch it disappear.
 * That proves almost nothing. The failures that hurt are the OTHER two directions —
 *
 *   FALSE NEGATIVE  an identifier that slips through because it was written in a form nobody
 *                   listed. Windows writes MACs with DASHES; the first probe written against this
 *                   checked only colons and reported "no MAC in reply" about a reply that would
 *                   have contained one. The test was wrong, not the code, which is worse: it would
 *                   have signed off a leak.
 *   FALSE POSITIVE  a redactor that eats data it had no business touching. `12:34:56` is a clock,
 *                   and an early pattern turned every timestamp in the journal into
 *                   `[redacted:ipv6]`. A privacy layer that destroys the log is not a safe default,
 *                   it is a broken product with a good excuse.
 *
 * So the bulk of this file is things that must SURVIVE, and identifiers written the awkward ways.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { redact } = require('./redact');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra !== undefined ? '  [' + extra + ']' : ''}`); }
};

/* A fixed identity, so the suite does not depend on whose machine it runs on. */
/* SYNTHETIC, and this is not cosmetic: the real hostname and username were hard-coded here, and
   pack.js refused the build because this file SHIPS to a public repository. The suite proves the
   redactor removes a host and a user by value — it never needed the owner MACHINE to be that host.
   A fixture that happens to be real data is a leak waiting for the day someone publishes. */
const SELF = [{ v: 'TESTBOX-A1B2C3', kind: 'host' }, { v: 'testuser', kind: 'user' }];
/* A throwaway salt directory too, so tags are this suite's own and never touch the real one. */
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vitals-rd-'));
process.on('exit', () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

const R = (v, o = {}) => redact(v, { self: SELF, dir: DIR, ...o });
const one = (s, o) => R({ v: s }, o).value.v;
/* "Gone" means replaced by ANY marker — the pseudonym `[mac:A4-C3-F0#7d2e]` or the blank
   `[redacted:mac]` — and the original no longer present. Asserting only the blank form is what made
   this whole suite go red the moment pseudonyms arrived: the test encoded one implementation of the
   rule rather than the rule. */
const gone = (s, o) => {
  const out = one(s, o);
  return /\[[a-z0-9]+:[^\]]*\]/i.test(out) && !out.includes(s);
};
const kept = (s) => one(s) === s;

console.log('--- identifiers must go, in every form they are actually written ---');
{
  check('MAC, colon-separated', gone('A4:C3:F0:11:22:33'));
  check('MAC, DASH-separated — how Windows writes it', gone('A4-C3-F0-11-22-33'),
    'the first probe for this only checked colons and reported a clean reply');
  check('MAC, lower case', gone('a4:c3:f0:11:22:33'));
  check('IPv6, full', gone('fe80:0000:0000:0000:1ff:fe23:4567:890a'));
  check('IPv6, compressed', gone('fe80::1ff:fe23:4567:890a'));
  check('IPv4', gone('192.168.1.47'));
  check('an IPv4 inside a sentence', gone('the gateway is 192.168.1.1 on this link'));
  check('the hostname, by value', gone('running on TESTBOX-A1B2C3 tonight'));
  check('the username, by value inside a path', gone('C:/Users/testuser/Downloads/code'));
  check('the username in a different case', gone('C:/USERS/TESTUSER/Downloads'));
}

console.log('\n--- and the things that must SURVIVE, which is the harder half ---');
{
  check('a clock is not an IPv6', kept('12:34:56'), one('12:34:56'));
  check('a journal line keeps its timestamp', kept('sent 11:15:36 · disk_low held 90 s'),
    one('sent 11:15:36 · disk_low held 90 s'));
  check('an ISO timestamp survives', kept('2026-08-01T13:22:06.451Z'), one('2026-08-01T13:22:06.451Z'));
  check('a Windows version is not an IPv4', kept('10.0.26200'), one('10.0.26200'));
  check('loopback is left alone — it identifies nothing', kept('127.0.0.1:8790'), one('127.0.0.1:8790'));
  check('0.0.0.0 likewise', kept('0.0.0.0'));
  check('a measurement sentence is untouched', kept('p95 209.0 · flags above 200'));
  check('a percentage survives', kept('the disk is 97.2% full'));
  check('a finding title survives', kept('C: is 3.0% free — below the threshold where SSDs slow down'));
}

console.log('\n--- REDACTED IS NOT ABSENT: the marker says which, and numbers are never touched ---');
{
  const r = R({ mac: 'A4-C3-F0-11-22-33', freeGB: 22.7, cpu: 0, missing: null, ssid: 'kitchen' });
  check('a redacted string becomes a MARKER, not null', typeof r.value.mac === 'string'
    && r.value.mac !== '' && r.value.mac !== null, r.value.mac);
  check('and the marker names the KIND, so a reader knows what to ask for',
    /^\[mac:/.test(r.value.mac), r.value.mac);
  check('the VENDOR survives — an OUI is shared by millions and answers a real question',
    /^\[mac:A4-C3-F0#/.test(r.value.mac), r.value.mac);
  check('but the device half does not', !r.value.mac.includes('11-22-33'), r.value.mac);
  check('a real zero is still a zero — this is the founding rule of the codebase', r.value.cpu === 0);
  check('a real null is still null, and distinguishable from a redaction', r.value.missing === null);
  check('measurements are never redacted', r.value.freeGB === 22.7);
  check('a key named ssid is redacted even though its value looks like a word',
    /^\[ssid:#/.test(r.value.ssid) && !r.value.ssid.includes('kitchen'), r.value.ssid);
  check('an SSID keeps NOTHING — unlike a MAC, no part of a network name is safe to show',
    /^\[ssid:#[0-9a-f]+\]$/.test(r.value.ssid), r.value.ssid);
  check('the count and kinds are reported so the caller can say what it withheld',
    r.count === 2 && r.kinds.join(',') === 'mac,ssid', `${r.count} · ${r.kinds}`);
}

console.log('\n--- structure survives: shape in, same shape out ---');
{
  const input = { a: [1, 2, { b: 'A4-C3-F0-11-22-33' }], c: { d: { e: true } }, f: 'plain' };
  const out = R(input).value;
  check('arrays stay arrays of the same length', Array.isArray(out.a) && out.a.length === 3);
  check('nested objects keep their keys', out.c.d.e === true);
  check('numbers inside arrays are untouched', out.a[0] === 1 && out.a[1] === 2);
  check('a deep identifier is still found', /^\[mac:/.test(out.a[2].b), out.a[2].b);
  check('unrelated strings pass through', out.f === 'plain');
  check('the original object is NOT mutated', input.a[2].b === 'A4-C3-F0-11-22-33',
    'redaction must return a copy — mutating the caller would corrupt the panel too');
}

console.log('\n--- it does not fall over on the shapes a real payload contains ---');
{
  check('null input', R(null).value === null);
  check('an empty object', JSON.stringify(R({}).value) === '{}');
  check('an empty string', R({ v: '' }).value.v === '');
  check('a very long string', R({ v: 'x'.repeat(50_000) }).value.v.length === 50_000);
  check('a key with no value', R({ ssid: null }).value.ssid === null,
    'an absent SSID must stay absent, not become a redaction marker for something that is not there');
}

console.log(`\n${fail ? fail + ' FAILED of ' : 'all '}${pass + fail} checks${fail ? '' : ' passed'} — identifiers go, measurements and timestamps stay.`);
process.exit(fail ? 1 : 0);
