// Supervision of the helper process by the host (D-010 r4 §8.2; moved here from PR 6):
// - on start, an orphan from helper.pid (a previous run that died) is stopped, if that pid still
//   runs our helper executable: SIGTERM, a grace period, then SIGKILL; the replacement starts only
//   once the orphan is gone (review PR 9 P2-4);
// - helper.pid is written once the helper is ready, removed on stop;
// - a ping every 30 s; no answer (the ping's own timeout, 10 s) or an unexpected exit → restart;
// - more than 3 restarts within 5 min → unavailable: no more restarts, the host sets the hold
//   helper_unavailable on the bindings of this transport (§7.5) until a person resumes;
// - stop() wins over a ping or restart in flight: each stop starts a new generation, work of an
//   older one never launches a helper, and a helper whose start was in flight is closed before
//   stop() resolves (review PR 9 P2-3).

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { executableName } from "@openlfcp/bridge-transport-eventkit";

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
  /** How long an orphan has after SIGTERM before SIGKILL (default 5 s). */
  readonly orphanGraceMs?: number;
  readonly onUnavailable?: (reason: string) => void;
  readonly onRestart?: (reason: string, helper: SupervisedHelper) => void;
  readonly now?: () => number;
  readonly setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
  readonly clearInterval?: (h: unknown) => void;
}

export const HELPER_EXECUTABLE = "lfcp-reminders-helper";

/** The pid runs our helper executable (Linux: /proc/<pid>/exe; macOS: ps comm). */
export function isHelperProcess(pid: number, name = HELPER_EXECUTABLE): boolean {
  return executableName(pid) === name;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits up to `ms` for the pid to be gone. */
async function gone(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() >= until) return false;
    await sleep(Math.min(50, ms));
  }
  return true;
}

export class HelperSupervisor {
  readonly #o: SupervisorOptions;
  #helper: SupervisedHelper | undefined;
  #state: SupervisorState = "stopped";
  #restarts: number[] = [];
  #timer: unknown;
  #offExit: (() => void) | undefined;
  #busy: Promise<void> = Promise.resolve();
  /** Bumped by stop(): work started under an older generation must not launch a helper. */
  #gen = 0;
  /** The launch in flight (including closing a helper that came up after stop). */
  #launching: Promise<unknown> | undefined;

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
    const gen = this.#gen;
    await this.#stopOrphan();
    if (gen !== this.#gen) return;
    await this.#launch(gen);
    if (gen !== this.#gen) return;
    const every = this.#o.pingEveryMs ?? 30_000;
    const h = (this.#o.setInterval ?? setInterval)(() => {
      void this.pingNow();
    }, every);
    h.unref?.();
    this.#timer = h;
  }

  /** One supervision round (the timer calls it; tests too). */
  pingNow(): Promise<void> {
    const gen = this.#gen;
    this.#busy = this.#busy.then(async () => {
      const helper = this.#helper;
      if (gen !== this.#gen || this.#state !== "running" || helper === undefined) return;
      try {
        await helper.ping();
      } catch {
        if (gen !== this.#gen || this.#helper !== helper) return;
        await this.#restart("no answer to ping", gen);
      }
    });
    return this.#busy;
  }

  /**
   * Restarts the helper now, for `reason` (the helper reported a stalled store call, R-001 live
   * run 2). Counts toward the restart budget like any restart. With `helper`, only that helper is
   * restarted: a late report about one already replaced restarts nothing.
   */
  restartNow(reason: string, helper?: SupervisedHelper): Promise<void> {
    const gen = this.#gen;
    this.#busy = this.#busy.then(async () => {
      if (gen !== this.#gen || this.#state !== "running" || this.#helper === undefined) return;
      if (helper !== undefined && this.#helper !== helper) return;
      await this.#restart(reason, gen);
    });
    return this.#busy;
  }

  async stop(): Promise<void> {
    this.#gen++;
    if (this.#timer !== undefined)
      (this.#o.clearInterval ?? clearInterval)(this.#timer as NodeJS.Timeout);
    this.#timer = undefined;
    this.#state = "stopped";
    this.#offExit?.();
    const helper = this.#helper;
    this.#helper = undefined;
    await helper?.close();
    // A start in flight finishes under the old generation and closes its helper itself.
    await this.#launching;
    rmSync(this.#o.pidFile, { force: true });
  }

  /** A person resumed after helper_unavailable: try again with a fresh budget. */
  async resume(): Promise<void> {
    this.#restarts = [];
    if (this.#state === "unavailable") await this.#launch(this.#gen);
  }

  /**
   * Stops the helper of a previous run named in helper.pid, if that pid runs our executable, and
   * waits until it is gone. Throws (keeping helper.pid) when it survives SIGKILL: no replacement
   * starts next to it.
   */
  async #stopOrphan(): Promise<void> {
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
      if (!(await gone(pid, this.#o.orphanGraceMs ?? 5_000))) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
        if (!(await gone(pid, 2_000)))
          throw new Error(`the previous helper (pid ${pid}) does not exit; not starting another`);
      }
    }
    rmSync(this.#o.pidFile, { force: true });
  }

  /** Starts a helper for generation `gen`; one that comes up after a stop is closed at once. */
  #launch(gen: number): Promise<void> {
    const run = (async () => {
      const helper = await this.#o.start();
      if (gen !== this.#gen) {
        await helper.close().catch(() => {});
        return;
      }
      this.#helper = helper;
      this.#state = "running";
      if (helper.pid !== undefined) writeFileSync(this.#o.pidFile, `${helper.pid}\n`);
      // Through restartNow: whether this helper is still the one running is checked when the
      // queued restart runs, not when the exit is noticed. A ping or stall handled meanwhile may
      // have replaced it, and the new helper must not be restarted for the old one's exit
      // (review #23 r2 P2-1): one incident, one restart.
      this.#offExit = helper.onExit(() => {
        if (gen === this.#gen && this.#helper === helper && this.#state === "running")
          void this.restartNow("the helper exited", helper);
      });
    })();
    const settled = run.catch(() => {});
    this.#launching = settled;
    void settled.then(() => {
      if (this.#launching === settled) this.#launching = undefined;
    });
    return run;
  }

  async #restart(reason: string, gen: number): Promise<void> {
    if (gen !== this.#gen) return;
    const now = (this.#o.now ?? Date.now)();
    const window = this.#o.restartWindowMs ?? 5 * 60_000;
    this.#restarts = [...this.#restarts.filter((t) => now - t < window), now];
    this.#offExit?.();
    const old = this.#helper;
    this.#helper = undefined;
    await old?.close().catch(() => {});
    if (gen !== this.#gen) return;
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
      await this.#launch(gen);
      if (gen === this.#gen && this.#helper) this.#o.onRestart?.(reason, this.#helper);
    } catch (e) {
      if (gen !== this.#gen) return;
      // A failed start counts as a restart too; the next ping round tries again.
      this.#state = "running";
      this.#helper = undefined;
      await this.#restart(`start failed: ${(e as Error).message}`, gen);
    }
  }
}
