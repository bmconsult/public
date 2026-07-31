# INSTALL_FOR_CLAUDE.md — installation procedure

**VITALS 0.9.0.** Pre-1.0 deliberately: Windows complete, Linux verified end to end, macOS written
but never run on hardware, action layer Windows-only. Report those honestly rather than smoothing
them over.

*You are Claude, installing VITALS on this machine. Follow this exactly. It takes about a minute and
spends no agent tokens.*

**There is nothing to rewrite.** Unlike most ported tools, VITALS has no path placeholders: every
path resolves from `__dirname` at runtime. The install is *verify the runtime, start it, prove the
collector is real, and report the platform's honest limits to the user.*

The one thing you must not skip is **Step 4**. VITALS' entire design principle is that it never shows
a number it did not measure. If you install it and report "working" without checking that the
collector actually produced telemetry, you have defeated the tool.

---

## Step 0 — establish the root

```bash
pwd
```

Call the result `<ROOT>`. It must contain: `bridge.js`, `start.js`, `dashboard.html`, `diagnose.js`,
and a `collect/` directory holding `caps.js`, `index.js`, `win32.js`, `linux.js`, `darwin.js`.

If `collect/` is missing, **stop** — this is a pre-port copy and has no cross-platform support. Do
not attempt to add one; ask the user for a current copy.

---

## Step 1 — check the runtime

```bash
node --version
```

Must be **v18.15.0 or newer**. Below that, `fs.statfsSync` does not exist and the Linux and macOS
collectors cannot read volume sizes.

If Node is missing or too old, stop and tell the user which one applies. Do **not** install Node
yourself — that is a system-level change and it is theirs to make. Give them the one line for their
platform:

- Windows: `winget install OpenJS.NodeJS.LTS`
- macOS: `brew install node`
- Debian/Ubuntu: `sudo apt install nodejs`
- Fedora: `sudo dnf install nodejs`

---

## Step 2 — read the capability manifest before starting anything

```bash
node -e "const{manifest}=require('./collect/caps');const m=manifest();console.log(JSON.stringify({platform:m.platform,name:m.name,collector:m.collector,verified:m.verified,missing:m.missing,limited:m.limited},null,1))"
```

This tells you what this host can honestly answer. Keep the output — you will report it in Step 7.

**If `verified` is `false`, the collector for this platform has never been run on real hardware.**
Currently that means macOS. Do not hide this from the user and do not soften it. Say plainly that
the numbers are unvalidated and that they are the first person to run it.

---

## Step 3 — start it

```bash
node start.js --no-window
```

`--no-window` keeps this step scriptable. It prints the platform, the collector, and the gaps, then
starts the bridge on 8790 and returns.

If the port is in use by an existing VITALS, `start.js` reuses it rather than starting a second one.
Two collectors sampling the same counters is waste, not redundancy.

---

## Step 4 — prove the collector is real (do not skip)

Wait a few seconds for the first sample, then:

```bash
curl -s http://127.0.0.1:8790/api/latest
```

Check, specifically:

1. **`cpu.total` is a number, and it is not 0 on a machine that is doing something.**
2. **`mem.totalMB` matches the machine's actual RAM.** If it does not, the collector is reading the
   wrong thing and every downstream conclusion is wrong.
3. **`disk.vols` contains the system volume** — `C:` on Windows, `/` elsewhere — with a plausible
   `freeGB`. Compare it against `df -h /` or `Get-PSDrive C`.
4. **`proc` is a non-empty array** with recognisable process names.
5. **Anything the manifest said was unavailable is `null`, not `0`.** A zero where the manifest
   promised a gap is a bug — report it rather than accepting it.

If `/api/latest` returns `{"none":true}` after ~10 seconds, the collector is not producing. Run
`node bridge.js` in the foreground and read stderr; the collector prints its own failures with a
`[metrics]` prefix.

Then confirm the manifest is being served to the panel:

```bash
curl -s http://127.0.0.1:8790/api/caps
```

---

## Step 5 — on Linux, run the real test suites

If the platform is Linux, you have actual verification available. Use it:

```bash
node collect/test-linux-live.js
node collect/test-linux-stimulus.js
```

The first cross-checks the collector against `df`, `free -m` and `nproc`. The second applies known
CPU, disk and network load and confirms the numbers move — which is the difference between a
collector that reads something and one that reads reality.

Both should end with every check passing. If any fail, **report the failing lines verbatim** rather
than summarising them; the check names say exactly which counter disagreed with which authority.

On macOS, `node collect/test-darwin.js` exists but its fixtures are synthetic — a pass is not
verification and you must not report it as one.

---

## Step 6 — wire the MCP server into the user's own Claude

**Do this as part of the install, not on request.** The panel's built-in Ask already carries its own
copy (see the note below), but the user's *own* Claude sessions — this one, their terminal, their
editor — have no access to the machine's telemetry until this is done. That is the difference
between a monitor they have to go and look at and one they can ask from wherever they already are.

```bash
node -e "console.log(require('path').resolve('vitals-mcp.js'))"
```

Add to their MCP config, using that absolute path:

```json
{ "mcpServers": { "vitals": { "command": "node", "args": ["<absolute path to vitals-mcp.js>"] } } }
```

Then tell them to restart their Claude client. **A new conversation is not a restart.**

Two things to say when you report it:

- **The bridge must be running** for any of these tools to answer. They talk to `127.0.0.1:8790`,
  not to the files directly.
- **Actions are off by default.** `vitals_clean`, `vitals_restart_app` and `vitals_bundle` only
  exist if the server is launched with `--allow-actions`. Without that flag the tools are not
  registered at all, so the server is read-only by construction rather than by good behaviour. Tell
  the user the flag exists and let them decide; do not add it yourself.

### The panel's Ask is already wired — separately, and on purpose

`ask.js` passes its own `--mcp-config` and pre-approves the ten read-only tools by name. It does
**not** rely on the config above, because an embedded assistant whose abilities depend on unrelated
setup elsewhere is one that silently ships broken on a fresh machine.

Worth knowing if you ever touch it: loading a tool and being allowed to call it are separate things.
`--permission-mode acceptEdits` covers file edits only, so with the server wired and no allowlist the
agent found the tools, called them, and every call returned "blocked awaiting permission" — then
answered from its pasted snapshot as though it had queried the machine. Wired-but-blocked is
indistinguishable from working until an answer is wrong.

---

## Step 7 — report to the user, then stop

Tell them, in this order:

1. **It is installed and the collector is producing** — cite one real number you saw in Step 4, so
   they know you checked rather than assumed.
2. **The platform and collector** from Step 2.
3. **The gaps**, in plain language. Not the raw key names — say "per-process disk I/O is not
   available on this platform because it needs root", not `proc.io: false`.
4. **If `verified` was false**, say so first and clearly. Ask them to compare the panel's figures
   against their system's own monitor and report back what is wrong.
5. **How to open it**: `VITALS.exe` on Windows (pin it — it carries the icon), `./vitals.sh`
   elsewhere. Or the panel is already at `http://127.0.0.1:8790/`.

---

## Step 8 — tell the user about viewer mode, if it is relevant to them

Do not change the mode. Just make sure they know it exists, in one or two sentences:

- **Admin** (default) is the technician's tool.
- **Viewer** reads and reports but cannot change the machine. Enforced at the bridge, so it holds for
  anything that can reach the port — not only the panel. Switch on the FOOTPRINT page.
- Coming back needs a passphrase (set while in admin) or a relaunch with `VITALS_MODE=admin`.

This matters most when installing on a machine the user does not own or will hand to someone else.

---

## Step 9 — do NOT "fix" the things that are off on purpose

Three defaults look like faults and are not. Report them as defaults:

- **Ask is disconnected.** A fresh install has `enabled: false`; `POST /api/ask` returns 409 and no
  Claude process is started. That is the shipped state, deliberately — nothing leaves the machine
  until the owner presses Connect on the Ask page. Do not enable it for them.
- **MCP will not start the bridge.** Autostart is opt-in (`--autostart`). A tool call on a cold
  machine returning "the bridge is not running" is correct behaviour, not a broken install.
- **Action routes 403 in viewer mode.** If you find them refused, the install is in viewer
  deliberately. Tell the user; do not edit `history/mode.json` to route around it.

---

## Things that will trip you up

- **A plain page reload serves a cached copy.** If you edit `dashboard.html` and nothing changes, it
  is the WebView cache. Hard reload: Ctrl+Shift+R.
- **The bridge must never run elevated.** It can kill processes and delete caches. Anything needing
  admin goes through a one-shot elevation prompt on purpose. If you find yourself wanting to run
  `bridge.js` as root or Administrator, you have misdiagnosed something.
- **Do not "fix" a missing gauge by emitting zero.** If a platform cannot measure something, the
  collector emits `null` and `caps.js` declares it false. That is the design, not an oversight.
- **Do not "fix" viewer mode by editing mode.json.** If actions return 403, the install is in viewer
  deliberately. Tell the user; do not route around it.
- **The Ask panel's summary is anonymous on purpose** — process names and account names are withheld
  and fetched via MCP only when a question needs them. If you are tempted to add them back into
  `context()` for convenience, that is a privacy regression, not a fix.
- **`history/` carries the previous machine's data** — telemetry, journal, clipboard log and the Ask
  conversation. On a fresh install for a different person, delete it.
- **Deleting `history/` does NOT clear the API key or the admin passphrase.** Those live in
  `%LOCALAPPDATA%\vitals` (or `~/.local/share/vitals`), outside the install folder. If you are
  handing this machine to someone else, that directory is the one to clear.
