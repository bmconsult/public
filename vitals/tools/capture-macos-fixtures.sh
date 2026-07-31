#!/usr/bin/env bash
# VITALS - capture real macOS output so the collector can actually be verified.
#
# Run this on ANY Mac you have 30 seconds of access to. It reads nothing private, writes one file,
# changes nothing, and needs no admin rights. Send the file back and the macOS collector stops being
# guesswork.
#
#   bash capture-macos-fixtures.sh            -> ./macos-fixtures.txt
#   bash capture-macos-fixtures.sh --redact   -> same, with hardware IDs masked
#
# WHY THIS MATTERS. collect/darwin.js was written from documented tool output on a machine with no
# Mac. Its LOGIC is tested (collect/test-darwin-sim.js drives the whole collector and checks 81
# things), but the thing that cannot be tested without you is whether these commands really emit
# what we assumed. Every number the panel shows on macOS rests on that assumption.
#
# PRIVACY. The only sensitive things in this output are your MAC addresses (from netstat) and your
# volume names. --redact masks the MAC addresses. Nothing here touches files, browsing, accounts,
# or anything you have open. Read the commands below - there are eight and they are all read-only.

set -u
OUT="${OUT:-./macos-fixtures.txt}"
REDACT=0
[ "${1:-}" = "--redact" ] && REDACT=1

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This must run on macOS. Current system: $(uname -s)"
  exit 1
fi

emit() { printf '\n===== %s =====\n' "$1" >> "$OUT"; }

: > "$OUT"
{
  echo "VITALS macOS fixture capture"
  echo "date: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "redacted: $REDACT"
} >> "$OUT"

emit "uname -m";                    uname -m                                    >> "$OUT" 2>&1
emit "sw_vers";                     sw_vers                                     >> "$OUT" 2>&1

# The exact command the collector issues for its static description.
emit "sysctl (static block)"
sysctl -n machdep.cpu.brand_string hw.physicalcpu hw.ncpu hw.memsize            >> "$OUT" 2>&1
sw_vers -productVersion                                                          >> "$OUT" 2>&1

emit "vm_stat";                     vm_stat                                     >> "$OUT" 2>&1

# Two seconds of iostat: the first row after the header is the one the collector parses. The device
# header matters as much as the data - it is what tells the parser how many disk columns to skip.
emit "iostat -w 1 (3 samples)";     iostat -w 1 -c 3                            >> "$OUT" 2>&1

emit "ps -Ao pid,rss,%cpu,comm (first 25)"
ps -Ao pid,rss,%cpu,comm | head -25                                              >> "$OUT" 2>&1

emit "df -kl";                      df -kl                                      >> "$OUT" 2>&1

emit "netstat -ib"
if [ "$REDACT" = "1" ]; then
  netstat -ib | sed -E 's/([0-9a-f]{1,2}:){5}[0-9a-f]{1,2}/xx:xx:xx:xx:xx:xx/gi' >> "$OUT" 2>&1
else
  netstat -ib                                                                    >> "$OUT" 2>&1
fi

emit "pmset -g batt";               pmset -g batt                               >> "$OUT" 2>&1

# Battery internals. Absent on a desktop Mac, which is itself a useful data point.
emit "ioreg AppleSmartBattery (selected keys)"
ioreg -rn AppleSmartBattery 2>/dev/null \
  | grep -E '"(CycleCount|DesignCapacity|AppleRawMaxCapacity|AppleRawCurrentCapacity|Voltage|InstantAmperage)"' \
  >> "$OUT" 2>&1 || echo "(no AppleSmartBattery - desktop Mac)"                  >> "$OUT"

# ---------------------------------------------------------------------------------------------
# EVERYTHING BELOW IS FOR CAPABILITIES NOT YET BUILT.
#
# Captured BEFORE the parsers are written, deliberately. The macOS collector was originally coded
# from documented tool output by someone with no Mac, and every later correction traced back to
# that. Capturing first inverts it: the parser gets written against real bytes, and a format that
# surprises us surprises us here rather than in someone's panel.
# ---------------------------------------------------------------------------------------------

# Per-core CPU. Node's own os.cpus() carries per-core times on Darwin (libuv calls
# host_processor_info), which is what makes per-core a free win rather than a native addon.
emit "node os.cpus() [per-core times]"
if command -v node >/dev/null 2>&1; then
  node -e 'const c=require("os").cpus();console.log(JSON.stringify({n:c.length,model:c[0]&&c[0].model,times:c.slice(0,4).map(x=>x.times)},null,1))' >> "$OUT" 2>&1
else
  echo "(node not installed - skipped)" >> "$OUT"
fi

# P-cores vs E-cores. Apple Silicon only; a Mac that reports both is a machine where "CPU at 40%"
# means something different depending on which cluster is busy.
emit "sysctl perflevels (P/E cores)"
sysctl -a 2>/dev/null | grep -E 'hw\.perflevel[0-9]+\.(name|physicalcpu|logicalcpu)|hw\.optional\.arm64' >> "$OUT" 2>&1 || echo "(none - Intel Mac)" >> "$OUT"

# GPU utilisation without root. The key names here decide whether gpu.total is reachable at all.
emit "ioreg IOAccelerator PerformanceStatistics"
ioreg -rc IOAccelerator -a 2>/dev/null | head -c 6000 >> "$OUT" 2>&1 || echo "(none)" >> "$OUT"

emit "system_profiler SPDisplaysDataType"
system_profiler SPDisplaysDataType -json 2>/dev/null | head -c 2500 >> "$OUT" 2>&1 || echo "(none)" >> "$OUT"

# Disk read/write split, one level upstream of iostat (which only gives combined throughput).
emit "ioreg IOBlockStorageDriver Statistics"
ioreg -rc IOBlockStorageDriver -a 2>/dev/null | head -c 6000 >> "$OUT" 2>&1 || echo "(none)" >> "$OUT"

# THE "BEYOND" ONE. Which process is holding this machine awake, by name, with no admin rights.
# Windows needs an elevated powercfg /requests for the same answer.
emit "pmset -g assertions"
pmset -g assertions 2>&1 | head -60 >> "$OUT" 2>&1

# Thermal pressure without root. Not degrees - the throttling verdict, which is the actionable half.
emit "pmset -g therm";              pmset -g therm 2>&1                         >> "$OUT" 2>&1

# Apple's own memory verdict. More honest than "% used", which VITALS already argues about.
emit "memory_pressure / pressure level"
memory_pressure 2>/dev/null | head -20 >> "$OUT" 2>&1 || echo "(memory_pressure unavailable)" >> "$OUT"
sysctl kern.memorystatus_vm_pressure_level vm.swapusage 2>&1 >> "$OUT"

# Per-process faults, page-ins and energy impact. Column layout is what matters here.
emit "top -l 2 -stats pid,command,cpu,mem,faults,pageins,power (2nd sample, first 20)"
top -l 2 -n 20 -stats pid,command,cpu,mem,faults,pageins,power 2>&1 | tail -40 >> "$OUT" 2>&1

# The EXACT command collect/darwin.js issues for its faults join - the parser gates on this
# header being precisely PID/FAULTS, so this capture is what proves or breaks that gate.
emit "top -l 1 -stats pid,faults (exact collector command, first 25)"
top -l 1 -stats pid,faults 2>&1 | head -25 >> "$OUT" 2>&1

# The exact grep the collector runs for the read/write split (the -a XML capture above shows the
# full tree; THIS shows the flat form the regex actually reads).
emit "ioreg IOBlockStorageDriver, flat Bytes lines (exact collector command)"
ioreg -rc IOBlockStorageDriver 2>/dev/null | grep "Bytes" | head -10 >> "$OUT" 2>&1 || echo "(none)" >> "$OUT"

# Sockets WITH owning pid, unprivileged. lsof -i shows only your own processes without root; this
# reads via sysctl and sees everything.
emit "netstat -anv (first 25, listening + established)"
if [ "$REDACT" = "1" ]; then
  netstat -anv 2>&1 | head -25 | sed -E 's/([0-9]{1,3}\.){3}[0-9]{1,3}/x.x.x.x/g' >> "$OUT" 2>&1
else
  netstat -anv 2>&1 | head -25 >> "$OUT" 2>&1
fi

# The exact form inspect-posix.js issues: TCP only. The HEADER row is the part that matters -
# the pid column's position is computed from it, so a header this parser has not seen is the
# difference between /api/conns working and refusing.
emit "netstat -anv -p tcp (exact collector command, first 20)"
if [ "$REDACT" = "1" ]; then
  netstat -anv -p tcp 2>&1 | head -20 | sed -E 's/([0-9]{1,3}\.){3}[0-9]{1,3}/x.x.x.x/g' >> "$OUT" 2>&1
else
  netstat -anv -p tcp 2>&1 | head -20 >> "$OUT" 2>&1
fi

# Startup items. plutil converts Apple's binary plists to JSON with no parser to write.
emit "launchctl list (first 20)"; launchctl list 2>&1 | head -20               >> "$OUT" 2>&1
emit "LaunchAgents present"
ls -1 ~/Library/LaunchAgents /Library/LaunchAgents /Library/LaunchDaemons 2>/dev/null | head -30 >> "$OUT" 2>&1 || true
emit "plutil on one LaunchAgent (shape only)"
_first=$(ls -1 /Library/LaunchDaemons/*.plist 2>/dev/null | head -1)
if [ -n "${_first:-}" ]; then plutil -convert json -o - "$_first" 2>&1 | head -c 900 >> "$OUT" 2>&1
else echo "(no LaunchDaemons readable)" >> "$OUT"; fi

# Spotlight: the MFT-killer. If indexing is on, "largest files" and "what changed" are index reads.
emit "mdutil -s / (is Spotlight indexing on?)"
mdutil -s / 2>&1                                                                >> "$OUT" 2>&1

# One real query, so the mdfind-backed "largest files" idea gets written against actual behaviour -
# including the (common) case where the index is off and it answers nothing.
emit "mdfind sample (files > 100 MB under HOME, count + first 5)"
mdfind -onlyin "$HOME" -count 'kMDItemFSSize > 104857600' 2>&1                  >> "$OUT" 2>&1
mdfind -onlyin "$HOME" 'kMDItemFSSize > 104857600' 2>/dev/null | head -5 \
  | sed "s|$HOME|~|g"                                                            >> "$OUT" 2>&1 || true

# networkQuality is the only capture here that SPENDS something: it runs Apple's bandwidth test,
# ~10-30 s and real data. Off by default so the promise at the top of this file ("reads, changes
# nothing") stays true for a casual run; CI and anyone willing passes NETQ=1. Both the human
# summary and -c (the machine-readable JSON a parser would actually read) are captured, because
# they are different formats and guessing either is how this collector got its previous mistakes.
emit "networkQuality (NETQ=1 to enable; costs bandwidth)"
if [ "${NETQ:-0}" = "1" ]; then
  networkQuality -s 2>&1                                                         >> "$OUT" 2>&1
  emit "networkQuality -c (JSON)"
  networkQuality -s -c 2>&1                                                      >> "$OUT" 2>&1
else
  echo "(skipped - set NETQ=1 to run Apple's bandwidth test; it spends real data)" >> "$OUT"
fi

echo ""
echo "Captured to: $OUT"
echo "Size: $(wc -c < "$OUT") bytes"
echo ""
echo "What to do with it:"
echo "  1. Read it. It is plain text and short enough to skim."
echo "  2. Send it back, or diff it yourself against the fixtures at the top of"
echo "     collect/test-darwin-sim.js and collect/test-darwin.js."
echo "  3. Where they differ, the REAL output wins and collect/darwin.js gets fixed."
echo ""
echo "If you also have Node 18+ here, the stronger move is to run the collector itself:"
echo "  node collect/test-darwin-live.js"
echo "which cross-checks it against df, sysctl and Activity Monitor's own numbers."
