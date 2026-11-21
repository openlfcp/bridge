// The support CLI of LFCP Bridge.app (A§7.3, E22, PLAN §E-006): `Contents/Resources/bin/lfcp-bridge`
// runs `bridge.mjs --support-client <argv>`. A thin client of the running host: it opens neither
// EventKit nor bridge.sqlite, it sends argv to support.sock (src/app/support.ts) and prints what
// comes back; its exit code is the command's.
//
// The app not running (no socket, or nobody listening): `open -b org.openlfcp.bridge --args
// --support-wait`, then the socket is tried again for at most 30 s.

import { execFile } from "node:child_process";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { bridgePaths } from "../config.js";
import { EXIT } from "../exit.js";
import { LineSplitter } from "./ipc.js";
import { SUPPORT_SOCKET, SUPPORT_VERSION, type SupportIo } from "./support.js";

export const BUNDLE_ID = "org.openlfcp.bridge";
export const SUPPORT_WAIT_MS = 30_000;

export interface SupportClientOptions {
  readonly path: string;
  readonly argv: readonly string[];
  readonly io: SupportIo;
  /** Starts the app (default: open -b org.openlfcp.bridge --args --support-wait). */
  readonly launch?: () => Promise<void>;
  readonly waitMs?: number;
  readonly retryMs?: number;
}

const launchApp = () =>
  new Promise<void>((resolve, reject) =>
    execFile("open", ["-b", BUNDLE_ID, "--args", "--support-wait"], (e) =>
      e ? reject(e) : resolve(),
    ),
  );

/** A connected socket, or the error code when nobody listens there. */
function open(path: string): Promise<Socket | string> {
  return new Promise((resolve) => {
    const s = connect(path);
    s.once("connect", () => {
      s.removeAllListeners("error");
      resolve(s);
    });
    s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
  });
}

const absent = (code: string) => code === "ENOENT" || code === "ECONNREFUSED";

/** Runs one support command on the host; returns its exit code. */
export async function supportClient(o: SupportClientOptions): Promise<number> {
  let s = await open(o.path);
  if (typeof s === "string" && absent(s)) {
    o.io.err("LFCP Bridge is not running: starting it…");
    try {
      await (o.launch ?? launchApp)();
    } catch {
      o.io.err("could not start LFCP Bridge (is it installed in /Applications?)");
      return EXIT.NEEDS_PERSON;
    }
    const until = Date.now() + (o.waitMs ?? SUPPORT_WAIT_MS);
    while (typeof s === "string" && absent(s) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, o.retryMs ?? 250));
      s = await open(o.path);
    }
  }
  if (typeof s === "string") {
    o.io.err(
      absent(s)
        ? `LFCP Bridge did not answer within ${Math.round((o.waitMs ?? SUPPORT_WAIT_MS) / 1000)} s`
        : `cannot reach LFCP Bridge (${s})`,
    );
    return EXIT.NEEDS_PERSON;
  }
  const socket = s;
  return new Promise((resolve) => {
    let code: number | undefined;
    const splitter = new LineSplitter(
      (line) => {
        let e: { type?: unknown; line?: unknown; code?: unknown };
        try {
          e = JSON.parse(line);
        } catch {
          return;
        }
        if (e.type === "out" && typeof e.line === "string") o.io.out(e.line);
        else if (e.type === "err" && typeof e.line === "string") o.io.err(e.line);
        else if (e.type === "exit" && typeof e.code === "number") code = e.code;
      },
      () => {},
    );
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => splitter.push(chunk));
    socket.on("error", () => {});
    socket.on("close", () => {
      if (code === undefined) o.io.err("LFCP Bridge closed the connection without an answer");
      resolve(code ?? EXIT.INTERNAL);
    });
    socket.write(`${JSON.stringify({ v: SUPPORT_VERSION, argv: o.argv })}\n`);
  });
}

/** The client as the bundle runs it: the socket in the data directory (LFCP_BRIDGE_HOME). */
export function supportClientMain(argv: readonly string[], io: SupportIo): Promise<number> {
  return supportClient({ path: join(bridgePaths().home, SUPPORT_SOCKET), argv, io });
}
