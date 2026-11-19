// Restore answers (A§7.1–7.2): the inverse button of a question — "Reopen the reminders",
// "Complete the reminders again", "Reopen the tasks for everyone", "Create new reminders from
// these tasks", "Keep only in Reminders" — is not an acceptance. It authorizes the exact inverse
// set of the anomaly it answers, derived from the hold's snapshot once, at the answer:
//
// | choice             | held anomaly (all its items)                      | each effect                                      |
// |--------------------|---------------------------------------------------|--------------------------------------------------|
// | prefer_lfcp_status | guard_mass_status, Apple completed (or reopened)  | apple_update completed{false} (or {true, date:   |
// |                    | the reminders, the Tasks did not follow           | LocalDate}), from = Apple's status, expectRev    |
// | reopen             | guard_mass_status, LFCP todo → done               | task.reopen, from = the Task's status            |
// | recreate           | guard_mass_unlink, all deleted_in_apple           | apple_create of a new projection (B11); the      |
// |                    |                                                   | unlinks it follows are what the guard counts     |
// | suppress           | guard_mass_import                                 | none: ignored_imports (externalId, else id)      |
//
// The authorization (and the decision, the planner's input) are written in one transaction with
// the answer. Its effects are counted again by their guard when planned; admission compares the
// current set of that guard with the authorization by the table of acceptances (A§7.1): empty →
// void{vanished}, with no exception (an inverse set is never empty); every item one of the
// effects with the same `from` (and `to`, `expectRev`) → consumed, with the preparation; anything
// else → void{changed}, held again whatever the threshold. A void authorization voids its decision.
// A consumed one leaves it pending: the decision ends Task by Task (decision_items), when a pass
// sees its write confirmed (the sides agreed; for recreate, linked again) or the Task no longer as
// answered. Until then the item turns the planner around and keeps the opposite transfer out.
// It covers only these effects: other holds, STOP, TCC, ownership, `expect.rev` still apply.

import { createHash } from "node:crypto";
import { isLocalDate } from "@openlfcp/bridge-reminders";
import type { RestoreItem, RestoreSeen } from "@openlfcp/bridge-reminders/adapter";
import { ulid } from "../executor/intents.js";
import {
  type AcceptanceOutcome,
  type AnomalyItem,
  type AnomalySnapshot,
  canonical,
  itemKey,
} from "./acceptances.js";
import type { BridgeDatabase } from "./database.js";
import type { HoldReason } from "./holds.js";
import type { Journal } from "./journal.js";

export type RestoreChoice = "prefer_lfcp_status" | "reopen" | "recreate" | "suppress";

/** One effect of an inverse set (A§7.1). */
export interface InverseEffect {
  readonly taskId: string;
  readonly effect: "apple_update" | "task_reopen" | "apple_create";
  readonly field: string;
  readonly from: unknown;
  readonly to: unknown;
  readonly expectRev?: string;
}

export interface Authorization {
  readonly id: string;
  readonly binding: string;
  readonly generation: number;
  /** The guard that counts its effects when they are planned. */
  readonly reason: HoldReason;
  readonly anomalyId: string;
  readonly effects: readonly InverseEffect[];
  readonly effectSetHash: string;
  readonly answerId: string | null;
  readonly state: "pending" | "consumed" | "void";
  readonly outcome: AcceptanceOutcome | null;
  readonly authorizedAt: string;
  readonly endedAt: string | null;
}

export interface Decision {
  readonly id: string;
  readonly binding: string;
  readonly anomalyId: string;
  readonly authorizationId: string | null;
  readonly kind: RestoreChoice;
  readonly taskIds: readonly string[];
  readonly state: "pending" | "done" | "void";
}

/** Why a choice has no inverse set for the anomaly (Restore is not offered for it, A§7.2). */
export type RestoreRefusal = { readonly refused: string };

const REASON_OF: Readonly<Record<RestoreChoice, HoldReason>> = {
  prefer_lfcp_status: "guard_mass_status",
  reopen: "guard_mass_status",
  recreate: "guard_mass_unlink",
  suppress: "guard_mass_import",
};

interface Status {
  readonly closed: boolean;
  readonly date?: string | null;
}
interface Basis {
  readonly rev?: string;
  readonly pL?: { readonly status?: Status };
  readonly pA?: { readonly status?: Status };
  readonly shadow?: { readonly status?: string };
  readonly reminder?: { readonly id: string; readonly externalId?: string };
}
const basisOf = (i: AnomalyItem, bases: Readonly<Record<string, unknown>>) =>
  (bases[itemKey(i)] ?? {}) as Basis;
const statusOf = (s: Status) => ({ closed: s.closed, date: s.date ?? null });
/** The Task's exact status (done and cancelled project alike) with its date: a task.reopen's from. */
const lfcpStatusOf = (b: Basis, pL: Status) => ({
  status: b.shadow?.status ?? null,
  ...statusOf(pL),
});

export const effectKey = (e: Pick<InverseEffect, "effect" | "taskId" | "field">): string =>
  [e.effect, e.taskId, e.field].join("\u0000");

/** The inverse set `choice` gives for the anomaly `snap`: its effects and the reminders to ignore. */
export function inverseOf(
  snap: AnomalySnapshot,
  choice: RestoreChoice,
):
  | {
      readonly reason: HoldReason;
      readonly effects: readonly InverseEffect[];
      readonly ignored: readonly string[];
    }
  | RestoreRefusal {
  const reason = REASON_OF[choice];
  if (snap.reason !== reason) return { refused: `${choice} does not answer ${snap.reason}` };
  if (snap.kind !== "set" || snap.items.length === 0)
    return { refused: "nothing to restore: the anomaly has no items" };
  const effects: InverseEffect[] = [];
  const ignored: string[] = [];
  // All completed, or all reopened: a mixed group has no Restore (A§7.2).
  const first = basisOf(snap.items[0] as AnomalyItem, snap.bases).pA?.status?.closed;
  for (const i of snap.items) {
    const b = basisOf(i, snap.bases);
    const task = i.taskId;
    if (task === undefined) return { refused: "an item without a Task" };
    const pL = b.pL?.status;
    const pA = b.pA?.status;
    switch (choice) {
      case "prefer_lfcp_status": {
        // Apple's status changed, LFCP's did not: write LFCP's back to the reminder.
        if (
          i.direction !== "to_lfcp" ||
          pL === undefined ||
          pA === undefined ||
          b.rev === undefined
        )
          return { refused: "not a status change made in Reminders" };
        if (pA.closed !== first || pA.closed === pL.closed)
          return { refused: "mixed status changes" };
        if (pL.closed && pL.date != null && !isLocalDate(pL.date))
          return { refused: `not a LocalDate: ${String(pL.date)}` };
        effects.push({
          taskId: task,
          effect: "apple_update",
          field: "completed",
          from: statusOf(pA),
          // A§7.2: the date to LocalDate precision; the time of completion is not restored.
          to: pL.closed
            ? { value: true, ...(pL.date == null ? {} : { date: pL.date }) }
            : { value: false },
          expectRev: b.rev,
        });
        break;
      }
      case "reopen":
        // A Task completed in LFCP, todo → done, proven by the status agreed before (the
        // snapshot's `before`): reopen it, the reminder stays open. Any other previous status,
        // or none known, has no Restore (A§7.2).
        if (
          i.direction !== "to_apple" ||
          pL?.closed !== true ||
          pA?.closed !== false ||
          b.shadow?.status !== "done"
        )
          return { refused: "not a Task completed in LFCP" };
        if ((i.before as { status?: unknown } | undefined)?.status !== "todo")
          return { refused: "not proven todo → done" };
        effects.push({
          taskId: task,
          effect: "task_reopen",
          field: "status",
          from: lfcpStatusOf(b, pL),
          to: { status: "todo" },
        });
        break;
      case "recreate":
        if (i.cause !== "deleted_in_apple") return { refused: "not all deleted in Reminders" };
        effects.push({
          taskId: task,
          effect: "apple_create",
          field: "link",
          from: { state: i.before, cause: i.cause, externalId: i.externalId ?? null },
          to: { state: "pending_apple_create" },
        });
        break;
      case "suppress": {
        const r = b.reminder;
        if (i.cause !== "import" || r === undefined) return { refused: "not a new reminder" };
        ignored.push(r.externalId === undefined ? `id:${r.id}` : `ext:${r.externalId}`);
        break;
      }
    }
  }
  return { reason, effects, ignored };
}

/** What a current item of `reason` would do, as an effect to find in an authorization. */
function effectOf(
  reason: HoldReason,
  i: AnomalyItem,
  bases: Readonly<Record<string, unknown>>,
): Omit<InverseEffect, "to"> & { readonly to?: unknown } {
  const b = basisOf(i, bases);
  const task = i.taskId ?? "";
  const none = {
    taskId: task,
    effect: "apple_update" as const,
    field: `other:${i.field}`,
    from: null,
  };
  if (reason === "guard_mass_unlink")
    return {
      taskId: task,
      effect: "apple_create",
      field: "link",
      from: { state: i.before, cause: i.cause, externalId: i.externalId ?? null },
    };
  if (reason !== "guard_mass_status") return none;
  const p = i.after as {
    readonly set?: { readonly completed?: unknown };
    readonly expect?: { readonly rev?: string };
    readonly intents?: readonly { readonly intent?: string }[];
  } | null;
  if (i.direction === "to_apple" && p?.set?.completed !== undefined && b.pA?.status !== undefined)
    return {
      taskId: task,
      effect: "apple_update",
      field: "completed",
      from: statusOf(b.pA.status),
      to: p.set.completed,
      ...(p.expect?.rev === undefined ? {} : { expectRev: p.expect.rev }),
    };
  if (
    i.direction === "to_lfcp" &&
    p?.intents?.length === 1 &&
    p.intents[0]?.intent === "task.reopen" &&
    b.pL?.status !== undefined
  )
    return {
      taskId: task,
      effect: "task_reopen",
      field: "status",
      from: lfcpStatusOf(b, b.pL.status),
      to: { status: "todo" },
    };
  return none;
}

/**
 * A pending authorization against the current set of its guard (A§7.1): `present` is whether the
 * guard fires in this plan. Empty is vanished with no exception: an inverse set is never empty.
 */
export function compareInverse(
  auth: Pick<Authorization, "reason" | "effects">,
  current: Pick<AnomalySnapshot, "kind" | "items" | "bases">,
  present: boolean,
): AcceptanceOutcome {
  if (current.kind === "set" && current.items.length === 0) return "vanished";
  // No data to compare: never let it through.
  if (current.kind === "opaque") return present ? "changed" : "vanished";
  const want = new Map(auth.effects.map((e) => [effectKey(e), e]));
  for (const i of current.items) {
    const got = effectOf(auth.reason, i, current.bases);
    const e = want.get(effectKey(got));
    if (e === undefined || canonical(e.from) !== canonical(got.from)) return "changed";
    if (got.to !== undefined && canonical(got.to) !== canonical(e.to)) return "changed";
    if (got.expectRev !== undefined && got.expectRev !== e.expectRev) return "changed";
  }
  return "consumed";
}

const iso = (now: number) => new Date(now).toISOString();

interface AuthRow {
  id: string;
  binding_id: string;
  generation: number;
  reason: HoldReason;
  anomaly_id: string;
  effects_json: string;
  effect_set_hash: string;
  answer_id: string | null;
  state: Authorization["state"];
  outcome: AcceptanceOutcome | null;
  authorized_at: string;
  ended_at: string | null;
}

const authFrom = (r: AuthRow): Authorization =>
  Object.freeze({
    id: r.id,
    binding: r.binding_id,
    generation: r.generation,
    reason: r.reason,
    anomalyId: r.anomaly_id,
    effects: JSON.parse(r.effects_json) as InverseEffect[],
    effectSetHash: r.effect_set_hash,
    answerId: r.answer_id,
    state: r.state,
    outcome: r.outcome,
    authorizedAt: r.authorized_at,
    endedAt: r.ended_at,
  });

interface DecisionRow {
  id: string;
  binding_id: string;
  anomaly_id: string;
  authorization_id: string | null;
  kind: RestoreChoice;
  task_ids_json: string;
  state: Decision["state"];
}

const decisionFrom = (r: DecisionRow): Decision =>
  Object.freeze({
    id: r.id,
    binding: r.binding_id,
    anomalyId: r.anomaly_id,
    authorizationId: r.authorization_id,
    kind: r.kind,
    taskIds: JSON.parse(r.task_ids_json) as string[],
    state: r.state,
  });

/** The authorizations, decisions and ignored imports of the bridge database. */
export class Authorizations {
  constructor(
    private readonly db: BridgeDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Records the answer `choice` to `snap` (the caller's transaction: the hold's lift and, in 0.6,
   * control_exec): its authorization (when it has effects), its decision and, for suppress, the
   * ignored reminders. A refusal writes nothing.
   */
  record(
    snap: AnomalySnapshot,
    choice: RestoreChoice,
    answerId?: string,
  ): { readonly authorization?: Authorization; readonly decision: Decision } | RestoreRefusal {
    const inv = inverseOf(snap, choice);
    if ("refused" in inv) return inv;
    const at = iso(this.now());
    let authorization: Authorization | undefined;
    if (inv.effects.length > 0) {
      const id = ulid(this.now());
      this.db
        .prepare(
          `INSERT INTO authorizations (id, binding_id, generation, reason, anomaly_id, kind, effects_json,
             effect_set_hash, answer_id, state, authorized_at)
           VALUES (?, ?, ?, ?, ?, 'inverse', ?, ?, ?, 'pending', ?)`,
        )
        .run(
          id,
          snap.binding,
          snap.generation,
          inv.reason,
          snap.anomalyId,
          JSON.stringify(inv.effects),
          hashOf(inv.effects),
          answerId ?? null,
          at,
        );
      authorization = this.get(id);
    }
    for (const key of inv.ignored)
      this.db
        .prepare(
          `INSERT INTO ignored_imports (binding_id, key, anomaly_id, ignored_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (binding_id, key) DO NOTHING`,
        )
        .run(snap.binding, key, snap.anomalyId, at);
    const id = ulid(this.now());
    // suppress is done once its reminders are ignored; the others once every Task of theirs is.
    const done = choice === "suppress";
    this.db
      .prepare(
        `INSERT INTO decisions (id, binding_id, generation, anomaly_id, authorization_id, kind,
           task_ids_json, answer_id, state, decided_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        snap.binding,
        snap.generation,
        snap.anomalyId,
        authorization?.id ?? null,
        choice,
        JSON.stringify(snap.items.map((i) => i.taskId ?? "")),
        answerId ?? null,
        done ? "done" : "pending",
        at,
        done ? at : null,
      );
    // Each Task is finished on its own (decision_items, A§7.2 "writes finished").
    if (!done)
      for (const t of new Set(snap.items.map((i) => i.taskId ?? "")))
        this.db
          .prepare(
            "INSERT INTO decision_items (decision_id, task_id, state) VALUES (?, ?, 'active')",
          )
          .run(id, t);
    const decision = this.decision(id) as Decision;
    return authorization === undefined ? { decision } : { authorization, decision };
  }

  get(id: string): Authorization | undefined {
    const r = this.db.prepare("SELECT * FROM authorizations WHERE id = ?").get(id) as
      | AuthRow
      | undefined;
    return r === undefined ? undefined : authFrom(r);
  }

  /** The pending authorizations of `binding`, oldest first. */
  pending(binding: string): readonly Authorization[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM authorizations WHERE binding_id = ? AND state = 'pending' ORDER BY id",
        )
        .all(binding) as AuthRow[]
    ).map(authFrom);
  }

  /**
   * Ends a pending authorization; a void one voids its decision. A consumed one leaves its
   * decision pending: the decision ends Task by Task, when its writes are confirmed (observe).
   * True when it was pending.
   */
  end(id: string, outcome: AcceptanceOutcome): boolean {
    const at = iso(this.now());
    const ended =
      this.db
        .prepare(
          "UPDATE authorizations SET state = ?, outcome = ?, ended_at = ? WHERE id = ? AND state = 'pending'",
        )
        .run(outcome === "consumed" ? "consumed" : "void", outcome, at, id).changes === 1;
    if (ended && outcome !== "consumed")
      this.db
        .prepare(
          "UPDATE decisions SET state = 'void', ended_at = ? WHERE authorization_id = ? AND state = 'pending'",
        )
        .run(at, id);
    return ended;
  }

  /** The active items of the pending decisions of `binding`, with their kind and authorization. */
  #active(binding: string) {
    return (
      this.db
        .prepare(
          `SELECT d.id AS decision, d.kind, d.authorization_id AS auth, i.task_id AS task
             FROM decisions d JOIN decision_items i ON i.decision_id = d.id
            WHERE d.binding_id = ? AND d.state = 'pending' AND i.state = 'active' ORDER BY d.id`,
        )
        .all(binding) as {
        decision: string;
        kind: RestoreChoice;
        auth: string | null;
        task: string;
      }[]
    ).map((r) => ({ ...r, authorization: r.auth === null ? undefined : this.get(r.auth) }));
  }

  /**
   * The planner's input (A§7.2): the active status items, by Task, with the state the person
   * answered — the reminder's rev the inverse write expects, the Task's exact status a reopen undoes.
   */
  restoring(binding: string): ReadonlyMap<string, RestoreItem> {
    const m = new Map<string, RestoreItem>();
    for (const a of this.#active(binding)) {
      const e = a.authorization?.effects.find((x) => x.taskId === a.task);
      if (e === undefined) continue;
      if (a.kind === "prefer_lfcp_status" && e.expectRev !== undefined)
        m.set(a.task, { kind: "prefer_lfcp_status", rev: e.expectRev });
      const status = (e.from as { status?: unknown } | null)?.status;
      if (a.kind === "reopen" && typeof status === "string")
        m.set(a.task, { kind: "reopen", status });
    }
    return m;
  }

  /** The active recreate items whose authorization still waits, with that authorization. */
  recreating(binding: string): ReadonlyMap<string, string> {
    const m = new Map<string, string>();
    for (const a of this.#active(binding))
      if (a.kind === "recreate" && a.authorization?.state === "pending")
        m.set(a.task, a.authorization.id);
    return m;
  }

  /**
   * After a pass applied (in its transaction): what it saw of the active items. A status item
   * the pass saw agreed is done (its inverse write confirmed, or nothing left to write), one no
   * longer as answered is changed; a recreate item is done once its Task is linked again (its new
   * reminder created). A decision with no active item left is done. An unfinished item — a write
   * prepared, in flight, superseded or in quarantine — stays active: it keeps turning the planner
   * around and the opposite transfer out until a pass sees how it ended.
   */
  observe(binding: string, seen: readonly RestoreSeen[], journal: Journal): void {
    const at = iso(this.now());
    const finish = (decision: string, task: string, state: "done" | "changed") =>
      this.db
        .prepare(
          "UPDATE decision_items SET state = ?, ended_at = ? WHERE decision_id = ? AND task_id = ? AND state = 'active'",
        )
        .run(state, at, decision, task).changes === 1;
    const by = new Map(seen.map((x) => [x.taskId, x.seen]));
    const linked = this.db.prepare(
      "SELECT 1 FROM links WHERE binding_id = ? AND task_id = ? AND state = 'linked'",
    );
    const touched = new Set<string>();
    for (const a of this.#active(binding)) {
      if (a.authorization?.state !== "consumed") continue;
      const s =
        a.kind === "recreate"
          ? linked.get(binding, a.task) === undefined
            ? undefined
            : "agreed"
          : by.get(a.task);
      if (s === "agreed" && finish(a.decision, a.task, "done")) touched.add(a.decision);
      if (s === "moved" && finish(a.decision, a.task, "changed")) {
        touched.add(a.decision);
        journal.append("warn", "decision.item_changed", {
          bindingId: binding,
          taskId: a.task,
          params: { decision: a.decision, kind: a.kind },
        });
      }
    }
    for (const d of touched)
      if (
        this.db
          .prepare(
            `UPDATE decisions SET state = 'done', ended_at = ? WHERE id = ? AND state = 'pending'
               AND NOT EXISTS (SELECT 1 FROM decision_items WHERE decision_id = ? AND state = 'active')`,
          )
          .run(at, d, d).changes === 1
      )
        journal.append("info", "decision.done", { bindingId: binding, params: { decision: d } });
  }

  /** The items of a decision and their state. */
  items(decision: string): Readonly<Record<string, string>> {
    return Object.fromEntries(
      (
        this.db
          .prepare(
            "SELECT task_id, state FROM decision_items WHERE decision_id = ? ORDER BY task_id",
          )
          .all(decision) as { task_id: string; state: string }[]
      ).map((r) => [r.task_id, r.state]),
    );
  }

  decision(id: string): Decision | undefined {
    const r = this.db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as
      | DecisionRow
      | undefined;
    return r === undefined ? undefined : decisionFrom(r);
  }

  /** The pending decisions of `binding` (the planner's input), oldest first. */
  decisions(binding: string): readonly Decision[] {
    return (
      this.db
        .prepare("SELECT * FROM decisions WHERE binding_id = ? AND state = 'pending' ORDER BY id")
        .all(binding) as DecisionRow[]
    ).map(decisionFrom);
  }

  /** Whether the reminder (`ext:<externalId>` or `id:<id>`) is kept out of the imports. */
  ignored(binding: string, key: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM ignored_imports WHERE binding_id = ? AND key = ?")
        .get(binding, key) !== undefined
    );
  }
}

/** The hash of an inverse set: its effects, canonical and sorted. */
function hashOf(effects: readonly InverseEffect[]): string {
  return createHash("sha256").update(effects.map(canonical).sort().join("\u0002")).digest("hex");
}
