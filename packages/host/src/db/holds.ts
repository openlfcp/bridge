// The holds of a binding (D-010 §7): a set of reasons, each with the time it
// was first set and an optional detail. A binding with any hold runs no
// effect (§7.1 r4: no exceptions, the N8 `migration` hold included). Setting a hold
// that is set keeps its `since`; a hold is lifted by `resume --accept
// <hold>` or by the condition that set it going away. Accepting a guard's hold
// records a durable acceptance of its anomaly (acceptances.ts, A§7.1).

import { Acceptances, type AnomalySnapshot, snapshot } from "./acceptances.js";
import type { BridgeDatabase } from "./database.js";

/** The hold reasons D-010 r4 names (§6.5, §7.2, §7.3–7.5, §9); a PR that needs another adds it here. */
export const HOLD_REASONS = Object.freeze([
  "guard_mass_unlink",
  "guard_mass_import",
  "guard_mass_status",
  "guard_count_drop",
  "guard_backlog",
  "ownership_lost",
  "foreign_bridge",
  "import_ambiguous",
  // N8 (§9 r4): set in the freezing transaction on every binding of the old installation.
  "migration",
  // §5.9: the server refuses the section (a blocked batch, a refused open); revocationStatus follows.
  "access_refused",
  // §7.5, §8.2: the helper did not stay up (more than 3 restarts within 5 min, PR 9 supervision).
  "helper_unavailable",
  // §8.2, the hang analysis G1: the helper stalled twice on this binding's list within the restart
  // window; only this binding pauses (no pass reads its list), the others go on.
  "helper_stall",
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

/** The anomaly snapshot a guard keeps in its hold's detail (Limits), if any. */
export function anomalyOf(detail: unknown): AnomalySnapshot | undefined {
  const a = (detail as { anomaly?: AnomalySnapshot } | null | undefined)?.anomaly;
  return a !== undefined && typeof a.effectSetHash === "string" ? a : undefined;
}

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

  /**
   * `resume --accept <hold>`, the answer [Yes] (A§7.1, E18): lifts the hold and accepts the
   * anomaly it held — its snapshot (the hold's detail `anomaly`) becomes a pending acceptance,
   * checked by every admission of the binding's plans (Limits.admit). A guard's hold without a
   * snapshot (set by 0.5) is accepted as an `opaque` anomaly, which lets nothing through: the next
   * pass that fires it asks again. True when the hold was set.
   */
  accept(binding: string, reason: HoldReason, o: { readonly answerId?: string } = {}): boolean {
    check(reason);
    return this.db
      .transaction(() => {
        // Only a hold that is set can be accepted: no permission is kept for an anomaly to come
        // (review PR 9b #24).
        const held = this.of(binding).find((h) => h.reason === reason);
        if (held === undefined || !this.lift(binding, reason)) return false;
        // A guard's answer is a pending acceptance; its window moves only when it is consumed
        // (Limits.admit, with the preparation), never by the answer itself.
        if (reason.startsWith("guard_")) {
          const snap = anomalyOf(held.detail) ?? snapshot(binding, reason, "opaque");
          new Acceptances(this.db, this.now).record(snap, o.answerId);
        } else this.markAccepted(binding, reason, iso(this.now()));
        return true;
      })
      .immediate();
  }

  /** A pending acceptance of `reason` on `binding` waits (not consumed, not void). */
  hasAccepted(binding: string, reason: HoldReason): boolean {
    return new Acceptances(this.db, this.now).pending(binding, reason).length > 0;
  }

  /**
   * Since when an accepted anomaly of `reason` is the new baseline: the guards count only what
   * came after it (the unlinks of the window, the imports, the count drop's previous pass).
   */
  acceptedAt(binding: string, reason: HoldReason): string | undefined {
    const r = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(`hold_accepted_at:${binding}:${reason}`) as { value: string } | undefined;
    return r?.value;
  }

  /** Moves the baseline of an accepted `reason` to `at` (the accepted pass's own work included). */
  markAccepted(binding: string, reason: HoldReason, at: string): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = max(value, excluded.value)",
      )
      .run(`hold_accepted_at:${binding}:${reason}`, at);
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

  /** Whether `binding` has any hold: then no effect runs (§7.1 r4: no exceptions). */
  blocked(binding: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM binding_holds WHERE binding_id = ? LIMIT 1").get(binding) !==
      undefined
    );
  }
}
