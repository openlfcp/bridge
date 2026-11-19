// The support socket of `run --app` (A§7.3, E22, PLAN §E-006): the one way in for support. The
// bundle's `lfcp-bridge` is a thin client of the running host; the host runs each command in its
// own queue, serialized with the passes, on its own transport (src/app/serve.ts, commands.ts).
//
// <data directory>/support.sock — the directory 0700, the socket 0600, and the peer's uid must be
// the host's: the trust of the 0.5 CLI under the same user. Node cannot read a peer's credentials,
// so the shell's executable does: it gets the connection as its fd 3 and prints getpeereid's uid
// (`LFCP Bridge --peer-uid`, app/Sources/BridgeShellCore/PeerCredentials.swift). Without it every
// connection is refused.
//
// One request per connection, JSON lines as the shell's channel (src/app/ipc.ts):
//   client → host  {"v":1,"argv":["quarantine","list"]}
//   host → client  {"v":1,"type":"out","line":"…"} · {"v":1,"type":"err","line":"…"}
//                  {"v":1,"type":"exit","code":0}                    last; then the host closes
// A refused connection gets an err line and {"type":"exit","code":3,"error":"forbidden"}.

import { spawn } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { EXIT } from "../exit.js";
import { LineSplitter } from "./ipc.js";

export const SUPPORT_SOCKET = "support.sock";
export const SUPPORT_VERSION = 1;
/** How long the shell's executable may take to name the peer. */
export const PEER_UID_TIMEOUT_MS = 5_000;

/** The uid of a connection's peer; undefined when it cannot be told. */
export type PeerUid = (socket: Socket) => Promise<number | undefined>;

export interface SupportIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface SupportServerOptions {
  /** <data directory>/support.sock. */
  readonly path: string;
  /** The host's uid: the only peer served. */
  readonly uid: number;
  /** undefined: no way to tell a peer's uid here, every connection is refused. */
  readonly peerUid: PeerUid | undefined;
  /** Runs one command; returns its exit code. */
  readonly run: (argv: readonly string[], io: SupportIo) => Promise<number>;
  readonly log: (line: string) => void;
}

/** The peer's uid as the shell's executable tells it (getpeereid on its fd 3). */
export function shellPeerUid(executable: string): PeerUid {
  return (socket) =>
    new Promise((resolve) => {
      let out = "";
      const child = spawn(executable, ["--peer-uid"], {
        stdio: ["ignore", "pipe", "ignore", socket],
      });
      const timer = setTimeout(() => child.kill(), PEER_UID_TIMEOUT_MS);
      child.stdout?.on("data", (d) => {
        out += String(d);
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const text = out.trim();
        resolve(code === 0 && /^\d+$/.test(text) ? Number(text) : undefined);
      });
    });
}

/** The shell's executable inside LFCP Bridge.app (A§2.1). */
export function shellExecutable(appBundle: string): string {
  return join(appBundle, "Contents", "MacOS", "LFCP Bridge");
}

/** Listens on support.sock; close() stops listening and removes the socket. */
export async function listenSupport(o: SupportServerOptions): Promise<{ close(): Promise<void> }> {
  const dir = dirname(o.path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  // A socket left by a host that crashed (run.lock keeps a second host out); anything else is not
  // ours to remove.
  try {
    if (!lstatSync(o.path).isSocket())
      throw new Error(`${SUPPORT_SOCKET} exists and is not a socket`);
    unlinkSync(o.path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const open = new Set<Socket>();
  const server = createServer((socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    void serve(socket, o);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // The directory is 0700 already: nobody else could reach the socket before this.
  chmodSync(o.path, 0o600);
  return {
    close: () =>
      new Promise((resolve) => {
        for (const s of open) s.destroy();
        server.close(() => {
          try {
            unlinkSync(o.path);
          } catch {}
          resolve();
        });
      }),
  };
}

async function serve(socket: Socket, o: SupportServerOptions): Promise<void> {
  socket.on("error", () => {});
  const send = (e: Record<string, unknown>) => {
    if (!socket.destroyed) socket.write(`${JSON.stringify({ v: SUPPORT_VERSION, ...e })}\n`);
  };
  const end = (code: number, error?: string) => {
    send({ type: "exit", code, ...(error === undefined ? {} : { error }) });
    socket.end();
  };
  // Lines are read only after the peer is known (the stream keeps what comes meanwhile).
  socket.pause();
  const uid = o.peerUid === undefined ? undefined : await o.peerUid(socket).catch(() => undefined);
  if (uid === undefined || uid !== o.uid) {
    o.log(`support: connection refused (peer uid ${uid ?? "unknown"})`);
    send({ type: "err", line: "refused: only the user this bridge runs as may use it" });
    end(EXIT.NEEDS_PERSON, "forbidden");
    return;
  }
  let taken = false;
  const splitter = new LineSplitter(
    (line) => {
      if (taken) return;
      taken = true;
      void request(line);
    },
    () => {
      if (taken) return;
      taken = true;
      end(EXIT.USAGE, "bad_request");
    },
  );
  const request = async (line: string) => {
    let argv: unknown;
    try {
      const v = JSON.parse(line) as { v?: unknown; argv?: unknown };
      argv = v.v === SUPPORT_VERSION ? v.argv : undefined;
    } catch {}
    if (!Array.isArray(argv) || !argv.every((a) => typeof a === "string")) {
      end(EXIT.USAGE, "bad_request");
      return;
    }
    let code: number;
    try {
      code = await o.run(argv, {
        out: (l) => send({ type: "out", line: l }),
        err: (l) => send({ type: "err", line: l }),
      });
    } catch {
      send({ type: "err", line: "internal error (lfcp-bridge log)" });
      code = EXIT.INTERNAL;
    }
    end(code);
  };
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => splitter.push(chunk));
  socket.resume();
}
