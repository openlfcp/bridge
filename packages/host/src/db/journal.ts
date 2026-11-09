// The journal of the bridge (D-010 §2.1 `log`, §7): what happened, for a
// person and for diagnostics, in bridge.sqlite. Entries are appended, never
// changed; `kind` is a stable machine name, `message` the text for people.
// No secrets and no Task contents beyond what the person sees anyway.

import type { BridgeDatabase } from "./database.js";

export type JournalLevel = "debug" | "info" | "warn" | "error";

export interface JournalEntry {
  readonly id: number;
  /** RFC 3339 UTC. */
  readonly at: string;
  readonly level: JournalLevel;
  readonly kind: string;
  readonly bindingId?: string;
  readonly runId?: string;
  readonly message: string;
  readonly data?: unknown;
}

export interface JournalFilter {
  readonly bindingId?: string;
  readonly minLevel?: JournalLevel;
  /** Entries after this id (follow). */
  readonly afterId?: number;
  /** The newest `limit` entries (default 100), returned oldest first. */
  readonly limit?: number;
}

const RANK: Readonly<Record<JournalLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

interface Row {
  id: number;
  at: string;
  level: JournalLevel;
  kind: string;
  binding_id: string | null;
  run_id: string | null;
  message: string;
  data_json: string | null;
}

export class Journal {
  constructor(
    private readonly db: BridgeDatabase,
    private readonly now: () => number = Date.now,
    private readonly runId?: string,
  ) {}

  /** Appends one entry; returns its id. */
  append(
    level: JournalLevel,
    kind: string,
    message: string,
    extra: { readonly bindingId?: string; readonly data?: unknown } = {},
  ): number {
    if (!(level in RANK)) throw new RangeError(`unknown journal level ${level}`);
    const r = this.db
      .prepare(
        `INSERT INTO journal (at, level, kind, binding_id, run_id, message, data_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date(this.now()).toISOString(),
        level,
        kind,
        extra.bindingId ?? null,
        this.runId ?? null,
        message,
        extra.data === undefined ? null : JSON.stringify(extra.data),
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
    const rows = this.db
      .prepare(
        `SELECT * FROM journal ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
         ORDER BY id DESC LIMIT ?`,
      )
      .all(...args, filter.limit ?? 100) as Row[];
    return rows.reverse().map((r) =>
      Object.freeze({
        id: r.id,
        at: r.at,
        level: r.level,
        kind: r.kind,
        ...(r.binding_id === null ? {} : { bindingId: r.binding_id }),
        ...(r.run_id === null ? {} : { runId: r.run_id }),
        message: r.message,
        ...(r.data_json === null ? {} : { data: JSON.parse(r.data_json) as unknown }),
      }),
    );
  }
}
