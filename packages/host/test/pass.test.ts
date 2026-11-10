// The dry-run pass (D-010 §5.5, §11 PR 8) on a real section replica (an
// offline SectionHost) and the fake transport, and the G4 fallback.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ListInfo, type ListRef, localDate } from "@openlfcp/bridge-reminders";
import { taskLink } from "@openlfcp/bridge-reminders/adapter";
import { FakePerson, FakeStore, FakeTransport } from "@openlfcp/bridge-reminders/fake";
import { OperationJournal } from "@openlfcp/client";
import { generateObjectId, type PrincipalId, toHex } from "@openlfcp/core";
import { createTask, principalRef } from "@openlfcp/shared-objects";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BridgeDatabase,
  bridgeInstanceId,
  deviceRoot,
  Executor,
  type Intent,
  openBridgeDatabase,
  Pass,
  SectionHost,
  transportStateKV,
} from "../src/index.js";
import { installation, memory, offline, ownedSection } from "./support/lfcp.js";

let dir: string;
let db: BridgeDatabase;
let store: FakeStore;
let list: ListInfo;
let host: SectionHost;

const me = installation();
const root = me.signer.descriptor.principalId;
const ME = principalRef(root);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "lfcp-bridge-pass-"));
  db = openBridgeDatabase(join(dir, "bridge.sqlite"));
  store = new FakeStore();
  store.today = () => localDate("2026-11-10");
  list = new FakePerson(store).createList("LFCP · Inbox");
});
afterEach(async () => {
  await host?.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A section with `titles` as Tasks (assigned to me unless "!" first), a binding of it to the list. */
async function setup(titles: readonly string[], state = "pending_dry_run") {
  const m = memory();
  const URL = "ws://127.0.0.1:9/v1/ws";
  const { R } = await ownedSection(me, m.storage, m.secrets, URL);
  host = new SectionHost({ url: URL, installation: me, ...m, webSocket: offline });
  await host.open(R);
  const S = generateObjectId();
  const tasks = titles.map(
    (t) =>
      createTask({
        title: t.replace(/^!/, ""),
        createdBy: root,
        ...(t.startsWith("!") ? {} : { assignees: [root] }),
      }).task,
  );
  await host.commitGuarded({
    resource: R,
    intents: [
      { intent: "section.create", sectionId: S, title: "Inbox", createdBy: root },
      ...tasks.map((task, k) => ({
        intent: "task.create_in_section" as const,
        task,
        parent: S,
        after: k === 0 ? null : (tasks[k - 1]?.id ?? null),
      })),
    ],
    operationId: "setup",
    check: () => true,
  });
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES ('i', 'd', 'p', 'r', 'l', ?)",
  ).run(now);
  db.prepare(
    `INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, target_ref, state, created_at)
     VALUES ('b', 'i', ?, 'apple-reminders', 'fake', ?, ?, ?)`,
  ).run(toHex(R), list.id, state, now);
  const t = new FakeTransport(store);
  await t.open({
    installationKey: "i",
    state: transportStateKV(db, "fake", "i"),
    scope: { listTitlePrefixes: ["LFCP · "], listIds: [list.id as ListRef] },
  });
  /** null: the person's root is not known. */
  const pass = (who: string | null = ME) =>
    new Pass({ db, transport: t, lfcp: host, me: async () => who ?? undefined, timeZone: "UTC" });
  return { R, tasks, t, pass };
}

const count = (table: string) =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const snapshotOf = () => JSON.stringify([...store.items.values()]);

describe("dry-run (§5.5, PR 8: dry-run only)", () => {
  it("plans from both sides and stores the plan as a dry run; nothing else changes", async () => {
    const s = await setup(["Buy milk", "!Someone else's"]);
    const before = snapshotOf();
    const r = await s.pass().dryRun("b");
    if (r.kind !== "planned") throw new Error(r.kind);
    expect(r.plan.intents.map((i) => [i.kind, i.taskId])).toEqual([["create", s.tasks[0]?.id]]);
    expect(r.plan.counts).toMatchObject({ tasks: 2, inFilter: 1, creates: 1, reminders: 0 });
    expect(r.guards).toEqual([]);
    const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(r.runId) as {
      kind: string;
      binding_id: string;
      outcome: string;
      plan_json: string;
      ended_at: string | null;
    };
    expect(run).toMatchObject({ kind: "dry", binding_id: "b", outcome: "planned" });
    expect(run.ended_at).not.toBeNull();
    expect(JSON.parse(run.plan_json)).toEqual(JSON.parse(JSON.stringify(r.plan)));
    // Nothing prepared, linked, conflicted or held; Apple untouched; the binding still waits for approve.
    for (const table of ["intents", "links", "bases", "conflicts", "binding_holds"])
      expect(count(table)).toBe(0);
    expect(snapshotOf()).toBe(before);
    expect(db.prepare("SELECT state FROM bindings WHERE id = 'b'").get()).toEqual({
      state: "pending_dry_run",
    });
  });

  it("apply is not in this build: dry_run_only, nothing run", async () => {
    const s = await setup(["Buy milk"], "active");
    expect(await s.pass().apply("b")).toEqual({ kind: "refused", reason: "dry_run_only" });
    expect(count("runs")).toBe(0);
    expect(count("intents")).toBe(0);
  });

  it("the guards a pass would trip are shown, none set (§7.2)", async () => {
    const s = await setup(["Buy milk"]);
    const person = new FakePerson(store);
    for (let k = 0; k < 11; k++) person.create(list.id as ListRef, `New ${k}`);
    const r = await s.pass().dryRun("b");
    if (r.kind !== "planned") throw new Error(r.kind);
    expect(r.plan.counts.imports).toBe(11);
    expect(r.guards).toEqual(["guard_mass_import"]);
    expect(count("binding_holds")).toBe(0);
  });

  it("a count drop against the last pass is shown (guard_count_drop), none set", async () => {
    const s = await setup(["T0", "T1", "T2", "T3", "T4", "T5"]);
    const person = new FakePerson(store);
    const now = new Date().toISOString();
    const made = Array.from({ length: 6 }, (_, k) => {
      const task = (s.tasks[k] as { id: string }).id;
      const it = person.create(list.id as ListRef, `R${k}`, {
        url: taskLink(task, toHex(s.R), bridgeInstanceId(db)),
      });
      db.prepare(
        "INSERT INTO links (binding_id, task_id, origin, state, created_at, updated_at) VALUES ('b', ?, 'lfcp', 'linked', ?, ?)",
      ).run(task, now, now);
      return it;
    });
    const first = await s.pass().dryRun("b");
    if (first.kind !== "planned") throw new Error(first.kind);
    expect(first.plan.counts.linkedApple).toBe(6);
    for (const it of made.slice(0, 4)) store.items.delete(it.ref.id);
    const second = await s.pass().dryRun("b");
    if (second.kind !== "planned") throw new Error(second.kind);
    expect(second.guards).toContain("guard_count_drop");
    // Review PR 8 #10: looking again does not accept the drop — it is still shown.
    const third = await s.pass().dryRun("b");
    if (third.kind !== "planned") throw new Error(third.kind);
    expect(third.guards).toContain("guard_count_drop");
    expect(count("binding_holds")).toBe(0);
  });

  it("refuses, recording why: identity unknown for the default filter, a binding not yet bound", async () => {
    const s = await setup(["Buy milk"]);
    const r = await s.pass(null).dryRun("b");
    expect(r).toMatchObject({ kind: "refused", reason: "identity_unknown", detail: "default" });
    expect(db.prepare("SELECT kind, outcome, plan_json FROM runs").get()).toEqual({
      kind: "dry",
      outcome: "identity_unknown",
      plan_json: null,
    });
    // The filter `all` does not need to know who I am.
    db.prepare("UPDATE bindings SET filter_mode = 'all'").run();
    expect((await s.pass(null).dryRun("b")).kind).toBe("planned");
    db.prepare("UPDATE bindings SET state = 'bootstrapping'").run();
    expect(await s.pass().dryRun("b")).toMatchObject({ reason: "binding_state" });
    expect(await s.pass().dryRun("nope")).toMatchObject({ reason: "no_binding" });
  });

  it("a planned create is a valid intent for the executor; once made, the next pass finds it, not a second create", async () => {
    const s = await setup(["Buy milk"]);
    const r = await s.pass().dryRun("b");
    if (r.kind !== "planned") throw new Error(r.kind);
    // Test-only: run the plan's intent on the fake (this build never does it from a pass).
    const e = new Executor({
      db,
      transport: s.t,
      lfcp: {
        commitGuarded: async () => {
          throw new Error("no LFCP");
        },
        receipt: async () => undefined,
      },
      gates: {
        stopped: () => false,
        safeMode: () => false,
        ownershipChecked: () => true,
        accessCheckedNow: () => true,
        offlineCommitAllowed: () => true,
        connected: () => true,
      },
      handler: {
        finalize: () => undefined,
        lfcpBasis: () => true,
      },
      effects: { enabled: true },
    });
    db.prepare("UPDATE bindings SET state = 'active'").run();
    const [i] = e.prepare("b", { intents: r.plan.intents, unlinks: 0 }) ?? [];
    expect(await e.run((i as Intent).id)).toEqual({ kind: "finalized" });
    const made = (await s.t.snapshot(list.id as ListRef)).items;
    expect(made.map((x) => [x.title, x.linkUrl])).toEqual([
      ["Buy milk", taskLink(s.tasks[0]?.id as string, toHex(s.R), bridgeInstanceId(db))],
    ]);
    const next = await s.pass().dryRun("b");
    if (next.kind !== "planned") throw new Error(next.kind);
    expect(next.plan.intents).toEqual([]);
    expect(next.plan.transitions).toEqual([
      { taskId: s.tasks[0]?.id, kind: "link_orphan", item: made[0]?.ref },
    ]);
  });
});

describe("fallback G4: deviceRoot", () => {
  it("the root of this installation's finished pairing request; not another device's, not an unfinished one", async () => {
    const m = memory();
    const device = installation().signer.descriptor.principalId;
    const other = installation().signer.descriptor.principalId;
    const journal = new OperationJournal(m.storage);
    const begin = (id: string, asked: PrincipalId, createdAt: number) =>
      journal.begin({
        id,
        kind: "pairing-request",
        createdAt,
        intent: { root: toHex(root), device: toHex(asked), candidates: [] },
      });
    await begin("pairing-request.1", device, 1);
    expect(await deviceRoot(m.storage, device)).toBeUndefined();
    await journal.setStatus("pairing-request.1", "done");
    expect(toHex((await deviceRoot(m.storage, device)) as PrincipalId)).toBe(toHex(root));
    await begin("pairing-request.2", other, 2);
    await journal.setStatus("pairing-request.2", "done");
    expect(await deviceRoot(m.storage, other)).toBeDefined();
    expect(toHex((await deviceRoot(m.storage, device)) as PrincipalId)).toBe(toHex(root));
    expect(await deviceRoot(memory().storage, device)).toBeUndefined();
  });
});
