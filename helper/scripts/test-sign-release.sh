#!/bin/bash
# Dry run of scripts/sign-release.sh: security, codesign, xcrun (notarytool, stapler), ditto and spctl
# are stubs that record their arguments; the app is a stand-in directory. Nothing is signed or
# sent to Apple, no keychain is read or changed.
#   scripts/test-sign-release.sh
# Shellcheck: SC2015 (cond && ok || bad) is fine here, ok only echoes and returns 0, so bad runs
# exactly when cond fails; SC2016, the stub bodies are single-quoted on purpose, they expand when a
# stub runs.
# shellcheck disable=SC2015,SC2016
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
HELPER="$PWD"
fails=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }

T="$(mktemp -d /tmp/lfcp-sign-release-test.XXXXXX)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/out/LFCP Reminders Helper.app/Contents"
cat > "$T/out/LFCP Reminders Helper.app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>0.5.0</string></dict></plist>
PLIST
LOG="$T/calls.log"
ID="Developer ID Application: Test Owner (ABCDE12345)"
KC="/tmp/Release Keys.keychain-db"

# Each call: one line "cmd" then one line per argument as "  [arg]".
stub() {
  local name="$1" body="$2"
  cat > "$T/bin/$name" <<STUB
#!/bin/bash
{ echo "$name"; for a in "\$@"; do echo "  [\$a]"; done; } >> "$LOG"
$body
exit 0
STUB
  chmod +x "$T/bin/$name"
}
stub security '
case "$1" in
  find-identity)
    [ -f "'"$T"'/have-identity" ] && echo "  1) 0123456789ABCDEF0123456789ABCDEF01234567 \"'"$ID"'\""
    ;;
  list-keychains)
    if [ "${4:-}" = "-s" ]; then
      # the restore (the call without the release keychain) fails when asked to
      if [ -f "'"$T"'/restore-fails" ] && ! printf "%s\n" "$@" | grep -qx "'"$KC"'"; then exit 1; fi
    else
      [ -f "'"$T"'/list-fails" ] && exit 1
      [ -f "'"$T"'/list-empty" ] || printf "    \"%s\"\n" "/Users/x/Library/Keychains/login.keychain-db"
    fi ;;
esac'
stub codesign '
if [ "$1" = "-d" ] && [ "$2" = "--verbose=2" ]; then
  echo "Identifier=org.openlfcp.bridge.reminders" >&2
  if [ -f "'"$T"'/no-runtime" ]; then echo "CodeDirectory v=20500 size=1 flags=0x0(none)" >&2
  else echo "CodeDirectory v=20500 size=1 flags=0x10000(runtime)" >&2; fi
  echo "Authority='"$ID"'" >&2
fi
if [ "$1" = "-d" ] && [ "$2" = "--entitlements" ]; then
  echo "<key>com.apple.security.personal-information.calendars</key><true/>"
fi'
stub xcrun '
if [ "$1" = notarytool ] && [ "$2" = submit ]; then
  echo "{\"id\":\"11111111-2222-3333-4444-555555555555\",\"status\":\"$(cat "'"$T"'/notary-status")\"}"
fi'
stub ditto ''
stub spctl ''

run() {
  : > "$LOG"
  PATH="$T/bin:$PATH" "$HELPER/scripts/sign-release.sh" --no-build --out "$T/out" "$@" >"$T/stdout" 2>"$T/stderr"
}
called() { grep -qx -- "$1" "$LOG"; }
# The arguments of the first call of $1 whose first argument is $2, one per line.
args_of() { awk -v c="$1" -v f="  [$2]" '$0==c{grab=1; n=0; next} grab&&/^  \[/{ if(n==0 && $0!=f){grab=0; next} print; n++; next} {grab=0}' "$LOG"; }

touch "$T/have-identity"
echo Accepted > "$T/notary-status"

run; [ $? = 2 ] && grep -q -- '--identity is required' "$T/stderr" && ok "no --identity: refused" || bad "no --identity"
run --identity "LFCP Bridge Dev"; [ $? = 2 ] && ! called codesign && ok "a non-Developer ID identity is refused" || bad "dev identity"
run --identity "$ID" --notarize; [ $? = 2 ] && grep -q 'needs --notary-profile' "$T/stderr" && ok "--notarize without credentials: refused" || bad "notarize w/o credentials"
run --identity "$ID" --notary-profile p; [ $? = 2 ] && ok "notary options without --notarize: refused" || bad "profile w/o notarize"
run --identity "$ID" --notarize --api-key /nonexistent.p8 --api-key-id K --api-issuer I; [ $? = 2 ] && ok "missing API key file: refused" || bad "api key file"
run --identity "$ID" --add-to-search-list; [ $? = 2 ] && ok "--add-to-search-list without --keychain: refused" || bad "search list w/o keychain"

rm "$T/have-identity"
run --identity "$ID"; rc=$?
[ "$rc" = 2 ] && ! called codesign && grep -q 'no valid code-signing identity' "$T/stderr" && ok "identity not found: nothing signed" || bad "identity not found ($rc)"
touch "$T/have-identity"

run --identity "$ID"; rc=$?
sign="$(args_of codesign --force)"
if [ "$rc" = 0 ] && grep -qx '  \[--options\]' <<<"$sign" && grep -qx '  \[runtime\]' <<<"$sign" &&
  grep -qx '  \[--timestamp\]' <<<"$sign" && grep -qx '  \[Support/release.entitlements\]' <<<"$sign" &&
  grep -qx "  \[$ID\]" <<<"$sign" && ! called xcrun && ! grep -qx '  \[-s\]' "$LOG"; then
  ok "sign only: Developer ID, hardened runtime, timestamp, entitlements; no notarization, no keychain change"
else bad "sign only ($rc)"; cat "$T/stderr"; fi

run --identity "$ID" --keychain "$KC"; rc=$?
[ "$rc" = 0 ] && grep -qx "  \[$KC\]" "$LOG" && ! grep -qx '  \[-s\]' "$LOG" && ok "--keychain alone: passed to codesign, search list untouched" || bad "--keychain alone ($rc)"

run --identity "$ID" --keychain "$KC" --add-to-search-list; rc=$?
sets="$(grep -c '^  \[-s\]$' "$LOG")"
last_set="$(awk '/^security$/{buf=""; s=1; next} s&&/^  \[/{buf=buf $0 "\n"; next} {if(s && buf ~ /\[-s\]/) last=buf; s=0} END{if(s && buf ~ /\[-s\]/) last=buf; printf "%s", last}' "$LOG")"
[ "$rc" = 0 ] && [ "$sets" = 2 ] && ! grep -q "$KC" <<<"$last_set" && ok "--add-to-search-list: added for the signing, then the list restored exactly" || bad "search list restore ($rc, $sets sets)"

run --identity "$ID" --notarize --notary-profile lfcp-notary; rc=$?
sub="$(args_of xcrun notarytool)"
[ "$rc" = 0 ] && grep -qx '  \[--keychain-profile\]' <<<"$sub" && grep -qx '  \[lfcp-notary\]' <<<"$sub" &&
  grep -qx '  \[--wait\]' <<<"$sub" && grep -qx '  \[staple\]' "$LOG" && grep -qx '  \[validate\]' "$LOG" && called spctl &&
  ok "notarize with a profile: submit --wait, staple, validate, spctl" || { bad "notarize profile ($rc)"; cat "$T/stderr"; }

key="$T/AuthKey_K.p8"; : > "$key"
run --identity "$ID" --notarize --api-key "$key" --api-key-id K123 --api-issuer ISS; rc=$?
[ "$rc" = 0 ] && grep -qx "  \[$key\]" "$LOG" && grep -qx '  \[K123\]' "$LOG" && grep -qx '  \[ISS\]' "$LOG" &&
  ok "notarize with an API key: --key, --key-id, --issuer" || bad "notarize api key ($rc)"

echo Invalid > "$T/notary-status"
run --identity "$ID" --notarize --notary-profile lfcp-notary; rc=$?
[ "$rc" = 4 ] && grep -qx '  \[log\]' "$LOG" && ! grep -qx '  \[staple\]' "$LOG" && ok "notarization Invalid: exit 4, the log fetched, nothing stapled" || bad "notary invalid ($rc)"
echo Accepted > "$T/notary-status"

touch "$T/no-runtime"
run --identity "$ID"; rc=$?
[ "$rc" = 2 ] && grep -q 'hardened runtime' "$T/stderr" && ok "a signature without the hardened runtime is refused" || bad "no runtime ($rc)"
rm "$T/no-runtime"

# ---------- review PR 14 P2-1: the keychain search list ----------
touch "$T/list-fails"
run --identity "$ID" --keychain "$KC" --add-to-search-list; rc=$?
[ "$rc" != 0 ] && ! grep -qx '  \[-s\]' "$LOG" && ! called codesign && ok "search list unreadable: nothing changed, nothing signed" || bad "search list unreadable ($rc)"
rm "$T/list-fails"
touch "$T/list-empty"
run --identity "$ID" --keychain "$KC" --add-to-search-list; rc=$?
[ "$rc" != 0 ] && ! grep -qx '  \[-s\]' "$LOG" && ok "search list read as empty: refused, nothing changed" || bad "search list empty ($rc)"
rm "$T/list-empty"
touch "$T/restore-fails"
run --identity "$ID" --keychain "$KC" --add-to-search-list; rc=$?
[ "$rc" != 0 ] && grep -q 'could not restore the keychain search list' "$T/stderr" && grep -q 'login.keychain-db' "$T/stderr" &&
  ok "a failed restore of the search list fails the run and prints the list to restore" || bad "restore failure ($rc)"
rm "$T/restore-fails"

if [ "$fails" = 0 ]; then echo "test-sign-release: all passed"; else echo "test-sign-release: $fails failed"; exit 1; fi
