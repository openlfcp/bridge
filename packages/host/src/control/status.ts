// The status fields of `bindings/<X>` (A§3.2, §3.5): the generation, the last complete check and
// what keeps "Up to date" away — open intents per direction, refused and unconfirmed ones (no
// person has resolved them). The writer of `C` (E-030c) publishes them.

import type { BridgeDatabase } from "../db/database.js";

export interface BindingStatus {
  readonly generation: number;
  readonly lastCompleteCheckAt: string | null;
  readonly pending: { readonly toApple: number; readonly toLfcp: number };
  readonly refused: number;
  /** An unknown outcome waiting for a person, or a batch to LFCP not confirmed final. */
  readonly unconfirmed: number;
}

export function bindingStatus(db: BridgeDatabase, binding: string): BindingStatus | undefined {
  const b = db
    .prepare("SELECT generation, last_complete_check_at AS at FROM bindings WHERE id = ?")
    .get(binding) as { generation: number; at: string | null } | undefined;
  if (b === undefined) return undefined;
  const n = (sql: string) => (db.prepare(sql).get(binding) as { n: number }).n;
  const unresolved = "id NOT IN (SELECT intent_id FROM intent_resolutions)";
  const open = "state IN ('prepared','effecting','applied')";
  return Object.freeze({
    generation: b.generation,
    lastCompleteCheckAt: b.at,
    pending: Object.freeze({
      toApple: n(
        `SELECT count(*) AS n FROM intents WHERE binding_id = ? AND direction = 'to_apple' AND ${open}`,
      ),
      toLfcp: n(
        `SELECT count(*) AS n FROM intents WHERE binding_id = ? AND direction = 'to_lfcp' AND ${open}`,
      ),
    }),
    refused: n(
      `SELECT count(*) AS n FROM intents WHERE binding_id = ? AND state = 'refused' AND ${unresolved}`,
    ),
    unconfirmed: n(
      `SELECT count(*) AS n FROM intents WHERE binding_id = ? AND ((state = 'quarantined'
         AND state_reason = 'unknown_outcome' AND ${unresolved}) OR (direction = 'to_lfcp'
         AND state = 'finalized' AND coalesce(batch_status, '') NOT IN ('accepted','noop')))`,
    ),
  });
}

/** A check that saw the whole section and the whole list (A§3.5 "Up to date" ≤ 75 min). */
export function markCompleteCheck(db: BridgeDatabase, binding: string, at: string): void {
  db.prepare("UPDATE bindings SET last_complete_check_at = ? WHERE id = ?").run(at, binding);
}

/** A new generation of the binding (turn-off/on, remove): requests for the old one are stale. */
export function nextGeneration(db: BridgeDatabase, binding: string): number {
  return (
    db
      .prepare("UPDATE bindings SET generation = generation + 1 WHERE id = ? RETURNING generation")
      .get(binding) as { generation: number }
  ).generation;
}
