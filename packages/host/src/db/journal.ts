// The journal of the bridge (D-010 §2.1 `log`, r2 §2.4): what happened, for
// a person, in bridge.sqlite. Entries are appended, never changed. An entry
// is a message key and its parameters (r2 §3 `journal(id, ts, level,
// binding_id, task_id, key, params_json)`); the text a person reads comes
// from the key (JOURNAL_TEXT), so it can be worded again or translated
// without touching what was recorded. No secrets, no Task contents beyond
// what the person sees anyway.

import type { BridgeDatabase } from "./database.js";

export type JournalLevel = "debug" | "info" | "warn" | "error";

export type JournalParams = Readonly<Record<string, unknown>>;

export interface JournalEntry {
  readonly id: number;
  /** RFC 3339 UTC. */
  readonly ts: string;
  readonly level: JournalLevel;
  /** The message key: a stable machine name. */
  readonly key: string;
  readonly bindingId?: string;
  readonly taskId?: string;
  readonly params?: JournalParams;
  /** The text for a person, from the key (JOURNAL_TEXT). */
  readonly text: string;
}

export interface JournalFilter {
  readonly bindingId?: string;
  readonly minLevel?: JournalLevel;
  /** The first `limit` entries after this id (a page forward: follow). */
  readonly afterId?: number;
  /** At most this many (default 100); without afterId the newest ones. Oldest first. */
  readonly limit?: number;
}

/** The texts of the message keys; a key without one shows as itself. */
export const JOURNAL_TEXT: Readonly<Record<string, (p: JournalParams) => string>> = {
  "effect.off": () => "An effect would run here (effects are off in this build)",
  "effect.lost": () => "The answer of a write to Reminders was lost",
  "effect.in_flight": () => "A write to Reminders is already under way; not repeated",
  "field.apple_overruled": (p) =>
    `Changed on both sides: the shared task's ${String(p.field ?? "")} was kept; your Reminders value was ${String(p.apple ?? "")}`,
  "link.out_of_filter": () =>
    "The task left this list's filter (reassigned or no due date): the reminder stays with you and is no longer synchronized",
  "link.task_gone": () =>
    "The task was deleted in the shared section: the reminder stays with you and is no longer synchronized",
  "link.unlinked": (p) =>
    p.reason === "moved_out"
      ? "You moved the reminder to another list: it is no longer synchronized (the task stays shared)"
      : "You deleted the reminder: the task stays shared and does not come back to this list",
  "link.relinked": () =>
    "The task is back in this list's filter: synchronized with its reminder again",
  "link.reprojected": () =>
    "The task is back in this list's filter and its old reminder is gone: a new one will be made",
  "link.quarantine": (p) =>
    `Which reminder belongs to the task is not clear (${String(p.reason ?? "")}): decide in \`lfcp-bridge quarantine\``,
  "link.status_locked": () =>
    "The reminder repeats: its completion and due date are not synchronized while it does",
  "link.status_unlocked": () =>
    "The reminder no longer repeats: completion and due are synchronized again",
  "hold.import_ambiguous": () =>
    "A reminder being imported cannot be found any more: new reminders are not imported until you decide (lfcp-bridge quarantine)",
  "hold.foreign_bridge": () =>
    "Another bridge's reminders are in this list: synchronization stopped (lfcp-bridge doctor)",
  "intent.stale": (p) =>
    `A planned write was dropped: the task's link changed meanwhile (${String(p.reason ?? "")}); it is planned again`,
  "link.user_replaced": () =>
    "You put your own link on the reminder: the bridge keeps it and never puts its own back",
  "helper.unmatched": () =>
    "The Reminders helper said something that answers no request (logged for diagnosis)",
  "fault.armed": (p) =>
    `Fault injection is on for this run (${String(p.fault ?? "")}): the next write of a verification binding will lose its answer`,
  "fault.injected": (p) =>
    `Fault injection: the answer of ${String(p.op ?? "")} (opKey ${String(p.opKey ?? "")}) was dropped after the helper ${p.answered ? "saved it" : "refused it"}, and the helper was killed`,
  "helper.reconnect_failed": (p) =>
    `The Reminders helper came back but could not be reconnected: ${String(p.error ?? "")}`,
  "effect.refused": (p) => `Reminders refused a write: ${String(p.code ?? "")}`,
  "intent.unknown_outcome": () =>
    "Whether a write to Reminders happened is not known: decide in `lfcp-bridge quarantine`",
  "intent.invalid": (p) =>
    `An intent did not match its binding and was refused: ${String(p.detail ?? "")}`,
  "intent.field_quarantined": (p) =>
    `Not written: ${String(p.fields ?? "")} waits for a decision in \`lfcp-bridge quarantine\``,
  "guard.limit": (p) =>
    `Stopped: more changes than a person makes (${String(p.holds ?? "")}). Usually the filter got narrower or the list became unavailable — not that you deleted these tasks`,
  "safe_mode.on": () => "Safe Mode: the bridge crashed twice at start",
  "safe_mode.off": () => "Safe Mode turned off",
  "delivery.rejected": () => "LFCP refused a change made from Reminders",
  "delivery.partial": () => "LFCP accepted only part of a change made from Reminders",
};

const RANK: Readonly<Record<JournalLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

interface Row {
  id: number;
  ts: string;
  level: JournalLevel;
  binding_id: string | null;
  task_id: string | null;
  key: string;
  params_json: string | null;
}

/** The text of an entry: its key's, or (an entry of schema version 2) the text it was written with. */
function textOf(key: string, params: JournalParams | undefined): string {
  const t = JOURNAL_TEXT[key];
  if (t !== undefined) return t(params ?? {});
  return typeof params?.text === "string" ? params.text : key;
}

export class Journal {
  constructor(
    private readonly db: BridgeDatabase,
    private readonly now: () => number = Date.now,
    /** The process run, recorded in each entry's parameters. */
    private readonly runId?: string,
  ) {}

  /** Appends one entry; returns its id. */
  append(
    level: JournalLevel,
    key: string,
    extra: {
      readonly bindingId?: string;
      readonly taskId?: string;
      readonly params?: JournalParams;
    } = {},
  ): number {
    if (!(level in RANK)) throw new RangeError(`unknown journal level ${level}`);
    const params =
      this.runId === undefined ? extra.params : { ...(extra.params ?? {}), run: this.runId };
    const r = this.db
      .prepare(
        `INSERT INTO journal (ts, level, binding_id, task_id, key, params_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date(this.now()).toISOString(),
        level,
        extra.bindingId ?? null,
        extra.taskId ?? null,
        key,
        params === undefined ? null : JSON.stringify(params),
      );
    return Number(r.lastInsertRowid);
  }

  list(filter: JournalFilter = {}): readonly JournalEntry[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.bindingId !== undefined) {
      where.push("binding_id = ?");
      args.push(filter.bindingId);
    }
    if (filter.minLevel !== undefined) {
      const levels = (Object.keys(RANK) as JournalLevel[]).filter(
        (l) => RANK[l] >= RANK[filter.minLevel as JournalLevel],
      );
      where.push(`level IN (${levels.map(() => "?").join(", ")})`);
      args.push(...levels);
    }
    if (filter.afterId !== undefined) {
      where.push("id > ?");
      args.push(filter.afterId);
    }
    // With a cursor: the first `limit` entries after it (a page forward, `log --follow`).
    // Without: the newest `limit` entries (the start of `log`). Both oldest first.
    const forward = filter.afterId !== undefined;
    const rows = this.db
      .prepare(
        `SELECT * FROM journal ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
         ORDER BY id ${forward ? "ASC" : "DESC"} LIMIT ?`,
      )
      .all(...args, filter.limit ?? 100) as Row[];
    if (!forward) rows.reverse();
    return rows.map((r) => {
      const params =
        r.params_json === null ? undefined : (JSON.parse(r.params_json) as JournalParams);
      return Object.freeze({
        id: r.id,
        ts: r.ts,
        level: r.level,
        key: r.key,
        ...(r.binding_id === null ? {} : { bindingId: r.binding_id }),
        ...(r.task_id === null ? {} : { taskId: r.task_id }),
        ...(params === undefined ? {} : { params }),
        text: textOf(r.key, params),
      });
    });
  }
}
