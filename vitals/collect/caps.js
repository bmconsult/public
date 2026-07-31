/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - CAPABILITY MANIFEST. What each operating system can honestly answer.
 *
 * THE POINT OF THIS FILE. VITALS was built against Windows perf counters, which happen to expose
 * an unusually complete picture: per-process I/O, per-adapter GPU, hard fault rates, NTFS internals.
 * Almost none of that ports one-for-one. macOS has no per-process disk I/O without elevation;
 * Linux has no NTFS master file table; neither has anything resembling `GPU Engine` counters.
 *
 * The tempting move is to emit zeros for whatever the host cannot measure. That is the single worst
 * thing this tool could do, and it is a lesson already paid for once on Windows: nvidia-smi read the
 * idle discrete GPU while the integrated one did all the work, and the panel confidently displayed
 * "GPU 0%" while a GPU was pegged. A plausible zero is worse than a blank, because a blank prompts a
 * question and a zero ends one.
 *
 * So capability is declared UP FRONT, per platform, and the panel gates on it. A feature the host
 * cannot measure is not drawn dim, not drawn at zero - it is absent, and the page says why. Every
 * value that does appear was genuinely measured on the machine in front of you.
 *
 * Values:  true      the host answers this properly
 *          'partial' answered, but weaker than the Windows original - `note` says how
 *          false     not available; the UI must omit the feature entirely
 *
 * VERIFICATION STATUS is tracked per platform and is deliberately visible in the UI, because an
 * untested collector making confident claims is exactly the failure this file exists to prevent.
 */

/* Every key the panel is allowed to gate on. Adding a feature to the UI means adding it here first,
   so a new page cannot silently ship a Windows-only assumption. */
const KEYS = [
  'cpu.perCore', 'cpu.temps',
  'mem.hardFaults', 'mem.committed', 'mem.cache', 'mem.pressure',
  'disk.perVolume', 'disk.io', 'disk.perDevice',
  'net.rates', 'net.perInterface', 'net.sockets',
  'proc.list', 'proc.cpu', 'proc.mem', 'proc.io', 'proc.faults',
  'gpu.total', 'gpu.perAdapter', 'gpu.perProcess',
  'power.battery', 'power.rate', 'power.health', 'power.wake',
  'scan.mft', 'scan.iotrace', 'scan.growth', 'scan.startup',
  'clip.history',
  'act.restartApp', 'act.clean', 'act.kill', 'act.elevate',
  'host.frameless', 'host.tray',
];

const PLATFORMS = {

  /* ---------------------------------------------------------------- WINDOWS
   * The reference implementation. Everything the panel does was designed against these counters,
   * and every one of these entries has been observed working on a real machine. */
  win32: {
    name: 'Windows',
    collector: 'metrics.ps1 (PowerShell, PerformanceCounter bulk read)',
    verified: 'measured on Windows 11 26H1, i7-1165G7, hybrid Iris Xe + GTX 1650',
    caps: {
      'cpu.perCore': true, 'cpu.temps': 'partial',
      'mem.hardFaults': true, 'mem.committed': true, 'mem.cache': true, 'mem.pressure': false,
      'disk.perVolume': true, 'disk.io': true, 'disk.perDevice': true,
      'net.rates': true, 'net.perInterface': true, 'net.sockets': true,
      'proc.list': true, 'proc.cpu': true, 'proc.mem': true, 'proc.io': true, 'proc.faults': true,
      'gpu.total': true, 'gpu.perAdapter': true, 'gpu.perProcess': true,
      'power.battery': true, 'power.rate': true, 'power.health': true, 'power.wake': false,
      'scan.mft': true, 'scan.iotrace': true, 'scan.growth': true, 'scan.startup': true,
      'clip.history': true,
      'act.restartApp': true, 'act.clean': true, 'act.kill': true, 'act.elevate': true,
      'host.frameless': true, 'host.tray': true,
    },
    notes: {
      'cpu.temps': 'Windows exposes no CPU temperature to unprivileged code. Present only when ' +
                   'LibreHardwareMonitor is running and serving its web endpoint on :8085.',
      'mem.pressure': 'A kernel memory VERDICT (the macOS pressure level) has no Windows twin; ' +
                      'the hard-fault rate is this platform\'s honest equivalent and is measured.',
      'power.wake': 'Naming the process that blocks sleep needs an elevated `powercfg /requests`, ' +
                    'which the unelevated bridge deliberately does not run.',
    },
  },

  /* ---------------------------------------------------------------- LINUX
   * /proc and /sys, read directly by Node - no shelling out, so the per-tick cost is a handful of
   * small file reads. The kernel exposes cumulative counters in almost exactly the shape the Windows
   * collector produces after differencing, which is why this port is the clean one.
   *
   * What genuinely does not exist here: an NTFS master file table (the scan.mft page is Windows-only
   * by definition), and any vendor-neutral per-process GPU accounting. */
  linux: {
    name: 'Linux',
    collector: 'collect/linux.js (direct /proc and /sys reads, no subprocesses)',
    /* Run end to end on Ubuntu 22.04 / kernel 6.6.87.2 (WSL2), 2026-07-30. 37 correctness checks
       cross-referenced against df, free -m, nproc, /proc/meminfo and hostname - independent sources,
       because a collector agreeing with itself proves nothing - plus 6 stimulus checks confirming
       the counters MOVE: idle 0-2.7% -> 100% under an all-core burn with every core registering,
       136 MB/s on a 200 MB fsynced write, 0.33 MB/s on a measured HTTPS pull.
       WHAT THAT RUN COULD NOT EXERCISE: the host was a VM with no battery, no /sys/class/drm cards
       and no thermal zones, so power(), gpuSys() and temps() were only proven to return null/false
       correctly. Their POPULATED paths remain untested - which is why the entries they feed are
       marked partial below rather than plain true. */
    verified: 'end-to-end on Ubuntu 22.04 (kernel 6.6.87.2, WSL2): 37 correctness checks against ' +
              'df/free/nproc + 6 stimulus checks. Battery, GPU and thermal paths were absent on ' +
              'that host and are still unproven when populated.',
    caps: {
      /* temps ARE emitted by the plug, but the THERM page reads only t.sensors
         (LibreHardwareMonitor). Measured-and-discarded is not a capability. */
      'cpu.perCore': true, 'cpu.temps': false,
      'mem.hardFaults': true, 'mem.committed': true, 'mem.cache': true,
      /* /proc/pressure (PSI) exists on modern kernels, but no parser for it has been written. */
      'mem.pressure': false,
      /* per-device rows and per-interface rates are EMITTED in the tick as of 2026-07-31
         (disk.devices, net.ifaces) - they were previously differenced inside the plug and
         discarded. Still false: the emission has not been re-run on a Linux host, and a flag here
         means verified, not written. Flip after the live suite sees them populated. */
      'disk.perVolume': true, 'disk.io': true, 'disk.perDevice': false,
      'net.rates': true, 'net.perInterface': false, 'net.sockets': false,
      'proc.list': true, 'proc.cpu': true, 'proc.mem': true, 'proc.io': 'partial', 'proc.faults': true,
      'gpu.total': 'partial', 'gpu.perAdapter': 'partial', 'gpu.perProcess': false,
      'power.battery': 'partial', 'power.rate': 'partial', 'power.health': 'partial',
      'power.wake': false,
      /* ---- MOSTLY FALSE BECAUSE THE CODE IS POWERSHELL, not because Linux cannot do it. A
         manifest describes what is IMPLEMENTED AND VERIFIED - the original values here were
         written from intent and certified features that returned 501.
         Three of these now have native implementations that the router serves on this platform:
         scan.growth (growthscan.js walker), act.kill and act.clean (actions-posix.js). They stay
         false until they have actually run on a Linux host - route reachable, capability
         unclaimed. The rest remain unported. ---- */
      'scan.mft': false, 'scan.iotrace': false, 'scan.growth': false, 'scan.startup': false,
      'clip.history': false,
      'act.restartApp': false, 'act.clean': false, 'act.kill': false, 'act.elevate': false,
      'host.frameless': 'partial', 'host.tray': false,
    },
    notes: {
      'cpu.temps': '/sys/class/thermal and hwmon, when the platform driver publishes them. Bare ' +
                   'metal usually does; VMs and WSL usually do not. The absent case is verified; ' +
                   'the present case has not been seen.',
      'power.battery': 'Reads /sys/class/power_supply, handling both energy_* (uWh) and charge_* ' +
                       '(uAh, needing voltage) driver conventions. The no-battery case is verified. ' +
                       'A real laptop battery has not been read yet, so treat the first reading on ' +
                       'one as unconfirmed and compare it against upower.',
      'power.rate': 'Derived from power_now, or current_now x voltage_now where the driver reports ' +
                    'amps instead of watts. Sign comes from status. Unverified on real hardware.',
      'power.health': 'energy_full vs energy_full_design. Unverified on real hardware.',
      'proc.io': '/proc/<pid>/io is readable only for your own processes unless running as root, ' +
                 'so the I/O column covers your session, not the whole machine.',
      'gpu.total': 'amdgpu and i915 publish utilisation through /sys; NVIDIA requires nvidia-smi. ' +
                   'Whichever is absent is omitted rather than reported as zero.',
      'gpu.perProcess': 'No vendor-neutral equivalent to the Windows GPU Engine counters exists.',
      'mem.pressure': '/proc/pressure/memory (PSI) is the kernel\'s own verdict and the right ' +
                      'source; the parser has not been written yet.',
      'scan.mft': 'Master File Table parsing is an NTFS feature. The growth walker ' +
                  '(growthscan.js, POST /api/growthscan) replaces it here - slower, but it works ' +
                  'on any filesystem.',
      'scan.growth': 'Implemented: growthscan.js walks the tree and /api/growth diffs the ' +
                     'snapshots. Not yet run on a Linux host, so unclaimed until it is.',
      'act.kill': 'Implemented (SIGTERM, then SIGKILL for survivors, denials counted). Unverified ' +
                  'on a Linux host.',
      'act.clean': 'Implemented for user-owned targets (tmp, ~/.cache) with denials counted. No ' +
                   'elevated targets: that needs polkit, see act.elevate.',
      'scan.iotrace': 'Needs blktrace or eBPF, both of which require root and a kernel built for it.',
      'clip.history': 'Requires a running X11 or Wayland session with xclip or wl-clipboard present.',
      'act.elevate': 'pkexec when a polkit agent is running, otherwise sudo in a terminal. Not ' +
                     'implemented: whether an agent is present decides everything, and that ' +
                     'cannot be written honestly from documentation.',
      'host.frameless': 'No WebView2 equivalent. The panel opens in the default browser in app mode; ' +
                        'edge-docking and always-on-top are the window manager\'s business, not ours.',
    },
  },

  /* ---------------------------------------------------------------- macOS
   * WRITTEN, NOT VERIFIED. There is no Mac on this bench, so every entry below is derived from
   * documented tool output rather than observed behaviour, and the panel says so out loud.
   *
   * This is the honest state of a port nobody has run yet. It is shipped because a collector that
   * announces its own untested status is more useful than no collector, and strictly more honest
   * than one that pretends. The first person to run it on real hardware should correct this block
   * and flip `verified`. */
  darwin: {
    name: 'macOS',
    collector: 'collect/darwin.js (sysctl, vm_stat, iostat, pmset, ps)',
    /* Still false, and it stays false until someone runs it on a Mac. What HAS been done is worth
       stating precisely, because it is not nothing and it is also not verification:
       collect/test-darwin-sim.js drives the entire collector from fixture text through an injection
       seam and checks 81 things - the memory arithmetic, ps aggregation, netstat de-duplication,
       mAh-to-watt-hour conversion with sign, rate differencing across ticks, null discipline, and
       the tick contract. That suite found three real defects: installed RAM was read from two
       different sources that could disagree, and the df parser located the mount point with
       indexOf, which for the root volume matched "/dev/..." at index 0 and SILENTLY DROPPED THE
       MAIN DISK. Both fixed.
       So: the logic is tested, the format assumption is not. Only a Mac settles the latter. */
    verified: false,
    verifyNote: 'UNVERIFIED on hardware - written from documented tool output, never executed on a ' +
                'Mac. The collector LOGIC is covered by 81 simulation checks (collect/test-darwin-sim.js), ' +
                'but whether macOS really emits the assumed formats is untested. CI now runs the live ' +
                'suite on real Darwin (macos-14 + macos-15) on every push; this note and the flags ' +
                'below change when it goes green, and not before.',
    /* IMPLEMENTED BUT NOT YET FLIPPED. cpu.perCore is written and works - os.cpus() carries
       per-core tick counters on Darwin, so it never needed the native addon the collector's own
       comment claimed - but a flag here means "verified on this platform", not "the code exists".
       It flips when the CI live suite reports per-core values that agree with an independent
       source, which is the same standard every other true in this file was held to. Writing the
       code and flipping the flag are deliberately two separate acts. */
    caps: {
      /* Corrected 2026-07-30 to match the CODE rather than the intent, and again 2026-07-31 the
         OTHER way: much below is now IMPLEMENTED (per-core, committed approximation, pressure,
         per-NIC, per-device, GPU via IOAccelerator, wake assertions, the growth walker, the whole
         action layer) and every flag for it is still false, because a flag here means "verified on
         this platform" and none of it has executed on a Mac. The note beside each says which state
         it is in. The CI live suite flipping green is what changes these, one by one. */
      'cpu.perCore': false, 'cpu.temps': false,
      'mem.hardFaults': true, 'mem.committed': false, 'mem.cache': true, 'mem.pressure': false,
      'disk.perVolume': true, 'disk.io': 'partial', 'disk.perDevice': false,
      'net.rates': true, 'net.perInterface': false, 'net.sockets': false,
      'proc.list': true, 'proc.cpu': 'partial', 'proc.mem': true, 'proc.io': false, 'proc.faults': false,
      'gpu.total': false, 'gpu.perAdapter': false, 'gpu.perProcess': false,
      'power.battery': true, 'power.rate': true, 'power.health': true, 'power.wake': false,
      'scan.mft': false, 'scan.iotrace': false, 'scan.growth': false, 'scan.startup': false,
      'clip.history': false,
      'act.restartApp': false, 'act.clean': false, 'act.kill': false, 'act.elevate': false,
      'host.frameless': 'partial', 'host.tray': false,
    },
    notes: {
      'cpu.perCore': 'Implemented: os.cpus() carries per-core tick counters on Darwin, differenced ' +
                     'between ticks like /proc/stat on Linux. Unverified on hardware - flips when ' +
                     'CI shows per-core values agreeing with an independent source. (An earlier ' +
                     'note here claimed per-core was impossible without a native addon, which was ' +
                     'never true.)',
      'cpu.total': 'Comes from the iostat stream. If iostat is missing or has not yet emitted a ' +
                   'data line, total is null rather than 0 - an idle-looking CPU is the one lie ' +
                   'this tool must never tell.',
      'mem.committed': 'Approximated as resident-used plus swap-used (vm.swapusage): "how much ' +
                       'memory this machine has actually had to find". macOS has no true commit ' +
                       'charge, so this is deliberately NOT presented as the Windows number. ' +
                       'Unverified on hardware.',
      'mem.pressure': 'Implemented: kern.memorystatus_vm_pressure_level, the number behind ' +
                      'Activity Monitor\'s pressure graph (1 normal / 2 warning / 4 critical). ' +
                      'Unverified on hardware.',
      'proc.cpu': 'macOS `ps` reports %cpu relative to ONE core, so a saturated multi-threaded ' +
                  'process can exceed 100. Normalised by core count to match the Windows and Linux ' +
                  'scale, but this is unverified on hardware.',
      'proc.faults': 'Not implemented - needs `top -stats faults`, whose column layout is being ' +
                     'captured by CI before the parser is written. Null, never 0.',
      'disk.io': 'iostat gives COMBINED throughput only. Read/write split, busy percentage and ' +
                 'queue depth are all null; only combinedMBs is real. The split lives one level ' +
                 'up in IOBlockStorageDriver statistics, whose real shape CI is capturing.',
      'disk.perDevice': 'Implemented: per-disk MB/s and tps from the iostat columns, named from ' +
                        'its header row. Unverified on hardware.',
      'net.perInterface': 'Implemented: per-NIC rates differenced from netstat -ib. Unverified on ' +
                          'hardware.',
      'cpu.temps': 'Apple Silicon exposes thermals only through IOKit and powermetrics, and ' +
                   'powermetrics requires root. Omitted rather than faked.',
      'proc.io': 'Per-process disk I/O needs fs_usage, which requires root and disabling SIP on ' +
                 'some releases. Not worth the cost.',
      'gpu.total': 'Implemented WITHOUT root: IOAccelerator\'s "Device Utilization %", the source ' +
                   'behind Activity Monitor\'s GPU history. The key names are the exact kind of ' +
                   'documented-not-observed assumption that has been wrong here before, so this ' +
                   'stays false until CI\'s captured ioreg output agrees.',
      'power.wake': 'Implemented: pmset -g assertions names the process holding the machine ' +
                    'awake, by pid, with no admin rights - something the Windows build cannot do ' +
                    'unelevated. Unverified on hardware.',
      'scan.growth': 'Implemented: the portable walker (growthscan.js, POST /api/growthscan) ' +
                     'writes snapshots that /api/growth diffs. Covers what this user may read, ' +
                     'not the whole disk. Unverified on hardware.',
      'act.kill': 'Implemented: SIGTERM, then SIGKILL for survivors, permission denials counted ' +
                  'and reported. Unverified on hardware.',
      'act.clean': 'Implemented: user targets (TMPDIR, ~/Library/Caches, ~/Library/Logs) swept ' +
                   'unelevated with denials counted; system targets go through clean-admin.js ' +
                   'behind the administrator prompt. /System is SIP-protected and deliberately ' +
                   'untouched. Unverified on hardware.',
      'act.restartApp': 'Implemented: resolve the bundle first (refuse if LaunchServices cannot), ' +
                        'AppleScript quit, force only survivors, relaunch the resolved path. ' +
                        'Unverified on hardware.',
      'act.elevate': 'Implemented as `do shell script ... with administrator privileges` - macOS ' +
                     'raises the password dialog, the user can refuse, and the elevated process ' +
                     'only ever runs clean-admin.js with a key from its own fixed table. ' +
                     'Unverified on hardware.',
      'host.frameless': 'Opens in the default browser in app mode. A native WKWebView host is ' +
                        'possible but is a separate build with its own signing requirements.',
    },
  },
};

function platformKey(p = process.platform) {
  return PLATFORMS[p] ? p : null;
}

/* The full manifest for the host we are actually on, plus the flat `can` map the panel gates on.
   `partial` counts as available - the feature renders, and its note explains the limit. */
function manifest(p = process.platform) {
  const key = platformKey(p);
  if (!key) {
    return {
      platform: p, name: p, supported: false, verified: false,
      collector: 'none', caps: {}, can: {}, notes: {},
      warning: `VITALS has no collector for "${p}". The panel will load but no telemetry will arrive.`,
    };
  }
  const d = PLATFORMS[key];
  const can = {};
  for (const k of KEYS) can[k] = !!d.caps[k];
  return {
    platform: key, name: d.name, supported: true,
    collector: d.collector,
    verified: d.verified === false ? false : d.verified,
    verifyNote: d.verifyNote || '',
    caps: d.caps, can, notes: d.notes || {},
    /* Everything this host cannot do, named. The panel shows this on the SELF page so the limits of
       the current install are always one click away rather than discovered by confusion. */
    missing: KEYS.filter((k) => !d.caps[k]),
    limited: KEYS.filter((k) => d.caps[k] === 'partial'),
  };
}

module.exports = { KEYS, PLATFORMS, manifest, platformKey };
