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
| **FOOTPRINT** | What VITALS itself costs, and what this install can and cannot do. |
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

## When something looks wrong with VITALS itself

- **A page is empty or a control does nothing** — check FOOTPRINT. If the capability is not available
  on this platform, the page says so there.
- **An edit you made is not showing** — Ctrl+Shift+R. The panel caches.
- **The panel will not open** — run `node start.js` from a terminal and read the output. If the
  folder came from a zip, Windows may have marked the files: `Get-ChildItem -Recurse . | Unblock-File`.
- **You want to send a bug report** — the SYS page builds a support bundle. It is an allowlist, so it
  carries logs and metrics and never your clipboard, API key or file listings. Tick what to include;
  the manifest states exactly what went in.
