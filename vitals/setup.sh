#!/usr/bin/env sh
# VITALS setup for macOS and Linux.
#
#   ./setup.sh
#
# Prefers the runtime that shipped in the box, same order as vitals.sh. Resolves its own directory
# so the folder can be moved, renamed, or run from a USB stick.

set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -x "$DIR/runtime/bin/node" ]; then
  NODE="$DIR/runtime/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE=node
else
  echo ""
  echo "  VITALS needs Node 18 or newer, and this copy did not come with one."
  echo ""
  echo "    macOS:   brew install node"
  echo "    Debian:  sudo apt install nodejs"
  echo "    Fedora:  sudo dnf install nodejs"
  echo ""
  echo "  Or download the bundle that includes it, which needs nothing installed."
  echo ""
  exit 1
fi

exec "$NODE" "$DIR/setup.js" "$@"
