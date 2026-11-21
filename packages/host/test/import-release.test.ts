// `resume --accept import_ambiguous` (owner Q-3, revising R2-8): the pending imports whose reminder
// is not found now are released — link → unlinked (import_released), create_task → superseded —
// and the hold is lifted; an import whose reminder is found keeps its pending link.

import { afterEach, describe, expect, it } from "vitest";
import { Holds, type Intent, Journal } from "../src/index.js";
import { acceptImportAmbiguous } from "../src/quarantine.js";
import { type Bridge, bridge } from "./support/bridge.js";

let b: Bridge;
afterEach(async () => {
  await b?.close();
});

const tasksTitled = (title: string) => b.order().filter((id) => b.now(id)?.title === title);
const intentState = (i: Intent) =>
  b.db.prepare("SELECT state, state_reason FROM intents WHERE id = ?").get(i.id);
const holds = () => b.db.prepare("SELECT reason FROM binding_holds").all();
const accept = () => acceptImportAmbiguous(b.db, b.t, "b", { journal: new Journal(b.db) });

/** Plans and prepares the imports of the list's reminders, without running them. */
async function pendingImports(): Promise<readonly Intent[]> {
  const plan = await b.pass.dryRun("b");
  if (plan.kind !== "planned") throw new Error(plan.kind);
  return b.e.prepare("b", { intents: plan.plan.intents, unlinks: 0 }) ?? [];
}

describe("resume --accept import_ambiguous", () => {
  it("a pending import whose reminder is found keeps its link and its create_task", async () => {
    b = await bridge();
    b.person.create(b.list.id, "Here");
    const [create] = await pendingImports();
    if (create === undefined) throw new Error("no create_task");
    new Holds(b.db).set("b", "import_ambiguous");
    const r = await accept();
    expect(r).toEqual({
      kind: "resolved",
      text: "hold import_ambiguous lifted and accepted on b: 0 pending import(s) without a reminder released; the next pass goes through",
    });
    expect(b.link(create.taskId)?.state).toBe("pending_lfcp_create");
    expect(intentState(create)).toEqual({ state: "prepared", state_reason: null });
    expect(holds()).toEqual([]);
  });

  it("only the vanished import is released; the found one goes on, and so do new reminders", async () => {
    b = await bridge();
    const gone = b.person.create(b.list.id, "Gone");
    b.person.create(b.list.id, "Kept");
    const prepared = await pendingImports();
    const of = (title: string) => {
      const i = prepared.find(
        (x) => (x.basis as { reminder?: { title: string } }).reminder?.title === title,
      );
      if (i === undefined) throw new Error(`no import of ${title}`);
      return i;
    };
    b.person.delete(gone.ref);
    b.person.create(b.list.id, "New");
    expect((await b.sync()).plan.holds).toEqual(["import_ambiguous"]);
    expect((await accept()).kind).toBe("resolved");
    expect(b.link(of("Gone").taskId)).toEqual({
      state: "unlinked",
      state_reason: "import_released",
      status_locked: 0,
    });
    expect(intentState(of("Gone"))).toEqual({
      state: "superseded",
      state_reason: "import_released",
    });
    expect(b.link(of("Kept").taskId)?.state).toBe("pending_lfcp_create");
    expect(intentState(of("Kept"))).toEqual({ state: "prepared", state_reason: null });
    // The kept import goes on as it was prepared; the next pass sets no hold and imports New.
    expect(await b.e.run(of("Kept").id)).toEqual({ kind: "finalized" });
    expect(tasksTitled("Kept")).toHaveLength(1);
    const next = await b.sync();
    expect(next.plan.holds).toEqual([]);
    expect(holds()).toEqual([]);
    expect(tasksTitled("New")).toHaveLength(1);
    expect(tasksTitled("Gone")).toEqual([]);
  });

  it("refused, nothing written, when the list cannot be read completely", async () => {
    b = await bridge();
    const r0 = b.person.create(b.list.id, "Gone");
    const [create] = await pendingImports();
    if (create === undefined) throw new Error("no create_task");
    b.person.delete(r0.ref);
    new Holds(b.db).set("b", "import_ambiguous");
    b.t.faults.incompleteReads = true;
    expect((await accept()).kind).toBe("refused");
    expect(b.link(create.taskId)?.state).toBe("pending_lfcp_create");
    expect(holds()).toEqual([{ reason: "import_ambiguous" }]);
  });

  it("a released reminder that comes back is imported as new", async () => {
    b = await bridge();
    const away = b.person.createList("Elsewhere");
    const r0 = b.person.create(b.list.id, "Wanderer");
    const [create] = await pendingImports();
    if (create === undefined) throw new Error("no create_task");
    b.person.edit(r0.ref, { moveTo: away.id });
    expect((await b.sync()).plan.holds).toEqual(["import_ambiguous"]);
    expect((await accept()).kind).toBe("resolved");
    expect(b.link(create.taskId)?.state).toBe("unlinked");
    b.person.edit(r0.ref, { moveTo: b.list.id });
    await b.sync();
    expect(holds()).toEqual([]);
    expect(tasksTitled("Wanderer")).toHaveLength(1);
    expect(b.linkOf(r0.ref.id)).toMatchObject({ state: "linked", origin: "apple" });
  });
});
