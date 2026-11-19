// The launchd user agent (D-010 r4 §2.2): `lfcp-bridge service install|uninstall`.
//
//   RunAtLoad true; KeepAlive {SuccessfulExit: false} — exit 0 (STOP, Safe Mode) is not restarted;
//   ThrottleInterval 30 (B-001: do not burn the 20/min WebSocket limit); LimitLoadToSessionType Aqua
//   (open and the TCC prompt need the GUI session); ProcessType Standard; LowPriorityIO.
//   The absolute path of node is recorded at install: launchd has no PATH of the person.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** What the first start of 0.6 found of 0.5's LaunchAgent. */
export type LaunchAgent05 =
  | { readonly removed: false }
  | {
      readonly removed: true;
      /** The data directory the agent ran with (its LFCP_BRIDGE_HOME), if it names one. */
      readonly home: string | undefined;
    };

const unesc = (s: string) =>
  s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/**
 * 0.6 over 0.5 (A§5.3 before the unbind, PLAN §E-007): LFCP Bridge.app runs the host itself, so
 * 0.5's agent (~/Library/LaunchAgents/org.openlfcp.bridge.plist, `lfcp-bridge service install`)
 * is booted out of the GUI session — launchd stops its `run`, which releases run.lock — and its
 * plist removed, so that it never comes back at the next login. By its label, not its file: the
 * job is stopped even when the plist no longer loads. Nothing else of 0.5 changes: the same data
 * directory, config.json (bridgeInstanceId) and bridge.sqlite. No plist: nothing to do, no
 * launchctl.
 */
export function retireLaunchAgent05(path: string, ctl: Launchctl = launchctl): LaunchAgent05 {
  if (!existsSync(path)) return { removed: false };
  let home: string | undefined;
  try {
    const m = /<key>LFCP_BRIDGE_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(
      readFileSync(path, "utf8"),
    );
    if (m?.[1] !== undefined) home = unesc(m[1]);
  } catch {}
  try {
    // Fails when the job is not loaded (already booted out, another session): nothing to stop.
    ctl(["bootout", `${domain()}/${LAUNCH_AGENT_LABEL}`]);
  } catch {}
  rmSync(path, { force: true });
  return { removed: true, home };
}
