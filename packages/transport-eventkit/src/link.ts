/**
 * A connection to the helper process (D-010 r4 §8.2). In production the app is launched through
 * LaunchServices (`open -n -W -g -a … --stdin/--stdout/--stderr FIFO`), so TCC attributes Reminders
 * access to the app itself, not to node or Terminal (R-001 §2). `direct` spawns the executable,
 * for CI and development (access then belongs to the parent process).
 *
 * Lifecycle rules (review PR 6, P2-2..P2-4):
 * - every failure of start (spawn error, launcher or helper exit before ready, ready timeout, wrong
 *   protocol) rejects with HelperLostError and runs one cleanup: stop what was started, close the
 *   FIFO sockets, remove the FIFO directory;
 * - the FIFOs are opened O_RDWR | O_NONBLOCK before the launcher starts and used as net.Sockets:
 *   libuv polls them, no threadpool thread waits on a quiet FIFO (fs streams held one per FIFO in
 *   read(): two helpers took all four threads and no request was written, R-001 live run). On a
 *   FIFO, O_RDWR never blocks and never fails with ENXIO, so the helper's opens never wait either.
 *   We hold the write side of stdout/stderr ourselves, so EOF never comes from there: the helper's
 *   end is the launcher's exit (open -W), or the child's;
 * - a stdout line that is not JSON or answers no pending request goes to onUnmatched;
 * - close() asks the helper to stop, then stops the helper itself (its pid from ready, checked to be
 *   our executable) — with `open`, the launcher is not the helper;
 * - a request timeout rejects only that request (HelperLostError: its outcome is unknown); the
 *   connection stays up and a late answer is reported (onUnmatched), not delivered. Restarting a silent helper is the host's
 *   supervision (PR 9).
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { PROTOCOL, type WireEvent, type WireReady, type WireResponse } from "./wire.js";

/** The helper is gone or did not answer: the outcome of an in-flight request is unknown. */
export class HelperLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HelperLostError";
  }
}

export interface HelperLink {
  readonly ready: WireReady;
  request(
    op: string,
    body?: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<WireResponse>;
  onEvent(cb: (e: WireEvent) => void): () => void;
  onExit(cb: (code: number | null) => void): () => void;
  close(): Promise<void>;
}

export interface HelperProcessOptions {
  /** Path to "LFCP Reminders Helper.app". */
  readonly appPath: string;
  readonly launch?: "open" | "direct";
  readonly backend?: "eventkit" | "memory";
  readonly readyTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  /** The LaunchServices launcher; tests substitute a stand-in. Default ["open"]. */
  readonly launcher?: readonly string[];
  /** Executable name of the helper, checked before a forced kill. Default "lfcp-reminders-helper". */
  readonly helperName?: string;
  /** How long close() waits for the helper to exit on its own before stopping it. Default 10 s. */
  readonly closeGraceMs?: number;
  /** stderr lines of the helper (EventKit logs noise there). */
  readonly onStderr?: (line: string) => void;
  /** stdout lines that are not JSON or answer no pending request (a late answer, no id). */
  readonly onUnmatched?: (line: string) => void;
}

/**
 * @internal
 * A seam for this package's own tests, not part of its API: src/index.ts does not export it,
 * package.json exports only ".", and `stripInternal` keeps it out of every built declaration.
 * `beforeUnlink` runs in cleanup before the FIFOs are removed, while our ends are still open — the
 * window where a late open of an end must still return. Whatever it throws is ignored: cleanup
 * always completes.
 */
export const fifoTestHooks: {
  beforeUnlink?: (fifos: {
    readonly in: string;
    readonly out: string;
    readonly err: string;
  }) => void;
} = {};

export const EXECUTABLE = path.join("Contents", "MacOS", "lfcp-reminders-helper");
const HELPER_NAME = "lfcp-reminders-helper";

type Pending = {
  resolve: (r: WireResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * The file name of the executable a pid runs, or undefined. Linux: /proc/<pid>/exe — `ps -o comm=`
 * there is the main thread's name (Node calls it "MainThread") cut to 15 characters, so it names
 * neither node nor lfcp-reminders-helper. macOS: `ps -o comm=` is the executable's path.
 */
export function executableName(pid: number): string | undefined {
  try {
    return path.basename(fs.readlinkSync(`/proc/${pid}/exe`));
  } catch {}
  try {
    const comm = execFileSync("ps", ["-o", "comm=", "-p", String(pid)])
      .toString()
      .trim();
    return comm === "" ? undefined : path.basename(comm);
  } catch {
    return undefined;
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export class HelperProcess implements HelperLink {
  readonly #emitter = new EventEmitter();
  readonly #pending = new Map<number, Pending>();
  readonly #opts: HelperProcessOptions;
  #nextId = 1;
  #input: Writable | undefined;
  #child: ChildProcess | undefined;
  #childExited = false;
  #fifoDir: string | undefined;
  readonly #fifoSockets: net.Socket[] = [];
  readonly #readers: Interface[] = [];
  #closed = false;
  #stopping: Promise<void> = Promise.resolve();
  #ready: WireReady | undefined;

  private constructor(opts: HelperProcessOptions) {
    this.#opts = opts;
  }

  static async start(opts: HelperProcessOptions): Promise<HelperProcess> {
    const h = new HelperProcess(opts);
    try {
      await h.#launch();
    } catch (e) {
      await h.#stop();
      h.#closed = true;
      h.#cleanup();
      throw e instanceof HelperLostError
        ? e
        : new HelperLostError(`cannot start the helper: ${(e as Error).message}`);
    }
    return h;
  }

  get ready(): WireReady {
    if (this.#ready === undefined) throw new Error("helper not ready");
    return this.#ready;
  }

  async #launch(): Promise<void> {
    const opts = this.#opts;
    const args = [
      "serve",
      "--protocol",
      String(PROTOCOL),
      "--backend",
      opts.backend ?? "eventkit",
      "--host-pid",
      String(process.pid),
    ];
    let out: Readable;
    let err: Readable;
    let child: ChildProcess;
    if ((opts.launch ?? "open") === "direct") {
      child = spawn(path.join(opts.appPath, EXECUTABLE), args, { stdio: ["pipe", "pipe", "pipe"] });
      this.#input = child.stdin ?? undefined;
      out = child.stdout as Readable;
      err = child.stderr as Readable;
    } else {
      this.#fifoDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfcp-helper-"));
      const [fin, fout, ferr] = ["in", "out", "err"].map((n) =>
        path.join(this.#fifoDir as string, n),
      ) as [string, string, string];
      for (const f of [fin, fout, ferr]) execFileSync("mkfifo", [f]);
      const { O_RDWR, O_NONBLOCK } = fs.constants;
      const socket = (file: string, readable: boolean) => {
        const s = new net.Socket({
          fd: fs.openSync(file, O_RDWR | O_NONBLOCK),
          readable,
          writable: !readable,
        });
        this.#fifoSockets.push(s);
        return s;
      };
      this.#input = socket(fin, false);
      out = socket(fout, true);
      err = socket(ferr, true);
      const launcher = opts.launcher ?? ["open"];
      child = spawn(
        launcher[0] as string,
        [
          ...launcher.slice(1),
          "-n",
          "-W",
          "-g",
          "-a",
          opts.appPath,
          "--stdin",
          fin,
          "--stdout",
          fout,
          "--stderr",
          ferr,
          "--args",
          ...args,
        ],
        { stdio: "ignore" },
      );
    }
    this.#child = child;
    for (const s of [this.#input, out, err]) s?.on("error", () => {});
    const failed = new Promise<never>((_, reject) => {
      child.once("error", (e) =>
        reject(new HelperLostError(`cannot launch the helper: ${e.message}`)),
      );
      child.once("exit", (code) => {
        if (this.#ready === undefined)
          reject(new HelperLostError(`helper launcher exited (${code}) before ready`));
      });
    });
    failed.catch(() => {});
    child.on("exit", (code) => this.#onExit(code));
    const errLines = createInterface({ input: err });
    errLines.on("line", (l) => opts.onStderr?.(l));
    const outLines = createInterface({ input: out });
    outLines.on("line", (l) => this.#onLine(l));
    this.#readers.push(errLines, outLines);

    let timer: NodeJS.Timeout | undefined;
    const ready = new Promise<WireReady>((resolve) => this.#emitter.once("ready", resolve));
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new HelperLostError("helper not ready in time")),
        opts.readyTimeoutMs ?? 15_000,
      );
    });
    try {
      this.#ready = await Promise.race([ready, failed, timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (this.#ready.protocol !== PROTOCOL) {
      throw new HelperLostError(`helper speaks protocol ${this.#ready.protocol}, not ${PROTOCOL}`);
    }
  }

  #onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.#opts.onUnmatched?.(line);
      return;
    }
    if (typeof msg.event === "string") {
      if (msg.event === "ready") this.#emitter.emit("ready", msg);
      else this.#emitter.emit("event", msg);
      return;
    }
    const p = this.#pending.get(msg.id as number);
    if (p === undefined) {
      // an answer after its timeout, or a line without an id: not delivered, but not lost
      this.#opts.onUnmatched?.(line);
      return;
    }
    this.#pending.delete(msg.id as number);
    clearTimeout(p.timer);
    p.resolve(msg as WireResponse);
  }

  #onExit(code: number | null): void {
    this.#childExited = true;
    if (this.#closed) return;
    this.#closed = true;
    // With `open`, the child is the launcher: it may go away while the helper still runs (killed,
    // crashed). An unmanaged helper must not stay behind (review PR 6 r2): stop it too.
    this.#stopping = this.#stopHelper();
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new HelperLostError(`helper exited (${code}) with a request in flight`));
    }
    this.#pending.clear();
    this.#cleanup();
    this.#emitter.emit("exit", code);
  }

  request(
    op: string,
    body: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<WireResponse> {
    if (this.#closed || this.#input === undefined)
      return Promise.reject(new HelperLostError("helper is not running"));
    const id = this.#nextId++;
    const input = this.#input;
    const ms = opts.timeoutMs ?? this.#opts.requestTimeoutMs ?? 60_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new HelperLostError(`${op}: no answer in ${ms} ms`));
      }, ms);
      this.#pending.set(id, { resolve, reject, timer });
      input.write(`${JSON.stringify({ v: PROTOCOL, id, op, ...body })}\n`);
    });
  }

  onEvent(cb: (e: WireEvent) => void): () => void {
    this.#emitter.on("event", cb);
    return () => this.#emitter.off("event", cb);
  }

  onExit(cb: (code: number | null) => void): () => void {
    this.#emitter.on("exit", cb);
    return () => this.#emitter.off("exit", cb);
  }

  /** Asks the helper to stop and closes stdin; after closeGraceMs stops the helper itself. */
  async close(): Promise<void> {
    if (this.#closed) {
      // Already gone (the launcher exited): make sure the helper went with it.
      await this.#stopping;
      await this.#stopHelper();
      return;
    }
    const exited = new Promise<void>((r) => {
      if (this.#childExited) r();
      else this.#child?.once("exit", () => r());
    });
    await this.request("shutdown", {}, { timeoutMs: 5_000 }).catch(() => {});
    // EOF reaches the helper only when every write end of its stdin is closed; ours is O_RDWR, so
    // close the descriptor once the last request is flushed, not just the writing half.
    const input = this.#input;
    input?.end(() => input.destroy());
    await Promise.race([exited, sleep(this.#opts.closeGraceMs ?? 10_000)]);
    await this.#stop();
    this.#onExit(null);
  }

  /** Stops the helper (pid from ready, if it is our executable) and the launcher; waits for both. */
  async #stop(): Promise<void> {
    await this.#stopHelper();
    const child = this.#child;
    if (
      child !== undefined &&
      !this.#childExited &&
      child.exitCode === null &&
      child.pid !== undefined
    ) {
      child.kill("SIGTERM");
      for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++)
        await sleep(100);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }

  /** Stops the helper itself (pid from ready, if it still runs our executable); waits for it. */
  async #stopHelper(): Promise<void> {
    const pid = this.#ready?.pid;
    if (typeof pid !== "number" || pid === process.pid || !alive(pid) || !this.#owned(pid)) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
    for (let i = 0; i < 20 && alive(pid); i++) await sleep(100);
    if (alive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }

  /** The pid runs our helper executable (guards against a reused pid). */
  #owned(pid: number): boolean {
    return executableName(pid) === (this.#opts.helperName ?? HELPER_NAME);
  }

  /**
   * Closes the FIFO sockets and removes the FIFOs. The FIFOs go first, while our ends (O_RDWR) are
   * still open: an open of an end that started before the removal returns at once (it has both a
   * reader and a writer), one after it fails with ENOENT. Nothing of ours waits on a FIFO.
   */
  #cleanup(): void {
    for (const r of this.#readers) r.close();
    if (this.#fifoDir !== undefined) {
      const dir = this.#fifoDir;
      try {
        fifoTestHooks.beforeUnlink?.({
          in: path.join(dir, "in"),
          out: path.join(dir, "out"),
          err: path.join(dir, "err"),
        });
      } catch {
        // a test hook never stops the cleanup
      }
      fs.rmSync(dir, { recursive: true, force: true });
      this.#fifoDir = undefined;
    }
    for (const s of this.#fifoSockets) s.destroy();
    this.#input?.destroy();
  }
}
