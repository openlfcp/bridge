// Bootstrap and ownership (D-010 r4 §6.5, B16, B17) on the fake transport of the adapter.

import {
  FakePerson,
  FakeStore,
  FakeTransport,
  type FakeTransportOptions,
} from "@openlfcp/bridge-reminders/fake";
import { type ListRef, MemoryKV } from "@openlfcp/bridge-reminders/transport";
import { beforeEach, describe, expect, it } from "vitest";
import { Bootstrap, LIST_PREFIX, VERIFY_PREFIX } from "../src/bootstrap.js";
import { Holds, Journal, openBridgeDatabase } from "../src/index.js";
import { markerUrl, OwnershipGuard, parseMarker } from "../src/ownership.js";

const ME = "inst-me";
const R = "lfcp1:resource-A";

async function rig(opts: FakeTransportOptions = {}) {
  const db = openBridgeDatabase(":memory:");
  db.prepare(
    "INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES ('i1', '/x', 'p', 'r', 'Mac', '2026-11-10T00:00:00Z')",
  ).run();
  const store = new FakeStore();
  const person = new FakePerson(store);
  const transport = new FakeTransport(store, opts);
  await transport.open({
    installationKey: "i1",
    state: new MemoryKV(),
    scope: { listTitlePrefixes: [LIST_PREFIX, VERIFY_PREFIX], listIds: [] },
  });
  let stopped = false;
  const journal = new Journal(db);
  const holds = new Holds(db);
  const boot = new Bootstrap({ db, journal, transport, instanceId: ME, stopped: () => stopped });
  return {
    db,
    store,
    person,
    transport,
    journal,
    holds,
    boot,
    stop: (v: boolean) => (stopped = v),
  };
}

const bindReq = { installationId: "i1", resourceId: R, section: "Work" };
const binding = (db: ReturnType<typeof openBridgeDatabase>, id: string) =>
  db.prepare("SELECT * FROM bindings WHERE id = ?").get(id) as Record<string, unknown>;
const listsTitled = (store: FakeStore, title: string) =>
  [...store.lists.values()].filter((l) => l.title === title);

describe("markers", () => {
  it("round-trip instance and resource", () => {
    const url = markerUrl("inst 1", "lfcp1:a#section:b");
    expect(url.startsWith("lfcp://bridge/")).toBe(true);
    expect(parseMarker(url)).toEqual({ instance: "inst 1", resource: "lfcp1:a#section:b" });
    expect(parseMarker("lfcp://task/x")).toBeUndefined();
  });
});

describe("bind", () => {
  it("creates a new list and the marker, then waits for a dry run", async () => {
    const { db, store, boot } = await rig();
    const r = await boot.bind(bindReq);
    expect(r).toMatchObject({ state: "pending_dry_run", title: "LFCP · Work" });
    if (r.state !== "pending_dry_run") return;
    const b = binding(db, r.bindingId);
    expect(b).toMatchObject({
      state: "pending_dry_run",
      bootstrap_step: "done",
      target_ref: r.list,
      verification: 0,
    });
    const marker = [...store.items.values()].find((i) => i.linkUrl === markerUrl(ME, R));
    expect(marker).toMatchObject({ completed: true, list: r.list });
    expect(JSON.parse(String(b.marker_ref))).toMatchObject({ id: marker?.id });
    expect(db.prepare("SELECT step, state FROM bootstrap_ops ORDER BY step").all()).toEqual([
      { step: "list", state: "done" },
      { step: "marker", state: "done" },
    ]);
  });

  it("never adopts an existing list by title: list_exists, nothing written (B17)", async () => {
    const { db, store, person, boot } = await rig();
    person.createList("LFCP · Work");
    const before = store.items.size;
    const r = await boot.bind(bindReq);
    expect(r).toMatchObject({ state: "refused", reason: "list_exists" });
    expect(binding(db, r.bindingId as string).state).toBe("removed");
    expect(listsTitled(store, "LFCP · Work")).toHaveLength(1);
    expect(store.items.size).toBe(before);
  });

  it("refuses when another bridge's marker for the section exists anywhere", async () => {
    const { store, person, boot } = await rig();
    const other = person.createList("LFCP · Work (old Mac)");
    person.create(other.id, "LFCP bridge · не удалять", {
      url: markerUrl("inst-other", R),
      completed: true,
    });
    const r = await boot.bind(bindReq);
    expect(r).toMatchObject({ state: "refused", reason: "foreign_bridge" });
    expect(listsTitled(store, "LFCP · Work")).toHaveLength(0);
  });

  it("refuses under STOP, without TCC access, and on an incomplete listing", async () => {
    const a = await rig();
    a.stop(true);
    expect(await a.boot.bind(bindReq)).toMatchObject({ state: "refused", reason: "stop" });
    const b = await rig();
    b.transport.setStatus({ state: "needs_human", reason: "tcc_denied" });
    expect(await b.boot.bind(bindReq)).toMatchObject({ state: "refused", reason: "transport" });
    const c = await rig();
    c.transport.faults.incompleteReads = true;
    expect(await c.boot.bind(bindReq)).toMatchObject({ state: "refused", reason: "incomplete" });
    for (const x of [a, b, c]) expect(x.store.lists.size).toBe(1); // only the default list
  });

  it("a foreign marker that appears after the list stops the marker step (checked before every effect)", async () => {
    const { store, person, transport, boot } = await rig();
    const original = transport.createList.bind(transport);
    transport.createList = async (op) => {
      const l = await original(op);
      const other = person.createList("Elsewhere");
      person.create(other.id, "marker", { url: markerUrl("inst-other", R), completed: true });
      return l;
    };
    const r = await boot.bind(bindReq);
    expect(r).toMatchObject({ state: "refused", reason: "foreign_bridge" });
    expect([...store.items.values()].some((i) => i.linkUrl === markerUrl(ME, R))).toBe(false);
  });

  it("an installation that is not active refuses the bootstrap", async () => {
    const { db, store, boot } = await rig();
    db.prepare("UPDATE installations SET status = 'frozen'").run();
    expect(await boot.bind(bindReq)).toMatchObject({ state: "refused" });
    expect(listsTitled(store, "LFCP · Work")).toHaveLength(0);
  });

  it("a verification binding gets an 'LFCP Verify · …' list", async () => {
    const { db, boot } = await rig();
    const r = await boot.bind({ ...bindReq, verification: true });
    expect(r).toMatchObject({ state: "pending_dry_run", title: "LFCP Verify · Work" });
    expect(binding(db, (r as { bindingId: string }).bindingId).verification).toBe(1);
  });

  it("a second bind of the same section is refused (already bound)", async () => {
    const { boot } = await rig();
    await boot.bind(bindReq);
    expect(await boot.bind(bindReq)).toMatchObject({ state: "refused", reason: "already_bound" });
  });
});

describe("unknown outcomes (B17, review PR 6 r2: never bypassed automatically)", () => {
  it("lost createList answer → unknown_outcome; a title match assigns nothing; the person picks by id", async () => {
    const { db, store, person, transport, boot } = await rig();
    transport.faults.loseNextResponse = 1;
    const r = await boot.bind(bindReq);
    expect(r).toMatchObject({ state: "unknown_outcome", step: "list" });
    if (r.state !== "unknown_outcome") return;
    expect(binding(db, r.bindingId)).toMatchObject({
      target_ref: null,
      marker_ref: null,
      state: "bootstrapping",
    });
    expect([...store.items.values()].some((i) => i.linkUrl?.startsWith("lfcp://bridge/"))).toBe(
      false,
    );
    // Meanwhile the person makes a list with the same title: two candidates, none assigned.
    const theirs = person.createList("LFCP · Work");
    const again = await boot.resume(r.bindingId);
    expect(again).toMatchObject({ state: "unknown_outcome", step: "list" });
    expect(again.state === "unknown_outcome" ? again.candidates : []).toHaveLength(2);
    // The person knows which one the bridge created.
    const created = listsTitled(store, "LFCP · Work").find((l) => l.id !== theirs.id);
    const done = await boot.resolveList(r.bindingId, created?.id as string);
    expect(done).toMatchObject({ state: "pending_dry_run", list: created?.id });
  });

  it("'none' while a list with the title exists is refused; after renaming, a new attempt with a new key", async () => {
    const { store, person, transport, boot } = await rig();
    transport.faults.loseNextResponse = 1;
    const r = await boot.bind(bindReq);
    const id = (r as { bindingId: string }).bindingId;
    expect(await boot.resolveList(id, "none")).toMatchObject({
      state: "refused",
      reason: "list_exists",
    });
    const leftover = listsTitled(store, "LFCP · Work")[0];
    person.renameList(leftover?.id as ListRef, "Old work");
    const done = await boot.resolveList(id, "none");
    expect(done).toMatchObject({ state: "pending_dry_run" });
    expect(listsTitled(store, "LFCP · Work")).toHaveLength(1);
  });

  it("lost marker answer: the marker record with its exact url proves it was written", async () => {
    const { db, transport, boot } = await rig();
    // Two writes: createList (kept), marker_create (answer lost).
    const original = transport.apply.bind(transport);
    let first = true;
    transport.apply = async (op) => {
      if (op.kind === "marker_create" && first) {
        first = false;
        transport.faults.loseNextResponse = 1;
      }
      return original(op);
    };
    const r = await boot.bind(bindReq);
    expect(r).toMatchObject({ state: "pending_dry_run" });
    expect(binding(db, (r as { bindingId: string }).bindingId).marker_ref).not.toBeNull();
  });

  it("resolveList refuses when the outcome is not unknown", async () => {
    const { boot } = await rig();
    const r = await boot.bind(bindReq);
    expect(await boot.resolveList((r as { bindingId: string }).bindingId, "none")).toMatchObject({
      reason: "not_unknown",
    });
  });
});

describe("unbind", () => {
  it("retires only this bridge's marker; the list stays", async () => {
    const { db, store, boot } = await rig();
    const r = await boot.bind(bindReq);
    const id = (r as { bindingId: string }).bindingId;
    expect(await boot.unbind(id)).toEqual({ retired: true });
    expect(binding(db, id).state).toBe("removed");
    expect([...store.items.values()].some((i) => i.linkUrl === markerUrl(ME, R))).toBe(false);
    expect(listsTitled(store, "LFCP · Work")).toHaveLength(1);
  });
});

describe("ownership check (start, wake, every full pass)", () => {
  let x: Awaited<ReturnType<typeof rig>>;
  let id: string;
  let guard: OwnershipGuard;
  beforeEach(async () => {
    x = await rig();
    id = ((await x.boot.bind(bindReq)) as { bindingId: string }).bindingId;
    guard = new OwnershipGuard(x.db, x.holds, x.journal, x.transport, ME);
  });

  it("own marker, none foreign: checked; reset on wake", async () => {
    expect((await guard.checkAll()).get(id)).toEqual({ state: "ok" });
    expect(guard.isChecked(id)).toBe(true);
    guard.reset();
    expect(guard.isChecked(id)).toBe(false);
  });

  it("a foreign marker sets foreign_bridge; it lifts when that marker is gone", async () => {
    const other = x.person.createList("Elsewhere");
    const m = x.person.create(other.id, "marker", {
      url: markerUrl("inst-other", R),
      completed: true,
    });
    expect((await guard.checkAll()).get(id)).toMatchObject({ state: "foreign" });
    expect(x.holds.has(id, "foreign_bridge")).toBe(true);
    expect(guard.isChecked(id)).toBe(false);
    x.person.delete(m.ref);
    await guard.checkAll();
    expect(x.holds.has(id, "foreign_bridge")).toBe(false);
    expect(guard.isChecked(id)).toBe(true);
  });

  it("own marker gone: ownership_lost, never lifted or re-created automatically", async () => {
    const own = [...x.store.items.values()].find((i) => i.linkUrl === markerUrl(ME, R));
    x.person.delete({ id: own?.id as string });
    expect((await guard.checkAll()).get(id)).toEqual({ state: "lost" });
    expect(x.holds.has(id, "ownership_lost")).toBe(true);
    await guard.checkAll();
    expect(x.holds.has(id, "ownership_lost")).toBe(true);
    expect([...x.store.items.values()].some((i) => i.linkUrl === markerUrl(ME, R))).toBe(false);
    expect(guard.isChecked(id)).toBe(false);
  });

  it("an incomplete search checks nothing and sets nothing", async () => {
    x.transport.faults.incompleteReads = true;
    expect((await guard.checkAll()).get(id)).toEqual({ state: "incomplete" });
    expect(x.holds.of(id)).toEqual([]);
    expect(guard.isChecked(id)).toBe(false);
  });
});
