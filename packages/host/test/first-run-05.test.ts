// The first start of 0.6 over a bridge of 0.5 (PLAN §E-007, A§5.3 before the unbind): 0.5's
// LaunchAgent is booted out and removed (a fake launchctl), the same data directory, config.json
// and bridgeInstanceId are kept, bridge.sqlite is migrated by the existing migrations without
// losing a row, and run.lock keeps a second host out.

import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { retire05 } from "../src/app/legacy.js";
import { bridgePaths, LAUNCH_AGENT_LABEL } from "../src/config.js";
import {
  MIGRATIONS,
  openBridgeDatabase,
  SCHEMA_VERSION,
  schemaVersion,
} from "../src/db/database.js";
import { EXIT, main } from "../src/index.js";
import { BOOTOUT_NOT_LOADED, renderLaunchAgent, retireLaunchAgent05 } from "../src/launchd.js";
import { runLockHolder, takeRunLock } from "../src/run/lock.js";
import { machineRuntime, type Runtime } from "../src/runtime.js";

const INSTANCE = "0f5e0b1d-5a3c-4c55-9d2e-0a5b05b05b05";
const SERVICE = `gui/${process.getuid?.() ?? 501}/${LAUNCH_AGENT_LABEL}`;
const line = (o: Record<string, unknown>) => JSON.stringify({ v: 1, ...o });

let dir: string;
let children: ChildProcess[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lfcp-05-"));
});
afterEach(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  children = [];
  rmSync(dir, { recursive: true, force: true });
});

/** A `lfcp-bridge run` of 0.5: a live process whose pid is in run.lock. */
function run05(home: string): ChildProcess {
  const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(c);
  writeFileSync(join(home, "run.lock"), `${c.pid}\n`);
  return c;
}

/** launchctl as launchd answers it: bootout stops the agent's process. */
function fakeLaunchctl(agent?: ChildProcess) {
  const calls: string[][] = [];
  return {
    calls,
    ctl: (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "bootout") agent?.kill("SIGTERM");
    },
  };
}

/**
 * The data directory of a 0.5 bridge, as `service install` and `run` left it: config.json with its
 * bridgeInstanceId, bridge.sqlite at `version` with an installation, a binding and its state, an
 * installation's directory, the LaunchAgent's plist.
 */
function fixture05(version: number) {
  const paths = bridgePaths(
    { LFCP_BRIDGE_HOME: join(dir, "Application Support", "org.openlfcp.bridge") },
    join(dir, "user"),
  );
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const config = `${JSON.stringify(
    {
      bridgeInstanceId: INSTANCE,
      writesVerified: { helperVersion: "0.5.0", macOS: "15.4", at: "2026-10-01T00:00:00.000Z" },
    },
    null,
    2,
  )}\n`;
  writeFileSync(paths.config, config, { mode: 0o600 });
  const db = openBridgeDatabase(paths.database, { migrations: MIGRATIONS.slice(0, version) });
  db.prepare(
    "INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("inst-1", join(paths.installations, "inst-1"), "p1", "r1", "Mac", "2026-10-01T00:00:00Z");
  db.prepare(
    `INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, target_ref,
       target_title, state, bootstrap_step, created_at)
     VALUES ('b-1', 'inst-1', 'res-1', 'reminders', 'eventkit', 'list-1', 'Groceries', 'active', 'done', '2026-10-01T00:00:00Z')`,
  ).run();
  db.prepare(
    "INSERT INTO binding_holds (binding_id, reason, since) VALUES ('b-1', 'helper_stall', '2026-10-02T00:00:00Z')",
  ).run();
  db.prepare(
    "INSERT INTO transport_state (transport, installation_key, key, value_json) VALUES ('eventkit', ?, 'cursor', '\"c-42\"')",
  ).run(INSTANCE);
  db.close();
  mkdirSync(join(paths.installations, "inst-1"), { recursive: true });
  writeFileSync(join(paths.installations, "inst-1", "state.bin"), "0.5 installation");
  mkdirSync(join(dir, "user", "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(
    paths.launchAgent,
    renderLaunchAgent({
      node: "/opt/homebrew/bin/node",
      cli: "/opt/homebrew/lib/node_modules/@openlfcp/bridge/dist/cli.js",
      home: paths.home,
      logs: paths.logs,
    }),
  );
  return { paths, config };
}

/** An error of launchctl as execFileSync throws it: its exit status. */
const exited = (status: number) =>
  Object.assign(new Error(`Command failed: launchctl bootout (${status})`), { status });

/** `run --app` through main over the machine's runtime of `paths`, with a run process that idles. */
function startApp(
  paths: ReturnType<typeof bridgePaths>,
  ctl: (args: readonly string[]) => void,
  o: { readonly waitMs?: number } = {},
) {
  let runtimes = 0;
  const input = new PassThrough();
  const out: string[] = [];
  const err: string[] = [];
  const env = { LFCP_BRIDGE_HOME: paths.home, LFCP_BRIDGE_LOGS: paths.logs };
  const done = main(["run", "--app"], {
    out: (l) => err.push(l),
    err: (l) => err.push(l),
    runtime: async (): Promise<Runtime> => ({
      ...(await (runtimes++, machineRuntime(env))),
      startProcess: async () => ({ stop: async () => {} }),
    }),
    app: { input, write: (l) => out.push(l) },
    launchAgent05: {
      path: paths.launchAgent,
      home: paths.home,
      launchctl: ctl,
      waitMs: o.waitMs ?? 5_000,
    },
  });
  const events = () => out.map((l) => JSON.parse(l) as Record<string, unknown>);
  const running = async () => {
    for (let i = 0; i < 500 && !events().some((e) => e.state === "running"); i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(
      events().some((e) => e.state === "running"),
      err.join("\n"),
    ).toBe(true);
  };
  const shutdown = () => input.write(`${line({ id: "s", cmd: "shutdown", reason: "quit" })}\n`);
  return { done, events, err, running, shutdown, runtimes: () => runtimes };
}

describe("retireLaunchAgent05", () => {
  it("boots out 0.5's agent by its label and removes the plist; says which data directory it used", () => {
    const path = join(dir, "org.openlfcp.bridge.plist");
    writeFileSync(
      path,
      renderLaunchAgent({ node: "/n", cli: "/c", home: "/data & more", logs: "/l" }),
    );
    const { calls, ctl } = fakeLaunchctl();
    expect(retireLaunchAgent05(path, ctl)).toEqual({
      state: "removed",
      home: "/data & more",
    });
    expect(calls).toEqual([["bootout", SERVICE]]);
    expect(existsSync(path)).toBe(false);
  });

  it("without a plist calls no launchctl", () => {
    const { calls, ctl } = fakeLaunchctl();
    expect(retireLaunchAgent05(join(dir, "none.plist"), ctl)).toEqual({ state: "none" });
    expect(calls).toEqual([]);
  });

  for (const status of BOOTOUT_NOT_LOADED)
    it(`a bootout that says the job is not loaded (status ${status}) still removes the plist`, () => {
      const path = join(dir, "org.openlfcp.bridge.plist");
      writeFileSync(path, "not a plist");
      const r = retireLaunchAgent05(path, () => {
        throw exited(status);
      });
      expect(r).toEqual({ state: "removed", home: undefined });
      expect(existsSync(path)).toBe(false);
    });

  it("any other bootout failure keeps the plist; the next try boots it out", () => {
    const home = join(dir, "home");
    mkdirSync(home);
    const agent = run05(home);
    const path = join(dir, "org.openlfcp.bridge.plist");
    writeFileSync(path, renderLaunchAgent({ node: "/n", cli: "/c", home, logs: "/l" }));
    for (const e of [exited(5), exited(36), Object.assign(new Error("spawn"), { code: "ENOENT" })])
      expect(
        retireLaunchAgent05(path, () => {
          throw e;
        }),
      ).toEqual({ state: "failed", detail: "status" in e ? `status ${e.status}` : "ENOENT" });
    expect(existsSync(path)).toBe(true);
    expect(runLockHolder(home)).toBe(agent.pid);
    const { calls, ctl } = fakeLaunchctl(agent);
    expect(retireLaunchAgent05(path, ctl)).toEqual({ state: "removed", home });
    expect(calls).toEqual([["bootout", SERVICE]]);
    expect(existsSync(path)).toBe(false);
  });
});

describe("retire05", () => {
  it("waits until 0.5's run, stopped by the bootout, lets go of run.lock", async () => {
    const home = join(dir, "home");
    mkdirSync(home);
    const agent = run05(home);
    const path = join(dir, "org.openlfcp.bridge.plist");
    writeFileSync(path, renderLaunchAgent({ node: "/n", cli: "/c", home, logs: "/l" }));
    expect(runLockHolder(home)).toBe(agent.pid);
    const { calls, ctl } = fakeLaunchctl(agent);
    expect(await retire05({ launchAgent: path, home, launchctl: ctl, pollMs: 10 })).toEqual({
      state: "removed",
      home,
    });
    expect(calls).toEqual([["bootout", SERVICE]]);
    expect(runLockHolder(home)).toBeUndefined();
    expect(typeof takeRunLock(home)).toBe("function");
  });

  it("gives up after its wait when run.lock stays held", async () => {
    const home = join(dir, "home");
    mkdirSync(home);
    const other = run05(home);
    const path = join(dir, "org.openlfcp.bridge.plist");
    writeFileSync(path, "x");
    const t0 = Date.now();
    await retire05({ launchAgent: path, home, launchctl: () => {}, waitMs: 100, pollMs: 10 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    expect(runLockHolder(home)).toBe(other.pid);
  });
});

describe("the first run --app over a bridge of 0.5 (L2)", () => {
  for (const version of [2, SCHEMA_VERSION]) {
    it(`schema ${version}: agent removed, same directory and bridgeInstanceId, migrations applied, no row lost`, async () => {
      const { paths, config } = fixture05(version);
      const agent = run05(paths.home);
      const { calls, ctl } = fakeLaunchctl(agent);
      const app = startApp(paths, ctl);
      await app.running();
      // 0.5's agent is gone, and the host serves from 0.5's directory.
      expect(calls).toEqual([["bootout", SERVICE]]);
      expect(existsSync(paths.launchAgent)).toBe(false);
      expect(agent.exitCode !== null || agent.signalCode !== null).toBe(true);
      expect(readFileSync(join(paths.home, "run.lock"), "utf8").trim()).toBe(String(process.pid));
      expect(app.events().find((e) => e.state === "running")).toMatchObject({
        sections: [{ bindingId: "b-1", title: "Groceries", state: "active" }],
      });
      app.shutdown();
      expect(await app.done).toBe(EXIT.OK);
      expect(app.err.join("\n")).toContain("the LaunchAgent of lfcp-bridge 0.5 was removed");

      // config.json (bridgeInstanceId, writesVerified) untouched, byte for byte.
      expect(readFileSync(paths.config, "utf8")).toBe(config);
      expect(readFileSync(join(paths.installations, "inst-1", "state.bin"), "utf8")).toBe(
        "0.5 installation",
      );
      const db = openBridgeDatabase(paths.database, { migrate: false });
      try {
        expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
        expect(db.prepare("SELECT id, state, target_title FROM bindings").all()).toEqual([
          { id: "b-1", state: "active", target_title: "Groceries" },
        ]);
        expect(db.prepare("SELECT id, status FROM installations").all()).toEqual([
          { id: "inst-1", status: "active" },
        ]);
        expect(db.prepare("SELECT binding_id, reason FROM binding_holds").all()).toEqual([
          { binding_id: "b-1", reason: "helper_stall" },
        ]);
        expect(
          db.prepare("SELECT installation_key, key, value_json FROM transport_state").all(),
        ).toEqual([{ installation_key: INSTANCE, key: "cursor", value_json: '"c-42"' }]);
        expect(
          db
            .prepare("SELECT level, params_json FROM journal WHERE key = ?")
            .all("bridge.launch_agent_05_removed"),
        ).toEqual([{ level: "info", params_json: '{"sameHome":true}' }]);
      } finally {
        db.close();
      }

      // The next start finds nothing of 0.5 to retire.
      const again = startApp(paths, ctl);
      await again.running();
      again.shutdown();
      expect(await again.done).toBe(EXIT.OK);
      expect(calls).toHaveLength(1);
      expect(again.err.join("\n")).not.toContain("LaunchAgent");
    }, 20_000);
  }

  it("an agent of 0.5 with another data directory: removed, a warning, that directory untouched", async () => {
    const { paths } = fixture05(SCHEMA_VERSION);
    const elsewhere = join(dir, "elsewhere");
    writeFileSync(
      paths.launchAgent,
      renderLaunchAgent({ node: "/n", cli: "/c", home: elsewhere, logs: "/l" }),
    );
    const app = startApp(paths, () => {});
    await app.running();
    app.shutdown();
    expect(await app.done).toBe(EXIT.OK);
    expect(existsSync(paths.launchAgent)).toBe(false);
    expect(existsSync(elsewhere)).toBe(false);
    expect(app.err.join("\n")).toContain("it used another data directory");
    const db = openBridgeDatabase(paths.database, { migrate: false });
    try {
      expect(
        db.prepare("SELECT level FROM journal WHERE key = 'bridge.launch_agent_05_removed'").all(),
      ).toEqual([{ level: "warn" }]);
    } finally {
      db.close();
    }
  }, 20_000);
});

describe("run.lock keeps a second host out (L2)", () => {
  it("a second run --app over the same directory exits without opening bridge.sqlite; the first goes on", async () => {
    const { paths } = fixture05(SCHEMA_VERSION);
    const first = startApp(paths, () => {});
    await first.running();
    const second = startApp(paths, () => {});
    expect(await second.done).toBe(EXIT.NEEDS_PERSON);
    expect(second.runtimes()).toBe(0);
    expect(second.events()).toEqual([]);
    expect(second.err.join("\n")).toContain(
      `another lfcp-bridge run is running (pid ${process.pid})`,
    );
    // The first still holds the lock and answers.
    expect(runLockHolder(paths.home)).toBe(process.pid);
    first.shutdown();
    expect(await first.done).toBe(EXIT.OK);
    expect(runLockHolder(paths.home)).toBeUndefined();
  }, 20_000);
});

describe("run --app never touches bridge.sqlite under another run (L2)", () => {
  const schemaOf = (path: string) => {
    const db = openBridgeDatabase(path, { migrate: false });
    try {
      return schemaVersion(db);
    } finally {
      db.close();
    }
  };

  it("0.5's run outlives the wait: exit NEEDS_PERSON, no runtime, schema unchanged; the next start migrates", async () => {
    const { paths } = fixture05(2);
    const agent = run05(paths.home);
    // launchd unloads the job, but its process has not exited yet when the wait ends.
    const late = startApp(paths, () => {}, { waitMs: 50 });
    expect(await late.done).toBe(EXIT.NEEDS_PERSON);
    expect(late.runtimes()).toBe(0);
    expect(late.events()).toEqual([]);
    expect(late.err.join("\n")).toContain(`another lfcp-bridge run is running (pid ${agent.pid})`);
    expect(schemaOf(paths.database)).toBe(2);
    expect(runLockHolder(paths.home)).toBe(agent.pid);

    agent.kill("SIGTERM");
    for (let i = 0; i < 200 && runLockHolder(paths.home) !== undefined; i++)
      await new Promise((r) => setTimeout(r, 10));
    const next = startApp(paths, () => {});
    await next.running();
    next.shutdown();
    expect(await next.done).toBe(EXIT.OK);
    expect(schemaOf(paths.database)).toBe(SCHEMA_VERSION);
  }, 20_000);

  it("a bootout that fails with the job alive: not started, plist kept, schema unchanged; the next start retires it", async () => {
    const { paths } = fixture05(2);
    const agent = run05(paths.home);
    const failing = startApp(paths, () => {
      throw exited(5);
    });
    expect(await failing.done).toBe(EXIT.NEEDS_PERSON);
    expect(failing.runtimes()).toBe(0);
    expect(failing.events()).toEqual([]);
    expect(failing.err.join("\n")).toContain("could not be booted out (status 5)");
    expect(failing.err.join("\n")).not.toContain("was removed");
    expect(existsSync(paths.launchAgent)).toBe(true);
    expect(schemaOf(paths.database)).toBe(2);
    expect(runLockHolder(paths.home)).toBe(agent.pid);

    const { calls, ctl } = fakeLaunchctl(agent);
    const next = startApp(paths, ctl);
    await next.running();
    next.shutdown();
    expect(await next.done).toBe(EXIT.OK);
    expect(calls).toEqual([["bootout", SERVICE]]);
    expect(existsSync(paths.launchAgent)).toBe(false);
    expect(schemaOf(paths.database)).toBe(SCHEMA_VERSION);
    expect(next.err.join("\n")).toContain("the LaunchAgent of lfcp-bridge 0.5 was removed");
  }, 20_000);
});

describe("the data directory of a first run --app (L2)", () => {
  it("is created 0700 under umask 022, by run.lock before the runtime", async () => {
    const paths = bridgePaths(
      {
        LFCP_BRIDGE_HOME: join(
          dir,
          "user",
          "Library",
          "Application Support",
          "org.openlfcp.bridge",
        ),
      },
      join(dir, "user"),
    );
    expect(existsSync(paths.home)).toBe(false);
    const umask = process.umask(0o022);
    try {
      const app = startApp(paths, () => {});
      await app.running();
      app.shutdown();
      expect(await app.done).toBe(EXIT.OK);
    } finally {
      process.umask(umask);
    }
    expect(statSync(paths.home).mode & 0o777).toBe(0o700);
  }, 20_000);
});
