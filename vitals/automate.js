/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - AUTOMATIONS.  What this machine is allowed to do without being asked.
 *
 * ===========================================================================================
 * TWO CLASSES, AND THE LINE BETWEEN THEM IS "DOES THIS DEPEND ON YOUR HABITS?"
 * ===========================================================================================
 *
 * The first version of this file had one class and one rule - nothing is offered that you have
 * not already done by hand. The owner corrected it, and the correction was right: "just want to
 * make sure the requirements arent always do it by hand while something happening, id like to
 * just have any automation that is helpful. regular maintenance, crash support."
 *
 * That is a real gap. Requiring a manual precedent is exactly right for CLEANING TEMP FILES,
 * because whether that is worth doing depends entirely on how you use this machine - plenty of
 * people never need it. It is exactly wrong for CAPTURING EVIDENCE WHEN SOMETHING BREAKS, because
 * that is worth doing on every machine there has ever been, and the one moment you cannot do it
 * retroactively is the moment you need it. Under one rule that automation could never turn on.
 *
 *   EARNED    Its value depends on your habits, or it changes the machine. The outcomes ledger
 *             decides, on the three gates below. Nothing here is offered until the record says so.
 *
 *   STANDARD  Its value does not depend on you and it does not change the machine - regular
 *             maintenance and incident support: scans, snapshots, evidence capture. Offered
 *             immediately, OFF until you say otherwise, with its cost stated.
 *
 * THE LOAD-BEARING GUARD: a standard automation may never be destructive. That is asserted in
 * code (assertClasses, run at require time) rather than left to whoever adds the next candidate,
 * because "standard" is precisely the door through which a wishlist would walk back in. If a
 * future entry marks something destructive as standard, this module refuses to load.
 *
 * ===========================================================================================
 * FOR THE EARNED CLASS: NOTHING IS OFFERED THAT YOU HAVE NOT ALREADY DONE YOURSELF, AND MEASURED.
 * ===========================================================================================
 *
 * The obvious way to build this page is a list of fifteen plausible automations with fifteen
 * toggles. That is a wishlist, and a wishlist is the opposite of everything else in this product:
 * it asserts that a thing is worth doing on YOUR machine on the strength of it being worth doing
 * on SOME machine. It would also be unfalsifiable - a toggle nobody turns on tells you nothing,
 * and a toggle everybody turns on because it sounds sensible tells you less.
 *
 * So an automation is EARNED from the outcomes ledger, which has been recording the answer since
 * long before this file existed: every finding that fired, every lever you pulled while it was
 * firing, and the measured delta afterwards. A candidate becomes offerable only when this
 * machine's own record shows all three of:
 *
 *   1. THE SITUATION RECURS   - the trigger fired at least MIN_FIRES times in the window, so this
 *                               is a pattern rather than an anecdote.
 *   2. YOU CHOSE THIS ANSWER  - you pulled this exact lever during it at least MIN_PULLS times.
 *                               Not "an expert would"; you did.
 *   3. IT ACTUALLY WORKED     - the median measured benefit cleared the candidate's floor. A lever
 *                               you pull out of habit that changes nothing must never be promoted
 *                               to something the machine does while you sleep.
 *
 * Until then the candidate is EARNING, and the page shows exactly which of the three is missing
 * and by how much. That is the same contract outcomes.quarantine() already uses to let this
 * machine's record judge a diagnosis rule, applied in the other direction: there it demotes a rule
 * the record says is noise, here it promotes an action the record says is useful.
 *
 * ===========================================================================================
 * TIERS - and the one that does not exist
 * ===========================================================================================
 *
 *   observe     A read-only scan. Costs CPU and nothing else. Runs by itself once armed.
 *   reversible  Deletes only what the OS already marks disposable, and the result is measured in
 *               bytes returned. Runs by itself once armed.
 *   disruptive  Visibly changes the session you are working in - restarting an app, ending a
 *               process. ARMED MEANS IT PROPOSES, NEVER THAT IT ACTS. It raises the finding with
 *               the evidence and one button, and waits. The owner's line: "it should still ask
 *               for permission before doing stuff that could be risky."
 *   ai          Hands the judgement to an agent instead of a rule. Requires AI access to be
 *               granted, is off by default, and is refused outright if access has lapsed.
 *
 * There is no tier for elevated cleanup, and that is a finding rather than an omission: wintemp,
 * winupdate, winre and thumbs all route through a UAC one-shot, and UAC is by construction an
 * interactive consent prompt. An automation that cannot run without a human clicking a system
 * dialog is not an automation, so those targets are marked unautomatable and say why, instead of
 * being offered as a toggle that silently never fires.
 *
 * ===========================================================================================
 * DEMOTION - the part that makes the promotion trustworthy
 * ===========================================================================================
 *
 * An armed automation keeps being measured against the same floor that earned it. After
 * DEMOTE_AFTER automatic runs, if the median benefit has fallen below that floor, it DISARMS
 * ITSELF and records why. Something that stops paying must stop running: an automation nobody
 * reviews is a background process with a good story attached.
 *
 * Every automatic run is written to the SAME outcomes ledger as your manual ones (`ev:'auto'`),
 * so the record cannot diverge into "what you did" and "what it did", and so an automation's
 * own results feed straight back into the evidence that judges it.
 *
 * ===========================================================================================
 * THE SEAM
 * ===========================================================================================
 *
 * consider() never reaches the machine itself. Levers arrive as an injected map of functions, so
 * the suite drives every path - armed, ceiling-limited, demoted, refused - at full speed without
 * deleting a single file. A module that can only be tested by letting it act on the host is a
 * module that will not be tested.
 */

const fs = require('fs');
const path = require('path');

/* ---- the thresholds that decide whether the record has said enough ---- */
const WINDOW_DAYS = 30;
const MIN_FIRES = 5;        // the trigger recurs
const MIN_PULLS = 2;        // you answered it this way, more than once
const DEMOTE_AFTER = 3;     // automatic runs before the record may disarm it
const MAX_LOG = 400;        // per-automation run history kept in the state file

/* ===========================================================================================
 * THE CANDIDATES.
 * Every entry names a lever the bridge already implements and, where it responds to something, a
 * finding diagnose.js already emits. Nothing here is aspirational - if it is in this table, the
 * code to do it shipped before this file did.
 * =========================================================================================== */
const CANDIDATES = [
  {
    id: 'clean_temp_on_pressure',
    title: 'Clear temp files when the disk gets tight',
    /* EARNED: whether this is worth doing depends entirely on how you use the machine. */
    klass: 'earned',
    tier: 'reversible',
    lever: 'clean',
    /* Both unelevated targets. usertemp is the user's own %TEMP%; ctmp is C:\tmp. Neither needs
       admin, which is exactly why they are the two that can be automated at all.
       THEY ARE SEPARATELY SELECTABLE (owner: "if there is multiple options like different file
       locations that might have different care... select with a toggle"). They genuinely differ in
       care: %TEMP% is churn that Windows itself creates and re-creates, while C:\tmp is a folder
       somebody made on purpose and may be using as a scratch area. Same tier, different comfort,
       so the choice belongs to the reader rather than to this table. */
    options: [
      { key: 'usertemp', label: 'Your %TEMP% folder',
        what: 'Windows creates and abandons files here constantly. This is the one that reclaims space.' },
      { key: 'ctmp', label: 'C:\\tmp',
        what: 'Not a Windows folder — somebody created it. Leave it off if you use it as a scratch area.' },
    ],
    params: { keys: ['usertemp', 'ctmp'] },
    triggers: ['disk_low', 'spiral'],
    blast: 'Deletes the contents of %TEMP% and C:\\tmp — files the operating system already '
         + 'treats as disposable. Files held open by a running program are skipped, not forced. '
         + 'Nothing outside those two folders is touched.',
    /* GB returned. Below this the lever is ceremony: it ran, the disk did not notice. */
    floor: 0.2,
    floorUnit: 'GB returned',
    benefit: (r) => (r && typeof r.freedGB === 'number' ? r.freedGB : null),
    maxPerDay: 4,
    minGapMin: 60,
  },
  {
    id: 'growth_scan_daily',
    title: 'Scan for folders that are growing',
    /* STANDARD, and it was miscategorised as earned in the first version. Nothing about the value
       of a size snapshot depends on your habits: the Growth page can only say what changed if two
       snapshots exist, and the first one cannot be taken retroactively. Requiring you to run it by
       hand twice before it may run by itself gets the dependency backwards. */
    klass: 'standard',
    tier: 'observe',
    lever: 'growthscan',
    params: {},
    triggers: null,                 // cadence, not a symptom
    cadenceHours: 24,
    blast: 'Walks your own folders and writes a size snapshot. Reads only — it never opens, '
         + 'moves or deletes a file. The comparison against yesterday is what makes the Growth '
         + 'page able to say what changed.',
    /* An observe automation has no delta to measure, so it cannot be demoted on benefit. It is
       judged on the only thing it could get wrong: failing. */
    floor: null,
    benefit: () => null,
    maxPerDay: 2,
    minGapMin: 600,
  },
  {
    /* THE ONE THE OWNER'S CORRECTION WAS ABOUT: incident support. When something goes critical,
       the state that explains it exists for exactly as long as the machine stays in it - and the
       moment you go looking is always afterwards. Capturing it cannot be earned by a manual
       precedent, because the manual version of this is "notice in time, and be at the keyboard". */
    id: 'capture_on_critical',
    title: 'Capture the evidence when something goes critical',
    klass: 'standard',
    tier: 'observe',
    lever: 'bundle',
    /* WHAT THIS HOST MUST HAVE FOR IT TO WORK AT ALL. buildBundle zips with Compress-Archive, so
       off Windows this automation can be armed and will then fail on every single incident.
       consider() already skips a missing lever honestly, but that is far too late: by then the
       owner has switched on a thing that will never work, which is exactly the "toggle that
       silently never fires" the UNAUTOMATABLE list below exists to refuse. A capability a platform
       does not have must be REFUSED AT THE OFFER, with the reason, not discovered at the first
       incident it was supposed to document. */
    needs: 'powershell',
    needsWhy: 'the support bundle is zipped with PowerShell\'s Compress-Archive, which only exists '
            + 'on Windows. Nothing else about this automation is Windows-bound — it needs a zip.',
    params: {},
    triggers: ['spiral', 'thrash', 'io_congestion', 'disk_low', 'ram_tight'],
    /* Only for a finding that has just APPEARED — see consider(). A critical that has been open
       for six hours does not need a fresh snapshot every thirty seconds. */
    onlyOnNew: true,
    blast: 'Writes a support bundle — counters, the journal, the diagnosis and the process table '
         + 'as they were at that moment — into this install\'s own history folder. Reads only; it '
         + 'changes nothing about the machine and sends nothing anywhere. Costs a few MB per '
         + 'incident, and it is the one thing that cannot be collected after the fact.',
    floor: null,
    benefit: () => null,
    maxPerDay: 6,
    minGapMin: 45,
  },
  {
    id: 'restart_hog_on_leak',
    title: 'Offer to restart an app that is leaking memory',
    klass: 'earned',
    tier: 'disruptive',
    lever: 'restart-app',
    params: {},
    triggers: ['mem_hog'],
    blast: 'ARMED MEANS IT ASKS. This never restarts anything on its own — it raises the app, '
         + 'the measured growth and a single button, and waits for you. Restarting an app you '
         + 'are working in can lose unsaved work, so the decision stays yours.',
    floor: null,
    benefit: () => null,
    maxPerDay: 3,
    minGapMin: 120,
  },
];

/* Targets that LOOK automatable and are not. Stated on the page rather than omitted, because a
   missing option reads as an oversight and a refused one reads as a decision. */
const UNAUTOMATABLE = [
  { id: 'clean_elevated',
    title: 'Clear Windows Update / WinSxS / thumbnail caches',
    why: 'These run through a UAC elevation prompt, and UAC exists precisely to require a human '
       + 'at the keyboard. An automation that cannot proceed without you clicking a system dialog '
       + 'is not an automation, so this is offered as a button on Reclaim and nowhere else.' },
];

const byId = (id) => CANDIDATES.find((c) => c.id === id) || null;

/* THE GUARD ON THE STANDARD CLASS, enforced at require time rather than reviewed at commit time.
   "Offered without the record having to earn it" is only defensible while it is also "cannot
   change the machine". The moment those two come apart, `klass: 'standard'` is just a way to
   ship a toggle nobody asked for — so a destructive candidate marked standard fails the process
   on startup instead of quietly appearing on the page. Loud, early, and impossible to miss. */
const NON_DESTRUCTIVE = new Set(['observe']);
function assertClasses() {
  for (const c of CANDIDATES) {
    if (!c.klass) throw new Error(`automate: ${c.id} has no class — it must be 'earned' or 'standard'`);
    if (c.klass === 'standard' && !NON_DESTRUCTIVE.has(c.tier)) {
      throw new Error(
        `automate: ${c.id} is marked standard but its tier is '${c.tier}'. A standard automation is `
        + `offered WITHOUT the record earning it, so it may only observe. Make it 'earned', or make `
        + `it observe-only — there is no third option, and this is the guard that keeps the standard `
        + `class from becoming a wishlist.`);
    }
  }
}
assertClasses();

class Automations {
  /* @param opts.now      injectable clock (the suite must not wait a real day for a ceiling)
     @param opts.window   override WINDOW_DAYS for the suite */
  constructor(dir, outcomes, opts = {}) {
    this.dir = dir;
    this.outcomes = outcomes;
    this.file = path.join(dir, 'automations.json');
    this.now = opts.now || (() => Date.now());
    this.windowDays = opts.window || WINDOW_DAYS;
    this.state = this._read();
    /* Last tick's firings, for onlyOnNew. Deliberately in memory: after a restart every open
       finding is "new" once, which captures one snapshot of a machine that has just come back —
       a reasonable thing to have, and cheaper than persisting state to avoid it. */
    this.seen = new Set();
  }

  _read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return { armed: {} }; }
  }

  _save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      /* Write-then-rename: a torn automations.json is a machine that forgot what it was allowed
         to do, which fails OPEN (nothing armed) but silently loses the owner's decisions. */
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, this.file);
      return true;
    } catch { return false; }
  }

  /* ---------------------------------------------------------------------------------------
   * EARNING. Read the ledger and answer, for one candidate, whether this machine's own record
   * has said enough - and if not, exactly what is still missing.
   * --------------------------------------------------------------------------------------- */
  evidenceFor(id) {
    const c = byId(id);
    if (!c) return null;
    const cutoff = this.now() - this.windowDays * 86400_000;
    const rows = this.outcomes.recent(8000).filter((r) => r.at && r.at >= cutoff);

    /* 1. does the situation recur? A cadence automation has no trigger, so this test does not
       apply to it and must not be faked as passed - it is reported as not applicable. */
    let fires = null;
    if (c.triggers) {
      fires = rows.filter((r) => r.ev === 'fired' && c.triggers.includes(r.id)).length;
    }

    /* 2. did YOU choose this lever? Manual pulls only - counting the automation's own runs here
       would let an armed automation keep itself armed by running, which is not evidence, it is
       a loop. */
    const pulls = rows.filter((r) => r.ev === 'lever' && r.kind === c.lever);
    /* For a responding automation the pull must have happened WHILE the trigger was open,
       otherwise "you once emptied temp on a quiet Sunday" would count as answering disk pressure. */
    const relevant = c.triggers
      ? pulls.filter((r) => (r.during || []).some((d) => c.triggers.includes(d)))
      : pulls;

    /* 3. did it work? Median, not mean: one lucky 8 GB sweep must not carry four that freed
       nothing. Null benefits (observe tier, or a lever that reports no delta) are excluded
       rather than counted as zero - null travels, zero lies. */
    const deltas = relevant.map((r) => c.benefit(r.detail)).filter((v) => v != null);
    let median = null;
    if (deltas.length) {
      const s = deltas.slice().sort((a, b) => a - b);
      median = s[Math.floor((s.length - 1) / 2)];
    }

    /* A STANDARD automation has no gates to pass. It is reported with its counts anyway - the page
       still shows how often the situation has come up, because "this has happened 116 times in 30
       days" is the most useful thing anyone could know before turning it on, even when it is not
       being used as a condition. Evidence and permission are different jobs. */
    const need = [];
    if (c.klass === 'earned') {
      if (c.triggers && fires < MIN_FIRES) need.push(`the trigger has fired ${fires} of ${MIN_FIRES} times`);
      if (relevant.length < MIN_PULLS) {
        need.push(`you have done it by hand ${relevant.length} of ${MIN_PULLS} times`
          + (c.triggers ? ' while the trigger was open' : ''));
      }
      if (c.floor != null) {
        if (median == null) need.push(`no measured result yet — the floor is ${c.floor} ${c.floorUnit}`);
        else if (median < c.floor) need.push(`median result ${median} ${c.floorUnit}, below the ${c.floor} floor`);
      }
    }

    return {
      id, klass: c.klass, fires, minFires: c.klass === 'earned' && c.triggers ? MIN_FIRES : null,
      pulls: relevant.length, minPulls: c.klass === 'earned' ? MIN_PULLS : null,
      median, floor: c.floor, floorUnit: c.floorUnit || null,
      windowDays: this.windowDays,
      earned: need.length === 0,
      need,
      why: c.klass === 'standard'
        ? `standard maintenance — its value does not depend on your habits and it only ever reads, `
          + `so it is offered rather than earned`
          + (fires != null ? `. For scale: the situation has come up ${fires} times in ${this.windowDays} days.` : '')
        : need.length === 0
          ? (c.triggers
              ? `on this machine the trigger has fired ${fires} times in ${this.windowDays} days, you `
                + `answered it this way ${relevant.length} times, and the median result was `
                + `${median != null ? median + ' ' + c.floorUnit : 'not measured'}`
              : `you have run this by hand ${relevant.length} times in ${this.windowDays} days`)
          : 'not yet — ' + need.join('; '),
    };
  }

  /* ---------------------------------------------------------------------------------------
   * THE LIST the panel renders. Candidates, their evidence, their armed state, their history,
   * and the refused ones with their reason.
   * --------------------------------------------------------------------------------------- */
  /* Can this host run it at all? Answered from what the CALLER says it has, not from
     process.platform: the bridge knows whether it resolved a PowerShell, and a module that guesses
     the answer from the operating system name would be wrong on a Windows box with a broken PATH —
     which is a real state this codebase has already been bitten by (see pshost.js). */
  _blocked(c, ctx) {
    if (!c.needs) return null;
    const has = ctx.has || {};
    if (has[c.needs]) return null;
    return { needs: c.needs, why: c.needsWhy || `this host has no ${c.needs}` };
  }

  list(ctx = {}) {
    const items = CANDIDATES.map((c) => {
      const ev = this.evidenceFor(c.id);
      const a = this.state.armed[c.id] || null;
      const runs = (a && a.runs) || [];
      const recent = runs.slice(-DEMOTE_AFTER);
      const benefits = recent.map((r) => r.benefit).filter((v) => v != null);
      let medianRecent = null;
      if (benefits.length) {
        const s = benefits.slice().sort((x, y) => x - y);
        medianRecent = s[Math.floor((s.length - 1) / 2)];
      }
      return {
        id: c.id, title: c.title, klass: c.klass, tier: c.tier, lever: c.lever, blast: c.blast,
        triggers: c.triggers, cadenceHours: c.cadenceHours || null,
        /* Which targets exist, and which are selected. Selection survives disarm→rearm because it
           is a preference about HOW, not a permission about WHETHER. */
        options: c.options || null,
        targets: this._targets(c),
        floor: c.floor, floorUnit: c.floorUnit || null,
        maxPerDay: c.maxPerDay, minGapMin: c.minGapMin,
        /* A disruptive automation is armed to ASK. Saying "on" without saying that would be the
           single most dangerous piece of imprecision on this page. */
        actsAlone: c.tier !== 'disruptive',
        evidence: ev,
        armed: !!a,
        armedAt: a ? a.at : null,
        runCount: runs.length,
        lastRun: runs.length ? runs[runs.length - 1] : null,
        medianRecent,
        demotedWhy: (a && a.demotedWhy) || (this.state.demoted && this.state.demoted[c.id]) || null,
        requiresAi: c.tier === 'ai',
        aiAvailable: !!ctx.aiGranted,
        /* Stated on the card, so a platform that cannot do it says so instead of offering it. */
        blocked: this._blocked(c, ctx),
      };
    });
    return { items, unautomatable: UNAUTOMATABLE, windowDays: this.windowDays };
  }

  /* ---------------------------------------------------------------------------------------
   * ARM / DISARM.
   * Arming is refused unless the record earned it. This is the load-bearing refusal: without it
   * the whole design collapses back into a wishlist with extra steps.
   * --------------------------------------------------------------------------------------- */
  /* Selected targets, defaulting to all of them. Stored outside `armed` so a disarm does not throw
     away a choice you made about which folders you are comfortable with. */
  _targets(c) {
    if (!c.options) return null;
    const saved = (this.state.targets || {})[c.id];
    if (!Array.isArray(saved)) return c.options.map((o) => o.key);
    return c.options.map((o) => o.key).filter((k) => saved.includes(k));
  }

  setTargets(id, keys) {
    const c = byId(id);
    if (!c || !c.options) return { error: 'this automation has no targets to choose from' };
    const valid = c.options.map((o) => o.key);
    const picked = (Array.isArray(keys) ? keys : []).filter((k) => valid.includes(k));
    /* AN EMPTY SELECTION IS REFUSED, not stored. An armed automation with nothing selected would
       run forever, do nothing, and report success - the most confusing possible state. Turning it
       off is what "none of these" means, and that control is right there. */
    if (!picked.length) {
      return { error: 'choose at least one — an automation with no targets would run and do nothing. '
                    + 'To stop it entirely, turn it off.', refused: 'empty-selection' };
    }
    this.state.targets = this.state.targets || {};
    this.state.targets[id] = picked;
    this._save();
    return { ok: true, id, targets: picked };
  }

  arm(id, opts = {}) {
    const c = byId(id);
    if (!c) return { error: 'no such automation' };
    /* REFUSED AT THE OFFER, before any of the earning logic runs. `force` deliberately does NOT
       override this: force exists so the suite can reach paths that would otherwise need a month
       of history, and no amount of history makes Compress-Archive exist on a Mac. */
    const blocked = this._blocked(c, opts);
    if (blocked) {
      return { error: 'this host cannot run it — ' + blocked.why, refused: 'unavailable', blocked };
    }
    if (c.tier === 'ai' && !opts.aiGranted) {
      return { error: 'this one hands the judgement to an agent, and AI access is not granted', refused: 'no-ai' };
    }
    const ev = this.evidenceFor(id);
    if (!ev.earned && !opts.force) {
      return { error: 'this machine\'s record has not earned it yet — ' + ev.need.join('; '),
               refused: 'unearned', evidence: ev };
    }
    this.state.armed[id] = { at: this.now(), runs: (this.state.armed[id] || {}).runs || [] };
    if (this.state.demoted) delete this.state.demoted[id];
    this._save();
    return { ok: true, id, armed: true, actsAlone: c.tier !== 'disruptive', evidence: ev };
  }

  disarm(id) {
    if (!this.state.armed[id]) return { ok: true, id, armed: false, note: 'was not armed' };
    delete this.state.armed[id];
    this._save();
    return { ok: true, id, armed: false };
  }

  /* ---------------------------------------------------------------------------------------
   * THE CEILINGS. Asked before anything runs, and each answer names itself so the page can say
   * why nothing happened - "it did not fire" and "it was not allowed to fire" are different facts.
   * --------------------------------------------------------------------------------------- */
  _gate(c, a) {
    const now = this.now();
    const runs = a.runs || [];
    const today = runs.filter((r) => now - r.at < 86400_000).length;
    if (today >= c.maxPerDay) return { blocked: 'daily-ceiling', detail: `${today} of ${c.maxPerDay} today` };
    const last = runs.length ? runs[runs.length - 1].at : 0;
    if (last && now - last < c.minGapMin * 60_000) {
      return { blocked: 'min-gap', detail: `${Math.round((now - last) / 60000)} min since the last, minimum ${c.minGapMin}` };
    }
    return { blocked: null };
  }

  /* ---------------------------------------------------------------------------------------
   * CONSIDER - called with each fresh diagnosis, from the same place outcomes.observe() is.
   *
   * `levers` is injected: { clean(keys, cb), growthscan(cb), propose(payload) }. Anything absent
   * is treated as unavailable on this host, which is the honest reading - an automation whose
   * lever does not exist here must report that, not fail quietly.
   * --------------------------------------------------------------------------------------- */
  async consider(d, tick, levers = {}, ctx = {}) {
    if (!d || !d.ready) return { ran: [], skipped: ['diagnosis not ready'] };
    /* SINGLE-FLIGHT, and it is load-bearing twice over.
       RE-ENTRANCY: a lever can reach code that calls back into the diagnosis loop. The bundle lever
       did exactly that and recursed 830 deep in one tick, because `seen` and the run log are both
       written after the lever resolves, so every nested pass saw a fresh trigger and an untouched
       ceiling. The caller was fixed too (buildBundle takes the diagnosis it already has), but a
       guard that depends on every future lever staying well-behaved is not a guard.
       OVERLAP: consider() is called from a 30 s interval AND from three request handlers, and a
       growthscan lever can run for fifteen minutes. Without this, a second pass reads gate state
       the first pass has not written yet, and the slow pass finishes by overwriting `seen` with a
       fifteen-minute-old snapshot — re-minting every finding as new.
       THE PRICE, stated: this serialises every automation behind the slowest lever. During a long
       growthscan a capture for a genuinely new critical is DELAYED until the scan finishes — late,
       not lost, since the stale `seen` it is compared against will not contain the new finding.
       That is the right trade (a scan already in flight is doing useful work, and a duplicate
       capture mid-scan helps nobody) but it is a real cost and should not be discovered later. */
    if (this.busy) return { ran: [], skipped: [{ why: 're-entered while already considering' }] };
    this.busy = true;
    try { return await this._consider(d, tick, levers, ctx); } finally { this.busy = false; }
  }

  async _consider(d, tick, levers = {}, ctx = {}) {
    const firing = new Set((d.findings || []).map((f) => f.id));
    const ran = [], skipped = [];

    for (const c of CANDIDATES) {
      const a = this.state.armed[c.id];
      if (!a) continue;

      /* Does it want to run? */
      let wants = false;
      if (c.triggers) {
        const hit = c.triggers.filter((t) => firing.has(t));
        /* onlyOnNew: capture the moment it BREAKS, not every tick it stays broken. `this.seen`
           carries the previous tick's firings, so a critical that has been open for six hours does
           not mint a fresh snapshot every thirty seconds until the disk it is diagnosing is full. */
        wants = c.onlyOnNew ? hit.some((t) => !this.seen.has(t)) : hit.length > 0;
      } else if (c.cadenceHours) {
        const last = (a.runs || []).length ? a.runs[a.runs.length - 1].at : 0;
        wants = !last || this.now() - last >= c.cadenceHours * 3600_000;
      }
      if (!wants) continue;

      /* The governor throttles work that is merely SCHEDULED, never work that is the response to
         something going wrong. Deferring a disk sweep because the machine is stalling would defer
         it exactly when the disk pressure is causing the stall. */
      if (c.tier === 'observe' && ctx.stalling) { skipped.push({ id: c.id, why: 'foreground stall — an observe scan waits' }); continue; }

      const g = this._gate(c, a);
      if (g.blocked) { skipped.push({ id: c.id, why: g.blocked, detail: g.detail }); continue; }

      /* DISRUPTIVE NEVER ACTS. It proposes, and a proposal is the whole of its behaviour. */
      if (c.tier === 'disruptive') {
        if (!levers.propose) { skipped.push({ id: c.id, why: 'no way to ask you on this host' }); continue; }
        const p = levers.propose({ id: c.id, title: c.title, lever: c.lever, findings: [...firing].filter((f) => (c.triggers || []).includes(f)) });
        this._record(c, a, { proposed: true, detail: p || null }, null);
        ran.push({ id: c.id, proposed: true });
        continue;
      }

      const fn = levers[c.lever];
      if (typeof fn !== 'function') { skipped.push({ id: c.id, why: `the ${c.lever} lever is not available on this host` }); continue; }

      /* The selected targets, not the table's full list — this is where the per-target choice
         actually reaches the machine, and it is the only place the two can diverge. */
      const params = c.options ? { ...c.params, keys: this._targets(c) } : c.params;
      /* THE SLOT IS RESERVED BEFORE THE AWAIT, not recorded after it. _gate() reads this same run
         log, so recording afterwards puts a check-then-act around an await: anything that reaches
         consider() again during a slow lever passes a ceiling that has not yet been told about the
         run in flight. The entry is completed in place once the lever answers. */
      /* WHICH INCIDENT THIS RUN BELONGS TO. An episode is a stretch of firing uninterrupted by the
         trigger clearing, so the id only advances when the trigger was NOT open on the previous
         pass. Cadence automations have no incident, so each run is its own episode. */
      a.episode = a.episode || 0;
      if (c.triggers) {
        const wasOpen = c.triggers.some((t) => this.seen.has(t));
        if (!wasOpen) a.episode++;
      } else a.episode++;
      const slot = this._record(c, a, { pending: true, episode: a.episode }, null);
      let res = null, err = null;
      try { res = await fn(params); } catch (e) { err = (e && e.message) || String(e); }
      /* A LEVER THAT RESOLVES CAN STILL HAVE FAILED. The clean lever stopped rejecting so it could
         keep partial results, which meant an all-targets-failed run arrived here as a resolved
         promise and was filed as `ok: true` — "ran, no result" — while the failure sat unread in
         `detail.errors`. A lever's own verdict about itself outranks the absence of a throw. */
      const leverSaysNo = res && res.ok === false;
      const benefit = err ? null : c.benefit(res);
      Object.assign(slot, {
        pending: false, ok: !err && !leverSaysNo, err: err || (leverSaysNo ? 'the lever reported failure' : null),
        detail: res, benefit,
      });
      /* One verdict, computed once, used everywhere — the slot, the return value and the ledger row. */
      ran.push({ id: c.id, ok: slot.ok, benefit, err: slot.err });

      /* The automation's own result goes into the SAME ledger as a manual pull, tagged so the two
         can never be confused - and so the Outcomes page shows one timeline, not two. */
      try { this.outcomes._write({ ev: 'auto', id: c.id, lever: c.lever, ok: slot.ok, benefit, at: this.now(), during: [...firing], m: this.outcomes.metricsOf(tick) }); } catch {}

      this._maybeDemote(c);
    }
    this._save();
    /* Updated LAST, so every candidate in this pass sees the same "what was already firing"
       snapshot. Moving this to the top of the loop would make the first candidate's view of
       "new" depend on where it sits in the table. */
    this.seen = firing;
    return { ran, skipped };
  }

  /* Returns the entry so a caller can reserve the slot first and complete it after the await. */
  _record(c, a, result, benefit) {
    a.runs = a.runs || [];
    const row = { at: this.now(), ...result, benefit };
    a.runs.push(row);
    if (a.runs.length > MAX_LOG) a.runs = a.runs.slice(-MAX_LOG);
    return row;
  }

  /* An automation is held to the same floor that earned it. Nothing here is about failure rates:
     a lever that runs cleanly and returns nothing is the case this catches, and it is the one a
     success/failure count would call healthy forever. */
  /* PER EPISODE, NOT PER RUN — the "empty well" problem, found in review.
     A cleanup run at the 60-minute gap during ONE sustained incident frees a gigabyte the first
     time and nothing the next two, because the first one emptied the well. Taking the median of
     the last three RUNS therefore disarms the automation in the middle of the incident it was
     earned for, and the message ("it stopped paying for itself") is arithmetically true and
     diagnostically backwards: it worked, which is precisely why the later runs found nothing.
     An episode is a run of firings uninterrupted by the trigger clearing, so it is scored by its
     BEST run — did this automation help with this incident at all — and demotion needs
     DEMOTE_AFTER unhelpful EPISODES. Three separate incidents where it achieved nothing is a
     real verdict; three ticks inside one incident is a description of it succeeding. */
  _episodes(a) {
    const eps = [];
    let cur = null;
    for (const r of a.runs || []) {
      if (!cur || r.episode !== cur.key) { cur = { key: r.episode, best: null }; eps.push(cur); }
      if (r.benefit != null && (cur.best == null || r.benefit > cur.best)) cur.best = r.benefit;
    }
    /* A run reserved before its lever answered — including one a crash left pending on disk —
       carries a null benefit, so this filter already excludes it and no separate `if (r.pending)`
       skip is needed. There WAS one, and mutation testing proved it could be deleted without any
       check going red: taking the max over non-null benefits makes it unreachable by construction.
       Removed rather than propped up with a test written to fit it. A line that cannot change the
       outcome is not a guard, and leaving it in claims a protection that is not there. */
    return eps.filter((e) => e.best != null);
  }

  _maybeDemote(c) {
    if (c.floor == null) return null;
    const a = this.state.armed[c.id];
    if (!a) return null;
    const eps = this._episodes(a);
    if (eps.length < DEMOTE_AFTER) return null;
    const recent = eps.slice(-DEMOTE_AFTER).map((e) => e.best).sort((x, y) => x - y);
    const median = recent[Math.floor((recent.length - 1) / 2)];
    if (median >= c.floor) return null;
    delete this.state.armed[c.id];
    this.state.demoted = this.state.demoted || {};
    this.state.demoted[c.id] = {
      at: this.now(), median, floor: c.floor,
      why: `disarmed itself: across the last ${DEMOTE_AFTER} separate incidents its BEST run `
         + `returned a median of ${median} ${c.floorUnit}, below the ${c.floor} ${c.floorUnit} `
         + `that earned it. Three different occasions where it achieved nothing — not three ticks `
         + `inside one. It stopped paying for itself, so it stopped running.`,
    };
    this._save();
    return this.state.demoted[c.id];
  }
}

module.exports = { Automations, CANDIDATES, UNAUTOMATABLE, MIN_FIRES, MIN_PULLS, DEMOTE_AFTER };
