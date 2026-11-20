#!/bin/bash
# Notarization and staple of a Developer ID signed app or DMG (E-052, R-601 §5): notarytool with
# the App Store Connect API key of the environment `release` (E-057), then stapler.
#
#   scripts/release/notarize.sh <LFCP Bridge.app | x.dmg>
#
# Environment: NOTARY_API_KEY_P8_BASE64, NOTARY_KEY_ID, NOTARY_ISSUER_ID.
set -euo pipefail
TARGET="${1:?usage: notarize.sh <app|dmg>}"
: "${NOTARY_API_KEY_P8_BASE64:?no NOTARY_API_KEY_P8_BASE64 (environment release, E-057)}"
: "${NOTARY_KEY_ID:?no NOTARY_KEY_ID}"
: "${NOTARY_ISSUER_ID:?no NOTARY_ISSUER_ID}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
printf '%s' "$NOTARY_API_KEY_P8_BASE64" | base64 --decode > "$tmp/key.p8"
auth=(--key "$tmp/key.p8" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER_ID")

submit="$TARGET"
case "$TARGET" in
  *.app) submit="$tmp/$(basename "$TARGET" .app).zip"; ditto -c -k --keepParent "$TARGET" "$submit" ;;
esac
result="$(xcrun notarytool submit "$submit" "${auth[@]}" --wait --output-format json)"
echo "$result"
status="$(jq -r .status <<< "$result")"
if [ "$status" != Accepted ]; then
  id="$(jq -r '.id // empty' <<< "$result")"
  [ -z "$id" ] || xcrun notarytool log "$id" "${auth[@]}" >&2 || true
  echo "notarize: $TARGET: $status" >&2
  exit 1
fi
xcrun stapler staple "$TARGET"
xcrun stapler validate "$TARGET"
case "$TARGET" in
  *.app) spctl --assess --type execute --verbose=2 "$TARGET" ;;
  *) spctl --assess --type open --context context:primary-signature --verbose=2 "$TARGET" ;;
esac
