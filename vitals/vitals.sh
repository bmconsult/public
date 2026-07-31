#!/usr/bin/env sh
# VITALS launcher for macOS and Linux.
#
#   ./vitals.sh                 start the bridge and open the panel
#   ./vitals.sh --no-window     bridge only (headless, for MCP or a remote browser)
#
# Resolves its own directory so the folder can be moved, renamed, or run from a USB stick.
# Prefers a bundled runtime under ./runtime/bin/node if one was placed there by the portable build,
# so a machine with no system Node still works.

set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -x "$DIR/runtime/bin/node" ]; then
  NODE="$DIR/runtime/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE=node
else
  echo "VITALS needs Node 18 or newer, and none was found."
  echo ""
  echo "  macOS:   brew install node"
  echo "  Debian:  sudo apt install nodejs"
  echo "  Fedora:  sudo dnf install nodejs"
  echo "  or:      https://nodejs.org  (LTS)"
  echo ""
  echo "Alternatively drop a Node build at $DIR/runtime/ and this script will use it."
  exit 1
fi

exec "$NODE" "$DIR/start.js" "$@"
