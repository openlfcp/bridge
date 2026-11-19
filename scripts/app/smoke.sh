#!/bin/bash
# L5 smoke of LFCP Bridge.app (PLAN §E-004, T§2 L5) on a fresh macOS runner:
#   1. the app starts (open), its status item is on screen, one copy runs;
#   2. the host runs: node + bridge.mjs run --app from the bundle, child of the shell, said hello;
#   3. control: Pause syncing writes STOP, Resume removes it (so step 5's check can fail);
#   4. lfcp-bridge:// reaches the host, and the URL is in no log or data file;
#   5. shutdown{reason:update}: the host exits 0, the app exits, no STOP;
#   6. the same under launchd (kickstart of the SMAppService agent): not restarted for 45 s, longer
#      than its ThrottleInterval.
# Before step 1 the runner gets a bridge of 0.5 (PLAN §E-007): its data directory with config.json
# and the LaunchAgent org.openlfcp.bridge loaded in launchd, its process holding run.lock. Step 1
# checks that the first start booted it out, removed its plist and kept config.json as it was.
#
#   scripts/app/smoke.sh <LFCP Bridge.app built with TEST_HOOKS=1>   (copies it to /Applications)
#
# Every check is a hard failure (exit 1). The app's hooks: app/Sources/LFCPBridge/TestHooks.swift.
set -euo pipefail
SRC="${1:?usage: smoke.sh <app>}"
APP="/Applications/LFCP Bridge.app"
LOGS="$HOME/Library/Logs/org.openlfcp.bridge"
DATA="$HOME/Library/Application Support/org.openlfcp.bridge"
HOOKS="$LOGS/test-hooks"
R="$HOOKS/report.json"
SECRET="smoke-link-secret-$RANDOM$RANDOM$RANDOM"

fail() {
  echo "SMOKE FAIL: $*"
  [ -f "$R" ] && cat "$R"
  for f in shell.log host.log; do [ -f "$LOGS/$f" ] && { echo "--- $f"; tail -n 40 "$LOGS/$f"; }; done
  exit 1
}
ok() { echo "SMOKE ok: $*"; }
check() { # <description> <jq filter over report.json>
  jq -e "$2" "$R" >/dev/null || fail "$1 ($2)"
  ok "$1"
}
wait_until() { # <seconds> <description> <command…>
  local seconds="$1" what="$2"
  shift 2
  for _ in $(seq 1 $((seconds * 4))); do
    if "$@"; then return 0; fi
    sleep 0.25
  done
  fail "timed out after ${seconds}s: $what"
}
fresh_report() { # asks the app for a new report.json
  rm -f "$R"
  touch "$HOOKS/report"
  for _ in $(seq 1 40); do
    if [ -s "$R" ]; then return 0; fi
    sleep 0.25
  done
  fail "the app wrote no report.json"
}
report_has() { fresh_report && jq -e "$1" "$R" >/dev/null; }
app_count() { pgrep -x "LFCP Bridge" | wc -l | tr -d ' '; }

echo "== environment"
sw_vers
csrutil status || true
command -v jq >/dev/null || fail "jq is missing"
for d in "$APP" "$LOGS" "$DATA"; do
  if [ -e "$d" ]; then fail "$d exists: the smoke needs a fresh runner"; fi
done
[ "$(app_count)" = 0 ] || fail "LFCP Bridge is already running"
ditto "$SRC" "$APP"
codesign --verify --strict --deep "$APP" || fail "codesign --verify --strict --deep"
ok "installed in /Applications, signature valid"

echo "== 0. a bridge of 0.5: its data directory and its LaunchAgent, running"
AGENT05="$HOME/Library/LaunchAgents/org.openlfcp.bridge.plist"
SERVICE05="gui/$(id -u)/org.openlfcp.bridge"
[ -e "$AGENT05" ] && fail "$AGENT05 exists: the smoke needs a fresh runner"
mkdir -p -m 700 "$DATA"
printf '{\n  "bridgeInstanceId": "0f5e0b1d-5a3c-4c55-9d2e-0a5b05b05b05"\n}\n' >"$DATA/config.json"
CONFIG05="$(mktemp)"
cp "$DATA/config.json" "$CONFIG05"
mkdir -p "$(dirname "$AGENT05")"
# The 0.5 agent's shape (src/launchd.ts), with a stand-in for `lfcp-bridge run`: it holds run.lock.
cat >"$AGENT05" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>org.openlfcp.bridge</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/sh</string>
		<string>-c</string>
		<string>echo \$\$ &gt; "\$LFCP_BRIDGE_HOME/run.lock"; exec /bin/sleep 3600</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>30</integer>
	<key>EnvironmentVariables</key>
	<dict>
		<key>LFCP_BRIDGE_HOME</key>
		<string>$DATA</string>
	</dict>
</dict>
</plist>
PLIST
plutil -lint "$AGENT05" >/dev/null || fail "the 0.5 agent's plist is not valid"
launchctl bootstrap "gui/$(id -u)" "$AGENT05" || fail "launchctl bootstrap of the 0.5 agent"
wait_until 15 "the 0.5 agent holds run.lock" test -s "$DATA/run.lock"
PID05="$(tr -d ' \n' <"$DATA/run.lock")"
kill -0 "$PID05" 2>/dev/null || fail "the 0.5 agent's process ($PID05) is not running"
ok "0.5 agent loaded (pid $PID05 in run.lock)"

echo "== 1. start"
open "$APP"
wait_until 30 "the app's hooks directory" test -d "$HOOKS"
wait_until 60 "host hello and a settled status" report_has \
  '.host.hello != "" and (.host.state == "running" or .host.state == "unavailable")'
cat "$R"
[ -e "$AGENT05" ] && fail "the 0.5 agent's plist is still there"
launchctl print "$SERVICE05" >/dev/null 2>&1 && fail "the 0.5 agent is still loaded in launchd"
kill -0 "$PID05" 2>/dev/null && fail "the 0.5 agent's process ($PID05) still runs"
cmp -s "$CONFIG05" "$DATA/config.json" || fail "config.json (bridgeInstanceId) changed"
[ "$(sqlite3 "$DATA/bridge.sqlite" "SELECT count(*) FROM journal WHERE key = 'bridge.launch_agent_05_removed'")" = 1 ] ||
  fail "no journal entry for the removed 0.5 agent"
ok "0.5 agent booted out and removed; same data directory and bridgeInstanceId"
check "status item exists" '.statusItem.exists == true'
check "status item visible" '.statusItem.visible == true'
check "status item has its icon" '.statusItem.hasImage == true'
check "status item is on screen" '.statusItem.hasWindow == true and .statusItem.width > 0'
check "menu headline" '.menu[0] | startswith("LFCP Bridge · ")'
check "menu ends with Quit" '.menu[-1] == "Quit LFCP Bridge"'
check "login item registered (SMAppService.agent)" \
  '.loginItem == "enabled" or .loginItem == "requiresApproval"'
APP_PID="$(jq -r .pid "$R")"
# register() starts the agent at once (RunAtLoad): that second copy must see us and exit 0.
sleep 5
[ "$(app_count)" = 1 ] || fail "$(app_count) copies of LFCP Bridge run"
ok "one copy runs (pid $APP_PID)"
launchctl print "gui/$(id -u)/org.openlfcp.bridge.agent" >/dev/null 2>&1 &&
  echo "SMOKE info: launchd knows org.openlfcp.bridge.agent" ||
  echo "SMOKE info: launchd has no org.openlfcp.bridge.agent (login item state: $(jq -r .loginItem "$R"))"

echo "== 2. host"
fresh_report
check "host is running under the supervisor" '.host.phase == "running" and .host.pid > 0'
check "host was not restarted" '.host.launches == 1'
HOST_PID="$(jq -r .host.pid "$R")"
kill -0 "$HOST_PID" 2>/dev/null || fail "host pid $HOST_PID is not alive"
[ "$(ps -o ppid= -p "$HOST_PID" | tr -d ' ')" = "$APP_PID" ] || fail "host's parent is not the shell"
cmd="$(ps -o command= -p "$HOST_PID")"
want="$APP/Contents/Resources/node/bin/node $APP/Contents/Resources/host/bridge.mjs run --app"
[ "$cmd" = "$want" ] || fail "host command line: $cmd"
ok "host pid $HOST_PID: bundled node + bridge.mjs run --app, child of the shell"
echo "SMOKE info: host state $(jq -r .host.state "$R") $(jq -r .host.reason "$R")"
[ -f "$DATA/bridge.sqlite" ] || fail "the host opened no bridge.sqlite in $DATA"
ok "host opened its database"

echo "== 3. control: pause writes STOP, resume removes it"
[ ! -e "$DATA/STOP" ] || fail "STOP before pause"
touch "$HOOKS/pause"
wait_until 15 "STOP after pause" test -e "$DATA/STOP"
wait_until 15 "status paused" report_has '.host.state == "paused" and .icon == "stopped"'
ok "pause: STOP written, status paused"
touch "$HOOKS/resume"
wait_until 15 "STOP removed after resume" test ! -e "$DATA/STOP"
wait_until 15 "status after resume" report_has '.host.state != "paused"'
ok "resume: STOP removed"

echo "== 4. lfcp-bridge:// handoff"
open "lfcp-bridge://connect?c=smoke#k=$SECRET"
wait_until 20 "the URL reached the host" report_has '.urls.forwarded == 1 and .urls.waiting == 0'
wait_until 10 "the host's replies" report_has '.replies.ok == 3'
check "no command was refused" '.replies.failed == 0'
grep -qF "app: openURL received" "$LOGS/host.log" || fail "the host did not log the openURL"
grep -qF "url: handed to the host" "$LOGS/shell.log" || fail "the shell did not log the handoff"
if grep -rlaF "$SECRET" "$LOGS" "$DATA"; then fail "the URL's secret is in the files above"; fi
ok "URL handed over; its secret is in no log or data file"

echo "== 5. shutdown{reason:update}"
touch "$HOOKS/shutdown-update"
wait_until 90 "the app exited" bash -c "! kill -0 $APP_PID 2>/dev/null"
wait_until 10 "the host exited" bash -c "! kill -0 $HOST_PID 2>/dev/null"
[ -s "$R" ] || fail "no final report"
cat "$R"
check "shutdown reason update" '.shutdown.reason == "update"'
check "host exited 0" '.shutdown.hostExit == 0'
[ ! -e "$DATA/STOP" ] || fail "shutdown{update} wrote STOP"
ok "no STOP after shutdown{update}"
grep -qF "app: shutting down (update)" "$LOGS/host.log" || fail "host.log has no shutdown (update)"
grep -qF "host: exited after shutdown (0)" "$LOGS/shell.log" || fail "shell.log has no exit after shutdown"
[ ! -e "$DATA/run.lock" ] || fail "run.lock left behind"
sleep 5
[ "$(app_count)" = 0 ] || fail "LFCP Bridge runs again 5 s after a clean exit"
pgrep -f "$APP/Contents/Resources/node/bin/node" >/dev/null && fail "a host still runs"
ok "no copy runs 5 s after the clean exit of the copy started by open"

echo "== 6. under launchd: a clean exit is final (KeepAlive {SuccessfulExit:false}, ThrottleInterval 30)"
LABEL="gui/$(id -u)/org.openlfcp.bridge.agent"
launchctl kickstart "$LABEL" || fail "launchctl kickstart $LABEL"
wait_until 60 "the app under launchd: host hello and a settled status" report_has \
  '.host.hello != "" and (.host.state == "running" or .host.state == "unavailable")'
AGENT_PID="$(jq -r .pid "$R")"
launchctl print "$LABEL" | grep -Eq "^[[:space:]]*pid = $AGENT_PID\$" ||
  fail "pid $AGENT_PID is not the agent's process: $(launchctl print "$LABEL" | grep -E 'pid =|state =')"
ok "the agent's process is the app (pid $AGENT_PID)"
AGENT_HOST="$(jq -r .host.pid "$R")"
touch "$HOOKS/shutdown-update"
wait_until 90 "the agent's app exited" bash -c "! kill -0 $AGENT_PID 2>/dev/null"
check "host exited 0 under launchd" '.shutdown.reason == "update" and .shutdown.hostExit == 0'
wait_until 10 "its host exited" bash -c "! kill -0 $AGENT_HOST 2>/dev/null"
[ ! -e "$DATA/STOP" ] || fail "shutdown{update} wrote STOP"
# Longer than ThrottleInterval (30 s) with a margin: launchd would have started it again by now.
sleep 45
[ "$(app_count)" = 0 ] || fail "launchd started LFCP Bridge again after a clean exit"
if launchctl print "$LABEL" | grep -Eq "^[[:space:]]*pid = "; then
  fail "the agent runs again: $(launchctl print "$LABEL" | grep -E 'pid =|state =')"
fi
echo "SMOKE info: $(launchctl print "$LABEL" | grep -E 'last exit code' | head -1 | xargs)"
ok "45 s after the agent's clean exit, launchd has not started it again"

if grep -rlaF "$SECRET" "$LOGS" "$DATA"; then fail "the URL's secret is in the files above"; fi
echo "== SMOKE: all checks passed"
