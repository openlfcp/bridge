#!/bin/bash
# Build "LFCP L3 Person.app" (scripts/l3/person/main.swift) for the native architecture, ad-hoc
# signed with the hardened runtime and the Calendars entitlement (EventKit reminders need it under
# the hardened runtime), as spike S-3 built its EventKit probe.
#   scripts/l3/build-person.sh [out dir]      # default: build/l3
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-build/l3}"
APP="$OUT/LFCP L3 Person.app"
BID=org.openlfcp.bridge.l3-person
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
xcrun swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos14" \
  scripts/l3/person/main.swift -o "$APP/Contents/MacOS/l3-person"
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key><string>$BID</string>
	<key>CFBundleExecutable</key><string>l3-person</string>
	<key>CFBundleName</key><string>LFCP L3 Person</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>1</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>LSUIElement</key><true/>
	<key>LSMinimumSystemVersion</key><string>14.0</string>
	<key>NSRemindersFullAccessUsageDescription</key><string>The L3 tests act as a person in Reminders.</string>
	<key>NSRemindersUsageDescription</key><string>The L3 tests act as a person in Reminders.</string>
</dict>
</plist>
EOF
plutil -lint "$APP/Contents/Info.plist" >/dev/null
codesign --force --options runtime --entitlements helper/Support/release.entitlements --sign - "$APP"
codesign --verify --strict "$APP"
echo "== built $APP"
