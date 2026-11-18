#!/bin/bash
# Spike S-2: sign "LFCP Bridge.app" ad-hoc from the inside out, hardened runtime on every Mach-O.
#   scripts/spike-s2/sign-app.sh <app> [node-entitlements]
# Default node entitlements: scripts/spike-s2/node.entitlements. An empty file name ("") signs node
# with no entitlements at all (the workflow's lower bound).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="${1:?usage: sign-app.sh <app> [node-entitlements]}"
NODE_ENT="${2-$ROOT/scripts/spike-s2/node.entitlements}"
C="$APP/Contents"
sign() { codesign --force --sign - --timestamp=none --options runtime "$@"; }

# 1. Loadable code first: the native module (a bundle-less Mach-O, identified by its name).
sign --identifier org.openlfcp.bridge.better-sqlite3 \
  "$C/Resources/host/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
# 2. Nested executables, each with its own entitlements.
if [ -n "$NODE_ENT" ]; then
  sign --identifier org.openlfcp.bridge.node --entitlements "$NODE_ENT" "$C/Resources/node/bin/node"
else
  sign --identifier org.openlfcp.bridge.node "$C/Resources/node/bin/node"
fi
sign --identifier org.openlfcp.bridge.reminders-helper \
  --entitlements "$ROOT/helper/Support/release.entitlements" "$C/MacOS/lfcp-reminders-helper"
# 3. The bundle last (seals Resources/, signs the main executable).
sign "$APP"

codesign --verify --strict --deep --verbose=2 "$APP"
