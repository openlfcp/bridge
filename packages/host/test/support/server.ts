// The Rust reference server for live tests: $LFCP_SERVER_BIN (a built
// lfcp-server at server.lock). Without it the live tests are skipped,
// unless LFCP_REQUIRE_LIVE=1. Restartable on the same port and state.

import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface LiveServer {
  readonly url: string;
  stop(): Promise<void>;
  restart(): Promise<void>;
  dispose(): Promise<void>;
}

export function serverSkip(): string | undefined {
  const bin = process.env.LFCP_SERVER_BIN;
  const why =
    bin === undefined || bin === ""
      ? "LFCP_SERVER_BIN is not set"
      : existsSync(bin)
        ? undefined
        : `LFCP_SERVER_BIN=${bin}: no such file`;
  if (why !== undefined && process.env.LFCP_REQUIRE_LIVE === "1")
    throw new Error(`LFCP_REQUIRE_LIVE=1 but ${why}`);
  return why;
}

const freePort = () =>
  new Promise<number>((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => ok(typeof a === "object" && a !== null ? a.port : 0));
    });
  });

export async function startServer(): Promise<LiveServer> {
  const bin = process.env.LFCP_SERVER_BIN as string;
  const dir = mkdtempSync(join(tmpdir(), "lfcp-bridge-server-"));
  mkdirSync(join(dir, "state"));
  const port = await freePort();
  const url = `ws://127.0.0.1:${port}/v1/ws`;
  writeFileSync(
    join(dir, "server.toml"),
    [
      `bind = "127.0.0.1:${port}"`,
      `state_dir = ${JSON.stringify(join(dir, "state"))}`,
      `public_urls = [${JSON.stringify(url)}]`,
      "heartbeat_ms = 5000",
      "connections_per_ip_per_minute = 0",
      "hosts_per_ip_per_day = 0",
      "",
    ].join("\n"),
  );
  let child: ChildProcess | undefined;
  const run = async () => {
    child = spawn(bin, ["--config", join(dir, "server.toml")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const log = (d: Buffer) => appendFileSync(join(dir, "server.log"), d);
    child.stdout?.on("data", log);
    child.stderr?.on("data", log);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("the server did not start");
  };
  const stop = async () => {
    const c = child;
    if (c === undefined || c.exitCode !== null) return;
    const done = new Promise((r) => c.once("exit", r));
    c.kill("SIGTERM");
    await done;
  };
  await run();
  return {
    url,
    stop,
    restart: run,
    dispose: async () => {
      await stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function waitFor(what: string, cond: () => boolean | Promise<boolean>, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}
