#!/bin/bash
# T§2 L5: a release LFCP Bridge.app carries none of the L5 smoke's test hooks
# (app/Sources/LFCPBridge/TestHooks.swift, compiled only with -DLFCP_TEST_HOOKS).
#
#   scripts/app/check-no-test-hooks.sh <app>              exit 0: no hooks; 1: hooks found
#   scripts/app/check-no-test-hooks.sh --expect-hooks <app>   the control: exit 0 only when found
#
# Looks at every slice of the shell for the hooks' symbols (TestHooks), the type's name in Swift's
# metadata (kept by a strip) and the hooks' start-up log line, and at Info.plist for a development
# version. (Swift keeps strings of up to 15 bytes inside instructions, not as C strings: the
# searched ones are longer.) The control runs on the smoke's TEST_HOOKS=1 build, so a search that
# finds nothing cannot pass unnoticed.
set -euo pipefail
expect=0
if [ "${1:-}" = --expect-hooks ]; then
  expect=1
  shift
fi
APP="${1:?usage: check-no-test-hooks.sh [--expect-hooks] <app>}"
SHELL_EXE="$APP/Contents/MacOS/LFCP Bridge"
found=()

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for arch in $(xcrun lipo -archs "$SHELL_EXE"); do
  slice="$tmp/shell-$arch"
  xcrun lipo -thin "$arch" "$SHELL_EXE" -output "$slice" 2>/dev/null || cp "$SHELL_EXE" "$slice"
  # nm -a: the symbol table as linked (a stripped binary has none: the strings below remain).
  n="$(xcrun nm -a "$slice" 2>/dev/null | grep -c 'TestHooks' || true)"
  if [ "$n" -gt 0 ]; then found+=("$arch: $n TestHooks symbol(s)"); fi
  for s in "TestHooks" "test hooks: on (L5 smoke build)"; do
    if strings -a "$slice" | grep -qF -- "$s"; then found+=("$arch: string '$s'"); fi
  done
done
in_shell=${#found[@]}
version="$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist")"
case "$version" in
  *-dev*) found+=("Info.plist: development version $version") ;;
esac

if [ "${#found[@]}" -gt 0 ]; then
  printf 'test hooks: %s\n' "${found[@]}"
else
  echo "test hooks: none in $SHELL_EXE ($(xcrun lipo -archs "$SHELL_EXE")), version $version"
fi
if [ "$expect" = 1 ]; then
  # The shell itself, not just the version: otherwise a blind binary search would pass.
  [ "$in_shell" -gt 0 ] || { echo "control: the shell of a build with hooks shows none: the search is blind"; exit 1; }
  echo "control: the search finds the hooks of a TEST_HOOKS=1 build"
else
  [ "${#found[@]}" -eq 0 ] || { echo "FAIL: the release build has test hooks"; exit 1; }
fi
