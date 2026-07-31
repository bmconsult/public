# Finishing VITALS on a Mac

The macOS port was **written blind** — no Mac on the bench, every parser derived from documented
tool output — with its logic covered by simulation suites and every capability flag in
`collect/caps.js` held at `false`, because there a flag means *verified on this platform*, not
*the code exists*.

**Where it stands now (2026-07-31):** the full CI suite has run on real Apple Silicon
(GitHub's macos-14 and macos-15 runners) and went green on both, first attempt — the live
collector cross-checked against sysctl/df/ps, the bridge serving measured samples, the socket
and startup inspectors answering with real rows, a real `pbcopy` round-tripped through the
clipboard watcher, the growth walker over a real Darwin home, and the Swift menu-bar host
compiled and launch-tested. The flags those runs proved are flipped, each note in caps.js naming
its proof.

What no CI runner can supply — and therefore all that is actually left:

- **battery** paths (runners have none)
- **populated GPU** (runners have a paravirtual device with no `IOAccelerator` statistics)
- **thermals**
- the **memory formula judged against Activity Monitor's own verdict**, and what the panel and
  menu-bar item **look like**

All of it is *evidence a physical Mac emits*. None of it requires the person at the Mac to
exercise judgement — the script below captures everything, screenshots included, and the
judging happens wherever the folder gets sent.

---

## Route 1 — a Mac you can borrow for two minutes: one command

```
git clone https://github.com/bmconsult/public.git
cd public/vitals
bash tools/finish-on-a-mac.sh
```

(Needs Node 18.15+: `brew install node`. Xcode command line tools get the native host built too,
but nothing fails without them.)

The script runs every suite CI runs, captures real output for every command the collector shells
out to (`tools/capture-macos-fixtures.sh`), boots the bridge, launches the panel next to
Activity Monitor and the Battery pane, and photographs them with `screencapture`. Everything —
logs, fixtures, JSON, PNGs — lands in `./mac-finish/`. **Send that folder back; that is the
whole job.** One note: the first screenshot may raise a one-time Screen Recording permission
prompt; if the PNGs come back as bare wallpaper, grant it and run the script once more.

If you'd rather read before running: every step is plain shell in `tools/finish-on-a-mac.sh`,
read-only outside `mac-finish/`, no sudo anywhere.

## Route 2 — thirty seconds of someone's Mac

```
bash tools/capture-macos-fixtures.sh --redact
```

Just the fixture capture: one output file (`macos-fixtures.txt`) banking real bytes for every
command the collector uses, including the battery/GPU/thermal paths CI is blind to. `--redact`
masks MAC addresses. Less than Route 1, but enough to fix any parser against reality.

## Route 3 — no Mac at all: push, and read CI

`.github/workflows/vitals-macos.yml` re-runs the entire battery on real Apple Silicon on every
push touching `vitals/`, banking fresh fixtures as artifacts each time. If a future change turns
a step red: download the `macos-fixtures-*` artifact, fix the parser against the real bytes —
never against more documentation — and push again.

---

## Closing the file out — for whoever holds the returned `mac-finish/` folder

- [ ] suites in the folder green; any failure fixed against `macos-fixtures.txt` and re-run
- [ ] `shot-1` — panel numbers (memory, top processes) agree with Activity Monitor beside them
      (better than ~1 GB / a few percent; macOS counts memory unusually, and
      `collect/test-darwin-live.js` prints what tolerance means where)
- [ ] `shot-2` — the VITALS menu-bar item is present and drawn right
- [ ] `shot-3` — battery health in `bridge-routes.json` agrees with System Settings → Battery
- [ ] flip the flags this evidence proves in `collect/caps.js` (darwin block) — battery, GPU
      and thermal flags take exactly this folder, not a CI run
- [ ] set the darwin `verified:` to a dated sentence naming the hardware, like the Linux block's
- [ ] delete the banner atop `collect/darwin.js` (it says so itself)
- [ ] update the pre-1.0 paragraph in `INSTALL.md` ("macOS is written but has never run…")

A flag flipped without its proof is the one move this project treats as worse than the gap
itself: a plausible zero is worse than a blank, and a claimed capability is worse than either.
