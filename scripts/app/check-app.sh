#!/bin/bash
# T§2 L5 on a packaged LFCP Bridge.app (scripts/app/package-app.sh), run where it was copied to —
# a path with a space, a PATH without node, no node_modules of the repository:
#   Info.plist (bundle id, LSMinimumSystemVersion 15.0, Sparkle keys), every Mach-O universal and
#   loadable on 15.0, the signature (--strict --deep, hardened runtime, entitlements), the pinned
#   Node and its ABI, no test hooks, then `bridge.mjs --self-test` (runtime, sqlite, Automerge,
#   helper `ping`) on this machine's slice, and on Apple silicon the x86_64 slice under Rosetta.
#
#   scripts/app/check-app.sh <app>      exit 0 only when every check passes
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="${1:?usage: check-app.sh <app>}"
C="$APP/Contents"
NODE="$C/Resources/node/bin/node"
HOST="$C/Resources/host/bridge.mjs"
SQLITE_NODE="$C/Resources/host/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
NODE_VERSION="$(tr -d '[:space:]' < "$ROOT/.node-version")"
NODE_MODULE_VERSION="$(sed -n 's/^# NODE_MODULE_VERSION \([0-9]*\)$/\1/p' "$ROOT/scripts/app/node-darwin.sha256")"
MIN_MACOS=15.0
CLEAN_PATH=/usr/bin:/bin:/usr/sbin:/sbin
failed=0
ok() { echo "L5 ok    $*"; }
bad() { echo "L5 FAIL  $*"; failed=$((failed + 1)); }
info() { echo "L5 info  $*"; }
clean() { env -i HOME="$HOME" PATH="$CLEAN_PATH" TMPDIR="${TMPDIR:-/tmp}" "$@"; }
plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$C/Info.plist" 2>/dev/null; }
# A version a.b[.c] no later than MIN_MACOS.
not_after_min() {
  awk -v a="$1" -v b="$MIN_MACOS" 'BEGIN {
    split(a, x, "."); split(b, y, ".")
    for (i = 1; i <= 3; i++) if (x[i] + 0 != y[i] + 0) exit !(x[i] + 0 < y[i] + 0)
    exit 0
  }'
}

echo "== app: $APP"
echo "== macOS $(sw_vers -productVersion) ($(sw_vers -buildVersion)) $(uname -m)"
csrutil status 2>/dev/null | sed 's/^/L5 info  /' # S-2: SIP off on hosted runners
if [ -e "$ROOT/node_modules" ]; then
  bad "the repository has node_modules: the check must run without them"
else
  ok "no node_modules in the repository"
fi

echo "== Info.plist"
for kv in "CFBundleIdentifier=org.openlfcp.bridge" "CFBundleExecutable=LFCP Bridge" \
  "LSMinimumSystemVersion=$MIN_MACOS" "LSUIElement=true" "SUEnableAutomaticChecks=true" \
  "SUAutomaticallyUpdate=true" "SUScheduledCheckInterval=86400"; do
  k="${kv%%=*}" want="${kv#*=}" got="$(plist "${kv%%=*}")"
  if [ "$got" = "$want" ]; then ok "Info.plist $k = $got"; else bad "Info.plist $k = '$got' (want '$want')"; fi
done
info "version $(plist CFBundleShortVersionString) ($(plist CFBundleVersion))"

echo "== Mach-O: universal, loadable on macOS $MIN_MACOS"
machos=()
while IFS= read -r -d '' f; do
  if file -b "$f" | grep -q 'Mach-O'; then machos+=("$f"); fi
done < <(find "$APP" -type f -print0)
info "${#machos[@]} Mach-O file(s)"
for want in "MacOS/LFCP Bridge" "MacOS/lfcp-reminders-helper" "Resources/node/bin/node" \
  "Resources/host/node_modules/better-sqlite3/build/Release/better_sqlite3.node"; do
  [ -f "$C/$want" ] || bad "missing $want"
done
for f in "${machos[@]}"; do
  rel="${f#"$C/"}"
  archs="$(xcrun lipo -archs "$f" 2>&1)"
  if [ "$archs" = "arm64 x86_64" ] || [ "$archs" = "x86_64 arm64" ]; then
    ok "lipo -archs $rel: $archs"
  else
    bad "lipo -archs $rel: $archs (want arm64 x86_64)"
  fi
  for a in $archs; do
    # LC_BUILD_VERSION's minos, or LC_VERSION_MIN_MACOSX's version (older toolchains).
    minos="$(xcrun vtool -arch "$a" -show-build "$f" 2>/dev/null | awk '$1 == "minos" || $1 == "version" { print $2; exit }')"
    if [ -n "$minos" ] && not_after_min "$minos"; then
      ok "minos $rel ($a): $minos"
    else
      bad "minos $rel ($a): '${minos}' (want ≤ $MIN_MACOS)"
    fi
  done
done

echo "== signature"
if out="$(codesign --verify --strict --deep --verbose=2 "$APP" 2>&1)"; then
  ok "codesign --verify --strict --deep: $(echo "$out" | tr '\n' ' ')"
else
  bad "codesign --verify --strict --deep: $(echo "$out" | tr '\n' ' ')"
fi
for f in "$APP" "${machos[@]}"; do
  rel="${f#"$C/"}"
  flags="$(codesign -dv "$f" 2>&1 | sed -n 's/^CodeDirectory .*flags=\([^ ]*\).*/\1/p' | head -1)"
  case "$flags" in
    *runtime*) ok "hardened runtime $rel: $flags" ;;
    *) bad "hardened runtime $rel: '$flags'" ;;
  esac
  ents="$(codesign -d --entitlements - --xml "$f" 2>/dev/null | plutil -convert xml1 -o - - 2>/dev/null |
    sed -n 's/.*<key>\(.*\)<\/key>.*/\1/p' | sort | tr '\n' ' ')"
  case "$ents" in
    *get-task-allow* | *disable-library-validation* | *allow-dyld-environment-variables* | *disable-executable-page-protection*)
      bad "entitlements $rel: $ents" ;;
    *) ok "entitlements $rel: ${ents:-none}" ;;
  esac
done
want_node="com.apple.security.cs.allow-jit com.apple.security.cs.allow-unsigned-executable-memory "
got_node="$(codesign -d --entitlements - --xml "$NODE" 2>/dev/null | plutil -convert xml1 -o - - 2>/dev/null |
  sed -n 's/.*<key>\(.*\)<\/key>.*/\1/p' | sort | tr '\n' ' ')"
if [ "$got_node" = "$want_node" ]; then ok "node entitlements: exactly $want_node"; else bad "node entitlements: '$got_node' (want '$want_node')"; fi

echo "== Node and the native module"
if clean /bin/sh -c 'command -v node' >/dev/null; then bad "node on PATH ($CLEAN_PATH)"; else ok "no node on PATH ($CLEAN_PATH)"; fi
v="$(clean "$NODE" -p 'process.version + " " + process.versions.modules + " napi " + process.versions.napi' 2>&1)"
case "$v" in
  "v$NODE_VERSION $NODE_MODULE_VERSION napi "*) ok "node $v" ;;
  *) bad "node $v (want v$NODE_VERSION $NODE_MODULE_VERSION)" ;;
esac
for a in arm64 x86_64; do
  if xcrun nm -gU -arch "$a" "$SQLITE_NODE" 2>/dev/null | grep -q napi_register_module_v1; then
    ok "better_sqlite3.node ($a) is Node-API (napi_register_module_v1): no NODE_MODULE_VERSION tie"
  else
    bad "better_sqlite3.node ($a) exports no napi_register_module_v1"
  fi
done

echo "== test hooks"
if hooks="$("$ROOT/scripts/app/check-no-test-hooks.sh" "$APP" 2>&1)"; then ok "$hooks"; else bad "$hooks"; fi

echo "== self-test"
selftest() { # <label> <cmd...>
  local label=$1 out err rc
  shift
  err="$(mktemp)"
  out="$(cd / && clean "$@" "$HOST" --self-test 2>"$err")"
  rc=$?
  echo "$out" | sed "s/^/  [$label] /"
  sed "s/^/  [$label stderr] /" "$err"
  if [ "$rc" = 0 ]; then ok "self-test $label: exit 0"; else bad "self-test $label: exit $rc"; fi
  # PB-30: the bundle loads Automerge's /slim entry; fullfat_base64 printed initSync()'s warning.
  if grep -q 'initSync' "$err"; then bad "self-test $label: initSync() warning on stderr"; fi
  rm -f "$err"
}
selftest "$(uname -m)" "$NODE"
if [ "$(uname -m)" = arm64 ] && arch -x86_64 /usr/bin/true 2>/dev/null; then
  # The x86_64 slices on Apple silicon under Rosetta; macos-15-intel runs them natively.
  selftest "x86_64 under Rosetta" arch -x86_64 "$NODE"
fi

echo "== size"
du -sh "$APP" | sed 's/^/L5 size  /'
for p in Resources/node/bin/node Resources/host/bridge.mjs Resources/host/node_modules MacOS; do
  du -sh "$C/$p" | sed "s|$C/||; s/^/L5 size  /"
done

echo "== L5 check: $failed failure(s)"
[ "$failed" = 0 ]
