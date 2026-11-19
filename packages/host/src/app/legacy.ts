// The first start of 0.6 over a bridge of 0.5 (A§5.3 before the unbind, PLAN §E-007), done by
// `run --app` before it opens bridge.sqlite: 0.5's LaunchAgent is booted out and removed
// (src/launchd.ts), then the host waits for 0.5's `run` to let go of run.lock. `run --app` takes
// run.lock before the runtime opens and migrates bridge.sqlite and holds it until the database is
// closed, so the migrations never run under another run process. The data stay where they are: the
// same directory, config.json with its bridgeInstanceId, bridge.sqlite, installations/.
// The unbind of 0.5's bindings and what the person is told about them are E-036.

import { type LaunchAgent05, type Launchctl, launchctl, retireLaunchAgent05 } from "../launchd.js";
import { runLockHolder } from "../run/lock.js";

/** How long 0.5's `run` may take to stop after its bootout (its own stop, then launchd's kill). */
export const RETIRE_WAIT_MS = 30_000;

export interface Retire05Options {
  /** ~/Library/LaunchAgents/org.openlfcp.bridge.plist */
  readonly launchAgent: string;
  /** The data directory (its run.lock). */
  readonly home: string;
  readonly launchctl?: Launchctl;
  readonly waitMs?: number;
  readonly pollMs?: number;
}

/**
 * Retires 0.5's LaunchAgent if there is one. Past the wait a run.lock still held is left to
 * `run --app` itself: it takes run.lock before it opens bridge.sqlite, so it refuses to start
 * without touching the database, and the shell starts it again with its back-off.
 */
export async function retire05(o: Retire05Options): Promise<LaunchAgent05> {
  const r = retireLaunchAgent05(o.launchAgent, o.launchctl ?? launchctl);
  if (r.state !== "removed") return r;
  const until = Date.now() + (o.waitMs ?? RETIRE_WAIT_MS);
  while (runLockHolder(o.home) !== undefined && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, o.pollMs ?? 200));
  return r;
}
