#!/bin/bash
# The DMG of LFCP Bridge.app: the app and an /Applications link, copied as they are (the release
# chain builds the artifact manifest first, A§9.2). A real identity signs the image.
#
#   scripts/app/make-dmg.sh <app> <dmg>
#
# Environment: SIGN_IDENTITY (default "-": no signature on the image), SIGN_KEYCHAIN.
set -euo pipefail
APP="${1:?usage: make-dmg.sh <app> <dmg>}"
DMG="${2:?usage: make-dmg.sh <app> <dmg>}"
IDENTITY="${SIGN_IDENTITY:--}"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
ditto "$APP" "$stage/LFCP Bridge.app"
ln -s /Applications "$stage/Applications"
rm -f "$DMG"
# ULFO (lzfse): opens on every macOS the app supports (≥ 10.11).
# hdiutil create on hosted runners now and then fails with "Resource busy" (another disk image
# job of the system holds the device): retry that, and only that, a few times.
for attempt in 1 2 3 4 5; do
  if log="$(hdiutil create -volname "LFCP Bridge" -srcfolder "$stage" -fs HFS+ -format ULFO \
    -ov "$DMG" 2>&1)"; then
    break
  fi
  echo "$log" >&2
  if ! grep -q 'Resource busy' <<< "$log" || [ "$attempt" = 5 ]; then
    echo "make-dmg: hdiutil create failed (attempt $attempt)" >&2
    exit 1
  fi
  echo "make-dmg: hdiutil create: Resource busy (attempt $attempt of 5), again in $((attempt * 10)) s" >&2
  sleep $((attempt * 10))
done
# An ad-hoc signature means nothing on a disk image; a real identity signs it (E-052 notarizes it).
if [ "$IDENTITY" != - ]; then
  flags=(--force --sign "$IDENTITY")
  if [ -n "${SIGN_KEYCHAIN:-}" ]; then flags+=(--keychain "$SIGN_KEYCHAIN"); fi
  if [ "${SIGN_TIMESTAMP:-}" = 1 ]; then flags+=(--timestamp); else flags+=(--timestamp=none); fi
  codesign "${flags[@]}" "$DMG"
fi
hdiutil verify "$DMG" >/dev/null
