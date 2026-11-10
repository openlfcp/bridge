// The decisions of a pass that change no side, only what the bridge knows (D-010 §5.5, PR 9b):
//
// | decision | here                                                                          |
// |----------|-------------------------------------------------------------------------------|
// | bases    | equivalent sides (a first link, both changed alike, a "=" row of the status   |
// |          | table): both bases := the projections now, the shadow := LFCP's exact value   |
// | shadow   | the LFCP shadow changed under an equal projection (done ↔ cancelled, …)       |
//
// Recorded only when a pass applies (not in a dry run), after the whole pass was admitted. The
// bases' intent_id becomes NULL: no intent finalized them, so a late rejection of an older intent
// leaves them alone (§5.9's generation rule). The Apple native value stays as it was.

import type { Plan } from "@openlfcp/bridge-reminders/adapter";
import type { BridgeDatabase } from "../db/database.js";

export function recordDecisions(
  db: BridgeDatabase,
  plan: Plan,
  now: () => number = Date.now,
): number {
  const at = new Date(now()).toISOString();
  const upsert = db.prepare(
    `INSERT INTO bases (binding_id, task_id, field, lfcp_proj_json, lfcp_shadow_json, apple_proj_json,
       intent_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT (binding_id, task_id, field) DO UPDATE SET lfcp_proj_json = excluded.lfcp_proj_json,
       lfcp_shadow_json = excluded.lfcp_shadow_json, apple_proj_json = excluded.apple_proj_json,
       intent_id = NULL, updated_at = excluded.updated_at`,
  );
  const shadow = db.prepare(
    "UPDATE bases SET lfcp_shadow_json = ?, updated_at = ? WHERE binding_id = ? AND task_id = ? AND field = ?",
  );
  let n = 0;
  db.transaction(() => {
    for (const d of plan.decisions) {
      if (d.decision === "bases") {
        upsert.run(
          plan.bindingId,
          d.taskId,
          d.field,
          JSON.stringify(d.lfcp ?? null),
          JSON.stringify(d.shadow ?? null),
          JSON.stringify(d.apple ?? null),
          at,
        );
        n++;
      } else if (d.decision === "shadow" && d.shadow !== undefined) {
        n += shadow.run(JSON.stringify(d.shadow), at, plan.bindingId, d.taskId, d.field).changes;
      }
    }
  }).immediate();
  return n;
}
