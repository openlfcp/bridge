#!/bin/bash
# Reminders access for L3 apps on a hosted macOS runner (spike S-3, research/s-3-tcc-ci-result.md):
# a kTCCServiceReminders row for each app's bundle id, with its code requirement, in the USER
# TCC.db (the system one does not help; SIP is off on the runners). It holds without restarting
# tccd for an app launched through `open` — its own responsible process. Then each app's
# `status` (through open) must say fullAccess, or the script fails with what it saw (the rows,
# tccd's log) in $L3_OUT. One app per argument; E-053 adds apps (the bridge's shell) the same way.
#   scripts/l3/tcc-grant.sh <app>...
set -uo pipefail
OUT="${L3_OUT:-build/l3/out}"
mkdir -p "$OUT"
UDB="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
since=$(date '+%Y-%m-%d %H:%M:%S')

# Run with a hard deadline (no GNU timeout on macOS images).
deadline() { local s=$1; shift; perl -e 'alarm shift @ARGV; exec @ARGV or die "exec: $!"' "$s" "$@"; }

# grant <bundle id> <csreq hex>: INSERT OR REPLACE, its columns from PRAGMA table_info (they differ by macOS).
grant() {
  local bid=$1 hex=$2 info name type notnull dflt v cols=() vals=()
  info=$(sqlite3 "$UDB" 'PRAGMA table_info(access)') || return 10
  [ -n "$info" ] || return 11
  while IFS='|' read -r _ name type notnull dflt _; do
    case "$name" in
      service) v="'kTCCServiceReminders'" ;;
      client) v="'$bid'" ;;
      client_type) v=0 ;;
      auth_value) v=2 ;;
      auth_reason) v=4 ;;
      auth_version) v=1 ;;
      csreq) v="X'$hex'" ;;
      policy_id | indirect_object_code_identity) v=NULL ;;
      indirect_object_identifier_type) v=0 ;;
      indirect_object_identifier) v="'UNUSED'" ;;
      flags) v=0 ;;
      last_modified) v="CAST(strftime('%s','now') AS INTEGER)" ;;
      *)
        [ "$notnull" = 1 ] && [ -z "$dflt" ] || continue
        case "$type" in INT*) v=0 ;; *) v="''" ;; esac ;;
    esac
    cols+=("$name"); vals+=("$v")
  done <<<"$info"
  sqlite3 "$UDB" "INSERT OR REPLACE INTO access ($(IFS=,; echo "${cols[*]}")) VALUES ($(IFS=,; echo "${vals[*]}"));"
}

# The app's code requirement as a hex blob: its designated requirement, or its cdhash (an ad-hoc
# signature has no explicit one).
csreq_hex() {
  local app=$1 dr tmp
  dr=$(codesign -d -r- "$app" 2>&1 | sed -n 's/^#* *designated => //p')
  [ -n "$dr" ] || dr="cdhash H\"$(codesign -dvvv "$app" 2>&1 | sed -n 's/^CDHash=//p')\""
  tmp=$(mktemp)
  echo "$dr" | csreq -r- -b "$tmp" || return 1
  xxd -p "$tmp" | tr -d '\n'
  rm -f "$tmp"
}

# The authorization an app reports for itself, launched through LaunchServices (`status`).
status_of() {
  local app=$1 out
  out="$OUT/status-$(basename "$app" .app | tr ' ' '-').json"
  : >"$out"
  deadline 60 open -n -W -g -a "$app" --stdout "$out" --stderr "$out.err" --args status
  node -e 'try{const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").pop();console.log(JSON.parse(l).authorization??"none")}catch{console.log("none")}' "$out"
}

failed=0
for app in "$@"; do
  bid=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist") || exit 2
  hex=$(csreq_hex "$app") || { echo "no code requirement for $app" >&2; exit 2; }
  grant "$bid" "$hex" || { echo "grant $bid failed ($?)" >&2; exit 2; }
  a=$(status_of "$app")
  echo "$bid: $a"
  [ "$a" = fullAccess ] || failed=1
done

sqlite3 -header "$UDB" "SELECT service,client,client_type,auth_value,auth_reason,length(csreq) AS csreq_len FROM access WHERE service='kTCCServiceReminders'" >"$OUT/tcc-rows.txt" 2>&1
if [ $failed = 1 ]; then
  echo "Reminders access not granted: see $OUT" >&2
  cat "$OUT/tcc-rows.txt" >&2
  log show --style compact --start "$since" --predicate 'subsystem == "com.apple.TCC"' >"$OUT/tccd.log" 2>&1
  grep -m 20 -i 'reminders' "$OUT/tccd.log" >&2
  exit 1
fi
