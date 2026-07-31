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
    /* VERIFICATION HISTORY, because each round proved something the previous could not:
       2026-07-30, Ubuntu 22.04 / kernel 6.6.87.2 (WSL2): 37 correctness checks against df, free,
       nproc and /proc/meminfo, plus 6 stimulus checks (idle -> 100% all-core burn, 136 MB/s on a
       fsynced write, a measured HTTPS pull). WSL is a VM with Windows interop that can mask
       PowerShell dependencies, so:
       2026-07-31, GitHub CI on REAL kernels - ubuntu-22.04 and ubuntu-24.04, both green: the same
       parser + live + stimulus suites, the route guard, the action and inspection logic suites,
       the growth walker over a real home, and a bridge boot serving a measured sample. That run
       also CAPTURED the /proc bytes (net/tcp, pressure, systemctl, ss) that the sockets, startup
       and PSI code below was then written against.
       STILL UNPROVEN ANYWHERE: battery, populated GPU and thermal paths - every CI host is a VM
       with none of the three, so those entries stay partial until a real Linux laptop reports. */
    verified: 'end-to-end on real kernels in CI (ubuntu-22.04 + 24.04, 2026-07-31): parser ' +
              'fixtures against captured /proc text, live cross-check against df/free/nproc, ' +
              'stimulus checks that the counters move, growth walker over a real home, bridge ' +
              'sample. Battery, GPU and thermal populated paths remain unproven - runners have ' +
              'none of the three.',
    /* THE FLIP-ON-GREEN LIST. Everything below marked "flip when CI agrees" was implemented
       2026-07-31 against the captured bytes, with unconditional checks added to the CI suites -
       written and verified are two separate acts, and the second happens by reading that run,
       not by predicting it. When the next Linux CI run is green, flip: mem.pressure -> true,
       disk.perDevice -> true, net.perInterface -> true, net.sockets -> 'partial',
       proc.io -> 'partial', scan.startup -> true, act.kill -> true, act.clean -> true. */
    caps: {
      /* temps ARE emitted by the plug, but the THERM page reads only t.sensors
         (LibreHardwareMonitor). Measured-and-discarded is not a capability. */
      'cpu.perCore': true, 'cpu.temps': false,
      'mem.hardFaults': true, 'mem.committed': true, 'mem.cache': true,
      /* PSI parser written + fixture-proven against captured bytes; the live suite now demands a
         measured value on a PSI kernel. Flip when CI agrees. */
      'mem.pressure': false,
      /* Per-device rows: emission was proven by the 2026-07-31 bridge sample; the strengthened
         live suite now demands rows named from /sys/block with numeric rates, and the stimulus
         suite demands they MOVE under a 200 MB write. Flip when CI agrees. */
      'disk.perVolume': true, 'disk.io': true, 'disk.perDevice': false,
      /* Same status as disk.perDevice, same round: flip when CI agrees. */
      'net.rates': true, 'net.perInterface': false,
      /* Implemented natively (/proc/net/tcp + tcp6 hex decode, owner join via /proc/<pid>/fd),
         parsers proven against captured kernel bytes cross-checked row-for-row with ss. Ceiling:
         'partial', never true - see the note. Flip to 'partial' when CI agrees. */
      'net.sockets': false,
      'proc.list': true, 'proc.cpu': true, 'proc.mem': true,
      /* Was 'partial' while the code emitted only nulls - a manifest claim the collector did not
         back, corrected 2026-07-31. Now implemented (own-session rchar/wchar); flip BACK to
         'partial' when the stimulus suite sees this process's own write in its own row. */
      'proc.io': false,
      'proc.faults': true,
      'gpu.total': 'partial', 'gpu.perAdapter': 'partial', 'gpu.perProcess': false,
      'power.battery': 'partial', 'power.rate': 'partial', 'power.health': 'partial',
      'power.wake': false,
      'scan.mft': false, 'scan.iotrace': false,
      /* Verified 2026-07-31: CI walked a real runner home on ubuntu-22.04 AND 24.04 - dirs, files,
         bytes and denials all counted, snapshot contract validated. The first Linux flag flipped
         by a green run rather than written from intent. */
      'scan.growth': true,
      /* Implemented (systemctl unit files + systemd-analyze blame + XDG autostart), parsers proven
         against captured bytes; the live suite now demands real rows from the route. Flip when CI
         agrees. */
      'scan.startup': false,
      'clip.history': false,
      /* act.kill / act.clean: the counting and escalation logic passed on both runners in the
         seam-driven suite; what was MISSING was real signals and the real target directory, and
         the CI now does both (a stubborn child that ignores SIGTERM; a genuine sweep of the
         production usercaches target). Flip both when CI agrees. */
      'act.restartApp': false, 'act.clean': false, 'act.kill': false, 'act.elevate': false,
      'host.frameless': 'partial', 'host.tray': false,
    },
    notes: {
      'cpu.temps': '/sys/class/thermal and hwmon, when the platform driver publishes them. Bare ' +
                   'metal usually does; VMs, WSL and CI runners do not - the absent case is ' +
                   'verified, the present case has never been seen and CANNOT be seen in CI.',
      'power.battery': 'Reads /sys/class/power_supply, handling both energy_* (uWh) and charge_* ' +
                       '(uAh, needing voltage) driver conventions. The no-battery case is verified ' +
                       'on WSL and both CI runners. A real laptop battery has not been read yet - ' +
                       'no CI host has one - so treat the first reading as unconfirmed and compare ' +
                       'it against upower.',
      'power.rate': 'Derived from power_now, or current_now x voltage_now where the driver reports ' +
                    'amps instead of watts. Sign comes from status. Unverifiable in CI; needs a ' +
                    'real laptop.',
      'power.health': 'energy_full vs energy_full_design. Unverifiable in CI; needs a real laptop.',
      'power.wake': 'The honest source would be `systemd-inhibit --list` (names the pid holding ' +
                    'each inhibitor, unprivileged). Its output is now captured by every CI run so ' +
                    'a future parser can be written against real bytes; nothing is implemented yet.',
      'proc.io': 'Own-session only, by kernel design: /proc/<pid>/io is mode 0400, so unelevated ' +
                 'it reads for this user\'s processes and nobody else\'s - foreign rows are null, ' +
                 'never zero. Counts rchar/wchar (all I/O the process issued, pipes and sockets ' +
                 'included - the semantic twin of the Windows IO counters these columns mirror).',
      'net.sockets': 'PARTIAL IS THE CEILING, not a stage: every TCP socket appears (read straight ' +
                     'from /proc/net/tcp and tcp6), but unelevated the OWNER resolves only for ' +
                     'this user\'s processes - /proc/<pid>/fd is unreadable for other users, and ' +
                     'ss -tanp on the CI runner showed the identical limit. Windows answers every ' +
                     'owner unprivileged; Linux answers root\'s sockets with pid null.',
      'gpu.total': 'amdgpu and i915 publish utilisation through /sys; NVIDIA requires nvidia-smi. ' +
                   'Whichever is absent is omitted rather than reported as zero. The populated ' +
                   'path needs real GPU hardware no CI runner has.',
      'gpu.perProcess': 'NEVER machine-wide without root: the Windows GPU Engine counters have no ' +
                        'vendor-neutral Linux equivalent. (Modern kernels expose per-client ' +
                        'engine time in /proc/<pid>/fdinfo for amdgpu/i915, but only for your own ' +
                        'processes and only per-driver - and no CI host has the hardware to prove ' +
                        'a parser, so none has been written.)',
      'mem.pressure': '/proc/pressure/memory (PSI): {some, full} avg10 percentages - the share of ' +
                      'recent time tasks stalled waiting for memory, the kernel\'s own verdict. ' +
                      'Parser proven against captured bytes from both runners; absent PSI ' +
                      '(pre-4.20, psi=0) yields null, never a fabricated calm.',
      'scan.mft': 'NEVER: the Master File Table is an NTFS structure and Linux roots are ext4/' +
                  'btrfs/xfs - there is nothing to parse, on any kernel, with any privilege. The ' +
                  'growth walker (growthscan.js, POST /api/growthscan) is the replacement here: ' +
                  'slower, filesystem-agnostic, and verified on this platform.',
      'scan.iotrace': 'NEVER unelevated: per-process I/O tracing needs blktrace or eBPF, both ' +
                      'root-only, and the bridge deliberately never runs privileged. An elevated ' +
                      'one-shot could exist someday; it would be a different feature.',
      'scan.startup': 'Three sources, all captured before parsing: systemd enabled unit files, ' +
                      'systemd-analyze blame joined on as measured boot cost, and XDG autostart ' +
                      '.desktop entries. Not covered: `systemctl --user` (needs a session bus a ' +
                      'headless host lacks) and cron @reboot lines - absent, not guessed.',
      'scan.growth': 'Verified 2026-07-31 on both CI runners: the walker walked a real home ' +
                     '(dirs, files, denials all counted) and /api/growth diffs the snapshots.',
      'act.kill': 'SIGTERM, then SIGKILL for survivors, denials counted. CI now proves it on real ' +
                  'processes, including one that ignores SIGTERM. Flip when that run is green.',
      'act.clean': 'User-owned targets (tmp, ~/.cache) with denials counted; CI now sweeps the ' +
                   'real usercaches target. No elevated targets: that needs polkit, see ' +
                   'act.elevate.',
      'clip.history': 'Requires a running X11 or Wayland session with xclip or wl-clipboard - a ' +
                      'thing no headless CI host has, so a watcher written today could not be ' +
                      'verified today. Unwritten until it can be proven on a real desktop.',
      'act.restartApp': 'Unimplemented: Linux has no LaunchServices - no reliable name-to-' +
                        'relaunch-command resolution exists (a .desktop lookup is a guess, and ' +
                        'relaunching a guess is worse than not relaunching).',
      'act.elevate': 'pkexec when a polkit agent is running, otherwise sudo in a terminal. Not ' +
                     'implemented: whether an agent is present decides everything, and that ' +
                     'cannot be written honestly from documentation.',
      'host.frameless': 'No WebView2 equivalent. The panel opens in the default browser in app mode; ' +
                        'edge-docking and always-on-top are the window manager\'s business, not ours.',
      'host.tray': 'Only exists where a native host process draws it, and no Linux host has been ' +
                   'built - this build has no tray, by fact rather than by omission.',
    },
  },

  /* ---------------------------------------------------------------- macOS
   * WRITTEN BLIND, THEN PROVEN IN CI. There is no Mac on this bench - every line was derived from
   * documented tool output - but as of 2026-07-31 the full suite has RUN on real Apple Silicon
   * (macos-14 + macos-15 runners, all green, first attempt), so entries proven by those runs now
   * say so individually. What a VM runner cannot have - battery, a populated GPU, thermals, a
   * human comparing the panel against Activity Monitor - is still unproven, and `verified` below
   * stays false until a physical Mac's evidence (tools/finish-on-a-mac.sh) comes back. */
  darwin: {
    name: 'macOS',
    collector: 'collect/darwin.js (sysctl, vm_stat, iostat, pmset, ps)',
    /* Still false - but the reason has narrowed. The 87-check simulation proved the LOGIC (and
       found three real defects, including a df parser that silently dropped the root volume); on
       2026-07-31 CI proved the FORMAT assumptions on real Apple Silicon, live, cross-checked
       against sysctl/df/ps. What `verified` still waits for is the part a VM cannot supply:
       battery internals, a GPU that publishes IOAccelerator statistics, thermals, and human eyes
       agreeing with Activity Monitor and System Settings. Run tools/finish-on-a-mac.sh on a
       physical Mac; it banks all of that, screenshots included. Then this becomes a dated
       sentence naming the hardware, like the Linux block's. */
    verified: false,
    verifyNote: 'PARTIALLY VERIFIED. On 2026-07-31 the full CI suite went green on real Apple ' +
                'Silicon, first try, both runners (macos-14 + macos-15): the live collector ' +
                'cross-checked against sysctl/df/ps, the bridge serving measured samples, ' +
                '/api/conns and /api/startup answering with real rows, a real pbcopy round-trip, ' +
                'the growth walker over a real Darwin home, and the Swift host compiled and ' +
                'launched. Flags proven by those runs are flipped below, each note saying so. ' +
                'Still unproven (runners are VMs): battery, populated GPU, thermals, the memory ' +
                'formula against Activity Monitor\'s verdict, and what anything LOOKS like - ' +
                'tools/finish-on-a-mac.sh on a physical Mac banks exactly that evidence, and ' +
                '`verified` flips when it comes back clean.',
    /* A flag here means "verified on this platform", not "the code exists" - writing the code
       and flipping the flag are deliberately two separate acts, and the second act happened for
       several of these on 2026-07-31 when the CI live suite went green on real Apple Silicon.
       Each flipped entry's note names its proof. */
    caps: {
      /* Corrected 2026-07-30 to match the CODE rather than the intent, corrected again 2026-07-31
         the OTHER way (everything implemented, every flag false pending hardware), and then, later
         that same day, CI ran the whole suite on real Apple Silicon - macos-14 and macos-15, both
         green, first try. The flags flipped below are EXACTLY the ones whose live checks are
         unconditional: per-core counts matched os.cpus(), per-device rows named diskN arrived, the
         top-faults join landed with real values, /api/conns saw the bridge's own listener with its
         pid resolved to a name, /api/startup returned real agents/daemons, the walker walked a
         real Darwin home, and a real pbcopy round-tripped the watcher. Flags whose live checks are
         CONDITIONAL on hardware the runners lack (battery internals, IOAccelerator GPU, the block-
         storage split) or that only prove emission-not-values (per-interface rates, pressure,
         wake) stay put until a physical Mac's evidence arrives - tools/finish-on-a-mac.sh. */
      'cpu.perCore': true, 'cpu.temps': false,
      'mem.hardFaults': true, 'mem.committed': false, 'mem.cache': true, 'mem.pressure': false,
      'disk.perVolume': true, 'disk.io': 'partial', 'disk.perDevice': true,
      'net.rates': true, 'net.perInterface': false, 'net.sockets': true,
      'proc.list': true, 'proc.cpu': 'partial', 'proc.mem': true, 'proc.io': false, 'proc.faults': true,
      'gpu.total': false, 'gpu.perAdapter': false, 'gpu.perProcess': false,
      'power.battery': true, 'power.rate': true, 'power.health': true, 'power.wake': false,
      'scan.mft': false, 'scan.iotrace': false, 'scan.growth': true, 'scan.startup': true,
      'clip.history': 'partial',
      'act.restartApp': false, 'act.clean': false, 'act.kill': false, 'act.elevate': false,
      'host.frameless': 'partial', 'host.tray': false,
    },
    notes: {
      'cpu.perCore': 'os.cpus() per-core tick counters, differenced between ticks like /proc/stat ' +
                     'on Linux. Verified on real Apple Silicon by the CI live suite 2026-07-31: ' +
                     'core count matches os.cpus(), values in range and not clones of the total. ' +
                     '(An earlier note here claimed per-core was impossible without a native ' +
                     'addon, which was never true.)',
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
      'proc.faults': '`top -l 1 -stats pid,faults` polled every 15 ticks, joined onto the ps rows ' +
                     'by pid - lifetime counts, the same quantity the Windows column shows. The ' +
                     'parser refuses any output whose header is not exactly PID/FAULTS, so a ' +
                     'reordered top yields null, never a misread column. Verified 2026-07-31: the ' +
                     'CI live run saw the join land with real values on both runners.',
      'disk.io': 'iostat gives COMBINED throughput; the read/write split is implemented one level ' +
                 'up, from IOBlockStorageDriver cumulative bytes differenced across a 5-tick poll - ' +
                 'an AVERAGE over that window, totals only, and unverified until CI\'s captured ' +
                 'ioreg output agrees. Busy percentage and queue depth remain null.',
      'disk.perDevice': 'Per-disk MB/s and tps from the iostat columns, named from its header ' +
                        'row. Verified 2026-07-31: the CI live run saw named diskN rows on both ' +
                        'runners.',
      'net.perInterface': 'Implemented: per-NIC rates differenced from netstat -ib. Unverified on ' +
                          'hardware.',
      'cpu.temps': 'Apple Silicon exposes thermals only through IOKit and powermetrics, and ' +
                   'powermetrics requires root. Omitted rather than faked.',
      'proc.io': 'Per-process disk I/O needs fs_usage, which requires root and disabling SIP on ' +
                 'some releases. Not worth the cost.',
      'net.sockets': 'inspect-posix.js: netstat -anv reports the owning pid for EVERY socket ' +
                     'unprivileged - lsof without root sees only your own - joined to names from ' +
                     'ps. The pid column\'s position is computed from the header, not hard-coded, ' +
                     'and an unrecognised header refuses rather than guesses. Verified 2026-07-31: ' +
                     'live /api/conns found the bridge\'s own :8790 listener, pid resolved to a ' +
                     'name, on both CI runners.',
      'scan.startup': 'inspect-posix.js: LaunchAgents and LaunchDaemons plists via plutil ' +
                      '(excluding /System, as the Windows scan excludes \\Microsoft\\), launchctl ' +
                      'state, and System Events login items - which need automation consent and ' +
                      'are reported as unavailable when refused, not as an empty list. Verified ' +
                      '2026-07-31: live /api/startup returned real entries in the macOS ' +
                      'vocabulary on both CI runners.',
      'clip.history': 'clipwatch-posix.js, and honestly weaker than Windows - hence partial, its ' +
                      'ceiling: text only, no source app (reading it would raise TCC prompts from ' +
                      'a background process), and polling pbpaste costs a fork per poll where ' +
                      'Windows polls a free counter - the watcher\'s header states the cost. Same ' +
                      'jsonl, same secret heuristics, same 24 h scrub. Verified 2026-07-31: CI ' +
                      'round-tripped a real pbcopy through it on both runners.',
      'host.tray': 'Implemented in the native host (NSStatusItem menu-bar item: show/hide, float ' +
                   'on top, quit-panel-not-bridge). Only exists when VitalsHost runs, and no ' +
                   'menu bar has ever drawn it - CI proves the build, human eyes prove the item.',
      'gpu.total': 'Implemented WITHOUT root: IOAccelerator\'s "Device Utilization %", the source ' +
                   'behind Activity Monitor\'s GPU history. The key names are the exact kind of ' +
                   'documented-not-observed assumption that has been wrong here before, so this ' +
                   'stays false until CI\'s captured ioreg output agrees.',
      'power.wake': 'Implemented: pmset -g assertions names the process holding the machine ' +
                    'awake, by pid, with no admin rights - something the Windows build cannot do ' +
                    'unelevated. Unverified on hardware.',
      'scan.growth': 'The portable walker (growthscan.js, POST /api/growthscan) writes snapshots ' +
                     'that /api/growth diffs. Covers what this user may read, not the whole disk. ' +
                     'Verified 2026-07-31: CI walked a real Darwin home - dirs, files, denials ' +
                     'all counted - and validated the snapshot contract, on both runners.',
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
