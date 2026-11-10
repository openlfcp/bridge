// A reconciliation pass of one binding (D-010 §5.5) — in this build a
// dry-run only (§11 PR 8): both sides are read, the adapter plans, the
// guards are checked without setting anything, and the plan is stored in
// `runs` (kind 'dry', plan_json), where `approve` (PR 9) finds it. Nothing
// is prepared or written, in Apple, in LFCP or in the binding's state.
//
// `apply` answers `dry_run_only`: the executor gets intents from a pass only
// in a later build (verification bindings, PR 9).
//
// | step | what                                                                      |
// |------|---------------------------------------------------------------------------|
// | 1    | the binding (pending_dry_run or active, with its list) and its filter's me |
// | 2    | LFCP: the section's Tasks from the replica, lfcp_live                      |
// | 3    | Apple: the list's snapshot (complete or not)                              |
// | 4    | links, bases, open intents, open conflicts from bridge.sqlite              |
// | 5    | the adapter's plan (projections, matching, filter)                        |
// | 6    | guards §7.2 as admit would see them, count drop against the last pass    |
// | 7    | the run: stats and plan                                                   |

import { randomBytes, randomUUID } from "node:crypto";
import type { RemindersTransport } from "@openlfcp/bridge-reminders";
import { TransportReadError } from "@openlfcp/bridge-reminders";
import {
  type Field,
  type FieldBase,
  type FilterMode,
  isFilterMode,
  type LinkRow,
  type LinkState,
  needsMe,
  type Plan,
  plan,
} from "@openlfcp/bridge-reminders/adapter";
import { fromHex, resourceId } from "@openlfcp/core";
import type { BridgeDatabase } from "../db/database.js";
import type { HoldReason } from "../db/holds.js";
import { Limits } from "../executor/limits.js";
import { type LfcpReader, sectionView } from "./section-view.js";

export interface PassOptions {
  readonly db: BridgeDatabase;
  readonly transport: RemindersTransport;
  readonly lfcp: LfcpReader;
  /** The person's root as a PrincipalRef (G4): who "me" is for the filter; undefined when not known. */
  readonly me: (installationId: string) => Promise<string | undefined>;
  /** The zone Apple's completion dates are read in (default: this process's). */
  readonly timeZone?: string;
  readonly now?: () => number;
}

export type DryRunRefusal =
  | "no_binding"
  /** Bootstrapping or removed. */
  | "binding_state"
  | "no_list"
  /** The section is not open in the SectionHost. */
  | "section_closed"
  /** The filter needs me and the person's root is not known (not paired). */
  | "identity_unknown"
  | "transport"
  | "snapshot_failed";

export type DryRunResult =
  | {
      readonly kind: "planned";
      readonly runId: string;
      readonly plan: Plan;
      /** The guards that would stop this pass (§7.2), none set. */
      readonly guards: readonly HoldReason[];
      readonly guardCounts: Readonly<Record<string, number>>;
    }
  | {
      readonly kind: "refused";
      readonly runId: string;
      readonly reason: DryRunRefusal;
      readonly detail?: string;
    };

interface BindingRow {
  id: string;
  installation_id: string;
  resource_id: string;
  target_ref: string | null;
  filter_mode: string;
  state: string;
}

interface LinkDbRow {
  task_id: string;
  state: LinkState;
  origin: "lfcp" | "apple";
  rem_url: string | null;
  rem_external_id: string | null;
  rem_id_cache: string | null;
  url_state: LinkRow["urlState"];
  status_locked: number;
  ignored_external_ids_json: string;
}

const parse = (s: string | null): unknown => (s === null ? undefined : JSON.parse(s));

/** This bridge's instance id (meta `bridge_instance_id`), made once: links' `b`, markers (§3). */
export function bridgeInstanceId(db: BridgeDatabase): string {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'bridge_instance_id'").get() as
    | { value: string }
    | undefined;
  if (row !== undefined) return row.value;
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('bridge_instance_id', ?)").run(
    randomBytes(16).toString("hex"),
  );
  return (
    db.prepare("SELECT value FROM meta WHERE key = 'bridge_instance_id'").get() as { value: string }
  ).value;
}

export class Pass {
  readonly #o: PassOptions;
  readonly #now: () => number;

  constructor(options: PassOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
  }

  /** Not in this build (D-010 §11 PR 8): a pass only plans. */
  async apply(
    _bindingId: string,
  ): Promise<{ readonly kind: "refused"; readonly reason: "dry_run_only" }> {
    return { kind: "refused", reason: "dry_run_only" };
  }

  /** A full pass without effects: the plan, its conflicts and the guards it would trip, stored as a dry run. */
  async dryRun(bindingId: string): Promise<DryRunResult> {
    const runId = randomUUID();
    const started = new Date(this.#now()).toISOString();
    const refused = (reason: DryRunRefusal, detail?: string): DryRunResult => {
      this.#record(runId, bindingId, started, reason, { reason, ...(detail ? { detail } : {}) });
      return { kind: "refused", runId, reason, ...(detail === undefined ? {} : { detail }) };
    };
    const db = this.#o.db;
    const b = db
      .prepare(
        "SELECT id, installation_id, resource_id, target_ref, filter_mode, state FROM bindings WHERE id = ?",
      )
      .get(bindingId) as BindingRow | undefined;
    if (b === undefined) return refused("no_binding");
    if (b.state !== "pending_dry_run" && b.state !== "active")
      return refused("binding_state", b.state);
    if (b.target_ref === null) return refused("no_list");
    const filter: FilterMode = isFilterMode(b.filter_mode) ? b.filter_mode : "default";
    const me = await this.#o.me(b.installation_id);
    if (me === undefined && needsMe(filter)) return refused("identity_unknown", filter);

    const R = resourceId(fromHex(b.resource_id));
    const lfcp = sectionView(this.#o.lfcp, R);
    if (lfcp === undefined) return refused("section_closed");

    const t = this.#o.transport;
    if (t.status().state !== "ok") return refused("transport", t.status().state);
    let snapshot: Awaited<ReturnType<RemindersTransport["snapshot"]>>;
    try {
      snapshot = await t.snapshot(b.target_ref as Parameters<RemindersTransport["snapshot"]>[0]);
    } catch (e) {
      return refused("snapshot_failed", e instanceof TransportReadError ? e.code : String(e));
    }

    const links = (
      db
        .prepare(
          `SELECT task_id, state, origin, rem_url, rem_external_id, rem_id_cache, url_state, status_locked,
                  ignored_external_ids_json FROM links WHERE binding_id = ?`,
        )
        .all(b.id) as LinkDbRow[]
    ).map(
      (l): LinkRow => ({
        taskId: l.task_id,
        state: l.state,
        origin: l.origin,
        ...(l.rem_url === null ? {} : { remUrl: l.rem_url }),
        ...(l.rem_external_id === null ? {} : { remExternalId: l.rem_external_id }),
        ...(l.rem_id_cache === null ? {} : { remIdCache: l.rem_id_cache }),
        urlState: l.url_state,
        statusLocked: l.status_locked === 1,
        ignoredExternalIds: JSON.parse(l.ignored_external_ids_json) as string[],
      }),
    );
    const bases = new Map<string, Map<Field, FieldBase>>();
    for (const r of db
      .prepare(
        "SELECT task_id, field, lfcp_proj_json, lfcp_shadow_json, apple_proj_json FROM bases WHERE binding_id = ?",
      )
      .all(b.id) as {
      task_id: string;
      field: Field;
      lfcp_proj_json: string | null;
      lfcp_shadow_json: string | null;
      apple_proj_json: string | null;
    }[]) {
      const m = bases.get(r.task_id) ?? new Map<Field, FieldBase>();
      bases.set(r.task_id, m);
      const shadow = parse(r.lfcp_shadow_json);
      m.set(r.field, {
        lfcpProj: parse(r.lfcp_proj_json) ?? null,
        appleProj: parse(r.apple_proj_json) ?? null,
        ...(shadow === undefined ? {} : { lfcpShadow: shadow }),
      });
    }
    const open = new Set(
      (
        db
          .prepare(
            "SELECT task_id, direction FROM intents WHERE binding_id = ? AND state IN ('prepared','effecting','applied')",
          )
          .all(b.id) as { task_id: string; direction: string }[]
      ).map((r) => `${r.task_id}\u0000${r.direction}`),
    );
    const held = new Map<string, string[]>();
    for (const r of db
      .prepare("SELECT task_id, field FROM conflicts WHERE binding_id = ? AND resolved_at IS NULL")
      .all(b.id) as { task_id: string; field: string }[]) {
      const a = held.get(r.task_id) ?? [];
      a.push(r.field);
      held.set(r.task_id, a);
    }

    const p = plan({
      binding: {
        id: b.id,
        installationId: b.installation_id,
        section: b.resource_id,
        list: b.target_ref as Parameters<RemindersTransport["snapshot"]>[0],
        filter,
        bridgeInstanceId: bridgeInstanceId(db),
      },
      ...(me === undefined ? {} : { me }),
      tasks: lfcp.tasks,
      unreadable: lfcp.unreadable,
      lfcpLive: lfcp.live,
      snapshot,
      links,
      bases,
      openIntent: (task, direction) => open.has(`${task}\u0000${direction}`),
      heldFields: (task) => held.get(task) ?? [],
      capabilities: t.capabilities,
      timeZone: this.#o.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    });

    // §7.2, as admit would answer; nothing is set by a dry run.
    const limits = new Limits(db, undefined, this.#now);
    const admission = limits.check(b.id, {
      intents: p.intents,
      unlinks: p.counts.unlinks,
      imports: p.counts.imports,
    });
    const guards: HoldReason[] = admission.ok ? [] : [...admission.holds];
    const previous = this.#previousCounts(b.id);
    if (
      previous !== undefined &&
      (limits.wouldDrop(previous.linkedApple, p.counts.linkedApple) ||
        limits.wouldDrop(previous.linkedLfcp, p.counts.linkedLfcp))
    )
      guards.push("guard_count_drop");
    for (const h of p.holds) guards.push(h);
    const guardCounts = admission.ok ? {} : admission.counts;
    this.#record(runId, b.id, started, "planned", { ...p.counts, guards }, p);
    return { kind: "planned", runId, plan: p, guards, guardCounts };
  }

  /**
   * The counts guard_count_drop compares against: the binding's last planned
   * pass that did not itself show the drop (review PR 8 #10). A pass that saw
   * a drop does not accept it — looking again shows it again, until a pass
   * without it (the counts came back) or an accept (`resume --accept`, PR 9)
   * makes a new baseline.
   */
  #previousCounts(bindingId: string): { linkedApple: number; linkedLfcp: number } | undefined {
    const rows = this.#o.db
      .prepare(
        "SELECT stats_json FROM runs WHERE binding_id = ? AND kind IN ('dry','apply') AND outcome = 'planned' ORDER BY started_at DESC, rowid DESC",
      )
      .iterate(bindingId) as IterableIterator<{ stats_json: string | null }>;
    for (const r of rows) {
      const s = parse(r.stats_json) as
        | { linkedApple?: unknown; linkedLfcp?: unknown; guards?: unknown }
        | undefined;
      if (typeof s?.linkedApple !== "number" || typeof s.linkedLfcp !== "number") continue;
      if (Array.isArray(s.guards) && s.guards.includes("guard_count_drop")) continue;
      return { linkedApple: s.linkedApple, linkedLfcp: s.linkedLfcp };
    }
    return undefined;
  }

  #record(
    runId: string,
    bindingId: string,
    started: string,
    outcome: string,
    stats: unknown,
    planned?: Plan,
  ): void {
    this.#o.db
      .prepare(
        `INSERT INTO runs (id, kind, binding_id, started_at, ended_at, outcome, stats_json, plan_json)
         VALUES (?, 'dry', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        bindingId,
        started,
        new Date(this.#now()).toISOString(),
        outcome,
        JSON.stringify(stats),
        planned === undefined ? null : JSON.stringify(planned),
      );
  }
}
