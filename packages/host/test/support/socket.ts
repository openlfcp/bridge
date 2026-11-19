// Support commands as the bundle's lfcp-bridge runs them (A§7.3, E-006): `run --app` over a test
// runtime serves support.sock; every call goes through the thin client (src/app/client.ts), the
// host's queue and the run process's transport — the runtime's own openTransport is never used.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect } from "vitest";
import { supportClient } from "../../src/app/client.js";
import { SUPPORT_SOCKET } from "../../src/app/support.js";
import type { BootstrapTransport } from "../../src/bootstrap.js";
import { EXIT, main } from "../../src/index.js";
import type { RunningProcess, Runtime } from "../../src/runtime.js";

const UID = process.getuid?.() ?? 501;

export interface Answer {
  readonly code: number;
  /** stdout lines joined with "\n", as the 0.5 tests read them. */
  readonly out: string;
  readonly err: string;
}

export interface SupportHost {
  /** One `lfcp-bridge <argv>` through support.sock. */
  call(...argv: string[]): Promise<Answer>;
  /** How many times the runtime's own transport was asked for (always 0). */
  readonly transportsOpened: () => number;
  /** The shell goes away: the host ends, exit 0. */
  close(): Promise<void>;
}

/**
 * The host of `run --app` over `rt` (its data directory, database, config), with `transport` as
 * the run process's. `connected` is the run process's server connection (doctor's "server").
 * `process` starts a real run process instead (a BridgeProcess: its passes, gates and control
 * look), for scenarios whose completion is the work going on after the command.
 */
export async function supportHost(
  rt: Runtime,
  transport: BootstrapTransport,
  o: {
    readonly connected?: () => boolean | undefined;
    readonly process?: () => Promise<RunningProcess>;
  } = {},
): Promise<SupportHost> {
  let opened = 0;
  const runtime: Runtime = {
    ...rt,
    async openTransport() {
      opened++;
      throw new Error("a support command opened a second transport");
    },
    startProcess:
      o.process ??
      (async () => ({
        stop: async () => {},
        transport,
        exclusive: <T>(fn: () => Promise<T>) => fn(),
        connected: o.connected ?? (() => undefined),
      })),
    // The test owns the database.
    close: async () => {},
  };
  const input = new PassThrough();
  const log: string[] = [];
  const done = main(["run", "--app"], {
    out: (l) => log.push(l),
    err: (l) => log.push(l),
    runtime: async () => runtime,
    app: { input, write: () => {} },
    launchAgent05: {
      path: join(rt.paths.home, "no-agent.plist"),
      home: rt.paths.home,
      launchctl: () => {},
    },
    support: { uid: UID, peerUid: async () => UID },
  });
  const path = join(rt.paths.home, SUPPORT_SOCKET);
  for (let i = 0; i < 400 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 5));
  if (!existsSync(path)) throw new Error(`no ${SUPPORT_SOCKET}: ${log.join("; ")}`);
  return {
    async call(...argv) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await supportClient({
        path,
        argv,
        io: { out: (l) => out.push(l), err: (l) => err.push(l) },
        launch: async () => {
          throw new Error("the app runs: the client must not start it");
        },
      });
      return { code, out: out.join("\n"), err: err.join("\n") };
    },
    transportsOpened: () => opened,
    async close() {
      input.end();
      expect(await done).toBe(EXIT.OK);
    },
  };
}
