// T§3 R3-1b at L3 (E-041c): the Restore answers on the real EventKit store, through the helper
// app, the scenarios restore.test.ts runs on the fake account. "Reopen the reminders": 8 of 12
// completed in Reminders → hold → the answer → one pass writes the 8 reminders back open, the
// authorization consumed, no new question. "Create new reminders": 4 deleted in Reminders → hold →
// the answer → the Tasks are projected anew, linked again. Skipped without the L3 setup
// (support/eventkit.ts); the L3 job (.github/workflows/l3.yml) requires it.

import { afterEach, describe, expect, it } from "vitest";
import { Holds, type Intent } from "../src/index.js";
import { type Bridge, bridge } from "./support/bridge.js";
import { type EventKitRig, eventKitRig, l3Skip } from "./support/eventkit.js";

const skip = l3Skip();
let b: Bridge | undefined;
afterEach(async () => {
  await b?.close();
  b = undefined;
});

const rows = (bb: Bridge, sql: string) => bb.db.prepare(sql).all();
const restore = (
  bb: Bridge,
  reason: Parameters<Holds["restore"]>[1],
  choice: Parameters<Holds["restore"]>[2],
) => {
  const r = new Holds(bb.db).restore("b", reason, choice);
  if ("refused" in r) throw new Error(r.refused);
};

/** A bridge on a new EventKit verification list with `n` Tasks projected and linked. */
async function linked(rig: EventKitRig, n: number) {
  const bb = await bridge({ rig });
  b = bb;
  const tasks = [];
  for (let k = 0; k < n; k++) tasks.push(await bb.task(`T${k}`));
  const first = await bb.sync();
  expect(first.outcomes).toEqual(Array.from({ length: n }, () => ({ kind: "finalized" })));
  for (const t of tasks) expect(bb.link(t.id)?.state).toBe("linked");
  const items = await rig.until((i) => i.length === n, `${n} reminders`);
  const byTitle = new Map(items.map((i) => [i.title, i]));
  return { bb, tasks, byTitle };
}

describe.skipIf(skip !== undefined)("T§3 R3-1b on EventKit (L3)", { timeout: 300_000 }, () => {
  it("[Reopen the reminders]: 8 of 12 completed in Reminders go back open in one pass", async () => {
    const rig = await eventKitRig("R3-1b reopen");
    const { bb, tasks, byTitle } = await linked(rig, 12);
    for (let k = 0; k < 8; k++) await rig.person.complete(byTitle.get(`T${k}`)?.ref.id as string);
    await rig.until((i) => i.filter((x) => x.completed).length === 8, "8 completed");

    expect((await bb.sync()).applied).toEqual({ kind: "held", holds: ["guard_mass_status"] });
    for (const t of tasks) expect(bb.now(t.id).status).toBe("todo");
    restore(bb, "guard_mass_status", "prefer_lfcp_status");

    // One pass: the 8 writes, the authorization consumed with them, no new question.
    const r = await bb.sync();
    expect(r.applied).toMatchObject({ kind: "applied" });
    expect(r.prepared.map((i: Intent) => [i.direction, i.kind, i.fields])).toEqual(
      Array.from({ length: 8 }, () => ["to_apple", "update", ["status"]]),
    );
    expect(r.outcomes).toEqual(Array.from({ length: 8 }, () => ({ kind: "finalized" })));
    expect(rows(bb, "SELECT state, outcome FROM authorizations")).toEqual([
      { state: "consumed", outcome: "consumed" },
    ]);
    expect(rows(bb, "SELECT reason FROM binding_holds")).toEqual([]);
    await rig.until((i) => i.every((x) => !x.completed), "all 12 open");
    for (const t of tasks) expect(bb.now(t.id).status).toBe("todo");

    // The next pass sees them confirmed: nothing written, the decision done.
    expect((await bb.sync()).prepared).toEqual([]);
    expect(rows(bb, "SELECT kind, state FROM decisions")).toEqual([
      { kind: "prefer_lfcp_status", state: "done" },
    ]);
  });

  it("[Create new reminders from these tasks]: 4 deleted in Reminders are projected anew", async () => {
    const rig = await eventKitRig("R3-1b recreate");
    // 12 links: 4 deleted is a mass unlink (> 3), not a count drop.
    const { bb, tasks, byTitle } = await linked(rig, 12);
    const gone = new Set<string>();
    for (let k = 0; k < 4; k++) {
      const item = byTitle.get(`T${k}`);
      await rig.person.delete(item?.ref.id as string);
      gone.add(item?.ref.id as string);
    }
    await rig.until((i) => i.length === 8, "8 reminders left");

    expect((await bb.sync()).applied).toEqual({ kind: "held", holds: ["guard_mass_unlink"] });
    for (const t of tasks) expect(bb.link(t.id)?.state).toBe("linked");
    restore(bb, "guard_mass_unlink", "recreate");

    // The answered pass: the 4 links projected anew (not unlinked), the authorization consumed.
    expect((await bb.sync()).applied).toMatchObject({ kind: "applied" });
    expect(rows(bb, "SELECT key FROM journal WHERE key LIKE 'link.%'")).toEqual(
      Array.from({ length: 4 }, () => ({ key: "link.recreated" })),
    );
    expect(rows(bb, "SELECT state, outcome FROM authorizations")).toEqual([
      { state: "consumed", outcome: "consumed" },
    ]);
    // The next: 4 new reminders, linked.
    const next = await bb.sync();
    expect(next.prepared.map((i: Intent) => [i.direction, i.kind])).toEqual(
      Array.from({ length: 4 }, () => ["to_apple", "create"]),
    );
    expect(next.outcomes).toEqual(Array.from({ length: 4 }, () => ({ kind: "finalized" })));
    for (const t of tasks) expect(bb.link(t.id)?.state).toBe("linked");
    const items = await rig.until((i) => i.length === 12, "12 reminders");
    expect(items.filter((i) => gone.has(i.ref.id))).toEqual([]);
    expect(new Set(items.map((i) => i.title))).toEqual(new Set(tasks.map((t) => t.title)));
    // Created and linked: the decision done.
    await bb.sync();
    expect(rows(bb, "SELECT kind, state FROM decisions")).toEqual([
      { kind: "recreate", state: "done" },
    ]);
  });
});
