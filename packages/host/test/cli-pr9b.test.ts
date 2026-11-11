// The commands of PR 9b through `main` (D-010 §2.1): dry-run, approve, run (run.lock, the signal),
// sections, pair's arguments. On the harness's binding (offline SectionHost, fake transport).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationJournal, receiptOf } from "@openlfcp/client";
import { toHex } from "@openlfcp/core";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import { afterEach, describe, expect, it } from "vitest";
import { bridgePaths, loadConfig } from "../src/config.js";
import { EXIT, Holds, Journal, main, openNodeInstallation } from "../src/index.js";
import { takeRunLock } from "../src/run/cli.js";
import type { Runtime } from "../src/runtime.js";
import { type Bridge, bridge } from "./support/bridge.js";

let b: Bridge;
let home: string;
afterEach(async () => {
  await b?.close();
  rmSync(home, { recursive: true, force: true });
});

function runtime(over: Partial<Runtime> = {}): () => Promise<Runtime> {
  home = mkdtempSync(join(tmpdir(), "lfcp-cli-9b-"));
  const paths = bridgePaths({ LFCP_BRIDGE_HOME: home, LFCP_BRIDGE_LOGS: join(home, "logs") }, home);
  const config = loadConfig(paths.config);
  // The harness's host stays open across commands (dry-run stops the hosts it was given).
  const host = new Proxy(b.host, {
    get(target, key) {
      if (key === "stop") return async () => {};
      const v = Reflect.get(target, key, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const rt: Runtime = {
    paths,
    db: b.db,
    config,
    journal: new Journal(b.db),
    holds: new Holds(b.db),
    openTransport: async () => b.t as never,
    resolveSection: async () => undefined,
    launchctl: { load: () => {}, unload: () => {} } as never,
    node: "node",
    cli: "lfcp-bridge",
    openInstallations: async () => ({
      ports: [
        {
          id: "i",
          host,
          receipt: (r, op) => receiptOf(b.storage, r, op),
          access: { accessCheckedNow: () => true, offlineCommitAllowed: () => true },
          createdBy: b.root,
        },
      ],
      close: () => {},
    }),
    close: async () => {},
    ...over,
  };
  return async () => rt;
}

async function call(rt: () => Promise<Runtime>, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l), runtime: rt });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("dry-run and approve", () => {
  it("dry-run plans, records a dry run and says what it would do; approve turns it active, strict for 24 h", async () => {
    b = await bridge();
    await b.task("Buy milk");
    b.db.prepare("UPDATE bindings SET state = 'pending_dry_run'").run();
    const rt = runtime();
    const dry = await call(rt, "dry-run", "b");
    expect(dry.code).toBe(EXIT.OK);
    expect(dry.out).toContain("would: create 1 reminder(s)");
    expect(dry.out).toContain("to_apple create");
    expect(dry.out).toContain("next: lfcp-bridge approve b");
    expect(b.reminders()).toEqual([]);
    const ok = await call(rt, "approve", "b");
    expect(ok.code).toBe(EXIT.OK);
    const row = b.db
      .prepare("SELECT state, approved_plan_run_id, strict_until FROM bindings WHERE id = 'b'")
      .get() as {
      state: string;
      approved_plan_run_id: string;
      strict_until: string;
    };
    expect(row.state).toBe("active");
    expect(row.approved_plan_run_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(row.strict_until) - Date.now()).toBeGreaterThan(23 * 3600_000);
    expect((await call(rt, "approve", "b")).code).toBe(EXIT.USAGE);
  });

  it("approve refuses without a dry run within the hour, with a guard in it, or with ownership lost", async () => {
    b = await bridge();
    b.db.prepare("UPDATE bindings SET state = 'pending_dry_run'").run();
    const rt = runtime();
    expect((await call(rt, "approve", "b")).code).toBe(EXIT.NEEDS_PERSON);
    b.db
      .prepare(
        "INSERT INTO runs (id, kind, binding_id, started_at, ended_at, outcome, stats_json) VALUES ('old', 'dry', 'b', ?, ?, 'planned', '{}')",
      )
      .run(new Date(Date.now() - 2 * 3600_000).toISOString(), new Date().toISOString());
    expect((await call(rt, "approve", "b")).err).toContain("within the last hour");
    b.db
      .prepare(
        "INSERT INTO runs (id, kind, binding_id, started_at, ended_at, outcome, stats_json) VALUES ('g', 'dry', 'b', ?, ?, 'planned', ?)",
      )
      .run(
        new Date().toISOString(),
        new Date().toISOString(),
        JSON.stringify({ guards: ["guard_mass_import"] }),
      );
    expect((await call(rt, "approve", "b")).code).toBe(EXIT.STOPPED);
    new Holds(b.db).set("b", "ownership_lost");
    expect((await call(rt, "approve", "b")).err).toContain("ownership not confirmed");
  });
});

describe("run", () => {
  it("starts the process, holds run.lock, stops on the signal; a second run is refused meanwhile", async () => {
    b = await bridge();
    let stopped: string | undefined;
    let signal: (s: string) => void = () => {};
    const until = new Promise<string>((r) => {
      signal = r;
    });
    const rt = runtime({
      startProcess: async () => ({
        stop: async (why) => {
          stopped = why;
        },
      }),
    });
    const out: string[] = [];
    const running = main(["run"], { out: (l) => out.push(l), err: () => {}, runtime: rt, until });
    await new Promise((r) => setTimeout(r, 20));
    const second = await call(
      runtime({ startProcess: async () => ({ stop: async () => {} }), paths: (await rt()).paths }),
      "run",
    );
    expect(second).toMatchObject({ code: EXIT.NEEDS_PERSON });
    expect(second.err).toContain("another lfcp-bridge run is running");
    signal("SIGTERM");
    expect(await running).toBe(EXIT.OK);
    expect(stopped).toBe("SIGTERM");
    expect(out).toEqual(["lfcp-bridge run: started", "lfcp-bridge run: stopped (SIGTERM)"]);
    // The lock is gone: it can be taken again.
    const release = takeRunLock((await rt()).paths.home);
    expect(typeof release).toBe("function");
    if (typeof release === "function") release();
  });

  it("a stale run.lock (its pid gone) is taken over", () => {
    const dir = mkdtempSync(join(tmpdir(), "lfcp-lock-"));
    home = dir;
    writeFileSync(join(dir, "run.lock"), "999999999\n");
    const release = takeRunLock(dir);
    expect(typeof release).toBe("function");
    expect(takeRunLock(dir)).toEqual({ held: process.pid });
    if (typeof release === "function") release();
  });
});

describe("sections and pair", () => {
  it("sections lists each installation's paired sections and which are bound", async () => {
    b = await bridge();
    const rt = runtime();
    const dir = join((await rt()).paths.installations, "i1");
    const node = await openNodeInstallation(dir);
    const journal = new OperationJournal(node.storage);
    await journal.begin({
      id: "pairing-request.1",
      kind: "pairing-request",
      createdAt: 1,
      intent: {
        candidates: [
          {
            resource: toHex(b.R),
            url: "ws://127.0.0.1:9/v1/ws",
            profile: SECTIONS_PROFILE_ID,
            name: "Inbox",
          },
          {
            resource: "cc".repeat(32),
            url: "ws://127.0.0.1:9/v1/ws",
            profile: SECTIONS_PROFILE_ID,
            name: "Work",
          },
        ],
      },
    });
    await journal.setStatus("pairing-request.1", "done");
    node.close();
    b.db.prepare("UPDATE installations SET dir = ?, label = 'Mac'").run(dir);
    const r = await call(rt, "sections");
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain("installation i (Mac)");
    expect(r.out).toMatch(/Inbox .*bound: b active/);
    expect(r.out).toMatch(/Work .*\(not stored yet\)/);
  });

  it("pair without a label or a section is a usage error", async () => {
    b = await bridge();
    const r = await call(runtime(), "pair", "--label", "Mac");
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.err).toContain("usage: lfcp-bridge pair");
  });
});
