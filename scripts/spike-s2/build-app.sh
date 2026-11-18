#!/bin/bash
# Spike S-2 (A§2.1): assemble a minimal, unsigned "LFCP Bridge.app" with the bundled host.
#   scripts/spike-s2/build-app.sh <out-dir>        (macOS; after pnpm install --frozen-lockfile)
#
#   Contents/MacOS/LFCP Bridge                launcher.c (stand-in for the shell), universal
#   Contents/MacOS/lfcp-reminders-helper      helper/scripts/build-app.sh, universal
#   Contents/Resources/node/bin/node          official Node $NODE_VERSION, arm64 + x64 → lipo
#   Contents/Resources/host/bridge.mjs        scripts/bundle-host.mjs (ESM, Automerge wasm inside)
#   Contents/Resources/host/package.json      {"type":"module"}
#   Contents/Resources/host/node_modules/better-sqlite3/   pnpm deploy --prod subtree:
#       package.json, lib/, build/Release/better_sqlite3.node (lipo of the two darwin prebuilds)
#
# Signing is scripts/spike-s2/sign-app.sh, checks scripts/spike-s2/check-app.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$(mkdir -p "${1:?usage: build-app.sh <out-dir>}" && cd "$1" && pwd)"
NODE_VERSION="${NODE_VERSION:?pin NODE_VERSION, e.g. 24.22.3}"
MIN_MACOS="${MIN_MACOS:-15.0}"
APP="$OUT/LFCP Bridge.app"
C="$APP/Contents"
WORK="$OUT/work"
rm -rf "$APP" "$WORK"
mkdir -p "$C/MacOS" "$C/Resources/node/bin" "$C/Resources/host/node_modules" "$WORK"

echo "== Info.plist"
cat > "$C/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key><string>org.openlfcp.bridge</string>
	<key>CFBundleName</key><string>LFCP Bridge</string>
	<key>CFBundleExecutable</key><string>LFCP Bridge</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>0.6.0-spike.s2</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>LSMinimumSystemVersion</key><string>$MIN_MACOS</string>
	<key>LSUIElement</key><true/>
</dict>
</plist>
EOF
plutil -lint "$C/Info.plist" >/dev/null

echo "== launcher (universal)"
xcrun clang -O2 -Wall -Werror -arch arm64 -arch x86_64 -mmacosx-version-min="$MIN_MACOS" \
  "$ROOT/scripts/spike-s2/launcher.c" -o "$C/MacOS/LFCP Bridge"

echo "== helper (universal)"
OUT="$WORK/helper" "$ROOT/helper/scripts/build-app.sh" >/dev/null
cp "$WORK/helper/LFCP Reminders Helper.app/Contents/MacOS/lfcp-reminders-helper" "$C/MacOS/"

echo "== node v$NODE_VERSION (official arm64 + x64 → lipo)"
base="https://nodejs.org/dist/v$NODE_VERSION"
curl -fsSL "$base/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
slices=()
for arch in arm64 x64; do
  tgz="node-v$NODE_VERSION-darwin-$arch.tar.gz"
  curl -fsSL "$base/$tgz" -o "$WORK/$tgz"
  (cd "$WORK" && grep " $tgz\$" SHASUMS256.txt | shasum -a 256 -c -)
  tar -xzf "$WORK/$tgz" -C "$WORK" "node-v$NODE_VERSION-darwin-$arch/bin/node"
  slices+=("$WORK/node-v$NODE_VERSION-darwin-$arch/bin/node")
done
xcrun lipo -create "${slices[@]}" -output "$C/Resources/node/bin/node"

echo "== host bundle"
(cd "$ROOT" && pnpm build >/dev/null)
node "$ROOT/scripts/bundle-host.mjs" "$C/Resources/host/bridge.mjs"
echo '{"type":"module"}' > "$C/Resources/host/package.json"

echo "== better-sqlite3 production subtree"
(cd "$ROOT" && pnpm --filter @openlfcp/bridge deploy --legacy --prod "$WORK/deploy" >/dev/null)
B="$C/Resources/host/node_modules/better-sqlite3"
cp -RL "$WORK/deploy/node_modules/better-sqlite3" "$B"
# Runtime needs package.json and lib/ (lib/binding.js: prebuilds/<platform>-<arch>.node, else
# build/Release/better_sqlite3.node). The sources, sqlite amalgamation and other platforms stay out.
mkdir -p "$B/build/Release"
xcrun lipo -create "$B/prebuilds/darwin-arm64.node" "$B/prebuilds/darwin-x64.node" \
  -output "$B/build/Release/better_sqlite3.node"
rm -rf "$B/prebuilds" "$B/src" "$B/deps" "$B/binding.gyp"
# node-addon-api (its only dependency) is C++ headers for building; nothing requires it at runtime.

rm -rf "$WORK"
echo "== built $APP (unsigned)"
du -sh "$APP"
