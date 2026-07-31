#!/usr/bin/env bash
# VITALS - finish the macOS port, in one command, on any Mac.
#
#   bash tools/finish-on-a-mac.sh
#
# Runs everything CI runs (parser fixtures, full-collector simulation, the LIVE collector
# cross-checked against sysctl/df/ps, route guard, action layer, inspection layer), plus what no
# CI runner can supply: this machine may have a battery, a real GPU and thermals - and a screen,
# so the visual half is CAPTURED too. The script launches the panel beside Activity Monitor and
# the Battery pane and photographs them with `screencapture`. Judging the pictures takes a human;
# taking them does not, and the person running this does not need to be that human.
#
# It changes nothing outside ./mac-finish/ (and briefly opens two Apple apps to photograph them).
# No sudo. A couple of minutes. Failures do not stop the run - each one is a finding, and one run
# should yield all of them.
#
# When it ends, ./mac-finish/ holds every suite's output, the fixtures, and the screenshots.
# Either fix collect/darwin.js against them yourself, or send the folder back exactly as it is.
# FINISH_ON_A_MAC.md says which flags flip on what proof.

set -u

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This must run on macOS. Current system: $(uname -s)"
  echo "Without a Mac, the same suites run in CI on every push - see FINISH_ON_A_MAC.md."
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "VITALS needs Node 18.15+ and none was found.  brew install node   (or https://nodejs.org)"
  exit 1
fi

cd "$(dirname "$0")/.."            # repo layout: this file lives in vitals/tools/
OUT="./mac-finish"
mkdir -p "$OUT"

PASS=0; FAIL=0; SUMMARY=""
step() {  # step <name> <logfile> <command...>
  local name="$1" log="$OUT/$2"; shift 2
  echo ""
  echo "==== $name"
  if "$@" > "$log" 2>&1; then
    PASS=$((PASS+1)); SUMMARY="$SUMMARY
  PASS  $name"
    tail -3 "$log" | sed 's/^/      /'
  else
    FAIL=$((FAIL+1)); SUMMARY="$SUMMARY
  FAIL  $name        -> $log"
    tail -12 "$log" | sed 's/^/      /'
  fi
}

echo "VITALS macOS finish run - $(sw_vers -productVersion) on $(uname -m), node $(node --version)"
echo "Everything below lands in $OUT/"

# 1. Real fixtures FIRST, so even a run full of failures banks the bytes the fixes get written
#    against. Redaction is the capturing human's call; default here is unredacted because this
#    folder is meant to be read before it is sent anywhere.
step "capture real fixtures (tools/capture-macos-fixtures.sh)" capture.log \
  env OUT="$OUT/macos-fixtures.txt" bash tools/capture-macos-fixtures.sh

# 2. The suites, in the same order CI runs them.
step "parser fixtures        (collect/test-darwin.js)"      test-darwin.log      node collect/test-darwin.js
step "collector simulation   (collect/test-darwin-sim.js)"  test-darwin-sim.log  node collect/test-darwin-sim.js
step "LIVE collector on this Mac (collect/test-darwin-live.js)" test-darwin-live.log node collect/test-darwin-live.js
step "route guard + capability manifest (test-routes.js)"   test-routes.log      node test-routes.js
step "action layer + growth walker (test-actions-posix.js)" test-actions.log     node test-actions-posix.js
step "inspection + clip watcher (test-inspect-posix.js)"    test-inspect.log     node test-inspect-posix.js

# 3. The native panel host, built before the bridge step so the visual capture below can use it.
HOST_BUILT=0
if command -v swiftc >/dev/null 2>&1; then
  step "build native host (mac/VitalsHost.swift -> ./VITALS)" swift-build.log \
    swiftc -O -o VITALS mac/VitalsHost.swift -framework Cocoa -framework WebKit
  [ -x ./VITALS ] && HOST_BUILT=1
else
  SUMMARY="$SUMMARY
  SKIP  native host build (no swiftc - run: xcode-select --install)"
fi

# 4. The bridge, against the real system: boot, one served sample, the two inspection routes that
#    were 501s until 2026-07-31. Left RUNNING for the photographs, killed at the end.
echo ""
echo "==== bridge boots and serves (15 s)"
VITALS_PORT=8790 node bridge.js > "$OUT/bridge.log" 2>&1 &
BRIDGE=$!
BOK=0
for i in $(seq 1 40); do
  curl -sf http://127.0.0.1:8790/api/caps >/dev/null 2>&1 && { BOK=1; break; }
  sleep 0.5
done
if [ "$BOK" = "1" ]; then
  sleep 12
  { echo "--- /api/latest ---";  curl -sf http://127.0.0.1:8790/api/latest
    echo ""; echo "--- /api/conns ---";   curl -sf http://127.0.0.1:8790/api/conns
    echo ""; echo "--- /api/startup ---"; curl -sf http://127.0.0.1:8790/api/startup
  } > "$OUT/bridge-routes.json" 2>&1
  if node -e '
    const fs=require("fs"), t=fs.readFileSync(process.argv[1],"utf8");
    const grab=n=>{const m=t.split("--- /api/"+n+" ---")[1];try{return JSON.parse((m||"").split("--- /api/")[0].trim())}catch{return null}};
    const l=grab("latest"), c=grab("conns"), s=grab("startup"); let bad=0;
    const need={"latest has measured cpu.total": l&&l.cpu&&typeof l.cpu.total==="number",
                "latest has mem.usedMB": l&&l.mem&&l.mem.usedMB>0,
                "conns sees the bridge on :8790": Array.isArray(c)&&c.some(r=>r.st==="Listen"&&/:8790$/.test(r.l)),
                "startup found entries": Array.isArray(s)&&s.length>0};
    for(const[k,v]of Object.entries(need)){console.log((v?"  ok   ":"  MISS ")+k);if(!v)bad++}
    process.exit(bad?1:0)' "$OUT/bridge-routes.json"
  then PASS=$((PASS+1)); SUMMARY="$SUMMARY
  PASS  bridge + live routes"
  else FAIL=$((FAIL+1)); SUMMARY="$SUMMARY
  FAIL  bridge + live routes -> $OUT/bridge-routes.json + $OUT/bridge.log"
  fi
else
  FAIL=$((FAIL+1)); SUMMARY="$SUMMARY
  FAIL  bridge never answered /api/caps -> $OUT/bridge.log"
fi

# 5. Photograph the evidence. The judgement (do these numbers match, does the window look right)
#    needs a human somewhere - but not THIS human, and not this machine. screencapture banks the
#    pixels; whoever maintains the port reads them next to bridge-routes.json.
#    NOTE: the first capture on a modern macOS raises a Screen Recording permission prompt for
#    your terminal. If the PNGs come back as bare wallpaper, grant it (System Settings > Privacy
#    & Security > Screen Recording) and run this script once more.
echo ""
echo "==== photographing the panel, Activity Monitor and the battery pane"
if [ "$BOK" = "1" ]; then
  HOSTPID=""
  if [ "$HOST_BUILT" = "1" ]; then
    ./VITALS --port 8790 > "$OUT/host.log" 2>&1 &
    HOSTPID=$!
  else
    # No swiftc: the browser panel is still the real dashboard rendering real telemetry.
    open "http://127.0.0.1:8790" 2>/dev/null || true
  fi
  open -a "Activity Monitor" 2>/dev/null || true
  sleep 8
  screencapture -x "$OUT/shot-1-panel-and-activity-monitor.png" 2>/dev/null || true
  # The menu bar strip alone, tight enough to see the VITALS status item next to the clock.
  # 2400 px is wider than most laptop panels; screencapture clips -R to the real screen.
  screencapture -x -R "0,0,2400,40" "$OUT/shot-2-menu-bar.png" 2>/dev/null || true
  open "x-apple.systempreferences:com.apple.Battery-Settings.extension" 2>/dev/null \
    || open -b com.apple.systempreferences 2>/dev/null || true
  sleep 5
  screencapture -x "$OUT/shot-3-battery-settings.png" 2>/dev/null || true
  [ -n "$HOSTPID" ] && kill $HOSTPID 2>/dev/null || true
  SHOTS=$(ls "$OUT"/shot-*.png 2>/dev/null | wc -l | tr -d ' ')
  if [ "${SHOTS:-0}" -ge 2 ]; then
    PASS=$((PASS+1)); SUMMARY="$SUMMARY
  PASS  evidence photographed ($SHOTS shots)"
  else
    FAIL=$((FAIL+1)); SUMMARY="$SUMMARY
  FAIL  screenshots missing - likely the Screen Recording permission; grant it and rerun"
  fi
else
  SUMMARY="$SUMMARY
  SKIP  photographs (bridge never came up)"
fi
kill $BRIDGE 2>/dev/null || true

echo ""
echo "================================================================"
echo "RESULT: $PASS passed, $FAIL failed$SUMMARY"
echo ""
echo "Everything is in $OUT/ - suite logs, macos-fixtures.txt, and the screenshots."
if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Each failure is a real finding about a guessed format. Fix collect/darwin.js (or"
  echo "inspect-posix.js / clipwatch-posix.js) against $OUT/macos-fixtures.txt - the real"
  echo "bytes always win - or send the whole folder back."
fi
echo ""
echo "If you are just lending this Mac: you are done - send the $OUT/ folder back."
echo "If you maintain the port: read the shots against bridge-routes.json (memory + top"
echo "processes vs Activity Monitor, battery health vs the Battery pane, does the panel and"
echo "menu-bar item draw), then flip exactly the flags this run proved in collect/caps.js,"
echo "set its verified: to a dated sentence, and delete the banner atop collect/darwin.js."
echo "FINISH_ON_A_MAC.md has the checklist."
exit 0
