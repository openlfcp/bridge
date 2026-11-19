#!/bin/bash
# Spike S-1: sign "LFCP Bridge.app" from the inside out with the self-signed "LFCP Bridge Dev"
# certificate (stable designated requirement across N → N+1), hardened runtime on every Mach-O.
#   scripts/spike-s1/sign-app.sh <app> <keychain>
#   SHELL_DLV=1 …   the shell also gets disable-library-validation (fallback if Sparkle won't load)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="${1:?usage: sign-app.sh <app> <keychain>}"
KC="${2:?keychain}"
ID="${SIGN_IDENTITY:-LFCP Bridge Dev}"
C="$APP/Contents"
F="$C/Frameworks/Sparkle.framework"
sign() { codesign --force --sign "$ID" --keychain "$KC" --timestamp=none --options runtime "$@"; }

SHELL_ENT="$ROOT/scripts/spike-s1/shell.entitlements"
if [ "${SHELL_DLV:-0}" = 1 ]; then
  SHELL_ENT="$(mktemp -d)/shell.entitlements"
  cp "$ROOT/scripts/spike-s1/shell.entitlements" "$SHELL_ENT"
  /usr/libexec/PlistBuddy -c "Add :com.apple.security.cs.disable-library-validation bool true" "$SHELL_ENT"
fi

sign --identifier org.openlfcp.bridge.better-sqlite3 \
  "$C/Resources/host/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
sign --identifier org.openlfcp.bridge.node --entitlements "$ROOT/scripts/spike-s2/node.entitlements" \
  "$C/Resources/node/bin/node"
sign --identifier org.openlfcp.bridge.reminders-helper \
  --entitlements "$ROOT/helper/Support/release.entitlements" "$C/MacOS/lfcp-reminders-helper"
sign "$F/Versions/B/Autoupdate"
sign "$F/Versions/B/Updater.app"
sign "$F"
sign --entitlements "$SHELL_ENT" "$APP"

codesign --verify --strict --deep --verbose=2 "$APP"
