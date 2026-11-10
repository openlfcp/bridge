// Runs and Safe Mode (D-010 §2.2, §7.3; r2 §2.3): each `run` writes a
// process row (runs.kind 'process') first thing, and closes it when it ends. A row still open at the next start is a
// crash. Two crashed runs in a row, started less than 10 minutes apart, put
// the bridge into Safe Mode: no effect runs until `resume --safe-mode-off`.

import type { BridgeDatabase } from "../db/database.js";
import { Journal } from "../db/journal.js";
import { ulid } from "./intents.js";

export const SAFE_MODE_WINDOW_MS = 10 * 60_000;

export interface SafeModeState {
  readonly since: string;
  readonly reason: string;
}

const KEY = "safe_mode";

export class Runs {
  constructor(
    private readonly db: BridgeDatabase,
    private readonly now: () => number = Date.now,
    private readonly pid: number = process.pid,
  ) {}

  /**
   * A start: the runs left open are closed as crashed, Safe Mode is entered
   * when the last two runs crashed less than 10 minutes apart, and this run
   * is recorded. Returns its id and whether Safe Mode is on.
   */
  start(): { readonly runId: string; readonly safeMode: SafeModeState | undefined } {
    const now = this.now();
    const iso = new Date(now).toISOString();
    return this.db
      .transaction(() => {
        this.db
          .prepare(
            "UPDATE runs SET ended_at = ?, outcome = 'crashed' WHERE kind = 'process' AND ended_at IS NULL",
          )
          .run(iso);
        const last = this.db
          .prepare(
            "SELECT started_at, outcome FROM runs WHERE kind = 'process' ORDER BY started_at DESC, id DESC LIMIT 2",
          )
          .all() as { started_at: string; outcome: string | null }[];
        if (
          this.safeMode() === undefined &&
          last.length === 2 &&
          last.every((r) => r.outcome === "crashed") &&
          Date.parse(last[0]?.started_at ?? "") - Date.parse(last[1]?.started_at ?? "") <
            SAFE_MODE_WINDOW_MS
        ) {
          const state: SafeModeState = { since: iso, reason: "two crashed runs within 10 minutes" };
          this.db
            .prepare(
              "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            )
            .run(KEY, JSON.stringify(state));
          new Journal(this.db, this.now).append("error", "safe_mode.on", {
            params: { runs: last },
          });
        }
        const runId = ulid(now);
        this.db
          .prepare(
            "INSERT INTO runs (id, kind, started_at, stats_json) VALUES (?, 'process', ?, ?)",
          )
          .run(runId, iso, JSON.stringify({ pid: this.pid }));
        return { runId, safeMode: this.safeMode() };
      })
      .immediate();
  }

  /** A clean end of `runId`. */
  end(runId: string, reason = "exit"): void {
    this.db
      .prepare("UPDATE runs SET ended_at = ?, outcome = ? WHERE id = ? AND ended_at IS NULL")
      .run(new Date(this.now()).toISOString(), reason, runId);
  }

  safeMode(): SafeModeState | undefined {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(KEY) as
      | { value: string }
      | undefined;
    return r === undefined ? undefined : (JSON.parse(r.value) as SafeModeState);
  }

  /** `resume --safe-mode-off`. */
  safeModeOff(): boolean {
    const off = this.db.prepare("DELETE FROM meta WHERE key = ?").run(KEY).changes === 1;
    if (off) new Journal(this.db, this.now).append("info", "safe_mode.off");
    return off;
  }
}
