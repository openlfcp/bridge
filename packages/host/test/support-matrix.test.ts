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
import { principalRef, setTitle } from "@openlfcp/shared-objects";
import { afterEach, describe, expect, it } from "vitest";
import { Bootstrap } from "../src/bootstrap.js";
import { bridgePaths } from "../src/config.js";
import { Runs } from "../src/executor/safe-mode.js";
import { BridgeProcess, EXIT, Holds, Journal, main } from "../src/index.js";
import { type MigrationPorts, Migrations } from "../src/migration.js";
import { markerUrl, OwnershipGuard } from "../src/ownership.js";
import { helperReconnector } from "../src/run/machine.js";
import type { Runtime } from "../src/runtime.js";
import { HelperSupervisor } from "../src/supervisor.js";
import { type Bridge, bridge } from "./support/bridge.js";
import { type SupportHost, supportHost } from "./support/socket.js";

const INSTANCE = "1b2d3f4a-0000-4000-8000-000000000001";
const OTHER = "9f9f9f9f-0000-4000-8000-000000000009";

let b: Bridge;
let home: string | undefined;
let rt: Runtime | undefined;
let host: SupportHost | undefined;
/** The run process's server connection, as doctor's "server" check reads it. */
const server = { up: true };
let ports: MigrationPorts | undefined;
afterEach(async () => {
  if (host !== undefined) expect(host.transportsOpened()).toBe(0);
  await host?.close();
  host = undefined;
  ports = undefined;
  rt = undefined;
  server.up = true;
  await b?.close();
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

/** The test's machine (one per test): the socket's host and the commands outside it share it. */
function runtime(): Runtime {
  if (rt !== undefined) return rt;
  home = mkdtempSync(join(tmpdir(), "lfcp-matrix-"));
  const paths = bridgePaths({ LFCP_BRIDGE_HOME: home, LFCP_BRIDGE_LOGS: join(home, "logs") }, home);
  rt = {
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
          me: principalRef(b.root),
          createdBy: b.root,
        },
      ],
      close: () => {},
    }),
    close: async () => {},
  };
  return rt;
}

/** A command outside support.sock (dry-run, approve: the 0.5 CLI on the same machine). */
async function outside(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    runtime: async () => runtime(),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** Polls until `ok()` — the work goes on by itself, nobody asks for a pass. */
async function waitFor(what: string, ok: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > until) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * The host with a real run process (BridgeProcess) on the harness's binding: an approved
 * verification binding with this bridge's marker, so its effects are permitted. It looks at the
 * control state every 20 ms; the full pass every 15 min never comes in a test.
 */
async function runningHost(
  o: { onHoldsLifted?: (reasons: ReadonlySet<string>) => void } = {},
): Promise<BridgeProcess> {
  b.db.prepare("UPDATE bindings SET verification = 1, state = 'active'").run();
  ownMarker();
  const p = new BridgeProcess({
    db: b.db,
    transport: b.t,
    installations: [
      {
        id: "i",
        // lfcp_live (§5.3): the offline host never is; LFCP counts as caught up here.
        host: new Proxy(b.host, {
          get(target, key) {
            if (key === "isLive") return () => true;
            const v = Reflect.get(target, key, target);
            return typeof v === "function" ? v.bind(target) : v;
          },
        }),
        receipt: (r, op) => receiptOf(b.storage, r, op),
        access: { accessCheckedNow: () => true, offlineCommitAllowed: () => true },
        me: principalRef(b.root),
        createdBy: b.root,
      },
    ],
    instanceId: INSTANCE,
    writesVerified: () => false,
    stopped: () => false,
    timeZone: "UTC",
    debounceMs: 5,
    maxDelayMs: 20,
    controlEveryMs: 20,
    ...(o.onHoldsLifted === undefined ? {} : { onHoldsLifted: o.onHoldsLifted }),
  });
  host = await supportHost(runtime(), b.t, {
    process: async () => {
      await p.start();
      return {
        stop: (why) => p.stop(why),
        transport: p.transport,
        exclusive: (fn) => p.exclusive(fn),
        connected: () => server.up,
      };
    },
  });
  return p;
}

/** The bootstrap of this machine (bind, unbind: the host's own operations, not support.sock's). */
const bootstrap = () =>
  new Bootstrap({
    db: b.db,
    journal: new Journal(b.db),
    transport: b.t,
    instanceId: INSTANCE,
    stopped: () => false,
  });

/**
 * The plugin's Remove from Reminders as the host carries it out (A§6.3 steps 3–4: `unbind` 0.5,
 * the binding `removed`). Steps 1–2 and 5–6 (user_off, unresolved work, the plugin's revocation)
 * are E-034's; the old binding's end state is the one A§7.3 names.
 */
async function removeFromReminders(binding: string) {
  const r = await bootstrap().unbind(binding);
  expect(r.refused).toBeUndefined();
  return r;
}
const bindingState = (id: string) =>
  (b.db.prepare("SELECT state FROM bindings WHERE id = ?").get(id) as { state: string }).state;

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

  it("import_ambiguous: links → resume --accept import_ambiguous --binding <b> lifts the hold; OPEN: the next pass sets it again, the import does not go on", async () => {
    b = await bridge();
    // R2-9 (4): a pending import whose reminder vanished; a new reminder waits behind it.
    const first = b.person.create(b.list.id, "First");
    const plan = await b.pass.dryRun("b");
    if (plan.kind !== "planned") throw new Error(plan.kind);
    b.e.prepare("b", { intents: plan.plan.intents, unlinks: 0 });
    b.person.delete(first.ref);
    b.person.create(b.list.id, "Second");
    expect((await b.sync()).plan.holds).toEqual(["import_ambiguous"]);
    const tasksTitled = (t: string) => b.order().filter((id) => b.now(id).title === t);
    const p = await runningHost();
    await p.idle();
    expect(holdsOf("b")).toEqual(["import_ambiguous"]);
    expect(tasksTitled("Second")).toEqual([]);
    const links = await lfcpBridge("links", "--binding", "b");
    expect(links.code).toBe(EXIT.OK);
    const r = await lfcpBridge("resume", "--accept", "import_ambiguous", "--binding", "b");
    expect(r.out).toBe(
      "hold import_ambiguous lifted and accepted on b: the next pass goes through",
    );
    // OPEN (REPORT, escalated): A§7.3 says "hold lifted, the import goes on". In 0.5 code — kept
    // by the design (research/response-r3: the release of the pending link was dropped) — the
    // next pass finds the same vanished pending import and sets the hold again; Second waits.
    await waitFor("the next pass after the acceptance", () => holdsOf("b").length === 1);
    await p.idle();
    expect(holdsOf("b")).toEqual(["import_ambiguous"]);
    expect(tasksTitled("Second")).toEqual([]);
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

  it("bootstrap.marker.unknown: bind --retry-marker <b> refuses with the marker ids; bind --resolve-marker <b> <id> → dry-run, approve → active", async () => {
    b = await bridge();
    // The section of the harness, bound anew (the harness's own binding removed first).
    await removeFromReminders("b");
    const R = resource();
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
    const r = await boot.bind({ installationId: "i", resourceId: R, section: "Work" });
    expect(r).toMatchObject({ state: "unknown_outcome", step: "marker" });
    b.t.apply = apply;
    b.t.recover = recover;
    const id = (r as { bindingId: string }).bindingId;
    const marker = b.reminders().find((x) => x.linkUrl === markerUrl(INSTANCE, R)) as AppleItem;
    const retry = await lfcpBridge("bind", "--retry-marker", id);
    expect(retry.code).toBe(EXIT.NEEDS_PERSON);
    expect(retry.err).toContain("marker_exists");
    expect(retry.err).toContain(marker.ref.id);
    const done = await lfcpBridge("bind", "--resolve-marker", id, marker.ref.id);
    expect(done.code).toBe(EXIT.OK);
    expect(bindingState(id)).toBe("pending_dry_run");
    // Outside support.sock, on the same machine: the dry run, then the person's approval.
    const dry = await outside("dry-run", id);
    expect([dry.code, dry.err]).toEqual([EXIT.OK, ""]);
    const approved = await outside("approve", id);
    expect([approved.code, approved.err]).toEqual([EXIT.OK, ""]);
    expect(bindingState(id)).toBe("active");
    expect((await lfcpBridge("status")).out).toContain(`${id}  active  "LFCP · Work"`);
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

  it("ownership_lost: doctor names it, no other bridge → Remove from Reminders → the old binding is removed", async () => {
    b = await bridge();
    const marker = ownMarker();
    const guard = new OwnershipGuard(b.db, new Holds(b.db), new Journal(b.db), b.t, INSTANCE);
    expect((await guard.check("b", resource())).state).toBe("ok");
    b.person.delete(marker.ref);
    expect((await guard.check("b", resource())).state).toBe("lost");
    const doctor = await lfcpBridge("doctor");
    expect(doctor.code).toBe(EXIT.NEEDS_PERSON);
    expect(doctor.out).toContain("fail  binding b: this bridge's marker is gone (ownership_lost)");
    // B16: no other bridge marks the section.
    expect(doctor.out).not.toContain("another bridge");
    // Remove is the plugin's, never support.sock's.
    expect((await lfcpBridge("unbind", "b")).code).toBe(EXIT.USAGE);
    expect(bindingState("b")).toBe("active");
    const removed = await removeFromReminders("b");
    expect(removed.retired).toBe(false); // the marker is gone: nothing to retire
    expect(bindingState("b")).toBe("removed");
    expect((await lfcpBridge("status")).out).not.toContain("b  active");
    // On again: a new binding of the section. OPEN until E-034 (REPORT): its new list takes a free
    // name ("LFCP · Inbox 2", A§6.1); the 0.5 bootstrap here refuses the title still in use.
    expect(
      await bootstrap().bind({ installationId: "i", resourceId: resource(), section: "Inbox" }),
    ).toMatchObject({
      state: "refused",
      reason: "list_exists",
    });
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

  it("list_missing: doctor names the gone list → Remove from Reminders → the old binding is removed; on again: a new binding and list", async () => {
    b = await bridge();
    const old = b.list.id;
    b.person.deleteList(old as ListRef);
    const doctor = await lfcpBridge("doctor");
    expect(doctor.code).toBe(EXIT.NEEDS_PERSON);
    expect(doctor.out).toContain(`fail  binding b: its list "`);
    expect(doctor.out).toContain("is gone");
    expect((await lfcpBridge("unbind", "b")).code).toBe(EXIT.USAGE);
    expect(bindingState("b")).toBe("active");
    await removeFromReminders("b");
    expect(bindingState("b")).toBe("removed");
    // On again (B17): a new binding, a new list.
    const again = await bootstrap().bind({
      installationId: "i",
      resourceId: resource(),
      section: "Inbox",
    });
    expect(again.state).toBe("pending_dry_run");
    const id = (again as { bindingId: string }).bindingId;
    expect(id).not.toBe("b");
    const row = b.db.prepare("SELECT target_ref FROM bindings WHERE id = ?").get(id) as {
      target_ref: string;
    };
    expect(row.target_ref).not.toBe(old);
    expect((await lfcpBridge("doctor")).out).not.toContain("is gone");
  });

  it("helper_unavailable: the restart budget spent → doctor → resume --binding <b> --accept helper_unavailable; the supervisor starts the helper again and the blocked write goes", async () => {
    b = await bridge();
    const task = await b.task("Buy milk");
    await b.sync();
    // The helper as the supervisor sees it (machine.ts wires the same pieces).
    let helperUp = true;
    const helper = () => ({
      pid: undefined,
      ping: async () => {
        if (!helperUp) throw new Error("no answer");
      },
      close: async () => {},
      onExit: () => () => {},
    });
    const supervisor = new HelperSupervisor({
      pidFile: join(runtime().paths.home, "helper.pid"),
      start: async () => {
        if (!helperUp) throw new Error("the helper does not start");
        return helper();
      },
      maxRestarts: 1,
      backoffBaseMs: 0,
      sleep: async () => {},
      pingEveryMs: 3_600_000,
      onUnavailable: (reason) => {
        new Holds(b.db).set("b", "helper_unavailable", { reason });
        b.t.setStatus({ state: "unavailable", reason: "helper_crashed" });
      },
    });
    let p: BridgeProcess | undefined;
    const reconnector = helperReconnector({
      supervisor,
      reopen: async () => b.t.setStatus({ state: "ok" }),
      after: async () => p?.passAll(),
    });
    let resumes = 0;
    p = await runningHost({
      onHoldsLifted: (reasons) => {
        if (reasons.has("helper_unavailable")) {
          resumes++;
          void reconnector.resume();
        }
      },
    });
    await supervisor.start();
    await lfcpBridge("status"); // the run process is up
    // The helper dies and does not come back: the budget is spent.
    helperUp = false;
    await supervisor.pingNow();
    expect(supervisor.state).toBe("unavailable");
    expect(holdsOf("b")).toEqual(["helper_unavailable"]);
    await b.edit(setTitle(b.now(task.id), "Buy bread"));
    p.schedule("b");
    await new Promise((r) => setTimeout(r, 50));
    await p.idle();
    expect(reminders().map((r) => r.title)).toEqual(["Buy milk"]);
    expect((await lfcpBridge("doctor")).out).toContain("fail  reminders access");
    // The person fixed what kept it down (or it was transient), then:
    helperUp = true;
    const r = await lfcpBridge("resume", "--binding", "b", "--accept", "helper_unavailable");
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain("hold helper_unavailable lifted and accepted on b");
    // Nobody asks for a pass: the run process sees the lifted hold, the supervisor starts the
    // helper with a fresh budget, the transport answers again and the rename is written.
    await waitFor("the rename written", () => reminders()[0]?.title === "Buy bread");
    expect(resumes).toBe(1);
    expect(supervisor.state).toBe("running");
    expect(holdsOf("b")).toEqual([]);
    await supervisor.stop();
  });

  it("safe_mode: doctor → fix the cause → safe-mode reset; the write it blocked goes by itself at the next pass", async () => {
    b = await bridge();
    const task = await b.task("Buy milk");
    await b.sync();
    // Safe Mode, as two crashed runs within 10 minutes leave it (executor/safe-mode.ts).
    b.db
      .prepare("INSERT INTO meta (key, value) VALUES ('safe_mode', ?)")
      .run(JSON.stringify({ since: new Date().toISOString(), reason: "two crashed runs" }));
    // The cause: no server. (Only a flag: nothing it changes wakes a pass by itself.)
    server.up = false;
    const p = await runningHost();
    expect(new Runs(b.db).safeMode()).toBeDefined();
    // An edit in LFCP and its pass: Safe Mode lets no effect run.
    await b.edit(setTitle(b.now(task.id), "Buy bread"));
    p.schedule("b");
    await new Promise((r) => setTimeout(r, 50));
    await p.idle();
    expect(reminders().map((r) => r.title)).toEqual(["Buy milk"]);
    const doctor = await lfcpBridge("doctor");
    expect(doctor.out).toContain("fail  server");
    const refused = await lfcpBridge("safe-mode", "reset");
    expect(refused.code).toBe(EXIT.NEEDS_PERSON);
    expect(refused.err).toContain("safe-mode reset refused: server");
    expect(new Runs(b.db).safeMode()).toBeDefined();
    await new Promise((r) => setTimeout(r, 60));
    expect(reminders().map((r) => r.title)).toEqual(["Buy milk"]);
    // The network comes back.
    server.up = true;
    const reset = await lfcpBridge("safe-mode", "reset");
    expect(reset).toMatchObject({ code: EXIT.OK, out: "Safe Mode off: the next pass runs" });
    expect(new Runs(b.db).safeMode()).toBeUndefined();
    // Nobody asks for a pass: the run process sees the control change and writes the rename.
    await waitFor("the rename written", () => reminders()[0]?.title === "Buy bread");
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
