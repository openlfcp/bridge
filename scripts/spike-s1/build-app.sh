#!/bin/bash
# Spike S-1 (A§2.1–2.3): the S-2 "LFCP Bridge.app" with the minimal Swift shell instead of the C
# launcher, Sparkle 2 and the SMAppService agent plist. Unsigned; scripts/spike-s1/sign-app.sh signs.
#   NODE_VERSION=… SPARKLE_VERSION=… SPARKLE_SHA256=… \
#     scripts/spike-s1/build-app.sh <out-dir> <feed-url> <ed25519-public-key-base64>
#   scripts/spike-s1/build-app.sh --set-version <app> <n>     CFBundleVersion n (Sparkle N → N+1)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
S1="$ROOT/scripts/spike-s1"
MIN_MACOS="${MIN_MACOS:-15.0}"

set_version() { # <app> <n>
  local p="$1/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $2" -c "Set :CFBundleShortVersionString 0.6.0-spike.s1.$2" "$p"
  plutil -lint "$p" >/dev/null
}
if [ "${1:-}" = --set-version ]; then set_version "${2:?app}" "${3:?n}"; exit 0; fi

OUT="$(mkdir -p "${1:?usage: build-app.sh <out-dir> <feed-url> <ed-public-key>}" && cd "$1" && pwd)"
FEED="${2:?feed url}"
ED_PUBLIC="${3:?ed25519 public key}"
SPARKLE_VERSION="${SPARKLE_VERSION:?pin SPARKLE_VERSION}"
SPARKLE_SHA256="${SPARKLE_SHA256:?pin SPARKLE_SHA256}"

# node, host bundle, better-sqlite3 subtree, helper, Info.plist; its C launcher is replaced below.
MIN_MACOS="$MIN_MACOS" "$ROOT/scripts/spike-s2/build-app.sh" "$OUT"
APP="$OUT/LFCP Bridge.app"
C="$APP/Contents"
WORK="$OUT/s1-work"
rm -rf "$WORK"
mkdir -p "$WORK" "$C/Frameworks" "$C/Library/LaunchAgents"

echo "== Sparkle $SPARKLE_VERSION"
curl -fsSL "https://github.com/sparkle-project/Sparkle/releases/download/$SPARKLE_VERSION/Sparkle-$SPARKLE_VERSION.tar.xz" \
  -o "$WORK/sparkle.tar.xz"
echo "$SPARKLE_SHA256  $WORK/sparkle.tar.xz" | shasum -a 256 -c -
mkdir "$WORK/sparkle"
tar -xJf "$WORK/sparkle.tar.xz" -C "$WORK/sparkle"
ditto "$WORK/sparkle/Sparkle.framework" "$C/Frameworks/Sparkle.framework"
# Not sandboxed: Sparkle's XPC services are optional, leave them out (one less thing to sign).
rm -rf "$C/Frameworks/Sparkle.framework/XPCServices" "$C/Frameworks/Sparkle.framework/Versions/B/XPCServices"

echo "== shell (universal)"
slices=()
for arch in arm64 x86_64; do
  xcrun clang -c -fobjc-arc -fmodules -Wall -arch "$arch" -mmacosx-version-min="$MIN_MACOS" \
    -F "$C/Frameworks" "$S1/shell/SparkleBridge.m" -o "$WORK/sparkle-bridge-$arch.o"
  xcrun swiftc -O -swift-version 5 -target "$arch-apple-macos$MIN_MACOS" \
    -import-objc-header "$S1/shell/SparkleBridge.h" -F "$C/Frameworks" \
    "$S1/shell/main.swift" "$WORK/sparkle-bridge-$arch.o" \
    -framework Sparkle -Xlinker -rpath -Xlinker @executable_path/../Frameworks \
    -o "$WORK/shell-$arch"
  slices+=("$WORK/shell-$arch")
done
xcrun lipo -create "${slices[@]}" -output "$C/MacOS/LFCP Bridge"

echo "== agent plist, Info.plist"
cp "$S1/agent.plist" "$C/Library/LaunchAgents/org.openlfcp.bridge.agent.plist"
plutil -lint "$C/Library/LaunchAgents/org.openlfcp.bridge.agent.plist" >/dev/null
P="$C/Info.plist"
pb() { /usr/libexec/PlistBuddy -c "$1" "$P"; }
pb "Add :SUFeedURL string $FEED"
pb "Add :SUPublicEDKey string $ED_PUBLIC"
pb "Add :SUEnableAutomaticChecks bool false"
pb "Add :NSRemindersUsageDescription string LFCP Bridge syncs your notes with Reminders."
pb "Add :NSRemindersFullAccessUsageDescription string LFCP Bridge syncs your notes with Reminders."
# The spike's appcast is served over http from 127.0.0.1.
pb "Add :NSAppTransportSecurity dict"
pb "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true"
set_version "$APP" "${APP_VERSION:-1}"

rm -rf "$WORK"
echo "== built $APP (unsigned, version ${APP_VERSION:-1})"
