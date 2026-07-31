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
# Mac. Its LOGIC is tested (collect/test-darwin-sim.js drives the whole collector and checks 61
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
