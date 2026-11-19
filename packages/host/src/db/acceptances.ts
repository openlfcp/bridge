// Durable acceptances (A§7.1, E18): a person's answer accepts one anomaly,
// the immutable snapshot of what a guard held — not "the next pass of this
// reason". The snapshot is kept with the hold (binding_holds.detail_json
// `anomaly`); accepting copies it into `acceptances` as `pending`. Every
// admission of the binding's plan compares each pending acceptance with the
// set of its reason in the current plan:
//
// | current set of the reason                    | outcome          |
// |----------------------------------------------|------------------|
// | empty (the anomaly went away)                | void{vanished}   |
// | ⊆ the accepted one, same before/bases        | consumed         |
// | anything else                                | void{changed}    |
//
// guard_count_drop holds the links its side stopped counting, guard_backlog
// the open intents and the planned ones. An `opaque` snapshot (a hold of 0.5,
// a plan that gives only a number) has nothing to compare: it never lets a
// non-empty set through — void{changed}, held again, asked again.

import { createHash } from "node:crypto";
import { ulid } from "../executor/intents.js";
import type { BridgeDatabase } from "./database.js";
import type { HoldReason } from "./holds.js";

/** One held transition or effect (A§7.1). `before`/bases are what an acceptance is tied to. */
export interface AnomalyItem {
  readonly taskId?: string;
  readonly appleId?: string;
  readonly externalId?: string;
  readonly field: string;
  readonly direction: string;
  /** The subtype per item (deleted_in_apple, moved_out, task_gone, out_of_filter, import, status). */
  readonly cause: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly rev?: string;
}

export interface AnomalySnapshot {
  readonly anomalyId: string;
  readonly binding: string;
  readonly generation: number;
  readonly reason: HoldReason;
  readonly kind: "set" | "opaque";
  readonly items: readonly AnomalyItem[];
  /** The hash of the held set (items' identity, cause, before and bases). */
  readonly effectSetHash: string;
  /** The basis of each item, by its key. */
  readonly bases: Readonly<Record<string, unknown>>;
}

export type AcceptanceState = "pending" | "consumed" | "void";
export type AcceptanceOutcome = "consumed" | "vanished" | "changed";

export interface Acceptance {
  readonly id: string;
  readonly binding: string;
  readonly generation: number;
  readonly reason: HoldReason;
  readonly anomalyId: string;
  readonly kind: "set" | "opaque";
  readonly items: readonly AnomalyItem[];
  readonly effectSetHash: string;
  readonly bases: Readonly<Record<string, unknown>>;
  readonly answerId: string | null;
  readonly state: AcceptanceState;
  readonly outcome: AcceptanceOutcome | null;
  readonly acceptedAt: string;
  readonly endedAt: string | null;
}

/** The identity of an item in its set. */
export const itemKey = (i: AnomalyItem): string =>
  [i.direction, i.taskId ?? "", i.externalId ?? "", i.appleId ?? "", i.field].join("\u0000");

/** JSON with sorted object keys: equal values, equal text. */
function canonical(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

/** What an item is tied to: its cause, its before and its basis (not its after). */
const tie = (i: AnomalyItem, bases: Readonly<Record<string, unknown>>) =>
  canonical([i.cause, i.before, i.rev, bases[itemKey(i)]]);

export function effectSetHash(
  kind: "set" | "opaque",
  reason: string,
  items: readonly AnomalyItem[],
  bases: Readonly<Record<string, unknown>>,
): string {
  const lines = items.map((i) => `${itemKey(i)}\u0001${tie(i, bases)}`).sort();
  return createHash("sha256")
    .update(`${kind}\u0002${reason}\u0002${lines.join("\u0002")}`)
    .digest("hex");
}

/** A new snapshot of what `reason` holds now on `binding`. */
export function snapshot(
  binding: string,
  reason: HoldReason,
  kind: "set" | "opaque",
  items: readonly AnomalyItem[] = [],
  bases: Readonly<Record<string, unknown>> = {},
  generation = 0,
): AnomalySnapshot {
  return Object.freeze({
    anomalyId: ulid(),
    binding,
    generation,
    reason,
    kind,
    items: Object.freeze([...items]),
    effectSetHash: effectSetHash(kind, reason, items, bases),
    bases: Object.freeze({ ...bases }),
  });
}

/**
 * The outcome of a pending acceptance against the current set of its reason (A§7.1):
 * `present` is whether the reason's guard fires in this plan. An empty current set is
 * `vanished`, except for an empty accepted set while the guard still fires (`consumed`).
 */
export function compare(
  accepted: Pick<Acceptance, "kind" | "items" | "bases" | "effectSetHash">,
  current: Pick<AnomalySnapshot, "kind" | "items" | "bases" | "effectSetHash">,
  present: boolean,
): AcceptanceOutcome {
  // Nothing of the reason in this plan: the anomaly is gone, whatever the window says (the plan is
  // then admitted by the usual rules). Only an anomaly that was itself empty — a hold the window
  // alone set — is consumed by an empty plan, and only while the window still fires: the answer
  // accepted exactly that. Once the guard no longer fires it is vanished, the window unmoved.
  if (current.kind === "set" && current.items.length === 0)
    return present && accepted.kind === "set" && accepted.items.length === 0
      ? "consumed"
      : "vanished";
  // No data to compare: never let it through.
  if (accepted.kind === "opaque" || current.kind === "opaque")
    return current.kind === "opaque" && !present ? "vanished" : "changed";
  if (current.effectSetHash === accepted.effectSetHash) return "consumed";
  const was = new Map(accepted.items.map((i) => [itemKey(i), tie(i, accepted.bases)]));
  for (const i of current.items)
    if (was.get(itemKey(i)) !== tie(i, current.bases)) return "changed";
  return "consumed";
}

interface Row {
  id: string;
  binding_id: string;
  generation: number;
  reason: HoldReason;
  anomaly_id: string;
  kind: "set" | "opaque";
  items_json: string;
  effect_set_hash: string;
  bases_json: string;
  answer_id: string | null;
  state: AcceptanceState;
  outcome: AcceptanceOutcome | null;
  accepted_at: string;
  ended_at: string | null;
}

const fromRow = (r: Row): Acceptance =>
  Object.freeze({
    id: r.id,
    binding: r.binding_id,
    generation: r.generation,
    reason: r.reason,
    anomalyId: r.anomaly_id,
    kind: r.kind,
    items: JSON.parse(r.items_json) as AnomalyItem[],
    effectSetHash: r.effect_set_hash,
    bases: JSON.parse(r.bases_json) as Record<string, unknown>,
    answerId: r.answer_id,
    state: r.state,
    outcome: r.outcome,
    acceptedAt: r.accepted_at,
    endedAt: r.ended_at,
  });

const iso = (now: number) => new Date(now).toISOString();

/** The acceptances of the bridge database. */
export class Acceptances {
  constructor(
    private readonly db: BridgeDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records the answer [Yes] to `snap`: a pending acceptance (A§7.1). */
  record(snap: AnomalySnapshot, answerId?: string): Acceptance {
    const id = ulid(this.now());
    this.db
      .prepare(
        `INSERT INTO acceptances (id, binding_id, generation, reason, anomaly_id, kind, items_json,
           effect_set_hash, bases_json, answer_id, state, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        id,
        snap.binding,
        snap.generation,
        snap.reason,
        snap.anomalyId,
        snap.kind,
        JSON.stringify(snap.items),
        snap.effectSetHash,
        JSON.stringify(snap.bases),
        answerId ?? null,
        iso(this.now()),
      );
    return this.get(id) as Acceptance;
  }

  get(id: string): Acceptance | undefined {
    const r = this.db.prepare("SELECT * FROM acceptances WHERE id = ?").get(id) as Row | undefined;
    return r === undefined ? undefined : fromRow(r);
  }

  /** The pending acceptances of `binding`, oldest first. */
  pending(binding: string, reason?: HoldReason): readonly Acceptance[] {
    const rows = (
      reason === undefined
        ? this.db
            .prepare(
              "SELECT * FROM acceptances WHERE binding_id = ? AND state = 'pending' ORDER BY id",
            )
            .all(binding)
        : this.db
            .prepare(
              "SELECT * FROM acceptances WHERE binding_id = ? AND reason = ? AND state = 'pending' ORDER BY id",
            )
            .all(binding, reason)
    ) as Row[];
    return rows.map(fromRow);
  }

  /** Ends a pending acceptance; true when it was pending (a consumed one is never repeated). */
  end(id: string, outcome: AcceptanceOutcome): boolean {
    return (
      this.db
        .prepare(
          "UPDATE acceptances SET state = ?, outcome = ?, ended_at = ? WHERE id = ? AND state = 'pending'",
        )
        .run(outcome === "consumed" ? "consumed" : "void", outcome, iso(this.now()), id).changes ===
      1
    );
  }
}
