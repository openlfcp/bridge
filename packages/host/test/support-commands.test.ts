// The support commands of E-006b (A§7.3) through the bundle's thin client (src/app/client.ts) and
// support.sock of `run --app`: links, safe-mode reset (refused while doctor names a cause),
// certification-test (until E-050); the client starts the app when nobody listens, for ≤ 30 s.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { FakeStore, FakeTransport } from "@openlfcp/bridge-reminders/fake";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { supportClient } from "../src/app/client.js";
import { listenSupport, SUPPORT_SOCKET } from "../src/app/support.js";
import { bridgePaths } from "../src/config.js";
import { openBridgeDatabase } from "../src/db/database.js";
import { Holds } from "../src/db/holds.js";
import { Journal } from "../src/db/journal.js";
import { Runs } from "../src/executor/safe-mode.js";
import { EXIT, main } from "../src/index.js";
import type { Runtime } from "../src/runtime.js";

const UID = process.getuid?.() ?? 501;

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lfcp-support-b-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

interface Said {
  readonly out: string[];
  readonly err: string[];
  readonly code: number;
}

async function client(path: string, argv: readonly string[]): Promise<Said> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await supportClient({
    path,
    argv,
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    launch: async () => {
      throw new Error("the app runs: no launch expected");
    },
  });
  return { out, err, code };
}

/** `run --app` over a FakeTransport; `server` is the run process's connection. */
async function app(server: { up: boolean | undefined }, helperPath = home) {
  const paths = bridgePaths({ LFCP_BRIDGE_HOME: home, LFCP_BRIDGE_LOGS: join(home, "logs") }, home);
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
    config: { bridgeInstanceId: "1b2d3f4a-0000-4000-8000-000000000001", helperPath },
    journal: new Journal(db),
    holds: new Holds(db),
    openTransport: async () => {
      throw new Error("a second transport");
    },
    startProcess: async () => ({
      stop: async () => {},
      transport: t,
      exclusive: <T>(fn: () => Promise<T>) => fn(),
      connected: () => server.up,
    }),
    close: async () => db.close(),
  } as unknown as Runtime;
  const input = new PassThrough();
  const written: string[] = [];
  const done = main(["run", "--app"], {
    out: () => {},
    err: () => {},
    runtime: async () => rt,
    app: { input, write: (l) => void written.push(l) },
    launchAgent05: { path: join(home, "no-agent.plist"), home, launchctl: () => {} },
    support: { uid: UID, peerUid: async () => UID },
  });
  const path = join(home, SUPPORT_SOCKET);
  for (let i = 0; i < 200 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 5));
  return {
    db,
    path,
    input,
    written,
    async end() {
      input.end();
      expect(await done).toBe(EXIT.OK);
    },
  };
}

const keys = (db: ReturnType<typeof openBridgeDatabase>, key: string) =>
  (
    db.prepare("SELECT params_json FROM journal WHERE key = ? ORDER BY id").all(key) as {
      params_json: string | null;
    }[]
  ).map((r) => (r.params_json === null ? {} : JSON.parse(r.params_json)));

function safeModeOn(db: ReturnType<typeof openBridgeDatabase>): void {
  db.prepare("INSERT INTO meta (key, value) VALUES ('safe_mode', ?)").run(
    JSON.stringify({ since: "2026-11-19T00:00:00.000Z", reason: "two crashed runs" }),
  );
}

describe("links (A§7.3)", () => {
  it("lists every link with the reminder id the quarantine commands take; --binding narrows", async () => {
    const a = await app({ up: true });
    const now = "2026-11-19T00:00:00.000Z";
    a.db
      .prepare(
        "INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES ('i', 'd', 'p', 'r', 'l', ?)",
      )
      .run(now);
    for (const b of ["b1", "b2"])
      a.db
        .prepare(
          `INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, filter_mode, state, created_at)
           VALUES (?, 'i', ?, 'apple-reminders', 'fake', 'all', 'active', ?)`,
        )
        .run(b, `r-${b}`, now);
    const link = a.db.prepare(
      `INSERT INTO links (binding_id, task_id, rem_external_id, rem_id_cache, rem_title_snapshot, origin, state,
         state_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'lfcp', ?, ?, ?, ?)`,
    );
    link.run("b1", "t1", "ext-1", "rem-1", "Buy milk", "linked", null, now, now);
    link.run("b1", "t2", null, null, null, "quarantine", "ambiguous_match", now, now);
    link.run("b2", "t3", "ext-3", null, "Call Anna", "linked", null, now, now);
    const all = await client(a.path, ["links"]);
    expect(all.code).toBe(EXIT.OK);
    expect(all.out).toEqual([
      'b1  t1  linked  lfcp  reminder rem-1 "Buy milk"',
      "b1  t2  quarantine (ambiguous_match)  lfcp",
      'b2  t3  linked  lfcp  reminder ext-3 "Call Anna"',
    ]);
    expect((await client(a.path, ["links", "--binding", "b2"])).out).toEqual([
      'b2  t3  linked  lfcp  reminder ext-3 "Call Anna"',
    ]);
    expect((await client(a.path, ["links", "--binding", "none"])).out).toEqual([
      "no links of none",
    ]);
    await a.end();
  });
});

describe("safe-mode reset (A§7.3)", () => {
  it("is refused with the cause while doctor names one; Safe Mode stays on", async () => {
    const server = { up: false as boolean | undefined };
    const a = await app(server);
    safeModeOn(a.db);
    const r = await client(a.path, ["safe-mode", "reset"]);
    expect(r.code).toBe(EXIT.NEEDS_PERSON);
    expect(r.err[0]).toBe(
      "safe-mode reset refused: server: not connected to the LFCP server (network, or the server is down)",
    );
    expect(new Runs(a.db).safeMode()).toBeDefined();
    expect(keys(a.db, "safe_mode.reset_refused")).toEqual([
      { causes: ["server"], author: "support CLI" },
    ]);
    expect(keys(a.db, "safe_mode.off")).toEqual([]);
    // The cause gone: the same command turns it off, once.
    server.up = true;
    const ok = await client(a.path, ["safe-mode", "reset"]);
    expect(ok).toMatchObject({ code: EXIT.OK, out: ["Safe Mode off: the next pass runs"] });
    expect(new Runs(a.db).safeMode()).toBeUndefined();
    expect(keys(a.db, "safe_mode.off")).toHaveLength(1);
    expect((await client(a.path, ["safe-mode", "reset"])).out).toEqual(["Safe Mode is not on"]);
    expect(keys(a.db, "support.command").map((p) => [p.command, p.exit, p.author])).toEqual([
      ["safe-mode reset", EXIT.NEEDS_PERSON, "support CLI"],
      ["safe-mode reset", EXIT.OK, "support CLI"],
      ["safe-mode reset", EXIT.OK, "support CLI"],
    ]);
    await a.end();
  });

  it("is refused when the helper is missing; the server check is left out when not known", async () => {
    const a = await app({ up: undefined }, join(home, "no-such.app"));
    safeModeOn(a.db);
    const r = await client(a.path, ["safe-mode", "reset"]);
    expect(r.code).toBe(EXIT.NEEDS_PERSON);
    expect(r.err).toHaveLength(2);
    expect(r.err[0]).toMatch(/^safe-mode reset refused: helper: /);
    expect(keys(a.db, "safe_mode.reset_refused")).toEqual([
      { causes: ["helper"], author: "support CLI" },
    ]);
    expect(new Runs(a.db).safeMode()).toBeDefined();
    await a.end();
  });

  it("asks for reset: other words are a usage error", async () => {
    const a = await app({ up: true });
    const r = await client(a.path, ["safe-mode", "off"]);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.err).toEqual(["usage: lfcp-bridge safe-mode reset"]);
    await a.end();
  });
});

describe("certification-test (until E-050)", () => {
  it("on and off say it is not in this build; anything else is a usage error", async () => {
    const a = await app({ up: true });
    for (const sub of ["on", "off"]) {
      const r = await client(a.path, ["certification-test", sub]);
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.err).toEqual([`certification-test ${sub}: not available in this build (E-050)`]);
    }
    expect((await client(a.path, ["certification-test"])).err).toEqual([
      "usage: lfcp-bridge certification-test on|off",
    ]);
    await a.end();
  });
});

describe("the thin client (A§7.3)", () => {
  it("nobody listens: it starts the app and waits for support.sock, then runs the command", async () => {
    const path = join(home, SUPPORT_SOCKET);
    let server: { close(): Promise<void> } | undefined;
    const err: string[] = [];
    const out: string[] = [];
    let launches = 0;
    const code = await supportClient({
      path,
      argv: ["status"],
      io: { out: (l) => out.push(l), err: (l) => err.push(l) },
      retryMs: 5,
      launch: async () => {
        launches++;
        // The app comes up a little later, as open -b does.
        setTimeout(() => {
          void listenSupport({
            path,
            uid: UID,
            peerUid: async () => UID,
            run: async (argv, io) => {
              io.out(`ran ${argv.join(" ")}`);
              return EXIT.NEEDS_PERSON;
            },
            log: () => {},
          }).then((s) => {
            server = s;
          });
        }, 30);
      },
    });
    expect(launches).toBe(1);
    expect(code).toBe(EXIT.NEEDS_PERSON);
    expect(out).toEqual(["ran status"]);
    expect(err).toEqual(["LFCP Bridge is not running: starting it…"]);
    await server?.close();
  });

  it("the app does not come up in time: it says so and exits NEEDS_PERSON", async () => {
    const err: string[] = [];
    const code = await supportClient({
      path: join(home, SUPPORT_SOCKET),
      argv: ["status"],
      io: { out: () => {}, err: (l) => err.push(l) },
      launch: async () => {},
      waitMs: 60,
      retryMs: 5,
    });
    expect(code).toBe(EXIT.NEEDS_PERSON);
    expect(err.at(-1)).toBe("LFCP Bridge did not answer within 0 s");
  });

  it("the app cannot be started: it says so", async () => {
    const err: string[] = [];
    const code = await supportClient({
      path: join(home, SUPPORT_SOCKET),
      argv: ["status"],
      io: { out: () => {}, err: (l) => err.push(l) },
      launch: async () => {
        throw new Error("no such app");
      },
    });
    expect(code).toBe(EXIT.NEEDS_PERSON);
    expect(err.at(-1)).toBe("could not start LFCP Bridge (is it installed in /Applications?)");
  });

  it("a refused peer's answer comes through with its exit code", async () => {
    const path = join(home, SUPPORT_SOCKET);
    const server = await listenSupport({
      path,
      uid: UID,
      peerUid: async () => UID + 1,
      run: async () => 0,
      log: () => {},
    });
    const r = await client(path, ["stop"]);
    expect(r.code).toBe(EXIT.NEEDS_PERSON);
    expect(r.err).toEqual(["refused: only the user this bridge runs as may use it"]);
    await server.close();
  });
});

describe("export (A§11, T§3 canary through run --app)", () => {
  it("support's export and the menu's export{path}: no canary in either zip", async () => {
    const CANARY = "CANARY9d1e";
    const a = await app({ up: true });
    const now = "2026-11-19T00:00:00.000Z";
    a.db
      .prepare(
        "INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES ('i', ?, 'p', 'r', ?, ?)",
      )
      .run(`/Users/${CANARY}`, CANARY, now);
    a.db
      .prepare(
        `INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, target_title, state, created_at)
         VALUES ('b1', 'i', 'r', 'apple-reminders', 'fake', ?, 'active', ?)`,
      )
      .run(`LFCP · ${CANARY}`, now);
    new Journal(a.db).append("warn", "effect.lost", {
      bindingId: "b1",
      params: { error: `Error: ${CANARY}`, cause: { message: CANARY } },
    });
    const viaSupport = join(home, "support.zip");
    const r = await client(a.path, ["export", "--out", viaSupport]);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out[0]).toContain(viaSupport);
    const viaMenu = join(home, "menu.zip");
    a.input.write(`${JSON.stringify({ v: 1, id: "e", cmd: "export", path: viaMenu })}\n`);
    for (let i = 0; i < 200 && !existsSync(viaMenu); i++)
      await new Promise((r) => setTimeout(r, 5));
    for (const zip of [viaSupport, viaMenu]) {
      const bytes = readFileSync(zip);
      expect(bytes.includes(Buffer.from("diagnostics.json"))).toBe(true);
      expect(bytes.includes(Buffer.from(CANARY))).toBe(false);
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(a.written.map((l) => JSON.parse(l)).find((e) => e.id === "e")).toMatchObject({
      type: "reply",
      ok: true,
      result: { path: viaMenu },
    });
    await a.end();
  });
});
