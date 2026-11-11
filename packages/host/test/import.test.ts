// New reminders → Tasks (D-010 §6.2, R2-9, PR 11): e2e E4 of r2 §10.3 on a
// real section replica and the fake account. The new Task goes to the
// section's end (sectionEnd) through commitGuarded, its id is stable for the
// reminder, the link is pending_lfcp_create until finalize; restore_url
// puts our link on the reminder, a person's URL is never touched; the
// import limit (r2 §7.2) and import_ambiguous (R2-9 (4)) stop imports.

import { receiptOf } from "@openlfcp/client";
import { afterEach, describe, expect, it } from "vitest";
import type { Intent } from "../src/index.js";
import { type Bridge, bridge } from "./support/bridge.js";

let b: Bridge;
afterEach(async () => {
  await b?.close();
});

const tasksTitled = (title: string) => b.order().filter((id) => b.now(id)?.title === title);
const reminder = (title: string) => {
  const r = b.reminders().find((x) => x.title === title);
  if (r === undefined) throw new Error(`no reminder ${title}`);
  return r;
};

describe("E4: a new reminder → a Task at the section's end, our link back on it", () => {
  it("create_task through commitGuarded, pending → linked (origin apple), then restore_url", async () => {
    b = await bridge();
    const first = await b.task("Existing");
    await b.sync();
    await b.sync();
    const r = b.person.create(b.list.id, "Call mom");
    b.person.edit(r.ref, { dueDate: "2026-11-12", dueTime: "18:00" });
    (b.store.items.get(r.ref.id) as { priority: number }).priority = 2;
    const one = await b.sync();
    expect(one.prepared.map((i) => [i.direction, i.kind])).toEqual([["to_lfcp", "create_task"]]);
    expect(one.outcomes).toEqual([{ kind: "finalized" }]);
    const [id] = tasksTitled("Call mom");
    expect(b.now(id as string)).toMatchObject({
      title: "Call mom",
      status: "todo",
      priority: "high",
      due: "2026-11-12", // the date only: the time is personal (B12)
      assignees: {},
    });
    // At the section's end, after the existing Task.
    expect(b.order()).toEqual([first.id, id]);
    expect(b.linkOf(r.ref.id)).toMatchObject({
      task_id: id,
      state: "linked",
      origin: "apple",
      url_state: "ours",
    });
    // Next pass: our link is put back on the reminder (its URL was empty).
    const two = await b.sync();
    expect(two.prepared.map((i) => i.kind)).toEqual(["restore_url"]);
    expect(reminder("Call mom").linkUrl).toBe(b.linkOf(r.ref.id)?.rem_url);
    expect(reminder("Call mom").linkUrl).toMatch(/^lfcp:\/\/task\//);
    // Then nothing: both sides agree.
    expect((await b.sync()).plan.intents).toEqual([]);
  });

  it("several new reminders keep their order at the end", async () => {
    b = await bridge();
    for (const t of ["One", "Two", "Three"]) b.person.create(b.list.id, t);
    await b.sync();
    expect(b.order().map((id) => b.now(id).title)).toEqual(["One", "Two", "Three"]);
  });

  it("a person's https URL is kept: user_replaced, no restore_url", async () => {
    b = await bridge();
    const r = b.person.create(b.list.id, "Read article", { url: "https://example.com/a" });
    await b.sync();
    expect(b.linkOf(r.ref.id)).toMatchObject({ state: "linked", url_state: "user_replaced" });
    expect((await b.sync()).plan.intents).toEqual([]);
    expect(reminder("Read article").linkUrl).toBe("https://example.com/a");
  });

  it("completed reminders and ownership markers are not imported", async () => {
    b = await bridge();
    b.person.create(b.list.id, "Done long ago", { completed: true });
    b.person.create(b.list.id, "LFCP bridge · do not delete", {
      url: `lfcp://bridge/abcdef0123456789?r=${"aa".repeat(32)}`,
      completed: true,
    });
    b.person.create(b.list.id, "Open marker?", {
      url: `lfcp://bridge/abcdef0123456789?r=${"aa".repeat(32)}`,
    });
    const r = await b.sync();
    expect(r.plan.intents).toEqual([]);
    expect(b.order()).toEqual([]);
  });
});

describe("E4: idempotent — a crash between the steps, or a pass before the effect, never makes two Tasks", () => {
  for (const point of ["after_effecting", "after_effect", "after_result"] as const) {
    it(`crash ${point}, restart: one Task, one link`, async () => {
      b = await bridge();
      b.person.create(b.list.id, "Buy stamps");
      const plan = await b.pass.dryRun("b");
      if (plan.kind !== "planned") throw new Error(plan.kind);
      const crashing = b.executor(point);
      const [i] = crashing.prepare("b", { intents: plan.plan.intents, unlinks: 0 }) ?? [];
      await expect(crashing.run((i as Intent).id)).rejects.toThrow(/crash/);
      // Restart: recovery, then passes.
      const restarted = b.executor();
      await restarted.recoverAll();
      await restarted.runDue();
      await b.sync();
      await b.sync();
      expect(tasksTitled("Buy stamps")).toHaveLength(1);
      expect(b.db.prepare("SELECT count(*) AS n FROM links").get()).toEqual({ n: 1 });
      expect(await receiptOf(b.storage, b.R, (i as Intent).operationId)).toBeDefined();
    });
  }

  it("a pass between prepare and effect matches the pending link: no second import", async () => {
    b = await bridge();
    const r = b.person.create(b.list.id, "Pay rent");
    const first = await b.pass.dryRun("b");
    if (first.kind !== "planned") throw new Error(first.kind);
    const [i] = b.e.prepare("b", { intents: first.plan.intents, unlinks: 0 }) ?? [];
    expect(b.linkOf(r.ref.id)).toMatchObject({ state: "pending_lfcp_create", origin: "apple" });
    const second = await b.pass.dryRun("b");
    if (second.kind !== "planned") throw new Error(second.kind);
    expect(second.plan.intents).toEqual([]);
    expect(await b.e.run((i as Intent).id)).toEqual({ kind: "finalized" });
    expect(tasksTitled("Pay rent")).toHaveLength(1);
  });

  it("the Task's id is stable for the reminder: after a lost bridge.sqlite step the same import is superseded, not a second Task", async () => {
    // filter mine: an imported Task (no assignee) gets no projection of its own.
    b = await bridge({ filter: "mine" });
    b.person.create(b.list.id, "Water plants");
    const plan = await b.pass.dryRun("b");
    if (plan.kind !== "planned") throw new Error(plan.kind);
    const crashing = b.executor("after_effect");
    const [i] = crashing.prepare("b", { intents: plan.plan.intents, unlinks: 0 }) ?? [];
    await expect(crashing.run((i as Intent).id)).rejects.toThrow(/crash/);
    const [id] = tasksTitled("Water plants");
    // The commit is in LFCP, but bridge.sqlite lost the intent and its link (an older backup).
    b.db.prepare("DELETE FROM intents").run();
    b.db.prepare("DELETE FROM links").run();
    const again = await b.sync();
    expect(again.prepared.map((x) => [x.kind, x.taskId])).toEqual([["create_task", id]]);
    expect(again.outcomes).toEqual([{ kind: "superseded", reason: "basis_changed" }]);
    expect(tasksTitled("Water plants")).toHaveLength(1);
  });
});

describe("guards on imports", () => {
  it("R2-9 (4): a pending import whose reminder vanished → hold import_ambiguous, new reminders wait", async () => {
    b = await bridge();
    const r = b.person.create(b.list.id, "First");
    const plan = await b.pass.dryRun("b");
    if (plan.kind !== "planned") throw new Error(plan.kind);
    b.e.prepare("b", { intents: plan.plan.intents, unlinks: 0 });
    b.person.delete(r.ref);
    b.person.create(b.list.id, "Second");
    const next = await b.sync();
    expect(next.plan.holds).toEqual(["import_ambiguous"]);
    expect(next.plan.items.map((x) => x.kind)).toEqual(["import_blocked"]);
    expect(b.db.prepare("SELECT reason FROM binding_holds").all()).toEqual([
      { reason: "import_ambiguous" },
    ]);
    expect(tasksTitled("Second")).toEqual([]);
  });

  it("more than 10 new Tasks an hour: hold guard_mass_import, nothing prepared (r2 §7.2)", async () => {
    b = await bridge();
    for (let k = 0; k < 11; k++) b.person.create(b.list.id, `New ${k}`);
    const r = await b.sync();
    expect(r.prepared).toEqual([]);
    expect(b.db.prepare("SELECT reason FROM binding_holds").all()).toEqual([
      { reason: "guard_mass_import" },
    ]);
    expect(b.order()).toEqual([]);
  });

  it("10 pass; in strict mode (24 h after approve) more than 3 is a hold", async () => {
    b = await bridge();
    for (let k = 0; k < 10; k++) b.person.create(b.list.id, `New ${k}`);
    expect((await b.sync()).prepared).toHaveLength(10);
    await b.close();
    b = await bridge({ strict: true });
    for (let k = 0; k < 4; k++) b.person.create(b.list.id, `New ${k}`);
    expect((await b.sync()).prepared).toEqual([]);
    expect(b.db.prepare("SELECT reason FROM binding_holds").all()).toEqual([
      { reason: "guard_mass_import" },
    ]);
  });
});

describe("review PR 11", () => {
  it("#20 B19: an unknown restore_url is quarantined; no new opKey until a person decides", async () => {
    b = await bridge();
    const r = b.person.create(b.list.id, "A");
    await b.sync();
    b.t.faults.loseNextResponse = 1;
    const lost = await b.sync();
    expect(lost.outcomes).toEqual([{ kind: "lost" }]);
    b.person.edit(r.ref, { url: null });
    await b.e.recoverAll();
    const q = b.db.prepare("SELECT id, state FROM intents WHERE kind = 'restore_url'").get() as {
      id: string;
      state: string;
    };
    expect(q.state).toBe("quarantined");
    expect(b.db.prepare("SELECT field, kind FROM conflicts WHERE intent_id = ?").all(q.id)).toEqual(
      [{ field: "url", kind: "unknown_outcome" }],
    );
    const next = await b.sync();
    expect(next.prepared.filter((i) => i.kind === "restore_url")).toEqual([]);
    // Other fields still go.
    b.person.edit(r.ref, { title: "A2" });
    expect((await b.sync()).prepared.map((i) => [i.direction, i.fields])).toEqual([
      ["to_lfcp", ["title"]],
    ]);
    // A person resolves it: a new restore_url, a new opKey.
    b.db
      .prepare("UPDATE conflicts SET resolved_at = ?, resolution = 'lfcp' WHERE intent_id = ?")
      .run(new Date().toISOString(), q.id);
    const after = await b.sync();
    expect(after.prepared.map((i) => i.kind)).toEqual(["restore_url"]);
    expect((after.prepared[0] as { id: string }).id).not.toBe(q.id);
  });

  it("#20 lost before the effect (recover not_started): the same opKey is run again, no quarantine", async () => {
    b = await bridge();
    b.person.create(b.list.id, "A");
    await b.sync();
    const crashing = b.executor("after_effecting");
    const r = await b.pass.dryRun("b");
    if (r.kind !== "planned") throw new Error(r.kind);
    const applied = await b.links.apply("b", r.plan, { executor: crashing });
    if (applied.kind !== "applied") throw new Error(applied.kind);
    const [i] = applied.prepared;
    await expect(crashing.run((i as Intent).id)).rejects.toThrow(/crash/);
    const restarted = b.executor();
    expect(await restarted.recoverAll()).toEqual([{ kind: "finalized" }]);
    expect(b.reminders()[0]?.linkUrl).toMatch(/^lfcp:\/\/task\//);
  });

  it("#21 a person's URL put on a linked reminder makes the link user_replaced; cleared later, it stays the person's", async () => {
    b = await bridge();
    const r = b.person.create(b.list.id, "A");
    await b.sync();
    await b.sync();
    expect(b.linkOf(r.ref.id)?.url_state).toBe("ours");
    b.person.edit(r.ref, { url: "https://example.com/personal" });
    await b.sync();
    expect(b.linkOf(r.ref.id)).toMatchObject({
      url_state: "user_replaced",
      rem_url: "https://example.com/personal",
    });
    b.person.edit(r.ref, { url: null });
    const next = await b.sync();
    expect(next.plan.intents.filter((i) => i.kind === "restore_url")).toEqual([]);
    expect(b.linkOf(r.ref.id)?.state).toBe("linked");
  });

  it("#22 the dry run counts each import once, as apply does: 6/10/11, strict 2/3/4", async () => {
    const guards = async (n: number, strict = false) => {
      b = await bridge({ strict });
      for (let k = 0; k < n; k++) b.person.create(b.list.id, `New ${k}`);
      const r = await b.pass.dryRun("b");
      if (r.kind !== "planned") throw new Error(r.kind);
      const held = r.guards.includes("guard_mass_import");
      const applied = await b.sync();
      expect(applied.applied.kind === "held").toBe(held);
      await b.close();
      return held;
    };
    expect([await guards(6), await guards(10), await guards(11)]).toEqual([false, false, true]);
    expect([await guards(2, true), await guards(3, true), await guards(4, true)]).toEqual([
      false,
      false,
      true,
    ]);
    b = await bridge();
  });

  it("a failing pending link rolls back its intent too (one transaction)", async () => {
    b = await bridge();
    b.person.create(b.list.id, "Atomic");
    const r = await b.pass.dryRun("b");
    if (r.kind !== "planned") throw new Error(r.kind);
    b.db.exec(
      "CREATE TRIGGER abort_pending AFTER INSERT ON links BEGIN SELECT RAISE(ABORT, 'abort'); END",
    );
    expect(() => b.e.prepare("b", { intents: r.plan.intents, unlinks: 0 })).toThrow(/abort/);
    expect(b.db.prepare("SELECT count(*) AS n FROM intents").get()).toEqual({ n: 0 });
    expect(b.db.prepare("SELECT count(*) AS n FROM links").get()).toEqual({ n: 0 });
  });

  it("crash after finalize: still one Task, one link", async () => {
    b = await bridge();
    b.person.create(b.list.id, "Finalized");
    const r = await b.pass.dryRun("b");
    if (r.kind !== "planned") throw new Error(r.kind);
    const e = b.executor("after_finalize");
    const [i] = e.prepare("b", { intents: r.plan.intents, unlinks: 0 }) ?? [];
    await expect(e.run((i as Intent).id)).rejects.toThrow(/crash/);
    const restarted = b.executor();
    await restarted.recoverAll();
    await restarted.runDue();
    await b.sync();
    await b.sync();
    expect(tasksTitled("Finalized")).toHaveLength(1);
    expect(b.db.prepare("SELECT count(*) AS n FROM links").get()).toEqual({ n: 1 });
  });
});
