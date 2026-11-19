#!/bin/bash
# The release packaging of LFCP Bridge.app (PLAN §E-005, A§2.1, research/s-2-bundle.md): universal
# (arm64 + x86_64, E2), macOS ≥ 15.0 (E15), signed from the inside out under the hardened runtime,
# then a DMG (scripts/app/make-dmg.sh). Notarization, Developer ID and the artifact manifest are the
# release chain (E-052, .github/workflows/release.yml).
#
#   scripts/app/package-app.sh <out-dir>         (macOS with Xcode; after pnpm install --frozen-lockfile)
#
# Environment (all optional):
#   SIGN_IDENTITY     codesign identity; default "-" (ad-hoc). "LFCP Bridge Dev" for a stable DR.
#   SIGN_KEYCHAIN     the keychain holding SIGN_IDENTITY
#   SIGN_TIMESTAMP=1  a secure timestamp (Developer ID); otherwise --timestamp=none
#   VERSION           CFBundleShortVersionString; default packages/host/package.json's version
#   BUILD_NUMBER      CFBundleVersion; default 1
#   SU_FEED_URL, SU_PUBLIC_ED_KEY   Sparkle's feed and EdDSA public key in Info.plist (A§2.3)
#   NODE_CACHE        a directory keeping the Node tarballs between runs
#   PACKAGE_DMG=0     stop after the signature: the release chain (E-052, .github/workflows/release.yml)
#                     notarizes, staples and builds the artifact manifest before scripts/app/make-dmg.sh
#
# Output: <out-dir>/LFCP Bridge.app and <out-dir>/LFCP-Bridge-<version>.dmg (the app and an
# /Applications link). The checks of T§2 L5 are scripts/app/check-app.sh.
#
#   Contents/MacOS/LFCP Bridge                   app/ (swift build -c release, per arch → lipo)
#   Contents/MacOS/lfcp-reminders-helper         helper/scripts/build-app.sh (universal)
#   Contents/Resources/node/bin/node             official Node .node-version, arm64 + x64 → lipo
#   Contents/Resources/node/LICENSE              Node's licence, shipped with its binary
#   Contents/Resources/host/bridge.mjs           scripts/bundle-host.mjs (+ bridge.mjs.LEGAL.txt)
#   Contents/Resources/host/package.json         {"type":"module"}
#   Contents/Resources/bin/lfcp-bridge           app/Support/lfcp-bridge (support CLI, A§7.3)
#   Contents/Resources/host/node_modules/better-sqlite3/   the production subtree: package.json,
#       LICENSE, lib/, build/Release/better_sqlite3.node (lipo of the two darwin prebuilds)
#   Contents/Library/LaunchAgents/org.openlfcp.bridge.agent.plist
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$(mkdir -p "${1:?usage: package-app.sh <out-dir>}" && cd "$1" && pwd)"
APP="$OUT/LFCP Bridge.app"
C="$APP/Contents"
WORK="$OUT/work"
ARCHS=(arm64 x86_64)
MIN_MACOS=15.0
VERSION="${VERSION:-$(node -p 'require(process.argv[1]).version' "$ROOT/packages/host/package.json")}"
BUILD_NUMBER="${BUILD_NUMBER:-1}"
IDENTITY="${SIGN_IDENTITY:--}"
DMG="$OUT/LFCP-Bridge-$VERSION.dmg"

# A release build never has the smoke's hooks (scripts/app/build-dev-app.sh TEST_HOOKS=1 does).
if [ -n "${TEST_HOOKS:-}" ]; then
  echo "package-app: TEST_HOOKS is set; the release build has no test hooks" >&2
  exit 2
fi
NODE_VERSION="$(tr -d '[:space:]' < "$ROOT/.node-version")"
if ! [[ "$NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "package-app: .node-version is '$NODE_VERSION', not an exact version" >&2
  exit 2
fi

rm -rf "$APP" "$WORK" "$DMG"
mkdir -p "$C/MacOS" "$C/Resources/node/bin" "$C/Resources/host/node_modules" \
  "$C/Library/LaunchAgents" "$WORK"

echo "== shell (${ARCHS[*]}, release)"
slices=()
for arch in "${ARCHS[@]}"; do
  # Its own build directory: never objects of a build with hooks (build-dev-app.sh uses .build/dev*).
  scratch="$ROOT/app/.build/package-$arch"
  (cd "$ROOT/app" && swift build -c release --arch "$arch" --scratch-path "$scratch")
  bin="$(cd "$ROOT/app" && swift build -c release --arch "$arch" --scratch-path "$scratch" --show-bin-path)"
  slices+=("$bin/LFCPBridge")
done
xcrun lipo -create "${slices[@]}" -output "$C/MacOS/LFCP Bridge"

echo "== Info.plist $VERSION ($BUILD_NUMBER), agent plist"
P="$C/Info.plist"
cp "$ROOT/app/Support/Info.plist" "$P"
pb() { /usr/libexec/PlistBuddy -c "$1" "$P"; }
pb "Set :CFBundleShortVersionString $VERSION"
pb "Set :CFBundleVersion $BUILD_NUMBER"
if [ -n "${SU_FEED_URL:-}" ]; then pb "Add :SUFeedURL string $SU_FEED_URL"; fi
if [ -n "${SU_PUBLIC_ED_KEY:-}" ]; then pb "Add :SUPublicEDKey string $SU_PUBLIC_ED_KEY"; fi
plutil -lint "$P" >/dev/null
min="$(pb "Print :LSMinimumSystemVersion")"
if [ "$min" != "$MIN_MACOS" ]; then
  echo "package-app: LSMinimumSystemVersion $min, want $MIN_MACOS (E15)" >&2
  exit 1
fi
cp "$ROOT/app/Support/agent.plist" "$C/Library/LaunchAgents/org.openlfcp.bridge.agent.plist"
plutil -lint "$C/Library/LaunchAgents/org.openlfcp.bridge.agent.plist" >/dev/null

echo "== helper (${ARCHS[*]})"
OUT="$WORK/helper" ARCHS="${ARCHS[*]}" MIN_MACOS="$MIN_MACOS" "$ROOT/helper/scripts/build-app.sh" >/dev/null
cp "$WORK/helper/LFCP Reminders Helper.app/Contents/MacOS/lfcp-reminders-helper" "$C/MacOS/"

echo "== node v$NODE_VERSION (official arm64 + x64 → lipo)"
cache="${NODE_CACHE:-$WORK/node-cache}"
mkdir -p "$cache"
node_slices=()
for arch in arm64 x64; do
  tgz="node-v$NODE_VERSION-darwin-$arch.tar.gz"
  pinned="$(awk -v f="$tgz" '$2 == f { print $1 }' "$ROOT/scripts/app/node-darwin.sha256")"
  if [ -z "$pinned" ]; then
    echo "package-app: no pinned SHA-256 for $tgz in scripts/app/node-darwin.sha256" >&2
    exit 1
  fi
  if ! [ -f "$cache/$tgz" ] || [ "$(shasum -a 256 "$cache/$tgz" | cut -d' ' -f1)" != "$pinned" ]; then
    curl -fsSL --retry 3 "https://nodejs.org/dist/v$NODE_VERSION/$tgz" -o "$cache/$tgz"
  fi
  echo "$pinned  $cache/$tgz" | shasum -a 256 -c -
  tar -xzf "$cache/$tgz" -C "$WORK" "node-v$NODE_VERSION-darwin-$arch/bin/node" \
    "node-v$NODE_VERSION-darwin-$arch/LICENSE"
  node_slices+=("$WORK/node-v$NODE_VERSION-darwin-$arch/bin/node")
done
xcrun lipo -create "${node_slices[@]}" -output "$C/Resources/node/bin/node"
cp "$WORK/node-v$NODE_VERSION-darwin-arm64/LICENSE" "$C/Resources/node/LICENSE"

echo "== host bundle"
(cd "$ROOT" && pnpm build >/dev/null)
node "$ROOT/scripts/bundle-host.mjs" "$C/Resources/host/bridge.mjs"
echo '{"type":"module"}' > "$C/Resources/host/package.json"
# The support CLI (A§7.3): a thin client of the host, sealed with Resources/.
mkdir -p "$C/Resources/bin"
install -m 755 "$ROOT/app/Support/lfcp-bridge" "$C/Resources/bin/lfcp-bridge"

echo "== better-sqlite3 production subtree"
src="$(cd "$ROOT/packages/host" && node -p 'path.dirname(require.resolve("better-sqlite3/package.json"))')"
# Its one dependency, node-addon-api, is C++ headers for building it; nothing requires it at run
# time. Another dependency would have to come along: stop rather than ship a broken subtree.
deps="$(node -p 'Object.keys(require(process.argv[1]).dependencies ?? {}).join(" ")' "$src/package.json")"
if [ "$deps" != node-addon-api ]; then
  echo "package-app: better-sqlite3 depends on '$deps'; the subtree carries none of them" >&2
  exit 1
fi
B="$C/Resources/host/node_modules/better-sqlite3"
mkdir -p "$B/build/Release"
cp "$src/package.json" "$src/LICENSE" "$B/"
cp -R "$src/lib" "$B/lib"
# lib/binding.js loads prebuilds/<platform>-<arch>.node, else build/Release/better_sqlite3.node:
# one universal file at the second place serves both slices.
xcrun lipo -create "$src/prebuilds/darwin-arm64.node" "$src/prebuilds/darwin-x64.node" \
  -output "$B/build/Release/better_sqlite3.node"

echo "== codesign ($IDENTITY, hardened runtime, inside out)"
sign_flags=(--force --sign "$IDENTITY")
if [ -n "${SIGN_KEYCHAIN:-}" ]; then sign_flags+=(--keychain "$SIGN_KEYCHAIN"); fi
sign_flags+=(--options runtime)
if [ "${SIGN_TIMESTAMP:-}" = 1 ]; then sign_flags+=(--timestamp); else sign_flags+=(--timestamp=none); fi
sign() { codesign "${sign_flags[@]}" "$@"; }
# 1. Loadable code: the native module (a bundle-less Mach-O, named by its identifier).
sign --identifier org.openlfcp.bridge.better-sqlite3 "$B/build/Release/better_sqlite3.node"
# 2. Nested executables, each with its own entitlements (research/s-2-bundle.md).
sign --identifier org.openlfcp.bridge.node --entitlements "$ROOT/app/Support/node.entitlements" \
  "$C/Resources/node/bin/node"
sign --identifier org.openlfcp.bridge.reminders-helper \
  --entitlements "$ROOT/helper/Support/release.entitlements" "$C/MacOS/lfcp-reminders-helper"
# 3. The bundle last: signs the shell and seals Resources/ (bridge.mjs, the plists, the subtree).
sign --entitlements "$ROOT/app/Support/shell.entitlements" "$APP"
codesign --verify --strict --deep --verbose=2 "$APP"

if [ "${PACKAGE_DMG:-1}" = 0 ]; then
  rm -rf "$WORK"
  echo "== built $APP (no DMG: PACKAGE_DMG=0)"
  du -sh "$APP"
  exit 0
fi

echo "== DMG"
SIGN_IDENTITY="$IDENTITY" "$ROOT/scripts/app/make-dmg.sh" "$APP" "$DMG"

rm -rf "$WORK"
echo "== built $APP"
du -sh "$APP"
echo "== $DMG"
du -h "$DMG"
shasum -a 256 "$DMG"
