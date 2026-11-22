// L0 of E-030b: control_exec before any effect (A§3.4), deduplication beyond the maps' cleanup,
// generation, the events machine and the cancel table of A§3.3 (one test per row); a crash
// between control_exec and the effect repeats nothing (B19).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as A from "@automerge/automerge";
import {
  SERVICE_CONTROL_PROFILE_ID,
  SERVICE_CONTROL_ROOT_KEYS,
  validateServiceControl,
} from "@openlfcp/shared-objects/service-control";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BridgeDatabase,
  ControlExec,
  canAdvance,
  checkCode,
  eventOf,
  type Incoming,
  nextGeneration,
  openBridgeDatabase,
} from "../src/index.js";

let dir: string;
let d: BridgeDatabase;
const now = "2026-11-19T10:00:00.000Z";
const open = () => openBridgeDatabase(join(dir, "bridge.sqlite"));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lfcp-bridge-control-"));
  d = open();
  d.prepare(
    "INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES ('i1', 'i', 'p', 'r', 'l', ?)",
  ).run(now);
  d.prepare(
    "INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, state, created_at) VALUES ('b1', 'i1', 'R1', 'apple-reminders', 'eventkit', 'active', ?)",
  ).run(now);
});
afterEach(() => {
  if (d.open) d.close();
  rmSync(dir, { recursive: true, force: true });
});

/** An intent as `plan` writes it: prepared until the executor effects it. */
const intent = (id: string, direction = "to_apple", state = "prepared", reason?: string) => {
  d.prepare(
    `INSERT INTO intents (id, binding_id, task_id, installation_id, direction, kind, fields_json,
       basis_json, payload_json, operation_id, state, state_reason, created_at)
     VALUES (?, 'b1', ?, 'i1', ?, 'update', '[]', '{}', '{}', 'op', ?, ?, ?)`,
  ).run(id, `t-${id}`, direction, state, reason ?? null, now);
  return id;
};
const intentState = (id: string) =>
  (d.prepare("SELECT state FROM intents WHERE id = ?").get(id) as { state: string }).state;
const req = (id: string, op = "turn-off", generation = 0): Incoming => ({
  kind: "request",
  id,
  op,
  binding: "b1",
  generation,
  author: "root",
});
const answer = (id: string, qid: string): Incoming => ({
  kind: "answer",
  id,
  questionId: qid,
  binding: "b1",
  generation: 0,
  choice: "keep",
  author: "personal",
});

/** `C` holding one event as the host writes it, read back by the SDK's §5 validation. */
const inC = (event: ReturnType<typeof eventOf>) => {
  const rid = "019a8f00-0000-7000-8000-000000000001";
  const s = (v: string) => new A.ImmutableString(v);
  const doc = A.change(A.init<Record<string, unknown>>(), (c) => {
    for (const k of SERVICE_CONTROL_ROOT_KEYS) c[k] = {};
    c.profile = s(SERVICE_CONTROL_PROFILE_ID);
    c.meta = { attemptId: s("a"), createdAt: s(now) };
    (c.events as Record<string, unknown>)[rid] = Object.fromEntries(
      Object.entries({ ...event, at: now }).map(([k, v]) => [k, typeof v === "string" ? s(v) : v]),
    );
  });
  const v = validateServiceControl(doc, "R1");
  return { problems: v.problems, event: v.events[rid] };
};
/** A pair-section request for a section with no binding yet (A§4.3 step 1). */
const pairReq = (id: string): Incoming => ({
  kind: "request",
  id,
  op: "pair-section",
  binding: "bX",
  author: "root",
});
describe("events (A§3.3)", () => {
  it("move only forward; a final state never changes; request-ready and ready are pair-section's", () => {
    expect(canAdvance("received", "executing")).toBe(true);
    expect(canAdvance("received", "rejected")).toBe(true);
    expect(canAdvance("executing", "received")).toBe(false);
    expect(canAdvance("applied", "failed")).toBe(false);
    expect(canAdvance("cancelled", "applied")).toBe(false);
    expect(canAdvance("executing", "request-ready", "turn-on")).toBe(false);
    expect(canAdvance("executing", "request-ready", "pair-section")).toBe(true);
    expect(canAdvance("request-ready", "ready", "pair-section")).toBe(true);
    expect(canAdvance("ready", "request-ready", "pair-section")).toBe(false);
  });

  it("a repeatable code is no outcome; failed and rejected need a final code", () => {
    expect(() => checkCode("failed", "network")).toThrow(/repeatable/);
    expect(() => checkCode("failed", undefined)).toThrow(/final code/);
    expect(() => checkCode("rejected", "whatever")).toThrow(/final code/);
    expect(() => checkCode("failed", "capacity")).not.toThrow();
    expect(() => checkCode("stale", undefined)).not.toThrow();
  });
});

describe("control_exec (A§3.4)", () => {
  it("is written with the effects its plan wrote, in one transaction; received in C", () => {
    const x = new ControlExec(d);
    const { fresh, row } = x.admit(req("r1"), { plan: () => [intent("e1"), intent("e2")], now });
    expect(fresh).toBe(true);
    expect(row).toMatchObject({ state: "accepted", effectIds: ["e1", "e2"], author: "root" });
    expect(eventOf(row)).toEqual({ state: "received" });
  });

  it("a failing plan leaves neither the row nor its effects", () => {
    const x = new ControlExec(d);
    expect(() =>
      x.admit(req("r1"), {
        plan: () => {
          intent("e1");
          throw new Error("disk");
        },
      }),
    ).toThrow("disk");
    expect(x.get("r1")).toBeUndefined();
    expect(d.prepare("SELECT count(*) AS n FROM intents").get()).toEqual({ n: 0 });
  });

  it("an id seen again — after the maps are cleaned up — is a duplicate; nothing runs", () => {
    const x = new ControlExec(d);
    x.admit(req("r1"), { plan: () => [intent("e1")] });
    x.advance("r1", "applied");
    // The request and its event left C 7 days later (cleanup); a late copy is seen again.
    let planned = 0;
    const again = x.admit(req("r1"), {
      plan: () => {
        planned++;
        return [];
      },
    });
    expect(again.fresh).toBe(false);
    expect(again.row.state).toBe("applied");
    expect(planned).toBe(0);
  });

  it("an unknown op is rejected{unsupported_op}, nothing planned", () => {
    let planned = false;
    const { row } = new ControlExec(d).admit(req("r1", "export-all"), {
      plan: () => {
        planned = true;
        return [];
      },
    });
    expect(eventOf(row)).toEqual({ state: "rejected", code: "unsupported_op" });
    expect(planned).toBe(false);
  });

  it("another generation, or a removed binding, is stale", () => {
    const x = new ControlExec(d);
    expect(nextGeneration(d, "b1")).toBe(1);
    expect(eventOf(x.admit(req("r1", "turn-off", 0)).row)).toEqual({
      state: "stale",
      code: "stale_generation",
    });
    expect(x.admit(req("r2", "turn-off", 1)).row.state).toBe("accepted");
    d.prepare("UPDATE bindings SET state = 'removed'").run();
    expect(x.admit(req("r3", "turn-off", 1)).row.state).toBe("stale");
  });

  it("the first answer accepted wins; the second is rejected{already_answered}; a check refuses", () => {
    const x = new ControlExec(d);
    expect(
      x.admit(answer("a0", "q1"), {
        check: () => ({ state: "rejected", code: "snapshot_changed" }),
      }).row.code,
    ).toBe("snapshot_changed");
    expect(x.admit(answer("a1", "q1")).row.state).toBe("accepted");
    expect(eventOf(x.admit(answer("a2", "q1")).row)).toEqual({
      state: "rejected",
      code: "already_answered",
    });
    expect(x.admit(answer("a3", "q2")).row.state).toBe("accepted");
  });

  it("states only move forward; a final one ends the row", () => {
    const x = new ControlExec(d);
    x.admit(req("r1"));
    expect(() => x.advance("r1", "failed", "network")).toThrow(/repeatable/);
    expect(x.advance("r1", "executing").endedAt).toBeNull();
    expect(x.advance("r1", "failed", "capacity", now).endedAt).toBe(now);
    expect(() => x.advance("r1", "applied")).toThrow(/failed → applied/);
    expect(x.open()).toEqual([]);
  });
});

describe("the cancel table (A§3.3), one test per row", () => {
  it("before received (with the request or earlier): cancelled, nothing done", () => {
    const x = new ControlExec(d);
    expect(x.cancel("r1")).toBe("unknown");
    let planned = false;
    const { row } = x.admit(req("r1"), {
      cancelled: true,
      plan: () => {
        planned = true;
        return [];
      },
    });
    expect(eventOf(row)).toEqual({ state: "cancelled" });
    expect(planned).toBe(false);
    expect(row.endedAt).not.toBeNull();
  });

  it("after received, before the first effect: cancelled; its unstarted intents superseded", () => {
    const x = new ControlExec(d);
    x.admit(req("r1"), { plan: () => [intent("e1"), intent("e2")] });
    expect(x.cancel("r1")).toBe("cancelled");
    expect([intentState("e1"), intentState("e2")]).toEqual(["superseded", "superseded"]);
    expect(x.beforeEffect("r1", false)).toBe("stop");
    // The executor's own check before an effect sees cancels first.
    x.admit(req("r2"), { plan: () => [intent("e3", "to_lfcp")] });
    expect(x.beforeEffect("r2", true)).toBe("stop");
    expect(x.get("r2")?.state).toBe("cancelled");
    expect(intentState("e3")).toBe("superseded");
  });

  it("an effect started: carried through; applied{lateCancel}", () => {
    const x = new ControlExec(d);
    x.admit(req("r1"), { plan: () => [intent("e1"), intent("e2", "to_lfcp")] });
    expect(x.beforeEffect("r1", false)).toBe("go");
    expect(x.get("r1")?.state).toBe("executing");
    expect(x.cancel("r1")).toBe("late");
    expect(x.beforeEffect("r1", true)).toBe("go");
    expect([intentState("e1"), intentState("e2")]).toEqual(["prepared", "prepared"]);
    const event = eventOf(x.advance("r1", "applied"));
    expect(event).toEqual({ state: "applied", detail: "lateCancel" });
    // The event is one C admits: `detail` is a string (SERVICE-CONTROL-PROFILE-01 §3).
    expect(inC(event)).toEqual({ problems: [], event: { ...event, at: now } });
  });

  it("already applied or final: the cancel is ignored", () => {
    const x = new ControlExec(d);
    x.admit(req("r1"));
    x.advance("r1", "applied");
    expect(x.cancel("r1")).toBe("ignored");
    expect(eventOf(x.get("r1") as never)).toEqual({ state: "applied" });
    x.admit(req("r2", "nope"));
    expect(x.cancel("r2")).toBe("ignored");
  });

  it("a crash: on recovery the same rules by control_exec.state and cancels", () => {
    let x = new ControlExec(d);
    x.admit(req("r1"), { plan: () => [intent("e1")] });
    x.admit(req("r2"), { plan: () => [intent("e2")] });
    x.beforeEffect("r2", false);
    x.admit(req("r3"), { plan: () => [intent("e3")] });
    d.close(); // the host dies; C holds cancels for r1 and r2
    d = open();
    x = new ControlExec(d);
    const carried = x.recover(new Set(["r1", "r2"]));
    expect(x.get("r1")?.state).toBe("cancelled");
    expect(intentState("e1")).toBe("superseded");
    expect(carried.map((r) => [r.id, r.state, r.lateCancel])).toEqual([
      ["r2", "executing", true],
      ["r3", "accepted", false],
    ]);
  });

  it("pair-section passes request-ready and ready before its outcome", () => {
    const x = new ControlExec(d);
    // The section it pairs has no binding yet: not stale (A§4.3 step 1).
    let planned = 0;
    const { row } = x.admit(pairReq("p1"), {
      plan: () => {
        planned++;
        return [];
      },
    });
    expect([row.state, row.binding, planned]).toEqual(["accepted", "bX", 1]);
    // Other ops on a binding that is not there stay stale; so does pair-section's old generation.
    expect(x.admit({ ...req("r1"), binding: "bX" }).row.state).toBe("stale");
    expect(x.admit({ ...pairReq("p2"), binding: "b1", generation: 5 }).row.state).toBe("stale");
    x.advance("p1", "executing");
    expect(eventOf(x.advance("p1", "request-ready"))).toEqual({ state: "request-ready" });
    x.advance("p1", "ready");
    expect(x.advance("p1", "applied").endedAt).not.toBeNull();
  });
});

describe("B19: a crash between control_exec and the effect repeats nothing", () => {
  it("the request seen again after the restart is a duplicate; its one intent is carried on", () => {
    let x = new ControlExec(d);
    x.admit(req("r1"), { plan: () => [intent("e1")] });
    d.close(); // before the executor effected e1
    d = open();
    x = new ControlExec(d);
    // C still has requests/r1: the host reads it again.
    let planned = 0;
    const again = x.admit(req("r1"), {
      plan: () => {
        planned++;
        return [intent("e2")];
      },
    });
    expect(again).toMatchObject({ fresh: false, row: { state: "accepted", effectIds: ["e1"] } });
    expect(planned).toBe(0);
    expect(x.recover(new Set()).map((r) => r.id)).toEqual(["r1"]);
    expect(d.prepare("SELECT id, state FROM intents").all()).toEqual([
      { id: "e1", state: "prepared" },
    ]);
  });
});
