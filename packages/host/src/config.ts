// Paths and config.json of the bridge (D-010 r4 §2.2).
//
//   ~/Library/Application Support/org.openlfcp.bridge/   (LFCP_BRIDGE_HOME overrides)
//     config.json  bridge.sqlite  installations/<iid>/  run.lock  STOP  helper.pid
//   ~/Library/Logs/org.openlfcp.bridge/
//   ~/Library/LaunchAgents/org.openlfcp.bridge.plist
//   ~/Applications/LFCP Reminders Helper.app            (config.helperPath overrides)
//
// config.json holds the bridgeInstanceId (created once, never changed: it names this bridge's
// ownership markers, §6.5). Writes follow the manifests (A§9.1, src/artifact/write-gate.ts); a
// writesVerified left by 0.5 is ignored.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const LAUNCH_AGENT_LABEL = "org.openlfcp.bridge";

export interface BridgePaths {
  readonly home: string;
  readonly config: string;
  readonly database: string;
  readonly installations: string;
  readonly helperPid: string;
  readonly logs: string;
  readonly launchAgent: string;
  readonly helperApp: string;
}

export function bridgePaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): BridgePaths {
  const base =
    env.LFCP_BRIDGE_HOME ?? join(home, "Library", "Application Support", LAUNCH_AGENT_LABEL);
  return {
    home: base,
    config: join(base, "config.json"),
    database: join(base, "bridge.sqlite"),
    installations: join(base, "installations"),
    helperPid: join(base, "helper.pid"),
    logs: env.LFCP_BRIDGE_LOGS ?? join(home, "Library", "Logs", LAUNCH_AGENT_LABEL),
    launchAgent: join(home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`),
    helperApp: join(home, "Applications", "LFCP Reminders Helper.app"),
  };
}

export interface BridgeConfig {
  readonly bridgeInstanceId: string;
  readonly helperPath?: string;
}

/** Reads config.json, creating it (with a new bridgeInstanceId) when missing. */
export function loadConfig(path: string): BridgeConfig {
  try {
    const c = JSON.parse(readFileSync(path, "utf8")) as Partial<BridgeConfig>;
    if (typeof c.bridgeInstanceId !== "string" || c.bridgeInstanceId === "")
      throw new Error(`${path}: no bridgeInstanceId`);
    return c as BridgeConfig;
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") throw e;
    const c: BridgeConfig = { bridgeInstanceId: randomUUID() };
    saveConfig(path, c);
    return c;
  }
}

/** Writes config.json atomically (temp file + rename). */
export function saveConfig(path: string, config: BridgeConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
