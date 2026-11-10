// One reconciliation pass of a binding (D-010 §5.5, r2 §5.5): a pure plan
// from what both sides show now and what the bridge knows (links, bases,
// open intents, conflicts). It writes nothing; the host stores it (dry-run)
// or, in a later build, prepares its intents.
//
// For each linked pair and field (§4.4), with base = the field's bases:
//   no base yet (a first link) → equivalent: record the bases; else LFCP
//                                wins (B14)
//   ¬dL ∧ ¬dA                  → nothing (a priority shadow change: record it)
//   pL ≡ pA                    → record the bases, no write (B13: a priority in
//                                the same bucket is no write)
//    dL ∧ ¬dA                  → to_apple
//   ¬dL ∧  dA                  → to_lfcp (PR 10): set_title, set_due / clear_due
//                                (the date only: time is personal, B12),
//                                set_priority (with the shadow, B13)
//    dL ∧  dA                  → LFCP wins (B14), Apple's value to the journal
// The status group goes by its own table (status-table.ts, r3 P2-2): one
// row per input, its action to Apple, to LFCP, or none (bases / shadow).
// A Task gets at most one update intent per direction in a pass.
// A field with an open conflict (unknown_outcome too) is held; a link with
// status_locked writes neither status nor due (§6.4). An open intent of the
// Task and direction holds a new one back.
//
// Then the links (§6.1–6.3): a Task gone or out of the filter (only when
// LFCP is live), a reminder missing (only on a complete snapshot), a return
// to the filter, an orphan to link; a projectable Task without a link and
// without a reminder in a complete snapshot → a new projection (create). New reminders (§6.2) and
// restore_url are PR 11's, the link transitions PR 12's: this PR shows them.
//
// The host stores the plan (dry-run) or, where apply is allowed, prepares its intents.

import type { CapabilityDeclaration } from "../capabilities.js";
import type { AppleItem, ListRef, WritableSet } from "../transport.js";
import { type FilterMode, inFilter, projectable } from "./filter.js";
import { type LfcpTaskIntent, type LfcpValues, lfcpStatusWrite, lfcpWrite } from "./lfcp-write.js";
import { taskLink } from "./link.js";
import { type LinkMatch, type LinkRow, type MatchResult, match } from "./matching.js";
import {
  type AppleNative,
  type AppleWrite,
  appleNative,
  appleWrite,
  equivalent,
  FIELDS,
  type Field,
  type LfcpShadow,
  type LfcpTask,
  lfcpValuesOf,
  type Projections,
  projectApple,
  projectLfcp,
  type StatusProjection,
  sameProjection,
  shadowOf,
} from "./projection.js";
import { type StatusInput, type StatusRowId, statusKind, statusRow } from "./status-table.js";

/** The bases of one field (§3 `bases`), as the plan reads them. */
export interface FieldBase {
  readonly lfcpProj: unknown;
  readonly appleProj: unknown;
  readonly lfcpShadow?: unknown;
}

export interface PassBinding {
  readonly id: string;
  readonly installationId: string;
  /** The section, hex. */
  readonly section: string;
  readonly list: ListRef;
  readonly filter: FilterMode;
  readonly bridgeInstanceId: string;
}

export interface PassView {
  readonly binding: PassBinding;
  /** The person's root as a PrincipalRef (G4); needed by the filters default and mine. */
  readonly me?: string;
  /** The section's Tasks (deleted ones too), from the replica. */
  readonly tasks: readonly LfcpTask[];
  /** Task ids in the section whose Task the replica cannot read now (invalid values): no conclusion about them. */
  readonly unreadable?: readonly string[];
  /** lfcp_live (§5.3): conclusions from LFCP absence only when true. */
  readonly lfcpLive: boolean;
  readonly snapshot: { readonly items: readonly AppleItem[]; readonly complete: boolean };
  readonly links: readonly LinkRow[];
  readonly bases: ReadonlyMap<string, ReadonlyMap<Field, FieldBase>>;
  /** An open intent of (Task, direction). */
  readonly openIntent: (taskId: string, direction: "to_apple" | "to_lfcp") => boolean;
  /** Fields of a Task with an open conflict (any kind, unknown_outcome too). */
  readonly heldFields: (taskId: string) => readonly string[];
  readonly capabilities: Pick<CapabilityDeclaration, "recurringCompletion">;
  /** The zone Apple's completion dates are read in. */
  readonly timeZone: string;
}

/** An intent as the host's executor prepares it (structurally its NewIntent). */
export type PlannedIntent = PlannedAppleIntent | PlannedLfcpIntent;

/** The basis of an intent (§5.6): what the plan saw of both sides, for finalize and the §5.8 check. */
export interface PlannedBasis {
  readonly rev?: string;
  /** The LFCP projections of the fields (all four for a create). */
  readonly pL: Partial<Projections>;
  readonly shadow: LfcpShadow;
  /** The Task's exact values at the plan. */
  readonly lfcp?: LfcpValues;
  readonly pA?: Partial<Projections>;
  /** Apple's stored values of the fields (to_lfcp: the Apple base's native). */
  readonly native?: AppleNative;
  /** B14: Apple's values this write overrules, by field — journaled at finalize. */
  readonly appleOverruled?: Partial<Projections>;
}

/** to_lfcp (PR 10): Task intents on the binding's section, through commitGuarded. */
export interface PlannedLfcpIntent {
  readonly bindingId: string;
  readonly taskId: string;
  readonly installationId: string;
  readonly direction: "to_lfcp";
  readonly kind: "update_task";
  readonly fields: readonly Field[];
  readonly basis: PlannedBasis;
  readonly payload: { readonly resource: string; readonly intents: readonly LfcpTaskIntent[] };
  readonly warnings: readonly string[];
}

export interface PlannedAppleIntent {
  readonly bindingId: string;
  readonly taskId: string;
  readonly installationId: string;
  readonly direction: "to_apple";
  readonly kind: "create" | "update";
  readonly fields: readonly Field[];
  readonly basis: PlannedBasis;
  readonly payload:
    | {
        readonly kind: "create";
        readonly list: ListRef;
        readonly linkUrl: string;
        readonly set: WritableSet;
      }
    | {
        readonly kind: "update";
        readonly ref: { readonly id: string; readonly externalId?: string };
        readonly set: WritableSet;
        readonly expect: { readonly rev: string };
      };
  /** Notes for the journal (e.g. alarm_on_old_date). */
  readonly warnings: readonly string[];
}

export type FieldDecision =
  | "write_apple"
  | "write_lfcp"
  | "bases"
  | "shadow"
  | "held"
  | "status_locked"
  | "pending_intent"
  | "conflict";

export interface Decision {
  readonly taskId: string;
  readonly field: Field;
  readonly decision: FieldDecision;
  readonly lfcp?: unknown;
  readonly apple?: unknown;
  /** B14: both changed, LFCP wins, Apple's value goes to the journal. */
  readonly appleValueLost?: boolean;
  /** The status table's row (status only). */
  readonly row?: StatusRowId;
}

export type TransitionKind =
  /** Task deleted in LFCP (lfcp_live). */
  | "task_gone"
  /** Task left the filter (lfcp_live, origin lfcp). */
  | "out_of_filter"
  /** A linked reminder is missing from a complete snapshot: a global find decides moved_out / deleted_in_apple (§6.3). */
  | "apple_missing"
  /** Back in the filter (or restored), its reminder found: linked again, bases as on a first link. */
  | "relink"
  /** Back in the filter, no reminder in the list: a global find, then a new projection (§6.1). */
  | "return_find"
  /** An orphan projection of ours: link it (§5.4 pass 2). */
  | "link_orphan"
  | "quarantine"
  /** Recurring copies to ignore (§6.4). */
  | "ignore_copies";

export interface Transition {
  readonly taskId: string;
  readonly kind: TransitionKind;
  readonly reason?: string;
  readonly item?: { readonly id: string; readonly externalId?: string };
  readonly ignore?: readonly string[];
}

export type Waiting =
  /** A conclusion from LFCP absence needs lfcp_live. */
  | "lfcp_not_live"
  /** A conclusion from Apple absence needs a complete snapshot. */
  | "apple_incomplete"
  /** The Task is in the section, but the replica cannot read it now. */
  | "task_unreadable";

export interface PlannedConflict {
  readonly taskId: string;
  readonly field: Field;
  readonly kind: "due_cleared_in_lfcp";
}

/** What PR 11 will do with a reminder; shown, not planned as intents here. */
export interface ItemNote {
  readonly kind:
    | "import"
    | "import_blocked"
    | "restore_url"
    | "user_replaced"
    | "foreign_bridge"
    | "orphan_quarantine"
    | "ignore";
  readonly item: { readonly id: string; readonly externalId?: string; readonly title: string };
  readonly taskId?: string;
  readonly reason?: string;
}

export interface Plan {
  readonly bindingId: string;
  readonly intents: readonly PlannedIntent[];
  readonly decisions: readonly Decision[];
  readonly transitions: readonly Transition[];
  readonly conflicts: readonly PlannedConflict[];
  readonly items: readonly ItemNote[];
  readonly waiting: readonly { readonly taskId: string; readonly waiting: Waiting }[];
  readonly holds: readonly ("foreign_bridge" | "import_ambiguous")[];
  readonly counts: {
    readonly tasks: number;
    readonly inFilter: number;
    readonly reminders: number;
    readonly linked: number;
    /** linked, with its reminder in the snapshot (guard_count_drop, Apple side). */
    readonly linkedApple: number;
    /** linked, with its Task active and in the filter (guard_count_drop, LFCP side). */
    readonly linkedLfcp: number;
    readonly creates: number;
    readonly updates: number;
    readonly imports: number;
    /** Planned transitions to out_of_filter, task_gone, unlinked (§7.2). */
    readonly unlinks: number;
  };
}

const ref = (i: AppleItem) => ({
  id: i.ref.id,
  ...(i.ref.externalId === undefined ? {} : { externalId: i.ref.externalId }),
});
const note = (kind: ItemNote["kind"], i: AppleItem, extra: Partial<ItemNote> = {}): ItemNote => ({
  kind,
  item: { ...ref(i), title: i.title },
  ...extra,
});

export function plan(view: PassView): Plan {
  const b = view.binding;
  const tasks = new Map(view.tasks.map((t) => [t.id, t]));
  const filtered = (t: LfcpTask | undefined) =>
    t !== undefined && t.lifecycle === "active" && inFilter(t, b.filter, view.me);
  const m: MatchResult = match(view.links, view.snapshot.items, {
    section: b.section,
    bridge8: b.bridgeInstanceId.slice(0, 8),
    recurringCompletion: view.capabilities.recurringCompletion,
    task: (id) => {
      const t = tasks.get(id);
      return { inSection: t?.lifecycle === "active", inFilter: filtered(t) };
    },
  });

  const intents: PlannedIntent[] = [];
  const decisions: Decision[] = [];
  const transitions: Transition[] = [];
  const conflicts: PlannedConflict[] = [];
  const waiting: { taskId: string; waiting: Waiting }[] = [];
  const items: ItemNote[] = [];
  let linkedApple = 0;
  let linkedLfcp = 0;

  const reconcile = (link: LinkRow, task: LfcpTask, item: AppleItem) => {
    const pL = projectLfcp(task);
    const pA = projectApple(item, view.timeZone);
    const shadow = shadowOf(task);
    const values = lfcpValuesOf(task);
    const held = new Set(view.heldFields(task.id));
    const bases = view.bases.get(task.id);
    const toApple: Field[] = [];
    let set: WritableSet = {};
    const warnings: string[] = [];
    const toLfcp: Field[] = [];
    const overruled: Partial<Record<Field, unknown>> = {};
    const lfcpIntents: LfcpTaskIntent[] = [];
    const decide = (field: Field, decision: FieldDecision, extra: Partial<Decision> = {}) =>
      decisions.push({
        taskId: task.id,
        field,
        decision,
        lfcp: pL[field],
        apple: pA[field],
        ...extra,
      });
    const writeApple = (field: Field, w: AppleWrite, extra: Partial<Decision> = {}) => {
      if (w.kind === "conflict") {
        conflicts.push({ taskId: task.id, field, kind: w.conflict });
        decide(field, "conflict", extra);
        return;
      }
      if (view.openIntent(task.id, "to_apple")) {
        decide(field, "pending_intent", extra);
        return;
      }
      toApple.push(field);
      if (extra.appleValueLost === true) overruled[field] = pA[field];
      set = { ...set, ...w.set };
      warnings.push(...w.warnings);
      decide(field, "write_apple", extra);
    };
    const writeLfcp = (
      field: Field,
      its: readonly LfcpTaskIntent[],
      extra: Partial<Decision> = {},
    ) => {
      if (view.openIntent(task.id, "to_lfcp")) {
        decide(field, "pending_intent", extra);
        return;
      }
      toLfcp.push(field);
      lfcpIntents.push(...its);
      decide(field, "write_lfcp", extra);
    };
    for (const field of FIELDS) {
      if (held.has(field)) {
        decide(field, "held");
        continue;
      }
      if (link.statusLocked && (field === "status" || field === "due")) {
        decide(field, "status_locked");
        continue;
      }
      const base = bases?.get(field);
      if (field === "status") {
        // The status group: its own table (§4.4, r3 P2-2).
        const input: StatusInput = {
          pL: pL.status,
          sL: statusKind(task.status),
          pA: pA.status,
          ...(base === undefined
            ? {}
            : {
                base: {
                  lfcp: base.lfcpProj as StatusProjection,
                  sL: statusKind(typeof base.lfcpShadow === "string" ? base.lfcpShadow : "todo"),
                  apple: base.appleProj as StatusProjection,
                },
              }),
        };
        const row = statusRow(input);
        const act = row.action(input);
        const extra = { row: row.id, ...(row.appleOverruled ? { appleValueLost: true } : {}) };
        if (act.kind === "apple")
          writeApple(
            field,
            { kind: "set", set: { completed: act.completed }, warnings: [] },
            extra,
          );
        else if (act.kind === "lfcp_complete" || act.kind === "lfcp_reopen")
          writeLfcp(field, lfcpStatusWrite(task.id, act), extra);
        else if (row.id === "1") {
          if (base?.lfcpShadow !== undefined && base.lfcpShadow !== task.status)
            decide(field, "shadow", extra);
        } else decide(field, "bases", extra);
        continue;
      }
      const same = equivalent(field, pL[field], pA[field]);
      if (base === undefined) {
        // A first link: equivalent → bases; else LFCP wins (B14).
        if (same) decide(field, "bases");
        else
          writeApple(field, appleWrite(field, pL, item, view.timeZone), { appleValueLost: true });
        continue;
      }
      const dL = !sameProjection(field, pL[field], base.lfcpProj);
      const dA = !sameProjection(field, pA[field], base.appleProj);
      if (!dL && !dA) {
        if (
          field === "priority" &&
          base.lfcpShadow !== undefined &&
          base.lfcpShadow !== shadow.priority
        )
          decide(field, "shadow");
        continue;
      }
      if (same) decide(field, "bases");
      else if (dL && !dA) writeApple(field, appleWrite(field, pL, item, view.timeZone));
      else if (!dL && dA) writeLfcp(field, lfcpWrite(field, task.id, pA, values));
      else writeApple(field, appleWrite(field, pL, item, view.timeZone), { appleValueLost: true });
    }
    if (toApple.length > 0)
      intents.push({
        bindingId: b.id,
        taskId: task.id,
        installationId: b.installationId,
        direction: "to_apple",
        kind: "update",
        fields: toApple,
        basis: {
          rev: item.rev,
          pL: Object.fromEntries(toApple.map((f) => [f, pL[f]])),
          shadow,
          pA: Object.fromEntries(toApple.map((f) => [f, pA[f]])),
          ...(Object.keys(overruled).length === 0
            ? {}
            : { appleOverruled: overruled as Partial<Projections> }),
        },
        payload: { kind: "update", ref: ref(item), set, expect: { rev: item.rev } },
        warnings,
      });
    if (toLfcp.length > 0)
      intents.push({
        bindingId: b.id,
        taskId: task.id,
        installationId: b.installationId,
        direction: "to_lfcp",
        kind: "update_task",
        fields: toLfcp,
        basis: {
          rev: item.rev,
          pL: Object.fromEntries(toLfcp.map((f) => [f, pL[f]])),
          shadow,
          lfcp: values,
          pA: Object.fromEntries(toLfcp.map((f) => [f, pA[f]])),
          native: appleNative(item),
        },
        payload: { resource: b.section, intents: lfcpIntents },
        warnings: [],
      });
  };

  const unreadable = new Set(view.unreadable ?? []);
  const linkedTasks = new Set<string>();
  for (const link of view.links) {
    linkedTasks.add(link.taskId);
    if (unreadable.has(link.taskId)) {
      waiting.push({ taskId: link.taskId, waiting: "task_unreadable" });
      continue;
    }
    const lm = m.links.get(link.taskId) as LinkMatch;
    const task = tasks.get(link.taskId);
    const active = task?.lifecycle === "active";
    if (lm.kind === "ambiguous") {
      if (link.state !== "quarantine")
        transitions.push({ taskId: link.taskId, kind: "quarantine", reason: lm.reason });
      continue;
    }
    switch (link.state) {
      case "linked": {
        if (lm.kind === "matched") linkedApple++;
        if (!active) {
          if (view.lfcpLive) transitions.push({ taskId: link.taskId, kind: "task_gone" });
          else waiting.push({ taskId: link.taskId, waiting: "lfcp_not_live" });
          continue;
        }
        if (link.origin === "lfcp" && !filtered(task)) {
          if (view.lfcpLive) transitions.push({ taskId: link.taskId, kind: "out_of_filter" });
          else waiting.push({ taskId: link.taskId, waiting: "lfcp_not_live" });
          continue;
        }
        linkedLfcp++;
        if (lm.kind === "absent") {
          if (view.snapshot.complete)
            transitions.push({ taskId: link.taskId, kind: "apple_missing" });
          else waiting.push({ taskId: link.taskId, waiting: "apple_incomplete" });
          continue;
        }
        if (lm.kind !== "matched") continue;
        if (lm.ignore.length > 0)
          transitions.push({ taskId: link.taskId, kind: "ignore_copies", ignore: lm.ignore });
        if (lm.restoreUrl) items.push(note("restore_url", lm.item, { taskId: link.taskId }));
        if (lm.userReplaced && link.urlState !== "user_replaced")
          items.push(note("user_replaced", lm.item, { taskId: link.taskId }));
        reconcile(link, task as LfcpTask, lm.item);
        break;
      }
      case "out_of_filter":
      case "task_gone": {
        // Back: active and in the filter again (§6.1).
        if (!active || !filtered(task)) continue;
        if (lm.kind === "tombstone")
          transitions.push({ taskId: link.taskId, kind: "relink", item: ref(lm.item) });
        else if (view.snapshot.complete)
          transitions.push({ taskId: link.taskId, kind: "return_find" });
        else waiting.push({ taskId: link.taskId, waiting: "apple_incomplete" });
        break;
      }
      // pending_* are their intents' (PR 10/11); unlinked and quarantine wait for a person.
      default:
        break;
    }
  }

  // Pass 2 of matching: orphans, foreign reminders, new ones.
  const orphaned = new Set<string>();
  for (const o of m.items) {
    switch (o.kind) {
      case "orphan_link":
        orphaned.add(o.taskId);
        if (!linkedTasks.has(o.taskId))
          transitions.push({
            taskId: o.taskId,
            kind: "link_orphan",
            item: ref(o.item),
            ...(o.ignore.length === 0 ? {} : { ignore: o.ignore }),
          });
        break;
      case "orphan_quarantine":
        // A reminder of the Task exists: no new projection of it either.
        orphaned.add(o.taskId);
        items.push(note("orphan_quarantine", o.item, { taskId: o.taskId, reason: o.reason }));
        break;
      case "foreign_bridge":
        items.push(note("foreign_bridge", o.item));
        break;
      case "import":
        items.push(note("import", o.item, o.userReplaced ? { reason: "user_replaced" } : {}));
        break;
      case "import_blocked":
        items.push(note("import_blocked", o.item));
        break;
      case "ignore":
        items.push(note("ignore", o.item, { reason: o.reason }));
        break;
    }
  }

  // New projections: projectable Tasks with no link and no orphan reminder.
  for (const task of view.tasks) {
    if (linkedTasks.has(task.id) || orphaned.has(task.id)) continue;
    if (!projectable(task, b.filter, view.me)) continue;
    if (view.openIntent(task.id, "to_apple")) continue;
    // Absence in Apple is a conclusion: only from a complete snapshot (§5.3, review PR 8 #8).
    if (!view.snapshot.complete) {
      waiting.push({ taskId: task.id, waiting: "apple_incomplete" });
      continue;
    }
    const pL = projectLfcp(task);
    const fields: Field[] = ["title", "priority", ...(pL.due === null ? [] : (["due"] as const))];
    let set: WritableSet = {};
    for (const f of fields) {
      const w = appleWrite(f, pL, undefined, view.timeZone);
      if (w.kind === "set") set = { ...set, ...w.set };
    }
    intents.push({
      bindingId: b.id,
      taskId: task.id,
      installationId: b.installationId,
      direction: "to_apple",
      kind: "create",
      fields,
      // All four projections: finalize records the bases of all of them (a new reminder's
      // status is open, its due the one written or none).
      basis: { pL, shadow: shadowOf(task), lfcp: lfcpValuesOf(task) },
      payload: {
        kind: "create",
        list: b.list,
        linkUrl: taskLink(task.id, b.section, b.bridgeInstanceId),
        set,
      },
      warnings: [],
    });
  }

  const unlinkKinds = new Set<TransitionKind>(["task_gone", "out_of_filter", "apple_missing"]);
  return {
    bindingId: b.id,
    intents,
    decisions,
    transitions,
    conflicts,
    items,
    waiting,
    holds: m.holds,
    counts: {
      tasks: view.tasks.filter((t) => t.lifecycle === "active").length,
      inFilter: view.tasks.filter((t) => filtered(t)).length,
      reminders: view.snapshot.items.length,
      linked: view.links.filter((l) => l.state === "linked").length,
      linkedApple,
      linkedLfcp,
      creates: intents.filter((i) => i.kind === "create").length,
      updates: intents.filter((i) => i.kind === "update").length,
      imports: items.filter((i) => i.kind === "import").length,
      unlinks: transitions.filter((t) => unlinkKinds.has(t.kind)).length,
    },
  };
}
