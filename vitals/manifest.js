/* VITALS - a system monitor that measures the machine it runs on and explains what it finds.
 * Copyright 2026 Ben M
 * SPDX-License-Identifier: Apache-2.0
 */
/* VITALS - WHAT THE PRODUCT IS, in one place.
 *
 * This list used to live inside pack.js, which was fine while packing was the only thing that
 * needed it. It is now also the answer to "what goes in the public repository", and two copies of
 * a security-relevant allowlist is how one of them quietly stops matching the other. A file added
 * to the shipped build but forgotten in the publish list is a broken repo; forgotten the other way
 * is a leak. One list, two consumers.
 *
 * The shape is deliberate: an ALLOWLIST. Everything in this folder is excluded unless named here,
 * so adding a file is a decision rather than a default. That is what keeps history/ (live
 * telemetry, Ask conversations, the clipboard log), shots/ and the owner's private notes out by
 * construction rather than by remembering.
 */

/* Files that make up a working install - what a user receives. */
const FILES = [
  // the application
  'bridge.js', 'ask.js', 'diagnose.js', 'history.js', 'journal.js', 'outcomes.js', 'ctl.js',
  'dashboard.html', 'start.js', 'vitals-mcp.js', 'pshost.js', 'package.json', 'VERSION',
  // the non-Windows action layer + the portable growth walker (and the elevated one-shot the
  // macOS clean action hands to the administrator prompt)
  'actions-posix.js', 'clean-admin.js', 'growthscan.js',
  // the non-Windows inspection layer (sockets, startup) and the macOS clipboard watcher
  'inspect-posix.js', 'clipwatch-posix.js',
  // collectors + their suites (the suites ship: they are how a new host proves itself)
  'collect/caps.js', 'collect/index.js', 'collect/win32.js', 'collect/linux.js', 'collect/darwin.js',
  'collect/test-linux.js', 'collect/test-linux-live.js', 'collect/test-linux-stimulus.js',
  'collect/test-darwin.js', 'collect/test-darwin-sim.js', 'collect/test-darwin-live.js',
  'test-routes.js', 'test-actions-posix.js', 'test-inspect-posix.js',
  // the self-verifying collector and its suite. Ships with the install for the same reason the
  // collector suites do: it is how a machine nobody has seen proves its readings agree with a
  // second, independent path into its own kernel.
  'selfcheck.js', 'test-selfcheck.js', 'selfcheck-live.js',
  // A2 + B1: the storage substrate that stores distributions rather than means, and the rewind
  // layer that points the rule engine at the archive. Their suites ship for the same reason the
  // collectors' do - they are how a machine nobody has seen proves the store round-trips.
  'hist.js', 'test-hist.js', 'replay.js', 'test-replay.js', 'test-history.js',
  // B5 + B6: per-workload percentiles, and the verdict that separates a heavy job from a
  // degraded machine by holding the workload fixed and varying only the machine.
  'workload.js', 'test-workload.js',
  // B4: proactive alerting, and the deeper hardware telemetry one-shot (B13/B14/B15).
  'notify.js', 'test-notify.js', 'hardware.ps1',
  // B16 + B18: the correlation subsystem, and the ledger read back to judge its own rules.
  'correlate.js', 'test-correlate.js',
  // ===========================================================================================
  // 2026-08-01. Everything below was written, reviewed four times, and was NOT IN THE PRODUCT.
  // pack.js caught it — nine FAILs, "this build is NOT shippable" — the moment anyone ran it,
  // which nobody had. Three review rounds asked "is this ready to ship" and none of them
  // executed the packager, which is the only thing that answers that question.
  //
  // THE TRAP IS THE DESIGN, AND THE DESIGN IS RIGHT: this list is an ALLOWLIST, so a new file is
  // excluded by default. That property is exactly what keeps the owner's screenshots, scratch
  // files and history out of a public repo — and it is exactly what silently dropped seven
  // runtime modules. Safe default, fatal omission, same mechanism. The rule that follows:
  // ADD TO THIS LIST IN THE SAME COMMIT THAT CREATES THE MODULE, and run `node pack.js` before
  // ever claiming something ships. A feature absent from here does not exist.
  //
  // The AI privacy layer: redaction by default, the access log, and the three permission tiers.
  'redact.js', 'test-redact.js', 'aiaccess.js', 'test-aiaccess.js',
  // Developer mode: the wiring/error surface, and the hash-bound per-diff edit approval.
  'devtools.js', 'devedit.js', 'test-devedit.js',
  // The automations engine — earned from the outcomes ledger, standard maintenance offered
  // outright, and the disruptive tier that only ever asks. Its suite ships for the same reason
  // the collectors' do: it is how a machine nobody has seen proves the refusals still refuse.
  'automate.js', 'test-automate.js', 'test-outcomes.js',
  // The screen read. Ships as of 0.9.9 with the three blockers closed: the grant is held IN
  // MEMORY (nothing on disk to forge, and a restart closes the window), the duration cap is
  // clamped on every READ rather than once at the door, and the grant is SCOPED TO A CALLER by a
  // token issued at /open — one human's permission is no longer everyone's permission.
  'peek.js', 'peek.ps1', 'test-peekgate.js', 'test-peeklive.js',
  // It was held out of this list on review's DO NOT SHIP, and the reason is kept because it is the
  // reason the current design looks the way it does: the grant used to be a FILE, so anything with
  // disk access could write itself one and never meet the passphrase — writing the file WAS turning
  // it on. Shipping that "off by default" would have been shipping a remote-controllable screen
  // reader, since off-by-default guards against accident and none of those paths was an accident.
  // The panel's own syntax check. `node --check` does not cover HTML, and a broken inline script
  // in dashboard.html produces a BLANK PAGE with an empty console — indistinguishable from a slow
  // fetch. This is the only thing that catches it.
  'test-dashboard.js',
  // B8 + B11: one scheduler for every periodic job, and the boot trial that measures this host
  // once and holds the verdict for the session without ever writing it down.
  'schedule.js', 'test-schedule.js',
  // B7 + B10: replaying a recorded moment (the only thing here that deliberately loads the
  // machine, hence the bounds inside it), and the reversible quarantine ladder.
  'reproduce.js', 'test-reproduce.js', 'quarantine.ps1',
  // B9 + B12: settings as experiments with receipts, and the governor that throttles background
  // work against measured foreground stall rather than against CPU load. sweep.js is also SERVED
  // to the panel at /sweep.js, so the significance bar has exactly one definition.
  'sweep.js', 'test-sweep.js', 'governor.js', 'test-governor.js',
  // Windows host + one-shots
  'panel.ps1', 'launch.ps1', 'metrics.ps1', 'winagent.ps1', 'clipwatch.ps1', 'mftscan.ps1',
  'iotrace.ps1', 'clean-admin.ps1', 'space-admin.ps1', 'filetools.ps1', 'badge.ps1', 'shot.ps1',
  'probe-ctl.ps1', 'measure.ps1', 'makeicon.ps1',
  // setup (the first-run experience)
  'setup.js', 'setup.html', 'Setup.cmd', 'setup.sh',
  // launchers + assets
  'vitals.cmd', 'vitals.sh', 'VITALS.exe', 'launcher.cs', 'vitals.ico',
  'lib/Microsoft.Web.WebView2.Core.dll', 'lib/Microsoft.Web.WebView2.WinForms.dll',
  'lib/WebView2Loader.dll',
  // docs a new install needs
  'INSTALL.md', 'INSTALL_FOR_CLAUDE.md', 'USING.md', 'LICENSE', 'NOTICE.md',
  // the macOS finishing kit: the process doc, the one-command runner, and the capture script it
  // and CI both use. They ship with the install because the person with the Mac is a user, not
  // necessarily a contributor with the repo.
  /* The CI workflow. It ships and it is in the repo because caps.js CITES a CI run as evidence,
     and an evidence claim whose evidence is not in the tree is the same defect as a capability
     manifest written from intent. Now anyone with the repository can re-run it. */
  '.github/workflows/verify.yml',
  'FINISH_ON_A_MAC.md',
  'tools/finish-on-a-mac.sh',
  'tools/capture-macos-fixtures.sh',
  // the native macOS panel host - source, not a binary. It is compiled by CI (and by anyone with
  // Xcode command line tools) rather than shipped built, because an unsigned binary downloaded
  // from the internet is worse than one you built yourself thirty seconds ago.
  'mac/VitalsHost.swift',
];

/* Files that belong in the SOURCE REPOSITORY but not in a user's install: the build itself.
   Someone reading the repo should be able to rebuild the artefacts; someone running VITALS has no
   use for the packer. Keeping the two lists separate is what lets both be complete. */
const REPO_ONLY = [
  'manifest.js', 'pack.js', 'bundle.js', 'publish.js', 'README.md',
  /* README images. ENUMERATED, NEVER GLOBBED - and this is the one place where naming each file is
     not bureaucracy. The publish scan reads text; it cannot look inside a PNG. A screenshot of a
     live monitor can carry an account name, a folder tree, a window bleeding through from behind,
     or the contents of somebody's desktop, and no automated check here will ever catch it. So the
     guard has to be that a human looked at each one, and the list IS that record: a new image
     cannot reach the repository without someone adding a line here.
     Every file below was reviewed. `diagnosis.png` is cropped because the full frame named the
     owner's Windows account in a growth finding. */
  'media/logo.svg',
  'media/overview-dark.png',
  'media/overview-light.png',
  'media/diagnosis.png',
  'media/memory.png',
];

/* Fixtures the Linux parser suite reads. Captured kernel text, no personal content - but enumerated
   explicitly rather than copying the folder, because the folder they live in is history/. */
const FIXTURES = ['stat.txt', 'meminfo.txt', 'diskstats.txt', 'net_dev.txt', 'uptime.txt',
                  'cpuinfo.txt', 'vmstat.txt',
                  /* PSI, captured from the 2026-07-31 ubuntu-24.04 CI run (kernel 6.17-azure) */
                  'pressure_cpu.txt', 'pressure_memory.txt', 'pressure_io.txt'];

module.exports = { FILES, REPO_ONLY, FIXTURES };
