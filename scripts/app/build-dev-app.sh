#!/bin/bash
# A development "LFCP Bridge.app" for the L5 smoke (PLAN §E-004): the layout of A§2.1 for the
# machine's own architecture, signed ad-hoc from the inside out with the hardened runtime. The
# release build (pinned universal Node, both slices, Sparkle, DMG) is E-005's scripts/package-app.
#
#   scripts/app/build-dev-app.sh <out-dir>              (macOS; after pnpm install --frozen-lockfile)
#   TEST_HOOKS=1 scripts/app/build-dev-app.sh <out-dir> the shell with the smoke's hooks
#
#   Contents/MacOS/LFCP Bridge                   app/ (swift build -c release)
#   Contents/MacOS/lfcp-reminders-helper         helper/scripts/build-app.sh
#   Contents/Resources/node/bin/node             the node running this script (v24, .node-version)
#   Contents/Resources/host/bridge.mjs           scripts/bundle-host.mjs
#   Contents/Resources/host/package.json         {"type":"module"}
#   Contents/Resources/host/node_modules/better-sqlite3/   package.json, lib/, this arch's .node
#   Contents/Library/LaunchAgents/org.openlfcp.bridge.agent.plist
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$(mkdir -p "${1:?usage: build-dev-app.sh <out-dir>}" && cd "$1" && pwd)"
APP="$OUT/LFCP Bridge.app"
C="$APP/Contents"
WORK="$OUT/work"
ARCH="$(uname -m)"
VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT/packages/host/package.json")"
rm -rf "$APP" "$WORK"
mkdir -p "$C/MacOS" "$C/Resources/node/bin" "$C/Resources/host/node_modules" \
  "$C/Library/LaunchAgents" "$WORK"

echo "== shell ($ARCH${TEST_HOOKS:+, test hooks})"
flags=()
if [ "${TEST_HOOKS:-}" = 1 ]; then flags=(-Xswiftc -DLFCP_TEST_HOOKS); fi
# A separate build directory: a build with hooks never shares objects with one without.
scratch="$ROOT/app/.build/dev${TEST_HOOKS:+-hooks}"
(cd "$ROOT/app" && swift build -c release --scratch-path "$scratch" ${flags[@]+"${flags[@]}"})
bin="$(cd "$ROOT/app" && swift build -c release --scratch-path "$scratch" ${flags[@]+"${flags[@]}"} --show-bin-path)"
cp "$bin/LFCPBridge" "$C/MacOS/LFCP Bridge"

echo "== Info.plist, agent plist"
cp "$ROOT/app/Support/Info.plist" "$C/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION-dev" \
  -c "Set :CFBundleVersion ${BUILD_NUMBER:-1}" "$C/Info.plist"
plutil -lint "$C/Info.plist" >/dev/null
cp "$ROOT/app/Support/agent.plist" "$C/Library/LaunchAgents/org.openlfcp.bridge.agent.plist"
plutil -lint "$C/Library/LaunchAgents/org.openlfcp.bridge.agent.plist" >/dev/null

echo "== helper ($ARCH)"
OUT="$WORK/helper" ARCHS="$ARCH" "$ROOT/helper/scripts/build-app.sh" >/dev/null
cp "$WORK/helper/LFCP Reminders Helper.app/Contents/MacOS/lfcp-reminders-helper" "$C/MacOS/"

echo "== node $(node --version)"
cp "$(node -p process.execPath)" "$C/Resources/node/bin/node"

echo "== host bundle"
(cd "$ROOT" && pnpm build >/dev/null)
node "$ROOT/scripts/bundle-host.mjs" "$C/Resources/host/bridge.mjs"
echo '{"type":"module"}' > "$C/Resources/host/package.json"

echo "== better-sqlite3"
src="$(cd "$ROOT/packages/host" && node -p 'path.dirname(require.resolve("better-sqlite3/package.json"))')"
B="$C/Resources/host/node_modules/better-sqlite3"
mkdir -p "$B/prebuilds"
cp "$src/package.json" "$B/"
cp -R "$src/lib" "$B/lib"
node_arch="$(node -p process.arch)"
# lib/binding.js loads prebuilds/<platform>-<arch>.node; only this machine's is needed here.
cp "$src/prebuilds/darwin-$node_arch.node" "$B/prebuilds/"

echo "== codesign (ad-hoc, hardened runtime, inside out)"
sign() { codesign --force --sign - --timestamp=none --options runtime "$@"; }
sign --identifier org.openlfcp.bridge.better-sqlite3 "$B/prebuilds/darwin-$node_arch.node"
sign --identifier org.openlfcp.bridge.node --entitlements "$ROOT/app/Support/node.entitlements" \
  "$C/Resources/node/bin/node"
sign --identifier org.openlfcp.bridge.reminders-helper \
  --entitlements "$ROOT/helper/Support/release.entitlements" "$C/MacOS/lfcp-reminders-helper"
sign --entitlements "$ROOT/app/Support/shell.entitlements" "$APP"
codesign --verify --strict --deep --verbose=1 "$APP"

rm -rf "$WORK"
echo "== built $APP"
du -sh "$APP"
