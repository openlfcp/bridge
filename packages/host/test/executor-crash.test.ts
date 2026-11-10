// The executor on the fake transport (D-010 PR 7, §10.2): a crash at every
// boundary prepare → effect → result → finalize and a restart; a lost answer
// (with and without the person's edit after it); unknown outcomes of a
// create (r3 P2-1); §7.1 before every effect and retry; effects off.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppleItem, type ListInfo, type ListRef, localDate } from "@openlfcp/bridge-reminders";
import { FakePerson, FakeStore, FakeTransport } from "@openlfcp/bridge-reminders/fake";
import { receiptOf } from "@openlfcp/client";
import { type ResourceId, toHex } from "@openlfcp/core";
import { setTitle } from "@openlfcp/shared-objects";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BridgeDatabase,
  type CrashPoint,
  Executor,
  type Gates,
  type Intent,
  type IntentHandler,
  offlineTestPort,
  openBridgeDatabase,
  resume,
  SectionHost,
  stop,
  stopState,
  transportStateKV,
} from "../src/index.js";
import { installation, memory, offline, ownedSection, sectionId, task } from "./support/lfcp.js";

class Crash extends Error {}

let dir: string;
let db: BridgeDatabase;
let store: FakeStore;
let list: ListInfo;
const R_HEX = "aa".repeat(32);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lfcp-bridge-crash-"));
  db = openBridgeDatabase(join(dir, "bridge.sqlite"));
  store = new FakeStore();
  store.today = () => localDate("2026-11-10");
  list = new FakePerson(store).createList("LFCP · Inbox");
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES ('i', 'd', 'p', 'r', 'l', ?)",
  ).run(now);
  db.prepare(
    "INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, target_ref, state, created_at) VALUES ('b', 'i', ?, 'apple-reminders', 'fake', ?, 'active', ?)",
  ).run(R_HEX, list.id, now);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A transport process: a fresh FakeTransport on the same account and the same durable stages. */
async function transport(opts: ConstructorParameters<typeof FakeTransport>[1] = {}) {
  const t = new FakeTransport(store, opts);
  await t.open({
    installationKey: "i",
    state: transportStateKV(db, "fake", "i"),
    scope: { listTitlePrefixes: ["LFCP · "], listIds: [list.id as ListRef] },
  });
  return t;
}

const gates = (over: Partial<Gates> = {}): Gates => ({
  stopped: () => stopState(dir) !== undefined,
  safeMode: () => false,
  ownershipChecked: () => true,
  accessCheckedNow: () => true,
  offlineCommitAllowed: () => true,
  connected: () => true,
  ...over,
});

/** The adapter's part, as PR 8/10 will have it: bases from basis (LFCP) and from what was written (Apple). */
const handler: IntentHandler = {
  finalize(i, result, d) {
    const r = result as { written?: Record<string, unknown> } | undefined;
    const basis = i.basis as { pL?: Record<string, unknown> };
    for (const f of i.fields)
      d.prepare(
        `INSERT INTO bases (binding_id, task_id, field, lfcp_proj_json, apple_proj_json, intent_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (binding_id, task_id, field) DO UPDATE SET lfcp_proj_json = excluded.lfcp_proj_json,
           apple_proj_json = excluded.apple_proj_json, intent_id = excluded.intent_id`,
      ).run(
        i.bindingId,
        i.taskId,
        f,
        JSON.stringify(basis.pL?.[f] ?? null),
        JSON.stringify(r?.written?.[f] ?? null),
        i.id,
        new Date().toISOString(),
      );
  },
  lfcpBasis: (replica, i) => {
    const b = i.basis as { task: string; title: string };
    return replica.task(b.task)?.task?.title === b.title || "title changed";
  },
};

const noLfcp = {
  commitGuarded: async () => {
    throw new Error("no LFCP here");
  },
  receipt: async () => undefined,
};

async function executor(
  over: {
    crash?: CrashPoint;
    gates?: Gates;
    effects?: boolean;
    transportOpts?: ConstructorParameters<typeof FakeTransport>[1];
    lfcp?: ConstructorParameters<typeof Executor>[0]["lfcp"];
  } = {},
) {
  const t = await transport(over.transportOpts);
  const e = new Executor({
    db,
    transport: t,
    lfcp: over.lfcp ?? noLfcp,
    gates: over.gates ?? gates(),
    handler,
    effects: { enabled: over.effects ?? true },
    ...(over.crash === undefined
      ? {}
      : {
          crash: (p: CrashPoint) => {
            if (p === over.crash) throw new Crash(p);
          },
        }),
  });
  return { e, t };
}

function item(title = "Buy milk"): AppleItem {
  return new FakePerson(store).create(list.id as ListRef, title, { url: "lfcp://task/T1?s=R" });
}
const update = (it: AppleItem, title: string) => ({
  bindingId: "b",
  taskId: "T1",
  installationId: "i",
  direction: "to_apple" as const,
  kind: "update",
  fields: ["title"],
  basis: { rev: it.rev, pL: { title } },
  payload: {
    kind: "update",
    ref: { id: it.ref.id, externalId: it.ref.externalId },
    set: { title },
    expect: { rev: it.rev },
  },
});
const create = (title: string) => ({
  bindingId: "b",
  taskId: "T2",
  installationId: "i",
  direction: "to_apple" as const,
  kind: "create",
  fields: ["title"],
  basis: { pL: { title } },
  payload: { kind: "create", list: list.id, linkUrl: "lfcp://task/T2?s=R", set: { title } },
});
const itemsIn = () => [...store.items.values()].filter((x) => x.list === list.id);
const stateOf = (id: string) =>
  db.prepare("SELECT state, state_reason FROM intents WHERE id = ?").get(id) as {
    state: string;
    state_reason: string | null;
  };
const baseOf = (task: string) =>
  db
    .prepare("SELECT apple_proj_json, intent_id FROM bases WHERE task_id = ? AND field = 'title'")
    .get(task) as { apple_proj_json: string; intent_id: string } | undefined;

describe("crash at every boundary, then a restart (§5.7)", () => {
  for (const point of [
    "after_effecting",
    "after_effect",
    "after_result",
    "after_finalize",
  ] as const) {
    it(`update, crash ${point}: one effect, finalized once, the base written`, async () => {
      const it0 = item();
      const first = await executor({ crash: point });
      const [i] =
        first.e.prepare("b", { intents: [update(it0, "Buy oat milk")], unlinks: 0 }) ?? [];
      await expect(first.e.run((i as Intent).id)).rejects.toBeInstanceOf(Crash);
      // Restart: a new transport process and executor on the same database and account.
      const second = await executor();
      await second.e.recoverAll();
      await second.e.runDue();
      expect(stateOf((i as Intent).id)).toEqual({ state: "finalized", state_reason: null });
      expect(store.items.get(it0.ref.id)?.title).toBe("Buy oat milk");
      expect(baseOf("T1")).toEqual({
        apple_proj_json: '"Buy oat milk"',
        intent_id: (i as Intent).id,
      });
    });

    it(`create, crash ${point}: exactly one reminder`, async () => {
      const first = await executor({ crash: point });
      const [i] = first.e.prepare("b", { intents: [create("Call Bob")], unlinks: 0 }) ?? [];
      await expect(first.e.run((i as Intent).id)).rejects.toBeInstanceOf(Crash);
      const second = await executor();
      await second.e.recoverAll();
      await second.e.runDue();
      expect(stateOf((i as Intent).id).state).toBe("finalized");
      expect(itemsIn().filter((x) => x.title === "Call Bob")).toHaveLength(1);
    });
  }
});

describe("a lost answer (§5.7, r3 P2-1)", () => {
  it("B19: update lost, the item's fields equal the payload — still quarantined, nothing inferred", async () => {
    const it0 = item();
    const { e, t } = await executor();
    t.faults.loseNextResponse = 1;
    const [i] = e.prepare("b", { intents: [update(it0, "Buy bread")], unlinks: 0 }) ?? [];
    expect(await e.run((i as Intent).id)).toEqual({ kind: "lost" });
    expect(stateOf((i as Intent).id).state).toBe("effecting");
    expect(store.items.get(it0.ref.id)?.title).toBe("Buy bread");
    const second = await executor();
    await second.e.recoverAll();
    expect(stateOf((i as Intent).id)).toEqual({
      state: "quarantined",
      state_reason: "unknown_outcome",
    });
    expect(baseOf("T1")).toBeUndefined();
    expect(
      db
        .prepare("SELECT field, kind FROM conflicts WHERE intent_id = ? AND resolved_at IS NULL")
        .all((i as Intent).id),
    ).toEqual([{ field: "title", kind: "unknown_outcome" }]);
    // Only the transport's confirmed done settles it on its own (a CloudKit-like exact recover).
    const third = await executor({ transportOpts: { capabilities: { recover: "exact" } } });
    await third.e.recoverAll();
    expect(stateOf((i as Intent).id).state).toBe("finalized");
  });

  it("update, lost answer, then the person edits, then a restart → quarantine; the person's edit stays", async () => {
    const it0 = item();
    const { e, t } = await executor();
    t.faults.loseNextResponse = 1;
    const [i] = e.prepare("b", { intents: [update(it0, "Buy bread")], unlinks: 0 }) ?? [];
    await e.run((i as Intent).id);
    new FakePerson(store).edit(it0.ref, { title: "Buy rye bread" });
    const second = await executor();
    await second.e.recoverAll();
    await second.e.runDue();
    expect(stateOf((i as Intent).id)).toEqual({
      state: "quarantined",
      state_reason: "unknown_outcome",
    });
    expect(store.items.get(it0.ref.id)?.title).toBe("Buy rye bread");
    const conflicts = db
      .prepare("SELECT field, kind FROM conflicts WHERE intent_id = ?")
      .all((i as Intent).id);
    expect(conflicts).toEqual([{ field: "title", kind: "unknown_outcome" }]);
  });

  it("update whose effect did not happen (rev unchanged): quarantined, not sent again; after a person, a new opKey", async () => {
    const it0 = item();
    const { e } = await executor({ crash: "after_effecting" });
    const [i] = e.prepare("b", { intents: [update(it0, "Buy tea")], unlinks: 0 }) ?? [];
    await expect(e.run((i as Intent).id)).rejects.toBeInstanceOf(Crash);
    // A stage "sent" with no effect: the transport says unknown; the item's rev is unchanged.
    transportStateKV(db, "fake", "i").put(`op:${(i as Intent).id}`, {
      stage: "sent",
      kind: "update",
    });
    const second = await executor();
    let sent = 0;
    const apply = second.t.apply.bind(second.t);
    second.t.apply = (op) => {
      sent++;
      return apply(op);
    };
    await second.e.recoverAll();
    await second.e.runDue();
    expect(stateOf((i as Intent).id)).toEqual({
      state: "quarantined",
      state_reason: "unknown_outcome",
    });
    expect(sent).toBe(0);
    expect(store.items.get(it0.ref.id)?.title).toBe("Buy milk");
    // The person settles it (conflicts resolve); the write, still wanted, is a new intent: a new opKey.
    db.prepare("UPDATE conflicts SET resolved_at = ?, resolution = 'lfcp' WHERE intent_id = ?").run(
      new Date().toISOString(),
      (i as Intent).id,
    );
    const [again] = second.e.prepare("b", { intents: [update(it0, "Buy tea")], unlinks: 0 }) ?? [];
    expect((again as Intent).id).not.toBe((i as Intent).id);
    expect(await second.e.run((again as Intent).id)).toEqual({ kind: "finalized" });
    expect(store.items.get(it0.ref.id)?.title).toBe("Buy tea");
  });

  it("OutcomeUnknownError from the transport: quarantined, never resent", async () => {
    const it0 = item();
    const { e, t } = await executor();
    t.faults.loseNextResponse = 1;
    const [i] = e.prepare("b", { intents: [update(it0, "Lost")], unlinks: 0 }) ?? [];
    expect(await e.run((i as Intent).id)).toEqual({ kind: "lost" });
    // An older build (or a hand edit) put it back to prepared: the run reaches apply with the same opKey.
    db.prepare("UPDATE intents SET state = 'prepared' WHERE id = ?").run((i as Intent).id);
    const revAfterLoss = store.items.get(it0.ref.id)?.rev;
    const second = await executor();
    expect(await second.e.run((i as Intent).id)).toEqual({
      kind: "quarantined",
      reason: "unknown_outcome",
    });
    expect(
      db.prepare("SELECT count(*) AS n FROM conflicts WHERE intent_id = ?").get((i as Intent).id),
    ).toEqual({ n: 1 });
    // Refused without sending: the reminder is as the lost write left it.
    expect(store.items.get(it0.ref.id)?.rev).toBe(revAfterLoss);
  });

  it("in this process an intent runs once at a time: a second run gets in_flight, sends nothing", async () => {
    const it0 = item();
    const { e, t } = await executor();
    let calls = 0;
    const apply = t.apply.bind(t);
    t.apply = (op) => {
      calls++;
      return apply(op);
    };
    let release = () => {};
    t.faults.stallNextWrite = new Promise<void>((r) => {
      release = r;
    });
    const [i] = e.prepare("b", { intents: [update(it0, "Once")], unlinks: 0 }) ?? [];
    const first = e.run((i as Intent).id);
    // Prepared, then effecting and inside the transport: a second run or a recovery sends nothing.
    expect(await e.run((i as Intent).id)).toEqual({ kind: "in_flight" });
    while (stateOf((i as Intent).id).state !== "effecting")
      await new Promise((r) => setTimeout(r, 1));
    expect(await e.run((i as Intent).id)).toEqual({ kind: "in_flight" });
    expect(await e.recoverAll()).toEqual([{ kind: "in_flight" }]);
    release();
    expect(await first).toEqual({ kind: "finalized" });
    expect(calls).toBe(1);
  });

  it("two executors on one prepared intent: one sends, the other gets in_flight", async () => {
    const it0 = item();
    const { e, t } = await executor();
    let calls = 0;
    const apply = t.apply.bind(t);
    t.apply = (op) => {
      calls++;
      return apply(op);
    };
    const other = new Executor({
      db,
      transport: t,
      lfcp: noLfcp,
      gates: gates(),
      handler,
      effects: { enabled: true },
    });
    const [i] = e.prepare("b", { intents: [update(it0, "Once")], unlinks: 0 }) ?? [];
    const outcomes = await Promise.all([e.run((i as Intent).id), other.run((i as Intent).id)]);
    expect(outcomes.map((o) => o.kind).sort()).toEqual(["finalized", "in_flight"]);
    expect(calls).toBe(1);
  });

  it("OperationInFlightError (another executor on the transport): not repeated; the call in flight settles it", async () => {
    const it0 = item();
    const { e, t } = await executor();
    let release = () => {};
    t.faults.stallNextWrite = new Promise<void>((r) => {
      release = r;
    });
    const [i] = e.prepare("b", { intents: [update(it0, "Once")], unlinks: 0 }) ?? [];
    const first = e.run((i as Intent).id);
    while (stateOf((i as Intent).id).state !== "effecting")
      await new Promise((r) => setTimeout(r, 1));
    await new Promise((r) => setTimeout(r, 1));
    // A second executor on the same transport: recover says not_started (nothing sent yet), its retry is refused.
    const other = new Executor({
      db,
      transport: t,
      lfcp: noLfcp,
      gates: gates(),
      handler,
      effects: { enabled: true },
    });
    expect(await other.run((i as Intent).id)).toEqual({ kind: "in_flight" });
    expect(db.prepare("SELECT key FROM journal WHERE key LIKE 'effect.%'").all()).toEqual([
      { key: "effect.in_flight" },
    ]);
    release();
    expect(await first).toEqual({ kind: "finalized" });
    expect(stateOf((i as Intent).id).state).toBe("finalized");
    expect(store.items.get(it0.ref.id)?.title).toBe("Once");
  });

  it("create: never settled from fields — quarantined, no second reminder; the transport may settle it later", async () => {
    const { e, t } = await executor();
    t.faults.loseNextResponse = 1;
    const [i] = e.prepare("b", { intents: [create("Water plants")], unlinks: 0 }) ?? [];
    expect(await e.run((i as Intent).id)).toEqual({ kind: "lost" });
    const second = await executor();
    await second.e.recoverAll();
    await second.e.runDue();
    expect(stateOf((i as Intent).id)).toEqual({
      state: "quarantined",
      state_reason: "unknown_outcome",
    });
    expect(itemsIn().filter((x) => x.title === "Water plants")).toHaveLength(1);
    // A transport whose recover knows the store's record (CloudKit-like): done → finalized.
    const third = await executor({ transportOpts: { capabilities: { recover: "exact" } } });
    await third.e.recoverAll();
    expect(stateOf((i as Intent).id).state).toBe("finalized");
    expect(
      db.prepare("SELECT resolution FROM conflicts WHERE intent_id = ?").all((i as Intent).id),
    ).toEqual([{ resolution: "transport_done" }]);
  });
});

describe("§7.1 before every effect and retry; effects off", () => {
  it("a retryable failure retries later; STOP set meanwhile denies the retry; removed, it runs", async () => {
    const it0 = item();
    const { e, t } = await executor();
    t.faults.failNext = { code: "transport_error", times: 1 };
    const [i] = e.prepare("b", { intents: [update(it0, "Buy jam")], unlinks: 0 }) ?? [];
    // transport_error is not retryable in the fake: refused. store_conflict is.
    t.faults.failNext = { code: "store_conflict", times: 1 };
    expect(await e.run((i as Intent).id)).toEqual({ kind: "retry", reason: "store_conflict" });
    stop(dir, "test");
    expect(await e.run((i as Intent).id)).toEqual({ kind: "denied", denials: ["stopped"] });
    resume(dir);
    expect(await e.run((i as Intent).id)).toEqual({ kind: "finalized" });
  });

  it("holds, a missing list, no access, no ownership: denied, nothing written", async () => {
    const it0 = item();
    const { e } = await executor({
      gates: gates({ ownershipChecked: () => false, accessCheckedNow: () => false }),
    });
    const [i] = e.prepare("b", { intents: [update(it0, "Buy figs")], unlinks: 0 }) ?? [];
    const out = await e.run((i as Intent).id);
    expect(out).toEqual({
      kind: "denied",
      denials: ["ownership_not_checked", "access_not_checked"],
    });
    expect(store.items.get(it0.ref.id)?.title).toBe("Buy milk");
    expect(stateOf((i as Intent).id).state).toBe("prepared");
    // Denied before the effect: no attempt counted, never effecting.
    expect(
      db.prepare("SELECT attempts, effected_at FROM intents WHERE id = ?").get((i as Intent).id),
    ).toEqual({
      attempts: 0,
      effected_at: null,
    });
  });

  it("effects off (this PR's default): the executor gets to the transport and writes nothing", async () => {
    const it0 = item();
    const { e } = await executor({ effects: false });
    const [i] = e.prepare("b", { intents: [update(it0, "Buy kiwi")], unlinks: 0 }) ?? [];
    expect(await e.run((i as Intent).id)).toEqual({ kind: "effects_off" });
    expect(stateOf((i as Intent).id).state).toBe("prepared");
    expect(store.items.get(it0.ref.id)?.title).toBe("Buy milk");
    const real = Object.assign(await transport(), { id: "eventkit" });
    expect(
      () =>
        new Executor({
          db,
          transport: real,
          lfcp: noLfcp,
          gates: gates(),
          handler,
          effects: { enabled: true },
        }),
    ).toThrow(/effects are off/);
  });

  it("limits: over the import limit nothing is prepared", async () => {
    const { e } = await executor();
    const many = Array.from({ length: 11 }, (_, n) => ({
      ...create(`t${n}`),
      taskId: `T${n}`,
      direction: "to_lfcp" as const,
      kind: "create_task",
      payload: { resource: R_HEX, intents: [] },
    }));
    expect(e.prepare("b", { intents: many, unlinks: 0 })).toBeUndefined();
    expect(db.prepare("SELECT count(*) AS n FROM intents").get()).toEqual({ n: 0 });
  });
});

describe("to_lfcp through SectionHost.commitGuarded (§5.7, §5.8)", () => {
  async function lfcpSetup() {
    const me = installation();
    const m = memory();
    const URL = "ws://127.0.0.1:9/v1/ws";
    const { R } = await ownedSection(me, m.storage, m.secrets, URL);
    const host = new SectionHost({ url: URL, installation: me, ...m, webSocket: offline });
    await host.open(R);
    const S = sectionId();
    const t1 = task("Buy milk", me);
    await host.commitGuarded({
      resource: R,
      intents: [
        {
          intent: "section.create",
          sectionId: S,
          title: "Inbox",
          createdBy: me.signer.descriptor.principalId,
        },
        { intent: "task.create_in_section", task: t1, parent: S, after: null },
      ],
      operationId: "setup",
      check: () => true,
    });
    // The binding is of this section; the port is the offline test port (review #4).
    db.prepare("UPDATE bindings SET resource_id = ? WHERE id = 'b'").run(toHex(R));
    const lfcp = offlineTestPort({
      commitGuarded: (c: Parameters<SectionHost["commitGuarded"]>[0]) => host.commitGuarded(c),
      receipt: (r: ResourceId, op: string) => receiptOf(m.storage, r, op),
    });
    const t = host.replica(R)?.task(t1.id)?.task;
    if (t === undefined) throw new Error("no task");
    const intent = (title: string) => ({
      bindingId: "b",
      taskId: t1.id,
      installationId: "i",
      direction: "to_lfcp" as const,
      kind: "update_task",
      fields: ["title"],
      basis: { task: t1.id, title: "Buy milk", pL: { title } },
      payload: { resource: toHex(R), intents: [setTitle(t, title).intent] },
    });
    return { host, m, R, t1, lfcp, intent };
  }

  for (const point of ["after_effecting", "after_effect", "after_result"] as const) {
    it(`crash ${point}: one commit (one receipt), finalized`, async () => {
      const s = await lfcpSetup();
      const first = await executor({ crash: point, lfcp: s.lfcp });
      const [i] = first.e.prepare("b", { intents: [s.intent("Buy oat milk")], unlinks: 0 }) ?? [];
      await expect(first.e.run((i as Intent).id)).rejects.toBeInstanceOf(Crash);
      const outboundBefore = (await s.m.storage.outbound.list(s.R)).length;
      const second = await executor({ lfcp: s.lfcp });
      await second.e.recoverAll();
      await second.e.runDue();
      expect(stateOf((i as Intent).id).state).toBe("finalized");
      expect(s.host.replica(s.R)?.task(s.t1.id)?.task?.title).toBe("Buy oat milk");
      const receipt = await receiptOf(s.m.storage, s.R, (i as Intent).operationId);
      expect(receipt).toBeDefined();
      if (point !== "after_effecting")
        expect((await s.m.storage.outbound.list(s.R)).length).toBe(outboundBefore);
      await s.host.stop();
    });
  }

  it("the basis changed before the commit: superseded, nothing written", async () => {
    const s = await lfcpSetup();
    const { e } = await executor({ lfcp: s.lfcp });
    const i = { ...s.intent("Buy oat milk"), basis: { task: s.t1.id, title: "something else" } };
    const [prepared] = e.prepare("b", { intents: [i], unlinks: 0 }) ?? [];
    expect(await e.run((prepared as Intent).id)).toEqual({
      kind: "superseded",
      reason: "basis_changed",
    });
    expect(await receiptOf(s.m.storage, s.R, (prepared as Intent).operationId)).toBeUndefined();
    await s.host.stop();
  });
});

// Review PR 7 (r2): the reviewer's reproductions.
describe("review PR 7", () => {
  it("#1 a field in quarantine (unknown_outcome) is not written by a new intent", async () => {
    const original = item();
    const { e, t } = await executor();
    t.faults.loseNextResponse = 1;
    const [i] = e.prepare("b", { intents: [update(original, "Bridge edit")], unlinks: 0 }) ?? [];
    await e.run((i as Intent).id);
    new FakePerson(store).edit(original.ref, { title: "Human edit" });
    await e.recoverAll();
    expect(stateOf((i as Intent).id).state).toBe("quarantined");
    const fresh = (await t.find({ id: original.ref.id }, "all")).items[0] as AppleItem;
    const next = e.prepare("b", { intents: [update(fresh, "Overwrite human")], unlinks: 0 });
    if (next?.[0]) await e.run(next[0].id);
    expect(store.items.get(original.ref.id)?.title).toBe("Human edit");
    // Nothing of it was prepared; the LFCP side of the same field is held too.
    expect(next).toEqual([]);
    const toLfcp = {
      ...update(fresh, "x"),
      direction: "to_lfcp" as const,
      kind: "update_task",
      payload: { resource: R_HEX, intents: [] },
    };
    expect(e.prepare("b", { intents: [toLfcp], unlinks: 0 })).toEqual([]);
    // Another field of the same Task still works.
    const [other] =
      e.prepare("b", {
        intents: [
          {
            ...update(fresh, "x"),
            fields: ["priority"],
            payload: {
              kind: "update",
              ref: fresh.ref,
              set: { priority: 1 },
              expect: { rev: fresh.rev },
            },
          },
        ],
        unlinks: 0,
      }) ?? [];
    expect(await e.run((other as Intent).id)).toEqual({ kind: "finalized" });
    // An intent prepared before the quarantine (an older pass) is superseded at its effect, unsent.
    const later = (await t.find({ id: original.ref.id }, "all")).items[0] as AppleItem;
    const [early] =
      e.prepare("b", {
        intents: [{ ...update(later, "Early"), fields: ["priority"] }],
        unlinks: 0,
      }) ?? [];
    db.prepare("UPDATE intents SET fields_json = '[\"title\"]' WHERE id = ?").run(
      (early as Intent).id,
    );
    expect(await e.run((early as Intent).id)).toEqual({
      kind: "superseded",
      reason: "field_quarantined",
    });
    expect(store.items.get(original.ref.id)?.title).toBe("Human edit");
    // Resolved by a person: the field may be written again.
    db.prepare(
      "UPDATE conflicts SET resolved_at = ?, resolution = 'apple' WHERE intent_id = ?",
    ).run(new Date().toISOString(), (i as Intent).id);
    const now = (await t.find({ id: original.ref.id }, "all")).items[0] as AppleItem;
    const [after] = e.prepare("b", { intents: [update(now, "After resolve")], unlinks: 0 }) ?? [];
    expect(await e.run((after as Intent).id)).toEqual({ kind: "finalized" });
    expect(store.items.get(original.ref.id)?.title).toBe("After resolve");
  });

  it("#2 a binding removed during the last asynchronous gate blocks the effect", async () => {
    const original = item();
    const { e, t } = await executor();
    const lists = t.lists.bind(t);
    let calls = 0;
    t.lists = async () => {
      const value = await lists();
      if (++calls === 2) db.prepare("UPDATE bindings SET state = 'removed' WHERE id = 'b'").run();
      return value;
    };
    const [i] = e.prepare("b", { intents: [update(original, "After unbind")], unlinks: 0 }) ?? [];
    await e.run((i as Intent).id);
    expect(store.items.get(original.ref.id)?.title).toBe("Buy milk");
  });

  it("#3 an update of a multi-step stages transport stays quarantined, fields matching or not", async () => {
    const original = item();
    const { e, t } = await executor();
    t.faults.loseNextResponse = 1;
    const [i] =
      e.prepare("b", { intents: [update(original, "Step one written")], unlinks: 0 }) ?? [];
    await e.run((i as Intent).id);
    const second = await executor({
      // A transport of its own name (the type keeps `transport` the fake's; the test overrides it).
      transportOpts: {
        capabilities: { transport: "multistep", recover: "stages" } as { recover: "stages" },
      },
    });
    second.t.recover = async () => ({
      state: "unknown",
      stage: "first-step-done-second-step-pending",
    });
    await second.e.recoverAll();
    expect(stateOf((i as Intent).id).state).toBe("quarantined");
  });

  it("#3 a multi-step transport is not inferred even in the stage the one-step one is", async () => {
    const original = item();
    const { e, t } = await executor();
    t.faults.loseNextResponse = 1;
    const [i] = e.prepare("b", { intents: [update(original, "Sent")], unlinks: 0 }) ?? [];
    await e.run((i as Intent).id);
    const second = await executor({
      transportOpts: {
        capabilities: { transport: "multistep", recover: "stages" } as { recover: "stages" },
      },
    });
    second.t.recover = async () => ({ state: "unknown", stage: "sent" });
    await second.e.recoverAll();
    expect(stateOf((i as Intent).id).state).toBe("quarantined");
  });

  it("#3 a multi-step transport with the revision unchanged is not retried either: quarantined", async () => {
    const original = item();
    const { e, t } = await executor();
    // The call dies before anything is written: the item keeps its revision.
    t.apply = async () => {
      throw new Error("helper died");
    };
    const [i] = e.prepare("b", { intents: [update(original, "Maybe")], unlinks: 0 }) ?? [];
    expect(await e.run((i as Intent).id)).toEqual({ kind: "lost" });
    const second = await executor({
      transportOpts: {
        capabilities: { transport: "multistep", recover: "stages" } as { recover: "stages" },
      },
    });
    second.t.recover = async () => ({ state: "unknown", stage: "sent" });
    await second.e.recoverAll();
    expect(stateOf((i as Intent).id).state).toBe("quarantined");
    expect(store.items.get(original.ref.id)?.title).toBe("Buy milk");
  });

  it("#3 even on the one-step transport, a stage past the single step is not inferred", async () => {
    const original = item();
    const { e, t } = await executor();
    t.faults.loseNextResponse = 1;
    const [i] = e.prepare("b", { intents: [update(original, "Written")], unlinks: 0 }) ?? [];
    await e.run((i as Intent).id);
    const second = await executor();
    second.t.recover = async () => ({ state: "unknown", stage: "second-step" });
    await second.e.recoverAll();
    expect(stateOf((i as Intent).id).state).toBe("quarantined");
  });

  it("#4 a fake Apple transport does not authorize an LFCP port that is not the offline test port", async () => {
    let called = 0;
    const { e } = await executor({
      lfcp: {
        receipt: async () => undefined,
        commitGuarded: async () => {
          called++;
          throw new Error("real write port reached");
        },
      },
    });
    const n = {
      ...create("x"),
      direction: "to_lfcp" as const,
      kind: "create_task",
      payload: { resource: R_HEX, intents: [] },
    };
    const [i] = e.prepare("b", { intents: [n], unlinks: 0 }) ?? [];
    await e.run((i as Intent).id);
    expect(called).toBe(0);
  });

  it("#5 the operation sent is the one checked: a payload whose kind differs is refused before any call", async () => {
    const original = item();
    const { e, t } = await executor();
    let called = 0;
    t.apply = async (op) => {
      called++;
      throw new Error(`unexpected ${op.kind}`);
    };
    const n = {
      ...update(original, "x"),
      payload: {
        kind: "marker_retire",
        ref: original.ref,
        markerUrl: "lfcp://bridge/test",
        expect: { rev: original.rev },
      },
    };
    expect(() => e.prepare("b", { intents: [n], unlinks: 0 })).toThrow(/does not match/);
    // A durable intent that got inconsistent anyway (an older build, a hand edit) is refused at run.
    const [ok] = e.prepare("b", { intents: [update(original, "y")], unlinks: 0 }) ?? [];
    db.prepare("UPDATE intents SET payload_json = ? WHERE id = ?").run(
      JSON.stringify(n.payload),
      (ok as Intent).id,
    );
    expect(await e.run((ok as Intent).id)).toMatchObject({
      kind: "refused",
      reason: "invalid_intent",
    });
    expect(called).toBe(0);
  });

  it("#5 a to_lfcp intent must address its binding's section, a create its binding's list", async () => {
    const { e } = await executor();
    const otherSection = {
      ...create("x"),
      direction: "to_lfcp" as const,
      kind: "create_task",
      payload: { resource: "bb".repeat(32), intents: [] },
    };
    expect(() => e.prepare("b", { intents: [otherSection], unlinks: 0 })).toThrow(/does not match/);
    const otherList = {
      ...create("y"),
      payload: {
        kind: "create",
        list: "L-other",
        linkUrl: "lfcp://task/T2?s=R",
        set: { title: "y" },
      },
    };
    expect(() => e.prepare("b", { intents: [otherList], unlinks: 0 })).toThrow(/does not match/);
    const otherInstallation = { ...create("z"), installationId: "elsewhere" };
    expect(() => e.prepare("b", { intents: [otherInstallation], unlinks: 0 })).toThrow(
      /does not match/,
    );
  });
});

describe("the run process's write gate (PR 9b)", () => {
  it("with permit, a non-fake transport may be given and permit decides each effect", async () => {
    const it0 = item();
    const t = await transport();
    Object.defineProperty(t, "id", { value: "eventkit" });
    const allowed = new Set<string>();
    const e = new Executor({
      db,
      transport: t,
      lfcp: noLfcp,
      gates: gates(),
      handler,
      effects: { enabled: true, permit: (i) => allowed.has(i.id) },
    });
    const [i] = e.prepare("b", { intents: [update(it0, "Gated")], unlinks: 0 }) ?? [];
    expect(await e.run((i as Intent).id)).toEqual({ kind: "effects_off" });
    expect(store.items.get(it0.ref.id)?.title).toBe("Buy milk");
    allowed.add((i as Intent).id);
    expect(await e.run((i as Intent).id)).toEqual({ kind: "finalized" });
    expect(store.items.get(it0.ref.id)?.title).toBe("Gated");
    // Without permit, a non-fake transport is still refused.
    expect(
      () =>
        new Executor({
          db,
          transport: t,
          lfcp: noLfcp,
          gates: gates(),
          handler,
          effects: { enabled: true },
        }),
    ).toThrow(/effects are off/);
  });
});
