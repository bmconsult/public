/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* Action layer + growth walker.  node test-actions-posix.js   (runs on any platform)
 *
 * WHAT A PASS MEANS, precisely - same contract as collect/test-darwin-sim.js:
 *   YES  the validation, the TERM->KILL escalation, the denial counting, the osascript command
 *        construction, the fixed-table rule, the walker's arithmetic and the growth diff are
 *        correct. The clean sweep and the walker run against a REAL temporary directory tree, so
 *        their filesystem behaviour is genuinely exercised on whatever platform runs this.
 *   NO   it does not prove osascript, pgrep or `open` behave as documented. Only a Mac settles
 *        that, which is why every act.* flag in caps.js stays false until CI's live run agrees.
 *
 * Process signalling and subprocess execution go through the module's injection seam, so nothing
 * here kills a real process or raises a real admin prompt.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const acts = require('./actions-posix');
const { scan } = require('./growthscan');
const admin = require('./clean-admin');
const { History } = require('./history');

let fails = 0, checks = 0;
function check(label, ok, detail) {
  checks++; if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  [' + detail + ']' : ''}`);
}
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol;

/* Sequential async steps: several tests use the module's real escalation timers. */
const steps = [];
function step(fn) { steps.push(fn); }
function runSteps() {
  const s = steps.shift();
  if (!s) return finish();
  s(() => runSteps());
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vitals-act-'));

/* ---------------- kill: validation, escalation, denial counting ---------------- */

step((done) => {
  console.log('--- kill ---');
  acts.kill([0, 1, 4, 1.5, 'x'], (e) => {
    check('refuses pids at or below 4 and non-integers', !!e, e && e.message);

    /* Fake process table: 100 dies on TERM, 200 ignores TERM (needs KILL), 300 is another
       user's (EPERM), 400 exited before we arrived (ESRCH). */
    const sent = [];
    const alive = new Set([100, 200, 300]);
    acts._inject(null, (pid, sig) => {
      sent.push([pid, sig]);
      const err = (code) => { const x = new Error(code); x.code = code; throw x; };
      if (!alive.has(pid)) err('ESRCH');
      if (pid === 300) err('EPERM');
      if (sig === 'SIGTERM' && pid === 100) alive.delete(pid);
      if (sig === 'SIGKILL') alive.delete(pid);
    });
    acts.kill([100, 200, 300, 400], (e2, r) => {
      check('no error when only some pids are denied', !e2, e2 && e2.message);
      check('polite TERM went to every live pid first',
        sent.filter(([, s]) => s === 'SIGTERM').length >= 3);
      check('SIGKILL only for the survivor that ignored TERM',
        sent.filter(([, s]) => s === 'SIGKILL').map(([p]) => p).join(',') === '200',
        JSON.stringify(sent));
      check('EPERM counted as denied, not swallowed', r && r.denied === 1, r && r.denied);
      check('already-exited pid counts as terminated (gone is the goal state)',
        r && r.terminated >= 1, r && r.terminated);
      check('ok=false while anything was denied', r && r.ok === false);

      /* Every pid denied must be an ERROR - "killed" about processes still running is the
         action-layer plausible zero. */
      acts._inject(null, () => { const x = new Error('EPERM'); x.code = 'EPERM'; throw x; });
      acts.kill([500, 501], (e3) => {
        check('all-denied reports an error, not success', !!e3, e3 && e3.message);
        acts._inject(null, (pid, sig) => process.kill(pid, sig));   // restore
        done();
      });
    });
  });
});

/* ---------------- clean: a real tree, measured and swept ---------------- */

step((done) => {
  console.log('\n--- clean (real temporary tree) ---');
  const dir = path.join(TMP, 'cache');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(300000));
  fs.writeFileSync(path.join(dir, 'sub', 'b.bin'), Buffer.alloc(200000));
  /* A symlink pointing OUTSIDE the target: it must be neither measured nor followed. */
  const outside = path.join(TMP, 'outside.bin');
  fs.writeFileSync(outside, Buffer.alloc(100000));
  try { fs.symlinkSync(outside, path.join(dir, 'link.bin')); } catch { /* no symlink rights on some Windows setups */ }

  const m = acts._internal.measureTree(dir);
  check('measureTree sums real files, not the symlink target', m.bytes === 500000, m.bytes);

  acts.clean('t', (e, r) => {
    check('sweep reports what it deleted', !e && r && r.entriesDeleted >= 2, JSON.stringify(r));
    check('a clean run is ok with zero denials', r && r.ok === true && r.entriesDenied === 0);
    check('the target directory itself survives (children only)', fs.existsSync(dir));
    check('everything under it is gone', fs.readdirSync(dir).length === 0);
    check('the symlink TARGET outside the tree survives', fs.existsSync(outside));

    acts.clean('nope', (e2) => {
      check('unknown key refused (fixed table, no path parameter)', !!e2, e2 && e2.message);
      done();
    });
  }, { t: { dir: () => dir, elevate: false } });
});

/* ---------------- elevation: quoting and the fixed-table rule ---------------- */

step((done) => {
  console.log('\n--- elevation (command construction only) ---');
  const { shq, osaStr } = acts._internal;
  check("sh quoting survives an embedded single quote", shq(`a'b`) === `'a'\\''b'`, shq(`a'b`));
  check('AppleScript quoting escapes backslash then quote',
    osaStr(`x\\y"z`) === `x\\\\y\\"z`, osaStr(`x\\y"z`));

  let captured = null;
  acts._inject((cmd, args, opts, cb) => { captured = { cmd, args }; cb(new Error('not a mac')); }, null);
  acts.cleanElevated('syscaches', (e) => {
    check('elevation goes through osascript -e', captured && captured.cmd === 'osascript'
      && captured.args[0] === '-e', captured && captured.cmd);
    const osa = captured ? captured.args[1] : '';
    check('command asks for administrator privileges', /with administrator privileges$/.test(osa));
    check('the elevated process is clean-admin.js with a KEY, never a caller path',
      osa.includes('clean-admin.js') && osa.includes('--targets') && osa.includes('syscaches'), osa.slice(0, 160));
    check('a failed elevation is an error, not silent success', !!e, e && e.message);

    /* And the table inside clean-admin.js is the last line of that defence: */
    const bad = admin.cleanOne('../../etc');
    check('clean-admin refuses a key that is not in its own MAP', bad.ok === false && /unknown/.test(bad.err));
    check('clean-admin MAP contains no user-supplied paths (fixed strings only)',
      Object.values(admin.MAP).every((t) => typeof t.path === 'string' && t.path.startsWith('/')));
    done();
  });
});

/* ---------------- restartApp: refusals first, then the full sequence ---------------- */

step((done) => {
  console.log('\n--- restartApp ---');
  acts.restartApp('bad"name', (e) => {
    check('name with a quote refused before any command runs', !!e);
    acts.restartApp('launchd', (e2) => {
      check('system-critical name refused', !!e2 && /system-critical/.test(e2.message), e2 && e2.message);
      /* Resolution failure = refusal BEFORE the quit - the app must still be running. */
      acts._inject((cmd, args, opts, cb) => cb(new Error('osascript: no such application'), ''), null);
      acts.restartApp('NotReal', (e3) => {
        check('unresolvable app refused (relaunching a guess is worse than not relaunching)',
          !!e3 && /cannot resolve/.test(e3.message), e3 && e3.message);
        done();
      });
    });
  });
});

step((done) => {
  const seq = [];
  const killed = [];
  acts._inject((cmd, args, opts, cb) => {
    seq.push(`${cmd} ${args.join(' ')}`);
    if (cmd === 'osascript' && /POSIX path/.test(args[1])) return cb(null, '/Applications/Fake.app\n');
    if (cmd === 'pgrep') return cb(null, '600\n601\n');
    cb(null, '');
  }, (pid, sig) => {
    if (sig === 0 && pid === 600) { const x = new Error('ESRCH'); x.code = 'ESRCH'; throw x; }  // quit politely
    if (sig === 'SIGKILL') killed.push(pid);
  });
  acts.restartApp('Fake', (e, r) => {
    check('happy path: ok with the resolved bundle path', !e && r && r.ok === true && r.path === '/Applications/Fake.app',
      JSON.stringify(r));
    check('resolution happens BEFORE the quit', /POSIX path/.test(seq[0]), seq[0]);
    check('graceful AppleScript quit before any force',
      seq.some((s) => /tell application "Fake" to quit/.test(s)));
    check('only the survivor was force-killed', killed.join(',') === '601', killed.join(','));
    check('relaunch uses the resolved path, not the name', seq[seq.length - 1] === 'open /Applications/Fake.app',
      seq[seq.length - 1]);
    check('graceful/forced split reported', r && r.closedGracefully === 1 && r.forced === 1,
      r && `${r.closedGracefully}/${r.forced}`);
    acts._inject((cmd, args, opts, cb) => cb(new Error('restored'), ''), (pid, sig) => process.kill(pid, sig));
    done();
  });
});

/* ---------------- growth walker + the diff it feeds ---------------- */

step((done) => {
  console.log('\n--- growth walker (real tree) + History.growth ---');
  const root = path.join(TMP, 'home');
  fs.mkdirSync(path.join(root, 'proj', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  /* Realistic sizes WITHOUT the I/O: truncate extends the LOGICAL size, which is what lstat
     reports and the walker sums, while writing (almost) nothing. History.growth() rounds to
     hundredths of a GB, so kilobyte-scale fixtures vanish in its own arithmetic - the first cut
     of this test learned that by failing. */
  const MB = 1048576;
  const mk = (p, mb) => { fs.writeFileSync(p, ''); fs.truncateSync(p, mb * MB); };
  mk(path.join(root, 'proj', 'a.bin'), 400);
  mk(path.join(root, 'proj', 'deep', 'b.bin'), 300);
  mk(path.join(root, 'docs', 'c.bin'), 100);

  const s1 = scan(root, { minBytes: 1 });
  check('total bytes = every file once', s1.totalBytes === 800 * MB, s1.totalBytes);
  check('file and dir counts real', s1.files === 3 && s1.dirs === 4, `${s1.files} files ${s1.dirs} dirs`);
  check('nothing denied on our own tree, and the snapshot SAYS so', s1.denied === 0 && /complete/.test(s1.note));
  check('snapshot declares its scanner family and separator', s1.scanner === 'walk-1' && s1.sep === path.sep);
  const proj = s1.entries.find((e) => e.path === path.join(root, 'proj'));
  check('directory totals are cumulative (proj = a + deep/b)', proj && proj.bytes === 700 * MB, proj && proj.bytes);
  check('entries sorted largest first', s1.entries[0].bytes === 800 * MB && s1.entries[0].path === root);

  /* Grow one deep folder by 0.49 GB - over the diff's default 0.25 GB floor. */
  mk(path.join(root, 'proj', 'deep', 'big.bin'), 500);
  const s2 = scan(root, { minBytes: 1 });

  const histDir = path.join(TMP, 'hist');
  fs.mkdirSync(histDir);
  fs.writeFileSync(path.join(histDir, 'walk-old.json'), JSON.stringify(s1));
  fs.writeFileSync(path.join(histDir, 'walk-new.json'), JSON.stringify(s2));
  /* An MFT snapshot sitting beside them, to prove the family guard. */
  fs.writeFileSync(path.join(histDir, 'mft-x.json'), JSON.stringify({ scanner: 3, takenAt: s1.takenAt, totalBytes: 1, entries: [] }));

  const h = new History(histDir);
  const snaps = h.snapshots();
  check('snapshots() lists BOTH families', snaps.length === 3, snaps.map((s) => s.file).join(','));

  const g = h.growth('walk-new.json', 'walk-old.json');           // the production 0.25 GB floor
  check('growth diff runs on walker snapshots', !!g && !g.incompatible);
  check('net growth measured (+0.49 GB)', g && near(g.netGB, 0.49, 0.011), g && g.netGB);
  const grewPaths = (g && g.grew || []).map((r) => r.path);
  check('deepest attribution wins with the POSIX-or-Windows separator (deep listed, not its ancestors)',
    grewPaths.some((p) => p.endsWith('deep')) && !grewPaths.some((p) => p === root || p.endsWith('proj')),
    grewPaths.join(' | '));

  const cross = h.growth('walk-new.json', 'mft-x.json');
  check('a walk is never diffed against an MFT index (different scanners refuse)',
    cross && cross.incompatible === true);
  done();
});

/* ---------------- teardown ---------------- */

function finish() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log('');
  if (fails) { console.log(`${fails} FAILED of ${checks}`); process.exit(1); }
  console.log(`all ${checks} checks passed - validation, counting, quoting, escalation and the walker's ` +
              `arithmetic are correct.\nThe osascript, pgrep and open behaviours are still assumptions ` +
              `until the CI live run on real Darwin agrees; caps.js stays false until then.`);
  process.exit(0);
}

runSteps();
