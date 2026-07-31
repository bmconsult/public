/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - macOS COLLECTOR PLUG.
 *
 * ############################################################################################
 * ##  UNVERIFIED. There is no Mac on the bench this was written on. Every field offset and   ##
 * ##  every output format below is taken from documented tool behaviour, NOT from observed   ##
 * ##  output. Nothing here has ever executed on real hardware.                               ##
 * ##                                                                                         ##
 * ##  caps.js declares this platform unverified and the panel says so on screen. The first   ##
 * ##  person to run it should check each number against Activity Monitor, fix what is wrong, ##
 * ##  and flip `verified` in caps.js. Do not remove this banner before that happens.         ##
 * ############################################################################################
 *
 * DESIGN. macOS has no /proc, so unlike the Linux plug this one has to shell out. Two decisions
 * follow from that, and both are about not paying fork/exec 3+ times a second:
 *
 *   1. ONE LONG-LIVED `iostat -w 1` CHILD supplies CPU percentages, disk throughput and load
 *      average as a continuous 1 Hz stream. This mirrors the Windows design for the same reason:
 *      a process spawned per sample spends more time booting than measuring. It also sidesteps the
 *      `top -l 1` trap, where the FIRST sample is an average since boot rather than an interval,
 *      so a naive one-shot reports the machine's whole uptime as if it were the last second.
 *
 *   2. EVERYTHING ELSE IS ONE COMBINED SHELL CALL PER TICK, not three. vm_stat, ps and netstat are
 *      run inside a single `sh -c` with delimiters between their outputs, so the per-second cost is
 *      one fork instead of three.
 *
 * WHAT IS DELIBERATELY ABSENT. No GPU utilisation (needs powermetrics, which requires root) and no
 * per-process disk I/O (needs fs_usage, root, and on some releases SIP disabled). Those are declared
 * false in caps.js and the panel omits the features rather than drawing empty gauges.
 */

const { spawn, execFile } = require('child_process');
const os = require('os');

function realSh(cmd, cb) {
  execFile('/bin/sh', ['-c', cmd], { maxBuffer: 8 << 20, timeout: 5000 }, (err, out) => cb(err ? '' : out));
}

/* THE INJECTION SEAM. Everything this collector knows about the machine arrives as text through
 * exactly two doors: `sh()` for the one-shots and `spawnIostat()` for the streaming child. Making
 * both replaceable means the ENTIRE collector - the memory arithmetic, the ps aggregation, the
 * netstat de-duplication, the mAh-to-watt-hour conversion, the rate differencing between ticks -
 * can be driven from fixture text on a machine that is not a Mac.
 *
 * BE PRECISE ABOUT WHAT THAT BUYS. It does NOT verify that the fixtures match what macOS really
 * emits; only a Mac can settle that. It verifies everything DOWNSTREAM of the format assumption,
 * which is most of this file and all of the arithmetic. A green suite here means "given that output,
 * the maths is right" - a genuinely useful claim, and a strictly weaker one than "it works".
 *
 * The same seam is how a real capture becomes a real test: drop genuine `vm_stat` output in place of
 * the fixture and the identical suite becomes verification. See tools/capture-macos-fixtures.sh. */
let sh = realSh;
let spawnIostat = () => spawn('iostat', ['-w', '1']);

/* ---------------- per-core CPU ----------------
 * os.cpus() carries per-core cumulative tick counters on Darwin - libuv fills them from
 * host_processor_info - so this needs no subprocess and no native addon. Differenced between
 * ticks, exactly as collect/linux.js differences /proc/stat.
 *
 * Two deliberate refusals to guess:
 *   - The FIRST tick returns [] rather than a reading. The counters are cumulative since boot, so
 *     a first sample would report the machine's average since power-on as though it were now.
 *   - A core whose counters did not advance returns null, not 0. No elapsed ticks means the load
 *     is unknowable for that interval; 0 would claim it was idle. */
let prevCores = null;
/* Previous per-NIC byte totals, keyed by interface, for rate differencing. Module scope for the
   same reason prevCores is: the tick is a callback and the sample before it has to outlive it. */
let prevNics = new Map();

function perCore() {
  const now = os.cpus().map(({ times: t }) => ({
    idle: t.idle,
    total: t.user + t.nice + t.sys + t.idle + t.irq,
  }));
  const prev = prevCores;
  prevCores = now;
  /* A core-count change mid-run (a VM resizing, a CPU offlined) makes the paired difference
     meaningless - drop the sample rather than difference mismatched cores against each other. */
  if (!prev || prev.length !== now.length) return [];
  return now.map((c, i) => {
    const dTotal = c.total - prev[i].total;
    const dIdle = c.idle - prev[i].idle;
    if (!(dTotal > 0)) return null;
    return Math.max(0, Math.min(100, Math.round(((dTotal - dIdle) / dTotal) * 100)));
  });
}
function _inject(fakeSh, fakeIostat) { sh = fakeSh || realSh; if (fakeIostat) spawnIostat = fakeIostat; }

/* ---------------- vm_stat ----------------
 * Output is "Pages free:  123456." - note the trailing period, which breaks parseInt if the line is
 * split on whitespace and the last token taken verbatim. Page size is announced in the header line
 * and is 16384 on Apple Silicon, 4096 on Intel; hard-coding either is wrong on half the fleet. */
function parseVmStat(text) {
  const out = {};
  const ps = /page size of (\d+) bytes/.exec(text);
  out.pageSize = ps ? +ps[1] : 4096;
  for (const line of text.split('\n')) {
    const x = /^"?([A-Za-z][^:]*?)"?:\s+(\d+)\.?\s*$/.exec(line.trim());
    /* Some vm_stat rows quote their key ("Translation faults"). The closing quote is not a colon, so
       a greedy [^:]* swallows it into the key and every lookup of that name silently misses. Lazy
       match plus an explicit strip; the trailing period on the VALUE is handled by the \.? above. */
    if (x) out[x[1].replace(/^"|"$/g, '').trim()] = +x[2];
  }
  return out;
}

/* ---------------- iostat stream ----------------
 * Columns under the `cpu` group are us / sy / id. Disk columns repeat per device as KB/t, tps, MB/s.
 * The header is reprinted periodically, so any line that is not numeric is skipped rather than
 * parsed into NaN. */
function parseIostatLine(line, diskCount) {
  const n = line.trim().split(/\s+/).map(Number);
  if (!n.length || n.some((v) => !Number.isFinite(v))) return null;
  const diskCols = diskCount * 3;
  if (n.length < diskCols + 3) return null;
  let mbs = 0;
  for (let i = 0; i < diskCount; i++) mbs += n[i * 3 + 2] || 0;
  const us = n[diskCols], sy = n[diskCols + 1], id = n[diskCols + 2];
  return { us, sy, id, busy: Math.max(0, Math.min(100, 100 - id)), mbs };
}

function start(root, { onStatic, onTick, onError }) {
  let stopped = false, timer = null, tick = 0;
  let cpuNow = null, diskMBs = 0, diskCount = 1;
  /* NULL until pmset actually answers. `{bat:false}` as an initial value tells a MacBook owner
     their laptop has no battery for the first second or two of every launch. */
  let prevNet = null, prevPageins = null, prevProc = null, prevPwr = null;
  let prevAt = process.hrtime.bigint();
  let volCache = null;
  /* ONE SOURCE OF TRUTH for installed RAM. The static event reported hw.memsize while the tick used
     os.totalmem(); on ordinary hardware those agree, so the split was invisible - but under a memory
     limit, a VM or a container they diverge, and the panel would then show a machine whose total RAM
     changed depending on which line you read. Captured once from sysctl, used by both. */
  let ramMB = Math.round(os.totalmem() / 1048576);

  /* -------- static -------- */
  sh('sysctl -n machdep.cpu.brand_string hw.physicalcpu hw.ncpu hw.memsize; sw_vers -productVersion',
    (out) => {
      const L = out.trim().split('\n');
      if (+L[3]) ramMB = Math.round(+L[3] / 1048576);
      onStatic({
        t: 'static',
        cpu: (L[0] || os.cpus()[0]?.model || 'unknown').trim(),
        cores: +L[1] || os.cpus().length,
        threads: +L[2] || os.cpus().length,
        ramMB,
        gpu: [],                      // no unprivileged GPU enumeration worth trusting
        nvidia: false,
        host: os.hostname(),
        os: `macOS ${(L[4] || '').trim()} (Darwin ${os.release()})`,
      });
    });

  /* -------- long-lived iostat -------- */
  let ios = null;
  function bootIostat() {
    if (stopped) return;
    ios = spawnIostat();
    let buf = '';
    ios.stdout.on('data', (c) => {
      buf += c.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        /* The device header names every disk; count them so the column maths stays right on a Mac
           with an external drive attached. */
        if (/disk\d/.test(line) && !/\d\.\d/.test(line)) {
          diskCount = (line.match(/disk\d+/g) || ['disk0']).length;
          continue;
        }
        if (/[A-Za-z]/.test(line)) continue;          // any other header row
        const r = parseIostatLine(line, diskCount);
        if (r) { cpuNow = r; diskMBs = r.mbs; }
      }
    });
    ios.on('error', () => onError('[metrics/darwin] iostat unavailable'));
    ios.on('exit', () => { if (!stopped) setTimeout(bootIostat, 2000); });
  }
  bootIostat();

  /* -------- battery, polled slowly -------- */
  function pollPower() {
    sh('pmset -g batt; echo "---IOREG---"; ioreg -rn AppleSmartBattery 2>/dev/null | ' +
       'grep -E "\\"(CycleCount|DesignCapacity|AppleRawMaxCapacity|AppleRawCurrentCapacity|Voltage|InstantAmperage)\\"" || true',
      (out) => {
        const [battTxt, ioregTxt = ''] = out.split('---IOREG---');
        if (!/InternalBattery/.test(battTxt)) { prevPwr = { bat: false }; return; }
        const pct = (/(\d+)%/.exec(battTxt) || [])[1];
        const state = /discharging/i.test(battTxt) ? 'Discharging'
                    : /charging/i.test(battTxt) ? 'Charging' : 'Full';
        const num = (k) => { const x = new RegExp(`"${k}"\\s*=\\s*(-?\\d+)`).exec(ioregTxt); return x ? +x[1] : null; };
        const mV = num('Voltage'), mA = num('InstantAmperage');
        const volts = mV ? mV / 1000 : null;
        /* IOKit reports capacities in mAh, so watt-hours need the pack voltage. Without it the honest
           answer is null, not a made-up conversion at an assumed 11.4 V. */
        const toWh = (mAh) => (mAh == null || volts == null ? null : Math.round(mAh * volts / 1000 * 10) / 10);
        let rateW = (mA != null && volts != null) ? Math.round(Math.abs(mA) * volts / 1000 * 10) / 10 : null;
        if (rateW != null) rateW = state === 'Discharging' ? -rateW : rateW;
        const remMin = (/(\d+):(\d+) remaining/.exec(battTxt) || []);
        prevPwr = {
          bat: true,
          pct: pct == null ? 255 : +pct,
          ac: /AC Power/.test(battTxt),
          charging: state === 'Charging',
          discharging: state === 'Discharging',
          rateW,
          remWh: toWh(num('AppleRawCurrentCapacity')),
          fullWh: toWh(num('AppleRawMaxCapacity')),
          designWh: toWh(num('DesignCapacity')),
          cycles: num('CycleCount') || 0,
          chem: 'Li-ion',
          lifeMin: remMin.length ? (+remMin[1] * 60 + +remMin[2]) : null,
        };
      });
  }
  pollPower();

  function pollVolumes() {
    /* -k for kilobyte units so the numbers are machine-readable, and the mount point is everything
       after the 9th column because a volume name may legally contain spaces. */
    /* PARSED BY SHAPE, NOT BY FIELD INDEX. Two things break naive splitting of df output, and the
       simulation caught both:
         1. The FILESYSTEM column can contain spaces ("map auto_home"), which shifts every field
            counted from the left.
         2. Locating the mount with line.indexOf(field) finds the FIRST occurrence. For the root
            volume the mount is "/", and the first "/" in the line is inside "/dev/disk3s1s1" at
            index 0 - so the mount came back as the entire line, which then matched the ^/dev
            exclusion and DROPPED THE ROOT VOLUME ENTIRELY. The main disk, silently missing.
       Anchoring on the numeric block instead is immune to both: a lazy filesystem group, the three
       size columns, capacity, the optional inode columns, and the mount as the rest of the line. */
    sh("df -kl | tail -n +2", (out) => {
      const v = [];
      const ROW = /^(.*?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(?:[\d-]+\s+[\d-]+\s+[\d-]+%\s+)?(\/.*)$/;
      for (const line of out.split('\n')) {
        const m = ROW.exec(line.trim());
        if (!m) continue;
        const sizeKB = +m[2], availKB = +m[4];
        const mnt = m[6].trim();
        /* `Data` joins the exclusion list: on modern macOS / and /System/Volumes/Data are the SAME
           APFS container and report identical size and free space, so listing both shows the user
           two copies of one disk. Root is the canonical row. */
        if (!sizeKB || /^\/(dev|System\/Volumes\/(Data|VM|Preboot|Update|xarts|iSCPreboot|Hardware))/.test(mnt)) continue;
        const size = sizeKB * 1024, free = availKB * 1024;
        v.push({
          id: mnt, label: m[1].replace('/dev/', ''),
          sizeGB: Math.round(size / 1073741824 * 10) / 10,
          freeGB: Math.round(free / 1073741824 * 10) / 10,
          pct: Math.round(((size - free) / size) * 1000) / 10,
        });
      }
      if (v.length) volCache = v;
    });
  }
  pollVolumes();

  /* -------- GPU, without root --------
   * IOAccelerator publishes a PerformanceStatistics dictionary containing "Device Utilization %".
   * It is where Activity Monitor's GPU history comes from, both the Apple Silicon AGX driver and
   * the Intel/AMD ones expose it, and reading it needs no privileges - so this does not require
   * powermetrics, which does.
   *
   * Polled every ~5 s, not per tick: ioreg walks the entire IO registry and is far too expensive
   * for a 1 Hz loop. Same reasoning that keeps the battery poll at 15 ticks.
   *
   * THE KEY NAMES HERE ARE UNVERIFIED. They come from documentation, which is exactly the way this
   * collector acquired its previous mistakes. CI captures raw ioreg output as an artifact on every
   * run so this parser gets corrected against real bytes; until it agrees with a real Mac, gpu
   * stays false in caps.js and this cache stays unread by the manifest. A missing key yields null,
   * never 0 - a GPU reported idle while it renders is the exact failure caps.js was built over. */
  let gpuCache = null;
  function pollGpu() {
    sh('ioreg -rc IOAccelerator 2>/dev/null | grep -E "Device Utilization|IOClass" | head -40', (out) => {
      if (stopped) return;
      const utils = [...String(out || '').matchAll(/"Device Utilization %"\s*=\s*(\d+)/g)].map((m) => +m[1]);
      if (!utils.length) { gpuCache = null; return; }
      const ads = utils.map((u, i) => ({ id: 'gpu' + i, name: null, util: u }));
      gpuCache = { ads, top: ads.reduce((a, b) => (b.util > a.util ? b : a)), max: Math.max(...utils) };
    });
  }

  /* -------- what is holding this machine awake --------
   * `pmset -g assertions` names the PROCESS preventing idle or display sleep, by pid, with no
   * admin rights. Windows needs an elevated `powercfg /requests` for the same answer, so this is
   * one of the places the Mac build can say something the Windows one cannot.
   * Thirty-second cadence: sleep blockers are held for minutes or hours, not milliseconds. */
  let wakeCache = null;
  function pollAssertions() {
    sh('pmset -g assertions 2>/dev/null | head -40', (out) => {
      if (stopped) return;
      const txt = String(out || '');
      if (!txt.trim()) { wakeCache = null; return; }
      const holders = [];
      for (const line of txt.split('\n')) {
        /* pid 123(Some App): [0x...] 00:12:34 PreventUserIdleSystemSleep named: "..." */
        const m = /pid\s+(\d+)\(([^)]+)\):.*?(PreventUserIdleSystemSleep|PreventUserIdleDisplaySleep|PreventSystemSleep)/.exec(line);
        if (m) holders.push({ pid: +m[1], name: m[2], kind: m[3] });
      }
      wakeCache = holders.length ? holders.slice(0, 8) : [];
    });
  }

  /* -------- the tick -------- */
  function sample() {
    if (stopped) return;
    tick++;
    if (tick % 15 === 1) pollPower();
    if (tick % 10 === 1) pollVolumes();
    if (tick % 5 === 1) pollGpu();
    if (tick % 30 === 1) pollAssertions();

    /* ONE fork for all three. See the header note. */
    /* Still ONE fork. sysctl is appended to the same command rather than forked separately - the
       header's whole argument is that a monitor sampling once a second cannot afford a process per
       metric, and that argument does not stop applying because a new metric arrived. */
    sh('vm_stat; echo "---PS---"; ps -Ao pid,rss,%cpu,comm; echo "---NET---"; netstat -ib; '
       + 'echo "---SYS---"; sysctl -n vm.swapusage kern.memorystatus_vm_pressure_level 2>/dev/null', (out) => {
      if (stopped) return;
      try {
        const now = process.hrtime.bigint();
        const elapsed = Number(now - prevAt) / 1e9;
        prevAt = now;

        const [vmTxt = '', psTxt = '', netTxt = '', sysTxt = ''] = out.split(/---PS---|---NET---|---SYS---/);

        /* COMMIT CHARGE, honestly approximated. macOS has no such counter - the kernel does not
           promise backing store the way Windows does, so there is nothing to report as its twin.
           The nearest true statement is "resident used plus what has been pushed to swap", i.e.
           how much memory this machine has actually had to find. caps.js marks it 'partial' and
           says so; it is not filed as the Windows number under a shared name.
           Null when sysctl says nothing, because a machine with swap disabled is not a machine
           with zero swap pressure - it is a machine that cannot tell us. */
        const swapLine = (sysTxt || '').split('\n').find((l) => /used\s*=/.test(l)) || '';
        const swapM = /used\s*=\s*([\d.]+)([MGK])/i.exec(swapLine);
        const swapUsedMB = swapM
          ? +swapM[1] * ({ K: 1 / 1024, M: 1, G: 1024 }[swapM[2].toUpperCase()] || 1)
          : null;
        /* Apple's own memory verdict: 1 normal, 2 warning, 4 critical. This is the number Activity
           Monitor's pressure graph is drawn from, and it is a better answer to "does this machine
           need more RAM" than any percentage - which is an argument this product already makes
           about hard faults on Windows. */
        const pressureRaw = (sysTxt || '').split('\n').map((l) => l.trim()).filter(Boolean).pop();
        const pressure = /^\d+$/.test(pressureRaw || '') ? +pressureRaw : null;
        const vm = parseVmStat(vmTxt);
        const pg = vm.pageSize;
        const mb = (pages) => ((pages || 0) * pg) / 1048576;

        /* macOS "used" excludes the purgeable and file-backed pages the kernel will hand back on
           demand, the same reasoning as MemAvailable on Linux. Compressed pages ARE used - they are
           real resident data, just squeezed. */
        const totalMB = ramMB;
        const freeish = mb(vm['Pages free']) + mb(vm['Pages purgeable']) + mb(vm['File-backed pages']);
        const usedMB = Math.max(0, Math.round(totalMB - freeish));

        /* Pageins is cumulative since boot; differencing it gives the same quantity the Windows
           hard-fault counter reports. */
        const pageins = vm['Pageins'] ?? null;
        const pagesSec = (pageins != null && prevPageins != null)
          ? Math.round(Math.max(0, pageins - prevPageins) / elapsed) : null;

        /* ps %cpu needs NO delta - the kernel maintains it - but it is a decaying average rather
           than an instantaneous reading, and it is expressed relative to ONE core. Both differences
           from the Windows and Linux plugs are handled: the scale is corrected where procOut is
           built below, and caps.js marks proc.cpu 'partial' for the averaging.
           (An earlier version of this comment claimed ps was "already normalised per core", which is
           the opposite of true and sat twenty lines above the code correcting for it.) */
        const agg = new Map();
        for (const line of psTxt.split('\n').slice(1)) {
          const x = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line);
          if (!x) continue;
          const name = (x[4].split('/').pop() || x[4]).trim();
          let a = agg.get(name);
          if (!a) { a = { n: name, mb: 0, cpu: 0, count: 0, pids: [] }; agg.set(name, a); }
          a.mb += +x[2] / 1024;                 // ps reports RSS in kB
          a.cpu += +x[3];
          a.count++;
          if (a.pids.length < 40) a.pids.push(+x[1]);
        }
        /* SCALE CORRECTION. macOS `ps` reports %cpu relative to ONE core, so a saturated
           multi-threaded process reads up to N x 100. Windows (metrics.ps1) and Linux both divide
           by logical-CPU count, so leaving this raw would make Mac process CPU run up to 10x hotter
           than the same process on the other two platforms - and the group sum below compounds it.
           Divided here so one number means one thing across all three plugs.
           UNVERIFIED on hardware: this rests on ps's documented semantics, not observed output. */
        const threads = os.cpus().length || 1;
        const procOut = [...agg.values()].map((a) => ({
          n: a.n, mb: Math.round(a.mb), cpu: Math.round((a.cpu / threads) * 10) / 10,
          ioMBs: null, rMBs: null, wMBs: null, pf: null, count: a.count, pids: a.pids,
        })).sort((x, y) => y.mb - x.mb);

        /* netstat -ib repeats each interface once per address family; the first row per interface
           carries the byte totals, so later duplicates are skipped rather than summed. */
        let rx = 0, tx = 0; const seen = new Set();
        /* PER-INTERFACE, kept rather than summed away. This loop already visited every NIC and
           de-duplicated it; the totals were the only thing that survived. Holding the rows costs
           nothing and is the whole of net.perInterface - "not ported" was never true here, the
           data was being parsed and discarded on the same line. */
        const nics = [];
        for (const line of netTxt.split('\n').slice(1)) {
          const p = line.trim().split(/\s+/);
          if (p.length < 10) continue;
          const nic = p[0];
          if (seen.has(nic) || nic === 'lo0' || /^(gif|stf|utun|awdl|llw|bridge)/.test(nic)) continue;
          const ib = +p[p.length - 5], ob = +p[p.length - 2];
          if (!Number.isFinite(ib) || !Number.isFinite(ob)) continue;
          seen.add(nic); rx += ib; tx += ob;
          nics.push({ id: nic, rxBytes: ib, txBytes: ob });
        }
        /* Rates per interface, differenced against the previous tick. A NIC that appeared since the
           last tick (VPN up, cable in) has no previous sample, so its rate is null rather than a
           spike computed from a zero baseline - the same rule the totals already follow. */
        const nicOut = nics.map((n) => {
          const p = prevNics.get(n.id);
          const rate = (a, b) => (p && elapsed > 0 ? Math.max(0, (a - b)) / 1048576 / elapsed : null);
          return {
            id: n.id,
            rxMBs: p ? Math.round(rate(n.rxBytes, p.rxBytes) * 100) / 100 : null,
            txMBs: p ? Math.round(rate(n.txBytes, p.txBytes) * 100) / 100 : null,
          };
        });
        prevNics = new Map(nics.map((n) => [n.id, n]));

        /* NULL, not 0. If iostat is missing, was killed, or has not emitted its first data line,
           a 0 here reports a perfectly idle CPU forever - confidently, with no gate to hide it.
           That is the precise failure the header of caps.js recounts from the nvidia-smi episode. */
        const cpuPct = cpuNow ? cpuNow.busy : null;
        onTick({
          t: 'tick',
          ts: Date.now(),
          /* PER-CORE, and it never needed a native addon.
             This said "no per-core breakdown without a native addon" while the same file called
             os.cpus() three times to count cores and never once read .times. Node IS the native
             addon: libuv implements os.cpus() on Darwin via host_processor_info, so every core's
             user/nice/sys/idle tick counters are already in this process. Differencing them between
             ticks is the identical algorithm collect/linux.js runs against /proc/stat.
             The assumption cost this platform a whole capability. It was never a platform limit -
             it was a comment nobody re-checked. */
          cpu: { total: cpuPct, cores: perCore() },
          mem: {
            usedMB, freeMB: totalMB - usedMB, totalMB,
            committedMB: swapUsedMB == null ? null : Math.round(usedMB + swapUsedMB),
            swapUsedMB: swapUsedMB == null ? null : Math.round(swapUsedMB),
            /* 1 normal · 2 warning · 4 critical, straight from the kernel. Null where unavailable. */
            pressure,
            pct: Math.round((usedMB / totalMB) * 1000) / 10,
            cacheMB: Math.round(mb(vm['File-backed pages'])),
            pagesSec,
          },
          disk: {
            /* null, not [] - an empty array renders as "this machine has no disks". */
            vols: volCache,
            /* iostat gives combined throughput only; read and write are not split, and busy time is
               not exposed at all without ioreg spelunking. Nulls, not zeros. */
            io: { readMBs: null, writeMBs: null, combinedMBs: Math.round(diskMBs * 100) / 100,
                  busyPct: null, queue: null },
          },
          /* First tick has nothing to difference against, so the honest answer is null - not 0,
             which would read as a genuinely idle network. The Linux plug suppresses its whole
             first tick for the same reason; this one cannot, because iostat drives the cadence. */
          net: {
            rxMBs: prevNet ? Math.round(Math.max(0, rx - prevNet.rx) / 1048576 / elapsed * 1000) / 1000 : null,
            txMBs: prevNet ? Math.round(Math.max(0, tx - prevNet.tx) / 1048576 / elapsed * 1000) / 1000 : null,
            /* Per-interface rates. Empty array only before the first difference exists; after that
               a machine with no NICs genuinely has none. */
            ifaces: nicOut,
          },
          proc: procOut.slice(0, 16),
          /* Null until ioreg has actually answered - the panel's three-state rule: a value, a real
             zero, or "this host cannot measure that". Never a placeholder zero. */
          gpu: gpuCache
            ? { util: gpuCache.max, memUsed: null, memTotal: null, temp: null, watts: null }
            : null,
          gpus: gpuCache,
          /* Which process is keeping this Mac awake. Null = not polled yet; [] = nothing is. */
          wake: wakeCache,
          pwr: prevPwr,
          /* NOT zeros. The FOOTPRINT page says "these numbers include the cost of producing this
             page"; emitting 0.00% cpu / 0 MB there is a measured-looking lie. Null degrades to
             "not measured on this platform". */
          self: null,
          up: Math.round((os.uptime() / 3600) * 10) / 10,
        });

        prevNet = { rx, tx };
        prevPageins = pageins;
        prevProc = agg;
      } catch (e) {
        onError('[metrics/darwin] ' + e.message);
      }
    });
  }

  timer = setInterval(sample, 1000);
  sample();
  return {
    stop() { stopped = true; clearInterval(timer); try { ios && ios.kill(); } catch {} },
  };
}

module.exports = { start, _inject, _internal: { parseVmStat, parseIostatLine } };
