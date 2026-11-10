// Intents in bridge.sqlite (D-010 §5.6): one external write each,
// prepare → effect → result → finalize, every step durable before the next.
// Ids are ULIDs: the transport's opKey and the suffix of the LFCP
// operation id (`brg1:<id>`).

import { randomBytes } from "node:crypto";
import type { BridgeDatabase } from "../db/database.js";

export type Direction = "to_apple" | "to_lfcp";
export type IntentState =
  | "prepared"
  | "effecting"
  | "applied"
  | "finalized"
  | "superseded"
  | "refused"
  | "quarantined";

export interface Intent {
  readonly id: string;
  readonly bindingId: string;
  readonly taskId: string;
  readonly installationId: string;
  readonly direction: Direction;
  /** to_apple: create | update | restore_url; to_lfcp: create_task | update_task. */
  readonly kind: string;
  readonly fields: readonly string[];
  readonly basis: unknown;
  readonly payload: unknown;
  readonly operationId: string;
  readonly state: IntentState;
  readonly stateReason: string | null;
  readonly attempts: number;
  readonly nextAt: string | null;
  readonly lastError: unknown;
  readonly result: unknown;
  readonly createdAt: string;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 48 bits of milliseconds, 80 random bits, Crockford base32 (sortable by time). */
export function ulid(
  now: number = Date.now(),
  random: (n: number) => Uint8Array = randomBytes,
): string {
  let t = now;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const r = random(10);
  let bits = 0n;
  for (const b of r) bits = (bits << 8n) | BigInt(b);
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand = CROCKFORD[Number(bits & 31n)] + rand;
    bits >>= 5n;
  }
  return time + rand;
}

interface Row {
  id: string;
  binding_id: string;
  task_id: string;
  installation_id: string;
  direction: Direction;
  kind: string;
  fields_json: string;
  basis_json: string;
  payload_json: string;
  operation_id: string;
  state: IntentState;
  state_reason: string | null;
  attempts: number;
  next_at: string | null;
  last_error_json: string | null;
  result_json: string | null;
  created_at: string;
}

const parse = (s: string | null): unknown => (s === null ? undefined : JSON.parse(s));

const fromRow = (r: Row): Intent =>
  Object.freeze({
    id: r.id,
    bindingId: r.binding_id,
    taskId: r.task_id,
    installationId: r.installation_id,
    direction: r.direction,
    kind: r.kind,
    fields: JSON.parse(r.fields_json) as string[],
    basis: parse(r.basis_json),
    payload: parse(r.payload_json),
    operationId: r.operation_id,
    state: r.state,
    stateReason: r.state_reason,
    attempts: r.attempts,
    nextAt: r.next_at,
    lastError: parse(r.last_error_json),
    result: parse(r.result_json),
    createdAt: r.created_at,
  });

export interface NewIntent {
  readonly bindingId: string;
  readonly taskId: string;
  readonly installationId: string;
  readonly direction: Direction;
  readonly kind: string;
  readonly fields: readonly string[];
  readonly basis: unknown;
  /** The exact payload; for to_apple the AppleOp without opKey (it is the id). */
  readonly payload: unknown;
}

/** An open intent of the same (binding, Task, direction) exists (one at a time, §5.6). */
export class OpenIntentExistsError extends Error {
  constructor(readonly existing: string) {
    super(`an open intent exists for this Task and direction: ${existing}`);
    this.name = "OpenIntentExistsError";
  }
}

/**
 * No intent may be prepared for this binding now (N8 §9 r4, review PR 13 P1-1): its installation
 * is not active (frozen by a migration, retired, revoked) or it has the hold `migration`.
 */
export class PreparationBlockedError extends Error {
  constructor(readonly reason: "installation_not_active" | "migration" | "binding_moved") {
    super(
      reason === "migration"
        ? "the binding is held for an N8 migration: no new intents"
        : reason === "binding_moved"
          ? "the binding no longer belongs to this installation"
          : "the installation is not active: no new intents",
    );
    this.name = "PreparationBlockedError";
  }
}

export class Intents {
  constructor(
    private readonly db: BridgeDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  #iso(): string {
    return new Date(this.now()).toISOString();
  }

  get(id: string): Intent | undefined {
    const r = this.db.prepare("SELECT * FROM intents WHERE id = ?").get(id) as Row | undefined;
    return r === undefined ? undefined : fromRow(r);
  }

  /**
   * A person's decision on a refused or quarantined intent (kept, dropped, …), durable. Only
   * such an intent can be resolved; a second decision replaces the first.
   */
  resolve(id: string, resolution: string): void {
    const i = this.get(id);
    if (i === undefined) throw new Error(`no intent ${id}`);
    if (i.state !== "refused" && i.state !== "quarantined")
      throw new Error(`intent ${id} is ${i.state}: only a refused or quarantined one is resolved`);
    this.db
      .prepare(
        `INSERT INTO intent_resolutions (intent_id, resolution, resolved_at) VALUES (?, ?, ?)
         ON CONFLICT (intent_id) DO UPDATE SET resolution = excluded.resolution, resolved_at = excluded.resolved_at`,
      )
      .run(id, resolution, this.#iso());
  }

  /** The open intents (prepared, effecting, applied), oldest first: what a start recovers (§5.7). */
  open(): readonly Intent[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM intents WHERE state IN ('prepared','effecting','applied') ORDER BY id",
        )
        .all() as Row[]
    ).map(fromRow);
  }

  /** Quarantined intents whose outcome only the transport can still settle (P2-1). */
  unknownOutcomes(): readonly Intent[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM intents WHERE state = 'quarantined' AND state_reason = 'unknown_outcome' ORDER BY id",
        )
        .all() as Row[]
    ).map(fromRow);
  }

  #blocked(n: NewIntent): PreparationBlockedError["reason"] {
    const b = this.db
      .prepare(
        "SELECT b.installation_id, i.status FROM bindings b JOIN installations i ON i.id = b.installation_id WHERE b.id = ?",
      )
      .get(n.bindingId) as { installation_id: string; status: string } | undefined;
    if (b === undefined || b.installation_id !== n.installationId) return "binding_moved";
    const held = this.db
      .prepare("SELECT 1 FROM binding_holds WHERE binding_id = ? AND reason = 'migration'")
      .get(n.bindingId);
    return held !== undefined ? "migration" : "installation_not_active";
  }

  /**
   * prepare (§5.6): the durable intent, with its exact payload, before any effect. Refused
   * (PreparationBlockedError) while the binding's installation is not active or the binding has
   * the hold `migration`, checked in the same statement as the insert (N8, review PR 13 P1-1).
   */
  prepare(n: NewIntent): Intent {
    const id = ulid(this.now());
    try {
      // One statement, under the write lock: the checks and the insert cannot be split by a freeze
      // committed from another connection in between.
      const inserted = this.db
        .prepare(
          `INSERT INTO intents (id, binding_id, task_id, installation_id, direction, kind, fields_json,
             basis_json, payload_json, operation_id, state, attempts, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 0, ?
            WHERE EXISTS (SELECT 1 FROM bindings b JOIN installations i ON i.id = b.installation_id
                           WHERE b.id = ? AND b.installation_id = ? AND i.status = 'active')
              AND NOT EXISTS (SELECT 1 FROM binding_holds WHERE binding_id = ? AND reason = 'migration')`,
        )
        .run(
          id,
          n.bindingId,
          n.taskId,
          n.installationId,
          n.direction,
          n.kind,
          JSON.stringify(n.fields),
          JSON.stringify(n.basis ?? null),
          JSON.stringify(n.payload ?? null),
          `brg1:${id}`,
          this.#iso(),
          n.bindingId,
          n.installationId,
          n.bindingId,
        );
      if (inserted.changes === 0) throw new PreparationBlockedError(this.#blocked(n));
    } catch (e) {
      if (String(e).includes("UNIQUE")) {
        const open = this.db
          .prepare(
            "SELECT id FROM intents WHERE binding_id = ? AND task_id = ? AND direction = ? AND state IN ('prepared','effecting','applied')",
          )
          .get(n.bindingId, n.taskId, n.direction) as { id: string } | undefined;
        throw new OpenIntentExistsError(open?.id ?? "?");
      }
      throw e;
    }
    return this.get(id) as Intent;
  }

  /** effect, first half: durable `effecting` and the attempt counted, before the call. */
  effecting(id: string): void {
    this.#move(id, ["prepared"], "effecting", {
      attempts: "attempts + 1",
      effected_at: "?",
    });
  }

  /** effecting, unless the intent is no longer prepared (another runner took it): false then. */
  tryEffecting(id: string): boolean {
    const r = this.db
      .prepare(
        "UPDATE intents SET state = 'effecting', attempts = attempts + 1, effected_at = ? WHERE id = ? AND state = 'prepared'",
      )
      .run(this.#iso(), id);
    return r.changes === 1;
  }

  /** result: the effect's result is durable; finalize follows. */
  applied(id: string, result: unknown): void {
    this.db
      .prepare(
        "UPDATE intents SET state = 'applied', result_json = ?, state_reason = NULL WHERE id = ? AND state = 'effecting'",
      )
      .run(JSON.stringify(result), id);
  }

  /** Back to prepared (not applied: retry later, the same opKey). */
  retry(id: string, nextAt: number, error: unknown): void {
    this.db
      .prepare(
        "UPDATE intents SET state = 'prepared', next_at = ?, last_error_json = ? WHERE id = ? AND state IN ('prepared','effecting')",
      )
      .run(new Date(nextAt).toISOString(), JSON.stringify(error ?? null), id);
  }

  /** finalize: the state, after the handler wrote the bases (in the same transaction). */
  finalized(id: string): void {
    this.db
      .prepare(
        "UPDATE intents SET state = 'finalized', finalized_at = ? WHERE id = ? AND state = 'applied'",
      )
      .run(this.#iso(), id);
  }

  end(
    id: string,
    state: "superseded" | "refused" | "quarantined",
    reason: string,
    error?: unknown,
  ): void {
    this.db
      .prepare(
        "UPDATE intents SET state = ?, state_reason = ?, last_error_json = coalesce(?, last_error_json) WHERE id = ?",
      )
      .run(state, reason, error === undefined ? null : JSON.stringify(error), id);
  }

  #move(
    id: string,
    from: readonly IntentState[],
    to: IntentState,
    extra: Record<string, string>,
  ): void {
    const sets = [`state = '${to}'`];
    const args: unknown[] = [];
    for (const [col, expr] of Object.entries(extra)) {
      sets.push(`${col} = ${expr}`);
      if (expr === "?") args.push(this.#iso());
    }
    const r = this.db
      .prepare(
        `UPDATE intents SET ${sets.join(", ")} WHERE id = ? AND state IN (${from.map(() => "?").join(", ")})`,
      )
      .run(...args, id, ...from);
    if (r.changes !== 1) throw new Error(`intent ${id} is not ${from.join("/")}`);
  }
}
