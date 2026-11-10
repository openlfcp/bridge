// Limits (D-010 §7.2, the table of r2 §7.2): a binding that is about to do
// far more than a person would stops with a hold before anything of its
// pass is prepared. A sliding window of 1 h counts what was prepared in it
// (prepared and executed alike) and the link transitions journaled in it,
// plus what the pass plans.
//
// | guard                                   | threshold                                             | hold              |
// |-----------------------------------------|-------------------------------------------------------|-------------------|
// | unlinks + out_of_filter + task_gone     | > max(3, 10 % of the links); in strict (24 h after    | guard_mass_unlink |
// |                                         | approve, bindings.strict_until) > 1                   |                   |
// | new Tasks from Apple                    | > 10 an hour (> 3 in strict)                          | guard_mass_import |
// | status changes                          | > 50 % of the links in one pass, with ≥ 6 links       | guard_mass_status |
// | count drop                              | `linked` on either side fell > 50 %, from ≥ 5         | guard_count_drop  |
// | backlog                                 | > 200 open intents                                    | guard_backlog     |
//
// For a person: "Usually this means the filter got narrower or the list
// became unavailable, not that you deleted N tasks." Lifted by
// `resume --accept <hold>`. The bridge deletes no Task and no reminder in MVP.

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
  /** New Tasks from Apple in the window; in strict. */
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

/** r2 §7.2. */
export const LIMITS: LimitConfig = Object.freeze({
  windowMs: 60 * 60_000,
  unlinksMin: 3,
  unlinksShare: 0.1,
  unlinksStrict: 1,
  imports: 10,
  importsStrict: 3,
  statusShare: 0.5,
  statusMinLinks: 6,
  countDropShare: 0.5,
  countDropMin: 5,
  backlog: 200,
});

/** The link transitions that count as unlinks (journal keys, PR 12 writes them). */
export const UNLINK_KEYS = Object.freeze(["link.unlinked", "link.out_of_filter", "link.task_gone"]);

/** What a pass plans for one binding, before anything is prepared. */
export interface PlannedWork {
  readonly intents: readonly NewIntent[];
  /** Planned transitions to unlinked, out_of_filter or task_gone. */
  readonly unlinks: number;
  /** New Tasks from Apple the pass would make, beyond its intents (a dry-run's count, §6.2). */
  readonly imports?: number;
}

export type Admission =
  | { readonly ok: true }
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
  admit(bindingId: string, planned: PlannedWork): Admission {
    const a = this.check(bindingId, planned);
    if (a.ok) return a;
    // A guard a person accepted (resume --accept) lets this one pass through, once.
    const h = new Holds(this.db, this.now);
    const left = a.holds.filter((reason) => !h.takeAccepted(bindingId, reason));
    if (left.length === 0) return { ok: true };
    this.#hold(bindingId, left, a.counts);
    return { ok: false, holds: left, counts: a.counts };
  }

  /** What admit would answer, setting nothing: a dry-run shows the guards that would stop it. */
  check(bindingId: string, planned: PlannedWork): Admission {
    const c = this.config;
    const since = new Date(this.now() - c.windowMs).toISOString();
    const strict = this.strict(bindingId);
    const one = (sql: string, ...args: unknown[]) =>
      (this.db.prepare(sql).get(...args) as { n: number }).n;
    const links = one(
      "SELECT count(*) AS n FROM links WHERE binding_id = ? AND state = 'linked'",
      bindingId,
    );
    const imported = one(
      "SELECT count(*) AS n FROM intents WHERE binding_id = ? AND direction = 'to_lfcp' AND kind = 'create_task' AND created_at >= ?",
      bindingId,
      since,
    );
    const open = one(
      "SELECT count(*) AS n FROM intents WHERE binding_id = ? AND state IN ('prepared','effecting','applied')",
      bindingId,
    );
    const unlinked = one(
      `SELECT count(*) AS n FROM journal WHERE binding_id = ? AND ts >= ?
         AND key IN (${UNLINK_KEYS.map(() => "?").join(", ")})`,
      bindingId,
      since,
      ...UNLINK_KEYS,
    );
    const counts = {
      links,
      unlinks: unlinked + planned.unlinks,
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
    if (holds.length === 0) return { ok: true };
    return { ok: false, holds, counts };
  }

  /**
   * The count of `linked` on one side, from the previous pass to this one
   * (guard_count_drop): a fall by more than countDropShare from at least
   * countDropMin sets the hold. True when it did.
   */
  countDrop(bindingId: string, side: "apple" | "lfcp", previous: number, current: number): boolean {
    if (!this.wouldDrop(previous, current)) return false;
    this.#hold(bindingId, ["guard_count_drop"], { [side]: current, [`${side}Before`]: previous });
    return true;
  }

  /** Whether a fall from `previous` to `current` is a count drop (no hold set). */
  wouldDrop(previous: number, current: number): boolean {
    return (
      previous >= this.config.countDropMin && current < previous * (1 - this.config.countDropShare)
    );
  }

  #hold(bindingId: string, holds: readonly HoldReason[], counts: Readonly<Record<string, number>>) {
    const h = new Holds(this.db, this.now);
    for (const reason of holds) h.set(bindingId, reason, counts);
    new Journal(this.db, this.now).append("error", "guard.limit", {
      bindingId,
      params: { holds: holds.join(", "), ...counts },
    });
  }
}
