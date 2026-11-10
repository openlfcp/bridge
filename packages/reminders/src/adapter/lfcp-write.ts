// Writes Apple → LFCP (D-010 §4.4 "← LFCP", PR 10): the Task intents that
// carry one field's Apple projection into LFCP, and their deterministic
// application to the Task's exact values — the LFCP base of a to_lfcp
// finalize (§5.6, R2-1: projL(applyIntents(basis, payload.intents))).
//
// | field    | Apple projection → LFCP                                                       |
// |----------|-------------------------------------------------------------------------------|
// | title    | task.set_title (the one-line title)                                           |
// | due      | task.set_due (the date only — time and alarms are personal, B12) / clear_due  |
// | priority | none → normal; high → high, highest if the shadow was highest; low → low,     |
// |          | lowest if it was lowest (B13). A bucket equal to LFCP's is no write at all.   |
// | status   | the status table's action: task.complete (with Apple's date) / task.reopen    |
//
// The intents are the profile's JSON (structurally `TaskIntent` of
// @openlfcp/shared-objects); the adapter does not depend on the SDK.

import type { LocalDate } from "../values.js";
import type { PriorityBucket, Projections } from "./projection.js";
import type { StatusAction } from "./status-table.js";

export type LfcpTaskIntent =
  | { readonly intent: "task.set_title"; readonly id: string; readonly title: string }
  | { readonly intent: "task.set_due"; readonly id: string; readonly date: string }
  | { readonly intent: "task.clear_due"; readonly id: string }
  | { readonly intent: "task.set_priority"; readonly id: string; readonly priority: string }
  | { readonly intent: "task.complete"; readonly id: string; readonly completionDate?: string }
  | { readonly intent: "task.reopen"; readonly id: string };

/** The exact LFCP values the bridge reads and writes (the basis of a to_lfcp intent). */
export interface LfcpValues {
  readonly title: string;
  readonly due: string | null;
  readonly priority: string;
  readonly status: string;
  readonly completion_date: string | null;
}

export function lfcpPriority(bucket: PriorityBucket, shadow: string): string {
  if (bucket === "high") return shadow === "highest" ? "highest" : "high";
  if (bucket === "low") return shadow === "lowest" ? "lowest" : "low";
  return "normal";
}

/** The intents that carry Apple's projection of `field` into the Task `id`. */
export function lfcpWrite(
  field: "title" | "due" | "priority",
  id: string,
  pA: Projections,
  current: LfcpValues,
): readonly LfcpTaskIntent[] {
  switch (field) {
    case "title":
      return [{ intent: "task.set_title", id, title: pA.title }];
    case "due":
      return pA.due === null
        ? [{ intent: "task.clear_due", id }]
        : [{ intent: "task.set_due", id, date: pA.due }];
    case "priority":
      return [
        { intent: "task.set_priority", id, priority: lfcpPriority(pA.priority, current.priority) },
      ];
  }
}

/** The intents of a status-table action on the LFCP side; [] for the others. */
export function lfcpStatusWrite(id: string, action: StatusAction): readonly LfcpTaskIntent[] {
  if (action.kind === "lfcp_complete")
    return [
      {
        intent: "task.complete",
        id,
        ...(action.date === undefined ? {} : { completionDate: action.date }),
      },
    ];
  if (action.kind === "lfcp_reopen") return [{ intent: "task.reopen", id }];
  return [];
}

/**
 * The Task's values after `intents`, as the profile applies them: set_title,
 * set_due / clear_due, set_priority; complete → done (with its date, else the
 * date it had); reopen → todo, no date. Other intents leave the values.
 */
export function applyLfcpIntents(
  values: LfcpValues,
  intents: readonly { readonly intent: string; readonly [k: string]: unknown }[],
): LfcpValues {
  let v = values;
  for (const i of intents) {
    switch (i.intent) {
      case "task.set_title":
        v = { ...v, title: String(i.title) };
        break;
      case "task.set_due":
        v = { ...v, due: String(i.date) };
        break;
      case "task.clear_due":
        v = { ...v, due: null };
        break;
      case "task.set_priority":
        v = { ...v, priority: String(i.priority) };
        break;
      case "task.complete":
        v = {
          ...v,
          status: "done",
          completion_date:
            typeof i.completionDate === "string"
              ? (i.completionDate as LocalDate)
              : v.completion_date,
        };
        break;
      case "task.reopen":
        v = { ...v, status: "todo", completion_date: null };
        break;
      default:
        break;
    }
  }
  return v;
}
