#!/bin/bash
# Build and test HelperCore with swiftc only (no SwiftPM: it is broken with some Command Line
# Tools installs). Builds every architecture in ARCHS, joins them with lipo, runs the native slice.
#   scripts/build.sh                 # arm64 + x86_64, run tests
#   ARCHS=x86_64 scripts/build.sh    # one architecture
#   NO_TEST=1 scripts/build.sh       # build only
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${OUT:-build}"
ARCHS="${ARCHS:-arm64 x86_64}"
MIN_MACOS="${MIN_MACOS:-12.0}"
mkdir -p "$OUT"

echo "== swiftc $(xcrun swiftc --version 2>&1 | head -1)"
echo "== SDK $(xcrun --show-sdk-version)"
slices=()
for arch in $ARCHS; do
  echo "== helper-core-tests ($arch)"
  xcrun swiftc -O -swift-version 5 -target "$arch-apple-macos$MIN_MACOS" \
    -module-name HelperCoreTests \
    Sources/HelperCore/*.swift Tests/HelperCoreTests/*.swift \
    -o "$OUT/helper-core-tests-$arch"
  slices+=("$OUT/helper-core-tests-$arch")
done
xcrun lipo -create "${slices[@]}" -output "$OUT/helper-core-tests"
xcrun lipo -info "$OUT/helper-core-tests"

if [ "${NO_TEST:-0}" != "1" ]; then
  echo "== run ($(uname -m))"
  "$OUT/helper-core-tests"
fi
