// The quarantine (D-010 r4 §2.1 `quarantine`, §5.4, §5.7, B19): what waits for a person, and their
// decisions. Three kinds:
//
// - unknown_outcome: a write to Reminders whose answer was lost (§5.7). The intent is quarantined
//   with field conflicts; those fields of the Task are not written either way until resolved.
//     accept — "the write happened; take Reminders as it is": the intent is finalized as if its
//       payload was written (bases: LFCP as planned, Reminders as written). The next pass then
//       sees what Reminders really shows: equal → nothing; different (the write did not happen,
//       or the person edited since) → Reminders' value goes to LFCP.
//     redo — "write it again from LFCP" (the design's `drop`): the intent ends; the next pass
//       plans the fields again from the bases, so a value Reminders lacks is written anew under a
//       new opKey (never the old one, B19).
//   A create or restore_url has no field values to take: accept is redo (the next pass finds the
//   reminder by its link URL if it was made — no duplicate — and makes it otherwise).
// - ambiguous_match: a link in state quarantine (several reminders claim the Task, §5.4).
//     link <reminder> <task> — this one is the Task's; the other candidates are ignored.
//     ignore <reminder> <task> — this one is not; the next pass matches again.
// - import_ambiguous: the hold (§6.2) — a pending import's reminder is not found. Listed with its
//   pending imports; the design names no finer decision than accepting the hold.
//
// Every decision is journaled (quarantine.resolved) and, for an intent, recorded in
// intent_resolutions (what N8's quiescence reads).

import type {
  AppleItem,
  AppleOpSuccess,
  FindQuery,
  RemindersTransport,
  WritableSet,
  WrittenFields,
} from "@openlfcp/bridge-reminders";
import type { BridgeDatabase } from "./db/database.js";
import type { Journal } from "./db/journal.js";
import type { IntentHandler } from "./executor/executor.js";
import { type Intent, Intents } from "./executor/intents.js";

export type QuarantineKind = "unknown_outcome" | "ambiguous_match" | "import_ambiguous";

export interface QuarantineEntry {
  readonly kind: QuarantineKind;
  /** What the commands take: the intent (unknown_outcome), the Task (ambiguous_match), the binding. */
  readonly id: string;
  readonly bindingId: string;
  readonly taskId?: string;
  readonly taskTitle?: string;
  readonly reminder?: { readonly id?: string; readonly title?: string };
  /** RFC 3339 UTC. */
  readonly since: string;
  /** unknown_outcome: the fields held; ambiguous_match: the reason; import_ambiguous: pending imports. */
  readonly detail?: string;
}

const json = (s: string | null | undefined): unknown => {
  if (s === null || s === undefined) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Everything in quarantine (of one binding), oldest first within a kind. */
export function quarantined(db: BridgeDatabase, bindingId?: string): QuarantineEntry[] {
  const out: QuarantineEntry[] = [];
  const of = bindingId === undefined ? "" : " AND binding_id = ?";
  const args = bindingId === undefined ? [] : [bindingId];
  const intents = db
    .prepare(
      `SELECT id, binding_id, task_id, fields_json, basis_json, payload_json, created_at FROM intents
        WHERE state = 'quarantined' AND state_reason = 'unknown_outcome'
          AND id NOT IN (SELECT intent_id FROM intent_resolutions)${of} ORDER BY id`,
    )
    .all(...args) as {
    id: string;
    binding_id: string;
    task_id: string;
    fields_json: string;
    basis_json: string;
    payload_json: string;
    created_at: string;
  }[];
  for (const i of intents) {
    const c = db
      .prepare(
        "SELECT min(created_at) AS since, max(apple_json) AS apple FROM conflicts WHERE intent_id = ? AND kind = 'unknown_outcome'",
      )
      .get(i.id) as { since: string | null; apple: string | null };
    const basis = json(i.basis_json) as { pL?: { title?: unknown } } | undefined;
    const payload = json(i.payload_json) as
      | { kind?: string; ref?: { id?: unknown }; set?: { title?: unknown } }
      | undefined;
    const item = json(c.apple) as { title?: unknown; ref?: { id?: unknown } } | undefined;
    const title = str(basis?.pL?.title) ?? str(payload?.set?.title);
    const reminderId = str(payload?.ref?.id) ?? str(item?.ref?.id);
    const reminderTitle = str(item?.title);
    out.push({
      kind: "unknown_outcome",
      id: i.id,
      bindingId: i.binding_id,
      taskId: i.task_id,
      ...(title === undefined ? {} : { taskTitle: title }),
      ...(reminderId === undefined && reminderTitle === undefined
        ? {}
        : {
            reminder: {
              ...(reminderId === undefined ? {} : { id: reminderId }),
              ...(reminderTitle === undefined ? {} : { title: reminderTitle }),
            },
          }),
      since: c.since ?? i.created_at,
      detail: `${payload?.kind ?? "write"} of ${(json(i.fields_json) as string[] | undefined)?.join(", ") ?? "?"}`,
    });
  }
  const links = db
    .prepare(
      `SELECT binding_id, task_id, rem_id_cache, rem_title_snapshot, state_reason, updated_at FROM links
        WHERE state = 'quarantine'${of} ORDER BY updated_at`,
    )
    .all(...args) as {
    binding_id: string;
    task_id: string;
    rem_id_cache: string | null;
    rem_title_snapshot: string | null;
    state_reason: string | null;
    updated_at: string;
  }[];
  for (const l of links)
    out.push({
      kind: "ambiguous_match",
      id: l.task_id,
      bindingId: l.binding_id,
      taskId: l.task_id,
      ...(l.rem_title_snapshot === null ? {} : { taskTitle: l.rem_title_snapshot }),
      ...(l.rem_id_cache === null ? {} : { reminder: { id: l.rem_id_cache } }),
      since: l.updated_at,
      detail: l.state_reason ?? "ambiguous",
    });
  const holds = db
    .prepare(
      `SELECT binding_id, since FROM binding_holds WHERE reason = 'import_ambiguous'${of} ORDER BY since`,
    )
    .all(...args) as { binding_id: string; since: string }[];
  for (const h of holds) {
    const pending = db
      .prepare(
        "SELECT rem_title_snapshot FROM links WHERE binding_id = ? AND state = 'pending_lfcp_create' ORDER BY created_at",
      )
      .all(h.binding_id) as { rem_title_snapshot: string | null }[];
    out.push({
      kind: "import_ambiguous",
      id: h.binding_id,
      bindingId: h.binding_id,
      since: h.since,
      detail: `pending imports: ${pending.map((p) => `"${p.rem_title_snapshot ?? "?"}"`).join(", ") || "none"}`,
    });
  }
  return out;
}

/** Quarantined items per binding (status). */
export function quarantineCounts(db: BridgeDatabase): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const e of quarantined(db)) counts.set(e.bindingId, (counts.get(e.bindingId) ?? 0) + 1);
  return counts;
}

/** The commands that resolve an entry (exact, ready to paste). */
export function resolveCommands(e: QuarantineEntry): string[] {
  switch (e.kind) {
    case "unknown_outcome":
      return [`lfcp-bridge quarantine accept ${e.id}`, `lfcp-bridge quarantine redo ${e.id}`];
    case "ambiguous_match":
      return [
        `lfcp-bridge quarantine link <reminder> ${e.id}`,
        `lfcp-bridge quarantine ignore <reminder> ${e.id}`,
      ];
    case "import_ambiguous":
      return [`lfcp-bridge resume --accept import_ambiguous --binding ${e.bindingId}`];
  }
}

export type Resolution =
  | { readonly kind: "resolved"; readonly text: string }
  | { readonly kind: "refused"; readonly text: string };

/** The quarantined unknown outcome `id`, still unresolved; a refusal otherwise. */
function unknownOutcome(db: BridgeDatabase, id: string): Intent | string {
  const i = new Intents(db).get(id);
  if (i === undefined) return `no intent ${id}`;
  if (i.state !== "quarantined" || i.stateReason !== "unknown_outcome")
    return `intent ${id} is ${i.state}${i.stateReason ? ` (${i.stateReason})` : ""}, not an unknown outcome`;
  const done = db.prepare("SELECT 1 FROM intent_resolutions WHERE intent_id = ?").get(id);
  if (done !== undefined) return `intent ${id} is resolved already`;
  return i;
}

/** What an update's `set` stored, as the helper reports it (`written`). */
function writtenOf(set: WritableSet): WrittenFields {
  return {
    ...(set.title === undefined ? {} : { title: set.title }),
    ...(set.dueDate === undefined ? {} : { dueDate: set.dueDate }),
    ...(set.priority === undefined ? {} : { priority: set.priority }),
    ...(set.completed === undefined
      ? {}
      : {
          completed: {
            value: set.completed.value,
            ...(set.completed.date === undefined ? {} : { completionDate: set.completed.date }),
          },
        }),
  };
}

function resolveConflicts(db: BridgeDatabase, intentId: string, resolution: string, at: string) {
  db.prepare(
    "UPDATE conflicts SET resolved_at = ?, resolution = ? WHERE intent_id = ? AND resolved_at IS NULL",
  ).run(at, resolution, intentId);
}

/** `accept`: the write happened, Reminders as it is (see the header). */
export function acceptOutcome(
  db: BridgeDatabase,
  id: string,
  o: { readonly handler: IntentHandler; readonly journal: Journal; readonly now?: () => number },
): Resolution {
  const i = unknownOutcome(db, id);
  if (typeof i === "string") return { kind: "refused", text: i };
  if (i.direction !== "to_apple" || i.kind !== "update") return redo(db, i, "accept", o);
  const at = new Date((o.now ?? Date.now)()).toISOString();
  const p = i.payload as { ref: { id: string; externalId?: string }; set: WritableSet };
  const result: AppleOpSuccess = {
    ok: true,
    opKey: i.id,
    ref: p.ref,
    rev: "",
    written: writtenOf(p.set),
  };
  const intents = new Intents(db, o.now);
  db.transaction(() => {
    intents.resolve(i.id, "accept");
    db.prepare(
      "UPDATE intents SET state = 'applied', state_reason = NULL, result_json = ? WHERE id = ?",
    ).run(JSON.stringify(result), i.id);
    o.handler.finalize(intents.get(i.id) as Intent, result, db);
    intents.finalized(i.id);
    resolveConflicts(db, i.id, "accept", at);
    o.journal.append("info", "quarantine.resolved", {
      bindingId: i.bindingId,
      taskId: i.taskId,
      params: { intent: i.id, choice: "accept", fields: i.fields.join(", ") },
    });
  }).immediate();
  return {
    kind: "resolved",
    text: `accepted: ${i.fields.join(", ")} recorded as written; the next pass compares with what Reminders shows (a difference goes to LFCP)`,
  };
}

/** `redo`: write it again from LFCP (see the header). */
export function redoOutcome(
  db: BridgeDatabase,
  id: string,
  o: { readonly journal: Journal; readonly now?: () => number },
): Resolution {
  const i = unknownOutcome(db, id);
  if (typeof i === "string") return { kind: "refused", text: i };
  return redo(db, i, "redo", o);
}

function redo(
  db: BridgeDatabase,
  i: Intent,
  choice: "redo" | "accept",
  o: { readonly journal: Journal; readonly now?: () => number },
): Resolution {
  const at = new Date((o.now ?? Date.now)()).toISOString();
  db.transaction(() => {
    new Intents(db, o.now).resolve(i.id, choice);
    resolveConflicts(db, i.id, choice, at);
    o.journal.append("info", "quarantine.resolved", {
      bindingId: i.bindingId,
      taskId: i.taskId,
      params: { intent: i.id, choice, fields: i.fields.join(", ") },
    });
  }).immediate();
  return {
    kind: "resolved",
    text:
      i.kind === "update"
        ? `redo: the next pass plans ${i.fields.join(", ")} again from LFCP (a new write if Reminders lacks it)`
        : `${choice}: the next pass finds the reminder by its link if the ${i.kind} happened, and writes it otherwise`,
  };
}

/** The reminders that claim the Task of a quarantined link: by its link URL, external id, id. */
export async function candidates(
  db: BridgeDatabase,
  transport: Pick<RemindersTransport, "find">,
  taskId: string,
): Promise<{ readonly items: readonly AppleItem[]; readonly complete: boolean }> {
  const l = db
    .prepare(
      "SELECT rem_external_id, rem_id_cache FROM links WHERE task_id = ? AND state = 'quarantine'",
    )
    .get(taskId) as { rem_external_id: string | null; rem_id_cache: string | null } | undefined;
  const queries: FindQuery[] = [{ urlPrefix: `lfcp://task/${taskId}?` }];
  if (l?.rem_external_id) queries.push({ externalId: l.rem_external_id });
  if (l?.rem_id_cache) queries.push({ id: l.rem_id_cache });
  const byId = new Map<string, AppleItem>();
  let complete = true;
  for (const q of queries) {
    const r = await transport.find(q, "all");
    complete &&= r.complete;
    for (const i of r.items) byId.set(i.ref.id, i);
  }
  return { items: [...byId.values()], complete };
}

/** The quarantined link of `taskId`, or a refusal. */
function quarantinedLink(db: BridgeDatabase, taskId: string) {
  const l = db
    .prepare(
      "SELECT binding_id, ignored_external_ids_json FROM links WHERE task_id = ? AND state = 'quarantine'",
    )
    .get(taskId) as { binding_id: string; ignored_external_ids_json: string } | undefined;
  return l ?? `no link of Task ${taskId} in quarantine`;
}

/** `link <reminder> <task>`: this reminder is the Task's; the other candidates are ignored. */
export async function linkReminder(
  db: BridgeDatabase,
  transport: Pick<RemindersTransport, "find">,
  reminderId: string,
  taskId: string,
  o: { readonly journal: Journal; readonly now?: () => number },
): Promise<Resolution> {
  const l = quarantinedLink(db, taskId);
  if (typeof l === "string") return { kind: "refused", text: l };
  const c = await candidates(db, transport, taskId);
  if (!c.complete)
    return { kind: "refused", text: "Reminders could not be searched completely; try again" };
  const chosen = c.items.find((i) => i.ref.id === reminderId || i.ref.externalId === reminderId);
  if (chosen === undefined)
    return {
      kind: "refused",
      text: `${reminderId} is not a candidate of Task ${taskId} (lfcp-bridge quarantine lists them)`,
    };
  const others = c.items.filter((i) => i !== chosen);
  const noExternal = others.filter((i) => i.ref.externalId === undefined);
  if (noExternal.length > 0)
    return {
      kind: "refused",
      text: `another candidate (${noExternal.map((i) => i.ref.id).join(", ")}) cannot be ignored (no external id); remove it from the list in Reminders, then link`,
    };
  const at = new Date((o.now ?? Date.now)()).toISOString();
  const ignored = new Set([
    ...(JSON.parse(l.ignored_external_ids_json) as string[]),
    ...others.map((i) => i.ref.externalId as string),
  ]);
  db.transaction(() => {
    db.prepare(
      `UPDATE links SET state = 'linked', state_reason = NULL, rem_id_cache = ?, rem_external_id = ?,
         rem_title_snapshot = coalesce(rem_title_snapshot, ?), ignored_external_ids_json = ?, updated_at = ?
       WHERE binding_id = ? AND task_id = ? AND state = 'quarantine'`,
    ).run(
      chosen.ref.id,
      chosen.ref.externalId ?? null,
      chosen.title,
      JSON.stringify([...ignored]),
      at,
      l.binding_id,
      taskId,
    );
    o.journal.append("info", "quarantine.resolved", {
      bindingId: l.binding_id,
      taskId,
      params: { choice: "link", reminder: chosen.ref.id, ignored: others.length },
    });
  }).immediate();
  return {
    kind: "resolved",
    text: `linked: "${chosen.title}" is the Task's reminder${others.length > 0 ? `; ${others.length} other(s) ignored` : ""}`,
  };
}

/** `ignore <reminder> <task>`: this one is not the Task's; the next pass matches again. */
export async function ignoreReminder(
  db: BridgeDatabase,
  transport: Pick<RemindersTransport, "find">,
  reminderId: string,
  taskId: string,
  o: { readonly journal: Journal; readonly now?: () => number },
): Promise<Resolution> {
  const l = quarantinedLink(db, taskId);
  if (typeof l === "string") return { kind: "refused", text: l };
  const c = await candidates(db, transport, taskId);
  const item = c.items.find((i) => i.ref.id === reminderId || i.ref.externalId === reminderId);
  if (item === undefined)
    return {
      kind: "refused",
      text: `${reminderId} is not a candidate of Task ${taskId} (lfcp-bridge quarantine lists them)`,
    };
  if (item.ref.externalId === undefined)
    return {
      kind: "refused",
      text: `${reminderId} cannot be ignored (no external id); remove it from the list in Reminders`,
    };
  const at = new Date((o.now ?? Date.now)()).toISOString();
  const ignored = new Set([
    ...(JSON.parse(l.ignored_external_ids_json) as string[]),
    item.ref.externalId,
  ]);
  db.transaction(() => {
    // Back to linked: the next pass matches the Task again without it (quarantine again if still
    // several claim it).
    db.prepare(
      `UPDATE links SET state = 'linked', state_reason = NULL, ignored_external_ids_json = ?, updated_at = ?
       WHERE binding_id = ? AND task_id = ? AND state = 'quarantine'`,
    ).run(JSON.stringify([...ignored]), at, l.binding_id, taskId);
    o.journal.append("info", "quarantine.resolved", {
      bindingId: l.binding_id,
      taskId,
      params: { choice: "ignore", reminder: item.ref.id },
    });
  }).immediate();
  return {
    kind: "resolved",
    text: `ignored: "${item.title}" is not the Task's; the next pass matches the Task again`,
  };
}

/** For a person: a reminder id, shortened. */
export const shortId = (id: string | undefined) =>
  id === undefined ? "?" : id.length > 10 ? `${id.slice(0, 8)}…` : id;
