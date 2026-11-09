#!/bin/bash
# Tests for scripts/sign-dev.sh. Never touches the login keychain.
#   scripts/test-sign-dev.sh          # A: stubbed security/codesign/openssl, fake HOME (always safe)
#   scripts/test-sign-dev.sh --real   # A + B: a real throwaway keychain whose path has spaces
set -uo pipefail
cd "$(dirname "$0")/.."
HELPER="$PWD"
fails=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }

# ---------- A: stubs ----------
T="$(mktemp -d /tmp/lfcp-sign-test.XXXXXX)"
mkdir -p "$T/bin" "$T/home/Library/Keychains" "$T/app/X.app"
LOGIN="$T/home/Library/Keychains/login.keychain-db"
LOG="$T/calls.log"
# Each call: one line "cmd" then one line per argument, prefixed with "  [" and suffixed with "]".
for cmd in security codesign; do
  cat > "$T/bin/$cmd" <<STUB
#!/bin/bash
{ echo "$cmd"; for a in "\$@"; do echo "  [\$a]"; done; } >> "$LOG"
case "$cmd \$1" in
  "security find-certificate") [ -f "$T/have-cert" ] && exit 0 || exit 44 ;;
  "security login-keychain") printf '    "%s"\n' "$LOGIN" ;;
  "security list-keychains")
    if [ "\${3:-}" = "-s" ]; then exit 0; fi
    printf '    "%s"\n' "$LOGIN" "/tmp/Personal Keys.keychain-db" ;;
  "codesign -d") echo 'designated => identifier "org.openlfcp.bridge.reminders" and certificate root = H"00"' >&2 ;;
esac
exit 0
STUB
  chmod +x "$T/bin/$cmd"
done
cat > "$T/bin/openssl" <<STUB
#!/bin/bash
echo "openssl" >> "$LOG"
for a in "\$@"; do case "\$prev" in -out|-keyout) : > "\$a" ;; esac; prev="\$a"; done
[ "\$1" = rand ] && echo 0123456789abcdef
exit 0
STUB
chmod +x "$T/bin/openssl"

run() { # env... -- args...
  : > "$LOG"
  env PATH="$T/bin:$PATH" HOME="$T/home" OPENSSL="$T/bin/openssl" OUT="$T/app" NO_BUILD=1 "$@" \
    "$HELPER/scripts/sign-dev.sh" > "$T/out.txt" 2>&1
}
# The app path the script signs: $OUT/LFCP Reminders Helper.app
mkdir -p "$T/app/LFCP Reminders Helper.app"

# A1: default run, no certificate → refuses, never imports into the login keychain
rm -f "$T/have-cert"
run; rc=$?
if [ $rc -ne 0 ] && ! grep -q '\[import\]' "$LOG" && grep -q -- '--login-keychain' "$T/out.txt"; then
  ok "A1 default run without a certificate refuses; no import into login"
else bad "A1 (rc=$rc): $(cat "$T/out.txt")"; fi

# A2: default run, certificate already in login → signs, imports nothing
touch "$T/have-cert"
run; rc=$?
if [ $rc -eq 0 ] && ! grep -q '\[import\]' "$LOG" && grep -q '^codesign' "$LOG"; then
  ok "A2 default run with an existing certificate signs read-only"
else bad "A2 (rc=$rc): $(cat "$T/out.txt")"; fi

# A3: explicit --login-keychain → creates and imports into login
rm -f "$T/have-cert"
: > "$LOG"
env PATH="$T/bin:$PATH" HOME="$T/home" OPENSSL="$T/bin/openssl" OUT="$T/app" NO_BUILD=1 \
  "$HELPER/scripts/sign-dev.sh" --login-keychain > "$T/out.txt" 2>&1; rc=$?
if [ $rc -eq 0 ] && grep -q '\[import\]' "$LOG" && grep -A3 '\[import\]' "$LOG" | grep -q -- "-k\]"; then
  if grep -A4 '\[import\]' "$LOG" | grep -qF "[$LOGIN]"; then ok "A3 --login-keychain imports into login"; else bad "A3 import target: $(grep -A6 '\[import\]' "$LOG")"; fi
else bad "A3 (rc=$rc): $(cat "$T/out.txt")"; fi

# A4: SIGN_KEYCHAIN with spaces, search list with spaces: every path stays one argument
touch "$T/have-cert"
run SIGN_KEYCHAIN="/tmp/lfcp dev/Dev Keys.keychain-db"; rc=$?
sets="$(awk '/^security$/{s=1;next} s&&/^  \[/{print} /^codesign$/{s=0}' "$LOG" | tr '\n' '|')"
expect_add="  [list-keychains]|  [-d]|  [user]|  [-s]|  [$LOGIN]|  [/tmp/Personal Keys.keychain-db]|  [/tmp/lfcp dev/Dev Keys.keychain-db]|"
expect_restore="  [list-keychains]|  [-d]|  [user]|  [-s]|  [$LOGIN]|  [/tmp/Personal Keys.keychain-db]|"
if [ $rc -eq 0 ] && [[ "$sets" == *"$expect_add"* ]] && [[ "$sets" == *"$expect_restore" ]]; then
  ok "A4 paths with spaces stay whole when adding and when restoring the search list"
else bad "A4 (rc=$rc): $sets"; fi

# A6–A8: other spellings of the login keychain need the flag too (review 5b r2, P2-1)
: > "$LOGIN"
ln -s "$LOGIN" "$T/login-link.keychain-db"
for alias in "$T/home/Library/Keychains/./login.keychain-db" \
             "$T/home/Library/Keychains/../Keychains/login.keychain-db" \
             "$T/login-link.keychain-db"; do
  rm -f "$T/have-cert"
  run SIGN_KEYCHAIN="$alias"; rc=$?
  if [ $rc -eq 3 ] && ! grep -q '\[import\]' "$LOG"; then
    ok "A6-8 login keychain spelled as $(basename "$(dirname "$alias")")/$(basename "$alias") still needs --login-keychain"
  else bad "A6-8 alias $alias (rc=$rc): $(cat "$T/out.txt")"; fi
done

# A5: unknown flag
run; env PATH="$T/bin:$PATH" HOME="$T/home" "$HELPER/scripts/sign-dev.sh" --yes > "$T/out.txt" 2>&1; rc=$?
[ $rc -eq 2 ] && ok "A5 unknown flag → exit 2" || bad "A5 rc=$rc"

rm -rf "$T"

# ---------- B: a real throwaway keychain (opt-in) ----------
if [ "${1:-}" = "--real" ]; then
  K="$(mktemp -d "/tmp/lfcp sign real.XXXXXX")"
  KC="$K/Dev Keys.keychain-db"
  before="$(security list-keychains -d user)"
  security create-keychain -p test "$KC" && security unlock-keychain -p test "$KC" && security set-keychain-settings "$KC"
  [ -x "build/LFCP Reminders Helper.app/Contents/MacOS/lfcp-reminders-helper" ] || ARCHS="$(uname -m)" scripts/build-app.sh >/dev/null
  dr() { codesign -d -r- "build/LFCP Reminders Helper.app" 2>&1 | sed -n 's/^designated => //p'; }
  SIGN_KEYCHAIN="$KC" NO_BUILD=1 scripts/sign-dev.sh > "$K/1.txt" 2>&1; r1=$?; d1="$(dr)"
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k test "$KC" >/dev/null 2>&1
  SIGN_KEYCHAIN="$KC" NO_BUILD=1 scripts/sign-dev.sh > "$K/2.txt" 2>&1; r2=$?; d2="$(dr)"
  after="$(security list-keychains -d user)"
  [ $r1 -eq 0 ] && [ $r2 -eq 0 ] && ok "B1 real keychain with spaces: create and sign twice" || bad "B1 r1=$r1 r2=$r2: $(cat "$K/1.txt" "$K/2.txt")"
  [ -n "$d1" ] && [ "$d1" = "$d2" ] && [[ "$d1" == *"certificate root"* ]] && ok "B2 designated requirement stable: $d1" || bad "B2 '$d1' vs '$d2'"
  [ "$before" = "$after" ] && ok "B3 search list restored exactly" || bad "B3 before: $before after: $after"
  security delete-keychain "$KC"
  rm -f "$K/1.txt" "$K/2.txt"; rmdir "$K"
fi

echo
[ $fails -eq 0 ] && echo "sign-dev tests: all passed" || echo "sign-dev tests: $fails failed"
exit $fails
