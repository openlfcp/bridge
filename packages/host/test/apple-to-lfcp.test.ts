// Apple → LFCP (D-010 §11 PR 10): fields from Reminders into the section
// through commitGuarded, the finalize formulas (§5.6, R2-1: the A→B→C test),
// B12 / B13 / B14, the status table on real data, the atomic basis check
// (§5.8) and the generation rule of a late rejection (§5.9).
//
// A pass plans (Pass.dryRun); the test runs its intents on the executor (the
// fake Apple transport, an offline SectionHost as the LFCP test port) — the
// way apply will once PR 9 opens it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppleItem, type ListInfo, type ListRef, localDate } from "@openlfcp/bridge-reminders";
import { FakePerson, FakeStore, FakeTransport } from "@openlfcp/bridge-reminders/fake";
import { type BatchStatus, receiptOf } from "@openlfcp/client";
import { generateObjectId, type ResourceId, toHex } from "@openlfcp/core";
import { createTask, setTitle, type Task } from "@openlfcp/shared-objects";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BridgeDatabase,
  bridgeHandler,
  currentLfcp,
  deliver,
  Executor,
  type Intent,
  offlineTestPort,
  openBridgeDatabase,
  Pass,
  SectionHost,
  transportStateKV,
} from "../src/index.js";
import { installation, memory, offline, ownedSection } from "./support/lfcp.js";

const me = installation();
const root = me.signer.descriptor.principalId;
const TZ = "UTC";

let dir: string;
let db: BridgeDatabase;
let store: FakeStore;
let list: ListInfo;
let host: SectionHost;
let R: ResourceId;
let storage: ReturnType<typeof memory>["storage"];
let t: FakeTransport;
let e: Executor;
let pass: Pass;
let S: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "lfcp-bridge-a2l-"));
  db = openBridgeDatabase(join(dir, "bridge.sqlite"));
  store = new FakeStore();
  store.today = () => localDate("2026-11-10");
  list = new FakePerson(store).createList("LFCP · Inbox");
  const m = memory();
  storage = m.storage;
  const URL = "ws://127.0.0.1:9/v1/ws";
  ({ R } = await ownedSection(me, m.storage, m.secrets, URL));
  host = new SectionHost({ url: URL, installation: me, ...m, webSocket: offline });
  await host.open(R);
  S = generateObjectId();
  await host.commitGuarded({
    resource: R,
    intents: [{ intent: "section.create", sectionId: S, title: "Inbox", createdBy: root }],
    operationId: "setup",
    check: () => true,
  });
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES ('i', 'd', 'p', 'r', 'l', ?)",
  ).run(now);
  db.prepare(
    `INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, target_ref, filter_mode, state, created_at)
     VALUES ('b', 'i', ?, 'apple-reminders', 'fake', ?, 'all', 'active', ?)`,
  ).run(toHex(R), list.id, now);
  t = new FakeTransport(store);
  await t.open({
    installationKey: "i",
    state: transportStateKV(db, "fake", "i"),
    scope: { listTitlePrefixes: ["LFCP · "], listIds: [list.id as ListRef] },
  });
  e = new Executor({
    db,
    transport: t,
    lfcp: offlineTestPort({
      commitGuarded: (c: Parameters<SectionHost["commitGuarded"]>[0]) => host.commitGuarded(c),
      receipt: (r: ResourceId, op: string) => receiptOf(storage, r, op),
    }),
    gates: {
      stopped: () => false,
      safeMode: () => false,
      ownershipChecked: () => true,
      accessCheckedNow: () => true,
      offlineCommitAllowed: () => true,
      connected: () => false,
    },
    handler: bridgeHandler({ timeZone: TZ }),
    effects: { enabled: true },
  });
  pass = new Pass({ db, transport: t, lfcp: host, me: async () => undefined, timeZone: TZ });
});
afterEach(async () => {
  await host.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A Task in the section (LFCP side). */
async function lfcpTask(title: string, over: Partial<Parameters<typeof createTask>[0]> = {}) {
  const task = createTask({ title, createdBy: root, ...over }).task;
  await host.commitGuarded({
    resource: R,
    intents: [
      {
        intent: "task.create_in_section",
        task,
        parent: S,
        after: null,
      },
    ],
    operationId: `create-${task.id}`,
    check: () => true,
  });
  return task;
}
const lfcpNow = (id: string): Task => host.replica(R)?.task(id)?.task as Task;
/** An LFCP-side edit (another device's, here a local commit). */
async function lfcpEdit(change: { intent: unknown }) {
  await host.commitGuarded({
    resource: R,
    intents: [change.intent],
    operationId: `edit-${generateObjectId()}`,
    check: () => true,
  });
}
const reminder = (): AppleItem => {
  const it = [...store.items.values()].find((x) => x.list === list.id);
  if (it === undefined) throw new Error("no reminder");
  return {
    ...it,
    ref: { id: it.id, ...(it.externalId ? { externalId: it.externalId } : {}) },
  } as unknown as AppleItem;
};
const person = () => new FakePerson(store);
/** The stored reminder of the list, to set what a person sets that FakePerson has no edit for. */
const stored = () => store.items.get(reminderRef().id) as { priority: number };
const reminderRef = () => {
  const it = [...store.items.values()].find((x) => x.list === list.id) as { id: string };
  return { id: it.id };
};

/** One pass: plan, then run every planned intent. */
async function sync() {
  const r = await pass.dryRun("b");
  if (r.kind !== "planned") throw new Error(`${r.kind}: ${"reason" in r ? r.reason : ""}`);
  const prepared = e.prepare("b", { intents: r.plan.intents, unlinks: 0 }) ?? [];
  const outcomes = [];
  for (const i of prepared) outcomes.push(await e.run(i.id));
  return { plan: r.plan, prepared, outcomes };
}
const base = (task: string, field: string) =>
  db
    .prepare(
      "SELECT lfcp_proj_json, apple_proj_json, intent_id FROM bases WHERE task_id = ? AND field = ?",
    )
    .get(task, field) as
    | { lfcp_proj_json: string; apple_proj_json: string; intent_id: string }
    | undefined;
const j = (v: unknown) => JSON.stringify(v);

/** A Task projected and linked: the first pass creates the reminder, finalize links it. */
async function linked(title = "A", over: Partial<Parameters<typeof createTask>[0]> = {}) {
  const task = await lfcpTask(title, over);
  const first = await sync();
  expect(first.outcomes).toEqual([{ kind: "finalized" }]);
  expect(db.prepare("SELECT state FROM links WHERE task_id = ?").get(task.id)).toEqual({
    state: "linked",
  });
  return task;
}

describe("A → B → C (R2-1): finalize between edits", () => {
  it("Apple edits twice: two set_title commits, no conflict, the bases follow each finalize", async () => {
    const task = await linked("A");
    expect(base(task.id, "title")).toMatchObject({
      lfcp_proj_json: j("A"),
      apple_proj_json: j("A"),
    });
    // 1. Apple → B.
    person().edit(reminderRef(), { title: "B" });
    const b = await sync();
    expect(b.prepared.map((i) => [i.direction, i.kind])).toEqual([["to_lfcp", "update_task"]]);
    expect(b.outcomes).toEqual([{ kind: "finalized" }]);
    // 2. finalize: LFCP base B (from the stored intents), Apple base B (captured at plan).
    expect(base(task.id, "title")).toMatchObject({
      lfcp_proj_json: j("B"),
      apple_proj_json: j("B"),
      intent_id: (b.prepared[0] as Intent).id,
    });
    expect(lfcpNow(task.id).title).toBe("B");
    // 3. Apple → C: dA (C ≠ B), ¬dL (B = B) → set_title(C); no conflict.
    person().edit(reminderRef(), { title: "C" });
    const c = await sync();
    expect(c.plan.decisions.filter((d) => d.taskId === task.id)).toEqual([
      expect.objectContaining({ field: "title", decision: "write_lfcp" }),
    ]);
    expect(c.plan.conflicts).toEqual([]);
    expect(c.outcomes).toEqual([{ kind: "finalized" }]);
    expect(lfcpNow(task.id).title).toBe("C");
    expect(base(task.id, "title")).toMatchObject({
      lfcp_proj_json: j("C"),
      apple_proj_json: j("C"),
    });
    // Nothing left to do.
    expect((await sync()).plan.intents).toEqual([]);
  });
});

describe("fields Apple → LFCP", () => {
  it("B12: a time on the due stays personal; a new date goes as the date only", async () => {
    const task = await linked("A", { due: "2026-11-12" });
    person().edit(reminderRef(), { dueTime: "18:30", tz: "Europe/Moscow" });
    expect((await sync()).plan.intents).toEqual([]);
    person().edit(reminderRef(), { dueDate: "2026-11-14" });
    expect((await sync()).outcomes).toEqual([{ kind: "finalized" }]);
    expect(lfcpNow(task.id).due).toBe("2026-11-14");
    expect(reminder().due?.time).toBe("18:30");
  });

  it("B13: a priority in the same bucket is no write; a new bucket keeps highest from the shadow", async () => {
    const task = await linked("A", { priority: "highest" });
    expect(reminder().priority).toBe(1);
    stored().priority = 3;
    expect((await sync()).plan.intents).toEqual([]);
    stored().priority = 9;
    await sync();
    expect(lfcpNow(task.id).priority).toBe("low");
    stored().priority = 1;
    await sync();
    // The shadow is now "low": back to the high bucket is "high".
    expect(lfcpNow(task.id).priority).toBe("high");
  });

  it("B14: both sides changed the title — LFCP wins, Apple's value goes to the journal", async () => {
    const task = await linked("A");
    await lfcpEdit(setTitle(lfcpNow(task.id), "From LFCP"));
    person().edit(reminderRef(), { title: "From Apple" });
    const r = await sync();
    expect(r.prepared.map((i) => i.direction)).toEqual(["to_apple"]);
    expect(reminder().title).toBe("From LFCP");
    expect(lfcpNow(task.id).title).toBe("From LFCP");
    expect(
      db.prepare("SELECT key, params_json FROM journal WHERE key = 'field.apple_overruled'").all(),
    ).toEqual([
      {
        key: "field.apple_overruled",
        params_json: expect.stringContaining('"apple":"\\"From Apple\\""'),
      },
    ]);
  });

  it("status: completed in Apple → complete with its date (row 7); reopened → reopen (row 8)", async () => {
    const task = await linked("A");
    const it = store.items.get(reminderRef().id) as { completed: boolean; completionDate?: string };
    it.completed = true;
    it.completionDate = "2026-11-09T12:00:00.000Z";
    const done = await sync();
    expect(done.plan.decisions.find((d) => d.field === "status")?.row).toBe("7");
    expect(lfcpNow(task.id)).toMatchObject({ status: "done", completion_date: "2026-11-09" });
    expect(base(task.id, "status")).toMatchObject({
      lfcp_proj_json: j({ closed: true, date: "2026-11-09" }),
      apple_proj_json: j({ closed: true, date: "2026-11-09" }),
    });
    it.completed = false;
    delete it.completionDate;
    const open = await sync();
    expect(open.plan.decisions.find((d) => d.field === "status")?.row).toBe("8");
    expect(lfcpNow(task.id).status).toBe("todo");
  });

  it("status: a cancelled Task stays cancelled when Apple's date moves (row 10, B14)", async () => {
    const task = await linked("A");
    await lfcpEdit({ intent: { intent: "task.cancel", id: task.id } });
    const closed = await sync();
    expect(closed.plan.decisions.find((d) => d.field === "status")?.row).toBe("3");
    const it = store.items.get(reminderRef().id) as { completionDate?: string };
    it.completionDate = "2026-11-01T08:00:00.000Z";
    const moved = await sync();
    expect(moved.plan.decisions.find((d) => d.field === "status")?.row).toBe("10");
    expect(moved.plan.intents).toEqual([]);
    expect(lfcpNow(task.id).status).toBe("cancelled");
  });

  it("§5.8: LFCP changed between the plan and the commit → superseded, nothing written", async () => {
    const task = await linked("A");
    person().edit(reminderRef(), { title: "B" });
    const r = await pass.dryRun("b");
    if (r.kind !== "planned") throw new Error(r.kind);
    const [i] = e.prepare("b", { intents: r.plan.intents, unlinks: 0 }) ?? [];
    await lfcpEdit(setTitle(lfcpNow(task.id), "Meanwhile in LFCP"));
    expect(await e.run((i as Intent).id)).toEqual({ kind: "superseded", reason: "basis_changed" });
    expect(lfcpNow(task.id).title).toBe("Meanwhile in LFCP");
    expect(await receiptOf(storage, R, (i as Intent).operationId)).toBeUndefined();
  });
});

describe("generation (§5.9, r3 P2-3)", () => {
  it("a late rejection of I1 after I2 finalized the same field keeps I2's base, no conflict", async () => {
    const task = await linked("A");
    person().edit(reminderRef(), { title: "B" });
    const i1 = (await sync()).prepared[0] as Intent;
    person().edit(reminderRef(), { title: "C" });
    const i2 = (await sync()).prepared[0] as Intent;
    expect(base(task.id, "title")).toMatchObject({ intent_id: i2.id, lfcp_proj_json: j("C") });
    const receipt = await receiptOf(storage, R, i1.operationId);
    if (receipt === undefined) throw new Error("no receipt for I1");
    const rejected: BatchStatus = {
      operationId: i1.operationId,
      status: "rejected",
      unitIds: receipt.unitIds,
      acceptedUnitIds: [],
      affectedNodeIds: [task.id],
      rejection: { code: "AUTHORIZATION_FAILED", unitIds: receipt.unitIds },
    } as BatchStatus;
    expect(deliver(db, rejected, { current: currentLfcp(() => host.replica(R)) })).toBe("refused");
    expect(base(task.id, "title")).toMatchObject({
      intent_id: i2.id,
      lfcp_proj_json: j("C"),
      apple_proj_json: j("C"),
    });
    expect(db.prepare("SELECT count(*) AS n FROM conflicts").get()).toEqual({ n: 0 });
  });

  it("…while a rejection of the intent that finalized the field gives lfcp_rejected with the replica's value", async () => {
    const task = await linked("A");
    person().edit(reminderRef(), { title: "B" });
    const i1 = (await sync()).prepared[0] as Intent;
    const receipt = await receiptOf(storage, R, i1.operationId);
    if (receipt === undefined) throw new Error("no receipt");
    const rejected = {
      operationId: i1.operationId,
      status: "rejected",
      unitIds: receipt.unitIds,
      acceptedUnitIds: [],
      affectedNodeIds: [task.id],
      rejection: { code: "AUTHORIZATION_FAILED", unitIds: receipt.unitIds },
    } as BatchStatus;
    expect(deliver(db, rejected, { current: currentLfcp(() => host.replica(R)) })).toBe("refused");
    expect(db.prepare("SELECT field, kind FROM conflicts").all()).toEqual([
      { field: "title", kind: "lfcp_rejected" },
    ]);
  });
});

describe("review PR 10", () => {
  it("#11 a cleared due is null in the Apple base; the person setting the old date again goes to LFCP", async () => {
    const task = await linked("A", { due: "2026-11-12" });
    await lfcpEdit({ intent: { intent: "task.clear_due", id: task.id } });
    await sync();
    expect(reminder().due).toBeUndefined();
    expect(base(task.id, "due")).toMatchObject({ lfcp_proj_json: "null", apple_proj_json: "null" });
    person().edit(reminderRef(), { dueDate: "2026-11-12" });
    const r = await sync();
    expect(r.prepared.map((i) => i.direction)).toEqual(["to_lfcp"]);
    expect(lfcpNow(task.id).due).toBe("2026-11-12");
  });

  it("the to_lfcp Apple base is the plan's: complete without Apple's date keeps LFCP's hidden date, bases differ", async () => {
    const task = await linked("A");
    await lfcpEdit({
      intent: { intent: "task.complete", id: task.id, completionDate: "2026-11-01" },
    });
    await lfcpEdit({ intent: { intent: "task.set_status", id: task.id, status: "todo" } });
    const it = store.items.get(reminderRef().id) as { completed: boolean; completionDate?: string };
    it.completed = true;
    delete it.completionDate;
    const r = await sync();
    expect(r.plan.decisions.find((d) => d.field === "status")?.row).toBe("7");
    expect(lfcpNow(task.id)).toMatchObject({ status: "done", completion_date: "2026-11-01" });
    expect(base(task.id, "status")).toMatchObject({
      lfcp_proj_json: j({ closed: true, date: "2026-11-01" }),
      apple_proj_json: j({ closed: true, date: null }),
    });
  });

  it("#13 the hidden completion date a dateless complete keeps changed before stage → superseded, nothing written", async () => {
    const task = await linked("A");
    await lfcpEdit({
      intent: { intent: "task.complete", id: task.id, completionDate: "2026-11-01" },
    });
    await lfcpEdit({ intent: { intent: "task.set_status", id: task.id, status: "todo" } });
    const it = store.items.get(reminderRef().id) as { completed: boolean; completionDate?: string };
    it.completed = true;
    delete it.completionDate;
    const r = await pass.dryRun("b");
    if (r.kind !== "planned") throw new Error(r.kind);
    const [i] = e.prepare("b", { intents: r.plan.intents, unlinks: 0 }) ?? [];
    await lfcpEdit({
      intent: { intent: "task.complete", id: task.id, completionDate: "2026-11-02" },
    });
    await lfcpEdit({ intent: { intent: "task.set_status", id: task.id, status: "todo" } });
    expect(await e.run((i as Intent).id)).toEqual({ kind: "superseded", reason: "basis_changed" });
    expect(lfcpNow(task.id)).toMatchObject({ status: "todo", completion_date: "2026-11-02" });
    expect(await receiptOf(storage, R, (i as Intent).operationId)).toBeUndefined();
  });
});
