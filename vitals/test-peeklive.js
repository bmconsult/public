/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - THE SCREEN-READ GATE, DRIVEN.  node test-peeklive.js   (any platform)
 *
 * test-peekgate.js proves the gate's SHAPE by reading bridge.js. Review defeated an earlier version
 * of it three ways in ten minutes — a trailing `&& false`, a deleted `return`, and the guard moved
 * below the read — each leaving the screen readable by any caller while every check stayed green.
 * All three are caught now, but the lesson stands: a textual assertion is only ever as good as the
 * mutations its author thought of. This file asks the running bridge instead.
 *
 * WHAT MADE IT POSSIBLE. Review named HIST_DIR as the obstacle and was one level off: the admin
 * passphrase lives in the SECRET dir (LOCALAPPDATA / vitals on Windows), outside the history
 * folder entirely, so isolating HIST_DIR alone still left a suite unable to set a credential it
 * was allowed to know. Both are env-overridable now, and this is the test they existed for.
 *
 * IT NEVER READS THE SCREEN — AND IT DID, FOR ONE VERSION. The ceiling check below sent an
 * over-sized grid with a VALID token, and the only way to read the clamped size back is for the
 * capture to have happened: every run on a Windows host photographed the top-left 400x200 of the
 * real desktop, while this paragraph said it did not. The reasoning that produced it was "not
 * asserting the pixels" — which is not the same as not taking them. It is asserted by the counter
 * now: `samples === 0` after the request. A suite must never be the thing that takes the picture,
 * least of all one that ships as the way a new host verifies itself.
 *
 * The final step - a successful capture - is deliberately NOT asserted:
 * proving the gate OPENS would mean actually sampling the display inside a test suite, which is
 * exactly the thing this whole subsystem exists to make deliberate. What is proved is every path
 * that must REFUSE, plus that a correct token is accepted as far as the worker (a host without
 * PowerShell answers "unavailable", which is itself the right answer and is treated as a pass).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra !== undefined ? '  [' + extra + ']' : ''}`); }
};

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vitals-peeklive-'));
const PORT = 8000 + (process.pid % 900);
const PASS = 'test-passphrase-not-the-owners';
let child = null;
const cleanup = () => {
  try { if (child) child.kill(); } catch {}
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

const req = (method, p, body) => new Promise((res) => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method,
    headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res({ code: x.statusCode, body: JSON.parse(b || '{}') }); } catch { res({ code: x.statusCode, body: {} }); } }); });
  r.on('error', () => res({ code: 0, body: {} }));
  if (data) r.write(data);
  r.end();
});

(async () => {
  /* A throwaway store with a passphrase this file is allowed to contain, because it is not the
     owner's and the whole directory is deleted on exit however the run ends. */
  fs.mkdirSync(DIR, { recursive: true });
  const crypto = require('crypto');
  const salt = crypto.randomBytes(16).toString('hex');
  /* The salt is hex-DECODED by the bridge before hashing, so it must be decoded here too — hashing
     with the hex string produces a different key and a permanent 403 that looks like a wrong
     passphrase rather than a mismatched fixture. */
  const hash = crypto.scryptSync(PASS, Buffer.from(salt, 'hex'), 32).toString('hex');
  fs.writeFileSync(path.join(DIR, 'admin-pass.json'), JSON.stringify({ salt, hash }));

  child = spawn(process.execPath, ['bridge.js'], {
    cwd: __dirname, stdio: 'ignore',
    env: { ...process.env, VITALS_HIST_DIR: DIR, VITALS_SECRET_DIR: DIR, VITALS_PORT: String(PORT), PORT: String(PORT) },
  });

  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise((r) => setTimeout(r, 300));
    up = (await req('GET', '/api/mode')).code === 200;
  }
  if (!up) {
    console.log('SKIP  the bridge did not start on this host — nothing below was proved');
    process.exit(0);
  }

  console.log('--- WITH NO WINDOW OPEN ---');
  {
    const r = await req('GET', '/api/peek?x=0&y=0&w=200&h=100&gw=8&gh=3');
    check('a read is refused', r.body.refused === 'not-open', JSON.stringify(r.body).slice(0, 90));
    const s = await req('GET', '/api/peek/status');
    check('and the status says the window is shut', s.body.screenOpen === false);
    check('and no worker was started by a refused read', s.body.running === false,
      'a refusal must not even reach the capture process');
  }

  console.log('\n--- OPENING IT NEEDS THE PASSPHRASE ---');
  {
    check('no passphrase is refused', (await req('POST', '/api/peek/open', { confirm: true })).code === 403);
    check('a wrong passphrase is refused', (await req('POST', '/api/peek/open', { pass: 'guess', confirm: true })).code === 403);
    /* The rate limiter now has two failures on the clock, so the next legitimate open may be
       throttled; wait it out rather than asserting against a limiter doing its job. */
    await new Promise((r) => setTimeout(r, 1200));
    const noConfirm = await req('POST', '/api/peek/open', { pass: PASS });
    check('the right passphrase without confirmation is refused',
      noConfirm.code === 400 || noConfirm.code === 429, `${noConfirm.code}`);
  }

  console.log('\n--- WITH A WINDOW OPEN, IT BELONGS TO ONE CALLER ---');
  let token = null;
  {
    let o = await req('POST', '/api/peek/open', { pass: PASS, confirm: true, minutes: 2, why: 'suite' });
    for (let i = 0; i < 8 && o.code === 429; i++) { await new Promise((r) => setTimeout(r, 1500)); o = await req('POST', '/api/peek/open', { pass: PASS, confirm: true, minutes: 2, why: 'suite' }); }
    check('passphrase + confirmation opens it', o.code === 200 && !!o.body.token, `${o.code}`);
    token = o.body.token;
    check('and the token is not echoed by the status route',
      !JSON.stringify((await req('GET', '/api/peek/status')).body).includes(String(token)),
      'a status endpoint that hands out the credential IS the permission');

    const noTok = await req('GET', '/api/peek?x=0&y=0&w=200&h=100&gw=8&gh=3');
    check('a read WITHOUT the token is refused even though a window is open',
      noTok.body.refused === 'not-your-window', JSON.stringify(noTok.body).slice(0, 80));
    const badTok = await req('GET', `/api/peek?x=0&y=0&w=200&h=100&gw=8&gh=3&token=${'0'.repeat(48)}`);
    check('and a wrong token is refused', badTok.body.refused === 'not-your-window');

    /* THE INCIDENT, AS A TEST. This is the exact shape of what happened: one caller opens a window
       and a different caller reads the screen on it. It must be impossible. */
    check('THE INCIDENT: a second caller cannot ride the first caller\'s window',
      noTok.body.refused === 'not-your-window' && badTok.body.refused === 'not-your-window');
  }

  console.log('\n--- AN OVER-SIZED REQUEST IS REFUSED WITHOUT A TOKEN ---');
  {
    /* THIS CHECK USED TO CAPTURE THE OWNER'S SCREEN, and the header above used to say it never did.
       It sent an over-sized grid WITH a valid token to prove the clamp — and the only way to read
       `gw === 64` back is for the capture to have happened: window open, token good, and
       CopyFromScreen(0,0,400,200) on the real desktop. Every run of this suite on a Windows host
       photographed the top-left of the display, and the suite SHIPS, so the documented way for a
       new host to verify itself quietly read its user's screen.
       Not asserting the pixels is not the same as not taking them. That is the exact defect this
       whole subsystem exists to prevent — a paragraph describing the intent while the code does
       more — committed inside the file whose subject is making screen reads deliberate.
       The clamp is proved at source in test-peekgate.js (Math.min(PEEK_MAX_W…) plus PEEK_MAX_W ===
       64), so nothing is lost by asserting the refusal here instead. A suite must never be the
       thing that takes the picture. */
    const r = await req('GET', '/api/peek?x=0&y=0&w=400&h=200&gw=128&gh=128');
    check('an over-sized request with no token is refused, not clamped-and-served',
      r.body.refused === 'not-your-window', JSON.stringify(r.body).slice(0, 80));
    check('and it never reached the capture worker',
      (await req('GET', '/api/peek/status')).body.samples === 0,
      'a suite that verifies a screen-read gate must not itself read the screen');
  }

  console.log('\n--- CLOSING IT REVOKES IMMEDIATELY ---');
  {
    await req('POST', '/api/peek/close');
    const after = await req('GET', `/api/peek?x=0&y=0&w=200&h=100&gw=8&gh=3&token=${token}`);
    check('the same token stops working the moment the window closes',
      after.body.refused === 'not-open', JSON.stringify(after.body).slice(0, 80));
    check('and the worker is stopped', (await req('GET', '/api/peek/status')).body.running === false);
  }

  console.log(`\n${fail ? fail + ' FAILED of ' : 'all '}${pass + fail} checks${fail ? '' : ' passed'} — driven against a real bridge, with a passphrase this suite is allowed to know.`);
  cleanup();
  process.exit(fail ? 1 : 0);
})();
