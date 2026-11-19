// Restore answers (A§7.1–7.2; E-041a): the inverse button authorizes the exact inverse set of the
// anomaly it answers, checked at admission by the table of acceptances. T§3 R3-1b at admission:
// the inverse plan above the threshold goes in one pass, an extra status change asks again, a
// second hold makes it wait. The planner that plans these effects is E-041b.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AnomalySnapshot,
  Authorizations,
  type BridgeDatabase,
  Holds,
  Journal,
  Limits,
  type NewIntent,
  openBridgeDatabase,
  type PlannedUnlink,
} from "../src/index.js";

let dir: string;
let db: BridgeDatabase;
const T0 = Date.parse("2026-11-10T10:00:00Z");
let t = T0;
const now = () => t;

beforeEach(() => {
  t = T0;
  dir = mkdtempSync(join(tmpdir(), "lfcp-bridge-authorizations-"));
  db = openBridgeDatabase(join(dir, "bridge.sqlite"));
  const at = new Date(T0 - 3 * 86_400_000).toISOString();
  db.prepare(
    "INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES ('i', 'd', 'p', 'r', 'l', ?)",
  ).run(at);
  db.prepare(
    "INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, target_ref, state, approved_at, strict_until, created_at) VALUES ('b', 'i', 'R', 'apple-reminders', 'fake', 'L', 'active', ?, ?, ?)",
  ).run(at, new Date(T0 - 2 * 86_400_000).toISOString(), at);
  // R3-1b: 12 links — status changes are held above 6 in one pass, unlinks above 3.
  for (let k = 0; k < 12; k++)
    db.prepare(
      "INSERT INTO links (binding_id, task_id, origin, state, created_at, updated_at) VALUES ('b', ?, 'lfcp', 'linked', ?, ?)",
    ).run(`L${k}`, at, at);
});
afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

const limits = () => new Limits(db, undefined, now);
const holds = () => new Holds(db, now);
const auths = () => new Authorizations(db, now);
const keys = () => new Journal(db).list().map((e) => e.key);
const range = (n: number, from = 0) => Array.from({ length: n }, (_, k) => k + from);
const open = { closed: false, date: null };
const done = (date = "2026-11-09") => ({ closed: true, date });

const intent = (
  k: number,
  direction: "to_apple" | "to_lfcp",
  basis: unknown,
  payload: unknown,
): NewIntent => ({
  bindingId: "b",
  taskId: `L${k}`,
  installationId: "i",
  direction,
  kind: direction === "to_apple" ? "update" : "update_task",
  fields: ["status"],
  basis,
  payload,
});
/** Completed in Reminders, the Task still open: the pass would complete the Task. */
const appleCompleted = (k: number, rev = `r${k}`) =>
  intent(
    k,
    "to_lfcp",
    { rev, pL: { status: open }, pA: { status: done() } },
    {
      resource: "R",
      intents: [{ intent: "task.complete", id: `L${k}`, completionDate: "2026-11-09" }],
    },
  );
/** The inverse: reopen the reminder, with its rev. */
const reopenReminder = (k: number, rev = `r${k}`, from = done()) =>
  intent(
    k,
    "to_apple",
    { rev, pL: { status: open }, pA: { status: from } },
    { kind: "update", ref: { id: `A${k}` }, set: { completed: { value: false } }, expect: { rev } },
  );
const plan = (intents: NewIntent[], unlinks: PlannedUnlink[] = []) =>
  limits().admit("b", { intents, unlinks });

/** R3-1b up to the answer: 8 completed in Reminders → hold → [Reopen the reminders]. */
function restored() {
  expect(plan(range(8).map((k) => appleCompleted(k)))).toMatchObject({
    ok: false,
    holds: ["guard_mass_status"],
  });
  t += 60_000;
  const r = holds().restore("b", "guard_mass_status", "prefer_lfcp_status", { answerId: "ans1" });
  if ("refused" in r) throw new Error(r.refused);
  expect(holds().of("b")).toEqual([]);
  expect(r.decision).toMatchObject({ kind: "prefer_lfcp_status", state: "pending" });
  expect(r.authorization).toMatchObject({
    reason: "guard_mass_status",
    answerId: "ans1",
    state: "pending",
  });
  expect(r.authorization?.effects[0]).toEqual({
    taskId: "L0",
    effect: "apple_update",
    field: "completed",
    from: { closed: true, date: "2026-11-09" },
    to: { value: false },
    expectRev: "r0",
  });
  expect(r.authorization?.effects).toHaveLength(8);
  t += 60_000;
  return { auth: r.authorization?.id as string, decision: r.decision.id };
}

describe("T§3 R3-1b: Restore authorizes the exact inverse set", () => {
  it("the inverse plan (8 > 6) goes in one pass: consumed with the preparation, no new question", () => {
    const { auth, decision } = restored();
    const inverse = range(8).map((k) => reopenReminder(k));
    // A crash before the preparation commits: the authorization stays pending.
    expect(() =>
      db.transaction(() => {
        expect(plan(inverse)).toEqual({ ok: true, accepted: ["guard_mass_status"] });
        throw new Error("crash");
      })(),
    ).toThrow("crash");
    expect(auths().get(auth)).toMatchObject({ state: "pending" });
    expect(plan(inverse)).toEqual({ ok: true, accepted: ["guard_mass_status"] });
    expect(auths().get(auth)).toMatchObject({ state: "consumed", outcome: "consumed" });
    expect(keys()).toContain("authorization.consumed");
    expect(holds().of("b")).toEqual([]);
    // The decision waits for its writes (the planner's input, E-041b).
    expect(auths().decision(decision)).toMatchObject({ state: "pending" });
    // Consumed once: the same set again is a new anomaly.
    expect(plan(inverse)).toMatchObject({ ok: false, holds: ["guard_mass_status"] });
  });

  it("one extra status change in the same pass → void{changed}: held again, the decision void", () => {
    const { auth, decision } = restored();
    const extra = intent(
      9,
      "to_apple",
      { rev: "r9", pL: { status: done() }, pA: { status: open } },
      {
        kind: "update",
        ref: { id: "A9" },
        set: { completed: { value: true } },
        expect: { rev: "r9" },
      },
    );
    expect(plan([...range(8).map((k) => reopenReminder(k)), extra])).toMatchObject({
      ok: false,
      holds: ["guard_mass_status"],
    });
    expect(auths().get(auth)).toMatchObject({ state: "void", outcome: "changed" });
    expect(auths().decision(decision)).toMatchObject({ state: "void" });
    expect(auths().decisions("b")).toEqual([]);
    expect(keys()).toContain("authorization.changed");
    const held = holds().of("b")[0]?.detail as { anomaly: AnomalySnapshot };
    expect(held.anomaly.items).toHaveLength(9);
  });

  it("Restore waits behind a second hold: not used up, then consumed once it is gone", () => {
    const { auth } = restored();
    const inverse = range(8).map((k) => reopenReminder(k));
    const deleted = range(4, 8).map((k) => ({
      taskId: `L${k}`,
      cause: "deleted_in_apple" as const,
    }));
    expect(plan(inverse, deleted)).toMatchObject({ ok: false, holds: ["guard_mass_unlink"] });
    expect(auths().get(auth)).toMatchObject({ state: "pending" });
    expect(plan(inverse)).toEqual({ ok: true, accepted: ["guard_mass_status"] });
  });

  it("⊆ with the same from → consumed; another rev or another from → changed; empty → vanished", () => {
    const fewer = restored();
    expect(plan(range(5).map((k) => reopenReminder(k)))).toEqual({
      ok: true,
      accepted: ["guard_mass_status"],
    });
    expect(auths().get(fewer.auth)).toMatchObject({ outcome: "consumed" });
    // The reminder was edited since the answer: another rev.
    const edited = restored();
    expect(plan([...range(7).map((k) => reopenReminder(k)), reopenReminder(7, "r7b")]).ok).toBe(
      false,
    );
    expect(auths().get(edited.auth)).toMatchObject({ outcome: "changed" });
    // Completed on another date since.
    holds().lift("b", "guard_mass_status");
    const redated = restored();
    expect(plan([reopenReminder(0, "r0", done("2026-11-10"))]).ok).toBe(false);
    expect(auths().get(redated.auth)).toMatchObject({ outcome: "changed" });
    // Nothing of it any more (reopened in Reminders by hand): vanished, the decision void.
    holds().lift("b", "guard_mass_status");
    const gone = restored();
    expect(plan([])).toEqual({ ok: true });
    expect(auths().get(gone.auth)).toMatchObject({ state: "void", outcome: "vanished" });
    expect(auths().decision(gone.decision)).toMatchObject({ state: "void" });
    expect(keys()).toContain("authorization.vanished");
  });
});

describe("the other inverse choices (A§7.2)", () => {
  it("Complete the reminders again: completed{true, date} to LocalDate precision", () => {
    const reopened = (k: number, date: string) =>
      intent(
        k,
        "to_lfcp",
        { rev: `r${k}`, pL: { status: done(date) }, pA: { status: open } },
        { resource: "R", intents: [{ intent: "task.reopen", id: `L${k}` }] },
      );
    plan(range(8).map((k) => reopened(k, "2026-11-08")));
    const r = holds().restore("b", "guard_mass_status", "prefer_lfcp_status");
    if ("refused" in r) throw new Error(r.refused);
    expect(r.authorization?.effects[3]).toMatchObject({
      to: { value: true, date: "2026-11-08" },
      from: { closed: false, date: null },
      expectRev: "r3",
    });
    // A date with a time is not a LocalDate: no Restore.
    plan(range(8).map((k) => reopened(k, "2026-11-08T10:00:00Z")));
    expect(holds().restore("b", "guard_mass_status", "prefer_lfcp_status")).toEqual({
      refused: "not a LocalDate: 2026-11-08T10:00:00Z",
    });
    expect(holds().has("b", "guard_mass_status")).toBe(true);
  });

  it("Reopen the tasks for everyone: task.reopen for the Tasks completed in LFCP", () => {
    const completed = (k: number) =>
      intent(
        k,
        "to_apple",
        { rev: `r${k}`, pL: { status: done() }, pA: { status: open }, shadow: { status: "done" } },
        {
          kind: "update",
          ref: { id: `A${k}` },
          set: { completed: { value: true } },
          expect: { rev: `r${k}` },
        },
      );
    plan(range(8).map(completed));
    const r = holds().restore("b", "guard_mass_status", "reopen");
    if ("refused" in r) throw new Error(r.refused);
    const reopen = (k: number) =>
      intent(
        k,
        "to_lfcp",
        { rev: `r${k}`, pL: { status: done() }, pA: { status: open } },
        { resource: "R", intents: [{ intent: "task.reopen", id: `L${k}` }] },
      );
    expect(plan(range(8).map(reopen))).toEqual({ ok: true, accepted: ["guard_mass_status"] });
    expect(auths().get(r.authorization?.id as string)).toMatchObject({ outcome: "consumed" });
  });

  it("Create new reminders: the deleted links' unlinks are authorized, the window moves on consumed only", () => {
    const deleted = (...ks: number[]) =>
      ks.map((k) => ({ taskId: `L${k}`, cause: "deleted_in_apple" as const, externalId: `E${k}` }));
    plan([], deleted(0, 1, 2, 3, 4));
    const r = holds().restore("b", "guard_mass_unlink", "recreate");
    if ("refused" in r) throw new Error(r.refused);
    expect(r.authorization?.effects[0]).toEqual({
      taskId: "L0",
      effect: "apple_create",
      field: "link",
      from: { state: "linked", cause: "deleted_in_apple", externalId: "E0" },
      to: { state: "pending_apple_create" },
    });
    expect(holds().acceptedAt("b", "guard_mass_unlink")).toBeUndefined();
    // Moved out instead of deleted: not what was answered.
    expect(plan([], [...deleted(0, 1, 2, 3), { taskId: "L4", cause: "moved_out" }]).ok).toBe(false);
    expect(auths().get(r.authorization?.id as string)).toMatchObject({ outcome: "changed" });
    expect(holds().acceptedAt("b", "guard_mass_unlink")).toBeUndefined();
    const again = holds().restore("b", "guard_mass_unlink", "recreate");
    expect(again).toEqual({ refused: "not all deleted in Reminders" });
    holds().lift("b", "guard_mass_unlink");
    plan([], deleted(0, 1, 2, 3, 4));
    holds().restore("b", "guard_mass_unlink", "recreate");
    expect(plan([], deleted(0, 1, 2, 3, 4))).toEqual({ ok: true, accepted: ["guard_mass_unlink"] });
    expect(holds().acceptedAt("b", "guard_mass_unlink")).toBe(new Date(t).toISOString());
  });

  it("Keep only in Reminders: the reminders are ignored, no authorization, the decision done", () => {
    const imported = (k: number, externalId?: string) => ({
      ...intent(
        k,
        "to_lfcp",
        { reminder: { id: `A${k}`, ...(externalId === undefined ? {} : { externalId }) } },
        {},
      ),
      kind: "create_task",
      fields: ["title"],
    });
    plan(range(11).map((k) => imported(k, k === 0 ? undefined : `E${k}`)));
    const r = holds().restore("b", "guard_mass_import", "suppress", { answerId: "ans" });
    if ("refused" in r) throw new Error(r.refused);
    expect(r.authorization).toBeUndefined();
    expect(r.decision).toMatchObject({ kind: "suppress", state: "done" });
    expect(auths().ignored("b", "id:A0")).toBe(true);
    expect(auths().ignored("b", "ext:E5")).toBe(true);
    expect(auths().ignored("b", "id:A5")).toBe(false);
    expect(holds().of("b")).toEqual([]);
  });

  it("refused, nothing written, the hold kept: not held, a hold of 0.5, another reason, mixed statuses", () => {
    expect(holds().restore("b", "guard_mass_status", "prefer_lfcp_status")).toEqual({
      refused: "guard_mass_status is not held",
    });
    holds().set("b", "guard_mass_status", { links: 12 });
    expect(holds().restore("b", "guard_mass_status", "prefer_lfcp_status")).toEqual({
      refused: "the hold has no snapshot",
    });
    holds().lift("b", "guard_mass_status");
    // 4 completed and 4 reopened in Reminders: a mixed group has no Restore.
    const reopenedInApple = (k: number) =>
      intent(
        k,
        "to_lfcp",
        { rev: `r${k}`, pL: { status: done() }, pA: { status: open } },
        { resource: "R", intents: [{ intent: "task.reopen", id: `L${k}` }] },
      );
    plan([...range(4).map((k) => appleCompleted(k)), ...range(4, 4).map(reopenedInApple)]);
    expect(holds().restore("b", "guard_mass_status", "recreate")).toEqual({
      refused: "recreate does not answer guard_mass_status",
    });
    expect(holds().restore("b", "guard_mass_status", "prefer_lfcp_status")).toEqual({
      refused: "mixed status changes",
    });
    // Changed in LFCP, not in Reminders.
    plan(range(8).map((k) => reopenReminder(k)));
    expect(holds().restore("b", "guard_mass_status", "prefer_lfcp_status")).toEqual({
      refused: "not a status change made in Reminders",
    });
    expect(holds().has("b", "guard_mass_status")).toBe(true);
    for (const table of ["authorizations", "decisions", "ignored_imports"])
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  });
});
