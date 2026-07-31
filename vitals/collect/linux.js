/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - LINUX COLLECTOR PLUG. Direct /proc and /sys reads, no subprocesses.
 *
 * WHY NO SHELLING OUT. The Windows collector pays ~250 ms to boot PowerShell, which is why it is a
 * single long-lived child. Linux has no such tax and needs no such child: the kernel publishes
 * everything as small text files, and a whole tick is a few dozen reads of a few kB each. Spawning
 * `top` or `ps` once a second would be strictly slower AND less precise, because those tools sample
 * and round before we ever see the number.
 *
 * THE COUNTERS ARE CUMULATIVE, exactly like the Windows perf counters, so the differencing logic is
 * the same shape: keep the previous raw reading, subtract, divide by measured wall-clock elapsed.
 * Never divide by the interval you ASKED for - a busy machine will not deliver it, and dividing by
 * the nominal 1000 ms while 1400 ms actually passed silently inflates every rate by 40%.
 *
 * FIELD OFFSETS ARE THE DANGEROUS PART of this file, so all of them were read off genuine kernel
 * output captured from Ubuntu 22.04 (kernel 6.6.87.2) rather than from memory. /proc/diskstats in
 * particular grew four discard fields in 4.18 and two flush fields in 5.5, so any offset counted
 * from the END of the line is a bug waiting for a kernel upgrade. Everything here counts from the
 * front, where the layout has been stable since 2.6.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SECTOR = 512;                    // /proc/diskstats speaks in 512-byte sectors, always
const HZ = 100;                        // USER_HZ: utime/stime units. 100 on every mainstream build.

function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
function readInt(p) { const t = read(p).trim(); const n = parseInt(t, 10); return Number.isFinite(n) ? n : null; }
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

/* ---------------- CPU ----------------
 * /proc/stat: cpu user nice system idle iowait irq softirq steal guest guest_nice
 * Busy is everything except idle and iowait. iowait counts as NOT busy on purpose: the core is
 * parked waiting on the disk, and folding it into CPU% is how you end up telling someone their
 * processor is saturated when the actual problem is their drive. */
function cpuStat() {
  const out = { total: null, cores: [] };
  for (const line of read('/proc/stat').split('\n')) {
    if (!line.startsWith('cpu')) break;
    const p = line.trim().split(/\s+/);
    const label = p[0];
    const n = p.slice(1).map(Number);
    const idle = (n[3] || 0) + (n[4] || 0);
    /* slice(0,8), NOT (0,10). The kernel already folds guest into user and guest_nice into nice
       (account_guest_time), so summing all ten counts virtualisation time twice - in the busy
       numerator and again in the total. Harmless on a laptop, silently inflates CPU% on any host
       running VMs, which is exactly the machine someone installs a monitor to understand. */
    const busy = n.slice(0, 8).reduce((a, b) => a + (b || 0), 0) - idle;
    const rec = { idle, busy };
    if (label === 'cpu') out.total = rec; else out.cores.push(rec);
  }
  return out;
}

function pctOf(cur, prev) {
  if (!cur || !prev) return 0;
  const dB = cur.busy - prev.busy, dI = cur.idle - prev.idle, dT = dB + dI;
  if (dT <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((dB / dT) * 1000) / 10));
}

/* ---------------- memory ---------------- */
function meminfo() {
  const m = {};
  for (const line of read('/proc/meminfo').split('\n')) {
    const x = /^(\w+):\s+(\d+)/.exec(line);
    if (x) m[x[1]] = +x[2];            // all values are kB
  }
  return m;
}

/* pgmajfault is the true analogue of the Windows "Pages/sec" hard-fault counter: a page that had to
   come back from DISK because it was not resident. Minor faults are just first-touch on memory the
   process already owns and mean nothing about pressure - counting them would make every healthy
   machine look like it was thrashing. */
function majFaults() {
  const x = /^pgmajfault (\d+)/m.exec(read('/proc/vmstat'));
  return x ? +x[1] : null;
}

/* ---------------- pressure (PSI) ----------------
 * /proc/pressure/memory is the kernel's own verdict on memory: the share of recent wall-clock time
 * in which at least one task ("some") or every task ("full") was stalled waiting for it. It is the
 * honest Linux twin of the macOS pressure level - a judgement, not a ratio we invented.
 *
 * Written against the CI capture from ubuntu-24.04 (kernel 6.17.0-1020-azure):
 *     some avg10=0.00 avg60=0.00 avg300=0.00 total=2
 *     full avg10=0.00 avg60=0.00 avg300=0.00 total=2
 * The `full` line is absent for the cpu resource on older kernels, and the whole file is absent
 * pre-4.20 or with psi=0 on the kernel command line - both yield null, never a fabricated calm. */
function psiRead(resource) {
  const txt = read('/proc/pressure/' + resource);
  const m = /^some avg10=([\d.]+)/m.exec(txt);
  if (!m || !Number.isFinite(+m[1])) return null;
  const f = /^full avg10=([\d.]+)/m.exec(txt);
  return { some: +m[1], full: f && Number.isFinite(+f[1]) ? +f[1] : null };
}

/* ---------------- self-attribution (FOOTPRINT page) ----------------
 * On Windows this is a pid map over WebView2 children; here the whole instrument is ONE process -
 * the collector runs inside bridge.js - and the window is the user's own browser, which is not ours
 * to claim. So self is a single honestly-labelled component: cumulative utime+stime from
 * /proc/self/stat (differenced by the caller like every other counter) and VmRSS from
 * /proc/self/status. RSS, not private bytes - it includes shared pages, so if it errs it errs
 * AGAINST us, which is the right direction for a self-report. */
function selfStat() {
  const raw = read('/proc/self/stat');
  const close = raw.lastIndexOf(')');
  if (close < 0) return null;
  const f = raw.slice(close + 2).trim().split(/\s+/);
  const ticks = (+f[11] || 0) + (+f[12] || 0);          // utime + stime, fields 14+15
  const m = /^VmRSS:\s+(\d+) kB/m.exec(read('/proc/self/status'));
  return { ticks, mb: m ? +m[1] / 1024 : null };
}

/* ---------------- disk I/O ----------------
 * Offsets counted from the FRONT (see the header note about discard/flush fields):
 *   [2] name  [5] sectors read  [9] sectors written  [11] I/Os in flight  [12] ms spent doing I/O
 * Loop and ram devices are skipped; so are partitions, which double-count their parent disk. */
function diskstats() {
  const out = {};
  for (const line of read('/proc/diskstats').split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 14) continue;
    const name = p[2];
    if (/^(loop|ram|zram|dm-|sr)\d*/.test(name)) continue;
    /* WHOLE DISKS ONLY, decided by the kernel rather than by the name. The previous test stripped
       trailing digits and asked whether the remainder was a known disk, which works for sdaN and
       fails for every NVMe and eMMC device: nvme0n1p1 -> "nvme0n1p", not a disk, so the PARTITION
       was kept and summed alongside nvme0n1 - roughly DOUBLING disk throughput on nearly every
       laptop made in the last five years. /sys/block lists whole devices and never partitions, so
       membership in it is the exact question, and it is name-agnostic. */
    if (!exists(`/sys/block/${name}`)) continue;
    out[name] = { rd: +p[5], wr: +p[9], inflight: +p[11], busyMs: +p[12] };
  }
  return out;
}

/* ---------------- volumes ----------------
 * Real mounted filesystems only. The kernel exposes a great many pseudo-filesystems that report a
 * size of zero and would render as a full disk, which is the "plausible zero" failure this whole
 * design exists to avoid. */
const PSEUDO_FS = new Set(['proc', 'sysfs', 'devtmpfs', 'devpts', 'tmpfs', 'securityfs', 'cgroup',
  'cgroup2', 'pstore', 'efivarfs', 'bpf', 'debugfs', 'tracefs', 'fusectl', 'configfs', 'ramfs',
  'binfmt_misc', 'autofs', 'mqueue', 'hugetlbfs', 'squashfs', 'overlay', 'nsfs', 'rpc_pipefs']);

function volumes() {
  const out = [];
  const seen = new Set();
  for (const line of read('/proc/mounts').split('\n')) {
    const p = line.split(/\s+/);
    if (p.length < 3) continue;
    const [dev, mnt, fstype] = p;
    if (PSEUDO_FS.has(fstype)) continue;
    if (!dev.startsWith('/') && fstype !== 'zfs' && fstype !== 'btrfs') continue;
    /* Dedupe by DEVICE as well as mount point. btrfs subvolumes are the default layout on Fedora
       and openSUSE - / and /home come from one device and report identical size and free space, so
       keying on the mount point alone lists the same disk twice and anything summing the list
       double-counts the machine's capacity. First mount of a device wins. */
    if (seen.has(mnt) || seen.has('dev:' + dev)) continue;
    seen.add(mnt); seen.add('dev:' + dev);
    let st;
    try { st = fs.statfsSync(mnt); } catch { continue; }   // Node 18.15+
    const size = st.blocks * st.bsize;
    if (!size) continue;
    /* bavail, not bfree: bfree includes the root-reserved 5% that an ordinary user can never touch,
       so reporting it would promise space that does not exist for anything you are likely to do. */
    const free = st.bavail * st.bsize;
    out.push({
      id: mnt, label: dev.replace(/^\/dev\//, ''),
      sizeGB: Math.round(size / 1073741824 * 10) / 10,
      freeGB: Math.round(free / 1073741824 * 10) / 10,
      pct: Math.round(((size - free) / size) * 1000) / 10,
      fs: fstype,
    });
  }
  /* Root first, then biggest - the same ordering instinct as putting C: at the top on Windows. */
  out.sort((a, b) => (a.id === '/' ? -1 : b.id === '/' ? 1 : b.sizeGB - a.sizeGB));
  return out;
}

/* ---------------- network ---------------- */
function netdev() {
  let rx = 0, tx = 0; const per = [];
  const lines = read('/proc/net/dev').split('\n').slice(2);
  for (const line of lines) {
    const x = /^\s*([\w.@-]+):\s*(.*)$/.exec(line);
    if (!x) continue;
    const nic = x[1];
    if (nic === 'lo' || /^(docker|veth|br-|virbr)/.test(nic)) continue;
    const n = x[2].trim().split(/\s+/).map(Number);
    rx += n[0] || 0; tx += n[8] || 0;
    per.push({ n: nic, rx: n[0] || 0, tx: n[8] || 0 });
  }
  return { rx, tx, per };
}

/* ---------------- processes ----------------
 * ONE file per pid. /proc/<pid>/stat carries the name, both CPU-time fields, the major-fault count
 * and RSS all at once, so a full sweep is one read per process rather than four.
 *
 * comm is wrapped in parentheses AND may itself contain parentheses and spaces (a process is free to
 * call itself "my (weird) name"). Splitting on whitespace corrupts the field offsets for every such
 * process, so the name is cut at the LAST ')' and the numeric fields are indexed from after it. */
function procList(pageSize) {
  const out = new Map();
  let names;
  try { names = fs.readdirSync('/proc'); } catch { return out; }
  for (const d of names) {
    if (d < '0' || d > '9999999') continue;
    const raw = read(`/proc/${d}/stat`);
    if (!raw) continue;                                  // process died between readdir and read
    const close = raw.lastIndexOf(')');
    const open = raw.indexOf('(');
    if (close < 0 || open < 0) continue;
    const name = raw.slice(open + 1, close);
    const f = raw.slice(close + 2).trim().split(/\s+/);
    /* f[0] is state, so the 1-indexed /proc/pid/stat field N sits at f[N-3]. */
    const majflt = +f[9] || 0;         // field 12
    const utime = +f[11] || 0;         // field 14
    const stime = +f[12] || 0;         // field 15
    const rssPages = +f[21] || 0;      // field 24
    const key = name;
    let a = out.get(key);
    if (!a) { a = { n: key, cpuTicks: 0, mb: 0, pf: 0, count: 0, pids: [], ioR: 0, ioW: 0, ioN: 0 }; out.set(key, a); }
    a.cpuTicks += utime + stime;
    a.mb += (rssPages * pageSize) / 1048576;
    a.pf += majflt;
    a.count += 1;
    if (a.pids.length < 40) a.pids.push(+d);
    /* Per-process I/O: /proc/<pid>/io is mode 0400, so it reads only for processes this user owns -
       root sees everything, an unelevated bridge sees its session. rchar/wchar, NOT read_bytes/
       write_bytes, for two paid-for reasons: (1) they are the semantic twin of the Windows
       'IO Read/Write Bytes/sec' counters these columns were built on - all I/O the process issued,
       pipes and sockets included, counted at the syscall; (2) buffered write_bytes is charged to
       whichever task submits the bio, so background writeback lands on root's kworkers and the
       column would silently under-report every process that does not fsync. ioN counts how many of
       this name's pids were readable, so the differencer can tell "measured 0" from "not allowed". */
    const io = read(`/proc/${d}/io`);
    if (io) {
      const r = /^rchar: (\d+)/m.exec(io);
      const w = /^wchar: (\d+)/m.exec(io);
      if (r && w) { a.ioR += +r[1]; a.ioW += +w[1]; a.ioN += 1; }
    }
  }
  return out;
}

/* ---------------- battery ----------------
 * Different drivers publish either energy_* (µWh, the common laptop case) or charge_* (µAh, needing
 * voltage to become watt-hours). Both are handled; neither is invented when absent. */
function power() {
  let base = '/sys/class/power_supply';
  let bat = null, ac = null;
  let entries = [];
  try { entries = fs.readdirSync(base); } catch { return { bat: false }; }
  for (const e of entries) {
    const type = read(path.join(base, e, 'type')).trim();
    if (type === 'Battery' && !bat) bat = path.join(base, e);
    if (type === 'Mains' && !ac) ac = path.join(base, e);
  }
  if (!bat) return { bat: false };

  const status = read(path.join(bat, 'status')).trim();
  const uV = readInt(path.join(bat, 'voltage_now'));
  const volts = uV ? uV / 1e6 : null;

  const eNow = readInt(path.join(bat, 'energy_now'));
  const eFull = readInt(path.join(bat, 'energy_full'));
  const eDesign = readInt(path.join(bat, 'energy_full_design'));
  const pNow = readInt(path.join(bat, 'power_now'));
  const cNow = readInt(path.join(bat, 'charge_now'));
  const cFull = readInt(path.join(bat, 'charge_full'));
  const cDesign = readInt(path.join(bat, 'charge_full_design'));
  const iNow = readInt(path.join(bat, 'current_now'));

  const wh = (uwh) => (uwh == null ? null : Math.round(uwh / 1e6 * 10) / 10);
  const ahToWh = (uah) => (uah == null || volts == null ? null : Math.round(uah / 1e6 * volts * 10) / 10);

  const remWh = eNow != null ? wh(eNow) : ahToWh(cNow);
  const fullWh = eFull != null ? wh(eFull) : ahToWh(cFull);
  const designWh = eDesign != null ? wh(eDesign) : ahToWh(cDesign);

  let rateW = null;
  if (pNow != null) rateW = Math.round(pNow / 1e6 * 10) / 10;
  else if (iNow != null && volts != null) rateW = Math.round((iNow / 1e6) * volts * 10) / 10;
  /* Sign convention matches Windows: positive while charging, negative while draining. The kernel
     reports magnitude only, so the sign comes from status. */
  if (rateW != null && status === 'Discharging') rateW = -Math.abs(rateW);
  if (rateW != null && status === 'Charging') rateW = Math.abs(rateW);

  const cap = readInt(path.join(bat, 'capacity'));
  return {
    bat: true,
    pct: cap == null ? 255 : cap,
    ac: ac ? readInt(path.join(ac, 'online')) === 1 : status !== 'Discharging',
    charging: status === 'Charging',
    discharging: status === 'Discharging',
    rateW, remWh, fullWh, designWh,
    cycles: readInt(path.join(bat, 'cycle_count')) || 0,
    chem: read(path.join(bat, 'technology')).trim(),
    /* Time-to-empty is derived, not reported, and only when there is a real draw to divide by. */
    lifeMin: (remWh != null && rateW != null && rateW < 0)
      ? Math.round((remWh / Math.abs(rateW)) * 60) : null,
  };
}

/* ---------------- GPU ----------------
 * amdgpu publishes a genuine busy percentage. i915 does not - it publishes frequencies, which are
 * NOT utilisation, so an Intel GPU appears in the adapter list without a number rather than with a
 * fabricated one. NVIDIA needs nvidia-smi, which is a subprocess and therefore polled slowly and
 * separately rather than on the tick path. */
function gpuSys() {
  const ads = [];
  let cards = [];
  try { cards = fs.readdirSync('/sys/class/drm').filter((d) => /^card\d+$/.test(d)); } catch { return null; }
  for (const c of cards) {
    const dev = `/sys/class/drm/${c}/device`;
    const busy = readInt(`${dev}/gpu_busy_percent`);          // amdgpu only
    let name = read(`${dev}/uevent`).match(/DRIVER=(\w+)/);
    name = name ? name[1] : c;
    ads.push({ n: name, util: busy == null ? null : busy });
  }
  if (!ads.length) return null;
  const nums = ads.map((a) => a.util).filter((u) => u != null);
  return { max: nums.length ? Math.max(...nums) : null, ads, top: [] };
}

function temps() {
  let zones = [];
  try { zones = fs.readdirSync('/sys/class/thermal').filter((d) => /^thermal_zone\d+$/.test(d)); } catch { return null; }
  let best = null;
  for (const z of zones) {
    const type = read(`/sys/class/thermal/${z}/type`).trim();
    const t = readInt(`/sys/class/thermal/${z}/temp`);
    if (t == null) continue;
    const c = t > 1000 ? t / 1000 : t;                       // millidegrees on almost every driver
    if (/x86_pkg_temp|cpu|soc|coretemp|k10temp/i.test(type)) best = Math.max(best ?? -99, c);
  }
  return best == null ? null : Math.round(best);
}

/* ---------------- the plug ---------------- */
function start(root, { onStatic, onTick, onError }) {
  /* PAGE SIZE IS NOT ALWAYS 4 kB, and the comment that used to say so here was simply wrong.
     Asahi Linux runs 16 kB pages and RHEL-family aarch64 runs 64 kB, so a hard-coded 4096 would
     under-report every process's memory by 4x or 16x on those machines - quietly, and in the
     direction that makes a struggling machine look healthy.
     There is no getpagesize() in Node, so it is read from the kernel: /proc/self/smaps reports
     KernelPageSize per mapping. Falling back to 4096 is right for x86-64 and arm64 desktop. */
  let pageSize = 4096;
  {
    const m = /KernelPageSize:\s+(\d+) kB/.exec(read('/proc/self/smaps'));
    if (m && +m[1] > 0) pageSize = +m[1] * 1024;
  }
  let stopped = false, timer = null, tick = 0;

  let prevCpu = null, prevDisk = null, prevNet = null, prevProc = null, prevFaults = null;
  let prevSelf = null;
  let prevAt = process.hrtime.bigint();
  let volCache = null;

  /* -------- static description, emitted once -------- */
  const cpuinfo = read('/proc/cpuinfo');
  const model = (/^model name\s*:\s*(.+)$/m.exec(cpuinfo) || [])[1] || os.cpus()[0]?.model || 'unknown';
  const physIds = new Set((cpuinfo.match(/^core id\s*:\s*\d+$/gm) || []));
  let osName = 'Linux';
  const rel = read('/etc/os-release');
  const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(rel);
  if (pretty) osName = pretty[1];

  const gsys = gpuSys();
  setImmediate(() => onStatic({
    t: 'static',
    cpu: model.trim(),
    cores: physIds.size || os.cpus().length,
    threads: os.cpus().length,
    ramMB: Math.round(os.totalmem() / 1048576),
    gpu: gsys ? gsys.ads.map((a) => a.n) : [],
    nvidia: exists('/proc/driver/nvidia'),
    host: os.hostname(),
    os: `${osName} (kernel ${os.release()})`,
  }));

  function sample() {
    if (stopped) return;
    try {
      const now = process.hrtime.bigint();
      /* MEASURED elapsed, never the nominal interval. See the header note. */
      const elapsed = Number(now - prevAt) / 1e9;
      prevAt = now;
      tick++;

      const c = cpuStat();
      const m = meminfo();
      const d = diskstats();
      const n = netdev();
      const faults = majFaults();
      const procs = procList(pageSize);
      const sf = selfStat();

      /* First pass has no previous reading to difference against, so it establishes the baseline and
         emits nothing. Publishing a first tick built from cumulative-since-boot totals would show a
         machine that has been at 100% disk for three days. */
      if (!prevCpu) {
        prevCpu = c; prevDisk = d; prevNet = n; prevProc = procs; prevFaults = faults; prevSelf = sf;
        return;
      }

      const perCore = c.cores.map((core, i) => Math.round(pctOf(core, prevCpu.cores[i])));

      let rdB = 0, wrB = 0, busyMs = 0, queue = 0;
      /* PER-DEVICE, kept rather than summed away. This loop already differenced every whole disk
         to build the aggregate and then discarded the rows - caps.js has been calling that
         "collected-but-unreachable" since it was written. Same {id, readMBs, writeMBs, ...} shape
         the darwin plug emits, with the split and busy time real here because the kernel gives
         them per device. */
      const devices = [];
      for (const [name, cur] of Object.entries(d)) {
        const p = prevDisk[name];
        if (!p) continue;
        const dRd = Math.max(0, cur.rd - p.rd) * SECTOR;
        const dWr = Math.max(0, cur.wr - p.wr) * SECTOR;
        const dBusy = Math.max(0, cur.busyMs - p.busyMs);
        rdB += dRd;
        wrB += dWr;
        busyMs = Math.max(busyMs, dBusy);
        queue += cur.inflight;
        devices.push({
          id: name,
          readMBs: Math.round((dRd / 1048576) / elapsed * 100) / 100,
          writeMBs: Math.round((dWr / 1048576) / elapsed * 100) / 100,
          combinedMBs: Math.round(((dRd + dWr) / 1048576) / elapsed * 100) / 100,
          busyPct: Math.min(100, Math.round((dBusy / (elapsed * 1000)) * 100)),
        });
      }

      if (!volCache || tick % 10 === 1) volCache = volumes();

      const totalKB = m.MemTotal || 1;
      /* "Used" is total minus AVAILABLE, not minus free. MemFree on a healthy Linux box is near zero
         because the kernel fills it with page cache it will hand back on demand; subtracting it
         would report every idle machine as out of memory. MemAvailable is the kernel's own estimate
         of what a new allocation could actually get, which is the honest number. */
      const availKB = m.MemAvailable != null ? m.MemAvailable : (m.MemFree || 0) + (m.Cached || 0);
      const usedMB = Math.round((totalKB - availKB) / 1024);
      const totalMB = Math.round(totalKB / 1024);

      const procOut = [];
      for (const [key, a] of procs) {
        const p = prevProc.get(key);
        const dTicks = p ? Math.max(0, a.cpuTicks - p.cpuTicks) : 0;
        /* I/O is differenced ONLY when both ticks had readable counters for this name. A name whose
           pids we cannot read (another user's) reports null, never 0 - the columns cover this
           session, not the machine, and caps.js says so (proc.io partial). */
        const hasIo = a.ioN > 0 && p && p.ioN > 0;
        const dR = hasIo ? Math.max(0, a.ioR - p.ioR) : null;
        const dW = hasIo ? Math.max(0, a.ioW - p.ioW) : null;
        procOut.push({
          n: a.n,
          mb: Math.round(a.mb),
          cpu: Math.round(((dTicks / HZ) / elapsed / os.cpus().length) * 1000) / 10,
          ioMBs: hasIo ? Math.round(((dR + dW) / 1048576) / elapsed * 100) / 100 : null,
          rMBs: hasIo ? Math.round((dR / 1048576) / elapsed * 100) / 100 : null,
          wMBs: hasIo ? Math.round((dW / 1048576) / elapsed * 100) / 100 : null,
          pf: a.pf, count: a.count, pids: a.pids,
        });
      }
      procOut.sort((x, y) => y.mb - x.mb);

      const g = gpuSys();
      const cTemp = temps();

      /* Self-attribution, the same formula as the Windows collector: CPU-time delta / wall delta /
         logical threads. One component - the collector runs inside the bridge process here, and the
         window is the user's own browser, which is not ours to claim (see selfStat's header). */
      let selfOut = null;
      if (sf && prevSelf) {
        const sCpu = Math.round((((Math.max(0, sf.ticks - prevSelf.ticks) / HZ) / elapsed
          / os.cpus().length) * 100) * 100) / 100;
        const sMb = sf.mb != null ? Math.round(sf.mb) : 0;
        selfOut = {
          comps: [{ k: 'bridge', n: 1, cpu: sCpu, mb: sMb }],
          cpu: sCpu, mb: sMb, n: 1,
          scanAge: 0,     // the pid "map" is ourselves; it cannot go stale
        };
      }

      onTick({
        t: 'tick',
        ts: Date.now(),
        cpu: { total: pctOf(c.total, prevCpu.total), cores: perCore },
        mem: {
          usedMB, freeMB: totalMB - usedMB, totalMB,
          committedMB: m.Committed_AS ? Math.round(m.Committed_AS / 1024) : null,
          pct: Math.round((usedMB / totalMB) * 1000) / 10,
          cacheMB: Math.round(((m.Cached || 0) + (m.Buffers || 0)) / 1024),
          pagesSec: (faults != null && prevFaults != null)
            ? Math.round(Math.max(0, faults - prevFaults) / elapsed) : null,
          /* The kernel's verdict, not ours: {some, full} avg10 percentages from PSI. Same field the
             darwin plug uses for its pressure LEVEL - the panel renders each platform's shape and
             history records the numeric part. Null wherever PSI is absent or disabled. */
          pressure: psiRead('memory'),
        },
        disk: {
          vols: volCache,
          io: {
            readMBs: Math.round((rdB / 1048576) / elapsed * 100) / 100,
            writeMBs: Math.round((wrB / 1048576) / elapsed * 100) / 100,
            busyPct: Math.min(100, Math.round((busyMs / (elapsed * 1000)) * 100)),
            queue,
          },
          devices,
        },
        net: {
          rxMBs: Math.round(Math.max(0, n.rx - prevNet.rx) / 1048576 / elapsed * 1000) / 1000,
          txMBs: Math.round(Math.max(0, n.tx - prevNet.tx) / 1048576 / elapsed * 1000) / 1000,
          /* Per-interface rates, differenced against the previous tick's per-NIC totals - which
             netdev() has always collected and this tick always threw away. A NIC with no previous
             sample (VPN up, cable in) reports null, not a spike off a zero baseline. */
          ifaces: n.per.map((nic) => {
            const p = prevNet.per.find((x) => x.n === nic.n);
            return {
              id: nic.n,
              rxMBs: p ? Math.round(Math.max(0, nic.rx - p.rx) / 1048576 / elapsed * 100) / 100 : null,
              txMBs: p ? Math.round(Math.max(0, nic.tx - p.tx) / 1048576 / elapsed * 100) / 100 : null,
            };
          }),
        },
        proc: procOut.slice(0, 16),
        gpu: g && g.max != null ? { util: g.max } : null,
        gpus: g,
        pwr: power(),
        temps: cTemp == null ? null : { cpu: cTemp },
        self: selfOut,
        up: Math.round((parseFloat(read('/proc/uptime')) / 3600) * 10) / 10,
      });

      prevCpu = c; prevDisk = d; prevNet = n; prevProc = procs; prevFaults = faults; prevSelf = sf;
    } catch (e) {
      onError('[metrics/linux] ' + e.message);
    }
  }

  sample();                                  // establish the baseline immediately
  timer = setInterval(sample, 1000);
  return { stop() { stopped = true; clearInterval(timer); } };
}

module.exports = { start, _internal: { cpuStat, meminfo, diskstats, netdev, pctOf, psiRead, selfStat } };
