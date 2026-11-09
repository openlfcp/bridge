// Delivery of to_lfcp intents (D-010 §5.9, R2-10; r3 P2-3): what the batch
// status of an intent's commit means for the intent, its fields' bases and
// conflicts, in one bridge.sqlite transaction.
//
// | batch                                   | here                                              |
// | receipt with no unitIds (no-op)         | delivered at once (the SDK keeps it `saved`)      |
// | saved, pending                          | syncing                                           |
// | accepted                                | delivered (releaseReceipt later); not final: an   |
// |                                         | ACKed unit the server lost is offered again → pending |
// | evidence-unavailable                    | unconfirmed, never green                          |
// | rejected, acceptedUnitIds empty         | refused; per field, by generation (below)         |
// | rejected, acceptedUnitIds not empty     | partial; per field, by the same generation rule   |
// | blocked                                 | hold access_refused → revocationStatus            |
//
// The generation rule (both rejected rows, r3 P2-3): a field whose base was
// last finalized by this intent (`bases.intent_id = id`) gets a conflict
// (`lfcp_rejected` / `lfcp_partial`) and its LFCP base becomes the projection
// of the replica **now**; a field finalized by a newer intent since keeps its
// base, and the refusal is only recorded (journal, the intent's evidence).
// The refused intent keeps its evidence: the SDK's status, the accepted unit
// IDs and the rejection.

import { randomUUID } from "node:crypto";
import type { BatchStatus } from "@openlfcp/client";
import { toHex } from "@openlfcp/core";
import type { BridgeDatabase } from "../db/database.js";
import { Holds } from "../db/holds.js";
import { Journal } from "../db/journal.js";

/** The projection and exact value of a field of a Task in the replica now (PR 8's projections). */
export type CurrentLfcp = (
  taskId: string,
  field: string,
) => { readonly proj: unknown; readonly shadow: unknown };

export type Delivery =
  | "delivered"
  | "syncing"
  | "unconfirmed"
  | "refused"
  | "partial"
  | "blocked"
  /** The same status again, or a final one already recorded: nothing changed. */
  | "unchanged"
  /** No to_lfcp intent has this operation ID (not the bridge's). */
  | "unknown-intent";

export interface DeliveryOptions {
  readonly current: CurrentLfcp;
  readonly now?: () => number;
  /** A blocked batch: the access tracker asks revocationStatus (§5.9). */
  readonly onBlocked?: (resourceHex: string) => void;
}

interface IntentRow {
  id: string;
  binding_id: string;
  task_id: string;
  fields_json: string;
  state: string;
  batch_status: string | null;
  accepted_unit_ids_json: string | null;
}

/** Applies one batch status of the commit `status.operationId` (§5.9). */
export function deliver(
  db: BridgeDatabase,
  status: BatchStatus,
  options: DeliveryOptions,
): Delivery {
  const now = options.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const journal = new Journal(db, now);
  let blockedResource: string | undefined;
  const result = db
    .transaction((): Delivery => {
      const intent = db
        .prepare(
          "SELECT id, binding_id, task_id, fields_json, state, batch_status, accepted_unit_ids_json FROM intents WHERE operation_id = ? AND direction = 'to_lfcp'",
        )
        .get(status.operationId) as IntentRow | undefined;
      if (intent === undefined) return "unknown-intent";
      const name = status.unitIds.length === 0 ? "noop" : status.status;
      const accepted = status.acceptedUnitIds.map(toHex).sort();
      const keptAccepted = (JSON.parse(intent.accepted_unit_ids_json ?? "[]") as string[]).sort();
      const sameEvidence =
        accepted.length === keptAccepted.length && accepted.every((u, i) => u === keptAccepted[i]);
      // A no-op receipt is delivered for good; a rejection stays one (the SDK keeps it) and
      // only its evidence may grow. Anything else follows the SDK: an accepted batch whose
      // units the server lost is offered again, pending until a new ACK (review PR 3b #6).
      if (intent.batch_status === "noop") return "unchanged";
      if (intent.batch_status === "rejected" && name !== "rejected") return "unchanged";
      if (intent.batch_status === name && sameEvidence) return "unchanged";
      const setStatus = db.prepare(
        "UPDATE intents SET batch_status = ?, accepted_unit_ids_json = ? WHERE id = ?",
      );
      const acceptedJson = JSON.stringify(accepted);
      switch (name) {
        case "noop":
        case "accepted":
          setStatus.run(name, acceptedJson, intent.id);
          return "delivered";
        case "saved":
        case "pending":
          setStatus.run(name, acceptedJson, intent.id);
          return "syncing";
        case "evidence-unavailable":
          setStatus.run(name, acceptedJson, intent.id);
          return "unconfirmed";
        case "blocked": {
          setStatus.run(name, acceptedJson, intent.id);
          const binding = db
            .prepare("SELECT resource_id FROM bindings WHERE id = ?")
            .get(intent.binding_id) as { resource_id: string } | undefined;
          new Holds(db, now).set(intent.binding_id, "access_refused", {
            operationId: status.operationId,
          });
          blockedResource = binding?.resource_id;
          return "blocked";
        }
        case "rejected":
          return rejected(db, intent, status, accepted, options.current, iso, journal);
        default:
          return "unchanged";
      }
    })
    .immediate();
  if (blockedResource !== undefined) options.onBlocked?.(blockedResource);
  return result;
}

/**
 * A rejection, first reported or with more evidence since (a NACK of one
 * unit, then an ACK of another: both reports are "rejected", review PR 3b
 * #5). The generation rule applies on every report: a field this intent last
 * finalized gets (or keeps) its conflict, now classified by the evidence;
 * a field finalized by a newer intent is only recorded.
 */
function rejected(
  db: BridgeDatabase,
  intent: IntentRow,
  status: BatchStatus,
  accepted: readonly string[],
  current: CurrentLfcp,
  iso: () => string,
  journal: Journal,
): Delivery {
  const partial = accepted.length > 0;
  const kind = partial ? "lfcp_partial" : "lfcp_rejected";
  const again = intent.batch_status === "rejected";
  db.prepare(
    `UPDATE intents SET state = 'refused', state_reason = ?, batch_status = 'rejected',
       accepted_unit_ids_json = ?, last_error_json = ? WHERE id = ?`,
  ).run(
    kind,
    JSON.stringify(accepted),
    JSON.stringify({
      code: status.rejection?.code ?? null,
      unitIds: (status.rejection?.unitIds ?? []).map(toHex),
      unitIdsAll: status.unitIds.map(toHex),
    }),
    intent.id,
  );
  const fields = JSON.parse(intent.fields_json) as string[];
  const base = db.prepare(
    "SELECT intent_id, apple_proj_json FROM bases WHERE binding_id = ? AND task_id = ? AND field = ?",
  );
  const openConflict = db.prepare(
    `SELECT id FROM conflicts WHERE intent_id = ? AND field = ? AND resolved_at IS NULL
       AND kind IN ('lfcp_rejected', 'lfcp_partial')`,
  );
  const conflicted: string[] = [];
  const recordedOnly: string[] = [];
  for (const field of fields) {
    const b = base.get(intent.binding_id, intent.task_id, field) as
      | { intent_id: string | null; apple_proj_json: string | null }
      | undefined;
    if (b?.intent_id !== intent.id) {
      // Finalized by a newer intent since (or never by this one): its base stands.
      recordedOnly.push(field);
      continue;
    }
    conflicted.push(field);
    const existing = openConflict.get(intent.id, field) as { id: string } | undefined;
    if (existing !== undefined) {
      // Already reported: the classification follows the evidence; the base is the replica's.
      db.prepare("UPDATE conflicts SET kind = ? WHERE id = ?").run(kind, existing.id);
      continue;
    }
    const now = current(intent.task_id, field);
    db.prepare(
      `UPDATE bases SET lfcp_proj_json = ?, lfcp_shadow_json = ?, updated_at = ?
         WHERE binding_id = ? AND task_id = ? AND field = ?`,
    ).run(
      JSON.stringify(now.proj),
      JSON.stringify(now.shadow),
      iso(),
      intent.binding_id,
      intent.task_id,
      field,
    );
    db.prepare(
      `INSERT INTO conflicts (id, binding_id, task_id, field, kind, lfcp_json, apple_json, intent_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      intent.binding_id,
      intent.task_id,
      field,
      kind,
      JSON.stringify(now.proj),
      b.apple_proj_json,
      intent.id,
      iso(),
    );
  }
  journal.append(
    "warn",
    partial ? "delivery.partial" : "delivery.rejected",
    partial
      ? "LFCP accepted only part of a change made from Reminders"
      : "LFCP refused a change made from Reminders",
    {
      bindingId: intent.binding_id,
      data: {
        intent: intent.id,
        task: intent.task_id,
        code: status.rejection?.code ?? null,
        accepted,
        again,
        conflicts: conflicted,
        recordedOnly,
      },
    },
  );
  return partial ? "partial" : "refused";
}
