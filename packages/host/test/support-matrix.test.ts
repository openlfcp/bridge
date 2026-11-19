// L2: the recovery matrix of A§7.3 (shared with the runbook of E-061), one test per row, every
// command through support.sock as the bundle's lfcp-bridge runs it (test/support/socket.ts: the
// thin client, the host's queue, the run process's transport) on the harness's binding — a real
// section replica, FakeTransport, the real handler. A row's procedure steps that are a person's or
// the plugin's (delete a duplicate in Reminders, Remove from Reminders) are done on the fake.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppleItem, ListRef } from "@openlfcp/bridge-reminders";
import { receiptOf } from "@openlfcp/client";
import { setTitle } from "@openlfcp/shared-objects";
import { afterEach, describe, expect, it } from "vitest";
import { Bootstrap } from "../src/bootstrap.js";
import { bridgePaths } from "../src/config.js";
import { Runs } from "../src/executor/safe-mode.js";
import { EXIT, Holds, Journal } from "../src/index.js";
import { type MigrationPorts, Migrations } from "../src/migration.js";
import { markerUrl, OwnershipGuard } from "../src/ownership.js";
import type { Runtime } from "../src/runtime.js";
import { type Bridge, bridge } from "./support/bridge.js";
import { type SupportHost, supportHost } from "./support/socket.js";

const INSTANCE = "1b2d3f4a-0000-4000-8000-000000000001";
const OTHER = "9f9f9f9f-0000-4000-8000-000000000009";

let b: Bridge;
let home: string | undefined;
let host: SupportHost | undefined;
/** The run process's server connection, as doctor's "server" check reads it. */
const server = { up: true };
let ports: MigrationPorts | undefined;
afterEach(async () => {
  if (host !== undefined) expect(host.transportsOpened()).toBe(0);
  await host?.close();
  host = undefined;
  ports = undefined;
  server.up = true;
  await b?.close();
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

function runtime(): Runtime {
  home = mkdtempSync(join(tmpdir(), "lfcp-matrix-"));
  const paths = bridgePaths({ LFCP_BRIDGE_HOME: home, LFCP_BRIDGE_LOGS: join(home, "logs") }, home);
  return {
    paths,
    db: b.db,
    // doctor's helper: present (the data directory stands in for the app bundle).
    config: { bridgeInstanceId: INSTANCE, helperPath: home } as Runtime["config"],
    journal: new Journal(b.db),
    holds: new Holds(b.db),
    openTransport: async () => b.t as never,
    resolveSection: async () => undefined,
    launchctl: (() => {}) as never,
    node: "node",
    cli: "lfcp-bridge",
    ...(ports === undefined ? {} : { migrationPorts: async () => ports as MigrationPorts }),
    openInstallations: async () => ({
      ports: [
        {
          id: "i",
          host: b.host,
          receipt: (r, op) => receiptOf(b.storage, r, op),
          access: { accessCheckedNow: () => true, offlineCommitAllowed: () => true },
          createdBy: b.root,
        },
      ],
      close: () => {},
    }),
    close: async () => {},
  };
}

/** `lfcp-bridge <argv>` through support.sock; the host starts at the first call of a test. */
async function lfcpBridge(...argv: string[]) {
  host ??= await supportHost(runtime(), b.t, { connected: () => server.up });
  return host.call(...argv);
}

const reminders = () => b.reminders(b.list.id).filter((r) => !r.completed);
const intentState = (id: string) =>
  b.db.prepare("SELECT state, state_reason FROM intents WHERE id = ?").get(id) as {
    state: string;
    state_reason: string | null;
  };
const openConflicts = () =>
  (
    b.db.prepare("SELECT count(*) AS n FROM conflicts WHERE resolved_at IS NULL").get() as {
      n: number;
    }
  ).n;
const holdsOf = (binding: string) => new Holds(b.db).of(binding).map((h) => h.reason);
const resource = () =>
  (b.db.prepare("SELECT resource_id FROM bindings WHERE id = 'b'").get() as { resource_id: string })
    .resource_id;
/** This bridge's ownership marker in the bound list (§6.5), as a bind leaves it. */
const ownMarker = () =>
  b.person.create(b.list.id, "LFCP bridge · не удалять", {
    url: markerUrl(INSTANCE, resource()),
    completed: true,
  });

describe("A§7.3 recovery matrix through support.sock (L2)", () => {
  it("unknown_outcome (update): quarantine list → quarantine accept <intent>; the intent is done, the conflict closed", async () => {
    b = await bridge();
    const task = await b.task("Buy milk");
    await b.sync();
    b.t.faults.loseNextResponse = 1;
    await b.edit(setTitle(b.now(task.id), "Buy bread"));
    const s = await b.sync();
    await b.e.settle("b");
    const intent = (s.prepared[0] as { id: string }).id;
    expect(intentState(intent)).toEqual({ state: "quarantined", state_reason: "unknown_outcome" });
    const list = await lfcpBridge("quarantine", "list");
    expect(list.out).toContain(`${intent}  b  unknown_outcome`);
    expect(list.out).toContain(`lfcp-bridge quarantine accept ${intent}`);
    expect(list.out).toContain(`lfcp-bridge quarantine redo ${intent}`);
    expect((await lfcpBridge("quarantine", "accept", intent)).code).toBe(EXIT.OK);
    expect(openConflicts()).toBe(0);
    expect((await lfcpBridge("quarantine", "list")).out).toBe("nothing in quarantine");
    await b.sync();
    expect(reminders().map((r) => r.title)).toEqual(["Buy bread"]);
  });

  it("unknown_outcome (create): quarantine accept <intent> finds the reminder by its link → linked", async () => {
    b = await bridge();
    b.t.faults.loseNextResponse = 1;
    const task = await b.task("Call Bob");
    const s = await b.sync();
    await b.e.settle("b");
    const intent = (s.prepared[0] as { id: string }).id;
    expect(intentState(intent).state_reason).toBe("unknown_outcome");
    const r = await lfcpBridge("quarantine", "accept", intent);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain('the create happened — linked to "Call Bob"');
    await b.sync();
    expect(b.link(task.id)?.state).toBe("linked");
    expect(b.reminders().filter((x) => x.title === "Call Bob")).toHaveLength(1);
  });

  it("ambiguous_match / shared_item: list shows the candidates; one without externalId refuses the link until the person removes it; then link", async () => {
    b = await bridge();
    const task = await b.task("Buy milk");
    await b.sync();
    const original = reminders()[0] as AppleItem;
    const copy = b.person.create(b.list.id, "Buy milk (copy)", { url: original.linkUrl as string });
    await b.sync();
    expect(b.link(task.id)?.state).toBe("quarantine");
    // The copy has no stable externalId (as a reminder not yet synced to iCloud).
    const find = b.t.find.bind(b.t);
    b.t.find = async (q, sc) => {
      const r = await find(q, sc);
      return {
        ...r,
        items: r.items.map((i) =>
          i.ref.id === copy.ref.id ? { ...i, ref: { id: i.ref.id } } : i,
        ) as typeof r.items,
      };
    };
    const list = await lfcpBridge("quarantine", "list");
    expect(list.out).toContain(`lfcp-bridge quarantine link ${original.ref.id} ${task.id}`);
    expect(list.out).toContain(`lfcp-bridge quarantine ignore ${copy.ref.id} ${task.id}`);
    const refused = await lfcpBridge("quarantine", "link", original.ref.id, task.id);
    expect(refused.code).toBe(EXIT.NEEDS_PERSON);
    expect(refused.err).toContain("cannot be ignored (no external id)");
    expect(b.link(task.id)?.state).toBe("quarantine");
    // The procedure: the person deletes the duplicate in Reminders, then lists again.
    b.person.delete(copy.ref);
    expect((await lfcpBridge("quarantine", "list")).out).not.toContain(copy.ref.id);
    expect((await lfcpBridge("quarantine", "link", original.ref.id, task.id)).code).toBe(EXIT.OK);
    expect((await lfcpBridge("quarantine", "list")).out).toBe("nothing in quarantine");
    expect(b.link(task.id)?.state).toBe("linked");
  });

  it("import_ambiguous: links, then resume --accept import_ambiguous --binding <b>; the hold is lifted", async () => {
    b = await bridge();
    await b.task("Buy milk");
    await b.sync();
    new Holds(b.db).set("b", "import_ambiguous");
    const links = await lfcpBridge("links", "--binding", "b");
    expect(links.code).toBe(EXIT.OK);
    expect(links.out).toMatch(/^b {2}\S+ {2}linked {2}lfcp {2}reminder \S+ "Buy milk"$/m);
    expect((await lfcpBridge("quarantine", "list")).out).toContain(
      "→ lfcp-bridge resume --accept import_ambiguous --binding b",
    );
    const r = await lfcpBridge("resume", "--accept", "import_ambiguous", "--binding", "b");
    expect(r.out).toBe(
      "hold import_ambiguous lifted and accepted on b: the next pass goes through",
    );
    expect(holdsOf("b")).toEqual([]);
  });

  it("bootstrap.list.unknown: bind --resolve-list <b> <listId> continues the bootstrap", async () => {
    b = await bridge();
    const boot = new Bootstrap({
      db: b.db,
      journal: new Journal(b.db),
      transport: b.t,
      instanceId: INSTANCE,
      stopped: () => false,
    });
    b.t.faults.loseNextResponse = 1;
    const r = await boot.bind({ installationId: "i", resourceId: "lfcp1:work", section: "Work" });
    expect(r).toMatchObject({ state: "unknown_outcome", step: "list" });
    const id = (r as { bindingId: string }).bindingId;
    const doctor = await lfcpBridge("doctor");
    expect(doctor.out).toContain(`binding ${id}: bootstrap waits for a person: unknown list`);
    const made = [...b.store.lists.values()].find((l) => l.title === "LFCP · Work");
    const done = await lfcpBridge("bind", "--resolve-list", id, made?.id as string);
    expect(done.code).toBe(EXIT.OK);
    expect(done.out).toContain(`bound: binding ${id}, list "LFCP · Work" (${made?.id})`);
    expect(b.db.prepare("SELECT state, target_ref FROM bindings WHERE id = ?").get(id)).toEqual({
      state: "pending_dry_run",
      target_ref: made?.id,
    });
  });

  it("bootstrap.marker.unknown: bind --retry-marker <b> refuses with the marker ids; bind --resolve-marker <b> <id> binds", async () => {
    b = await bridge();
    const boot = new Bootstrap({
      db: b.db,
      journal: new Journal(b.db),
      transport: b.t,
      instanceId: INSTANCE,
      stopped: () => false,
    });
    const apply = b.t.apply.bind(b.t);
    const recover = b.t.recover.bind(b.t);
    let first = true;
    b.t.apply = async (op) => {
      if (op.kind === "marker_create" && first) {
        first = false;
        b.t.faults.loseNextResponse = 1;
      }
      return apply(op);
    };
    b.t.recover = async () => ({ state: "unknown" }) as never;
    const r = await boot.bind({ installationId: "i", resourceId: "lfcp1:work", section: "Work" });
    expect(r).toMatchObject({ state: "unknown_outcome", step: "marker" });
    b.t.apply = apply;
    b.t.recover = recover;
    const id = (r as { bindingId: string }).bindingId;
    const marker = b
      .reminders()
      .find((x) => x.linkUrl === markerUrl(INSTANCE, "lfcp1:work")) as AppleItem;
    const retry = await lfcpBridge("bind", "--retry-marker", id);
    expect(retry.code).toBe(EXIT.NEEDS_PERSON);
    expect(retry.err).toContain("marker_exists");
    expect(retry.err).toContain(marker.ref.id);
    const done = await lfcpBridge("bind", "--resolve-marker", id, marker.ref.id);
    expect(done.code).toBe(EXIT.OK);
    expect(b.db.prepare("SELECT state FROM bindings WHERE id = ?").get(id)).toEqual({
      state: "pending_dry_run",
    });
  });

  it("bind decisions: the 0.5 syntax (--binding <b>) is still accepted; binding a section is not a support command", async () => {
    b = await bridge();
    const boot = new Bootstrap({
      db: b.db,
      journal: new Journal(b.db),
      transport: b.t,
      instanceId: INSTANCE,
      stopped: () => false,
    });
    b.t.faults.loseNextResponse = 1;
    const id = (
      (await boot.bind({ installationId: "i", resourceId: "lfcp1:work", section: "Work" })) as {
        bindingId: string;
      }
    ).bindingId;
    const made = [...b.store.lists.values()].find((l) => l.title === "LFCP · Work");
    const done = await lfcpBridge("bind", "--binding", id, "--resolve-list", made?.id as string);
    expect(done.code).toBe(EXIT.OK);
    for (const argv of [
      ["bind", "Work"],
      ["bind", "--binding", id],
      ["bind", "--retry-marker"],
    ])
      expect((await lfcpBridge(...argv)).code).toBe(EXIT.USAGE);
  });

  it("ownership_lost: doctor names it; no support command clears it (Remove from Reminders in the plugin, then on again)", async () => {
    b = await bridge();
    const marker = ownMarker();
    const guard = new OwnershipGuard(b.db, new Holds(b.db), new Journal(b.db), b.t, INSTANCE);
    expect((await guard.check("b", resource())).state).toBe("ok");
    b.person.delete(marker.ref);
    expect((await guard.check("b", resource())).state).toBe("lost");
    const doctor = await lfcpBridge("doctor");
    expect(doctor.code).toBe(EXIT.NEEDS_PERSON);
    expect(doctor.out).toContain("fail  binding b: this bridge's marker is gone (ownership_lost)");
    // Remove (and unbind) is the plugin's, never support.sock's.
    expect((await lfcpBridge("unbind", "b")).code).toBe(EXIT.USAGE);
    expect(holdsOf("b")).toEqual(["ownership_lost"]);
  });

  it("foreign_bridge: doctor names the other instance; the person deletes its marker; the next check lifts the hold", async () => {
    b = await bridge();
    ownMarker();
    const foreign = b.person.create(b.list.id, "LFCP bridge · не удалять", {
      url: markerUrl(OTHER, resource()),
      completed: true,
    });
    const guard = new OwnershipGuard(b.db, new Holds(b.db), new Journal(b.db), b.t, INSTANCE);
    expect((await guard.check("b", resource())).state).toBe("foreign");
    expect(holdsOf("b")).toEqual(["foreign_bridge"]);
    const doctor = await lfcpBridge("doctor");
    expect(doctor.out).toContain(`fail  binding b: another bridge marks this section (${OTHER})`);
    b.person.delete(foreign.ref);
    // The next pass's ownership check (0.5 code) lifts it.
    expect((await guard.check("b", resource())).state).toBe("ok");
    expect(holdsOf("b")).toEqual([]);
    expect((await lfcpBridge("doctor")).out).not.toContain("another bridge");
  });

  it("migration: migrate status → migrate resume / migrate abort <id>; the migration ends aborted", async () => {
    b = await bridge();
    ports = {
      pair: async () => ({ id: "i2", dir: "/new", principal: "p2", root: "r", label: "Mac" }),
      catchUp: async (_i, rs) =>
        rs.map((r) => ({ resourceId: r, live: false, connectedAt: new Date().toISOString() })),
      closeOld: async () => {},
      revocationStatus: async () => "active",
    };
    const started = await new Migrations({
      db: b.db,
      journal: new Journal(b.db),
      ports,
    }).add("i", ["Home"]);
    expect(started.state).toBe("started");
    const id = (started as { migration: { id: string } }).migration.id;
    expect((await lfcpBridge("migrate", "status")).out).toMatch(
      new RegExp(`^${id} {2}catching_up {2}i -> i2`),
    );
    const resumed = await lfcpBridge("migrate", "resume", id);
    expect(resumed.code).toBe(EXIT.OK);
    expect(resumed.out).toContain(`lfcp-bridge migrate resume ${id}`);
    const aborted = await lfcpBridge("migrate", "abort", id);
    expect(aborted.code).toBe(EXIT.NEEDS_PERSON);
    expect(aborted.out).toMatch(new RegExp(`^${id} {2}aborted`));
    expect((await lfcpBridge("migrate", "status")).out).toMatch(new RegExp(`^${id} {2}aborted`));
  });

  it("list_missing: doctor names the gone list; no support command removes the binding (Remove in the plugin, then on again)", async () => {
    b = await bridge();
    b.person.deleteList(b.list.id as ListRef);
    const doctor = await lfcpBridge("doctor");
    expect(doctor.code).toBe(EXIT.NEEDS_PERSON);
    expect(doctor.out).toContain(`fail  binding b: its list "`);
    expect(doctor.out).toContain("is gone");
    expect((await lfcpBridge("unbind", "b")).code).toBe(EXIT.USAGE);
    expect(b.db.prepare("SELECT state FROM bindings WHERE id = 'b'").get()).toEqual({
      state: "active",
    });
  });

  it("helper_unavailable: doctor → resume --binding <b> --accept helper_unavailable; the hold is lifted", async () => {
    b = await bridge();
    new Holds(b.db).set("b", "helper_unavailable", { reason: "restart budget spent" });
    expect((await lfcpBridge("doctor")).out).toContain("ok    reminders access: full access");
    const r = await lfcpBridge("resume", "--binding", "b", "--accept", "helper_unavailable");
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain("hold helper_unavailable lifted and accepted on b");
    expect(holdsOf("b")).toEqual([]);
  });

  it("safe_mode: doctor → fix the cause → safe-mode reset; refused while a cause is active", async () => {
    b = await bridge();
    b.db
      .prepare("INSERT INTO meta (key, value) VALUES ('safe_mode', ?)")
      .run(JSON.stringify({ since: new Date().toISOString(), reason: "two crashed runs" }));
    b.t.setStatus({ state: "denied", reason: "denied" } as never);
    server.up = false;
    const doctor = await lfcpBridge("doctor");
    expect(doctor.out).toContain("fail  reminders access");
    expect(doctor.out).toContain("fail  server");
    const refused = await lfcpBridge("safe-mode", "reset");
    expect(refused.code).toBe(EXIT.NEEDS_PERSON);
    expect(refused.err).toContain("safe-mode reset refused: reminders access");
    expect(refused.err).toContain("safe-mode reset refused: server");
    expect(new Runs(b.db).safeMode()).toBeDefined();
    // The person grants access; the network comes back.
    b.t.setStatus({ state: "ok" } as never);
    server.up = true;
    const reset = await lfcpBridge("safe-mode", "reset");
    expect(reset).toMatchObject({ code: EXIT.OK, out: "Safe Mode off: the next pass runs" });
    expect(new Runs(b.db).safeMode()).toBeUndefined();
  });

  it("every command is journaled with the author support CLI", async () => {
    b = await bridge();
    await lfcpBridge("status");
    await lfcpBridge("links");
    const entries = (
      b.db
        .prepare("SELECT params_json FROM journal WHERE key = 'support.command' ORDER BY id")
        .all() as { params_json: string }[]
    ).map((r) => JSON.parse(r.params_json));
    expect(entries).toEqual([
      { command: "status", exit: EXIT.OK, author: "support CLI" },
      { command: "links", exit: EXIT.OK, author: "support CLI" },
    ]);
  });
});
