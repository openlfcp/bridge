// bridge.sqlite (D-010 §3): migrations up from nothing and from the previous
// version, down, a failing migration, a newer schema; the constraints of the
// schema; holds as a set; the journal; STOP.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BridgeDatabase,
  Holds,
  Journal,
  MIGRATIONS,
  type Migration,
  migrateTo,
  openBridgeDatabase,
  resume,
  SCHEMA_VERSION,
  SchemaTooNewError,
  schemaVersion,
  stop,
  stopState,
} from "../src/index.js";

let dir: string;
const open: BridgeDatabase[] = [];
const db = (options?: Parameters<typeof openBridgeDatabase>[1], name = "bridge.sqlite") => {
  const d = openBridgeDatabase(join(dir, name), options);
  open.push(d);
  return d;
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lfcp-bridge-db-"));
});
afterEach(() => {
  for (const d of open.splice(0)) if (d.open) d.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The schema objects, without SQLite's own (sqlite_sequence, autoindexes). */
const schema = (d: BridgeDatabase) =>
  (
    d
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as { type: string; name: string; sql: string }[]
  ).map((r) => `${r.type} ${r.name}: ${r.sql.replace(/\s+/g, " ")}`);
const tables = (d: BridgeDatabase) =>
  (
    d
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);

const V1_TABLES = ["binding_holds", "bindings", "installations", "journal", "meta", "runs"];
const V2_TABLES = [
  "apple_personal",
  "bases",
  "bootstrap_ops",
  "conflicts",
  "intents",
  "links",
  "migrations",
  "transport_state",
];

const now = "2026-11-10T00:00:00.000Z";
function seedV1(d: BridgeDatabase) {
  d.prepare(
    "INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES ('i1', 'installations/i1', 'p', 'r', 'Reminders bridge', ?)",
  ).run(now);
  d.prepare(
    "INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, state, created_at) VALUES ('b1', 'i1', 'R1', 'apple-reminders', 'eventkit', 'bootstrapping', ?)",
  ).run(now);
  new Holds(d).set("b1", "ownership_lost", { why: "no marker" });
  new Journal(d).append("info", "binding.created", "Inbox bound", { bindingId: "b1" });
  d.prepare("INSERT INTO meta (key, value) VALUES ('bridge_instance', 'abc')").run();
}

describe("bridge.sqlite migrations", () => {
  it("up from nothing: every table of §3, at SCHEMA_VERSION, WAL, FULL sync, foreign keys", () => {
    const d = db();
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length);
    expect(schemaVersion(d)).toBe(SCHEMA_VERSION);
    expect(tables(d)).toEqual([...V1_TABLES, ...V2_TABLES].sort());
    expect(d.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(d.pragma("synchronous", { simple: true })).toBe(2);
    expect(d.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("up from every earlier version keeps the data and ends in the schema of a fresh database", () => {
    const fresh = schema(db({}, "fresh.sqlite"));
    for (let from = 0; from < SCHEMA_VERSION; from++) {
      const name = `from-${from}.sqlite`;
      const old = db({ migrate: false }, name);
      migrateTo(old, from);
      if (from >= 1) seedV1(old);
      old.close();
      const d = db({}, name);
      expect([from, schemaVersion(d)]).toEqual([from, SCHEMA_VERSION]);
      expect(schema(d)).toEqual(fresh);
      if (from >= 1) {
        expect(new Holds(d).of("b1").map((h) => h.reason)).toEqual(["ownership_lost"]);
        expect(new Journal(d).list().map((e) => e.kind)).toEqual(["binding.created"]);
      }
    }
  });

  it("down to the previous version keeps its data; down to 0 empties; up again is the same schema", () => {
    const d = db();
    const latest = schema(d);
    seedV1(d);
    expect(migrateTo(d, 1)).toEqual([1]);
    expect(tables(d)).toEqual(V1_TABLES);
    expect(new Holds(d).of("b1")).toHaveLength(1);
    expect(migrateTo(d, 0)).toEqual([0]);
    expect(tables(d)).toEqual([]);
    expect(migrateTo(d, SCHEMA_VERSION)).toEqual([1, 2]);
    expect(schema(d)).toEqual(latest);
  });

  it("every down drops exactly what its up created", () => {
    const d = db({ migrate: false });
    for (const m of MIGRATIONS) {
      const before = schema(d);
      migrateTo(d, m.version);
      migrateTo(d, m.version - 1);
      expect([m.name, schema(d)]).toEqual([m.name, before]);
      migrateTo(d, m.version);
    }
  });

  it("a failing migration leaves the last complete version, nothing of itself", () => {
    const bad: Migration = {
      version: 3,
      name: "broken",
      up: ["CREATE TABLE half_done (a TEXT) STRICT", "THIS IS NOT SQL"],
      down: ["DROP TABLE half_done"],
    };
    db();
    open.pop()?.close();
    expect(() => db({ migrations: [...MIGRATIONS, bad] })).toThrow();
    const d = db();
    expect(schemaVersion(d)).toBe(SCHEMA_VERSION);
    expect(tables(d)).not.toContain("half_done");
  });

  it("refuses a database of a newer bridge without touching it", () => {
    const d = db();
    d.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    d.close();
    expect(() => db()).toThrow(SchemaTooNewError);
    const raw = db({ migrate: false, migrations: [] }, "other.sqlite");
    expect(schemaVersion(raw)).toBe(0);
    expect(() => migrateTo(raw, 5)).toThrow(RangeError);
  });
});

describe("the schema's rules (§3)", () => {
  const binding = (
    d: BridgeDatabase,
    id: string,
    resource: string,
    list: string,
    state = "active",
  ) =>
    d
      .prepare(
        "INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, target_ref, state, created_at) VALUES (?, 'i1', ?, 'apple-reminders', 'eventkit', ?, ?, ?)",
      )
      .run(id, resource, list, state, now);

  it("one live binding per section and per list; a removed one does not count", () => {
    const d = db();
    seedV1(d);
    d.prepare("DELETE FROM binding_holds").run();
    d.prepare("DELETE FROM bindings").run();
    binding(d, "b1", "R1", "L1");
    expect(() => binding(d, "b2", "R1", "L2")).toThrow(/UNIQUE/);
    expect(() => binding(d, "b3", "R2", "L1")).toThrow(/UNIQUE/);
    d.prepare("UPDATE bindings SET state = 'removed' WHERE id = 'b1'").run();
    binding(d, "b4", "R1", "L1");
  });

  it("one open intent per (binding, Task, direction); states and directions are checked", () => {
    const d = db();
    seedV1(d);
    const intent = (id: string, state: string, direction = "to_apple") =>
      d
        .prepare(
          "INSERT INTO intents (id, binding_id, task_id, installation_id, direction, kind, fields_json, basis_json, payload_json, operation_id, state, created_at) VALUES (?, 'b1', 'T1', 'i1', ?, 'update', '[]', '{}', '{}', ?, ?, ?)",
        )
        .run(id, direction, `brg1:${id}`, state, now);
    intent("a", "prepared");
    expect(() => intent("b", "effecting")).toThrow(/UNIQUE/);
    intent("c", "prepared", "to_lfcp");
    intent("d", "finalized");
    expect(() => intent("e", "lost")).toThrow(/CHECK/);
    expect(() => intent("f", "finalized", "sideways")).toThrow(/CHECK/);
  });

  it("a binding needs its installation (foreign keys are on)", () => {
    const d = db();
    expect(() =>
      d
        .prepare(
          "INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, state, created_at) VALUES ('b', 'nobody', 'R', 'apple-reminders', 'fake', 'active', ?)",
        )
        .run(now),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe("holds", () => {
  it("are a set per binding: setting again keeps since, lifting is per reason", () => {
    const d = db();
    seedV1(d);
    let t = Date.parse("2026-11-10T10:00:00Z");
    const holds = new Holds(d, () => t);
    expect(holds.set("b1", "foreign_bridge")).toBe(true);
    t += 60_000;
    expect(holds.set("b1", "foreign_bridge", { marker: "x" })).toBe(false);
    expect(holds.of("b1").find((h) => h.reason === "foreign_bridge")).toEqual({
      reason: "foreign_bridge",
      since: "2026-11-10T10:00:00.000Z",
      detail: { marker: "x" },
    });
    expect(holds.of("b1").map((h) => h.reason)).toEqual(["foreign_bridge", "ownership_lost"]);
    expect(holds.blocked("b1")).toBe(true);
    expect(holds.blocked("b1", ["foreign_bridge", "ownership_lost"])).toBe(false);
    expect(holds.lift("b1", "foreign_bridge")).toBe(true);
    expect(holds.lift("b1", "foreign_bridge")).toBe(false);
    expect(holds.has("b1", "ownership_lost")).toBe(true);
    expect(() => holds.set("b1", "whatever" as never)).toThrow(RangeError);
  });
});

describe("the journal", () => {
  it("appends in order; filters by binding, level and position; the newest page, oldest first", () => {
    const d = db();
    seedV1(d);
    const j = new Journal(d, () => Date.parse("2026-11-10T11:00:00Z"), "run-1");
    const a = j.append("debug", "pass.start", "pass started");
    j.append("warn", "alarm.old_day", "a reminder kept its alarm on the old day", {
      bindingId: "b1",
      data: { task: "T1" },
    });
    j.append("error", "transport.down", "the helper stopped");
    expect(j.list().map((e) => e.kind)).toEqual([
      "binding.created",
      "pass.start",
      "alarm.old_day",
      "transport.down",
    ]);
    expect(j.list({ bindingId: "b1" }).map((e) => e.kind)).toEqual([
      "binding.created",
      "alarm.old_day",
    ]);
    expect(j.list({ minLevel: "warn" }).map((e) => e.level)).toEqual(["warn", "error"]);
    expect(j.list({ afterId: a }).map((e) => e.kind)).toEqual(["alarm.old_day", "transport.down"]);
    expect(j.list({ limit: 2 }).map((e) => e.kind)).toEqual(["alarm.old_day", "transport.down"]);
    expect(j.list({ minLevel: "warn" })[0]).toMatchObject({
      at: "2026-11-10T11:00:00.000Z",
      runId: "run-1",
      bindingId: "b1",
      data: { task: "T1" },
    });
    expect(() => j.append("loud" as never, "x", "y")).toThrow(RangeError);
  });
});

describe("STOP", () => {
  it("is a file: set with a reason, read, removed; a hand-made or empty file is STOP too", () => {
    expect(stopState(dir)).toBeUndefined();
    expect(resume(dir)).toBe(false);
    const s = stop(dir, "guard_count_drop on Inbox", () => Date.parse("2026-11-10T12:00:00Z"));
    expect(stopState(dir)).toEqual(s);
    expect(JSON.parse(readFileSync(join(dir, "STOP"), "utf8"))).toEqual({
      at: "2026-11-10T12:00:00.000Z",
      reason: "guard_count_drop on Inbox",
    });
    expect(resume(dir)).toBe(true);
    expect(existsSync(join(dir, "STOP"))).toBe(false);
    writeFileSync(join(dir, "STOP"), "");
    expect(stopState(dir)).toEqual({});
    writeFileSync(join(dir, "STOP"), "going on holiday\n");
    expect(stopState(dir)).toEqual({ reason: "going on holiday" });
  });

  it("fails closed: a STOP that cannot be read still stops", () => {
    // A directory named STOP cannot be read as a file.
    mkdirSync(join(dir, "STOP"));
    expect(stopState(dir)?.reason).toMatch(/unreadable/);
  });
});
