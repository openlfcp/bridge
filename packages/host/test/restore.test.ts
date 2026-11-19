// Restore answers executed (A§7.1–7.2; E-041b), L2 on a real section replica and the fake
// account: the planner turns the status around for a pending decision, the authorization is
// consumed with the preparation, "Create new reminders" projects the Tasks anew, "Keep only in
// Reminders" keeps the reminders out of the imports. T§3 R3-1b.

import { complete } from "@openlfcp/shared-objects";
import { afterEach, describe, expect, it } from "vitest";
import { Authorizations, Holds, type Intent } from "../src/index.js";
import { type Bridge, bridge } from "./support/bridge.js";

let b: Bridge;
afterEach(async () => {
  await b?.close();
});

const holds = () => new Holds(b.db);
const answers = () => new Authorizations(b.db);
const rows = (table: string) =>
  b.db.prepare(`SELECT state, outcome FROM ${table} ORDER BY id`).all() as {
    state: string;
    outcome?: string | null;
  }[];
const decisions = () =>
  (
    b.db.prepare("SELECT kind, state FROM decisions ORDER BY id").all() as {
      kind: string;
      state: string;
    }[]
  ).map((d) => `${d.kind}:${d.state}`);
/** The items of the (only) decision, by Task. */
const items = () => {
  const d = b.db.prepare("SELECT id FROM decisions").get() as { id: string };
  return answers().items(d.id);
};
const reminder = (title: string) => {
  const r = b.reminders().find((x) => x.title === title);
  if (r === undefined) throw new Error(`no reminder ${title}`);
  return r;
};
const restore = (
  reason: Parameters<Holds["restore"]>[1],
  choice: Parameters<Holds["restore"]>[2],
) => {
  const r = holds().restore("b", reason, choice);
  if ("refused" in r) throw new Error(r.refused);
  return r;
};

/** `n` Tasks projected and linked (T0…). */
async function linked(n: number) {
  const tasks = [];
  for (let k = 0; k < n; k++) tasks.push(await b.task(`T${k}`));
  await b.sync();
  for (const t of tasks) expect(b.link(t.id)?.state).toBe("linked");
  return tasks;
}

describe("T§3 R3-1b: [Reopen the reminders] on 8 of 12 completed in Reminders", {
  timeout: 30_000,
}, () => {
  /** 12 linked; 8 reminders completed in Reminders (> 50 %) → hold → [Reopen the reminders]. */
  async function answered() {
    b = await bridge();
    const tasks = await linked(12);
    for (let k = 0; k < 8; k++) b.person.edit(reminder(`T${k}`).ref, { completed: true });
    const held = await b.sync();
    expect(held.applied).toEqual({ kind: "held", holds: ["guard_mass_status"] });
    restore("guard_mass_status", "prefer_lfcp_status");
    expect(holds().of("b")).toEqual([]);
    return tasks;
  }

  it("one pass: 8 apple_update, the authorization consumed with the preparation, no new question", async () => {
    const tasks = await answered();
    const r = await b.sync();
    expect(r.applied).toMatchObject({ kind: "applied" });
    expect(r.prepared.map((i: Intent) => [i.direction, i.kind, i.fields])).toEqual(
      Array.from({ length: 8 }, () => ["to_apple", "update", ["status"]]),
    );
    expect(r.outcomes.every((o) => o.kind === "finalized")).toBe(true);
    for (const t of tasks) {
      expect(reminder(t.title).completed).toBe(false);
      expect(b.now(t.id).status).toBe("todo");
    }
    expect(rows("authorizations")).toEqual([{ state: "consumed", outcome: "consumed" }]);
    // Consuming the authorization does not finish the decision: its writes do, Task by Task.
    expect(decisions()).toEqual(["prefer_lfcp_status:pending"]);
    expect(holds().of("b")).toEqual([]);
    // The next pass sees them confirmed (both sides open): nothing written, the decision done.
    expect((await b.sync()).prepared).toEqual([]);
    expect(decisions()).toEqual(["prefer_lfcp_status:done"]);
    expect(Object.values(items())).toEqual(Array.from({ length: 8 }, () => "done"));
    // A later completion is the person's again.
    b.person.edit(reminder("T0").ref, { completed: true });
    const later = await b.sync();
    expect(later.prepared.map((i: Intent) => i.direction)).toEqual(["to_lfcp"]);
  });

  it("one more status change in the same pass → void{changed}, the question asked again, nothing written", async () => {
    const tasks = await answered();
    await b.edit(complete(b.now((tasks[11] as { id: string }).id)));
    const r = await b.sync();
    expect(r.applied).toEqual({ kind: "held", holds: ["guard_mass_status"] });
    expect(rows("authorizations")).toEqual([{ state: "void", outcome: "changed" }]);
    expect(decisions()).toEqual(["prefer_lfcp_status:void"]);
    for (let k = 0; k < 8; k++) expect(reminder(`T${k}`).completed).toBe(true);
    // The re-issued question: its snapshot has the 9 changes.
    const detail = holds().of("b")[0]?.detail as { anomaly: { items: unknown[] } };
    expect(detail.anomaly.items).toHaveLength(9);
  });

  it("Restore waits behind a second hold: nothing done until it is lifted, then the same pass goes", async () => {
    await answered();
    holds().set("b", "ownership_lost");
    expect((await b.sync()).applied).toEqual({ kind: "held", holds: ["ownership_lost"] });
    expect(rows("authorizations")).toEqual([{ state: "pending", outcome: null }]);
    for (let k = 0; k < 8; k++) expect(reminder(`T${k}`).completed).toBe(true);
    holds().lift("b", "ownership_lost");
    const r = await b.sync();
    expect(r.prepared).toHaveLength(8);
    expect(rows("authorizations")).toEqual([{ state: "consumed", outcome: "consumed" }]);
    for (let k = 0; k < 8; k++) expect(reminder(`T${k}`).completed).toBe(false);
  });
});

describe("a Restore answer is finished only by its writes (review E-041b r1)", {
  timeout: 30_000,
}, () => {
  /** R3-1b up to the consuming pass, its 8 writes prepared but not run. */
  async function prepared() {
    b = await bridge();
    await linked(12);
    for (let k = 0; k < 8; k++) b.person.edit(reminder(`T${k}`).ref, { completed: true });
    await b.sync();
    restore("guard_mass_status", "prefer_lfcp_status");
    const p = await b.pass.dryRun("b");
    if (p.kind !== "planned") throw new Error(p.kind);
    const applied = await b.links.apply("b", p.plan, { executor: b.e, guards: p.guards });
    if (applied.kind !== "applied") throw new Error(applied.kind);
    expect(applied.prepared).toHaveLength(8);
    return applied.prepared;
  }
  /** A pass that plans nothing for `task` in LFCP (the opposite of the answer). */
  async function noOpposite(task: string) {
    const r = await b.sync();
    expect(r.applied).toMatchObject({ kind: "applied" });
    expect(r.plan.intents.filter((i) => i.taskId === task && i.direction === "to_lfcp")).toEqual(
      [],
    );
    expect(b.now(task).status).toBe("todo");
    return r;
  }

  it("7 of 8 writes run, the 8th waits: the next pass does not carry the completion to LFCP", async () => {
    const intents = await prepared();
    for (const i of intents.slice(0, 7)) await b.e.run(i.id);
    const last = intents[7] as Intent;
    await noOpposite(last.taskId);
    // The 7 confirmed are done; the 8th is still the answer's.
    const states = items();
    expect(states[last.taskId]).toBe("active");
    expect(Object.values(states).filter((x) => x === "done")).toHaveLength(7);
    expect(decisions()).toEqual(["prefer_lfcp_status:pending"]);
    // Its write runs (a retry, later): confirmed by the next pass, the decision done.
    expect(await b.e.run(last.id)).toEqual({ kind: "finalized" });
    await noOpposite(last.taskId);
    expect(decisions()).toEqual(["prefer_lfcp_status:done"]);
    expect(reminder("T7").completed).toBe(false);
  });

  it("a crash before a write's effect, then the retry: no opposite transfer in between", async () => {
    const intents = await prepared();
    for (const i of intents.slice(0, 7)) await b.e.run(i.id);
    const last = intents[7] as Intent;
    await expect(b.executor("after_effecting").run(last.id)).rejects.toThrow("crash");
    await noOpposite(last.taskId);
    expect(items()[last.taskId]).toBe("active");
    await b.e.recoverAll();
    await b.e.runDue();
    await noOpposite(last.taskId);
    expect(reminder("T7").completed).toBe(false);
    expect(decisions()).toEqual(["prefer_lfcp_status:done"]);
  });

  it("a Task changed by the person after the answer, before its write: the item ends changed, the change goes as usual", async () => {
    const intents = await prepared();
    for (const i of intents.slice(0, 7)) await b.e.run(i.id);
    const last = intents[7] as Intent;
    // The person edits the reminder (another rev): the waiting write no longer applies.
    b.person.edit(reminder("T7").ref, { title: "T7 renamed" });
    await b.e.run(last.id);
    await b.sync();
    expect(items()[last.taskId]).toBe("changed");
    expect(decisions()).toEqual(["prefer_lfcp_status:done"]);
    expect(b.db.prepare("SELECT key FROM journal WHERE key LIKE 'decision.%'").all()).toEqual([
      { key: "decision.item_changed" },
      { key: "decision.done" },
    ]);
  });
});

describe("the other Restore answers (A§7.2)", { timeout: 30_000 }, () => {
  it("[Complete the reminders again]: 8 reopened in Reminders are completed again, the date to the day", async () => {
    b = await bridge();
    const tasks = await linked(12);
    // Completed in LFCP 4 at a time (8 in one pass would be held).
    for (const part of [tasks.slice(0, 4), tasks.slice(4, 8)]) {
      for (const t of part) await b.edit(complete(b.now(t.id), "2026-11-08"));
      expect((await b.sync()).applied).toMatchObject({ kind: "applied" });
    }
    for (let k = 0; k < 8; k++) expect(reminder(`T${k}`).completed).toBe(true);
    for (let k = 0; k < 8; k++) b.person.edit(reminder(`T${k}`).ref, { completed: false });
    expect((await b.sync()).applied).toEqual({ kind: "held", holds: ["guard_mass_status"] });
    const r = restore("guard_mass_status", "prefer_lfcp_status");
    expect(r.authorization?.effects[0]?.to).toEqual({ value: true, date: "2026-11-08" });
    const pass = await b.sync();
    expect(pass.prepared).toHaveLength(8);
    for (let k = 0; k < 8; k++) {
      expect(reminder(`T${k}`).completed).toBe(true);
      expect(b.now((tasks[k] as { id: string }).id).status).toBe("done");
    }
    expect(rows("authorizations")).toEqual([{ state: "consumed", outcome: "consumed" }]);
  });

  it("[Reopen the tasks for everyone]: 8 completed in LFCP (todo → done) are reopened, the reminders stay open", async () => {
    b = await bridge();
    const tasks = await linked(12);
    for (const t of tasks.slice(0, 8)) await b.edit(complete(b.now(t.id)));
    expect((await b.sync()).applied).toEqual({ kind: "held", holds: ["guard_mass_status"] });
    restore("guard_mass_status", "reopen");
    const r = await b.sync();
    expect(r.prepared.map((i: Intent) => [i.direction, i.fields])).toEqual(
      Array.from({ length: 8 }, () => ["to_lfcp", ["status"]]),
    );
    for (const t of tasks) {
      expect(b.now(t.id).status).toBe("todo");
      expect(reminder(t.title).completed).toBe(false);
    }
    expect(decisions()).toEqual(["reopen:pending"]);
    await b.sync();
    expect(decisions()).toEqual(["reopen:done"]);
  });

  it("[Create new reminders from these tasks]: the deleted links are projected anew, not unlinked", async () => {
    b = await bridge();
    // 12 links: 4 deleted is a mass unlink (> 3), not a count drop (12 → 8).
    const tasks = await linked(12);
    for (let k = 0; k < 4; k++) b.person.delete(reminder(`T${k}`).ref);
    expect((await b.sync()).applied).toEqual({ kind: "held", holds: ["guard_mass_unlink"] });
    restore("guard_mass_unlink", "recreate");
    const r = await b.sync();
    expect(r.applied).toMatchObject({ kind: "applied" });
    expect(rows("authorizations")).toEqual([{ state: "consumed", outcome: "consumed" }]);
    // The links are gone, nothing created yet: the decision is not finished.
    expect(decisions()).toEqual(["recreate:pending"]);
    const keys = b.db.prepare("SELECT key FROM journal WHERE key LIKE 'link.%'").all();
    expect(keys).toEqual(Array.from({ length: 4 }, () => ({ key: "link.recreated" })));
    // The next pass: a new projection of each, linked again.
    const next = await b.sync();
    expect(next.prepared.map((i: Intent) => [i.direction, i.kind])).toEqual(
      Array.from({ length: 4 }, () => ["to_apple", "create"]),
    );
    for (const t of tasks) {
      expect(b.link(t.id)?.state).toBe("linked");
      expect(reminder(t.title).completed).toBe(false);
    }
    expect(b.reminders()).toHaveLength(12);
    // Created and linked: the next pass sees all four, the decision done.
    expect(decisions()).toEqual(["recreate:pending"]);
    await b.sync();
    expect(Object.values(items())).toEqual(Array.from({ length: 4 }, () => "done"));
    expect(decisions()).toEqual(["recreate:done"]);
  });

  it("[Keep only in Reminders]: the 11 new reminders are not imported, now or later", async () => {
    b = await bridge();
    await linked(1);
    for (let k = 0; k < 11; k++) b.person.create(b.list.id, `New ${k}`);
    expect((await b.sync()).applied).toEqual({ kind: "held", holds: ["guard_mass_import"] });
    const r = restore("guard_mass_import", "suppress");
    expect(r.authorization).toBeUndefined();
    for (let k = 0; k < 2; k++) {
      const pass = await b.sync();
      expect(pass.applied).toMatchObject({ kind: "applied" });
      expect(pass.prepared).toEqual([]);
      expect(pass.plan.items.filter((i) => i.kind === "ignore")).toHaveLength(11);
    }
    expect(b.order()).toHaveLength(1);
    expect(answers().decisions("b")).toEqual([]);
  });
});
