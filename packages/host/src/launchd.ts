// The launchd user agent (D-010 r4 §2.2): `lfcp-bridge service install|uninstall`.
//
//   RunAtLoad true; KeepAlive {SuccessfulExit: false} — exit 0 (STOP, Safe Mode) is not restarted;
//   ThrottleInterval 30 (B-001: do not burn the 20/min WebSocket limit); LimitLoadToSessionType Aqua
//   (open and the TCC prompt need the GUI session); ProcessType Standard; LowPriorityIO.
//   The absolute path of node is recorded at install: launchd has no PATH of the person.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LAUNCH_AGENT_LABEL } from "./config.js";

export const THROTTLE_INTERVAL_S = 30;

export interface AgentSpec {
  readonly node: string;
  readonly cli: string;
  readonly home: string;
  readonly logs: string;
}

const esc = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function renderLaunchAgent(spec: AgentSpec): string {
  const str = (s: string) => `<string>${esc(s)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	${str(LAUNCH_AGENT_LABEL)}
	<key>ProgramArguments</key>
	<array>
		${str(spec.node)}
		${str(spec.cli)}
		${str("run")}
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>${THROTTLE_INTERVAL_S}</integer>
	<key>LimitLoadToSessionType</key>
	${str("Aqua")}
	<key>ProcessType</key>
	${str("Standard")}
	<key>LowPriorityIO</key>
	<true/>
	<key>EnvironmentVariables</key>
	<dict>
		<key>LFCP_BRIDGE_HOME</key>
		${str(spec.home)}
	</dict>
	<key>StandardOutPath</key>
	${str(join(spec.logs, "launchd.out"))}
	<key>StandardErrorPath</key>
	${str(join(spec.logs, "launchd.err"))}
</dict>
</plist>
`;
}

/** launchctl, replaceable in tests. */
export type Launchctl = (args: readonly string[]) => void;

export const launchctl: Launchctl = (args) => {
  execFileSync("launchctl", [...args], { stdio: "ignore" });
};

const domain = () => `gui/${process.getuid?.() ?? 501}`;

/** Writes the plist and loads it into the GUI session (unloading an older one first). */
export function installLaunchAgent(
  path: string,
  spec: AgentSpec,
  ctl: Launchctl = launchctl,
): void {
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(spec.logs, { recursive: true });
  if (existsSync(path)) {
    try {
      ctl(["bootout", domain(), path]);
    } catch {}
  }
  writeFileSync(path, renderLaunchAgent(spec));
  ctl(["bootstrap", domain(), path]);
}

/** Unloads and removes the plist; true when there was one. */
export function uninstallLaunchAgent(path: string, ctl: Launchctl = launchctl): boolean {
  if (!existsSync(path)) return false;
  try {
    ctl(["bootout", domain(), path]);
  } catch {}
  rmSync(path, { force: true });
  return true;
}
