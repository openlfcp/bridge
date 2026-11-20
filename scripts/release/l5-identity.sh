#!/bin/bash
# L5 "artifact identity" (T§3, A§9.1, PLAN §E-051) on the release chain's dry run: the write gate
# of a real, Dev-signed LFCP Bridge.app in /Applications decides by real manifests.
#
#   1. the job's own build: package-app.sh with the Dev certificate, its host trusting this run's
#      ephemeral manifest key (l5-identity.mjs trust-key — this build only, never a release);
#      artifact-manifest.json of it, a public certification manifest with a certified record for its
#      manifestSha256 on this macOS; both put into the gate's cache as a download would;
#   2. the clean artifact → cert.state certified;
#   3. (c) the helper replaced by another valid signature with the same DR → nested-cdhash, before
#      the helper's restart (the app keeps running) and after an "update" (the app started again
#      with the replaced bundle);
#   4. (a) one byte of bridge.mjs changed, no new signature → code-invalid;
#   5. (b) bridge.mjs changed and the bundle signed again → another artifactSliceId → shell-cdhash;
#   6. the clean artifact again → certified (the steps above leave nothing behind).
#
#   SIGN_IDENTITY=<sha1> SIGN_KEYCHAIN=<keychain> scripts/release/l5-identity.sh <work-dir>
#
# CI only (a fresh macOS runner, after `pnpm build`): it edits keys.ts in the checkout and installs
# into /Applications. Every check is a hard failure (exit 1).
set -euo pipefail
[ "${GITHUB_ACTIONS:-}" = true ] || { echo "l5-identity: CI only (edits keys.ts, installs into /Applications)" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mkdir -p "${1:?usage: l5-identity.sh <work-dir>}" && cd "$1" && pwd)"
: "${SIGN_IDENTITY:?}" "${SIGN_KEYCHAIN:?}"
APP="/Applications/LFCP Bridge.app"
DATA="$HOME/Library/Application Support/org.openlfcp.bridge"
LOGS="$HOME/Library/Logs/org.openlfcp.bridge"
DB="$DATA/bridge.sqlite"
HELPER=Contents/MacOS/lfcp-reminders-helper
JS=Contents/Resources/host/bridge.mjs
AM="$ROOT/scripts/release/artifact-manifest.mjs"
L5="$ROOT/scripts/release/l5-identity.mjs"
KEYS="$ROOT/packages/host/src/artifact/keys.ts"
ARCH="$(uname -m)"
[ "$ARCH" = arm64 ] || ARCH=x86_64

gate() { sqlite3 "$DB" "SELECT value FROM meta WHERE key = 'cert_gate'" 2>/dev/null || true; }
last_when() {
  sqlite3 "$DB" "SELECT json_extract(params_json, '$.when') FROM journal WHERE key = 'cert.state' ORDER BY rowid DESC LIMIT 1"
}
fail() {
  echo "L5 FAIL: $*"
  echo "cert_gate: $(gate)"
  [ -f "$DB" ] && sqlite3 "$DB" "SELECT ts, params_json FROM journal WHERE key = 'cert.state'" || true
  for f in shell.log host.log; do [ -f "$LOGS/$f" ] && { echo "--- $f"; tail -n 40 "$LOGS/$f"; }; done
  exit 1
}
ok() { echo "L5 ok: $*"; }
wait_until() { # <seconds> <description> <command…>
  local seconds="$1" what="$2"
  shift 2
  for _ in $(seq 1 $((seconds * 2))); do
    if "$@"; then return 0; fi
    sleep 0.5
  done
  fail "timed out after ${seconds}s: $what"
}
cdhash() { codesign -d -vvv -a "$ARCH" "$1" 2>&1 | sed -n 's/^CDHash=//p'; }
install_app() { rm -rf "$APP" && ditto "$1" "$APP"; }
running() { pgrep -x "LFCP Bridge" >/dev/null || pgrep -f "$APP/Contents/" >/dev/null; }
gone() { ! running; }
reason_is() { [ "$(gate | jq -r .reason)" = "$1" ]; }
decided_since() { local at; at="$(gate | jq -r '.at // ""')"; [ -n "$at" ] && [ "$at" != "$1" ]; }
start_app() { # waits for the decision of this start
  local before
  before="$(gate | jq -r '.at // ""')"
  running && fail "LFCP Bridge already runs"
  open "$APP"
  wait_until 120 "the write gate's decision at the start" decided_since "$before"
}
quit_app() { # SIGTERM to the shell: its host sees stdin close and shuts down (never STOP)
  pkill -TERM -x "LFCP Bridge" || true
  wait_until 90 "the app, its host and its helper exited" gone
}
expect() { # <what> <state> <reason> [artifactSliceId]
  local g
  g="$(gate)"
  echo "L5 info: cert_gate $g"
  [ "$(echo "$g" | jq -r .state)" = "$2" ] && [ "$(echo "$g" | jq -r .reason)" = "$3" ] ||
    fail "$1: want $2 ($3)"
  if [ -n "${4:-}" ]; then
    [ "$(echo "$g" | jq -r .artifactSliceId)" = "$4" ] || fail "$1: artifactSliceId, want $4"
  fi
  ok "$1: cert.state $2 ($3)"
}

echo "== environment"
sw_vers
for d in "$APP" "$DATA" "$LOGS"; do [ -e "$d" ] && fail "$d exists: a fresh runner is needed"; done
running && fail "LFCP Bridge already runs"

echo "== 1. the job's build: the Dev certificate, this run's manifest key trusted"
KEY="$WORK/manifest-key.pem"
PUB="$("$AM" keygen "$KEY")"
cp "$KEYS" "$WORK/keys.ts"
trap 'cp "$WORK/keys.ts" "$KEYS"' EXIT
node "$L5" trust-key "$PUB"
PACKAGE_DMG=0 SIGN_TIMESTAMP='' "$ROOT/scripts/app/package-app.sh" "$WORK/out" >"$WORK/package.log" 2>&1 ||
  { tail -n 60 "$WORK/package.log"; fail "package-app.sh"; }
CLEAN="$WORK/out/LFCP Bridge.app"
grep -qF "$PUB" "$CLEAN/$JS" || fail "the build's bridge.mjs does not trust this run's key"
codesign -d -r- "$CLEAN" 2>&1 | sed -n 's/^designated => /designated: /p'
SHA="$("$AM" build "$CLEAN" --key "$KEY" --out "$WORK/artifact-manifest.json")"
"$AM" check "$CLEAN" --manifest "$WORK/artifact-manifest.json" --public-key "$PUB"
SLICE="$(jq -er ".manifest.slices.$ARCH.shell" "$WORK/artifact-manifest.json")"
MACOS="$(sw_vers -productVersion | cut -d. -f1-2)"
node "$L5" certify "$WORK/artifact-manifest.json" --key "$KEY" --macos "$MACOS" \
  --os-build "$(sw_vers -buildVersion)" --out "$WORK/certification-manifest.json"
ok "manifestSha256 $SHA, $ARCH artifactSliceId $SLICE, certified on macOS $MACOS"

# (c)'s helper: the same program signed again by the same certificate with the same identifier
# and entitlements (the same designated requirement), another code directory (page size).
OTHER="$WORK/helper-other"
cp "$CLEAN/$HELPER" "$OTHER"
codesign --force --sign "$SIGN_IDENTITY" --keychain "$SIGN_KEYCHAIN" --options runtime \
  --timestamp=none --identifier org.openlfcp.bridge.reminders-helper \
  --entitlements "$ROOT/helper/Support/release.entitlements" --pagesize 16384 "$OTHER"
codesign --verify --strict "$OTHER" || fail "the other helper's signature"
[ "$(codesign -d -r- "$OTHER" 2>&1 | grep '^designated')" = "$(codesign -d -r- "$CLEAN/$HELPER" 2>&1 | grep '^designated')" ] ||
  fail "the other helper's designated requirement differs"
[ "$(cdhash "$OTHER")" != "$(cdhash "$CLEAN/$HELPER")" ] || fail "the other helper has the same cdhash"
ok "another helper: the same DR, cdhash $(cdhash "$OTHER") (manifest $(cdhash "$CLEAN/$HELPER"))"

echo "== the first start creates bridge.sqlite (nothing kept yet: preview)"
install_app "$CLEAN"
start_app
expect "nothing kept" unavailable no-artifact-manifest
quit_app
node "$L5" seed "$DB" --artifact "$WORK/artifact-manifest.json" \
  --certification "$WORK/certification-manifest.json" --public-key "$PUB" >/dev/null
ok "both manifests are in the write gate's cache"

echo "== 2. the clean artifact"
start_app
expect "clean artifact" certified certified "$SLICE"
[ "$(gate | jq -r .manifestSha256)" = "$SHA" ] || fail "manifestSha256 in cert_gate"
wait_until 30 "support.sock" test -S "$DATA/support.sock"
STATUS="$("$APP/Contents/Resources/bin/lfcp-bridge" status 2>&1)" || fail "lfcp-bridge status: $STATUS"
echo "$STATUS" | grep -E 'cert\.state: certified' || fail "status has no cert.state certified"
ok "status: cert.state certified"

echo "== 3. (c) the helper replaced by another valid build with the same DR"
before="$(gate | jq -r .at)"
cp "$OTHER" "$APP/$HELPER.l5" && mv -f "$APP/$HELPER.l5" "$APP/$HELPER"
codesign --verify --strict --deep --verbose=2 "$APP" 2>&1 ||
  echo "L5 info: codesign --verify --strict --deep fails on the bundle with the other helper"
pkill -TERM -f "$APP/$HELPER" || fail "no helper ran"
wait_until 60 "the decision before the helper's restart" decided_since "$before"
wait_until 30 "nested-cdhash after the helper's restart" reason_is nested-cdhash
expect "(c) before the helper's restart" mismatch nested-cdhash "$SLICE"
[ "$(last_when)" = helper ] || fail "cert.state was journaled at '$(last_when)', not before a helper start"
quit_app
start_app
expect "(c) after an update (the app started with the replaced bundle)" mismatch nested-cdhash "$SLICE"
quit_app

echo "== 4. (a) a byte of bridge.mjs changed, no new signature"
install_app "$CLEAN"
printf '\n// L5: changed after the signature\n' >>"$APP/$JS"
codesign --verify --strict --deep "$APP" 2>/dev/null && fail "codesign accepts the changed bundle"
start_app
expect "(a) a changed byte, no new signature" mismatch code-invalid
quit_app

echo "== 5. (b) bridge.mjs changed and the bundle signed again"
install_app "$CLEAN"
printf '\n// L5: another build of the host\n' >>"$APP/$JS"
codesign --force --sign "$SIGN_IDENTITY" --keychain "$SIGN_KEYCHAIN" --options runtime \
  --timestamp=none --entitlements "$ROOT/app/Support/shell.entitlements" "$APP"
codesign --verify --strict --deep "$APP" || fail "the re-signed bundle's signature"
RESIGNED="$(cdhash "$APP")"
[ -n "$RESIGNED" ] && [ "$RESIGNED" != "$SLICE" ] || fail "the re-signed shell's cdhash is $RESIGNED"
start_app
expect "(b) re-signed: another artifactSliceId" mismatch shell-cdhash "$RESIGNED"
quit_app

echo "== 6. the clean artifact again"
install_app "$CLEAN"
start_app
expect "clean artifact again" certified certified "$SLICE"
quit_app
echo "== L5 artifact identity: all checks passed"
