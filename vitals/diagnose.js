/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS — causal diagnosis engine.
 *
 * The gap this fills: every monitor shows you forty numbers and leaves the synthesis to you.
 * Knowing RAM is at 78% is not knowing why the machine feels slow. This produces ranked, evidenced
 * statements of CAUSE, in the order they're worth acting on.
 *
 * Three design rules, all of which exist to stop it from crying wolf:
 *
 *  1. NOTHING FIRES ON AN INSTANT. Every rule tests a SUSTAINED condition against the history ring.
 *     A 100% CPU spike is a process starting; 100% for ninety seconds is a problem. Rules that
 *     can't meet their window return nothing rather than guessing.
 *  2. COMPOUND RULES OUTRANK THEIR PARTS. "Disk is full" and "RAM is tight" are two findings.
 *     "The disk is full BECAUSE the pagefile grew BECAUSE RAM is exhausted" is one finding that
 *     explains both, and it suppresses them.
 *  3. EVERY FINDING CARRIES ITS EVIDENCE. Measured numbers, not adjectives — so a wrong call is
 *     visibly wrong instead of merely unconvincing.
 */

const S = { CRIT: 3, WARN: 2, INFO: 1 };
const NAME = { 3: 'critical', 2: 'warning', 1: 'note' };

function gb(mb) { return +(mb / 1024).toFixed(1); }

/* Compact surfaces get a SHORT form (2026-07-30). The overview tile and the docked sidebar have one
 * line each; the full sentence earns its elaboration on the DIAG page, where there is room for it.
 * Owner: "the disk is full because your ram is exhausted - the two are feeding each other. have it just
 * say the disk is full because your ram is exhausted."
 * Derived from the title rather than authored per rule, so a new finding cannot forget to carry one -
 * every title here is written as CLAIM then separator then elaboration, and the elaboration is exactly
 * what should go first when space runs out. */
function shortTitle(t) {
  const cut = String(t).split(' — ')[0].split(' · ')[0].trim();
  return cut.length >= 12 ? cut : String(t);   // never truncate into something meaningless
}

/* ---------- the feedback sentence (outcomes ledger → prose) ----------
 * When a finding fires AGAIN, the ledger knows what happened last time: how long it lasted, which
 * levers were pulled while it was open, what the metrics did, and how long the machine then
 * stayed clear. Composing that here (not in the UI) keeps the same rule as `chain`: the sentence
 * is built from the engine's own recorded values, so it can never disagree with the ledger. */
function pastText(p) {
  const ago = (t) => { const h = (Date.now() - t) / 3600000; return h < 1 ? Math.round(h * 60) + ' min' : h < 48 ? h.toFixed(1) + ' h' : (h / 24).toFixed(1) + ' days'; };
  const dur = (s) => s < 90 ? s + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : (s / 3600).toFixed(1) + ' h';
  const levers = (p.levers || []).map((l) =>
    l.kind === 'clean' ? `cleaning ${l.detail.key} returned ${l.detail.freedGB} GB`
    : l.kind === 'kill' ? `you killed ${(l.detail.pids || []).length} process${(l.detail.pids || []).length === 1 ? '' : 'es'}${l.detail.name ? ' (' + l.detail.name + ')' : ''}`
    : l.kind === 'task' ? `you ${l.detail.enable ? 'enabled' : 'disabled'} task ${l.detail.name}`
    : l.kind).join('; ');
  let t = `Last time this fired (${ago(p.firedAt)} ago) it cleared after ${dur(p.durSec)}`;
  if (levers) t += ` — during it ${levers}`;
  const dFree = p.m1 && p.m0 && typeof p.m1.freeGB === 'number' && typeof p.m0.freeGB === 'number' ? +(p.m1.freeGB - p.m0.freeGB).toFixed(1) : null;
  if (dFree !== null && Math.abs(dFree) >= 0.5) t += `; C: free moved ${dFree > 0 ? '+' : ''}${dFree} GB`;
  t += `. It then stayed clear for ${ago(p.clearedAt)}.`;
  return t;
}

/**
 * @param tick   latest metrics sample
 * @param hist   History instance
 * @param extra  { growth?, snapshot?, startupCount?, outcomes?, maint?, trend? }
 */
function diagnose(tick, hist, extra = {}) {
  if (!tick) return { findings: [], summary: 'waiting for data', ready: false };

  const f = [];
  /* THE SYSTEM VOLUME, cross-platform, and NULL when there is not one.
     This was `find(v => v.id === 'C:') || { pct: 0, freeGB: 0, sizeGB: 1 }` - two failures sharing
     a line. The selector only matched Windows, so on Linux and macOS, where the root volume is '/',
     nothing ever matched. The fallback then described the disk as 0% used with 0 GB free.
     Every rule below tests `pct >= N`, so a zeroed volume does not fire a WRONG finding - it fires
     NOTHING, which is worse in the only way this project cares about: the engine silently reports a
     healthy disk on a machine whose disk is full, and the absence of a finding reads as an all-clear.
     history.js:59 already selects the root volume properly. Same selection here, and null instead of
     zeros so a missing volume DISABLES the disk rules rather than answering on their behalf. */
  const vol = (() => {
    const v = (tick.disk && tick.disk.vols) || [];
    return v.find((x) => x.id === 'C:')
        || v.find((x) => x.id === '/')
        /* Neither name present (a Windows install on D:, an unusual mount layout): the biggest
           volume is the best available guess, and it is a guess about WHICH disk, not about its
           numbers - those are still measured. */
        || v.slice().sort((a, b) => (b.sizeGB || 0) - (a.sizeGB || 0))[0]
        || null;
  })();
  /* The label every disk finding quotes. Hard-coding "C:" in the prose was the same Windows
     assumption one layer up: a finding that says "C: is 4% free" on a Mac is wrong twice. */
  const volId = vol ? vol.id : null;
  /* "22.6 GB free of undefined GB". Total capacity is not archived, so a finding replayed from the
     record interpolated `undefined` straight into its evidence - a measured number and a hole,
     printed with identical confidence. The percentage is archived and says the same thing, so the
     phrase degrades to it rather than to a placeholder. Live ticks are unaffected; this also
     covers any platform whose volume reader omits a size. */
  const freeOf = () => !vol ? ''
    : vol.sizeGB != null
      ? `${vol.freeGB} GB free of ${vol.sizeGB} GB`
      : `${vol.freeGB} GB free (${(100 - vol.pct).toFixed(1)}% of the volume)`;
  const totalRamMB = tick.mem.totalMB;
  const suppress = new Set();

  const add = (o) => {
    // Attach this-machine history from the outcomes ledger, if the bridge passed one in.
    if (extra.outcomes) {
      try { const p = extra.outcomes.pastFor(o.id); if (p) o.past = { ...p, text: pastText(p) }; } catch {}
    }
    f.push(o);
  };

  /* ---------- 1. the compound spiral (the whole point of this engine) ---------- */
  const diskTight = !!vol && vol.pct >= 90;
  const ramTight = hist.sustained('mem', (v) => v >= 80, 120, 0.7);
  const faulting = hist.sustained('hardFaults', (v) => v >= 80, 120, 0.4);
  // pagefile is inferred: committed well above installed means Windows is leaning on disk
  const overCommit = tick.mem.committedMB > totalRamMB * 1.2;

  if (diskTight && (ramTight || overCommit)) {
    suppress.add('disk_low'); suppress.add('ram_tight');
    add({
      id: 'spiral', sev: S.CRIT,
      title: `Your disk is full because your RAM is exhausted — the two are feeding each other`,
      because:
        `RAM sits at ${tick.mem.pct}% with ${gb(tick.mem.committedMB)} GB committed against ` +
        `${gb(totalRamMB)} GB installed, so Windows has grown the pagefile to absorb the overflow. ` +
        `That pagefile is consuming the disk that is already at ${vol.pct}% — and a drive this full ` +
        `has no spare blocks left for wear-levelling, so every write it serves is slower than rated. ` +
        `Freeing disk unwinds it from both ends at once.`,
      evidence: [
        `${volId} ${freeOf()}`,
        `RAM ${tick.mem.pct}% used, sustained (${ramTight ? Math.round(ramTight.frac * 100) + '% of last 2 min' : 'commit-based'})`,
        `Committed ${gb(tick.mem.committedMB)} GB vs ${gb(totalRamMB)} GB installed`,
        faulting ? `Hard faults averaging ${hist.stat('hardFaults', 120).avg}/s — actively paging to disk` : `Hard faults low right now`,
      ],
      action: 'Free disk first (Reclaim tab), then cap the pagefile. Do not cap it while space is scarce.',
      confidence: faulting ? 'high' : 'medium',
      /* The mechanism as STRUCTURE, not only prose — the UI renders this as the causal chain.
       * Every value here is the same measurement quoted in the evidence; nothing is derived
       * client-side from text, so the chain can never disagree with the finding. `loop` marks
       * that the last node feeds the first (the spiral). */
      chain: {
        loop: true,
        steps: [
          { v: `${tick.mem.pct}%`,               l: 'RAM used' },
          { v: `${gb(tick.mem.committedMB)} GB`, l: `committed of ${gb(totalRamMB)}` },
          { v: `${(100 - vol.pct).toFixed(1)}%`, l: `${volId} free` },
          { v: faulting ? `${hist.stat('hardFaults', 120).avg}/s` : `${tick.mem.pagesSec ?? 0}/s`, l: 'hard faults' },
        ],
      },
    });
  }

  /* ---------- 2. individual resource pressure ---------- */
  if (vol && !suppress.has('disk_low') && vol.pct >= 90) {
    add({
      id: 'disk_low', sev: vol.pct >= 95 ? S.CRIT : S.WARN,
      title: `${volId} is ${(100 - vol.pct).toFixed(1)}% free — below the threshold where SSDs slow down`,
      because: `Below ~10% free an SSD runs out of spare blocks for wear-levelling and garbage ` +
               `collection; sustained write throughput can fall by more than half. Fully reversible.`,
      evidence: [freeOf()],
      action: 'Reclaim tab → clear Tier 1. Then archive the large directories under Growth.',
      confidence: 'high',
    });
  }

  if (!suppress.has('ram_tight')) {
    const r = hist.sustained('mem', (v) => v >= 85, 180, 0.7);
    if (r) add({
      id: 'ram_tight', sev: S.WARN,
      title: `Memory has been above 85% for ${Math.round(r.samples / 60)} of the last 3 minutes`,
      because: `Once physical RAM is exhausted Windows pages to disk. The percentage itself is not ` +
               `the problem — the hard-fault rate below is what you actually feel.`,
      evidence: [`${tick.mem.pct}% used, ${gb(tick.mem.freeMB)} GB available`,
                 `${Math.round(r.frac * 100)}% of samples above threshold`],
      action: 'Close what you are not using, or check the memory hogs below.',
      confidence: 'high',
    });
  }

  const hf = hist.sustained('hardFaults', (v) => v >= 150, 90, 0.4);
  if (hf) {
    const st = hist.stat('hardFaults', 90);
    add({
      id: 'thrash', sev: S.CRIT,
      title: `Actively thrashing the pagefile — ${st.avg} hard faults/sec average`,
      because: `A hard fault is Windows fetching a memory page back from disk because it wasn't in ` +
               `RAM. This is the single most direct measure of "out of memory", and unlike the RAM ` +
               `percentage it correlates with what you perceive as stalling.`,
      evidence: [`avg ${st.avg}/s, peak ${st.max}/s over ${st.n}s`,
                 `RAM ${tick.mem.pct}%, disk queue ${tick.disk.io.queue}`],
      action: 'Free RAM now. This is costing you real time on every operation.',
      confidence: 'high',
    });
  }

  /* ---------- 3. I/O attribution — who is causing the congestion ---------- */
  const q = hist.sustained('diskQueue', (v) => v >= 2, 60, 0.5);
  if (q) {
    const hogs = [...(tick.proc || [])]
      .map((p) => ({ ...p, io: (p.rMBs || 0) + (p.wMBs || 0) }))
      .filter((p) => p.io > 0.5).sort((a, b) => b.io - a.io).slice(0, 3);
    add({
      id: 'io_congestion', sev: S.WARN,
      title: hogs.length
        ? `Disk is congested and ${hogs[0].n} is the main cause (${hogs[0].io.toFixed(1)} MB/s)`
        : `Disk queue has been backed up for a minute`,
      because: `Queue depth is how many requests are waiting on the drive. Sustained above ~2 per ` +
               `physical disk means every app on the machine is waiting, which is felt as stutter ` +
               `rather than slowness.`,
      evidence: [
        `queue ${tick.disk.io.queue}, active ${tick.disk.io.busyPct}%`,
        ...hogs.map((h) => `${h.n}: read ${h.rMBs} MB/s, write ${h.wMBs} MB/s`),
      ],
      action: hogs.length ? `If ${hogs[0].n} is a background task, pause it.` : 'Identify the writer in the Processes view.',
      confidence: hogs.length ? 'high' : 'medium',
    });
  }

  /* ---------- 4. CPU shape, not just CPU level ---------- */
  const oneCore = hist.sustained('cpuMax', (v) => v >= 92, 90, 0.7);
  const totalLow = hist.sustained('cpu', (v) => v <= 45, 90, 0.7);
  if (oneCore && totalLow) {
    add({
      id: 'single_thread', sev: S.INFO,
      title: 'A single-threaded bottleneck — one core pinned while the rest idle',
      because: `One logical thread has been saturated while total CPU stayed low. Whatever is ` +
               `running cannot use more cores, so a faster CPU would help and more cores would not.`,
      evidence: [`peak core ${hist.stat('cpuMax', 90).avg}% avg`, `total CPU ${hist.stat('cpu', 90).avg}% avg`],
      action: 'Informational. Relevant when choosing hardware or parallelising a workload.',
      confidence: 'medium',
    });
  }

  const cpuHog = (tick.proc || []).filter((p) => p.cpu >= 40).sort((a, b) => b.cpu - a.cpu)[0];
  if (cpuHog && hist.sustained('cpu', (v) => v >= 60, 120, 0.6)) {
    add({
      id: 'cpu_hog', sev: S.INFO,
      title: `${cpuHog.n} is holding ${cpuHog.cpu}% of CPU`,
      because: `Sustained across the last two minutes, so not a startup spike.`,
      evidence: [`${cpuHog.n} — ${cpuHog.cpu}% CPU, ${cpuHog.count} instance(s), ${cpuHog.mb} MB`],
      action: 'Expected for a build or render. Unexpected otherwise.',
      confidence: 'medium',
    });
  }

  /* ---------- 5. memory hogs, proportional to what you have ---------- */
  const memHog = (tick.proc || []).filter((p) => p.mb > totalRamMB * 0.15).sort((a, b) => b.mb - a.mb)[0];
  if (memHog) {
    add({
      id: 'mem_hog', sev: tick.mem.pct > 85 ? S.WARN : S.INFO,
      title: `${memHog.n} is holding ${gb(memHog.mb)} GB — ${Math.round((memHog.mb / totalRamMB) * 100)}% of your RAM`,
      because: `Across ${memHog.count} process${memHog.count > 1 ? 'es' : ''}.`,
      evidence: [`${memHog.mb} MB of ${totalRamMB} MB installed`],
      action: tick.mem.pct > 85 ? 'Restarting it would return the most memory of anything running.' : 'Fine while RAM is comfortable.',
      /* The finding already named the app to restart; without a lever the reader has to go find it
         in a process table and do it by hand. Offered only while RAM is actually tight - a restart
         button on a healthy machine is an invitation to break something for no reason. */
      lever: tick.mem.pct > 85 ? { kind: 'restart-app', name: memHog.n, mb: memHog.mb } : null,
      confidence: 'high',
    });
  }

  /* ---------- 6. thermal ---------- */
  if (tick.gpu && tick.gpu.temp >= 84) {
    add({
      id: 'gpu_hot', sev: tick.gpu.temp >= 90 ? S.WARN : S.INFO,
      title: `GPU at ${tick.gpu.temp} °C`,
      because: `Sustained high temperature causes clock throttling — the card quietly gets slower ` +
               `rather than failing, so it shows up as reduced performance, not an error.`,
      evidence: [`${tick.gpu.temp} °C at ${tick.gpu.util}% utilisation, ${tick.gpu.watts} W`],
      action: 'Check airflow and vents if this persists at idle.',
      confidence: 'high',
    });
  }

  /* ---------- 6b. battery (2026-07-29) — state, not speculation ----------
   * Two separately measurable facts, reported separately:
   *   worn pack: FullChargeCapacity vs DesignCapacity from ACPI — a hardware fact.
   *   stuck low on AC: charge <=10% while on mains and the firmware reports no charge flow.
   *     Software cannot distinguish a charge-limit setting from a dead pack, so the finding
   *     says exactly that instead of guessing. */
  if (tick.pwr && tick.pwr.bat && tick.pwr.designWh && tick.pwr.fullWh) {
    const healthPct = Math.round((tick.pwr.fullWh / tick.pwr.designWh) * 100);
    if (healthPct < 50) {
      add({
        id: 'battery_worn', sev: S.INFO,
        title: `Battery holds ${healthPct}% of its design capacity`,
        because: `The pack was built for ${tick.pwr.designWh} Wh and now fully charges to ` +
                 `${tick.pwr.fullWh} Wh after ${tick.pwr.cycles || '?'} charge cycles. ` +
                 `This is chemistry ageing, not a fault — but runtime estimates scale with it.`,
        evidence: [`${tick.pwr.fullWh} Wh full-charge vs ${tick.pwr.designWh} Wh design · ${tick.pwr.cycles || '?'} cycles (ACPI + powercfg)`],
        action: 'THERM page → Capacity history shows the full decline curve.',
        confidence: 'high',
      });
    }
    if (tick.pwr.ac && !tick.pwr.charging && tick.pwr.pct !== 255 && tick.pwr.pct <= 10) {
      add({
        id: 'battery_stuck', sev: S.WARN,
        title: `Battery at ${tick.pwr.pct}% on AC power and not charging`,
        because: `The firmware reports zero charge flow while plugged in. That is either a ` +
                 `vendor charge-limit/protection mode or a pack that can no longer accept charge — ` +
                 `Windows cannot tell which from software, so this finding won't guess.`,
        evidence: [`${tick.pwr.pct}% · on AC · charging=false · flow ${tick.pwr.rateW ?? '?'} W (ACPI)`],
        action: 'Check the vendor battery utility (e.g. MyASUS "Battery Health Charging") before suspecting the pack.',
        confidence: 'high',
      });
    }
  }

  /* ---------- 6c. MAINTENANCE REMEDIES (2026-07-29) ----------
   * The owner's question, verbatim: "will it notify when something [needs] restarting computer or a
   * certain app or other things like recycle bin, defrag if thats still a thing". These are the
   * remedy-shaped findings. Every one fires on a signal WINDOWS ITSELF maintains, never on a guess,
   * and each carries a machine-readable `lever` so the UI can offer the remedy as a button instead
   * of describing it in prose.
   *
   * Reboot is deliberately STRICT. Windows sets four flags people commonly treat as
   * "restart required" and two of them are present benignly on healthy machines - measured on this
   * one: `WindowsUpdate\Services\Pending` was set and `PendingFileRenameOperations` absent while
   * NEITHER strong flag was, i.e. no restart was actually pending. Firing on the weak flags is
   * exactly the crying-wolf failure rule 1 exists to prevent, so they ride along as evidence and can
   * never trigger on their own. */
  const mt = extra.maint;
  if (mt) {
    const strong = [];
    if (mt.reboot && mt.reboot.cbs) strong.push('Component Based Servicing: RebootPending');
    if (mt.reboot && mt.reboot.wuau) strong.push('Windows Update: RebootRequired');
    const weak = [];
    if (mt.reboot && mt.reboot.wupend) weak.push('WindowsUpdate\\Services\\Pending (weak, often stale)');
    if (mt.reboot && mt.reboot.fileRename) weak.push('PendingFileRenameOperations (weak, common when healthy)');
    const upTxt = mt.uptimeH >= 48 ? `${(mt.uptimeH / 24).toFixed(1)} days` : `${mt.uptimeH} h`;

    if (strong.length) {
      add({
        id: 'reboot_pending', sev: mt.uptimeH >= 72 ? S.WARN : S.INFO,
        title: 'Windows is holding a restart to finish installing updates',
        because: `Servicing has staged files it cannot swap while they are in use. Until the restart ` +
                 `happens the update is half-applied: the component store keeps both copies, which is ` +
                 `also why dismhost and wimserv churn the disk in the background.`,
        evidence: [...strong, ...weak, `up ${upTxt}`],
        action: 'Restart when convenient. Nothing else clears this.',
        lever: { kind: 'reboot' },
        confidence: 'high',
      });
    } else if (mt.uptimeH >= 14 * 24) {
      add({
        id: 'uptime_long', sev: S.INFO,
        title: `Up ${upTxt} without a restart`,
        because: `Not a fault on its own, and long uptime is not a problem to be solved. It is only ` +
                 `worth saying because a restart is the cheapest way to clear accumulated driver and ` +
                 `service state and to apply anything already staged.`,
        evidence: [`last boot ${upTxt} ago`, ...(weak.length ? weak : ['no restart-required flag set'])],
        action: 'Optional. Restart next time it is convenient.',
        lever: { kind: 'reboot' },
        confidence: 'high',
      });
    }

    /* Recycle Bin: reported, never emptied from here. The owner asked for exactly this style to be
     * kept - surface it with the reasoning and let Explorer own the destructive click. */
    if (vol && typeof mt.recycleGB === 'number' && mt.recycleGB >= 1 && vol.pct >= 88) {
      add({
        id: 'recycle_full', sev: vol.pct >= 95 ? S.WARN : S.INFO,
        title: `${mt.recycleGB} GB is sitting in the Recycle Bin while ${volId} is ${(100 - vol.pct).toFixed(1)}% free`,
        because: `Deleted files still occupy their blocks until the bin is emptied, so this space is ` +
                 `already yours - it is just not free yet. Cheapest reclaim available, and the only ` +
                 `one that needs no judgement about what the files are for.`,
        evidence: [`${mt.recycleGB} GB across ${mt.recycleItems} item(s)`, freeOf()],
        action: 'Open the bin, look at what is in it, then empty it yourself. This tool deliberately ' +
                'has no button for it: permanently destroying files belongs behind Explorer own confirmation.',
        lever: { kind: 'recycle-open' },
        confidence: 'high',
      });
    }

    /* "defrag if thats still a thing": on an SSD it is not, and running it would be actively wrong.
     * The equivalent is TRIM (Optimize-Volume -ReTrim), which Windows already schedules weekly. So
     * the finding is about the SCHEDULE having stopped running, and it names the right remedy for the
     * media actually installed. Measured here: Intel Optane H10 with SSD, last optimized 1.1 days
     * ago, result 0 - healthy, so nothing fires. */
    const media = String(mt.mediaType || '').toLowerCase();
    const isSSD = /ssd|nvme|optane/.test(media);
    if (mt.optimizeDaysAgo != null && mt.optimizeDaysAgo > 30) {
      add({
        id: 'disk_optimize', sev: mt.optimizeDaysAgo > 90 ? S.WARN : S.INFO,
        title: `Windows has not optimized C: in ${Math.round(mt.optimizeDaysAgo)} days`,
        because: isSSD
          ? `This is an SSD (${mt.disk || media}), so defragmenting is the wrong operation and would ` +
            `only burn write cycles. What it needs is TRIM: telling the drive which blocks are dead ` +
            `so its garbage collector can reclaim them. Windows schedules that weekly; the schedule ` +
            `has stopped running. On a drive this full, skipped TRIM is a real write-speed cost.`
          : `This is a spinning disk (${mt.disk || media}), so file fragmentation genuinely costs seek ` +
            `time. Windows schedules a defragment weekly; the schedule has stopped running.`,
        evidence: [`media type: ${mt.mediaType || 'unknown'}`,
                   mt.lastOptimize ? `last run ${mt.lastOptimize.replace('T', ' ')}` : 'no recorded run',
                   mt.optimizeResult != null ? `last result code ${mt.optimizeResult}` : 'no result recorded'],
        action: isSSD ? 'Run TRIM once: Optimize-Volume -DriveLetter C -ReTrim. Then check why the scheduled task stopped.'
                      : 'Run Optimize-Volume -DriveLetter C -Defrag, then check the scheduled task.',
        lever: { kind: 'optimize', ssd: isSSD },
        confidence: 'high',
      });
    }
  }

  /* ---------- 7. growth attribution — the question no live monitor can answer ---------- */
  if (extra.growth && extra.growth.grew && extra.growth.grew.length) {
    const g = extra.growth, top = g.grew[0];
    if (top.deltaGB >= 1 && g.spanDays >= 0.02) {
      const perDay = top.deltaGB / Math.max(g.spanDays, 0.04);
      add({
        id: 'growth', sev: S.WARN,
        /* Split on BOTH separators. This was `split('\\')` - the same hard-coded backslash that
           History.growth() had to lose for posix snapshots, still here one file away. On Linux and
           macOS it finds nothing to split, so the "leaf" is the entire path and the title reads as
           a wall of directories instead of a folder name. */
        title: `${top.path.split(/[\\/]/).filter(Boolean).pop()} grew ${top.deltaGB} GB over the last ${g.spanDays < 1 ? Math.round(g.spanDays * 24) + ' hours' : g.spanDays.toFixed(1) + ' days'}`,
        /* The runway clause is CONDITIONAL on knowing the free space. `vol` is now legitimately
           null when no volume was identified, and this rule never guarded it - it read vol.freeGB
           unconditionally and was only safe because the old fallback handed it a zero. The
           attribution ("this folder grew 19 GB") is still worth saying without a runway; the
           runway is not worth inventing. */
        because: `Comparing two snapshots. Net change across the volume was ` +
                 `${g.netGB > 0 ? '+' : ''}${g.netGB} GB. At ${perDay.toFixed(2)} GB/day` +
                 (vol && typeof vol.freeGB === 'number'
                   ? ` this directory alone fills your remaining ${vol.freeGB} GB in ` +
                     `${Math.max(1, Math.round(vol.freeGB / Math.max(perDay, 0.01)))} days.`
                   : `, sustained.`),
        evidence: [top.path, ...g.grew.slice(1, 4).map((r) => `${r.path} ${r.deltaGB > 0 ? '+' : ''}${r.deltaGB} GB`)],
        action: 'Growth tab for the full list.',
        confidence: 'high',
      });
    }
  }

  /* ---------- 8. predictive — fire BEFORE the wall, or say nothing (B3, 2026-07-31) ----------
   * Generalises the growth rule's extrapolation from one directory to the volume itself, over
   * the minute rollups (history.trend). THE GUARD IS THE FEATURE: every gate below exists to
   * stop a noisy trend from producing a confident date. When any gate fails there is no
   * watered-down guess — the plain current-state findings above ARE the honest degraded
   * answer. And a prediction is a claim, so the finding states the model, the fit quality and
   * the interval, never just the date.
   *
   * Fires only while the wall is still AHEAD (pct < 90): past it, disk_low and the spiral own
   * the present tense, and stacking a forecast on top of an alarm is noise. The outcomes
   * ledger's SUPPRESSORS map knows disk_low/spiral absorb this finding, so the handover is
   * recorded as absorption, not as a "cleared" at the exact moment things got worse. */
  const tr = extra.trend && extra.trend.diskFree;
  if (tr && vol && vol.pct > 0 && vol.pct < 90 && vol.sizeGB > 1) {
    const rate = -tr.perDay;                          // GB LOST per day; positive = filling
    const wallGB = vol.sizeGB * 0.10;                 // the 10%-free line disk_low fires at
    const gbAbove = vol.freeGB - wallGB;
    const slopeReal = tr.sePerDay > 0 ? rate / tr.sePerDay >= 3 : rate > 0;   // ≥3σ from noise
    if (rate >= 0.1 && gbAbove > 0 &&
        tr.n >= 24 && tr.spanDays >= 1.5 &&           // at least a real day and a half of hours
        tr.r2 >= 0.5 && slopeReal) {
      const eta = gbAbove / rate;
      const etaLo = gbAbove / (rate + tr.sePerDay);
      const etaHi = tr.sePerDay < rate ? gbAbove / (rate - tr.sePerDay) : null;
      const fd = (d) => d < 1.5 ? '~1 day' : '~' + Math.round(d) + ' days';
      if (eta <= 45) {
        add({
          id: 'disk_fill_ahead', sev: eta <= 7 ? S.WARN : S.INFO,
          title: `C: is on course to cross 10% free in ${fd(eta)} — the line where SSDs start slowing down`,
          because: `Free space has fallen at ${rate.toFixed(2)} GB/day across the measured ` +
                   `${tr.spanDays.toFixed(1)} days. From today's ${vol.freeGB} GB the ` +
                   `${wallGB.toFixed(0)} GB line (10% of ${vol.sizeGB} GB) is ${gbAbove.toFixed(1)} GB away` +
                   (etaHi ? ` — ${fd(etaLo)} to ${fd(etaHi)} inside the fit's ±1σ band` : '') +
                   `. This fires before the wall on purpose: past it every write is slower, and the ` +
                   `cleanup happens under pressure instead of at leisure.`,
          evidence: [
            `${vol.freeGB} GB free of ${vol.sizeGB} GB now (${(100 - vol.pct).toFixed(1)}% free)`,
            `trend −${rate.toFixed(2)} GB/day ± ${tr.sePerDay.toFixed(2)} (1σ) · R² ${tr.r2.toFixed(2)} · ${tr.n} hourly medians over ${tr.spanDays.toFixed(1)} days`,
            `model: straight-line least squares over rollup medians — a big delete or cleanup resets the clock and the fit`,
          ],
          action: 'Growth tab shows what is growing; Reclaim shows what comes back. Cheap now, urgent later.',
          confidence: tr.r2 >= 0.8 ? 'high' : 'medium',
        });
      }
    }
  }

  /* ---------- B6: is it the machine, or is it the job? ----------
   *
   * The two findings this engine could not previously tell apart, and they have OPPOSITE fixes.
   * "Your machine is slow" sends someone to clean their disk; "this job is heavy" tells them the
   * machine is fine and the work grew. Getting it backwards wastes an afternoon in either
   * direction, and every tool in this category conflates them because both look identical from a
   * machine-wide average: high CPU, high I/O, slow.
   *
   * Telling them apart needs the comparison to hold the WORKLOAD fixed and vary only the machine.
   * `workload.js` records, per session of a named program, both what that program cost and what the
   * machine was like while it ran - so "the machine is under more pressure than it normally is
   * WHILE THIS PROGRAM RUNS" is answerable, and it is a different question from "the machine is
   * busy", which is merely a restatement of the complaint.
   *
   * Fired only from a verdict that cleared its own evidence bar (three past sessions minimum, and
   * a percentile that moved by more than run-to-run noise). Anything less says nothing at all,
   * which is correct: a verdict from one prior run distinguishes nothing while sounding exactly as
   * confident as one from twenty. */
  for (const v of (extra.workloads || [])) {
    if (!v || !v.ok || v.call === 'normal') continue;
    const j = v.job && v.job[0], m = v.machine && v.machine[0];
    const num = (x) => (x >= 100 ? Math.round(x) : +x.toFixed(1));

    if (v.call === 'machine') {
      add({
        id: 'wl_machine', sev: S.WARN,
        title: `${v.name} is being slowed by the machine, not by its own work`,
        because: `Held against its own past runs, ${v.name} is asking for no more than usual — but ` +
                 `the machine is under more pressure than it normally is while ${v.name} runs. ` +
                 `That comparison is the point: measured against the machine's all-time average ` +
                 `this would just say "something heavy is running", which is the complaint, not ` +
                 `the cause.`,
        evidence: [
          `${m.label} p95 ${num(m.now)}${m.unit} now vs ${num(m.was)}${m.unit} usual — ${m.ratio}x`,
          `${v.name}'s own demand is within its normal range`,
          `compared against ${v.against}`,
        ],
        action: 'Look at what else is running — the DIAG findings above name it if it is measurable.',
        confidence: v.sessions >= 8 ? 'high' : 'medium',
      });
    } else if (v.call === 'job') {
      add({
        id: 'wl_job', sev: S.INFO,
        title: `This run of ${v.name} is heavier than usual — the machine is fine`,
        because: `${v.name} is asking for more than it normally does, while the machine behaves ` +
                 `as it usually does when ${v.name} runs. Nothing here needs fixing on the ` +
                 `computer; the work itself grew.`,
        evidence: [
          `${j.label} p95 ${num(j.now)}${j.unit} this run vs ${num(j.was)}${j.unit} usual — ${j.ratio}x`,
          `machine contention is within its normal range for this program`,
          `compared against ${v.against}`,
        ],
        action: 'Nothing to fix here. Worth knowing if you expected this run to be the same size as the last.',
        confidence: v.sessions >= 8 ? 'high' : 'medium',
      });
    } else if (v.call === 'both') {
      add({
        id: 'wl_both', sev: S.WARN,
        title: `A heavier run of ${v.name}, on a machine already under more pressure than usual`,
        because: `Both moved, and they are separate problems with separate fixes — the run got ` +
                 `bigger AND the machine is more contended than it normally is while ${v.name} ` +
                 `runs. Treating this as one problem fixes at most half of it.`,
        evidence: [
          `${v.name}: ${j.label} p95 ${num(j.now)}${j.unit} vs ${num(j.was)}${j.unit} usual — ${j.ratio}x`,
          `machine: ${m.label} p95 ${num(m.now)}${m.unit} vs ${num(m.was)}${m.unit} usual — ${m.ratio}x`,
          `compared against ${v.against}`,
        ],
        action: 'Clear the machine-side pressure first — it is the half you can act on.',
        confidence: v.sessions >= 8 ? 'high' : 'medium',
      });
    }
  }

  /* ---------- B13: the drive is telling you it is failing ----------
   * The most valuable sentence a monitor can say, and the one with the shortest useful window.
   * Every other finding here is about performance; this one is about whether the data survives the
   * week. It fires on the drive's OWN verdict rather than on an inference, which is why it is
   * allowed to be this loud on this little evidence. */
  const hw = extra.hw;
  if (hw && Array.isArray(hw.disks)) {
    for (const d of hw.disks) {
      const sick = d.health && d.health !== 'Healthy';
      const predicted = (hw.failurePredict || []).some((x) => x.predictFailure);
      if (sick || predicted) {
        add({
          id: 'drive_health', sev: S.CRIT,
          title: `${d.name || 'A drive'} reports its own health as ${sick ? d.health : 'failing'}`,
          because: `This is not an inference from performance — it is the drive's own firmware ` +
                   `reporting through SMART. Back up now, before anything else on this page. A ` +
                   `drive that has begun reallocating sectors can stay usable for months or fail ` +
                   `this afternoon, and nothing here can tell you which.`,
          evidence: [
            `health ${d.health}${d.opState ? ' · ' + d.opState : ''}`,
            `${d.media || 'disk'}${d.sizeGB ? ' · ' + d.sizeGB + ' GB' : ''}${d.bus ? ' · ' + d.bus : ''}`,
            d.wearPct != null ? `wear ${d.wearPct}%` : 'wear and error counts need elevation to read',
            predicted ? 'the driver is predicting failure' : 'no failure prediction flag set',
          ],
          action: 'Copy anything irreplaceable off this drive today. Then replace it.',
          confidence: 'high',
        });
      } else if (d.wearPct != null && d.wearPct >= 80) {
        add({
          id: 'drive_wear', sev: d.wearPct >= 90 ? S.WARN : S.INFO,
          title: `${d.name || 'The drive'} has used ${d.wearPct}% of its rated write endurance`,
          because: `SSDs wear by writing. At this level the drive still reports healthy and will ` +
                   `keep working, but the remaining life is a fraction of what it was — worth ` +
                   `knowing before it becomes urgent rather than after.`,
          evidence: [`wear ${d.wearPct}%`,
                     d.powerOnHours != null ? `${d.powerOnHours} power-on hours` : 'power-on hours unavailable',
                     d.tempC != null ? `${d.tempC} °C` : 'temperature unavailable'],
          action: 'Nothing urgent. Plan a replacement rather than react to one.',
          confidence: 'high',
        });
      }
    }
  }

  /* ---------- B14: the machine is spending its time on interrupts ----------
   * Reported as a TIME SHARE, which is what the counters actually measure. Worst-case DPC latency
   * in microseconds - the number LatencyMon prints and the one people quote - needs an ETW kernel
   * session or a driver, and is not available here. Saying "DPC time is 12% of the CPU" is true;
   * printing a microsecond figure derived from it would not be, and this engine would rather be
   * quiet than confidently wrong about a unit. */
  if (hw && hw.irq && typeof hw.irq.dpcPct === 'number') {
    const load = hw.irq.dpcPct + (hw.irq.intPct || 0);
    if (load >= 10) {
      add({
        id: 'irq_load', sev: load >= 20 ? S.WARN : S.INFO,
        title: `${load.toFixed(1)}% of CPU time is going to interrupts and deferred driver work`,
        because: `That work happens at higher priority than anything you started, so it is felt ` +
                 `as stutter and dropped audio rather than as a busy CPU. It is almost always one ` +
                 `driver — commonly network, storage or a virtualisation filter.`,
        evidence: [
          `DPC ${hw.irq.dpcPct.toFixed(2)}% · interrupts ${(hw.irq.intPct || 0).toFixed(2)}%`,
          'time share, not latency — worst-case DPC latency needs a kernel trace and is not measured here',
        ],
        action: 'Update network and storage drivers first; they account for most of this.',
        confidence: 'medium',
      });
    }
  }

  f.sort((a, b) => b.sev - a.sev);
  const crit = f.filter((x) => x.sev === S.CRIT);
  const summary = !f.length
    ? 'Nothing wrong that I can measure.'
    : (crit[0] || f[0]).title;

  const WARMUP = 90;                       // seconds of wall clock, not samples
  const span = hist.spanSec();
  return {
    ready: span >= WARMUP,
    warmupSec: Math.max(0, Math.round(WARMUP - span)),
    historySec: Math.round(span),
    sampleRateHz: hist.ring.length > 1 ? +(hist.ring.length / Math.max(span, 1)).toFixed(2) : 0,
    summary,
    counts: { critical: crit.length, warning: f.filter((x) => x.sev === S.WARN).length, note: f.filter((x) => x.sev === S.INFO).length },
    findings: f.map((x) => ({ ...x, sevName: NAME[x.sev], short: shortTitle(x.title) })),
  };
}

module.exports = { diagnose };
