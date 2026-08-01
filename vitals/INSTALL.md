# Installing VITALS

**Version 0.9.1.** Pre-1.0 on purpose: Windows is complete and measured, Linux is verified end to
end, macOS runs green in CI on real Apple Silicon but still awaits a physical Mac for its battery,
GPU and thermal paths (`FINISH_ON_A_MAC.md` is that process, one command), and the action layer
(kill, clean, restart, dials) is Windows-only. Those four facts are what 1.0 would have to close.


VITALS is a system monitor that measures the machine it runs on and explains what it finds. It is a
folder, a Node runtime, and nothing else — no service, no installer, no registry keys, no accounts,
no telemetry. Copy the folder, run one command.

One thing does leave the machine, and only when you press it: the network **speed test** transfers
data against `speed.cloudflare.com`. The only other thing that ever reaches the network is Ask, and
Ask ships disconnected — nothing until you press Connect.

**It binds to `127.0.0.1` only.** The bridge can kill processes and delete caches, so it must never
be reachable off-box. There is no "hosted" mode and there will not be one.

Binding to loopback is not the whole story, so VITALS does not stop there. A browser *on this machine*
can also reach loopback, and a cross-origin request needs no permission to be *sent* — only to be
read, which an attacker does not care about if the point was the side effect. So the bridge also
refuses any request carrying a non-loopback `Origin` (including the opaque `null` a sandboxed iframe
sends) or a non-loopback `Host` header, which is what DNS rebinding looks like. A page you happen to
be viewing cannot drive this machine.

---

## What you need

| | |
|---|---|
| **Node** | **18.15 or newer — unless you took a portable bundle, which brings its own and needs nothing.** The launcher only checks the major version, so 18.0–18.14 will start and then report no disks at all — `fs.statfsSync` arrived in 18.15 and the Linux/macOS collectors need it. |
| **Windows** | Nothing else on x64. PowerShell 5.1 ships with the OS and WebView2 ships with Windows 11 and modern Edge. **ARM64**: the frameless host is x64-only, so you get a browser window instead. **Non-English Windows**: performance counters are localized, so the collector cannot read them — see Troubleshooting. |
| **macOS** | Nothing else. `vm_stat`, `iostat`, `pmset` and `ps` are all part of the system. |
| **Linux** | Nothing else. Everything comes from `/proc` and `/sys`. A Chromium-family browser gets you a nicer window, but is optional. |

There are no npm dependencies. `node_modules` does not exist and nothing will try to create it.

---

## Install

### The short way: double-click Setup

If you downloaded a **portable bundle** — `vitals-0.9.1-win-x64.zip`, `-mac-arm64.tar.gz`,
`-linux-x64.tar.gz` and so on — the Node runtime is already inside it. Nothing needs installing
first, on any platform.

| Platform | Unpack | Then |
|---|---|---|
| **Windows** | Right-click the .zip → Extract All | Double-click **`Setup.cmd`** |
| **macOS / Linux** | `tar -xzf vitals-0.9.1-<target>.tar.gz` | `cd` in and run **`./setup.sh`** |

Setup verifies every file it shipped with, finds the runtime, probes what this platform can measure,
then takes a real reading of your machine and shows it to you. There is no progress bar estimating
anything: the numbers on that screen are the work it actually did. When it finishes, VITALS is
already running — the button just opens the window.

It offers a few optional extras (Start-menu entry, desktop shortcut, start at login, and letting
Claude Code read this machine). **All of them are off**, and setup writes nothing outside its own
folder unless you tick one. Options this platform cannot honour are not shown at all.

> Use `.tar.gz` rather than `.zip` on macOS and Linux even if both are offered. Zip does not carry
> the executable bit, so an unzipped copy gives you a `node` and a `setup.sh` that refuse to run.

### The plain way: one command

```bash
node start.js
```

Skips setup entirely and needs Node 18.15+ already installed. `start.js` checks your Node version,
prints what the collector on this platform can and cannot measure, starts the bridge on port 8790,
and opens the panel.

Platform launchers exist so you do not have to remember that:

| Platform | Launcher | Notes |
|---|---|---|
| Windows | `VITALS.exe` | Pin this one — it carries the icon. `vitals.cmd` is the terminal equivalent. |
| macOS | `./vitals.sh` | `chmod +x vitals.sh` first. |
| Linux | `./vitals.sh` | `chmod +x vitals.sh` first. |

Add `--no-window` to run the bridge headless — useful when you only want the MCP server, or intend
to open the panel in a browser yourself. **This works for `vitals.cmd`, `vitals.sh` and
`node start.js` only.** `VITALS.exe` ignores it and opens the panel regardless, as does passing it
to `launch.ps1`.

---

## What you get on each platform, honestly

The panel was built on Windows against performance counters that expose an unusually complete
picture. Not all of it ports. Rather than paper over the gaps, VITALS declares them: a feature the
host cannot measure is **absent from the panel**, not drawn at zero, and the FOOTPRINT page lists
every gap with the reason.

This matters more than it sounds. A gauge reading 0% while the thing it measures is genuinely busy
*answers* the question wrongly; a missing gauge *prompts* the question. VITALS learned this the hard
way on Windows, where reading only the discrete GPU showed "GPU 0%" on a machine whose integrated
GPU was doing all the work.

### Read this first: the collector is ported, the action layer is not

VITALS has two halves. The **collector** — the live telemetry behind every ring, chart and
diagnosis — runs on all three platforms. The **action and scan layer** — the startup scan, expanded
process list, network connections, speed test, disk cleanup, kill and restart-app, the CTRL dials,
the MFT and growth scans — is implemented as PowerShell one-shots and works **only on Windows**.

On macOS and Linux those routes return a `501` naming themselves, and `caps.js` declares them
`false` so the panel hides them rather than showing pages that error. They are absent because they
are unported, not because the platform can't do them — Linux could do nearly all of it.

So: **live monitoring and diagnosis are cross-platform today. Acting on what you find is not.**
If you need parity, the collector is the hard part and it is done; the rest is scheduled work.

### Windows — the reference implementation
Everything works. Per-core CPU, per-process CPU/memory/disk I/O, per-adapter and per-process GPU,
hard fault rates, NTFS master-file-table scanning, battery health, every action, the lot.
CPU temperature is the one gap: Windows exposes none to unprivileged code, so it appears only if
LibreHardwareMonitor happens to be running.

### Linux — nearly everything, and run for real
Per-core CPU, memory with correct available/cached accounting, per-device disk I/O, per-interface
network, per-process CPU and memory, battery including charge rate and health, thermal zones.

Verified end to end on Ubuntu 22.04 (kernel 6.6.87.2): 37 correctness checks cross-referenced
against `df`, `free -m`, `nproc` and `/proc/meminfo` — independent sources, because a collector
agreeing with itself proves nothing — plus 6 stimulus checks confirming the counters actually move:
idle 0–2.7% → 100% under an all-core burn with every core registering, 136 MB/s on a 200 MB fsynced
write, 0.33 MB/s on a measured HTTPS pull.

**What that run could not exercise:** the host was a VM with no battery, no GPU under
`/sys/class/drm`, and no thermal zones. Those code paths were only proven to return nothing
*correctly*. The first time you run this on a real laptop, compare the battery figures against
`upower -i` and tell us if they disagree.

Missing or reduced:
- **No actions or scans at all** — see the section above. Startup, connections, cleanup, kill,
  restart-app, growth and MFT are PowerShell and return 501 here.
- **Per-process disk I/O covers your own processes only.** `/proc/<pid>/io` is root-only for other
  users' processes, so the column is omitted rather than shown as a partial total pretending to be
  a complete one.
- **GPU depends on the driver.** AMD publishes real utilisation through `/sys`. Intel publishes
  frequencies, which are not utilisation, so an Intel GPU is listed without a number rather than
  with a fabricated one. NVIDIA needs `nvidia-smi`.
- **CPU temperature is collected but not yet displayed.** The plug reads `/sys/class/thermal`; the
  thermal page still only reads LibreHardwareMonitor. Declared `false` until the page consumes it —
  measured-and-discarded is not a capability.
- **The window has a title bar.** There is no WebView2 equivalent, so the panel opens in a
  Chromium-family browser in app mode. Always-on-top and edge-docking are your window manager's
  business.

> **A caution about the verification above.** The Linux host was WSL2, and `spawn('powershell.exe')`
> *succeeds* from WSL through Windows interop. That means WSL is the one Linux where every
> PowerShell dependency is invisible, and a green suite there proves nothing about a real Linux
> desktop. The collector results stand — they read `/proc` and `/sys` directly. Everything else
> above was found by code review, not by that test run.

### macOS — written, not verified

> **The macOS collector has never been run on real hardware.** It was written from documented tool
> output on a machine that has no Mac. The panel says so in its header and on the FOOTPRINT page,
> and it will keep saying so until someone runs it and confirms the numbers.

If you are that person: launch it, compare every figure against Activity Monitor, and correct
`collect/darwin.js`. When the numbers hold, set `verified` in `collect/caps.js` and delete the
warning banner at the top of `darwin.js`. Until then, treat what it reports as a first draft.

Expected gaps regardless of verification:
- **No GPU utilisation** — needs `powermetrics`, which needs root.
- **No per-process disk I/O** — needs `fs_usage`, root, and on some releases a weakened SIP.
- **No CPU temperature** — IOKit and root again.
- **Coarser per-core CPU** — `host_processor_info` needs a native addon, so the per-core strip is
  hidden rather than filled with copies of the average.
- **System caches are left alone.** `~/Library/Caches` is fair game; anything under SIP is not.

---

## Ask ships disconnected

**Ask is off on a fresh install, and nothing has been sent anywhere.** Open the Ask page and it shows
what connecting would do, then one button. Until you press it, no Claude process is started and no
description of your machine leaves the machine.

That is enforced in the bridge, not just the page — a request to `/api/ask` while disconnected is
refused outright rather than quietly starting something.

Disconnecting later leaves your model, effort and API key settings alone. Turning a thing off should
not discard how you had it set up.

In **viewer mode** you cannot connect it or change its credentials. Connecting Ask is the one control
that sends machine data off the box and spends a subscription, so it belongs to whoever holds admin.

## Ask, and the API key

The **Ask** page runs a Claude conversation inside the panel, grounded in the machine's live
telemetry. It shells out to the Claude Code CLI, so it has two ways to authenticate:

1. **Subscription** — if you have run `claude` once on this machine and logged in, Ask uses that
   login and costs nothing beyond your subscription. This is the default and needs no setup.
2. **API key** — click the `auth` chip in the Ask header and paste one. This is the path for a
   machine that has the CLI installed but is not logged into it.

The key is stored **outside the install folder** — `%LOCALAPPDATA%\vitals\ask-config.json` on
Windows, `$XDG_DATA_HOME/vitals/` (usually `~/.local/share/vitals/`) elsewhere. That is deliberate:
Ask runs with the VITALS folder as its working directory, so a key kept inside it would be reachable
by any file tool. Out of scope beats a list of denied tools. It is never returned by any API (the
panel only ever
learns whether one is set and its last four characters), and is excluded from support bundles.

The model and effort dropdowns beside it are passed straight through to the CLI. Leave them on
`default` to use whatever your CLI would pick on its own.

Ask runs with `cwd` set to the VITALS folder and edits enabled, which means **it can modify VITALS
itself** — ask it for a new tool and it will write one. Reload the window afterwards with
**Ctrl+Shift+R**; a plain Ctrl+R serves the cached page and you will think nothing happened.

---

## Putting it on another machine

The folder is self-contained and position-independent — no absolute paths, no user names, no drive
letters baked in. Copy it to a USB stick and run it from there if you like.

1. Copy the folder.
2. Delete `history/` if you do not want the previous machine's records travelling with it. It holds
   telemetry history, the event journal, the clipboard log and your Ask conversation.
   Your **API key and admin passphrase are not in there** — they live in `%LOCALAPPDATA%\vitals\`
   (or `~/.local/share/vitals/`), so they do not travel with a copied folder at all. Clear those
   separately if you are handing the machine on.
3. Make sure Node 18+ is on the target.
4. Run the launcher for that platform.

To make it fully self-contained, drop a Node build into `runtime/` — `runtime/node.exe` on Windows,
`runtime/bin/node` elsewhere. Both launchers prefer it over the system Node, so the target machine
needs nothing installed at all.

---

## Testing a collector

Twelve suites, and it matters which is which — they prove different amounts.

| Command | Runs on | What a pass actually means |
|---|---|---|
| `node collect/test-linux.js` | any platform | Parsers handle **real kernel text** captured from a running Linux box. Proves the field offsets. |
| `node collect/test-linux-live.js` | Linux only | Runs the whole collector and checks it against `df`, `free -m`, `nproc`. **Real verification.** |
| `node collect/test-linux-stimulus.js` | Linux only | Applies known CPU, disk and network load and checks the numbers move. Proves it reads *reality*, not plausible constants. |
| `node collect/test-darwin.js` | any platform | Two parsers against synthetic fixtures. **Not verification.** |
| `node collect/test-darwin-sim.js` | any platform | Drives the **whole** macOS collector from fixtures through an injection seam — 64 checks covering the memory maths, `ps` aggregation, `netstat` dedup, battery conversion, rate differencing, null discipline. Proves the **logic**, not the format assumption. |
| `node collect/test-darwin-live.js` | macOS only | The real thing. Cross-checks against `sysctl`, `df`, `pmset`, and tells you what to confirm by eye in Activity Monitor. |
| `node test-selfcheck.js` | any platform | The self-check's own arithmetic: independence gating, the bound invariant, median verdicts, the refusal to judge too early. Uses stubs — it would pass on a kernel where the two "independent" sources are secretly the same file. **Not verification.** |
| `node selfcheck-live.js` | any platform | Runs the real collector against the real second source and prints the agreement record. **This is the verification**, and it is what `self.verify` in `collect/caps.js` is flagged from. |
| `node test-hist.js` | any platform | The histogram substrate. Measures the realised quantile error against raw samples on every distribution shape these metrics take, and asserts it against the 2% the module claims. A bound that is asserted rather than measured is not a bound. |
| `node test-history.js` | any platform | Rollups round-trip through the disk with distributions intact; rows from earlier builds are still read; both formats coexist inside one query window; compaction verifies an archive **before** removing its source. |
| `node test-replay.js` | any platform | REWIND. The engine runs at a past moment, reports what the archive could not answer, and refuses to fabricate a correlation the store never recorded. |
| `node test-workload.js` | any platform | Per-program percentiles, and the B6 separation: it builds a heavy-job scenario and a degraded-machine scenario that are **identical from any machine-wide average**, and asserts they get opposite verdicts. |

### Why simulated tests still earn their keep

They cannot prove macOS emits what we assumed. They can and did prove the code around that
assumption is wrong. Three real bugs came out of them:

1. `vm_stat`'s quoted keys (`"Translation faults":`) kept a stray quotation mark, so every lookup of
   a quoted key silently missed.
2. Installed RAM was read from **two different sources** — `hw.memsize` for the static event,
   `os.totalmem()` for every tick. Identical on ordinary hardware, divergent under a VM or a memory
   limit, and the panel would have shown a machine whose total RAM depended on which line you read.
3. The `df` parser located the mount point with `indexOf`. For the root volume the mount is `/`, and
   the first `/` in the line sits inside `/dev/disk3s1s1` at index 0 — so the mount came back as the
   whole line, matched the `/dev` exclusion, and **silently dropped the main disk.**

A test that cannot verify can still falsify. That third one would have shipped.

### Checking the collector against itself, on any machine

```bash
node selfcheck-live.js --samples 16
```

This is the one to run on a machine nobody has seen. It reads a second, **independent** path into
the kernel — `os.freemem()` reaches `GlobalMemoryStatusEx` / `sysinfo(2)` / `host_statistics64`, a
different route from the one the collector takes — and reports how closely the two agree. It exits
nonzero if any comparison disagrees **or** if too few samples arrived to say anything, because "we
could not check" and "we checked and it was fine" are different results.

On Linux it will tell you two of the three comparisons are **not run**: libuv reads the same
`/proc/stat` and `/proc/uptime` the collector does, so those comparisons could not fail. That is
reported rather than counted — a check that cannot fail manufactures confidence.

### If you have a Mac

```bash
bash tools/capture-macos-fixtures.sh
```

Read-only, no admin, one output file, `--redact` masks MAC addresses. That capture replaces the
synthetic fixtures with real ones and turns the simulation into verification. If Node 18+ is also
present, `node collect/test-darwin-live.js` is the stronger move.

## Two modes

**Admin** is the default: the technician's tool, everything available.

**Viewer** reads the machine and reports on it, and changes nothing about it. Diagnosis, history,
journal and the live telemetry all work; kill, clean, restart-app, the dials and the elevated scans
are refused.

It also withholds anything that names your **files**: the MFT index, the growth and big-directory
scans, the file tools, saved clipboard images and the support bundle. And the findings it does show
are stripped of paths and of your account name — so a viewer session sees *how the machine is
performing*, not *what is stored on it*. Its own theme and layout stay yours — viewer mode is about the machine, not about forbidding
you a colour scheme.

It is enforced at the **bridge**, not in the UI. Hiding buttons would be theatre: the bridge listens
on a port, and anything that can reach it could call the route the button would have. So the router
refuses, and the panel hides those controls as a *consequence* rather than as the mechanism.

Switch to viewer on the FOOTPRINT page, under *"this install · what it can do"*. Coming back is
deliberately not symmetric — a restriction the restricted party can lift is not a restriction:

- **With a passphrase** (set it while in admin): an *Unlock admin* button appears in viewer.
- **Without one**: relaunch with the mode set — `$env:VITALS_MODE='admin'; node start.js`

A passphrase is a guardrail against mistakes and casual poking. It is **not** a security boundary:
anyone with a shell here can set the environment variable, edit `history/mode.json`, or delete the
stored hash. A real boundary means running the bridge under an account the viewer cannot write as.

## What the Ask panel can see

Worth knowing before you use it, because the answer is not "nothing until you ask".

**Every question carries a short machine summary** — CPU, memory, disk, GPU, battery, and the ranked
diagnosis. That summary is deliberately **anonymous**: no process names, no account names, no paths.
It reports "16 processes running" and leaves it there.

**Detail is fetched, not shipped.** When a question genuinely needs to know what is running, the
model calls `vitals_processes`; for what grew, `vitals_growth`; for when it changed,
`vitals_journal`. That costs a round-trip and means identity leaves the machine only when a question
actually required it.

**It can read and write files in this folder** — that is how you can ask it for a new tool and get
one. Two things stay out of its reach, by different means. Your **API key and admin passphrase are
not in this folder at all** — they live in `%LOCALAPPDATA%\vitals` (or `~/.local/share/vitals`),
outside the directory Ask runs in, so no file tool can reach them. The **clipboard log** does live
here, and is denied explicitly at the tool layer.

Out of scope is the stronger of the two, and deliberately so: a deny list is only as good as its
last update, and this one grew a rule every time someone found a way around it.

**In viewer mode it drops to read-only** and knows why — it will tell you the install is in viewer
mode and how to restore admin, rather than reporting a tool failure.

## Popping the chat out

The Ask page has a **pop out** control that opens the conversation in its own window. Both windows
watch the same server-side stream, so the thread stays identical and closing either one does not
interrupt a running answer — the run belongs to the bridge, not to the window that started it.

Closing the main panel closes its pop-outs. Minimising does not: minimise the panel and keep the chat
up on its own, which is the most useful arrangement of the two. The bridge keeps running either way —
"close the window, keep the record" is deliberate, and history, journal and diagnosis carry on.

## Ports

`8790`. Override with the `VITALS_PORT` environment variable. It deliberately avoids `8787`, which
belongs to a different tool on the author's machine.

`bridge.js`, `start.js`, `vitals.cmd`, `vitals.sh` and `vitals-mcp.js` all read `VITALS_PORT`, so two
installs can run side by side.

**`VITALS.exe` and `launch.ps1` do not** — they are hard-wired to 8790. Set `VITALS_PORT` and launch
from the pinned icon and you get a misleading "Node.js is not installed" dialog, because the bridge
came up on your port while the launcher waited on 8790. Use `vitals.cmd` for a non-default port until
that is fixed. For the same reason, a second install launched from `VITALS.exe` will open a panel
onto the *first* install if one is already running.

## Troubleshooting

**"needs Node 18 or newer"** — `node --version` will tell you what you have.

**Panel opens but stays empty** — the bridge is up but the collector is not producing. Run
`node start.js --no-window` in a terminal and read the output; the collector prints its own errors.

**A gauge you expected is missing** — that is the design. Open the FOOTPRINT page; the "this install"
section names every capability this host lacks and why.

**Edits do not appear** — hard reload with Ctrl+Shift+R. The WebView caches the page.

**The panel never appears, and nothing says why (Windows).** If this folder came out of a downloaded
`.zip`, Windows has marked every file and .NET refuses to load marked assemblies. VITALS unblocks its
own DLLs on launch, but if you are still stuck, clear the whole folder:

```bash
Get-ChildItem -Recurse . | Unblock-File
```

**ARM64 Windows** (Surface, Copilot+): the bundled WebView2 loader is x64-only, so the frameless host
cannot run. VITALS detects this, says so, and opens a browser window instead. Everything else works
normally.

**Non-English Windows**: .NET resolves performance counters by their *localized* name, so the English
names VITALS uses will not resolve and CPU, memory, disk and network cannot be read. It detects this,
prints the reason, and reports those capabilities as unavailable rather than as zero — you will see
gaps, not wrong numbers. This is a known limitation, not a fault on your machine.
