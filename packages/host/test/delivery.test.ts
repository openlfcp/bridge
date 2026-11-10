// Delivery of to_lfcp intents (D-010 §5.9, R2-10, r3 P2-3).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BatchStatus } from "@openlfcp/client";
import { type DataUnitId, dataUnitId, generateResourceId, toHex } from "@openlfcp/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BridgeDatabase, deliver, Holds, Journal, openBridgeDatabase } from "../src/index.js";

let dir: string;
let db: BridgeDatabase;
const R = toHex(generateResourceId());
const now = "2026-11-10T00:00:00.000Z";
const unit = (n: number): DataUnitId => dataUnitId(new Uint8Array(32).fill(n));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lfcp-bridge-delivery-"));
  db = openBridgeDatabase(join(dir, "bridge.sqlite"));
  db.prepare(
    "INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES ('i', 'd', 'p', 'r', 'l', ?)",
  ).run(now);
  db.prepare(
    "INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, target_ref, state, created_at) VALUES ('b', 'i', ?, 'apple-reminders', 'fake', 'L', 'active', ?)",
  ).run(R, now);
  db.prepare(
    "INSERT INTO links (binding_id, task_id, origin, state, created_at, updated_at) VALUES ('b', 'T', 'apple', 'linked', ?, ?)",
  ).run(now, now);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function intent(id: string, fields: string[], state = "finalized") {
  db.prepare(
    `INSERT INTO intents (id, binding_id, task_id, installation_id, direction, kind, fields_json, basis_json,
       payload_json, operation_id, state, created_at)
     VALUES (?, 'b', 'T', 'i', 'to_lfcp', 'update_task', ?, '{}', '[]', ?, ?, ?)`,
  ).run(id, JSON.stringify(fields), `brg1:${id}`, state, now);
}
function base(field: string, intentId: string, lfcp: unknown, apple: unknown) {
  db.prepare(
    `INSERT INTO bases (binding_id, task_id, field, lfcp_proj_json, lfcp_shadow_json, apple_proj_json,
       apple_native_json, intent_id, updated_at) VALUES ('b', 'T', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (binding_id, task_id, field) DO UPDATE SET lfcp_proj_json = excluded.lfcp_proj_json,
       lfcp_shadow_json = excluded.lfcp_shadow_json, apple_proj_json = excluded.apple_proj_json,
       intent_id = excluded.intent_id`,
  ).run(
    field,
    JSON.stringify(lfcp),
    JSON.stringify(lfcp),
    JSON.stringify(apple),
    JSON.stringify(apple),
    intentId,
    now,
  );
}
const status = (
  id: string,
  s: BatchStatus["status"],
  units: DataUnitId[],
  accepted: DataUnitId[] = [],
  rejection?: BatchStatus["rejection"],
): BatchStatus => ({
  operationId: `brg1:${id}`,
  status: s,
  unitIds: units,
  acceptedUnitIds: accepted,
  affectedNodeIds: ["T"],
  ...(rejection === undefined ? {} : { rejection }),
});
/** The replica now: the rejected value never applied there. */
const current = (_task: string, field: string) => ({
  proj: `${field}@replica`,
  shadow: `${field}@replica`,
});
const row = (id: string) =>
  db
    .prepare(
      "SELECT state, state_reason, batch_status, accepted_unit_ids_json, last_error_json FROM intents WHERE id = ?",
    )
    .get(id) as Record<string, string>;
const baseOf = (field: string) =>
  db.prepare("SELECT lfcp_proj_json, intent_id FROM bases WHERE field = ?").get(field) as {
    lfcp_proj_json: string;
    intent_id: string;
  };
const conflicts = () =>
  db
    .prepare("SELECT field, kind, intent_id, lfcp_json, apple_json FROM conflicts ORDER BY field")
    .all();

describe("deliver (§5.9)", () => {
  it("a no-op receipt (no units) is delivered at once", () => {
    intent("I0", ["title"], "applied");
    expect(deliver(db, status("I0", "saved", []), { current })).toBe("delivered");
    expect(row("I0").batch_status).toBe("noop");
    expect(deliver(db, status("I0", "saved", []), { current })).toBe("unchanged");
  });

  it("saved / pending sync, evidence-unavailable is not green, accepted is delivered", () => {
    intent("I1", ["title"]);
    expect(deliver(db, status("I1", "saved", [unit(1)]), { current })).toBe("syncing");
    expect(deliver(db, status("I1", "pending", [unit(1)]), { current })).toBe("syncing");
    expect(deliver(db, status("I1", "evidence-unavailable", [unit(1)]), { current })).toBe(
      "unconfirmed",
    );
    expect(deliver(db, status("I1", "accepted", [unit(1)], [unit(1)]), { current })).toBe(
      "delivered",
    );
    // The same report again changes nothing.
    expect(deliver(db, status("I1", "accepted", [unit(1)], [unit(1)]), { current })).toBe(
      "unchanged",
    );
    expect(row("I1")).toMatchObject({ state: "finalized", batch_status: "accepted" });
    expect(conflicts()).toEqual([]);
  });

  it("blocked: hold access_refused on the binding, and the tracker is told", () => {
    intent("I2", ["title"]);
    const told: string[] = [];
    expect(
      deliver(db, status("I2", "blocked", [unit(2)]), { current, onBlocked: (r) => told.push(r) }),
    ).toBe("blocked");
    expect(new Holds(db).has("b", "access_refused")).toBe(true);
    expect(told).toEqual([R]);
  });

  it("rejected, nothing accepted: a field this intent finalized gets lfcp_rejected and the replica's base", () => {
    intent("I3", ["title", "due"]);
    base("title", "I3", "B", "B");
    base("due", "I3", "2026-11-12", "2026-11-12");
    const rejection = { code: "AUTHORIZATION_FAILED", unitIds: [unit(3)] };
    expect(deliver(db, status("I3", "rejected", [unit(3)], [], rejection), { current })).toBe(
      "refused",
    );
    expect(row("I3")).toMatchObject({
      state: "refused",
      state_reason: "lfcp_rejected",
      batch_status: "rejected",
    });
    expect(JSON.parse(row("I3").last_error_json as string)).toMatchObject({
      code: "AUTHORIZATION_FAILED",
    });
    expect(conflicts()).toEqual([
      {
        field: "due",
        kind: "lfcp_rejected",
        intent_id: "I3",
        lfcp_json: '"due@replica"',
        apple_json: '"2026-11-12"',
      },
      {
        field: "title",
        kind: "lfcp_rejected",
        intent_id: "I3",
        lfcp_json: '"title@replica"',
        apple_json: '"B"',
      },
    ]);
    expect(baseOf("title")).toEqual({ lfcp_proj_json: '"title@replica"', intent_id: "I3" });
    expect(deliver(db, status("I3", "rejected", [unit(3)], [], rejection), { current })).toBe(
      "unchanged",
    );
    expect(conflicts()).toHaveLength(2);
  });

  it("partial: the same generation rule; accepted units kept as evidence", () => {
    intent("I4", ["title"]);
    base("title", "I4", "B", "B");
    const rejection = { code: "PROFILE_INVALID", unitIds: [unit(5)] };
    expect(
      deliver(db, status("I4", "rejected", [unit(4), unit(5)], [unit(4)], rejection), { current }),
    ).toBe("partial");
    expect(row("I4")).toMatchObject({ state: "refused", state_reason: "lfcp_partial" });
    expect(JSON.parse(row("I4").accepted_unit_ids_json as string)).toEqual([toHex(unit(4))]);
    expect(conflicts()).toMatchObject([{ field: "title", kind: "lfcp_partial", intent_id: "I4" }]);
    expect(baseOf("title").lfcp_proj_json).toBe('"title@replica"');
  });

  it("I1 partially rejected after I2 finalized the same field: I2's base stands, I1's evidence kept (r3 P2-3)", () => {
    intent("I1", ["title"]);
    intent("I2", ["title"]);
    // I1 finalized the title (B), then I2 (C): the base is I2's generation.
    base("title", "I1", "B", "B");
    base("title", "I2", "C", "C");
    const rejection = { code: "PROFILE_INVALID", unitIds: [unit(7)] };
    expect(
      deliver(db, status("I1", "rejected", [unit(6), unit(7)], [unit(6)], rejection), { current }),
    ).toBe("partial");
    expect(baseOf("title")).toEqual({ lfcp_proj_json: '"C"', intent_id: "I2" });
    expect(conflicts()).toEqual([]);
    expect(row("I1")).toMatchObject({
      state: "refused",
      state_reason: "lfcp_partial",
      batch_status: "rejected",
    });
    expect(JSON.parse(row("I1").accepted_unit_ids_json as string)).toEqual([toHex(unit(6))]);
    expect(row("I2").state).toBe("finalized");
    const [entry] = new Journal(db).list({ bindingId: "b" });
    expect(entry).toMatchObject({
      key: "delivery.partial",
      taskId: "T",
      params: { intent: "I1", conflicts: [], recordedOnly: ["title"] },
    });
    // The same with nothing accepted: the same rule.
    intent("I5", ["title"]);
    expect(deliver(db, status("I5", "rejected", [unit(8)], [], rejection), { current })).toBe(
      "refused",
    );
    expect(baseOf("title")).toEqual({ lfcp_proj_json: '"C"', intent_id: "I2" });
    expect(conflicts()).toEqual([]);
  });

  it("an operation that is not the bridge's is not touched", () => {
    expect(deliver(db, status("nobody", "accepted", [unit(9)], [unit(9)]), { current })).toBe(
      "unknown-intent",
    );
  });

  // Review PR 3b (r2).
  it("#5 a rejected batch whose accepted units grow becomes partial, by the same generation rule", () => {
    intent("I6", ["title"]);
    base("title", "I6", "B", "B");
    const rejection = { code: "PROFILE_INVALID", unitIds: [unit(12)] };
    // First the NACK of U2, then the ACK of U1: both reports are "rejected".
    expect(
      deliver(db, status("I6", "rejected", [unit(11), unit(12)], [], rejection), { current }),
    ).toBe("refused");
    expect(
      deliver(db, status("I6", "rejected", [unit(11), unit(12)], [unit(11)], rejection), {
        current,
      }),
    ).toBe("partial");
    expect(row("I6")).toMatchObject({ state: "refused", state_reason: "lfcp_partial" });
    expect(JSON.parse(row("I6").accepted_unit_ids_json as string)).toEqual([toHex(unit(11))]);
    expect(conflicts()).toMatchObject([{ field: "title", kind: "lfcp_partial", intent_id: "I6" }]);
    // Again the same: nothing changes.
    expect(
      deliver(db, status("I6", "rejected", [unit(11), unit(12)], [unit(11)], rejection), {
        current,
      }),
    ).toBe("unchanged");
    expect(conflicts()).toHaveLength(1);
  });

  it("#5 pending with more accepted units keeps the evidence", () => {
    intent("I7", ["title"]);
    deliver(db, status("I7", "pending", [unit(13), unit(14)]), { current });
    expect(
      deliver(db, status("I7", "pending", [unit(13), unit(14)], [unit(13)]), { current }),
    ).toBe("syncing");
    expect(JSON.parse(row("I7").accepted_unit_ids_json as string)).toEqual([toHex(unit(13))]);
  });

  it("#6 accepted is not final: units the server lost are offered again (pending), then accepted again", () => {
    intent("I8", ["title"]);
    expect(deliver(db, status("I8", "accepted", [unit(15)], [unit(15)]), { current })).toBe(
      "delivered",
    );
    expect(deliver(db, status("I8", "pending", [unit(15)]), { current })).toBe("syncing");
    expect(row("I8").batch_status).toBe("pending");
    expect(deliver(db, status("I8", "accepted", [unit(15)], [unit(15)]), { current })).toBe(
      "delivered",
    );
    // A no-op receipt is final.
    intent("I9", ["title"]);
    expect(deliver(db, status("I9", "saved", []), { current })).toBe("delivered");
    expect(deliver(db, status("I9", "pending", []), { current })).toBe("unchanged");
  });
});
