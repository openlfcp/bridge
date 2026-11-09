#!/bin/bash
# Build "LFCP Reminders Helper.app" with swiftc only (arm64 + x86_64 by default) and sign it.
#   scripts/build-app.sh                         # ad-hoc signature (CI; TCC treats every build as new)
#   SIGN_IDENTITY="LFCP Bridge Dev" scripts/build-app.sh   # stable dev signature (scripts/sign-dev.sh)
#   ARCHS=x86_64 scripts/build-app.sh
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${OUT:-build}"
ARCHS="${ARCHS:-arm64 x86_64}"
MIN_MACOS="${MIN_MACOS:-12.0}"
APP="$OUT/LFCP Reminders Helper.app"
EXE=lfcp-reminders-helper
VERSION="$(sed -n 's/.*static let version = "\(.*\)".*/\1/p' Sources/HelperCore/Protocol.swift)"
mkdir -p "$OUT"

slices=()
for arch in $ARCHS; do
  echo "== $EXE ($arch)"
  xcrun swiftc -O -swift-version 5 -target "$arch-apple-macos$MIN_MACOS" \
    -module-name LFCPRemindersHelper \
    Sources/HelperCore/*.swift Sources/HelperApp/*.swift \
    -o "$OUT/$EXE-$arch"
  slices+=("$OUT/$EXE-$arch")
done

mkdir -p "$APP/Contents/MacOS"
xcrun lipo -create "${slices[@]}" -output "$APP/Contents/MacOS/$EXE"
sed "s/@VERSION@/$VERSION/g" Support/Info.plist > "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist" >/dev/null

if [ -n "${SIGN_IDENTITY:-}" ]; then
  echo "== codesign ($SIGN_IDENTITY)"
  codesign --force --sign "$SIGN_IDENTITY" ${SIGN_KEYCHAIN:+--keychain "$SIGN_KEYCHAIN"} "$APP"
else
  echo "== codesign (ad-hoc)"
  codesign --force --sign - "$APP"
fi
codesign --verify --strict --verbose=1 "$APP"
codesign -d -r- "$APP" 2>&1 | sed -n 's/^designated => /designated requirement: /p'
xcrun lipo -info "$APP/Contents/MacOS/$EXE"
echo "== built $APP ($VERSION)"
