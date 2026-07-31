# bmconsult

Public projects. Each folder is self-contained — its own README, its own licence.

---

### [VITALS](vitals/) &nbsp;·&nbsp; a system monitor that never shows you a number it did not measure

<a href="vitals/"><img src="vitals/media/diagnosis.png" width="640" alt="VITALS diagnosis: one compound verdict, the measured causal chain behind it, and what happened last time it fired on this machine" /></a>

Every monitor shows you what your machine is *doing*. VITALS tells you what is *wrong* with it —
one ranked verdict instead of a wall of gauges:

> **Your disk is full because your RAM is exhausted — the two are feeding each other**

Findings are ranked by **consequence**, not by the biggest number; a disk at 94% matters more than a
CPU at 94%, because the CPU will be fine in a minute and the disk will not. Nothing fires on an
instant — every rule tests a sustained window, so a spike is a process starting and ninety seconds
of it is a problem. Each finding carries the measured evidence that produced it, and where it has
fired before, it tells you what happened last time **on your machine**: how long it took to clear,
which cleanup you ran, and what that actually freed. If a cleanup claimed 9 GB and gave back
200 MB, the ledger says so.

You can believe the verdict because of the rule underneath it. An absent gauge means *this host
cannot measure that*, a dash means *not measured*, and `0%` means genuinely zero — enforced by a
per-platform capability manifest that the interface is gated on, so a new page cannot quietly ship
a platform assumption. Every number above was measured or it would not be on the screen.

Windows · Linux · macOS &nbsp;·&nbsp; no installer, no service, no accounts, no telemetry &nbsp;·&nbsp; Apache-2.0

**[Download](vitals/#download)** &nbsp;·&nbsp; **[Read more](vitals/)**
