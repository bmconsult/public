# Using VITALS

Installation is covered in `INSTALL.md`. This is about what to do with it once it is running.

---

## The one idea worth knowing first

**VITALS never shows you a number it did not measure.**

That sounds like a slogan; it is actually the rule that shapes everything else. If a gauge is
missing, it is missing because this machine cannot measure that thing — not because it is idle, not
because something failed quietly. A reading of `0%` means genuinely zero. A dash means *not
measured*. An absent panel means *not available here*, and the FOOTPRINT page will tell you why.

This matters because the opposite is the normal failure of monitoring tools. A gauge stuck at zero
while the thing it watches is pegged *answers* your question — wrongly, and confidently. A blank
*prompts* it. So VITALS would rather show you nothing than show you something plausible.

---

## Where to start when something is wrong

**Go to DIAG first.** Not the rings, not the charts — the ranked diagnosis. It reads the last several
minutes rather than this instant, and it tells you what is wrong, what the evidence is, and what to
do about it.

The ranking is by consequence, not by number. A disk at 94% is a bigger problem than a CPU at 94%,
because the CPU will be fine in a minute and the disk will not.

Two habits that make it useful:

- **Sustained, not instantaneous.** A rule fires when something has been true for a while. If you
  glance at the CPU ring at the wrong second you will see a spike; the diagnosis will not report it,
  and the diagnosis is right.
- **Findings come with a lever.** Where there is something to do, the finding says so and points at
  the page that does it.

---

## The pages, and what each is actually for

| Page | Ask it |
|---|---|
| **OVERVIEW** | "Is anything wrong right now?" The rings are the last few minutes, not a snapshot. |
| **DIAG** | "What is wrong, ranked, with evidence." Start here. |
| **CPU / MEMORY / STORAGE / NETWORK** | "Which process, and since when?" |
| **THERMALS & POWER** | Battery health, charge rate, how far the pack has degraded. |
| **GROWTH** | "What got bigger while I was not looking?" Diffs the filesystem over time. |
| **RECLAIM** | "What can I safely delete, and how much will it give back?" Sized before you act. |
| **STARTUP** | What launches at boot, and which of it is not Microsoft's. |
| **SYS** | The event journal — what changed, and when. |
| **WORKLOADS** | What each program costs in percentiles, and whether this run is unusual for it. |
| **REWIND** | "Why was it slow yesterday at 2pm?" Runs the diagnosis at any past moment. |
| **FOOTPRINT** | What VITALS itself costs, what this install can and cannot do, and whether its own readings agree with a second source. |
| **TOOLS** | Clock, stopwatch, clipboard history, port lookup, watches. |
| **ASK** | A Claude conversation about this machine. Off until you connect it. |

---

## Reading memory correctly

The single most misread number in any monitor.

**"Free RAM" near zero is normal and healthy.** Windows and Linux both fill unused memory with a file
cache and release it the instant something needs it. A machine with 200 MB "free" and a large cache
is working correctly.

**The number that matters is hard faults** — pages fetched back from *disk* because they were not in
memory. Sustained triple digits is thrashing, and that is what you actually feel as slowness. VITALS
puts it on the memory page as "the stall predictor" for exactly this reason.

If hard faults are high and disk is also full, those two are feeding each other: the pagefile has
nowhere to grow, so paging gets slower, so more pages queue. Fix the disk first.

---

## Reclaim: what is safe

The RECLAIM page sizes every target before you touch it, and labels each one.

- **Safe** — caches and temp files the system rebuilds on demand.
- **Deliberate** — things with a real trade, stated. Hibernation frees a lot but disables fast
  startup; capping the pagefile frees a lot but reduces headroom for large allocations.
- **Surfaced, not automated** — the Recycle Bin is shown with its size and never emptied for you.
  Deleting someone's files is not a thing software should do on its own initiative.

Anything needing admin rights raises a single UAC prompt for that one operation. The bridge itself
never runs elevated — that is deliberate, and it is why elevation appears when it does.

Afterwards the outcomes ledger records what was actually freed, measured rather than estimated. If a
cleanup claimed 9 GB and gave back 200 MB, the ledger will say so.

---

## Ask: what it knows, and what it does not

**It is off until you connect it.** Open the Ask page and it tells you what connecting would do,
then offers one button. Nothing is sent anywhere before you press it — that is enforced in the bridge,
not just hidden in the page. Disconnecting later keeps your model, effort and key settings.

**It always receives** a short anonymous summary with every question: CPU, memory, disk, GPU,
battery, and the ranked diagnosis. Deliberately anonymous — **no process names, no account name, no
paths**. It sees "16 processes running", not what they are.

**It fetches detail only when a question needs it.** Ask "what is using the most memory" and it will
call for the process list. Ask "why is my disk full" and it will not.

**It can read and write files in the VITALS folder** — that is how you can say "add me a tool that
does X" and get one. Reload the window with **Ctrl+Shift+R** afterwards; a plain reload serves the
cached page.

**Your secrets are out of its reach by construction, not by rule.** The API key and the admin
passphrase do not live in the VITALS folder at all — they are in `%LOCALAPPDATA%\vitals` (or
`~/.local/share/vitals`), outside the directory Ask runs in, so no file tool can reach them. The
clipboard log stays in the folder and is denied explicitly at the tool layer.

That distinction matters: a denied path is a list someone has to keep complete, and out-of-scope is
not.

Good questions to ask it:

- *"Why is this machine slow right now?"*
- *"What should I clear next, and what will it cost me?"*
- *"Read the journal and tell me what changed today."*
- *"Has this been getting worse over the last week?"*

It is grounded in measurements, so it will tell you when it does not have enough to answer rather
than guessing. That is the point of it.

---

## Two modes

**Admin** is the default — the full technician's tool.

**Viewer** reads and reports but changes nothing. It also withholds anything that names your
**files** — the MFT index, growth and big-directory scans, the file tools, saved clipboard images and
the support bundle — and strips paths and your account name out of the findings it does show. So it
reports how the machine is *performing*, not what is *on* it.

Use it when handing the machine to someone else, or when you want to be sure you cannot fat-finger a
process kill. Switch on the FOOTPRINT page. It cannot connect Ask or change its credentials either,
since that would send data off the machine.

Getting back needs a passphrase you set beforehand, or a relaunch with `VITALS_MODE=admin`. That
asymmetry is deliberate: a restriction the restricted party can lift is not a restriction.

**It is a guardrail, not a security boundary.** Anyone with a shell on the machine can undo it. If
you need a real boundary, that is operating-system work — run the bridge as an account the other
person cannot write as.

---

## Windows and panels

- **Drag the top strip** to move the panel. Drag it to a screen edge to dock it as a sidebar or
  topbar; drag away to restore.
- **Keys**: `1`–`9`,`0` switch pages, `Esc` returns to the overview, `Shift+Esc` closes the panel,
  `T` cycles the theme. They do not fire while you are typing in a text field.
- **Pop the chat out** from the Ask page — it opens in its own window, shares the same conversation,
  and closing either window never interrupts a running answer.
- **Window controls collapse to one ⋯ button** in every mode, so they do not sit on top of the
  header. Click it to expand.
- **Docked, the whole strip drags** — except its controls. The clock, the stopwatch buttons and the
  metric tiles all still respond; press anywhere else to move the window.
- **Link straight to a page.** `http://127.0.0.1:8790/?page=footprint` opens on FOOTPRINT rather
  than the overview — any page name from the rail works, and so does `#footprint`. Two uses: a
  second window can sit pinned to one page beside the first, and a bug report or a screenshot can
  name the exact view it is about. An unknown name just opens the panel normally.
- **Closing the panel does not stop VITALS.** The bridge keeps collecting, so history, the journal
  and the diagnosis carry on. Reopen and nothing was lost. Minimise instead if you want to keep the
  chat window up on its own.

---

## Changing your mind about the setup options

Run **Setup** again — `Setup.cmd` on Windows, `./setup.sh` elsewhere. It is not a one-time thing.

It reads the current state of every option and starts with those boxes already ticked, so you can
see what you chose the first time. **Unticking removes it**: the shortcut is deleted, the MCP server
is unregistered. The button tells you how many changes it is about to make before you press it.

Re-running is otherwise harmless. It re-verifies the files, re-reads the machine, and notices the
bridge is already up rather than starting a second one.

---

## Asking VITALS from somewhere else

The MCP server exposes the telemetry as tools, so your own Claude sessions can ask about the machine
without you opening the panel. Setup is in `INSTALL.md`.

Two things to know:

- **The bridge must be running.** The tools talk to it, not to the files.
- **It is read-only unless you say otherwise.** The action tools are not registered at all without
  `--allow-actions`, and it will not start the bridge for you unless you pass `--autostart`.

---

## Workloads: is it the machine, or is it the job?

Two complaints sound identical and have opposite fixes:

> *"The export is slower than it used to be."*

Either the export is doing more work than it used to, or the machine is worse than it used to be.
**Every tool in this category conflates them**, because from a machine-wide average they look the
same: high CPU, high I/O, slow. Getting it backwards wastes an afternoon in either direction — you
either clean a disk that was fine, or you shrug at a machine that is genuinely degrading.

**WORKLOADS** tells them apart, and the trick is what it compares against. Each time a program runs,
VITALS records two things: what that program cost, **and what the machine was like while it ran**.
So the question becomes two questions:

| | compared against | answers |
|---|---|---|
| Is the **job** heavier? | this program's own past runs | the work grew |
| Is the **machine** worse? | *the machine during this program's past runs* | something else is competing |

The second comparison is the one that makes this work. Measuring contention against the machine's
all-time average would simply rediscover that you are running something heavy — which is the
complaint, not the cause. Measuring it against *what this machine was like the last twenty times you
ran this same program* holds the workload fixed, so what is left is the machine.

Four possible answers, and each gets a different sentence: nothing unusual · **the job** · **the
machine** · **both**, which is two problems with two fixes and is said as such.

**It refuses until it can mean it.** Three past runs minimum before "usual" is allowed to mean
anything — a verdict from one prior run distinguishes nothing while sounding exactly as confident as
one from twenty. Early on the column reads *learning*, and that is the honest state.

### Reading the percentiles

Each program shows **p50**, **p95** and **p99**, not an average, plus a spread bar from p50 to p95
with a tick at p99. Two programs with the same average look identical in every number and completely
different in that bar.

The two upper percentiles do different jobs, and both are needed:

- **p95** answers *"is the normal case worse than it used to be"*.
- **p99** answers *"how bad are the bad moments"*. A program that hitches on 3% of samples is exactly
  what people describe as stuttering, and **p95 cannot see it** — the 95th percentile sits below the
  hitches by construction. Reporting only p95 would silently choose which kind of slowness this
  product is able to notice.

### The one caveat, stated plainly

The process list VITALS reads is a **top sixteen by memory**. A program that never enters it has no
record here at all, and one that drops out has a gap in observation rather than an ending. Sessions
are therefore periods of *observed activity*, not process lifetimes — a program going quiet for a
while is stitched back together rather than counted as two runs, and a genuinely new set of process
IDs is what marks a real restart.

---

## Rewind: what was wrong at 2pm yesterday

Every other tool on this machine answers *now*. Reliability Monitor shows crashes rather than
pressure. Event Viewer logs events, not utilisation. `perfmon /report` is a sixty-second snapshot
and says outright that it cannot detect historical patterns. WPA records everything and needs you
to have started the trace **before** the problem, which nobody does.

VITALS has kept the record all along. **REWIND** points the same diagnosis engine at it — the rules
are not a second copy, so what you read is what the engine would have said at the time.

**The axis is logarithmic in age.** The last ten minutes get as much width as the last ten weeks, so
a quarter of history sits on one screen. Drag anywhere along the band and the diagnosis follows.
Zooming became scrolling, so there is neither.

Reading the band:

- **Each bar is one column of time** — its height is the spread from the minimum to the 95th
  percentile within that column, with a solid cap at the median. A calm minute and a violent one
  look different, which is the entire reason the store keeps distributions instead of averages.
- **Shaded columns hold a record with no distribution.** They were written before the store kept
  them, so *"did this hold, or did it merely peak?"* cannot be asked of that moment. The numbers are
  still there; that one question is not answerable.
- **Gaps are gaps.** The machine was off. Nothing is drawn through them — a line joined across a
  power cut is the most legible possible lie.

**It always tells you what it could not ask.** The archive holds what was archived: process names,
battery state and committed bytes were never rolled up, so the rules that read them cannot run at a
past moment. Those rules would otherwise skip in silence and leave a short list that reads as a
calm machine, so the right-hand panel names every one of them. A rewound diagnosis is systematically
shorter than a live one, and that is a fact about the record rather than about the day.

If a moment has no record at all, it says so — and says explicitly that an absence of evidence is
not a clean bill of health.

---

## Percentiles, and why the store keeps distributions

A mean hides exactly the thing people complain about. A minute that ran evenly at 12 ms and a minute
that ran at 8 ms with four 108 ms hitches have the **same average**, and only one of them stutters.

So the rollups store a distribution per metric per minute rather than a min/average/max. Two things
follow. p50/p95/p99 become answerable over any span — and they are *not* recoverable after the fact
from a stored mean, so this had to change at write time or never. And because distributions merge
exactly, an hour is the sum of its sixty minutes and a quarter is the sum of its minutes: one stored
resolution answers every zoom level, which is what makes REWIND's axis possible at all.

Quantiles carry a stated accuracy of 2% relative, measured rather than claimed — the suite checks
the recovered percentile against the raw samples on every distribution shape these metrics take.

It costs less disk than the format it replaced. Finished days are compacted; measured on the
author's machine, 90 days of the richer format is about 36 MB against the old format's 39 MB.
Today's file is deliberately left uncompressed, so a crash mid-write still costs at most one line.

---

## Does the instrument agree with itself?

Every number here comes from one reading of one API. That reading was checked by a human, once, on
one machine — and then shipped to machines nobody has ever seen, where a locale, a driver, a kernel
version or a virtualisation layer can change what the same call returns. FOOTPRINT already tells you
what this platform *cannot* do. This tells you whether what it *does* do is holding up.

On a duty cycle — not every tick, so it costs nothing you could measure — VITALS reads a second,
**independent** source for a few core numbers and publishes how closely the two agree. You will find
it at the bottom of **FOOTPRINT**.

**It is not an error bar, and the difference matters.** An error bar needs ground truth. Two methods
disagreeing tells you something is wrong; it does not tell you *which one*. So the page says
"agrees" or "DISAGREES", never "our error is 4%" — a monitor inventing a confident number about its
own accuracy is the exact failure this product exists to avoid.

What gets compared, and what does not:

| Reading | Second source | |
|---|---|---|
| memory available | `GlobalMemoryStatusEx` · `sysinfo(2)` · `host_statistics64` | independent everywhere |
| cpu total | `NtQuerySystemInformation` · `host_processor_info` | independent on Windows and macOS |
| uptime | `GetTickCount64` · `kern.boottime` | independent on Windows and macOS |

On Linux the CPU and uptime rows say **"not cross-checked here"** and are not run, because the
reference reads the same `/proc/stat` and `/proc/uptime` the collector does. A comparison that
cannot fail is worse than no comparison — it manufactures confidence — so it is declared rather than
quietly counted as a pass.

A few things the display is careful about:

- **Below about a dozen comparisons it withholds the verdict** and shows the numbers anyway.
  "No disagreement yet" and "not checked yet" are different facts, and only one is reassuring.
- **It judges the median, not each sample.** Two interval averages over slightly offset windows
  simply differ, and on a busy machine the tail is wide. A path that has actually come loose moves
  the median a long way; noise moves only the tail. The tail is still printed, because it is real.
- **Each tolerance says where it came from.** They were measured on real hardware, not chosen.

If a row ever says **DISAGREES**, that is worth a bug report — the SYS page builds the bundle. It
means one of two paths into your kernel is not returning what it should, and the interesting part is
finding out which.

To take the same reading yourself, from a terminal in the install folder:

```
node selfcheck-live.js --samples 16
```

---

## When something looks wrong with VITALS itself

- **A page is empty or a control does nothing** — check FOOTPRINT. If the capability is not available
  on this platform, the page says so there.
- **A number looks wrong** — check the agreement record at the bottom of FOOTPRINT before assuming
  it. If the second source agrees, the reading is probably right and your expectation is what needs
  examining; if it says DISAGREES, you have found a real defect and it is worth reporting.
- **An edit you made is not showing** — Ctrl+Shift+R. The panel caches.
- **The panel will not open** — run `node start.js` from a terminal and read the output. If the
  folder came from a zip, Windows may have marked the files: `Get-ChildItem -Recurse . | Unblock-File`.
- **You want to send a bug report** — the SYS page builds a support bundle. It is an allowlist, so it
  carries logs and metrics and never your clipboard, API key or file listings. Tick what to include;
  the manifest states exactly what went in.
