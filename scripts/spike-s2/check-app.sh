#!/bin/bash
# Spike S-2 acceptance (T§3 S-2) on a signed "LFCP Bridge.app", run where it was copied to:
# architectures, versions, signature, then `bridge.mjs --self-test` with PATH free of node.
#   scripts/spike-s2/check-app.sh <app>     exit 0 only when every check passes
# Expects NODE_VERSION and NODE_MODULE_VERSION (the pins) in the environment.
set -uo pipefail
APP="${1:?usage: check-app.sh <app>}"
C="$APP/Contents"
NODE="$C/Resources/node/bin/node"
HOST="$C/Resources/host/bridge.mjs"
SQLITE_NODE="$C/Resources/host/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
CLEAN_PATH=/usr/bin:/bin:/usr/sbin:/sbin
failed=0
ok() { echo "S2 ok    $*"; }
bad() { echo "S2 FAIL  $*"; failed=$((failed + 1)); }
clean() { env -i HOME="$HOME" PATH="$CLEAN_PATH" TMPDIR="${TMPDIR:-/tmp}" "$@"; }

echo "== app: $APP"
echo "== macOS $(sw_vers -productVersion) $(uname -m)"

for f in "$NODE" "$SQLITE_NODE" "$C/MacOS/lfcp-reminders-helper" "$C/MacOS/LFCP Bridge"; do
  archs="$(xcrun lipo -archs "$f" 2>&1)"
  line="lipo -archs ${f#"$C/"}: $archs"
  if [ "$archs" = "arm64 x86_64" ] || [ "$archs" = "x86_64 arm64" ]; then ok "$line"; else bad "$line"; fi
done

if out="$(codesign --verify --strict --deep --verbose=2 "$APP" 2>&1)"; then
  ok "codesign --verify --strict --deep: $(echo "$out" | tr '\n' ' ')"
else
  bad "codesign --verify --strict --deep: $(echo "$out" | tr '\n' ' ')"
fi
for f in "$APP" "$NODE" "$SQLITE_NODE" "$C/MacOS/lfcp-reminders-helper"; do
  flags="$(codesign -dv "$f" 2>&1 | sed -n 's/^CodeDirectory .*flags=\([^ ]*\).*/\1/p' | head -1)"
  case "$flags" in
    *runtime*) ok "hardened runtime ${f#"$C/"}: $flags" ;;
    *) bad "hardened runtime ${f#"$C/"}: $flags" ;;
  esac
done
echo "== node entitlements"
codesign -d --entitlements - --xml "$NODE" 2>/dev/null | plutil -convert xml1 -o - - 2>/dev/null |
  sed -n 's/.*<key>\(.*\)<\/key>.*/  \1/p'
if codesign -d --entitlements - --xml "$NODE" 2>/dev/null | grep -q get-task-allow; then
  bad "node has get-task-allow"
else
  ok "node has no get-task-allow"
fi

if clean /bin/sh -c 'command -v node' >/dev/null; then bad "node on PATH ($CLEAN_PATH)"; else ok "no node on PATH ($CLEAN_PATH)"; fi
v="$(clean "$NODE" -p 'process.version + " " + process.versions.modules + " napi " + process.versions.napi' 2>&1)"
case "$v" in
  "v$NODE_VERSION $NODE_MODULE_VERSION napi "*) ok "node $v" ;;
  *) bad "node $v (want v$NODE_VERSION $NODE_MODULE_VERSION)" ;;
esac
if nm -gU -arch arm64 "$SQLITE_NODE" 2>/dev/null | grep -q napi_register_module_v1; then
  ok "better_sqlite3.node is Node-API (napi_register_module_v1): no NODE_MODULE_VERSION tie"
else
  echo "S2 info  better_sqlite3.node exports no napi_register_module_v1"
fi

selftest() { # <label> <cmd...>
  local label=$1 out rc
  shift
  out="$(cd "$(dirname "$APP")" && clean "$@" --self-test 2>&1)"
  rc=$?
  echo "$out" | sed "s/^/  [$label] /"
  if [ "$rc" = 0 ]; then ok "self-test $label: exit 0"; else bad "self-test $label: exit $rc"; fi
}
selftest "node bridge.mjs" "$NODE" "$HOST"
selftest "LFCP Bridge (launcher)" "$C/MacOS/LFCP Bridge"
if [ "$(uname -m)" = arm64 ] && arch -x86_64 /usr/bin/true 2>/dev/null; then
  # The x86_64 slices on Apple silicon under Rosetta: informational, never fails the check.
  out="$(cd "$(dirname "$APP")" && clean arch -x86_64 "$NODE" "$HOST" --self-test 2>&1)"
  echo "S2 info  self-test x86_64 under Rosetta: exit $? $(echo "$out" | tail -1)"
fi

echo "== size"
du -sh "$APP" | sed 's/^/S2 size  /'
for p in Resources/node/bin/node Resources/host/bridge.mjs Resources/host/node_modules MacOS; do
  du -sh "$C/$p" | sed "s|$C/||; s/^/S2 size  /"
done

echo "== S2 check: $failed failure(s)"
[ "$failed" = 0 ]
