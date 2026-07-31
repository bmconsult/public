# bmconsult

Public projects. Each folder is self-contained — its own README, its own licence.

---

### [VITALS](vitals/) &nbsp;·&nbsp; a system monitor with a memory

<a href="vitals/"><img src="vitals/media/diagnosis.png" width="640" alt="The diagnosis page: one compound verdict, the measured evidence behind it, and what happened last time it fired on this machine" /></a>

**"Why was my computer slow yesterday at 2pm?"** Nothing on your machine can answer that. The
live numbers were gone by 2:01, the built-in tools describe *now*, and the ones that could have
recorded everything had to be switched on before the problem happened. Your computer watched the
whole thing — and kept no notes.

VITALS keeps the notes. It runs a diagnosis every 30 seconds, window open or not, and writes each
conclusion to an append-only ledger: the finding that fired, the CPU / memory / disk / hard-fault
readings at that moment, every cleanup and kill you performed while it was open, and the readings
again when it cleared. A verdict here doesn't arrive alone — it arrives citing what happened last
time, on *your* machine.

> **Your disk is full because your RAM is exhausted — the two are feeding each other**

That is not sample copy. It is a critical finding from the build machine's own ledger, fired
29 July. It stayed open 22.3 hours, and the ledger has all six cleanups run during it with what
each *actually* returned:

```
winre      1.83 GB      ctmp       0.96 GB      usertemp   0.29 GB
winupdate  0.09 GB      ctmp       0.00 GB      winupdate −0.02 GB
```

One freed nothing. One went backwards. The record states both as flatly as it states the 1.83,
because a cleanup log that only remembers its wins is just advertising. At fire: 10.6 GB free.
At clear: 38.2. Next time this finding fires, the engine attaches that history to the verdict.

The rest of the highlight reel, measured on the machine it was built on:

- **Verdicts, not gauges.** Rules fire only on *sustained* windows — a CPU spike is a process
  starting; ninety seconds of it is a problem — and a compound cause suppresses the symptoms it
  explains, so the RAM→pagefile→disk spiral above arrived as one finding, not three alarms.
- **The whole disk in 6.4 seconds.** 1,400,271 files / 454 GB read straight from the filesystem's
  own master index and verified against a full directory walk to 0.2% — then drawn as a treemap
  where colour answers *"can I have these bytes back?"* and mapped + free + unmapped reconcile to
  the size of the drive instead of quietly summing short.
- **90 days deep.** Per-minute rollups of every metric, a journal of individual threshold
  crossings, and an hour of history wrapped into the overview rings — a spike twenty minutes ago
  is a hot blob two-thirds of the way round.
- **Diagnosis and fix on the same panel.** Every cleanup target is sized *before* you act and
  ledgered *after*. The Recycle Bin is shown, never emptied for you.
- **It bills itself honestly.** The footprint page charges VITALS' own CPU and RAM to VITALS —
  including the cost of producing the footprint page.
- **A dock, a chat, an API.** A frameless panel that docks to a screen edge as a live sidebar
  (Windows); an optional AI chat grounded in the live telemetry, shipped disconnected until you
  press Connect; an MCP server so your own agent sessions can ask this machine what's wrong with it.
- **And one rule underneath everything:** an absent gauge means *this host can't measure that*, a
  dash means *not measured*, and 0% means zero — enforced by a per-platform capability manifest,
  not by good intentions.

<a href="vitals/"><img src="vitals/media/overview-dark.png" width="640" alt="The overview: CPU, memory, disk and GPU as rings — the bold arc is now, the ring's own track is that metric's last hour" /></a>

Windows is the product — **32 of 33 capabilities measured**. Linux and macOS are real ports but
**partial ones**: live telemetry, the diagnosis engine, 90 days of history and the journal work on
all three, but neither can act on what it finds, and macOS has **never run on a real Mac** —
everything there is written and simulated. The project README breaks that down capability by
capability rather than averaging it into a tick.

No installer, no service, no accounts, no telemetry · loopback only · Apache-2.0

**[Download](vitals/#download)** &nbsp;·&nbsp; **[Read more](vitals/)**
