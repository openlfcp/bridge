// Limits (A§8, E16; D-010 §7.2): a binding that is about to do far more
// than a person would stops with a hold before anything of its pass is
// prepared. A sliding window of 1 h counts what was prepared in it (prepared
// and executed alike) and the link transitions journaled in it, plus what the
// pass plans.
//
// | guard                                   | threshold                                             | hold              |
// |-----------------------------------------|-------------------------------------------------------|-------------------|
// | unlinks + out_of_filter + task_gone     | > max(3, 10 % of the links); in strict (24 h after    | guard_mass_unlink |
// |                                         | approve, bindings.strict_until) > 1                   |                   |
// | new Tasks from Apple                    | > 10 an hour, in strict too (E16; was > 3)            | guard_mass_import |
// | status changes                          | > 50 % of the links in one pass, with ≥ 6 links       | guard_mass_status |
// | count drop                              | `linked` on either side fell > 50 %, from ≥ 5         | guard_count_drop  |
// | backlog                                 | > 200 open intents                                    | guard_backlog     |
// | new reminders (to_apple create)         | not limited (as 0.5)                                  | —                 |
//
// A hold keeps the snapshot of the anomaly it held (A§7.1); a person's
// answer makes it a pending acceptance, checked at every admission — before
// the early "no guard, ok" — against the current set of its reason
// (acceptances.ts): vanished, consumed (in the transaction that prepares the
// pass: the caller's) or changed (held again whatever the threshold).
//
// For a person: "Usually this means the filter got narrower or the list
// became unavailable, not that you deleted N tasks." Lifted by
// `resume --accept <hold>`. The bridge deletes no Task and no reminder in MVP.

import {
  type Acceptance,
  Acceptances,
  type AnomalyItem,
  type AnomalySnapshot,
  compare,
  itemKey,
  snapshot,
} from "../db/acceptances.js";
import type { BridgeDatabase } from "../db/database.js";
import { type HoldReason, Holds } from "../db/holds.js";
import { Journal } from "../db/journal.js";
import type { NewIntent } from "./intents.js";

export interface LimitConfig {
  readonly windowMs: number;
  /** Unlinks: at most max(unlinksMin, unlinksShare × links); in strict at most unlinksStrict. */
  readonly unlinksMin: number;
  readonly unlinksShare: number;
  readonly unlinksStrict: number;
  /** New Tasks from Apple in the window; in strict (E16: the same as outside it). */
  readonly imports: number;
  readonly importsStrict: number;
  /** Status changes of one pass: at most statusShare × links, checked from statusMinLinks links. */
  readonly statusShare: number;
  readonly statusMinLinks: number;
  /** linked count falling by more than this share… */
  readonly countDropShare: number;
  /** …from at least this many. */
  readonly countDropMin: number;
  /** Open intents at once. */
  readonly backlog: number;
}

/** A§8 (E16). */
export const LIMITS: LimitConfig = Object.freeze({
  windowMs: 60 * 60_000,
  unlinksMin: 3,
  unlinksShare: 0.1,
  unlinksStrict: 1,
  imports: 10,
  importsStrict: 10,
  statusShare: 0.5,
  statusMinLinks: 6,
  countDropShare: 0.5,
  countDropMin: 5,
  backlog: 200,
});

/** The link transitions that count as unlinks (journal keys, PR 12 writes them). */
export const UNLINK_KEYS = Object.freeze(["link.unlinked", "link.out_of_filter", "link.task_gone"]);

/** A planned transition out of `linked`, the item of a guard_mass_unlink anomaly. */
export interface PlannedUnlink {
  readonly taskId: string;
  readonly cause: "deleted_in_apple" | "moved_out" | "task_gone" | "out_of_filter";
  readonly externalId?: string;
}

/** What a pass plans for one binding, before anything is prepared. */
export interface PlannedWork {
  readonly intents: readonly NewIntent[];
  /**
   * Planned transitions to unlinked, out_of_filter or task_gone: each one (the items of the
   * anomaly), or only their number (a dry run; held as an `opaque` anomaly).
   */
  readonly unlinks: number | readonly PlannedUnlink[];
  /** New Tasks from Apple the pass would make, beyond its intents (a dry-run's count, §6.2). */
  readonly imports?: number;
  /**
   * The links `linked` now that this pass no longer counts on each side (Task gone, out of the
   * filter, unreadable; the reminder missing): what a guard_count_drop holds. Without it the
   * count drop is `opaque`.
   */
  readonly uncounted?: { readonly apple: readonly string[]; readonly lfcp: readonly string[] };
}

export type Admission =
  /**
   * accepted: the reasons whose pending acceptance this pass consumes (their pass's work is the new
   * baseline: its unlinks are journaled as accepted, its imports move the window).
   */
  | { readonly ok: true; readonly accepted?: readonly HoldReason[] }
  | {
      readonly ok: false;
      readonly holds: readonly HoldReason[];
      readonly counts: Readonly<Record<string, number>>;
    };

const STATUS_FIELDS = new Set(["status", "completed", "completion_date"]);
const isStatus = (fields: readonly string[]) => fields.some((f) => STATUS_FIELDS.has(f));
const isImport = (i: { readonly direction: string; readonly kind: string }) =>
  i.direction === "to_lfcp" && i.kind === "create_task";

export class Limits {
  constructor(
    private readonly db: BridgeDatabase,
    private readonly config: LimitConfig = LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether the binding is in its strict window (24 h after approve, `strict_until`). */
  strict(bindingId: string): boolean {
    const r = this.db.prepare("SELECT strict_until FROM bindings WHERE id = ?").get(bindingId) as
      | { strict_until: string | null }
      | undefined;
    return r?.strict_until != null && Date.parse(r.strict_until) > this.now();
  }

  /**
   * Whether `planned` may be prepared for `bindingId`; when not, the holds
   * are set (and journaled) and nothing of the pass is to be prepared.
   */
  admit(
    bindingId: string,
    planned: PlannedWork,
    /** Guards found outside the limits for this pass (the dry run's guard_count_drop). */
    extra: readonly HoldReason[] = [],
  ): Admission {
    const m = this.#measure(bindingId, planned);
    const fired = [...new Set([...m.holds, ...extra])];
    const acceptances = new Acceptances(this.db, this.now);
    const pending = acceptances.pending(bindingId);
    // Without an answer waiting, as 0.5: no guard, ok.
    if (fired.length === 0 && pending.length === 0) return { ok: true };

    // Every pending acceptance against the current set of its reason (A§7.1), even below the
    // threshold: vanished and changed end here; consumed ones end only if the pass is admitted.
    const current = new Map<HoldReason, AnomalySnapshot>();
    const now = (reason: HoldReason) => {
      const known = current.get(reason);
      if (known !== undefined) return known;
      const snap = this.#snapshot(bindingId, reason, planned);
      current.set(reason, snap);
      return snap;
    };
    const consumed: Acceptance[] = [];
    const changed = new Set<HoldReason>();
    const journal = new Journal(this.db, this.now);
    for (const p of pending) {
      const outcome = compare(p, now(p.reason), fired.includes(p.reason));
      if (outcome === "consumed") {
        consumed.push(p);
        continue;
      }
      acceptances.end(p.id, outcome);
      journal.append(outcome === "changed" ? "warn" : "info", `acceptance.${outcome}`, {
        bindingId,
        params: { reason: p.reason, anomalyId: p.anomalyId },
      });
      if (outcome === "changed") changed.add(p.reason);
    }
    // The pass goes through only when every guard it fires is covered by a consumed acceptance; a
    // changed anomaly is held again whatever the threshold (conservative).
    const covered = new Set(consumed.map((c) => c.reason));
    const holds = [...new Set([...fired.filter((r) => !covered.has(r)), ...changed])];
    if (holds.length > 0) {
      this.#hold(bindingId, holds, m.counts, now);
      return { ok: false, holds, counts: m.counts };
    }
    // Consumed: in the caller's transaction, with the preparation of the pass (a crash before its
    // commit leaves the acceptance pending; a consumed one is never repeated).
    const at = new Date(this.now()).toISOString();
    const h = new Holds(this.db, this.now);
    for (const c of consumed) {
      acceptances.end(c.id, "consumed");
      h.markAccepted(bindingId, c.reason, at);
      journal.append("info", "acceptance.consumed", {
        bindingId,
        params: { reason: c.reason, anomalyId: c.anomalyId },
      });
    }
    return covered.size === 0 ? { ok: true } : { ok: true, accepted: [...covered] };
  }

  /** What admit would answer, setting nothing: a dry-run shows the guards that would stop it. */
  check(bindingId: string, planned: PlannedWork): Admission {
    const m = this.#measure(bindingId, planned);
    return m.holds.length === 0 ? { ok: true } : { ok: false, holds: m.holds, counts: m.counts };
  }

  /** The measures of A§8 and the guards they fire. */
  #measure(
    bindingId: string,
    planned: PlannedWork,
  ): { readonly holds: HoldReason[]; readonly counts: Readonly<Record<string, number>> } {
    const c = this.config;
    const since = new Date(this.now() - c.windowMs).toISOString();
    const strict = this.strict(bindingId);
    const one = (sql: string, ...args: unknown[]) =>
      (this.db.prepare(sql).get(...args) as { n: number }).n;
    const links = one(
      "SELECT count(*) AS n FROM links WHERE binding_id = ? AND state = 'linked'",
      bindingId,
    );
    // After an accepted anomaly the window starts at its baseline (resume --accept, §7.5).
    const h = new Holds(this.db, this.now);
    const after = (reason: HoldReason) => {
      const a = h.acceptedAt(bindingId, reason);
      return a !== undefined && a > since ? a : since;
    };
    const imported = one(
      "SELECT count(*) AS n FROM intents WHERE binding_id = ? AND direction = 'to_lfcp' AND kind = 'create_task' AND created_at > ?",
      bindingId,
      after("guard_mass_import"),
    );
    const open = one(
      "SELECT count(*) AS n FROM intents WHERE binding_id = ? AND state IN ('prepared','effecting','applied')",
      bindingId,
    );
    const unlinked = one(
      `SELECT count(*) AS n FROM journal WHERE binding_id = ? AND ts > ?
         AND key IN (${UNLINK_KEYS.map(() => "?").join(", ")})
         AND coalesce(json_extract(params_json, '$.accepted'), 0) = 0`,
      bindingId,
      after("guard_mass_unlink"),
      ...UNLINK_KEYS,
    );
    const counts = {
      links,
      unlinks:
        unlinked + (typeof planned.unlinks === "number" ? planned.unlinks : planned.unlinks.length),
      imports: imported + planned.intents.filter(isImport).length + (planned.imports ?? 0),
      statusChanges: planned.intents.filter((i) => isStatus(i.fields)).length,
      backlog: open + planned.intents.length,
      strict: strict ? 1 : 0,
    };
    const holds: HoldReason[] = [];
    const unlinkLimit = strict ? c.unlinksStrict : Math.max(c.unlinksMin, c.unlinksShare * links);
    if (counts.unlinks > unlinkLimit) holds.push("guard_mass_unlink");
    if (counts.imports > (strict ? c.importsStrict : c.imports)) holds.push("guard_mass_import");
    if (links >= c.statusMinLinks && counts.statusChanges > c.statusShare * links)
      holds.push("guard_mass_status");
    if (counts.backlog > c.backlog) holds.push("guard_backlog");
    return { holds, counts };
  }

  /** What `reason` holds in `planned` now: its items (A§7.1), or `opaque` when the plan gives none. */
  #snapshot(bindingId: string, reason: HoldReason, planned: PlannedWork): AnomalySnapshot {
    const items: AnomalyItem[] = [];
    const bases: Record<string, unknown> = {};
    const intent = (i: NewIntent, field: string, cause: string) => {
      const item: AnomalyItem = {
        taskId: i.taskId,
        field,
        direction: i.direction,
        cause,
        after: i.payload,
      };
      items.push(item);
      bases[itemKey(item)] = i.basis;
    };
    switch (reason) {
      case "guard_mass_unlink":
        // Only a number: nothing to compare, unless it is none.
        if (typeof planned.unlinks === "number") {
          if (planned.unlinks > 0) return snapshot(bindingId, reason, "opaque");
          break;
        }
        for (const u of planned.unlinks)
          items.push({
            taskId: u.taskId,
            ...(u.externalId === undefined ? {} : { externalId: u.externalId }),
            field: "link",
            // Where it happened: the reminder (Apple) or the Task (LFCP).
            direction: u.cause === "deleted_in_apple" || u.cause === "moved_out" ? "apple" : "lfcp",
            cause: u.cause,
            before: "linked",
          });
        break;
      case "guard_mass_import":
        for (const i of planned.intents) if (isImport(i)) intent(i, "task", "import");
        break;
      case "guard_mass_status":
        for (const i of planned.intents)
          if (isStatus(i.fields))
            intent(i, i.fields.filter((f) => STATUS_FIELDS.has(f)).join(","), "status");
        break;
      case "guard_backlog": {
        // What waits: the open intents (one per Task and direction) and this plan's.
        const open = this.db
          .prepare(
            "SELECT id, task_id, direction, basis_json FROM intents WHERE binding_id = ? AND state IN ('prepared','effecting','applied') ORDER BY id",
          )
          .all(bindingId) as {
          id: string;
          task_id: string;
          direction: string;
          basis_json: string;
        }[];
        for (const o of open) {
          const item: AnomalyItem = {
            taskId: o.task_id,
            field: "open",
            direction: o.direction,
            cause: "backlog",
            rev: o.id,
          };
          items.push(item);
          bases[itemKey(item)] = JSON.parse(o.basis_json) as unknown;
        }
        for (const i of planned.intents) intent(i, `plan:${i.kind}`, "backlog");
        break;
      }
      case "guard_count_drop": {
        // The links each side stopped counting (A§8: `linked` of the side, previous → this pass).
        if (planned.uncounted === undefined) return snapshot(bindingId, reason, "opaque");
        for (const side of ["apple", "lfcp"] as const)
          for (const taskId of [...planned.uncounted[side]].sort())
            items.push({
              taskId,
              field: "linked",
              direction: side,
              cause: "count_drop",
              before: "linked",
            });
        break;
      }
      default:
        return snapshot(bindingId, reason, "opaque");
    }
    return snapshot(bindingId, reason, "set", items, bases);
  }

  /**
   * The count of `linked` on one side, from the previous pass to this one
   * (guard_count_drop): a fall by more than countDropShare from at least
   * countDropMin sets the hold. True when it did.
   */
  countDrop(bindingId: string, side: "apple" | "lfcp", previous: number, current: number): boolean {
    if (!this.wouldDrop(previous, current)) return false;
    this.#hold(
      bindingId,
      ["guard_count_drop"],
      { [side]: current, [`${side}Before`]: previous },
      // Only the counts: nothing to compare (the pass's own count drop comes through admit).
      (reason) => snapshot(bindingId, reason, "opaque"),
    );
    return true;
  }

  /** Whether a fall from `previous` to `current` is a count drop (no hold set). */
  wouldDrop(previous: number, current: number): boolean {
    return (
      previous >= this.config.countDropMin && current < previous * (1 - this.config.countDropShare)
    );
  }

  /** Sets the holds, each with the snapshot of its anomaly (what an answer accepts). */
  #hold(
    bindingId: string,
    holds: readonly HoldReason[],
    counts: Readonly<Record<string, number>>,
    anomaly: (reason: HoldReason) => AnomalySnapshot,
  ) {
    const h = new Holds(this.db, this.now);
    for (const reason of holds) h.set(bindingId, reason, { ...counts, anomaly: anomaly(reason) });
    new Journal(this.db, this.now).append("error", "guard.limit", {
      bindingId,
      params: { holds: holds.join(", "), ...counts },
    });
  }
}
