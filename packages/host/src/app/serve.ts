// `lfcp-bridge run --app`: the host under LFCP Bridge.app (A§1, A§2.3, PLAN §E-004). Commands
// come on stdin, events and replies go to stdout (src/app/ipc.ts). One command at a time, in
// order of arrival.
//
// | command          | here                                                                    |
// |------------------|-------------------------------------------------------------------------|
// | pause            | STOP (db/stop.ts): permanent until resume (A§6.3)                       |
// | resume           | STOP removed; a run process that could not start is tried again          |
// | shutdown{reason} | nothing new starts, what is in flight finishes (≤ 60 s), exit 0; never  |
// |                  | STOP — update, quit and logout continue at the next start (A§6.3)       |
// | openURL{url}     | accepted; the handoff itself is E-031. The URL is never logged          |
// | answer, export,  | not_implemented until E-042, E-045, E-034                               |
// | remove           |                                                                         |
//
// stdin closing (the shell is gone) is a shutdown too: a host without its shell would be an
// orphan that nobody can pause.

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

/** Why the host ends: a shutdown command's reason, the shell gone, or a signal. */
export type EndReason = "update" | "quit" | "logout" | "stdin_closed" | "SIGTERM" | "SIGINT";

export interface AppHostOptions {
  /** The bridge's directory (STOP lives there). */
  readonly home: string;
  readonly version: string;
  readonly pid: number;
  /** Starts the run process (Runtime.startProcess). */
  readonly start: () => Promise<{ stop(reason?: string): Promise<void> }>;
  /** The bindings for the status event. */
  readonly sections: () => readonly SectionStatus[];
  /** One line to stdout (without "\n"). */
  readonly write: (line: string) => void;
  /** One line to the log (stderr). Never given a URL or task data. */
  readonly log: (line: string) => void;
  readonly shutdownWaitMs?: number;
}

export class AppHost {
  readonly #o: AppHostOptions;
  readonly #splitter: LineSplitter;
  #process: { stop(reason?: string): Promise<void> } | undefined;
  #state: HostState = "starting";
  #reason: string | undefined;
  #queue: Promise<void> = Promise.resolve();
  #ending: EndReason | undefined;
  #ended!: (r: EndReason) => void;
  /** Resolves when the host has shut down (the process exits with 0 then). */
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

  /** hello, then the run process. */
  async begin(): Promise<void> {
    this.#emit({ type: "hello", version: this.#o.version, pid: this.#o.pid });
    this.#status();
    await this.#enqueue(() => this.#startProcess());
  }

  /** Bytes from stdin. */
  input(chunk: string): void {
    this.#splitter.push(chunk);
  }

  /** stdin closed, or a signal. */
  end(why: EndReason): Promise<EndReason> {
    void this.#enqueue(() => this.#shutdown(why));
    return this.ended;
  }

  #enqueue(job: () => Promise<void>): Promise<void> {
    this.#queue = this.#queue.then(job, job).catch((e: unknown) => {
      this.#o.log(`app: internal error: ${e instanceof Error ? e.message : String(e)}`);
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
      this.#o.log(`app: sections unavailable: ${(e as Error).message}`);
    }
    this.#emit({
      type: "status",
      state: this.#state,
      ...(this.#reason === undefined ? {} : { reason: this.#reason }),
      sections,
    });
  }

  #settle(): void {
    if (this.#ending !== undefined) return;
    if (this.#process === undefined) return;
    this.#state = stopState(this.#o.home) === undefined ? "running" : "paused";
    this.#reason = undefined;
  }

  async #startProcess(): Promise<void> {
    if (this.#ending !== undefined || this.#process !== undefined) return;
    try {
      this.#process = await this.#o.start();
      this.#o.log("app: run process started");
      this.#settle();
    } catch (e) {
      // Not fatal: the shell shows it, the person can resume (try again) or quit.
      this.#state = "unavailable";
      this.#reason = "start_failed";
      this.#o.log(`app: run process failed to start: ${(e as Error).message}`);
    }
    this.#status();
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
    await this.#run(id, command);
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

  async #run(id: string, c: Command): Promise<void> {
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
        if (this.#process === undefined) await this.#startProcess();
        else {
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
        await this.#shutdown(c.reason);
        return;
    }
  }

  async #shutdown(why: EndReason): Promise<void> {
    if (this.#ending !== undefined) return;
    this.#ending = why;
    this.#state = "stopping";
    this.#reason = why;
    this.#status();
    this.#o.log(`app: shutting down (${why})`);
    const p = this.#process;
    this.#process = undefined;
    if (p !== undefined) {
      let timer: NodeJS.Timeout | undefined;
      const waited = new Promise<"timeout">((r) => {
        timer = setTimeout(() => r("timeout"), this.#o.shutdownWaitMs ?? SHUTDOWN_WAIT_MS);
      });
      try {
        const r = await Promise.race([
          p.stop(`shutdown: ${why}`).then(() => "done" as const),
          waited,
        ]);
        if (r === "timeout") this.#o.log("app: in-flight work did not finish in time; exiting");
      } catch (e) {
        this.#o.log(`app: run process stopped with an error: ${(e as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
    }
    this.#ended(why);
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
