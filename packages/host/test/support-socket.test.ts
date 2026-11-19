// The support socket (A§7.3, E22, PLAN §E-006a): support.sock in a 0700 directory, the socket
// 0600, only the host's uid served; a support command runs in the host's one queue, serialized
// with the passes, on the run process's transport — never a second one.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { FakeStore, FakeTransport } from "@openlfcp/bridge-reminders/fake";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppHost } from "../src/app/serve.js";
import { listenSupport, SUPPORT_SOCKET } from "../src/app/support.js";
import { bridgePaths } from "../src/config.js";
import { openBridgeDatabase } from "../src/db/database.js";
import { Holds } from "../src/db/holds.js";
import { Journal } from "../src/db/journal.js";
import { STOP_FILE } from "../src/db/stop.js";
import { EXIT, main } from "../src/index.js";
import type { Runtime } from "../src/runtime.js";

const UID = process.getuid?.() ?? 501;

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lfcp-support-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

interface Reply {
  readonly out: string[];
  readonly err: string[];
  readonly exit?: { code: number; error?: string };
}

/** The thin client's side: one request, every line until the host closes. */
function request(path: string, argv: readonly string[]): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const r: { out: string[]; err: string[]; exit?: { code: number; error?: string } } = {
      out: [],
      err: [],
    };
    let buffer = "";
    const s = connect(path, () => s.write(`${JSON.stringify({ v: 1, argv })}\n`));
    s.setEncoding("utf8");
    s.on("data", (chunk: string) => {
      buffer += chunk;
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const e = JSON.parse(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (e.type === "out") r.out.push(e.line);
        else if (e.type === "err") r.err.push(e.line);
        else if (e.type === "exit")
          r.exit = { code: e.code, ...(e.error === undefined ? {} : { error: e.error }) };
      }
    });
    s.on("error", reject);
    s.on("close", () => resolve(r));
  });
}

const sock = () => join(home, "data", SUPPORT_SOCKET);

describe("support.sock (L0)", () => {
  it("the directory is 0700 and the socket 0600, also over a wider directory", async () => {
    mkdirSync(join(home, "data"), { mode: 0o755 });
    chmodSync(join(home, "data"), 0o755);
    const server = await listenSupport({
      path: sock(),
      uid: UID,
      peerUid: async () => UID,
      run: async (argv, io) => {
        io.out(`ran ${argv.join(" ")}`);
        io.err("a note");
        return EXIT.NEEDS_PERSON;
      },
      log: () => {},
    });
    try {
      expect(statSync(join(home, "data")).mode & 0o777).toBe(0o700);
      expect(statSync(sock()).mode & 0o777).toBe(0o600);
      expect(statSync(sock()).isSocket()).toBe(true);
      expect(await request(sock(), ["quarantine", "list"])).toEqual({
        out: ["ran quarantine list"],
        err: ["a note"],
        exit: { code: EXIT.NEEDS_PERSON },
      });
    } finally {
      await server.close();
    }
  });

  it("refuses a peer of another uid, and any peer when its uid cannot be told", async () => {
    for (const peerUid of [async () => UID + 1, async () => undefined, undefined]) {
      const ran: string[] = [];
      const logs: string[] = [];
      const server = await listenSupport({
        path: sock(),
        uid: UID,
        peerUid,
        run: async (argv) => {
          ran.push(argv.join(" "));
          return 0;
        },
        log: (l) => logs.push(l),
      });
      try {
        const r = await request(sock(), ["stop"]);
        expect(r.exit).toEqual({ code: EXIT.NEEDS_PERSON, error: "forbidden" });
        expect(r.err).toHaveLength(1);
        expect(ran).toEqual([]);
        expect(logs.join("\n")).toContain("connection refused");
      } finally {
        await server.close();
      }
    }
  });

  it("answers a bad request with bad_request; never removes a file that is not a socket", async () => {
    const server = await listenSupport({
      path: sock(),
      uid: UID,
      peerUid: async () => UID,
      run: async () => 0,
      log: () => {},
    });
    try {
      const bad = await new Promise<string>((resolve) => {
        let got = "";
        const s = connect(sock(), () => s.write('{"v":1,"argv":[1]}\n'));
        s.setEncoding("utf8");
        s.on("data", (c: string) => {
          got += c;
        });
        s.on("close", () => resolve(got));
      });
      expect(JSON.parse(bad)).toEqual({
        v: 1,
        type: "exit",
        code: EXIT.USAGE,
        error: "bad_request",
      });
    } finally {
      await server.close();
    }
    rmSync(sock(), { force: true });
    writeFileSync(sock(), "not a socket");
    await expect(
      listenSupport({
        path: sock(),
        uid: UID,
        peerUid: undefined,
        run: async () => 0,
        log: () => {},
      }),
    ).rejects.toThrow("not a socket");
  });
});

describe("the host's one queue (L0)", () => {
  it("a support command runs inside the run process's exclusive section, after the queue", async () => {
    const order: string[] = [];
    const host = new AppHost({
      home,
      version: "t",
      pid: 1,
      start: async () => ({
        stop: async () => {},
        exclusive: async <T>(fn: () => Promise<T>) => {
          order.push("exclusive:in");
          const r = await fn();
          order.push("exclusive:out");
          return r;
        },
      }),
      sections: () => [],
      write: () => {},
      log: () => {},
      support: async (argv, io, p) => {
        order.push(`run ${argv.join(" ")} ${p === undefined ? "without" : "with"} process`);
        io.out("done");
        return 0;
      },
    });
    await host.begin();
    const out: string[] = [];
    const code = await host.support(["status"], { out: (l) => out.push(l), err: () => {} });
    expect(code).toBe(0);
    expect(out).toEqual(["done"]);
    expect(order).toEqual(["exclusive:in", "run status with process", "exclusive:out"]);
    await host.end("quit");
  });

  it("after a shutdown a support command is refused", async () => {
    let ran = false;
    const host = new AppHost({
      home,
      version: "t",
      pid: 1,
      start: async () => ({ stop: async () => {} }),
      sections: () => [],
      write: () => {},
      log: () => {},
      support: async () => {
        ran = true;
        return 0;
      },
    });
    await host.begin();
    await host.end("quit");
    const err: string[] = [];
    expect(await host.support(["stop"], { out: () => {}, err: (l) => err.push(l) })).toBe(
      EXIT.STOPPED,
    );
    expect(ran).toBe(false);
    expect(existsSync(join(home, STOP_FILE))).toBe(false);
  });
});

describe("run --app serves support.sock (L0)", () => {
  async function app(openTransport: () => Promise<never>) {
    const paths = bridgePaths(
      { LFCP_BRIDGE_HOME: home, LFCP_BRIDGE_LOGS: join(home, "logs") },
      home,
    );
    const db = openBridgeDatabase(paths.database);
    const t = new FakeTransport(new FakeStore());
    await t.open({
      installationKey: "x",
      state: { get: () => undefined, put: () => {}, delete: () => {}, keys: () => [] },
      scope: { listTitlePrefixes: ["LFCP · "], listIds: [] },
    });
    const rt = {
      paths,
      db,
      config: { bridgeInstanceId: "1b2d3f4a-0000-4000-8000-000000000001", helperPath: home },
      journal: new Journal(db),
      holds: new Holds(db),
      openTransport,
      startProcess: async () => ({
        stop: async () => {},
        transport: t,
        exclusive: <T>(fn: () => Promise<T>) => fn(),
      }),
      close: async () => db.close(),
    } as unknown as Runtime;
    const input = new PassThrough();
    const events: string[] = [];
    const done = main(["run", "--app"], {
      out: () => {},
      err: () => {},
      runtime: async () => rt,
      app: { input, write: (l) => events.push(l) },
      launchAgent05: { path: join(home, "no-agent.plist"), home, launchctl: () => {} },
      support: { uid: UID, peerUid: async () => UID },
    });
    for (let i = 0; i < 200 && !existsSync(join(home, SUPPORT_SOCKET)); i++)
      await new Promise((r) => setTimeout(r, 5));
    return { db, events, done, input, path: join(home, SUPPORT_SOCKET) };
  }

  it("doctor uses the run process's transport; no second transport is opened", async () => {
    let opened = 0;
    const a = await app(async () => {
      opened++;
      throw new Error("a second transport");
    });
    const r = await request(a.path, ["doctor"]);
    expect(r.out.join("\n")).toContain("reminders access: full access");
    expect(opened).toBe(0);
    const journal = a.db
      .prepare("SELECT key, params_json FROM journal WHERE key = 'support.command'")
      .all() as { key: string; params_json: string }[];
    expect(journal.map((j) => JSON.parse(j.params_json))).toEqual([
      { command: "doctor", exit: r.exit?.code, author: "support CLI" },
    ]);
    a.input.write(`${JSON.stringify({ v: 1, id: "1", cmd: "shutdown", reason: "quit" })}\n`);
    expect(await a.done).toBe(EXIT.OK);
    expect(existsSync(a.path)).toBe(false);
  });

  it("stop and resume over the socket change what the menu sees; other commands are refused", async () => {
    const a = await app(async () => {
      throw new Error("a second transport");
    });
    expect((await request(a.path, ["stop"])).exit).toEqual({ code: EXIT.OK });
    expect(existsSync(join(home, STOP_FILE))).toBe(true);
    const paused = a.events.map((l) => JSON.parse(l)).filter((e) => e.type === "status");
    expect(paused.at(-1)).toMatchObject({ state: "paused" });
    expect((await request(a.path, ["resume"])).exit).toEqual({ code: EXIT.OK });
    expect(existsSync(join(home, STOP_FILE))).toBe(false);
    for (const argv of [["pair"], ["run"], ["service", "install"], ["bind", "Inbox"]])
      expect((await request(a.path, argv)).exit?.code).toBe(EXIT.USAGE);
    a.input.end();
    expect(await a.done).toBe(EXIT.OK);
  });
});
