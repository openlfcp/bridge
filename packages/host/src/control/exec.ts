// Durable execution of `C` on the host (A§3.3–3.4, B19). Every request and answer the host sees is
// written to `control_exec` before any effect, in the one transaction that plans its effects (the
// intents, the acceptance of an answer): a crash after it never plans them again, and an id seen
// again — after a crash, after the maps are cleaned up — is a duplicate. Rows are never deleted.
//
// Cancellation (A§3.3), by when the host sees `cancels/<rid>`:
//
// | when                                      | outcome                                            |
// |-------------------------------------------|----------------------------------------------------|
// | with the request or before it (admit)     | cancelled, nothing planned                         |
// | after received, before the first effect   | cancelled; its prepared intents become superseded  |
// | an effect started                         | carried through; applied{lateCancel}               |
// | the event is final                        | ignored                                            |
// | after a crash (recover)                   | the same rules by control_exec.state and cancels  |
//
// The executor asks `beforeEffect` before each effect of `effect_ids`.

import { SERVICE_CONTROL_V1_OPS } from "@openlfcp/shared-objects/service-control";
import type { BridgeDatabase } from "../db/database.js";
import { canAdvance, checkCode, type EventState, isFinal } from "./events.js";

/** `accepted` is the event's `received` (A§3.4 names the row's state so). */
export type ExecState = Exclude<EventState, "received"> | "accepted";

export interface ExecRow {
  readonly id: string;
  readonly kind: "request" | "answer";
  readonly op: string | null;
  readonly questionId: string | null;
  readonly binding: string | null;
  readonly generation: number | null;
  readonly choice: string | null;
  readonly author: string;
  readonly effectIds: readonly string[];
  readonly state: ExecState;
  readonly code: string | null;
  readonly lateCancel: boolean;
  readonly cancelSeenAt: string | null;
  readonly effectStartedAt: string | null;
  readonly receivedAt: string;
  readonly endedAt: string | null;
}

/** A request or an answer as read from `C`, its author already classed (A§3.1). */
export type Incoming =
  | {
      readonly kind: "request";
      readonly id: string;
      readonly op: string;
      readonly binding?: string;
      readonly generation?: number;
      readonly author: string;
    }
  | {
      readonly kind: "answer";
      readonly id: string;
      readonly questionId: string;
      readonly binding: string;
      readonly generation: number;
      readonly choice: string;
      readonly author: string;
    };

export interface AdmitOptions {
  /** `cancels/<rid>` is there already (with the request or before it). */
  readonly cancelled?: boolean;
  /** Checks of the caller (snapshotHash, anomalyId, capacity…), in the transaction: a refusal. */
  readonly check?: () => { state: "rejected" | "stale" | "failed"; code: string } | undefined;
  /** Plans the effects in the transaction (intents, an acceptance); returns their ids. */
  readonly plan?: () => readonly string[];
  readonly now?: string;
}

export type Admitted = { readonly fresh: boolean; readonly row: ExecRow };

/** `events.detail` of an applied request cancelled after its first effect (A§3.3). */
export const LATE_CANCEL_DETAIL = "lateCancel";

/** The event `C` shows for a row (A§3.2 `events`; `code` and `detail` are strings there). */
export function eventOf(row: ExecRow): { state: EventState; code?: string; detail?: string } {
  const state: EventState = row.state === "accepted" ? "received" : row.state;
  return {
    state,
    ...(row.code !== null ? { code: row.code } : {}),
    ...(row.state === "applied" && row.lateCancel ? { detail: LATE_CANCEL_DETAIL } : {}),
  };
}

const OPS: ReadonlySet<string> = new Set(SERVICE_CONTROL_V1_OPS);
const iso = () => new Date().toISOString();

interface Raw {
  id: string;
  kind: "request" | "answer";
  op: string | null;
  question_id: string | null;
  binding_id: string | null;
  generation: number | null;
  choice: string | null;
  author: string;
  effect_ids_json: string;
  state: ExecState;
  code: string | null;
  late_cancel: number;
  cancel_seen_at: string | null;
  effect_started_at: string | null;
  received_at: string;
  ended_at: string | null;
}

const row = (r: Raw): ExecRow =>
  Object.freeze({
    id: r.id,
    kind: r.kind,
    op: r.op,
    questionId: r.question_id,
    binding: r.binding_id,
    generation: r.generation,
    choice: r.choice,
    author: r.author,
    effectIds: Object.freeze(JSON.parse(r.effect_ids_json) as string[]),
    state: r.state,
    code: r.code,
    lateCancel: r.late_cancel === 1,
    cancelSeenAt: r.cancel_seen_at,
    effectStartedAt: r.effect_started_at,
    receivedAt: r.received_at,
    endedAt: r.ended_at,
  });

const finalState = (s: ExecState) => s !== "accepted" && isFinal(s);

export class ControlExec {
  constructor(private readonly db: BridgeDatabase) {}

  get(id: string): ExecRow | undefined {
    const r = this.db.prepare("SELECT * FROM control_exec WHERE id = ?").get(id) as Raw | undefined;
    return r === undefined ? undefined : row(r);
  }

  /** The rows not final yet, oldest first (recovery, the next pass). */
  open(): ExecRow[] {
    return (
      this.db
        .prepare("SELECT * FROM control_exec WHERE ended_at IS NULL ORDER BY received_at, id")
        .all() as Raw[]
    ).map(row);
  }

  /**
   * Steps 1–2 of A§3.4 in one transaction: a seen id is a duplicate (nothing runs); otherwise the
   * row is written with its outcome — cancelled, rejected{unsupported_op}, stale, the caller's
   * refusal, rejected{already_answered} — or `accepted` with the effects `plan` wrote.
   */
  admit(i: Incoming, o: AdmitOptions = {}): Admitted {
    const now = o.now ?? iso();
    return this.db.transaction((): Admitted => {
      const seen = this.get(i.id);
      if (seen !== undefined) return { fresh: false, row: seen };
      const refusal = o.cancelled
        ? { state: "cancelled" as const, code: null }
        : this.refusal(i, o);
      const effectIds = refusal === undefined ? [...(o.plan?.() ?? [])] : [];
      this.db
        .prepare(
          `INSERT INTO control_exec (id, kind, op, question_id, binding_id, generation, choice, author,
             effect_ids_json, state, code, cancel_seen_at, received_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          i.id,
          i.kind,
          i.kind === "request" ? i.op : null,
          i.kind === "answer" ? i.questionId : null,
          i.binding ?? null,
          i.generation ?? null,
          i.kind === "answer" ? i.choice : null,
          i.author,
          JSON.stringify(effectIds),
          refusal?.state ?? "accepted",
          refusal?.code ?? null,
          o.cancelled ? now : null,
          now,
          refusal === undefined ? null : now,
        );
      return { fresh: true, row: this.get(i.id) as ExecRow };
    })();
  }

  private refusal(i: Incoming, o: AdmitOptions) {
    if (i.kind === "request" && !OPS.has(i.op))
      return { state: "rejected" as const, code: "unsupported_op" };
    if (i.binding !== undefined) {
      const b = this.db
        .prepare("SELECT generation, state FROM bindings WHERE id = ?")
        .get(i.binding) as { generation: number; state: string } | undefined;
      // A request for another generation, or for a binding no longer there, is stale (A§3.4).
      // pair-section names the section it creates (A§4.3): no local row yet is no staleness.
      if (
        b === undefined
          ? !(i.kind === "request" && i.op === "pair-section")
          : b.state === "removed" || (i.generation ?? b.generation) !== b.generation
      )
        return { state: "stale" as const, code: "stale_generation" };
    }
    const refused = o.check?.();
    if (refused !== undefined) return refused;
    // The first answer the host accepts wins (A§3.4 step 4).
    if (
      i.kind === "answer" &&
      this.db
        .prepare(
          `SELECT 1 FROM control_exec WHERE kind = 'answer' AND question_id = ?
             AND state NOT IN ('rejected','stale','cancelled')`,
        )
        .get(i.questionId) !== undefined
    )
      return { state: "rejected" as const, code: "already_answered" };
    return undefined;
  }

  /**
   * `cancels/<rid>` seen for a row (A§3.3): before its first effect it is cancelled and its
   * prepared intents superseded; after, it is carried through (lateCancel); a final row ignores
   * it. `unknown` — no row yet: `admit` is told `cancelled` when the request comes.
   */
  cancel(id: string, now = iso()): "cancelled" | "late" | "ignored" | "unknown" {
    return this.db.transaction(() => {
      const r = this.get(id);
      if (r === undefined) return "unknown";
      if (finalState(r.state)) return "ignored";
      if (r.effectStartedAt !== null) {
        this.db
          .prepare(
            "UPDATE control_exec SET late_cancel = 1, cancel_seen_at = coalesce(cancel_seen_at, ?) WHERE id = ?",
          )
          .run(now, id);
        return "late";
      }
      const supersede = this.db.prepare(
        `UPDATE intents SET state = 'superseded', state_reason = 'cancelled'
           WHERE id = ? AND state = 'prepared'`,
      );
      for (const e of r.effectIds) supersede.run(e);
      this.db
        .prepare(
          `UPDATE control_exec SET state = 'cancelled', cancel_seen_at = coalesce(cancel_seen_at, ?),
             ended_at = ? WHERE id = ?`,
        )
        .run(now, now, id);
      return "cancelled";
    })();
  }

  /**
   * Before each effect of a row (A§3.3, the executor): `go` marks the first effect started
   * (`executing`); `stop` — the row is final or was cancelled before it.
   */
  beforeEffect(id: string, cancelled: boolean, now = iso()): "go" | "stop" {
    return this.db.transaction(() => {
      const r = this.get(id);
      if (r === undefined) throw new Error(`no control_exec ${id}`);
      if (cancelled && this.cancel(id, now) === "cancelled") return "stop";
      const after = this.get(id) as ExecRow;
      if (finalState(after.state)) return "stop";
      if (after.effectStartedAt === null)
        this.db
          .prepare(
            `UPDATE control_exec SET effect_started_at = ?,
               state = CASE state WHEN 'accepted' THEN 'executing' ELSE state END WHERE id = ?`,
          )
          .run(now, id);
      return "go";
    })();
  }

  /** Moves a row forward (A§3.3); a final state ends it. Throws on a step back or a bad code. */
  advance(id: string, to: Exclude<ExecState, "accepted">, code?: string, now = iso()): ExecRow {
    return this.db.transaction(() => {
      const r = this.get(id);
      if (r === undefined) throw new Error(`no control_exec ${id}`);
      const from: EventState = r.state === "accepted" ? "received" : r.state;
      if (!canAdvance(from, to, r.op)) throw new Error(`control_exec ${id}: ${from} → ${to}`);
      checkCode(to, code);
      this.db
        .prepare("UPDATE control_exec SET state = ?, code = ?, ended_at = ? WHERE id = ?")
        .run(to, code ?? null, isFinal(to) ? now : null, id);
      return this.get(id) as ExecRow;
    })();
  }

  /**
   * After a crash (A§3.3 last row): the open rows by the same rules — one cancelled (`cancels`
   * holds its id) before its first effect is cancelled; the rest are returned to be carried on
   * (their intents recover by the executor's rules, never planned again).
   */
  recover(cancelled: ReadonlySet<string>, now = iso()): ExecRow[] {
    for (const r of this.open())
      if (cancelled.has(r.id) || r.cancelSeenAt !== null) this.cancel(r.id, now);
    return this.open();
  }
}
