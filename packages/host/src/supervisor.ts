// Supervision of the helper process by the host (D-010 r4 §8.2; moved here from PR 6):
// - on start, an orphan from helper.pid (a previous run that died) is stopped, if that pid still
//   runs our helper executable;
// - helper.pid is written once the helper is ready, removed on stop;
// - a ping every 30 s; no answer (the ping's own timeout, 10 s) or an unexpected exit → restart;
// - more than 3 restarts within 5 min → unavailable: no more restarts, the host sets the hold
//   helper_unavailable on the bindings of this transport (§7.5) until a person resumes.

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

export interface SupervisedHelper {
  readonly pid: number | undefined;
  /** Resolves when the helper answered; rejects on no answer. */
  ping(): Promise<void>;
  close(): Promise<void>;
  onExit(cb: (code: number | null) => void): () => void;
}

export type SupervisorState = "stopped" | "running" | "restarting" | "unavailable";

export interface SupervisorOptions {
  readonly start: () => Promise<SupervisedHelper>;
  readonly pidFile: string;
  readonly pingEveryMs?: number;
  readonly maxRestarts?: number;
  readonly restartWindowMs?: number;
  /** The pid runs our helper executable (default: `ps` comm is lfcp-reminders-helper). */
  readonly isOurs?: (pid: number) => boolean;
  readonly onUnavailable?: (reason: string) => void;
  readonly onRestart?: (reason: string, helper: SupervisedHelper) => void;
  readonly now?: () => number;
  readonly setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
  readonly clearInterval?: (h: unknown) => void;
}

export const HELPER_EXECUTABLE = "lfcp-reminders-helper";

export function isHelperProcess(pid: number, name = HELPER_EXECUTABLE): boolean {
  try {
    return (
      basename(
        execFileSync("ps", ["-o", "comm=", "-p", String(pid)])
          .toString()
          .trim(),
      ) === name
    );
  } catch {
    return false;
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export class HelperSupervisor {
  readonly #o: SupervisorOptions;
  #helper: SupervisedHelper | undefined;
  #state: SupervisorState = "stopped";
  #restarts: number[] = [];
  #timer: unknown;
  #offExit: (() => void) | undefined;
  #busy: Promise<void> = Promise.resolve();

  constructor(options: SupervisorOptions) {
    this.#o = options;
  }

  get state(): SupervisorState {
    return this.#state;
  }

  get helper(): SupervisedHelper | undefined {
    return this.#helper;
  }

  /** Stops an orphan from helper.pid (if ours), starts the helper, starts pinging. */
  async start(): Promise<void> {
    this.#killOrphan();
    await this.#launch();
    const every = this.#o.pingEveryMs ?? 30_000;
    const h = (this.#o.setInterval ?? setInterval)(() => {
      void this.pingNow();
    }, every);
    h.unref?.();
    this.#timer = h;
  }

  /** One supervision round (the timer calls it; tests too). */
  pingNow(): Promise<void> {
    this.#busy = this.#busy.then(async () => {
      if (this.#state !== "running" || this.#helper === undefined) return;
      try {
        await this.#helper.ping();
      } catch {
        await this.#restart("no answer to ping");
      }
    });
    return this.#busy;
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined)
      (this.#o.clearInterval ?? clearInterval)(this.#timer as NodeJS.Timeout);
    this.#timer = undefined;
    this.#state = "stopped";
    this.#offExit?.();
    await this.#helper?.close();
    this.#helper = undefined;
    rmSync(this.#o.pidFile, { force: true });
  }

  /** A person resumed after helper_unavailable: try again with a fresh budget. */
  async resume(): Promise<void> {
    this.#restarts = [];
    if (this.#state === "unavailable") await this.#launch();
  }

  #killOrphan(): void {
    let pid: number;
    try {
      pid = Number(readFileSync(this.#o.pidFile, "utf8").trim());
    } catch {
      return;
    }
    const ours = this.#o.isOurs ?? ((p: number) => isHelperProcess(p));
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid) && ours(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
    rmSync(this.#o.pidFile, { force: true });
  }

  async #launch(): Promise<void> {
    const helper = await this.#o.start();
    this.#helper = helper;
    this.#state = "running";
    if (helper.pid !== undefined) writeFileSync(this.#o.pidFile, `${helper.pid}\n`);
    this.#offExit = helper.onExit(() => {
      if (this.#helper === helper && this.#state === "running") {
        this.#busy = this.#busy.then(() => this.#restart("the helper exited"));
      }
    });
  }

  async #restart(reason: string): Promise<void> {
    const now = (this.#o.now ?? Date.now)();
    const window = this.#o.restartWindowMs ?? 5 * 60_000;
    this.#restarts = [...this.#restarts.filter((t) => now - t < window), now];
    this.#offExit?.();
    const old = this.#helper;
    this.#helper = undefined;
    await old?.close().catch(() => {});
    rmSync(this.#o.pidFile, { force: true });
    if (this.#restarts.length > (this.#o.maxRestarts ?? 3)) {
      this.#state = "unavailable";
      this.#o.onUnavailable?.(
        `${reason}; more than ${this.#o.maxRestarts ?? 3} restarts within ${window / 60_000} min`,
      );
      return;
    }
    this.#state = "restarting";
    try {
      await this.#launch();
      if (this.#helper) this.#o.onRestart?.(reason, this.#helper);
    } catch (e) {
      // A failed start counts as a restart too; the next ping round tries again.
      this.#state = "running";
      this.#helper = undefined;
      await this.#restart(`start failed: ${(e as Error).message}`);
    }
  }
}
