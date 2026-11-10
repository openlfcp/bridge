#!/bin/bash
# Release signing of LFCP Reminders Helper.app (B5 as changed by the owner): Developer ID, hardened
# runtime, the Calendars entitlement (EventKit reminders), notarization and stapling.
#
#   scripts/sign-release.sh --identity "Developer ID Application: Name (TEAMID)"
#       build, sign, verify — no notarization
#   scripts/sign-release.sh --identity "…" --notarize --notary-profile lfcp-notary
#       … then notarytool submit --wait with a keychain profile (xcrun notarytool store-credentials)
#   scripts/sign-release.sh --identity "…" --notarize --api-key AuthKey_ABC.p8 --api-key-id ABC --api-issuer <uuid>
#       … with an App Store Connect API key instead
#
# Options:
#   --identity <name|SHA-1>   required: a "Developer ID Application" identity
#   --keychain <path>         look for the identity in this keychain (passed to codesign only)
#   --add-to-search-list      put --keychain in the user's keychain search list while signing, and
#                             restore the list exactly afterwards (codesign finds identities only there)
#   --notarize                submit to Apple's notary service, wait, staple, check with spctl
#   --notary-profile <name>   notarytool keychain profile (its credentials stay in the keychain)
#   --api-key <file> --api-key-id <id> --api-issuer <uuid>   App Store Connect API key instead
#   --no-build                sign the existing build/LFCP Reminders Helper.app
#   --out <dir>               the build directory (default build)
#
# This script never creates, imports, unlocks or deletes anything in a keychain, and never changes
# the keychain search list unless --add-to-search-list is given. Passwords are never arguments: an
# app-specific password lives in the notarytool profile, an API key in its .p8 file.
# docs/guides/signing-the-helper.md explains how to get the profile or the key.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="build"
APP_NAME="LFCP Reminders Helper.app"
ENTITLEMENTS="Support/release.entitlements"
BUNDLE_ID="org.openlfcp.bridge.reminders"

identity="" keychain="" add_to_list=0 notarize=0 build=1
profile="" api_key="" api_key_id="" api_issuer=""

die() { echo "sign-release: $*" >&2; exit 2; }
need() { [ $# -ge 2 ] && [ -n "$2" ] && [ "${2#--}" = "$2" ] || die "$1 needs a value"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --identity) need "$@"; identity="$2"; shift 2 ;;
    --keychain) need "$@"; keychain="$2"; shift 2 ;;
    --add-to-search-list) add_to_list=1; shift ;;
    --notarize) notarize=1; shift ;;
    --notary-profile) need "$@"; profile="$2"; shift 2 ;;
    --api-key) need "$@"; api_key="$2"; shift 2 ;;
    --api-key-id) need "$@"; api_key_id="$2"; shift 2 ;;
    --api-issuer) need "$@"; api_issuer="$2"; shift 2 ;;
    --no-build) build=0; shift ;;
    --out) need "$@"; OUT="$2"; shift 2 ;;
    -h | --help) sed -n '2,29p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$identity" ] || die "--identity is required (a \"Developer ID Application: …\" identity)"
case "$identity" in
  "Developer ID Application:"*) ;;
  *)
    grep -Eq '^[0-9A-Fa-f]{40}$' <<<"$identity" ||
      die "--identity must be a \"Developer ID Application: …\" identity or its SHA-1, not \"$identity\""
    ;;
esac
[ "$add_to_list" = 0 ] || [ -n "$keychain" ] || die "--add-to-search-list needs --keychain"
notary_auth=()
if [ "$notarize" = 1 ]; then
  if [ -n "$profile" ]; then
    [ -z "$api_key$api_key_id$api_issuer" ] || die "use either --notary-profile or the --api-key options"
    notary_auth=(--keychain-profile "$profile")
  elif [ -n "$api_key" ] && [ -n "$api_key_id" ] && [ -n "$api_issuer" ]; then
    [ -f "$api_key" ] || die "no API key file at $api_key"
    notary_auth=(--key "$api_key" --key-id "$api_key_id" --issuer "$api_issuer")
  else
    die "--notarize needs --notary-profile, or --api-key with --api-key-id and --api-issuer"
  fi
elif [ -n "$profile$api_key$api_key_id$api_issuer" ]; then
  die "notarization options given without --notarize"
fi
[ -f "$ENTITLEMENTS" ] || die "missing $ENTITLEMENTS"
APP="$OUT/$APP_NAME"

# The identity must be there (read-only lookup) before anything is built or changed.
find_args=(find-identity -v -p codesigning)
[ -z "$keychain" ] || find_args+=("$keychain")
if ! security "${find_args[@]}" | grep -F -- "$identity" >/dev/null; then
  die "no valid code-signing identity \"$identity\"${keychain:+ in $keychain}"
fi

if [ "$add_to_list" = 1 ]; then
  search_list=()
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%\"}"
    line="${line#\"}"
    [ -n "$line" ] && search_list+=("$line")
  done < <(security list-keychains -d user)
  in_list=0
  for k in ${search_list[@]+"${search_list[@]}"}; do
    [ "$k" = "$keychain" ] && in_list=1
  done
  if [ "$in_list" = 0 ]; then
    restore_search_list() { security list-keychains -d user -s ${search_list[@]+"${search_list[@]}"}; }
    trap restore_search_list EXIT
    security list-keychains -d user -s ${search_list[@]+"${search_list[@]}"} "$keychain"
  fi
fi

if [ "$build" = 1 ]; then
  # Built ad-hoc first (both architectures); the release signature replaces it below.
  OUT="$OUT" scripts/build-app.sh
fi
[ -d "$APP" ] || die "no app at $APP (build first, or drop --no-build)"

echo "== codesign: Developer ID, hardened runtime, secure timestamp, $ENTITLEMENTS"
sign_args=(--force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$identity")
[ -z "$keychain" ] || sign_args+=(--keychain "$keychain")
codesign "${sign_args[@]}" "$APP"
codesign --verify --strict --deep --verbose=2 "$APP"
codesign -d --verbose=2 "$APP" 2>&1 | grep -E '^(Identifier|Authority|TeamIdentifier|Timestamp|Runtime Version|CodeDirectory)' || true
details="$(codesign -d --verbose=2 "$APP" 2>&1)"
grep -q "Identifier=$BUNDLE_ID" <<<"$details" || die "signed identifier is not $BUNDLE_ID"
grep -q 'flags=.*runtime' <<<"$details" || die "the hardened runtime flag is missing"
codesign -d --entitlements - "$APP" 2>/dev/null | grep -q 'com.apple.security.personal-information.calendars' ||
  die "the calendars entitlement is missing from the signature"

if [ "$notarize" = 1 ]; then
  work="$(mktemp -d /tmp/lfcp-notarize.XXXXXX)"
  trap_notarize() { rm -rf "$work"; }
  if [ "$add_to_list" = 1 ] && [ "${in_list:-1}" = 0 ]; then
    trap 'trap_notarize; restore_search_list' EXIT
  else
    trap trap_notarize EXIT
  fi
  zip="$work/lfcp-reminders-helper.zip"
  echo "== notarize: submit and wait"
  ditto -c -k --keepParent "$APP" "$zip"
  result="$(xcrun notarytool submit "$zip" "${notary_auth[@]}" --wait --output-format json)"
  echo "$result"
  status="$(sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' <<<"$result" | head -1)"
  id="$(sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' <<<"$result" | head -1)"
  if [ "$status" != "Accepted" ]; then
    echo "sign-release: notarization $status; the log:" >&2
    [ -z "$id" ] || xcrun notarytool log "$id" "${notary_auth[@]}" >&2 || true
    exit 4
  fi
  echo "== staple"
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
  spctl --assess --type execute --verbose=2 "$APP"
fi

version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null || echo '?')"
echo "== release-signed $APP ($version)"
if [ "$notarize" = 1 ]; then echo "   notarized and stapled"; else echo "   not notarized (add --notarize)"; fi
