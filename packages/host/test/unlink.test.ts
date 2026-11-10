// Unlinking and the filter (D-010 §6.1–§6.4, B4, B11; PR 12): e2e E5 and E6
// of r2 §10.3 on a real section replica and the fake account, R2-9 (3),
// task_gone, quarantine and the recurrence lock. The bridge deletes nothing:
// a reminder that leaves synchronization stays with the person.

import {
  assign,
  deleteTask,
  restoreTask,
  setDue,
  setTitle,
  unassign,
} from "@openlfcp/shared-objects";
import { afterEach, describe, expect, it } from "vitest";
import type { Intent } from "../src/index.js";
import { type Bridge, bridge } from "./support/bridge.js";

let b: Bridge;
afterEach(async () => {
  await b?.close();
});

/** A Task projected and linked. */
async function linked(title = "A", over: Parameters<Bridge["task"]>[1] = {}) {
  const task = await b.task(title, over);
  const first = await b.sync();
  expect(first.outcomes).toEqual([{ kind: "finalized" }]);
  expect(b.link(task.id)?.state).toBe("linked");
  return task;
}
const reminderOf = (title: string) => {
  const r = b.reminders().find((x) => x.title === title);
  if (r === undefined) throw new Error(`no reminder ${title}`);
  return r;
};
const journalKeys = () =>
  (
    b.db.prepare("SELECT key FROM journal WHERE key LIKE 'link.%' ORDER BY id").all() as {
      key: string;
    }[]
  ).map((r) => r.key);

describe("E5: deleted or moved in Apple → unlinked (B4); many at once → hold", () => {
  it("the person deletes the reminder: unlinked(deleted_in_apple); the Task stays, it does not come back", async () => {
    b = await bridge();
    const task = await linked("Milk");
    b.person.delete(reminderOf("Milk").ref);
    const r = await b.sync();
    expect(r.plan.transitions).toEqual([{ taskId: task.id, kind: "apple_missing" }]);
    expect(b.link(task.id)).toMatchObject({ state: "unlinked", state_reason: "deleted_in_apple" });
    expect(b.now(task.id).lifecycle).toBe("active");
    expect(journalKeys()).toEqual(["link.unlinked"]);
    // B4: not re-created while unlinked.
    const again = await b.sync();
    expect(again.plan.intents).toEqual([]);
    expect(b.reminders()).toEqual([]);
  });

  it("the person moves it to another list: unlinked(moved_out); the reminder is untouched there", async () => {
    b = await bridge();
    const task = await linked("Bread");
    const other = b.person.createList("Groceries");
    const before = reminderOf("Bread");
    b.person.edit(before.ref, { moveTo: other.id });
    await b.sync();
    expect(b.link(task.id)).toMatchObject({ state: "unlinked", state_reason: "moved_out" });
    // Later LFCP edits do not reach it.
    await b.edit(setTitle(b.now(task.id), "Rye bread"));
    expect((await b.sync()).plan.intents).toEqual([]);
    const after = reminderOf("Bread");
    expect(after.list).toBe(other.id);
    expect(after.title).toBe("Bread");
    expect(b.reminders(other.id)).toHaveLength(1);
  });

  it("an incomplete find decides nothing (B4): the link waits", async () => {
    b = await bridge();
    const task = await linked("Tea");
    b.person.delete(reminderOf("Tea").ref);
    const find = b.t.find.bind(b.t);
    b.t.find = async (q, s) => ({ ...(await find(q, s)), complete: false });
    const r = await b.sync();
    expect(r.applied).toMatchObject({ kind: "applied", outcomes: [{ result: "waiting" }] });
    expect(b.link(task.id)?.state).toBe("linked");
  });

  it("deleting more than max(3, 10 %) at once: hold guard_mass_unlink, nothing unlinked (r2 §7.2)", async () => {
    b = await bridge();
    const tasks = [];
    for (const t of ["A", "B", "C", "D"]) tasks.push(await b.task(t));
    await b.sync();
    for (const r of b.reminders()) b.person.delete(r.ref);
    const r = await b.sync();
    expect(r.applied).toEqual({ kind: "held", holds: ["guard_mass_unlink"] });
    for (const t of tasks) expect(b.link(t.id)?.state).toBe("linked");
    expect(b.db.prepare("SELECT reason FROM binding_holds").all()).toEqual([
      { reason: "guard_mass_unlink" },
    ]);
  });

  it("in strict mode (24 h after approve) more than one is already a hold", async () => {
    b = await bridge({ strict: true });
    const a = await b.task("A");
    await b.task("B");
    await b.sync();
    for (const r of b.reminders()) b.person.delete(r.ref);
    expect((await b.sync()).applied.kind).toBe("held");
    expect(b.link(a.id)?.state).toBe("linked");
  });
});

describe("E6: out of the filter → out_of_filter, the reminder intact; back → the same reminder relinked", () => {
  it("reassigned away and back (filter mine)", async () => {
    b = await bridge({ filter: "mine" });
    const task = await linked("Report");
    const before = reminderOf("Report");
    await b.edit(unassign(b.now(task.id), b.root));
    const out = await b.sync();
    expect(out.plan.transitions).toEqual([{ taskId: task.id, kind: "out_of_filter" }]);
    expect(b.link(task.id)?.state).toBe("out_of_filter");
    expect(journalKeys()).toEqual(["link.out_of_filter"]);
    // B11: the reminder stays, untouched, and is no longer synchronized.
    expect(reminderOf("Report")).toEqual(before);
    await b.edit(setTitle(b.now(task.id), "Report v2"));
    expect((await b.sync()).plan.intents).toEqual([]);
    expect(reminderOf("Report").rev).toBe(before.rev);
    // Back in the filter: the same reminder, agreed as on a first link (LFCP wins).
    await b.edit(assign(b.now(task.id), b.root));
    const back = await b.sync();
    expect(back.plan.transitions).toEqual([{ taskId: task.id, kind: "relink", item: before.ref }]);
    expect(b.link(task.id)?.state).toBe("linked");
    await b.sync();
    expect(b.reminders()).toHaveLength(1);
    expect(b.reminders()[0]).toMatchObject({ ref: before.ref, title: "Report v2" });
  });

  it("back in the filter, agreed as on a first link: the person's edit while away does not flow into LFCP", async () => {
    b = await bridge({ filter: "mine" });
    const task = await linked("Report");
    await b.edit(unassign(b.now(task.id), b.root));
    await b.sync();
    b.person.edit(reminderOf("Report").ref, { title: "My own title" });
    await b.edit(assign(b.now(task.id), b.root));
    await b.sync();
    const r = await b.sync();
    expect(r.prepared.map((i) => i.direction)).toEqual(["to_apple"]);
    expect(b.now(task.id).title).toBe("Report");
    expect(b.reminders()[0]?.title).toBe("Report");
  });

  it("no conclusion from LFCP absence while LFCP is not live", async () => {
    b = await bridge({ filter: "mine" });
    const task = await linked("Report");
    await b.edit(unassign(b.now(task.id), b.root));
    b.lfcp.live = false;
    const r = await b.sync();
    expect(r.plan.transitions).toEqual([]);
    expect(r.plan.waiting).toEqual([{ taskId: task.id, waiting: "lfcp_not_live" }]);
    expect(b.link(task.id)?.state).toBe("linked");
  });

  it("R2-9 (3): back in the filter, the reminder was moved meanwhile → global find → unlinked(moved_out), no new projection", async () => {
    b = await bridge({ filter: "mine" });
    const task = await linked("Plan");
    await b.edit(unassign(b.now(task.id), b.root));
    await b.sync();
    const other = b.person.createList("Archive");
    b.person.edit(reminderOf("Plan").ref, { moveTo: other.id });
    await b.edit(assign(b.now(task.id), b.root));
    const back = await b.sync();
    expect(back.plan.transitions).toEqual([{ taskId: task.id, kind: "return_find" }]);
    expect(b.link(task.id)).toMatchObject({ state: "unlinked", state_reason: "moved_out" });
    await b.sync();
    expect(b.reminders()).toHaveLength(1);
    expect(b.reminders(b.list.id)).toEqual([]);
  });

  it("…and deleted meanwhile → the old one is gone everywhere: a new projection", async () => {
    b = await bridge({ filter: "mine" });
    const task = await linked("Plan");
    await b.edit(unassign(b.now(task.id), b.root));
    await b.sync();
    b.person.delete(reminderOf("Plan").ref);
    await b.edit(assign(b.now(task.id), b.root));
    const back = await b.sync();
    expect(back.applied).toMatchObject({
      outcomes: [{ transition: "return_find", result: "removed" }],
    });
    const next = await b.sync();
    expect(next.prepared.map((i) => i.kind)).toEqual(["create"]);
    expect(b.reminders(b.list.id).map((r) => r.title)).toEqual(["Plan"]);
    expect(b.link(task.id)?.state).toBe("linked");
  });
});

describe("task_gone, quarantine, the recurrence lock", () => {
  it("Task deleted in LFCP → task_gone, the reminder stays; restored → relinked", async () => {
    b = await bridge();
    const task = await linked("Call");
    const before = reminderOf("Call");
    await b.edit(deleteTask(b.now(task.id)));
    await b.sync();
    expect(b.link(task.id)?.state).toBe("task_gone");
    expect(reminderOf("Call")).toEqual(before);
    await b.edit(restoreTask(b.now(task.id)));
    const back = await b.sync();
    expect(back.plan.transitions).toEqual([{ taskId: task.id, kind: "relink", item: before.ref }]);
    expect(b.link(task.id)?.state).toBe("linked");
  });

  it("two reminders with the Task's link: quarantine, nothing synchronized, nothing deleted", async () => {
    b = await bridge();
    const task = await linked("Gift");
    const r = reminderOf("Gift");
    b.person.create(b.list.id, "Gift (copy)", { url: r.linkUrl as string });
    await b.sync();
    expect(b.link(task.id)).toMatchObject({ state: "quarantine", state_reason: "ambiguous_match" });
    await b.edit(setTitle(b.now(task.id), "Gift for Ann"));
    expect((await b.sync()).plan.intents).toEqual([]);
    expect(b.reminders(b.list.id)).toHaveLength(2);
  });

  it("§6.4: a recurrence makes status and due read-only both ways; the title still goes; removed → agreed again", async () => {
    b = await bridge();
    const task = await linked("Water plants", { due: "2026-11-12" });
    b.person.edit(reminderOf("Water plants").ref, { recurrence: true });
    const lock = await b.sync();
    expect(lock.plan.transitions).toEqual([{ taskId: task.id, kind: "status_lock" }]);
    expect(b.link(task.id)?.status_locked).toBe(1);
    // Apple completes an occurrence and moves the date: nothing goes to LFCP.
    const it = b.store.items.get(reminderOf("Water plants").ref.id) as {
      completed: boolean;
      completionDate?: string;
    };
    it.completed = true;
    it.completionDate = "2026-11-12T10:00:00.000Z";
    b.person.edit(reminderOf("Water plants").ref, { dueDate: "2026-11-19" });
    // LFCP moves the due: nothing goes to Apple either; the title does.
    await b.edit(setDue(b.now(task.id), "2026-11-15"));
    await b.edit(setTitle(b.now(task.id), "Water the plants"));
    const r = await b.sync();
    expect(r.prepared.map((i) => [i.direction, i.fields])).toEqual([["to_apple", ["title"]]]);
    expect(b.now(task.id)).toMatchObject({ status: "todo", due: "2026-11-15" });
    expect(reminderOf("Water the plants").due?.date).toBe("2026-11-19");
    // The recurrence removed: unlocked, status and due agreed as on a first link.
    b.person.edit(reminderOf("Water the plants").ref, { recurrence: false });
    const un = await b.sync();
    expect(un.plan.transitions).toEqual([{ taskId: task.id, kind: "status_unlock" }]);
    expect(b.link(task.id)?.status_locked).toBe(0);
    expect(un.plan.decisions.filter((d) => d.field === "due" || d.field === "status")).toEqual([
      expect.objectContaining({ field: "due", decision: "write_apple" }),
      expect.objectContaining({ field: "status", decision: "write_lfcp", row: "X:F2" }),
    ]);
  });
});

describe("review PR 12", () => {
  it("#14 a prepared to_apple update does not run after the Task left the filter (B11)", async () => {
    b = await bridge({ filter: "mine" });
    const task = await linked("A");
    await b.edit(setTitle(b.now(task.id), "B"));
    const r = await b.pass.dryRun("b");
    if (r.kind !== "planned") throw new Error(r.kind);
    const [i] = b.e.prepare("b", { intents: r.plan.intents, unlinks: 0 }) ?? [];
    await b.edit(unassign(b.now(task.id), b.root));
    await b.sync();
    expect(b.link(task.id)?.state).toBe("out_of_filter");
    expect(await b.e.run((i as Intent).id)).toEqual({
      kind: "superseded",
      reason: "link_out_of_filter",
    });
    expect(b.reminders()[0]?.title).toBe("A");
  });

  it("#14 a prepared to_lfcp due does not run after the recurrence lock (§6.4); the title still goes", async () => {
    b = await bridge();
    const task = await linked("A", { due: "2026-11-12" });
    b.person.edit(reminderOf("A").ref, { dueDate: "2026-11-19", title: "A2" });
    const r = await b.pass.dryRun("b");
    if (r.kind !== "planned") throw new Error(r.kind);
    const [i] = b.e.prepare("b", { intents: r.plan.intents, unlinks: 0 }) ?? [];
    expect((i as Intent).fields).toEqual(["title", "due"]);
    b.person.edit(reminderOf("A2").ref, { recurrence: true });
    await b.sync();
    expect(b.link(task.id)?.status_locked).toBe(1);
    expect(await b.e.run((i as Intent).id)).toEqual({
      kind: "superseded",
      reason: "status_locked",
    });
    expect(b.now(task.id).due).toBe("2026-11-12");
    // Re-planned: the title alone.
    const again = await b.sync();
    expect(again.prepared.map((x) => x.fields)).toEqual([["title"]]);
    expect(b.now(task.id)).toMatchObject({ title: "A2", due: "2026-11-12" });
  });

  it("#15 the whole pass is checked before any change: a mass status change stops the link transitions too", async () => {
    b = await bridge({ filter: "mine" });
    const tasks = [];
    for (let k = 0; k < 6; k++) tasks.push(await b.task(`T${k}`));
    await b.sync();
    for (const t of tasks.slice(0, 4))
      await b.edit({ intent: { intent: "task.complete", id: t.id, completionDate: "2026-11-10" } });
    await b.edit(unassign(b.now((tasks[5] as { id: string }).id), b.root));
    const r = await b.sync();
    expect(r.applied).toEqual({ kind: "held", holds: ["guard_mass_status"] });
    expect(r.prepared).toEqual([]);
    expect(b.link((tasks[5] as { id: string }).id)?.state).toBe("linked");
    expect(b.reminders().filter((x) => x.completed)).toEqual([]);
  });

  it("#15 a count drop the dry run saw stops the pass", async () => {
    b = await bridge();
    for (const t of ["A", "B", "C", "D", "E", "F"]) await b.task(t);
    await b.sync();
    await b.sync();
    const list = b.list.id;
    const keep = b.reminders(list).slice(0, 2);
    // Four reminders gone from the snapshot read (an empty list answer), the links still there.
    const snapshot = b.t.snapshot.bind(b.t);
    b.t.snapshot = async (l) => ({ ...(await snapshot(l)), items: keep });
    const r = await b.sync();
    expect(r.applied).toMatchObject({
      kind: "held",
      holds: expect.arrayContaining(["guard_count_drop"]),
    });
    expect(b.db.prepare("SELECT state FROM links WHERE state <> 'linked'").all()).toEqual([]);
  });

  it("#16 return_find's moved_out counts toward the unlink limit (strict: more than one)", async () => {
    b = await bridge({ strict: true });
    const a = await b.task("A");
    const c = await b.task("C");
    await b.sync();
    b.db.prepare("UPDATE links SET state = 'out_of_filter'").run();
    const other = b.person.createList("Elsewhere");
    for (const r of b.reminders()) b.person.edit(r.ref, { moveTo: other.id });
    const r = await b.sync();
    expect(r.applied).toEqual({ kind: "held", holds: ["guard_mass_unlink"] });
    expect(b.link(a.id)?.state).toBe("out_of_filter");
    expect(b.link(c.id)?.state).toBe("out_of_filter");
  });

  it("#17 an incomplete find decides nothing, found or not, mixed completeness too", async () => {
    b = await bridge();
    const task = await linked("A");
    const other = b.person.createList("Elsewhere");
    b.person.edit(reminderOf("A").ref, { moveTo: other.id });
    const find = b.t.find.bind(b.t);
    b.t.find = async (q, s) => ({ ...(await find(q, s)), complete: false });
    await b.sync();
    expect(b.link(task.id)?.state).toBe("linked");
    // Only the URL read incomplete, the externalId one complete: still nothing.
    b.t.find = async (q, s) => ({ ...(await find(q, s)), complete: !("url" in q) });
    await b.sync();
    expect(b.link(task.id)?.state).toBe("linked");
    b.t.find = find;
    await b.sync();
    expect(b.link(task.id)).toMatchObject({ state: "unlinked", state_reason: "moved_out" });
  });

  it("#18 a global find with two candidates quarantines, never picks one", async () => {
    b = await bridge({ filter: "mine" });
    const task = await linked("A");
    const old = reminderOf("A");
    await b.edit(unassign(b.now(task.id), b.root));
    await b.sync();
    const other = b.person.createList("Elsewhere");
    b.person.edit(old.ref, { moveTo: other.id });
    await b.edit(assign(b.now(task.id), b.root));
    const r = await b.pass.dryRun("b");
    if (r.kind !== "planned") throw new Error(r.kind);
    b.person.create(b.list.id, "Copy", { url: old.linkUrl as string });
    await b.links.apply("b", r.plan);
    expect(b.link(task.id)).toMatchObject({ state: "quarantine", state_reason: "ambiguous_find" });
    expect(
      b.db.prepare("SELECT count(*) AS n FROM bases WHERE task_id = ?").get(task.id),
    ).not.toEqual({ n: 0 });
  });

  it("status_unlock drops the locked-era status and due bases even when nothing is written", async () => {
    b = await bridge();
    const task = await linked("A", { due: "2026-11-12" });
    b.person.edit(reminderOf("A").ref, { recurrence: true });
    await b.sync();
    // While locked, both sides move the due to the same date.
    b.person.edit(reminderOf("A").ref, { dueDate: "2026-11-19" });
    await b.edit(setDue(b.now(task.id), "2026-11-19"));
    await b.sync();
    b.person.edit(reminderOf("A").ref, { recurrence: false });
    const un = await b.sync();
    expect(un.prepared).toEqual([]);
    expect(un.plan.decisions.filter((d) => d.field === "due")).toEqual([
      expect.objectContaining({ decision: "bases" }),
    ]);
    // The locked-era base (2026-11-12) is gone; the bases are the next apply's to record (PR 9).
    expect(
      b.db
        .prepare("SELECT field FROM bases WHERE task_id = ? AND field IN ('status','due')")
        .all(task.id),
    ).toEqual([]);
  });
});

describe("review PR 12 r2", () => {
  it("#19 a limit hold not yet accepted stops the whole pass, even once the anomaly shrank", async () => {
    b = await bridge({ filter: "mine" });
    const tasks = [];
    for (let k = 0; k < 4; k++) tasks.push(await b.task(`T${k}`));
    await b.sync();
    for (const task of tasks) await b.edit(unassign(b.now(task.id), b.root));
    expect((await b.sync()).applied).toEqual({ kind: "held", holds: ["guard_mass_unlink"] });
    // Three come back: one unlink left, under the limit — but the hold is not accepted.
    for (const task of tasks.slice(0, 3)) await b.edit(assign(b.now(task.id), b.root));
    const r = await b.sync();
    expect(r.applied).toEqual({ kind: "held", holds: ["guard_mass_unlink"] });
    expect(b.link((tasks[3] as { id: string }).id)?.state).toBe("linked");
    // Accepted (resume --accept, PR 9: the hold lifted): the pass goes on.
    b.db.prepare("DELETE FROM binding_holds WHERE reason = 'guard_mass_unlink'").run();
    expect((await b.sync()).applied.kind).toBe("applied");
    expect(b.link((tasks[3] as { id: string }).id)?.state).toBe("out_of_filter");
  });
});
