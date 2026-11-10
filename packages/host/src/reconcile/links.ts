// Link transitions of a pass (D-010 §6.1–§6.4, B4, B11; PR 12). The plan
// says what changed; this applies it to `links` (and `bases`), after the
// unlink limit (§7.2, r2). Nothing is ever deleted or written in Apple or
// LFCP here: a reminder that leaves synchronization stays with the person,
// with its personal data — the link becomes a tombstone that keeps it out
// of imports and matching.
//
// | transition     | here                                                                     |
// |----------------|--------------------------------------------------------------------------|
// | task_gone      | link → task_gone (Task deleted in LFCP; lfcp_live in the plan)           |
// | out_of_filter  | link → out_of_filter (reassigned, no due …; temporary — B11, not B4)     |
// | apple_missing  | global find (url, externalId, all lists): in another list →              |
// |                | unlinked(moved_out); none, complete → unlinked(deleted_in_apple);        |
// |                | incomplete → wait (B4: decided only on a complete find)                  |
// | return_find    | back in the filter, nothing in the list: the same global find first      |
// |                | (R2-9 (3)): in another list → unlinked(moved_out); none, complete → the  |
// |                | link goes and the next pass makes a new projection; incomplete → wait    |
// | relink         | back in the filter, its reminder found: linked again; the bases go, so   |
// |                | the next pass agrees as on a first link (LFCP wins, status by the table) |
// | link_orphan    | an orphan reminder of ours: linked, as a first link                     |
// | quarantine     | link → quarantine (ambiguous): a person decides                          |
// | ignore_copies  | completed recurring copies → the link's ignored ids                      |
// | status_lock    | a recurrence on the reminder: status and due read-only both ways (§6.4)  |
// | status_unlock  | recurrence gone: unlocked; status and due bases go (re-agreed)           |
//
// unlinked (moved_out, deleted_in_apple) is the person's decision (B4): the
// Task does not come back to this list until `relink` (after MVP), whatever
// the filter says. out_of_filter and task_gone are temporary: a return
// relinks the same reminder when it can be found unambiguously.

import type { AppleItem, ListRef, RemindersTransport } from "@openlfcp/bridge-reminders";
import { type Plan, type Transition, taskLink } from "@openlfcp/bridge-reminders/adapter";
import type { BridgeDatabase } from "../db/database.js";
import { type HoldReason, Holds } from "../db/holds.js";
import { Journal } from "../db/journal.js";
import type { Executor } from "../executor/executor.js";
import type { Intent } from "../executor/intents.js";
import { Limits } from "../executor/limits.js";

export type LinkOutcome = {
  readonly taskId: string;
  readonly transition: Transition["kind"];
  /** What became of the link: its new state, "removed" (re-projection), or "waiting". */
  readonly result: string;
};

export type LinkApplyResult =
  | {
      readonly kind: "applied";
      readonly outcomes: readonly LinkOutcome[];
      /** The pass's intents, prepared after the whole pass was admitted (with `executor`). */
      readonly prepared: readonly Intent[];
    }
  /** The unlink limit (or another guard) stopped the pass: nothing applied, holds set. */
  | { readonly kind: "held"; readonly holds: readonly HoldReason[] };

interface LinkRow {
  rem_url: string | null;
  rem_external_id: string | null;
  rem_id_cache: string | null;
  ignored_external_ids_json: string;
}

type Located =
  | { readonly kind: "present"; readonly item: AppleItem }
  | { readonly kind: "elsewhere"; readonly item: AppleItem }
  | { readonly kind: "absent" }
  /** More than one reminder answers the link: a person decides (§5.4, B11). */
  | { readonly kind: "ambiguous" }
  | { readonly kind: "unknown" };

export interface LinkApplierOptions {
  readonly db: BridgeDatabase;
  readonly transport: RemindersTransport;
  readonly now?: () => number;
}

export class LinkApplier {
  readonly #o: LinkApplierOptions;
  readonly #now: () => number;
  readonly #journal: Journal;

  constructor(o: LinkApplierOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
    this.#journal = new Journal(o.db, this.#now);
  }

  /**
   * Applies a pass of `bindingId` (review PR 12 #15, #16): the global finds are resolved first,
   * without changing anything; then the whole pass — its intents, the unlinks it will really make
   * (return_find's moved_out included), the dry run's count drop, matching's holds — is checked
   * once, on the state before any change. If anything stops it, nothing is applied and nothing
   * prepared (until `resume --accept`). Else the link transitions are applied, then, with
   * `executor`, the intents prepared (their limits already checked).
   */
  async apply(
    bindingId: string,
    plan: Plan,
    o: { readonly executor?: Executor; readonly guards?: readonly string[] } = {},
  ): Promise<LinkApplyResult> {
    const db = this.#o.db;
    const b = db
      .prepare("SELECT resource_id, target_ref FROM bindings WHERE id = ?")
      .get(bindingId) as { resource_id: string; target_ref: string | null } | undefined;
    if (b === undefined) throw new Error(`no binding ${bindingId}`);
    const holds = new Holds(db, this.#now);
    // The holds matching found (§5.4): import_ambiguous (R2-9 (4)) stops imports — matching
    // already left them out —, foreign_bridge (§6.5) stops the binding.
    for (const h of plan.holds)
      if (holds.set(bindingId, h, { seen: new Date(this.#now()).toISOString() }))
        this.#journal.append("warn", `hold.${h}`, { bindingId });
    // A hold already set and not accepted (`resume --accept`) stops the whole pass, even when this
    // plan alone would pass (review PR 12 #19): the anomaly is the person's to accept, not the
    // next pass's to outgrow. import_ambiguous only stops imports — matching left them out already.
    const standing = holds
      .of(bindingId)
      .map((h) => h.reason)
      .filter((r) => r !== "import_ambiguous");
    if (standing.length > 0) return { kind: "held", holds: standing };

    // 1. Global finds, nothing changed yet.
    const located = new Map<string, Located>();
    for (const t of plan.transitions) {
      if (t.kind !== "apple_missing" && t.kind !== "return_find") continue;
      const link = this.#link(bindingId, t.taskId);
      if (link !== undefined) located.set(t.taskId, await this.#locate(link, t.taskId, b));
    }
    // 2. The whole pass against the limits, on the state before any change.
    let unlinks = 0;
    for (const t of plan.transitions) {
      if (t.kind === "task_gone" || t.kind === "out_of_filter") unlinks++;
      const where = located.get(t.taskId);
      if (where?.kind === "elsewhere" || (t.kind === "apple_missing" && where?.kind === "absent"))
        unlinks++;
    }
    const admitted = new Limits(db, undefined, this.#now).admit(bindingId, {
      intents: plan.intents,
      unlinks,
    });
    const stopped: HoldReason[] = admitted.ok ? [] : [...admitted.holds];
    if (
      o.guards?.includes("guard_count_drop") &&
      !holds.takeAccepted(bindingId, "guard_count_drop")
    ) {
      if (holds.set(bindingId, "guard_count_drop", { seen: new Date(this.#now()).toISOString() }))
        this.#journal.append("error", "guard.limit", {
          bindingId,
          params: { holds: "guard_count_drop" },
        });
      stopped.push("guard_count_drop");
    }
    if (stopped.length > 0) return { kind: "held", holds: stopped };

    // 3. Apply: the link transitions, then the intents.
    const out: LinkOutcome[] = [];
    for (const t of plan.transitions) {
      const result = this.#one(bindingId, b, t, located.get(t.taskId));
      out.push({ taskId: t.taskId, transition: t.kind, result });
    }
    const prepared =
      o.executor === undefined || plan.intents.length === 0
        ? []
        : (o.executor.prepare(
            bindingId,
            { intents: plan.intents, unlinks: 0 },
            { admitted: true },
          ) ?? []);
    return { kind: "applied", outcomes: out, prepared };
  }

  #link(bindingId: string, taskId: string): LinkRow | undefined {
    return this.#o.db
      .prepare(
        "SELECT rem_url, rem_external_id, rem_id_cache, ignored_external_ids_json FROM links WHERE binding_id = ? AND task_id = ?",
      )
      .get(bindingId, taskId) as LinkRow | undefined;
  }

  #one(
    bindingId: string,
    b: { resource_id: string; target_ref: string | null },
    t: Transition,
    where: Located | undefined,
  ): string {
    const db = this.#o.db;
    const at = new Date(this.#now()).toISOString();
    const link = this.#link(bindingId, t.taskId);
    const setState = (state: string, reason: string | null, from: readonly string[]) =>
      db
        .prepare(
          `UPDATE links SET state = ?, state_reason = ?, updated_at = ?
            WHERE binding_id = ? AND task_id = ? AND state IN (${from.map(() => "?").join(", ")})`,
        )
        .run(state, reason, at, bindingId, t.taskId, ...from).changes === 1;
    const journal = (level: "info" | "warn", key: string, params: Record<string, unknown> = {}) =>
      this.#journal.append(level, key, { bindingId, taskId: t.taskId, params });
    const dropBases = (fields?: readonly string[]) =>
      fields === undefined
        ? db
            .prepare("DELETE FROM bases WHERE binding_id = ? AND task_id = ?")
            .run(bindingId, t.taskId)
        : db
            .prepare(
              `DELETE FROM bases WHERE binding_id = ? AND task_id = ? AND field IN (${fields.map(() => "?").join(", ")})`,
            )
            .run(bindingId, t.taskId, ...fields);
    const tx = <T>(f: () => T): T => db.transaction(f).immediate();

    switch (t.kind) {
      case "task_gone":
      case "out_of_filter":
        return tx(() => {
          if (!setState(t.kind, null, ["linked"])) return "skipped";
          journal("info", `link.${t.kind}`);
          return t.kind;
        });
      case "apple_missing":
      case "return_find": {
        if (link === undefined || where === undefined) return "skipped";
        return tx(() => {
          const from = t.kind === "apple_missing" ? ["linked"] : ["out_of_filter", "task_gone"];
          if (where.kind === "unknown") return "waiting";
          if (where.kind === "ambiguous") {
            if (!setState("quarantine", "ambiguous_find", from)) return "skipped";
            journal("warn", "link.quarantine", { reason: "ambiguous_find" });
            return "quarantine";
          }
          if (where.kind === "elsewhere") {
            if (!setState("unlinked", "moved_out", from)) return "skipped";
            journal("warn", "link.unlinked", { reason: "moved_out" });
            return "unlinked";
          }
          if (where.kind === "present") {
            // The plan's snapshot missed it (or it came back): linked to what was found.
            this.#rememberItem(bindingId, t.taskId, where.item, at);
            if (!setState("linked", null, [...from, "linked"])) return "skipped";
            if (t.kind === "return_find") dropBases();
            return "linked";
          }
          if (t.kind === "apple_missing") {
            if (!setState("unlinked", "deleted_in_apple", from)) return "skipped";
            journal("warn", "link.unlinked", { reason: "deleted_in_apple" });
            return "unlinked";
          }
          // Back in the filter and its old reminder is gone everywhere: a new projection.
          db.prepare(
            "DELETE FROM links WHERE binding_id = ? AND task_id = ? AND state IN ('out_of_filter','task_gone')",
          ).run(bindingId, t.taskId);
          dropBases();
          journal("info", "link.reprojected");
          return "removed";
        });
      }
      case "relink":
        return tx(() => {
          if (t.item !== undefined) this.#rememberRef(bindingId, t.taskId, t.item, at);
          if (!setState("linked", null, ["out_of_filter", "task_gone"])) return "skipped";
          dropBases();
          journal("info", "link.relinked");
          return "linked";
        });
      case "link_orphan":
        return tx(() => {
          if (t.item === undefined) return "skipped";
          const r = db
            .prepare(
              `INSERT INTO links (binding_id, task_id, rem_url, rem_external_id, rem_id_cache, origin, state,
                 ignored_external_ids_json, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'lfcp', 'linked', ?, ?, ?) ON CONFLICT (binding_id, task_id) DO NOTHING`,
            )
            .run(
              bindingId,
              t.taskId,
              taskLink(t.taskId, b.resource_id, this.#instance()),
              t.item.externalId ?? null,
              t.item.id,
              JSON.stringify(t.ignore ?? []),
              at,
              at,
            );
          if (r.changes !== 1) return "skipped";
          journal("info", "link.relinked", { orphan: true });
          return "linked";
        });
      case "quarantine":
        return tx(() => {
          if (
            !setState("quarantine", t.reason ?? null, [
              "linked",
              "pending_apple_create",
              "pending_lfcp_create",
              "out_of_filter",
              "task_gone",
              "unlinked",
            ])
          )
            return "skipped";
          journal("warn", "link.quarantine", { reason: t.reason ?? null });
          return "quarantine";
        });
      case "ignore_copies":
        return tx(() => {
          if (link === undefined) return "skipped";
          const ids = new Set([
            ...(JSON.parse(link.ignored_external_ids_json) as string[]),
            ...(t.ignore ?? []),
          ]);
          db.prepare(
            "UPDATE links SET ignored_external_ids_json = ?, updated_at = ? WHERE binding_id = ? AND task_id = ?",
          ).run(JSON.stringify([...ids]), at, bindingId, t.taskId);
          return "ignored";
        });
      case "user_replaced":
        return tx(() => {
          const r = db
            .prepare(
              "UPDATE links SET url_state = 'user_replaced', rem_url = ?, updated_at = ? WHERE binding_id = ? AND task_id = ? AND state = 'linked'",
            )
            .run(t.url ?? null, at, bindingId, t.taskId);
          if (r.changes !== 1) return "skipped";
          journal("info", "link.user_replaced");
          return "user_replaced";
        });
      case "status_lock":
      case "status_unlock":
        return tx(() => {
          const lock = t.kind === "status_lock";
          db.prepare(
            "UPDATE links SET status_locked = ?, updated_at = ? WHERE binding_id = ? AND task_id = ?",
          ).run(lock ? 1 : 0, at, bindingId, t.taskId);
          if (!lock) dropBases(["status", "due"]);
          journal("info", lock ? "link.status_locked" : "link.status_unlocked");
          return lock ? "locked" : "unlocked";
        });
    }
  }

  /** Global find (§6.3, R2-9 (3)): by the link's URL and its externalId, in every list. */
  async #locate(
    link: LinkRow,
    taskId: string,
    b: { resource_id: string; target_ref: string | null },
  ): Promise<Located> {
    const t = this.#o.transport;
    const url = link.rem_url ?? taskLink(taskId, b.resource_id, this.#instance());
    const reads = [
      t.find({ url }, "all"),
      ...(link.rem_external_id === null
        ? []
        : [t.find({ externalId: link.rem_external_id }, "all")]),
    ];
    let results: Awaited<ReturnType<RemindersTransport["find"]>>[];
    try {
      results = await Promise.all(reads);
    } catch {
      return { kind: "unknown" };
    }
    // Nothing is decided on an incomplete find, found or not (§6.3, B4; review PR 12 #17).
    if (!results.every((r) => r.complete)) return { kind: "unknown" };
    const found = new Map<string, AppleItem>();
    const ignored = new Set(JSON.parse(link.ignored_external_ids_json) as string[]);
    for (const r of results)
      for (const i of r.items)
        if (i.ref.externalId === undefined || !ignored.has(i.ref.externalId))
          found.set(i.ref.id, i);
    const items = [...found.values()];
    if (items.length === 0) return { kind: "absent" };
    // One reminder, or the open one of recurring copies (§6.4); several → a person decides, never
    // the first of a list (review PR 12 #18).
    let one = items.length === 1 ? items[0] : undefined;
    if (one === undefined && this.#o.transport.capabilities.recurringCompletion === "copy") {
      const open = items.filter((i) => !i.completed);
      if (open.length === 1) one = open[0];
    }
    if (one === undefined) return { kind: "ambiguous" };
    return one.list === (b.target_ref as ListRef)
      ? { kind: "present", item: one }
      : { kind: "elsewhere", item: one };
  }

  #rememberItem(bindingId: string, taskId: string, item: AppleItem, at: string) {
    this.#rememberRef(bindingId, taskId, item.ref, at);
  }

  #rememberRef(
    bindingId: string,
    taskId: string,
    ref: { readonly id: string; readonly externalId?: string },
    at: string,
  ) {
    this.#o.db
      .prepare(
        "UPDATE links SET rem_id_cache = ?, rem_external_id = coalesce(?, rem_external_id), updated_at = ? WHERE binding_id = ? AND task_id = ?",
      )
      .run(ref.id, ref.externalId ?? null, at, bindingId, taskId);
  }

  #instance(): string {
    const r = this.#o.db.prepare("SELECT value FROM meta WHERE key = 'bridge_instance_id'").get() as
      | { value: string }
      | undefined;
    return r?.value ?? "";
  }
}
