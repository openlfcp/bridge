// The holds of a binding (D-010 §7): a set of reasons, each with the time it
// was first set and an optional detail. A binding with any hold runs no
// effect (§7.1 r4: no exceptions, the N8 `migration` hold included). Setting a hold
// that is set keeps its `since`; a hold is lifted by `resume --accept
// <hold>` or by the condition that set it going away.

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
  /**
   * `resume --accept <hold>` (§7.5): lifts the hold and accepts the anomaly that set it — the next
   * pass that would set it again goes through once instead (Limits.admit, the count drop). True
   * when the hold was set.
   */
  accept(binding: string, reason: HoldReason): boolean {
    check(reason);
    // Only a hold that is set can be accepted: no permission is kept for an anomaly to come
    // (review PR 9b #24).
    const lifted = this.lift(binding, reason);
    if (!lifted) return false;
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(`hold_accepted:${binding}:${reason}`, iso(this.now()));
    this.markAccepted(binding, reason, iso(this.now()));
    return true;
  }

  /** An acceptance of `reason` on `binding` waits (not used up). */
  hasAccepted(binding: string, reason: HoldReason): boolean {
    return (
      this.db
        .prepare("SELECT 1 AS x FROM meta WHERE key = ?")
        .get(`hold_accepted:${binding}:${reason}`) !== undefined
    );
  }

  /** Drops every waiting acceptance of `binding`: a pass that needed none of them ends them. */
  clearAccepted(binding: string): void {
    this.db.prepare("DELETE FROM meta WHERE key LIKE ?").run(`hold_accepted:${binding}:%`);
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

  /** An acceptance of `reason` on `binding` waits: it is used up by this call (true). */
  takeAccepted(binding: string, reason: HoldReason): boolean {
    return (
      this.db.prepare("DELETE FROM meta WHERE key = ?").run(`hold_accepted:${binding}:${reason}`)
        .changes === 1
    );
  }

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
