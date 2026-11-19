// `lfcp-bridge run --app`: the host under LFCP Bridge.app (A§1, A§2.3, PLAN §E-004). Commands
// come on stdin, events and replies go to stdout (src/app/ipc.ts). Commands run one at a time, in
// order of arrival; none of them waits for the run process to start.
//
// | command          | here                                                                    |
// |------------------|-------------------------------------------------------------------------|
// | pause            | STOP (db/stop.ts): permanent until resume (A§6.3)                       |
// | resume           | STOP removed; a run process that could not start is tried again          |
// | shutdown{reason} | at once, even while the run process starts: no new effect (the process's |
// |                  | own stop gate), what is in flight finishes, exit 0. Never STOP — update, |
// |                  | quit and logout continue at the next start (A§6.3)                      |
// | openURL{url}     | accepted; the handoff itself is E-031. The URL is never logged          |
// | answer, export,  | not_implemented until E-042, E-045, E-034                               |
// | remove           |                                                                         |
//
// stdin closing (the shell is gone) and SIGTERM/SIGINT are a shutdown too: a host without its
// shell would be an orphan that nobody can pause.
//
// The deadline (60 s from the shutdown, A§6.3) covers a start in progress and the stop. Past it
// the process exits at once with EXIT_DEADLINE, without releasing run.lock or closing
// bridge.sqlite under work that still runs: committed rows are durable (WAL, synchronous=FULL),
// an effect in flight stays `effecting` for the next start's recovery (§5.7), and the lock's pid
// is dead, so the next host takes it over.

import { resume, stop, stopState } from "../db/stop.js";
import {
  type Command,
  type ErrorCode,
  type Event,
  encodeEvent,
  type HostState,
  LineSplitter,
  parseCommand,
  type SectionStatus,
} from "./ipc.js";

export const SHUTDOWN_WAIT_MS = 60_000;
/** The exit code when the shutdown deadline passed with work still running. */
export const EXIT_DEADLINE = 1;

/** Why the host ends: a shutdown command's reason, the shell gone, or a signal. */
export type EndReason = "update" | "quit" | "logout" | "stdin_closed" | "SIGTERM" | "SIGINT";

type RunProcess = { stop(reason?: string): Promise<void> };

export interface AppHostOptions {
  /** The bridge's directory (STOP lives there). */
  readonly home: string;
  readonly version: string;
  readonly pid: number;
  /** Starts the run process (Runtime.startProcess). */
  readonly start: () => Promise<RunProcess>;
  /** The bindings for the status event. */
  readonly sections: () => readonly SectionStatus[];
  /** One line to stdout (without "\n"). */
  readonly write: (line: string) => void;
  /** One line to the log (stderr). Never given a URL or task data. */
  readonly log: (line: string) => void;
  readonly shutdownWaitMs?: number;
  /** Ends the process at the deadline (default process.exit); tests record it. */
  readonly exit?: (code: number) => void;
}

/** A safe detail for a failed command: the error's code, never its message (paths, values). */
function failure(e: unknown): string {
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "error";
}

export class AppHost {
  readonly #o: AppHostOptions;
  readonly #splitter: LineSplitter;
  #process: RunProcess | undefined;
  #starting: Promise<void> | undefined;
  #state: HostState = "starting";
  #reason: string | undefined;
  #queue: Promise<void> = Promise.resolve();
  #ending: EndReason | undefined;
  #ended!: (r: EndReason) => void;
  /** Resolves when the host has shut down in time (the process exits with 0 then). */
  readonly ended: Promise<EndReason>;

  constructor(o: AppHostOptions) {
    this.#o = o;
    this.ended = new Promise((r) => {
      this.#ended = r;
    });
    this.#splitter = new LineSplitter(
      (line) => this.#enqueue(() => this.#line(line)),
      () => this.#emit({ type: "reply", id: null, ok: false, error: { code: "bad_line" } }),
    );
  }

  /** hello, then the run process (not awaited by commands). */
  async begin(): Promise<void> {
    this.#emit({ type: "hello", version: this.#o.version, pid: this.#o.pid });
    this.#status();
    await this.#startProcess();
  }

  /** Bytes from stdin. */
  input(chunk: string): void {
    this.#splitter.push(chunk);
  }

  /** stdin closed, or a signal: at once, not behind the queue. */
  end(why: EndReason): Promise<EndReason> {
    this.#shutdown(why);
    return this.ended;
  }

  #enqueue(job: () => Promise<void>): Promise<void> {
    this.#queue = this.#queue.then(job, job).catch((e: unknown) => {
      this.#o.log(`app: internal error: ${failure(e)}`);
    });
    return this.#queue;
  }

  #emit(e: Event): void {
    this.#o.write(encodeEvent(e));
  }

  #status(): void {
    let sections: readonly SectionStatus[] = [];
    try {
      sections = this.#o.sections();
    } catch (e) {
      this.#o.log(`app: sections unavailable: ${failure(e)}`);
    }
    this.#emit({
      type: "status",
      state: this.#state,
      ...(this.#reason === undefined ? {} : { reason: this.#reason }),
      sections,
    });
  }

  #settle(): void {
    if (this.#ending !== undefined || this.#process === undefined) return;
    this.#state = stopState(this.#o.home) === undefined ? "running" : "paused";
    this.#reason = undefined;
  }

  /** Starts the run process once at a time; a shutdown during it stops what it brings. */
  #startProcess(): Promise<void> {
    if (this.#ending !== undefined || this.#process !== undefined) return Promise.resolve();
    if (this.#starting !== undefined) return this.#starting;
    this.#state = "starting";
    this.#reason = undefined;
    const run = (async () => {
      try {
        const p = await this.#o.start();
        if (this.#ending !== undefined) {
          // Started after the shutdown: stop it at once (bounded by the shutdown's deadline).
          this.#o.log("app: run process started after shutdown; stopping it");
          this.#process = p;
          return;
        }
        this.#process = p;
        this.#o.log("app: run process started");
        this.#settle();
      } catch (e) {
        if (this.#ending !== undefined) return;
        // Not fatal: the shell shows it, the person can resume (try again) or quit.
        this.#state = "unavailable";
        this.#reason = "start_failed";
        this.#o.log(`app: run process failed to start: ${(e as Error).message}`);
      } finally {
        this.#starting = undefined;
      }
      this.#status();
    })();
    this.#starting = run;
    return run;
  }

  async #line(line: string): Promise<void> {
    const parsed = parseCommand(line);
    if (!parsed.ok) {
      this.#fail(parsed.id, parsed.code, parsed.detail);
      return;
    }
    const { id, command } = parsed.envelope;
    if (this.#ending !== undefined) {
      this.#fail(id, "shutting_down");
      return;
    }
    try {
      this.#run(id, command);
    } catch (e) {
      this.#o.log(`app: ${command.cmd} failed: ${failure(e)}`);
      this.#fail(id, "failed", failure(e));
    }
  }

  #fail(id: string | null, code: ErrorCode, detail?: string): void {
    this.#emit({
      type: "reply",
      id,
      ok: false,
      error: { code, ...(detail === undefined ? {} : { detail }) },
    });
  }

  #ok(id: string, result?: Record<string, unknown>): void {
    this.#emit({ type: "reply", id, ok: true, ...(result === undefined ? {} : { result }) });
  }

  /** Synchronous: nothing here waits for the run process. */
  #run(id: string, c: Command): void {
    switch (c.cmd) {
      case "pause":
        stop(this.#o.home, "Pause syncing (menu)");
        this.#o.log("app: paused (STOP written)");
        this.#ok(id);
        this.#settle();
        this.#status();
        return;
      case "resume":
        resume(this.#o.home);
        this.#o.log("app: resumed (STOP removed)");
        this.#ok(id);
        if (this.#process === undefined) {
          if (this.#starting === undefined) {
            void this.#startProcess();
            this.#status();
          }
        } else {
          this.#settle();
          this.#status();
        }
        return;
      case "openURL":
        // The handoff (pairing, E-031) reads it; until then it is only acknowledged.
        this.#o.log("app: openURL received");
        this.#ok(id, { handled: false });
        return;
      case "answer":
      case "export":
      case "remove":
        this.#fail(id, "not_implemented", c.cmd);
        return;
      case "shutdown":
        this.#ok(id);
        this.#shutdown(c.reason);
        return;
    }
  }

  #shutdown(why: EndReason): void {
    if (this.#ending !== undefined) return;
    this.#ending = why;
    this.#state = "stopping";
    this.#reason = why;
    this.#status();
    this.#o.log(`app: shutting down (${why})`);
    const deadline = setTimeout(() => {
      this.#o.log("app: shutdown deadline passed with work still running; exiting");
      (this.#o.exit ?? ((code: number) => process.exit(code)))(EXIT_DEADLINE);
    }, this.#o.shutdownWaitMs ?? SHUTDOWN_WAIT_MS);
    void (async () => {
      // A start in progress is waited for (it cannot be cancelled midway); what it brought is stopped.
      await this.#starting;
      const p = this.#process;
      this.#process = undefined;
      try {
        await p?.stop(`shutdown: ${why}`);
      } catch (e) {
        this.#o.log(`app: run process stopped with an error: ${failure(e)}`);
      }
      clearTimeout(deadline);
      this.#ended(why);
    })();
  }
}

export interface AppIo {
  /** stdin: commands. */
  readonly input: NodeJS.ReadableStream;
  /** stdout: one line (without "\n"). */
  readonly write: (line: string) => void;
}

const SIGNALS = ["SIGTERM", "SIGINT"] as const;

/**
 * Runs the host for the shell until shutdown: run.lock as `run`, then AppHost over stdio. A held
 * run.lock is not served: the shell sees the host exit and restarts it with its back-off.
 */
export async function serveApp(o: {
  readonly home: string;
  readonly version: string;
  readonly lock: () => (() => void) | { readonly held: number };
  readonly start: AppHostOptions["start"];
  readonly sections: AppHostOptions["sections"];
  readonly io: AppIo;
  readonly log: (line: string) => void;
  /** Tests leave the process's signal handlers alone. */
  readonly signals?: boolean;
  readonly shutdownWaitMs?: number;
  readonly exit?: (code: number) => void;
}): Promise<EndReason | { readonly held: number }> {
  const lock = o.lock();
  if (typeof lock !== "function") {
    o.log(`run --app: another lfcp-bridge run is running (pid ${lock.held})`);
    return lock;
  }
  const host = new AppHost({
    home: o.home,
    version: o.version,
    pid: process.pid,
    start: o.start,
    sections: o.sections,
    write: o.io.write,
    log: o.log,
    ...(o.shutdownWaitMs === undefined ? {} : { shutdownWaitMs: o.shutdownWaitMs }),
    ...(o.exit === undefined ? {} : { exit: o.exit }),
  });
  const onData = (chunk: Buffer | string) => host.input(String(chunk));
  const onEnd = () => void host.end("stdin_closed");
  const onSignal = (s: NodeJS.Signals) => void host.end(s as EndReason);
  o.io.input.setEncoding?.("utf8");
  o.io.input.on("data", onData);
  o.io.input.on("end", onEnd);
  if (o.signals !== false) for (const s of SIGNALS) process.on(s, onSignal);
  try {
    await host.begin();
    return await host.ended;
  } finally {
    o.io.input.off("data", onData);
    o.io.input.off("end", onEnd);
    o.io.input.pause();
    if (o.signals !== false) for (const s of SIGNALS) process.off(s, onSignal);
    lock();
  }
}
