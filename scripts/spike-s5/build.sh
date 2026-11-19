#!/usr/bin/env bash
# Spike S-5: build the probe app (S5Probe.app) and the AX driver (s5-ax) for the host architecture,
# ad-hoc signed. Usage: scripts/spike-s5/build.sh <out-dir>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:?usage: build.sh <out-dir>}"
mkdir -p "$out"

app="$out/S5Probe.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>org.openlfcp.spike.s5probe</string>
  <key>CFBundleName</key><string>S5Probe</string>
  <key>CFBundleExecutable</key><string>S5Probe</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.0.1</string>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>LSUIElement</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PLIST
xcrun swiftc -O -target "$(uname -m)-apple-macos15.0" -o "$app/Contents/MacOS/S5Probe" "$here/app/main.swift"
codesign --force --sign - "$app"

xcrun swiftc -O -target "$(uname -m)-apple-macos15.0" -o "$out/s5-ax" "$here/driver/main.swift"
codesign --force --sign - --identifier org.openlfcp.spike.s5-ax "$out/s5-ax"

codesign -dvv "$app" 2>&1 | grep -E '^(Identifier|CodeDirectory|Signature)' || true
codesign -dvv "$out/s5-ax" 2>&1 | grep -E '^(Identifier|CodeDirectory|Signature)' || true
