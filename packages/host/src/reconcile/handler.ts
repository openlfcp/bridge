// What the executor asks of the adapter (D-010 §5.6, §5.8; PR 10): the
// finalize formulas, the atomic LFCP basis check, and the replica's
// projections for delivery (§5.9).
//
// Finalize (R2-1), only the intent's fields, `bases.intent_id := intent`:
//
// | direction        | LFCP base (proj, shadow)                         | Apple base (proj, native)                   |
// |------------------|--------------------------------------------------|---------------------------------------------|
// | to_apple update  | basis.pL (what was projected), basis.shadow      | projA(result.written), written              |
// | to_apple create  | the same, for all four fields; the link becomes  | written; a field not written is a new       |
// |                  | linked with the reminder's ids and URL           | reminder's: due none, status open           |
// | to_lfcp          | projL(applyIntents(basis.lfcp, payload.intents)) | basis.pA, basis.native (captured at plan)   |
//
// A snapshot after the effect never goes into the bases: what the person
// changed meanwhile, the next pass finds. B14: Apple values a to_apple
// write overruled are journaled at its finalize.
//
// The basis check runs inside SectionHost's stage (§5.8): the Task's LFCP
// projections of the intent's fields must still be those of the plan, and,
// for a complete without a date, its exact completion_date too (the SDK keeps
// it; review PR 10 #13).

import type { AppleOpSuccess } from "@openlfcp/bridge-reminders";
import {
  applyLfcpIntents,
  FIELDS,
  type Field,
  type LfcpTaskIntent,
  type LfcpValues,
  type PlannedBasis,
  type Projections,
  projectLfcp,
  projectWritten,
  sameProjection,
} from "@openlfcp/bridge-reminders/adapter";
import type { SectionReplica } from "@openlfcp/shared-objects/sections";
import type { BridgeDatabase } from "../db/database.js";
import { Journal } from "../db/journal.js";
import type { IntentHandler } from "../executor/executor.js";
import type { Intent } from "../executor/intents.js";
import type { CurrentLfcp } from "../lfcp/delivery.js";

const NEW_REMINDER: Partial<Projections> = {
  due: null,
  priority: "none",
  status: { closed: false, date: null },
};

/** The values the bridge reads of a Task in the replica now; undefined when it cannot be read. */
function lfcpValues(replica: SectionReplica, taskId: string): LfcpValues | undefined {
  const t = replica.task(taskId)?.task;
  if (t === undefined) return undefined;
  return {
    title: t.title,
    due: t.due ?? null,
    priority: t.priority,
    status: t.status,
    completion_date: t.completion_date ?? null,
  };
}

const shadowOf = (field: Field, v: { status: string; priority: string }): unknown =>
  field === "status" ? v.status : field === "priority" ? v.priority : null;

export interface HandlerOptions {
  /** The zone Apple's completion dates are read in (as the pass's). */
  readonly timeZone: string;
  readonly now?: () => number;
}

export function bridgeHandler(o: HandlerOptions): IntentHandler {
  const now = o.now ?? Date.now;
  const upsert = (
    db: BridgeDatabase,
    i: Intent,
    field: Field,
    v: { lfcp: unknown; shadow: unknown; apple: unknown; native: unknown },
  ) =>
    db
      .prepare(
        `INSERT INTO bases (binding_id, task_id, field, lfcp_proj_json, lfcp_shadow_json, apple_proj_json,
           apple_native_json, intent_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (binding_id, task_id, field) DO UPDATE SET lfcp_proj_json = excluded.lfcp_proj_json,
           lfcp_shadow_json = excluded.lfcp_shadow_json, apple_proj_json = excluded.apple_proj_json,
           apple_native_json = excluded.apple_native_json, intent_id = excluded.intent_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        i.bindingId,
        i.taskId,
        field,
        JSON.stringify(v.lfcp ?? null),
        JSON.stringify(v.shadow ?? null),
        JSON.stringify(v.apple ?? null),
        JSON.stringify(v.native ?? null),
        i.id,
        new Date(now()).toISOString(),
      );

  return {
    finalize(i, result, db) {
      const basis = i.basis as PlannedBasis;
      if (i.direction === "to_lfcp") {
        const p = i.payload as { intents: readonly LfcpTaskIntent[] };
        const after = applyLfcpIntents(basis.lfcp as LfcpValues, p.intents);
        const pL = projectLfcp(after);
        for (const f of i.fields as Field[])
          upsert(db, i, f, {
            lfcp: pL[f],
            shadow: shadowOf(f, after),
            apple: basis.pA?.[f],
            native: basis.native,
          });
        return;
      }
      const r = result as AppleOpSuccess;
      const written = projectWritten(r.written, o.timeZone);
      const create = i.kind === "create";
      const fields = create ? FIELDS : (i.fields as Field[]);
      for (const f of fields)
        upsert(db, i, f, {
          lfcp: basis.pL[f],
          shadow: shadowOf(f, basis.shadow),
          // A written null (a cleared due) is a value; only a field not written falls back.
          apple: Object.hasOwn(written, f) ? written[f] : create ? NEW_REMINDER[f] : basis.pA?.[f],
          native: r.written,
        });
      if (create) {
        const p = i.payload as { linkUrl: string; set: { title?: string } };
        const at = new Date(now()).toISOString();
        db.prepare(
          `INSERT INTO links (binding_id, task_id, rem_url, rem_external_id, rem_id_cache, rem_title_snapshot,
             origin, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'lfcp', 'linked', ?, ?)
           ON CONFLICT (binding_id, task_id) DO UPDATE SET rem_url = excluded.rem_url,
             rem_external_id = excluded.rem_external_id, rem_id_cache = excluded.rem_id_cache,
             state = 'linked', updated_at = excluded.updated_at`,
        ).run(
          i.bindingId,
          i.taskId,
          p.linkUrl,
          r.ref.externalId ?? null,
          r.ref.id,
          p.set.title ?? null,
          at,
          at,
        );
      }
      // B14: what Apple had, overruled by LFCP — for the person, in the journal.
      for (const [field, value] of Object.entries(basis.appleOverruled ?? {}))
        new Journal(db, now).append("info", "field.apple_overruled", {
          bindingId: i.bindingId,
          taskId: i.taskId,
          params: { field, apple: JSON.stringify(value), intent: i.id },
        });
    },

    lfcpBasis(replica, i) {
      const v = lfcpValues(replica, i.taskId);
      if (v === undefined) return "the Task cannot be read";
      const pL = projectLfcp(v);
      const basis = i.basis as PlannedBasis;
      for (const f of i.fields as Field[])
        if (!sameProjection(f, pL[f], basis.pL[f])) return `${f} changed in LFCP since the plan`;
      // A complete without a date keeps the Task's completion_date (SDK): that hidden value is an
      // input of the operation and of finalize's base, though the open projection does not show it.
      const intents = (i.payload as { intents?: readonly LfcpTaskIntent[] }).intents ?? [];
      if (
        intents.some((x) => x.intent === "task.complete" && x.completionDate === undefined) &&
        v.completion_date !== (basis.lfcp?.completion_date ?? null)
      )
        return "completion_date changed in LFCP since the plan";
      return true;
    },
  };
}

/** The replica's projection and exact value of a Task's field now (delivery, §5.9). */
export function currentLfcp(replica: () => SectionReplica | undefined): CurrentLfcp {
  return (taskId, field) => {
    const r = replica();
    const v = r === undefined ? undefined : lfcpValues(r, taskId);
    if (v === undefined) return { proj: null, shadow: null };
    const f = field as Field;
    return { proj: projectLfcp(v)[f] ?? null, shadow: shadowOf(f, v) };
  };
}
