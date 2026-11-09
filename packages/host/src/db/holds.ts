// The holds of a binding (D-010 §7): a set of reasons, each with the time it
// was first set and an optional detail. A binding with any hold runs no
// effect (§7.1, except the fixed set N8 freezing allows, §9). Setting a hold
// that is set keeps its `since`; a hold is lifted by `resume --accept
// <hold>` or by the condition that set it going away.

import type { BridgeDatabase } from "./database.js";

/** The hold reasons D-010 r3 names (§6.5, §7.2, §7.3–7.5); a PR that needs another adds it here. */
export const HOLD_REASONS = Object.freeze([
  "guard_mass_unlink",
  "guard_mass_import",
  "guard_mass_status",
  "guard_count_drop",
  "guard_backlog",
  "ownership_lost",
  "foreign_bridge",
  "import_ambiguous",
] as const);

export type HoldReason = (typeof HOLD_REASONS)[number];

export interface Hold {
  readonly reason: HoldReason;
  /** RFC 3339 UTC: when it was first set. */
  readonly since: string;
  readonly detail?: unknown;
}

const known = new Set<string>(HOLD_REASONS);

function check(reason: string): asserts reason is HoldReason {
  if (!known.has(reason)) throw new RangeError(`unknown hold reason ${reason}`);
}

const iso = (now: number) => new Date(now).toISOString();

/** The holds of the bridge database. */
export class Holds {
  constructor(
    private readonly db: BridgeDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Sets `reason` on `binding`; true when it was not set. A hold already set
   * keeps its `since`; its detail is replaced when one is given.
   */
  set(binding: string, reason: HoldReason, detail?: unknown): boolean {
    check(reason);
    const json = detail === undefined ? null : JSON.stringify(detail);
    return this.db
      .transaction(() => {
        if (this.has(binding, reason)) {
          if (json !== null)
            this.db
              .prepare(
                "UPDATE binding_holds SET detail_json = ? WHERE binding_id = ? AND reason = ?",
              )
              .run(json, binding, reason);
          return false;
        }
        this.db
          .prepare(
            "INSERT INTO binding_holds (binding_id, reason, since, detail_json) VALUES (?, ?, ?, ?)",
          )
          .run(binding, reason, iso(this.now()), json);
        return true;
      })
      .immediate();
  }

  /** Lifts `reason` from `binding`; true when it was set. */
  lift(binding: string, reason: HoldReason): boolean {
    check(reason);
    return (
      this.db
        .prepare("DELETE FROM binding_holds WHERE binding_id = ? AND reason = ?")
        .run(binding, reason).changes === 1
    );
  }

  /** The holds of `binding`, by reason. */
  of(binding: string): readonly Hold[] {
    const rows = this.db
      .prepare(
        "SELECT reason, since, detail_json FROM binding_holds WHERE binding_id = ? ORDER BY reason",
      )
      .all(binding) as { reason: HoldReason; since: string; detail_json: string | null }[];
    return rows.map((r) =>
      Object.freeze({
        reason: r.reason,
        since: r.since,
        ...(r.detail_json === null ? {} : { detail: JSON.parse(r.detail_json) as unknown }),
      }),
    );
  }

  has(binding: string, reason: HoldReason): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM binding_holds WHERE binding_id = ? AND reason = ?")
        .get(binding, reason) !== undefined
    );
  }

  /** Whether `binding` has a hold outside `allowed` (§7.1: none at all, by default). */
  blocked(binding: string, allowed: readonly HoldReason[] = []): boolean {
    return this.of(binding).some((h) => !allowed.includes(h.reason));
  }
}
