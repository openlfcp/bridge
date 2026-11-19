// L0 of E-030b: the status fields of `bindings/<X>` (A§3.2, §3.5).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BridgeDatabase,
  bindingStatus,
  markCompleteCheck,
  nextGeneration,
  openBridgeDatabase,
} from "../src/index.js";

let dir: string;
let d: BridgeDatabase;
const now = "2026-11-19T10:00:00.000Z";
const open = () => openBridgeDatabase(join(dir, "bridge.sqlite"));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lfcp-bridge-status-"));
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
describe("binding status fields (A§3.2, §3.5)", () => {
  it("count open intents per direction, unresolved refused and unconfirmed ones", () => {
    intent("o1", "to_apple");
    intent("o2", "to_lfcp", "effecting");
    intent("f1", "to_apple", "refused");
    intent("f2", "to_lfcp", "refused");
    d.prepare(
      "INSERT INTO intent_resolutions (intent_id, resolution, resolved_at) VALUES ('f2', 'dismissed', ?)",
    ).run(now);
    intent("u1", "to_apple", "quarantined", "unknown_outcome");
    intent("u2", "to_lfcp", "finalized");
    markCompleteCheck(d, "b1", now);
    expect(bindingStatus(d, "b1")).toEqual({
      generation: 0,
      lastCompleteCheckAt: now,
      pending: { toApple: 1, toLfcp: 1 },
      refused: 1,
      unconfirmed: 2,
    });
    expect(bindingStatus(d, "nope")).toBeUndefined();
    expect(nextGeneration(d, "b1")).toBe(1);
    expect(bindingStatus(d, "b1")?.generation).toBe(1);
  });
});
