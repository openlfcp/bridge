// Durable acceptances of anomaly snapshots (A§7.1, E18; E-040): an answer
// accepts the anomaly a guard held, checked at every admission against the
// current set of its reason — vanished, consumed, changed. T§3 R3-1a on its
// fixture, a crash after the answer, `count` anomalies, holds of 0.5.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Acceptances,
  type AnomalySnapshot,
  type BridgeDatabase,
  Holds,
  Intents,
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

function open() {
  db = openBridgeDatabase(join(dir, "bridge.sqlite"));
}

beforeEach(() => {
  t = T0;
  dir = mkdtempSync(join(tmpdir(), "lfcp-bridge-acceptances-"));
  open();
  const at = new Date(T0 - 3 * 86_400_000).toISOString();
  db.prepare(
    "INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES ('i', 'd', 'p', 'r', 'l', ?)",
  ).run(at);
  // R3-1a: the binding is older than 24 h — strict mode is over.
  db.prepare(
    "INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, target_ref, state, approved_at, strict_until, created_at) VALUES ('b', 'i', 'R', 'apple-reminders', 'fake', 'L', 'active', ?, ?, ?)",
  ).run(at, new Date(T0 - 2 * 86_400_000).toISOString(), at);
  // …with 20 links: the unlink threshold is > max(3, 2) = 3.
  for (let k = 0; k < 20; k++)
    db.prepare(
      "INSERT INTO links (binding_id, task_id, origin, state, created_at, updated_at) VALUES ('b', ?, 'lfcp', 'linked', ?, ?)",
    ).run(`L${k}`, at, at);
});
afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

const deleted = (...tasks: number[]): PlannedUnlink[] =>
  tasks.map((k) => ({ taskId: `L${k}`, cause: "deleted_in_apple" }));
const limits = () => new Limits(db, undefined, now);
const holds = () => new Holds(db, now);
const acceptances = () => new Acceptances(db, now);
const keys = () => new Journal(db).list().map((e) => e.key);
const anomaly = (reason: string): AnomalySnapshot => {
  const held = holds()
    .of("b")
    .find((h) => h.reason === reason);
  if (held === undefined) throw new Error(`no hold ${reason}`);
  return (held.detail as { anomaly: AnomalySnapshot }).anomaly;
};

/** R3-1a up to the answer: 5 reminders deleted → hold → [Stop syncing them]. */
function answered() {
  expect(limits().admit("b", { intents: [], unlinks: deleted(0, 1, 2, 3, 4) })).toMatchObject({
    ok: false,
    holds: ["guard_mass_unlink"],
  });
  const snap = anomaly("guard_mass_unlink");
  expect(snap).toMatchObject({ binding: "b", reason: "guard_mass_unlink", kind: "set" });
  expect(snap.items.map((i) => [i.taskId, i.cause])).toEqual(
    [0, 1, 2, 3, 4].map((k) => [`L${k}`, "deleted_in_apple"]),
  );
  t += 60_000;
  expect(holds().accept("b", "guard_mass_unlink", { answerId: "ans1" })).toBe(true);
  expect(holds().of("b")).toEqual([]);
  const [a] = acceptances().pending("b");
  expect(a).toMatchObject({
    reason: "guard_mass_unlink",
    anomalyId: snap.anomalyId,
    effectSetHash: snap.effectSetHash,
    answerId: "ans1",
    state: "pending",
  });
  t += 60_000;
  return (a as { id: string }).id;
}

describe("T§3 R3-1a: an answer accepts the anomaly, not the next one", () => {
  it("3 came back + 1 new (3, below the threshold) → void{changed}: held again, the question re-issued", () => {
    const id = answered();
    const a = limits().admit("b", { intents: [], unlinks: deleted(3, 4, 10) });
    expect(a).toMatchObject({ ok: false, holds: ["guard_mass_unlink"] });
    expect(acceptances().get(id)).toMatchObject({ state: "void", outcome: "changed" });
    // A new snapshot: the current set, a new anomaly.
    const again = anomaly("guard_mass_unlink");
    expect(again.items.map((i) => i.taskId)).toEqual(["L3", "L4", "L10"]);
    expect(keys()).toContain("acceptance.changed");
    expect(acceptances().pending("b")).toEqual([]);
  });

  it("all 5 came back → void{vanished}: resolved by itself, the plan admitted by the usual rules", () => {
    const id = answered();
    expect(limits().admit("b", { intents: [], unlinks: [] })).toEqual({ ok: true });
    expect(acceptances().get(id)).toMatchObject({ state: "void", outcome: "vanished" });
    expect(keys()).toContain("acceptance.vanished");
    expect(holds().of("b")).toEqual([]);
  });

  it("2 came back, none new (3 ⊆ 5) → consumed; acceptedAt moves then, not at the answer", () => {
    const id = answered();
    expect(holds().acceptedAt("b", "guard_mass_unlink")).toBeUndefined();
    expect(limits().admit("b", { intents: [], unlinks: deleted(2, 3, 4) })).toEqual({
      ok: true,
      accepted: ["guard_mass_unlink"],
    });
    expect(acceptances().get(id)).toMatchObject({ state: "consumed", outcome: "consumed" });
    expect(holds().acceptedAt("b", "guard_mass_unlink")).toBe(new Date(t).toISOString());
    expect(keys()).toContain("acceptance.consumed");
  });

  it("the very same 5 (above the threshold) → consumed; the same item with another cause → changed", () => {
    const id = answered();
    expect(limits().admit("b", { intents: [], unlinks: deleted(0, 1, 2, 3, 4) })).toMatchObject({
      ok: true,
      accepted: ["guard_mass_unlink"],
    });
    expect(acceptances().get(id)?.state).toBe("consumed");

    db.prepare("DELETE FROM meta").run();
    const other = (() => {
      limits().admit("b", { intents: [], unlinks: deleted(5, 6, 7, 8) });
      holds().accept("b", "guard_mass_unlink");
      return acceptances().pending("b")[0]?.id as string;
    })();
    const moved: PlannedUnlink[] = [...deleted(5, 6, 7), { taskId: "L8", cause: "moved_out" }];
    expect(limits().admit("b", { intents: [], unlinks: moved })).toMatchObject({ ok: false });
    expect(acceptances().get(other)?.outcome).toBe("changed");
  });

  it("a crash after the answer loses nothing; a consumed acceptance is never repeated", () => {
    const id = answered();
    // The admission consumes in the caller's transaction: a crash before its commit undoes it.
    expect(() =>
      db.transaction(() => {
        expect(limits().admit("b", { intents: [], unlinks: deleted(0, 1, 2, 3, 4) }).ok).toBe(true);
        throw new Error("crash");
      })(),
    ).toThrow("crash");
    db.close();
    open();
    expect(acceptances().get(id)?.state).toBe("pending");
    expect(limits().admit("b", { intents: [], unlinks: deleted(0, 1, 2, 3, 4) }).ok).toBe(true);
    expect(acceptances().get(id)?.state).toBe("consumed");
    // The same anomaly once more: nothing left to let it through.
    expect(limits().admit("b", { intents: [], unlinks: deleted(0, 1, 2, 3, 4) })).toMatchObject({
      ok: false,
      holds: ["guard_mass_unlink"],
    });
  });

  it("a waiting acceptance is not used up by a pass another guard holds", () => {
    const id = answered();
    const a = limits().admit("b", { intents: [], unlinks: deleted(2, 3, 4) }, ["guard_count_drop"]);
    expect(a).toMatchObject({ ok: false, holds: ["guard_count_drop"] });
    expect(acceptances().get(id)?.state).toBe("pending");
  });
});

describe("other snapshots", () => {
  const status = (task: string, basis: unknown = { completed: false }): NewIntent => ({
    bindingId: "b",
    taskId: task,
    installationId: "i",
    direction: "to_lfcp",
    kind: "update_task",
    fields: ["status"],
    basis,
    payload: { status: "done" },
  });

  it("status: the same before/bases → consumed; another basis → changed", () => {
    const eleven = Array.from({ length: 11 }, (_, k) => status(`L${k}`));
    expect(limits().admit("b", { intents: eleven, unlinks: 0 })).toMatchObject({
      holds: ["guard_mass_status"],
    });
    expect(anomaly("guard_mass_status").items).toHaveLength(11);
    holds().accept("b", "guard_mass_status");
    const changed = [...eleven.slice(1), status("L0", { completed: true })];
    expect(limits().admit("b", { intents: changed, unlinks: 0 }).ok).toBe(false);
    expect(acceptances().pending("b")).toEqual([]);
    holds().accept("b", "guard_mass_status");
    expect(limits().admit("b", { intents: changed.slice(2), unlinks: 0 })).toEqual({
      ok: true,
      accepted: ["guard_mass_status"],
    });
  });

  it("count drop: the side and the links it stopped counting — the same → consumed; another side or other links → changed", () => {
    const drop = (apple: number[], lfcp: number[] = []) =>
      limits().admit(
        "b",
        {
          intents: [],
          unlinks: 0,
          uncounted: { apple: apple.map((k) => `L${k}`), lfcp: lfcp.map((k) => `L${k}`) },
        },
        ["guard_count_drop"],
      );
    const answer = () => {
      expect(drop([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toMatchObject({
        holds: ["guard_count_drop"],
      });
      expect(anomaly("guard_count_drop").items).toHaveLength(11);
      holds().accept("b", "guard_count_drop");
    };
    answer();
    expect(drop([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({
      ok: true,
      accepted: ["guard_count_drop"],
    });
    // The other side dropped instead (the Tasks are gone, not the reminders).
    answer();
    const lfcp = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(drop(lfcp, lfcp)).toMatchObject({ ok: false, holds: ["guard_count_drop"] });
    expect(keys().filter((k) => k === "acceptance.changed")).toHaveLength(1);
    // Other reminders missing.
    holds().accept("b", "guard_count_drop");
    expect(drop([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19])).toMatchObject({ ok: false });
    expect(keys().filter((k) => k === "acceptance.changed")).toHaveLength(2);
    // The count came back: vanished.
    holds().accept("b", "guard_count_drop");
    expect(
      limits().admit("b", { intents: [], unlinks: 0, uncounted: { apple: [], lfcp: [] } }),
    ).toEqual({ ok: true });
    expect(keys()).toContain("acceptance.vanished");
  });

  it("backlog: the waiting intents — the same → consumed; replaced by others → changed", () => {
    const creates = (p: string) =>
      Array.from(
        { length: 201 },
        (_, j): NewIntent => ({
          bindingId: "b",
          taskId: `${p}${j}`,
          installationId: "i",
          direction: "to_apple",
          kind: "create",
          fields: ["title"],
          basis: null,
          payload: { kind: "create", title: `${p}${j}` },
        }),
      );
    expect(limits().admit("b", { intents: creates("A"), unlinks: 0 })).toMatchObject({
      holds: ["guard_backlog"],
    });
    expect(anomaly("guard_backlog").items).toHaveLength(201);
    holds().accept("b", "guard_backlog");
    expect(limits().admit("b", { intents: creates("B"), unlinks: 0 })).toMatchObject({
      ok: false,
      holds: ["guard_backlog"],
    });
    expect(acceptances().pending("b")).toEqual([]);
    expect(keys()).toContain("acceptance.changed");
    holds().accept("b", "guard_backlog");
    expect(limits().admit("b", { intents: creates("B"), unlinks: 0 })).toEqual({
      ok: true,
      accepted: ["guard_backlog"],
    });
  });

  it("an opaque anomaly (a hold of 0.5, a bare count) lets nothing through: asked again; other holds only lift", () => {
    holds().set("b", "guard_mass_unlink", { links: 20, unlinks: 5 });
    holds().set("b", "helper_stall", { stalls: 2 });
    expect(holds().accept("b", "guard_mass_unlink")).toBe(true);
    expect(holds().accept("b", "helper_stall")).toBe(true);
    expect(
      acceptances()
        .pending("b")
        .map((a) => [a.reason, a.kind]),
    ).toEqual([["guard_mass_unlink", "opaque"]]);
    // Below the threshold too: no data to compare, changed.
    expect(limits().admit("b", { intents: [], unlinks: deleted(0, 1) })).toMatchObject({
      ok: false,
      holds: ["guard_mass_unlink"],
    });
    expect(anomaly("guard_mass_unlink").kind).toBe("set");
    holds().accept("b", "guard_mass_unlink");
    expect(limits().admit("b", { intents: [], unlinks: deleted(0, 1) })).toMatchObject({
      ok: true,
      accepted: ["guard_mass_unlink"],
    });
    // countDrop() knows only the counts: opaque, never consumed while it fires.
    expect(limits().countDrop("b", "apple", 10, 2)).toBe(true);
    expect(anomaly("guard_count_drop")).toMatchObject({ kind: "opaque", items: [] });
    holds().accept("b", "guard_count_drop");
    expect(limits().admit("b", { intents: [], unlinks: 0 }, ["guard_count_drop"])).toMatchObject({
      ok: false,
    });
  });

  it("without an answer the admission is as in 0.5: nothing pending, nothing ended", () => {
    expect(limits().admit("b", { intents: [], unlinks: deleted(0, 1, 2) })).toEqual({ ok: true });
    expect(limits().admit("b", { intents: [], unlinks: deleted(0, 1, 2, 3) })).toMatchObject({
      ok: false,
    });
    expect(db.prepare("SELECT count(*) AS n FROM acceptances").get()).toEqual({ n: 0 });
  });
});

describe("the window keeps its base until an acceptance is consumed (A§7.1, A§8)", () => {
  /** Three unaccepted unlinks journaled in this hour, 20 links: one more is a hold (4 > 3). */
  function heldOnTheWindow(task: number) {
    for (let k = 0; k < 3; k++)
      new Journal(db, () => t - 10 * 60_000).append("info", "link.unlinked", { bindingId: "b" });
    expect(limits().admit("b", { intents: [], unlinks: deleted(task) })).toMatchObject({
      holds: ["guard_mass_unlink"],
    });
    holds().accept("b", "guard_mass_unlink");
    t += 60_000;
  }
  const another = () => limits().check("b", { intents: [], unlinks: deleted(15) });

  it("after void{vanished}", () => {
    heldOnTheWindow(10);
    expect(another()).toMatchObject({ ok: false }); // pending: the window is unchanged
    expect(limits().admit("b", { intents: [], unlinks: [] })).toEqual({ ok: true });
    expect(acceptances().pending("b")).toEqual([]);
    expect(another()).toMatchObject({ ok: false, holds: ["guard_mass_unlink"] });
  });

  it("after void{changed}", () => {
    heldOnTheWindow(10);
    expect(limits().admit("b", { intents: [], unlinks: deleted(11) }).ok).toBe(false);
    expect(keys()).toContain("acceptance.changed");
    expect(another()).toMatchObject({ ok: false, holds: ["guard_mass_unlink"] });
  });

  it("while the acceptance waits behind another hold", () => {
    heldOnTheWindow(10);
    expect(
      limits().admit("b", { intents: [], unlinks: deleted(10) }, ["guard_count_drop"]).ok,
    ).toBe(false);
    expect(acceptances().pending("b")).toHaveLength(1);
    expect(another()).toMatchObject({ ok: false, holds: ["guard_mass_unlink"] });
    expect(holds().acceptedAt("b", "guard_mass_unlink")).toBeUndefined();
  });

  it("imports: the hour of prepared imports stays after void{vanished}", () => {
    const imp = (task: string): NewIntent => ({
      bindingId: "b",
      taskId: task,
      installationId: "i",
      direction: "to_lfcp",
      kind: "create_task",
      fields: ["title"],
      basis: null,
      payload: {},
    });
    const prepared = new Intents(db, () => t - 10 * 60_000);
    for (let k = 0; k < 10; k++) prepared.prepare(imp(`W${k}`));
    expect(limits().admit("b", { intents: [imp("X")], unlinks: 0 })).toMatchObject({
      holds: ["guard_mass_import"],
    });
    holds().accept("b", "guard_mass_import");
    expect(limits().check("b", { intents: [imp("Y")], unlinks: 0 })).toMatchObject({ ok: false });
    expect(limits().admit("b", { intents: [], unlinks: 0 })).toEqual({ ok: true });
    expect(keys()).toContain("acceptance.vanished");
    expect(limits().check("b", { intents: [imp("Y")], unlinks: 0 })).toMatchObject({
      ok: false,
      holds: ["guard_mass_import"],
    });
  });
});

describe("an empty current set is vanished, even while the window fires (A§7.1 row 1, A§8)", () => {
  const imp = (task: string): NewIntent => ({
    bindingId: "b",
    taskId: task,
    installationId: "i",
    direction: "to_lfcp",
    kind: "create_task",
    fields: ["title"],
    basis: null,
    payload: {},
  });
  const unlinkedInTheHour = (n: number) => {
    for (let k = 0; k < n; k++)
      new Journal(db, () => t - 10 * 60_000).append("info", "link.unlinked", { bindingId: "b" });
  };

  it("unlinks: 4 unaccepted in the hour, {L10} held and answered, L10 back → vanished; the window stays", () => {
    unlinkedInTheHour(4);
    expect(limits().admit("b", { intents: [], unlinks: deleted(10) })).toMatchObject({
      holds: ["guard_mass_unlink"],
    });
    holds().accept("b", "guard_mass_unlink");
    const [a] = acceptances().pending("b");
    t += 60_000;
    // L10 came back; the window alone still fires: no acceptance covers it.
    expect(limits().admit("b", { intents: [], unlinks: [] })).toMatchObject({
      ok: false,
      holds: ["guard_mass_unlink"],
    });
    expect(acceptances().get((a as { id: string }).id)).toMatchObject({
      state: "void",
      outcome: "vanished",
    });
    expect(holds().acceptedAt("b", "guard_mass_unlink")).toBeUndefined();
    expect(limits().check("b", { intents: [], unlinks: deleted(15) })).toMatchObject({
      ok: false,
      holds: ["guard_mass_unlink"],
    });
  });

  it("imports: 11 in the hour, {X} answered and gone → vanished; a new {Y} is held", () => {
    const prepared = new Intents(db, () => t - 10 * 60_000);
    for (let k = 0; k < 11; k++) prepared.prepare(imp(`W${k}`));
    expect(limits().admit("b", { intents: [imp("X")], unlinks: 0 })).toMatchObject({
      holds: ["guard_mass_import"],
    });
    holds().accept("b", "guard_mass_import");
    t += 60_000;
    expect(limits().admit("b", { intents: [], unlinks: 0 }).ok).toBe(false);
    expect(
      db.prepare("SELECT state, outcome FROM acceptances WHERE reason = 'guard_mass_import'").all(),
    ).toEqual([{ state: "void", outcome: "vanished" }]);
    expect(holds().acceptedAt("b", "guard_mass_import")).toBeUndefined();
    holds().lift("b", "guard_mass_import");
    expect(limits().admit("b", { intents: [imp("Y")], unlinks: 0 })).toMatchObject({
      ok: false,
      holds: ["guard_mass_import"],
    });
  });

  it("opaque, the current set empty → vanished, the window not moved", () => {
    unlinkedInTheHour(4);
    holds().set("b", "guard_mass_unlink", { links: 20, unlinks: 5 });
    holds().accept("b", "guard_mass_unlink");
    expect(acceptances().pending("b")[0]?.kind).toBe("opaque");
    limits().admit("b", { intents: [], unlinks: [] });
    expect(db.prepare("SELECT state, outcome FROM acceptances").all()).toEqual([
      { state: "void", outcome: "vanished" },
    ]);
    expect(holds().acceptedAt("b", "guard_mass_unlink")).toBeUndefined();
  });

  it("the one exception: a hold the window alone set (an empty set) is consumed by an empty plan", () => {
    unlinkedInTheHour(4);
    expect(limits().admit("b", { intents: [], unlinks: [] })).toMatchObject({
      holds: ["guard_mass_unlink"],
    });
    expect(anomaly("guard_mass_unlink")).toMatchObject({ kind: "set", items: [] });
    holds().accept("b", "guard_mass_unlink");
    t += 60_000;
    expect(limits().admit("b", { intents: [], unlinks: [] })).toEqual({
      ok: true,
      accepted: ["guard_mass_unlink"],
    });
    expect(holds().acceptedAt("b", "guard_mass_unlink")).toBe(new Date(t).toISOString());
    // The window starts at the consumed answer: one new unlink passes.
    expect(limits().check("b", { intents: [], unlinks: deleted(15) })).toEqual({ ok: true });
  });
});
