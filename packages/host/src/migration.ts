// N8 (D-010 r4 §9, B17 P1-1): `sections add <name>` moves every binding of an installation to a
// new one whose pairing covers the old sections and the new one — only from quiescence.
//
//   (precondition) the old installation is quiescent (quiescence() below), else refused with the list
//   pairing        a new pairing (scope = old ∪ new); refused → aborted
//   (freezing)     ONE immediate transaction of bridge.sqlite: quiescence checked again, the hold
//                  `migration` on every binding of the old installation, the old one `frozen`,
//                  frozen_at recorded, phase catching_up. Not quiescent (work appeared during the
//                  pairing) → nothing of the freeze stays: aborted(not_quiescent), the new
//                  installation retired, the old one works on. The executor takes intents only
//                  through this database, so none can appear between the check and the hold.
//                  There is no persisted `freezing` or `quiescent` phase (r4).
//   catching_up    each Resource of the old bindings is LIVE for the new installation on a
//                  connection opened after frozen_at (fresh LIVE); after 24 h blocked_reason is
//                  set, the phase stays
//   switching →    one transaction: bindings.installation_id := new, the old installation retired
//   switched
//   closing        the old SyncClient closed, the hold `migration` lifted, a full reconcile asked
//   awaiting_revocation  the person revokes the old device; revocationStatus = revocation-proven
//                  → the old installation revoked, done
//
// abort is allowed before switching (the new installation retired, its directory stays; the old
// one active again, the holds lifted); after it only forward. `migrate resume` continues from the
// stored phase. The phase, blocked_reason and aborted_reason are kept apart.

import { randomUUID } from "node:crypto";
import type { BridgeDatabase } from "./db/database.js";
import { Holds } from "./db/holds.js";
import type { Journal } from "./db/journal.js";
import type { RevocationVerdict } from "./lfcp/access.js";

export type MigrationPhase =
  | "pairing"
  | "catching_up"
  | "switching"
  | "switched"
  | "closing"
  | "awaiting_revocation"
  | "done"
  | "aborted";

/** Why an installation is not quiescent (each with how many). */
export type NotQuiescent =
  | "open_intents"
  | "unfinished_batches"
  | "open_conflicts"
  | "quarantine"
  | "open_migration";

export interface Quiescence {
  readonly quiescent: boolean;
  readonly reasons: readonly { readonly reason: NotQuiescent; readonly count: number }[];
}

export interface NewInstallation {
  readonly id: string;
  readonly dir: string;
  readonly principal: string;
  readonly root: string;
  readonly label: string;
}

/** What one Resource looks like for the new installation, as its SectionHost says. */
export interface CatchUpState {
  readonly resourceId: string;
  /** lfcp_live now. */
  readonly live: boolean;
  /** When the connection it is LIVE on was opened (RFC 3339 UTC). */
  readonly connectedAt?: string;
}

/** The machine around the migration (the run process; tests pass fakes). */
export interface MigrationPorts {
  /**
   * A new pairing whose scope is the old installation's sections ∪ `sections` (the ones added);
   * undefined when the person refused it.
   */
  pair(req: {
    readonly from: string;
    readonly sections: readonly string[];
  }): Promise<NewInstallation | undefined>;
  /** Opens the Resources for the new installation (idempotent) and says where each one is. */
  catchUp(installationId: string, resourceIds: readonly string[]): Promise<readonly CatchUpState[]>;
  /** Closes the SyncClient of the old installation. */
  closeOld(installationId: string): Promise<void>;
  /** Asks for a full reconcile of these bindings. */
  reconcile?(bindingIds: readonly string[]): void;
  /** revocationStatus of the old installation's device. */
  revocationStatus(installationId: string): Promise<RevocationVerdict>;
}

export interface MigrationRow {
  readonly id: string;
  readonly from: string;
  readonly to: string | null;
  readonly phase: MigrationPhase;
  readonly blockedReason: string | null;
  readonly abortedReason: string | null;
  readonly sections: readonly string[];
  readonly frozenAt: string | null;
}

export type SectionsAddOutcome =
  | { readonly state: "refused"; readonly reasons: Quiescence["reasons"]; readonly detail?: string }
  | { readonly state: "started"; readonly migration: MigrationRow };

export const CATCH_UP_LIMIT_MS = 24 * 60 * 60_000;

const OPEN_PHASES = [
  "pairing",
  "catching_up",
  "switching",
  "switched",
  "closing",
  "awaiting_revocation",
];

/**
 * Whether the installation is quiescent (§9 precondition): no open intent (prepared, effecting,
 * applied), every batch to LFCP final (accepted or a no-op), no open conflict (lfcp_rejected and
 * lfcp_partial included: a refused batch leaves one; unknown_outcome quarantine leaves one too), no
 * link in quarantine, and no other migration under way.
 */
export function quiescence(db: BridgeDatabase, installationId: string): Quiescence {
  const count = (sql: string) => (db.prepare(sql).get(installationId) as { n: number }).n;
  const of = "SELECT id FROM bindings WHERE installation_id = ? AND state <> 'removed'";
  const counts: [NotQuiescent, number][] = [
    [
      "open_intents",
      count(
        `SELECT count(*) AS n FROM intents WHERE installation_id = ? AND state IN ('prepared','effecting','applied')`,
      ),
    ],
    [
      "unfinished_batches",
      count(
        `SELECT count(*) AS n FROM intents WHERE installation_id = ? AND direction = 'to_lfcp'
           AND state = 'finalized' AND coalesce(batch_status, '') NOT IN ('accepted','noop')`,
      ),
    ],
    [
      "open_conflicts",
      count(
        `SELECT count(*) AS n FROM conflicts WHERE resolved_at IS NULL AND binding_id IN (${of})`,
      ),
    ],
    [
      "quarantine",
      count(`SELECT count(*) AS n FROM links WHERE state = 'quarantine' AND binding_id IN (${of})`),
    ],
    [
      "open_migration",
      count(
        `SELECT count(*) AS n FROM migrations WHERE from_installation = ? AND phase IN (${OPEN_PHASES.map((p) => `'${p}'`).join(",")})`,
      ),
    ],
  ];
  const reasons = counts.filter(([, n]) => n > 0).map(([reason, n]) => ({ reason, count: n }));
  return { quiescent: reasons.length === 0, reasons };
}

export interface MigrationDeps {
  readonly db: BridgeDatabase;
  readonly journal: Journal;
  readonly ports: MigrationPorts;
  readonly now?: () => number;
  /** Called between the precondition and the freeze (tests: work appears during the pairing). */
  readonly afterPairing?: () => void;
}

export class Migrations {
  readonly #d: MigrationDeps;
  readonly #now: () => number;

  constructor(deps: MigrationDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
  }

  #iso(): string {
    return new Date(this.#now()).toISOString();
  }

  get(id: string): MigrationRow | undefined {
    const r = this.#d.db
      .prepare(
        `SELECT m.id, m.from_installation, m.to_installation, m.phase, m.blocked_reason,
                d.sections_json, d.frozen_at, d.aborted_reason
           FROM migrations m LEFT JOIN migration_details d ON d.migration_id = m.id WHERE m.id = ?`,
      )
      .get(id) as
      | {
          id: string;
          from_installation: string;
          to_installation: string | null;
          phase: MigrationPhase;
          blocked_reason: string | null;
          sections_json: string | null;
          frozen_at: string | null;
          aborted_reason: string | null;
        }
      | undefined;
    if (r === undefined) return undefined;
    return {
      id: r.id,
      from: r.from_installation,
      to: r.to_installation,
      phase: r.phase,
      blockedReason: r.blocked_reason,
      abortedReason: r.aborted_reason,
      sections: JSON.parse(r.sections_json ?? "[]") as string[],
      frozenAt: r.frozen_at,
    };
  }

  /** Every migration, newest first. */
  list(): MigrationRow[] {
    return (
      this.#d.db.prepare("SELECT id FROM migrations ORDER BY created_at DESC, id DESC").all() as {
        id: string;
      }[]
    ).map((r) => this.get(r.id) as MigrationRow);
  }

  /** The migration under way, if any. */
  open(): MigrationRow | undefined {
    return this.list().find((m) => OPEN_PHASES.includes(m.phase));
  }

  /**
   * `sections add <name>`: refused unless `from` is quiescent and active; otherwise the
   * migration starts and runs as far as it can (see advance).
   */
  async add(from: string, sections: readonly string[]): Promise<SectionsAddOutcome> {
    const inst = this.#d.db.prepare("SELECT status FROM installations WHERE id = ?").get(from) as
      | { status: string }
      | undefined;
    if (inst?.status !== "active")
      return { state: "refused", reasons: [], detail: `installation ${from} is not active` };
    const open = this.open();
    if (open !== undefined)
      return {
        state: "refused",
        reasons: [{ reason: "open_migration", count: 1 }],
        detail: `migration ${open.id} is ${open.phase}`,
      };
    const q = quiescence(this.#d.db, from);
    if (!q.quiescent) return { state: "refused", reasons: q.reasons };
    const id = `m_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const now = this.#iso();
    this.#d.db.transaction(() => {
      this.#d.db
        .prepare(
          "INSERT INTO migrations (id, from_installation, phase, created_at, updated_at) VALUES (?, ?, 'pairing', ?, ?)",
        )
        .run(id, from, now, now);
      this.#d.db
        .prepare("INSERT INTO migration_details (migration_id, sections_json) VALUES (?, ?)")
        .run(id, JSON.stringify(sections));
    })();
    this.#d.journal.append("info", "migration.started", {
      params: { text: `N8 migration ${id} started from installation ${from}.`, migration: id },
    });
    return { state: "started", migration: await this.advance(id) };
  }

  /** Runs the migration from its stored phase as far as it can go now (`migrate resume`). */
  async advance(id: string): Promise<MigrationRow> {
    for (;;) {
      const m = this.get(id);
      if (m === undefined) throw new Error(`no migration ${id}`);
      const next = await this.#step(m);
      if (!next) return this.get(id) as MigrationRow;
    }
  }

  /** abort (before switching only): the new installation retired, the old one active again. */
  abort(id: string, reason = "person"): MigrationRow {
    // The phase is read under the write lock: a resume in another process that moved it to
    // switching meanwhile wins, and this abort is refused (review PR 13 P1-2).
    this.#d.db
      .transaction(() => {
        const m = this.get(id);
        if (m === undefined) throw new Error(`no migration ${id}`);
        if (m.phase !== "pairing" && m.phase !== "catching_up")
          throw new MigrationError(
            m.phase === "aborted" || m.phase === "done"
              ? `migration ${id} is ${m.phase}`
              : `migration ${id} is ${m.phase}: after switching only forward (migrate resume)`,
          );
        this.#abortIn(m, reason);
      })
      .immediate();
    this.#d.journal.append("warn", "migration.aborted", {
      params: { text: `N8 migration ${id} aborted (${reason}).`, migration: id, reason },
    });
    return this.get(id) as MigrationRow;
  }

  // ---------- steps; true when the phase moved and the next one may run now ----------

  async #step(m: MigrationRow): Promise<boolean> {
    switch (m.phase) {
      case "pairing":
        return this.#pairing(m);
      case "catching_up":
        return this.#catchingUp(m);
      case "switching":
      case "switched":
        return this.#switch(m);
      case "closing":
        return this.#closing(m);
      case "awaiting_revocation":
        return this.#awaitingRevocation(m);
      default:
        return false;
    }
  }

  async #pairing(m: MigrationRow): Promise<boolean> {
    let to = m.to;
    if (to === null) {
      const paired = await this.#d.ports.pair({ from: m.from, sections: m.sections });
      if (paired === undefined) {
        if (this.get(m.id)?.phase === "pairing") this.abort(m.id, "pairing_refused");
        return false;
      }
      // A late answer (the migration was aborted meanwhile) moves nothing; the installation it
      // made is recorded retired, so nothing uses it (review PR 13 P1-2).
      const current = this.#d.db
        .transaction((): boolean => {
          const now = this.#iso();
          const live = this.get(m.id);
          const ok = live?.phase === "pairing" && live.to === null;
          this.#d.db
            .prepare(
              `INSERT INTO installations (id, dir, principal, root, label, created_at, status, status_detail, retired_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              paired.id,
              paired.dir,
              paired.principal,
              paired.root,
              paired.label,
              now,
              ok ? "active" : "retired",
              ok ? null : `N8 ${m.id}: paired after the migration ended`,
              ok ? null : now,
            );
          if (ok)
            this.#d.db
              .prepare("UPDATE migrations SET to_installation = ?, updated_at = ? WHERE id = ?")
              .run(paired.id, now, m.id);
          return ok;
        })
        .immediate();
      if (!current) return false;
      to = paired.id;
    }
    this.#d.afterPairing?.();
    return this.#freeze({ ...m, to });
  }

  /** The atomic freeze (B17 P1-1): quiescence again and the hold in one immediate transaction. */
  #freeze(m: MigrationRow): boolean {
    const db = this.#d.db;
    const outcome = db
      .transaction((): Quiescence | "stale" => {
        // Still this migration's turn (an abort may have come meanwhile, review PR 13 P1-2)?
        if (this.get(m.id)?.phase !== "pairing") return "stale";
        // Only an active installation is frozen: a revoked or retired one stays as it is
        // (review PR 13 P2-1).
        const status = (
          db.prepare("SELECT status FROM installations WHERE id = ?").get(m.from) as
            | { status: string }
            | undefined
        )?.status;
        if (status !== "active") {
          this.#abortIn(m, `installation_${status ?? "missing"}`);
          return { quiescent: false, reasons: [] };
        }
        const q = quiescence(db, m.from);
        // The migration itself is the one open migration of `from`: not a reason here.
        const reasons = q.reasons.filter((r) => r.reason !== "open_migration" || r.count > 1);
        if (reasons.length > 0) {
          this.#abortIn(
            m,
            `not_quiescent: ${reasons.map((r) => `${r.reason} ${r.count}`).join(", ")}`,
          );
          return { quiescent: false, reasons };
        }
        const holds = new Holds(db, this.#now);
        for (const b of this.#bindingsOf(m.from))
          holds.set(b, "migration", { migration: m.id, to: m.to });
        const now = this.#iso();
        db.prepare(
          "UPDATE installations SET status = 'frozen', status_detail = ? WHERE id = ?",
        ).run(`N8 ${m.id}`, m.from);
        db.prepare("UPDATE migration_details SET frozen_at = ? WHERE migration_id = ?").run(
          now,
          m.id,
        );
        db.prepare("UPDATE migrations SET phase = 'catching_up', updated_at = ? WHERE id = ?").run(
          now,
          m.id,
        );
        return { quiescent: true, reasons: [] };
      })
      .immediate();
    if (outcome === "stale") return false;
    if (!outcome.quiescent && outcome.reasons.length === 0) {
      this.#d.journal.append("warn", "migration.aborted", {
        params: {
          text: `N8 migration ${m.id} aborted: installation ${m.from} is no longer active.`,
          migration: m.id,
          reason: this.get(m.id)?.abortedReason ?? "installation_not_active",
        },
      });
      return false;
    }
    if (!outcome.quiescent) {
      this.#d.journal.append("warn", "migration.aborted", {
        params: {
          text: `N8 migration ${m.id} aborted: work appeared during the pairing (${outcome.reasons
            .map((r) => r.reason)
            .join(", ")}). Run sections add again later.`,
          migration: m.id,
          reason: "not_quiescent",
        },
      });
      return false;
    }
    this.#d.journal.append("info", "migration.frozen", {
      params: { text: `Installation ${m.from} frozen for N8 migration ${m.id}.`, migration: m.id },
    });
    return true;
  }

  async #catchingUp(m: MigrationRow): Promise<boolean> {
    const to = m.to as string;
    const frozenAt = m.frozenAt as string;
    const resources = [
      ...new Set(
        (
          this.#d.db
            .prepare(
              "SELECT resource_id FROM bindings WHERE installation_id = ? AND state <> 'removed'",
            )
            .all(m.from) as { resource_id: string }[]
        ).map((r) => r.resource_id),
      ),
    ];
    const states = await this.#d.ports.catchUp(to, resources);
    const fresh = (r: string) =>
      states.some(
        (s) =>
          s.resourceId === r &&
          s.live &&
          s.connectedAt !== undefined &&
          Date.parse(s.connectedAt) > Date.parse(frozenAt),
      );
    if (resources.every(fresh)) {
      // Only if it is still catching up: an abort while catchUp ran wins (review PR 13 P1-2).
      return (
        this.#d.db
          .prepare(
            "UPDATE migrations SET phase = 'switching', blocked_reason = NULL, updated_at = ? WHERE id = ? AND phase = 'catching_up'",
          )
          .run(this.#iso(), m.id).changes === 1
      );
    }
    if (this.#now() - Date.parse(frozenAt) > CATCH_UP_LIMIT_MS && m.blockedReason === null) {
      const waiting = resources.filter((r) => !fresh(r));
      const set = this.#d.db
        .prepare(
          "UPDATE migrations SET blocked_reason = ?, updated_at = ? WHERE id = ? AND phase = 'catching_up'",
        )
        .run(`catch_up_over_24h: ${waiting.join(", ")}`, this.#iso(), m.id);
      if (set.changes === 0) return false;
      this.#d.journal.append("warn", "migration.blocked", {
        params: {
          text: `N8 migration ${m.id}: the new installation is not live after 24 h (${waiting.length} sections). Check the connection, or migrate abort.`,
          migration: m.id,
        },
      });
    }
    return false;
  }

  /** switching → switched: one transaction, idempotent. */
  #switch(m: MigrationRow): boolean {
    const db = this.#d.db;
    const moved = db
      .transaction((): boolean => {
        const phase = this.get(m.id)?.phase;
        if (phase !== "switching" && phase !== "switched") return false;
        const now = this.#iso();
        db.prepare(
          "UPDATE bindings SET installation_id = ? WHERE installation_id = ? AND state <> 'removed'",
        ).run(m.to, m.from);
        db.prepare(
          "UPDATE installations SET status = 'retired', retired_at = coalesce(retired_at, ?) WHERE id = ? AND status <> 'revoked'",
        ).run(now, m.from);
        db.prepare("UPDATE migrations SET phase = 'closing', updated_at = ? WHERE id = ?").run(
          now,
          m.id,
        );
        return true;
      })
      .immediate();
    if (!moved) return false;
    this.#d.journal.append("info", "migration.switched", {
      params: {
        text: `N8 migration ${m.id}: the bindings now use installation ${m.to}.`,
        migration: m.id,
      },
    });
    return true;
  }

  async #closing(m: MigrationRow): Promise<boolean> {
    await this.#d.ports.closeOld(m.from);
    const bindings = this.#bindingsOf(m.to as string);
    const moved = this.#d.db
      .transaction((): boolean => {
        if (this.get(m.id)?.phase !== "closing") return false;
        const holds = new Holds(this.#d.db, this.#now);
        for (const b of bindings) holds.lift(b, "migration");
        this.#d.db
          .prepare(
            "UPDATE migrations SET phase = 'awaiting_revocation', updated_at = ? WHERE id = ?",
          )
          .run(this.#iso(), m.id);
        return true;
      })
      .immediate();
    if (!moved) return false;
    this.#d.ports.reconcile?.(bindings);
    this.#d.journal.append("info", "migration.revoke_old", {
      params: {
        text: `N8 migration ${m.id}: revoke the old device (installation ${m.from}) in the plugin; the bridge waits for the proof.`,
        migration: m.id,
      },
    });
    return true;
  }

  async #awaitingRevocation(m: MigrationRow): Promise<boolean> {
    const verdict = await this.#d.ports.revocationStatus(m.from);
    if (verdict !== "revocation-proven") return false;
    const moved = this.#d.db
      .transaction((): boolean => {
        if (this.get(m.id)?.phase !== "awaiting_revocation") return false;
        const now = this.#iso();
        this.#d.db
          .prepare("UPDATE installations SET status = 'revoked', revoked_at = ? WHERE id = ?")
          .run(now, m.from);
        this.#d.db
          .prepare("UPDATE migrations SET phase = 'done', updated_at = ? WHERE id = ?")
          .run(now, m.id);
        return true;
      })
      .immediate();
    if (!moved) return false;
    this.#d.journal.append("info", "migration.done", {
      params: {
        text: `N8 migration ${m.id} done; the old installation is revoked.`,
        migration: m.id,
      },
    });
    return false;
  }

  // ---------- rows ----------

  #bindingsOf(installation: string): string[] {
    return (
      this.#d.db
        .prepare("SELECT id FROM bindings WHERE installation_id = ? AND state <> 'removed'")
        .all(installation) as { id: string }[]
    ).map((r) => r.id);
  }

  /** Inside a transaction: the migration aborted, the new installation retired, the old one active. */
  #abortIn(m: MigrationRow, reason: string): void {
    const db = this.#d.db;
    const now = this.#iso();
    const to = m.to ?? this.get(m.id)?.to ?? null;
    if (to !== null)
      db.prepare(
        "UPDATE installations SET status = 'retired', retired_at = coalesce(retired_at, ?), status_detail = ? WHERE id = ? AND status = 'active'",
      ).run(now, `N8 ${m.id} aborted`, to);
    // Back to active only what this migration froze (review PR 13 P2-1).
    db.prepare(
      "UPDATE installations SET status = 'active', status_detail = NULL WHERE id = ? AND status = 'frozen' AND status_detail = ?",
    ).run(m.from, `N8 ${m.id}`);
    const holds = new Holds(db, this.#now);
    for (const b of this.#bindingsOf(m.from)) holds.lift(b, "migration");
    db.prepare("UPDATE migration_details SET aborted_reason = ? WHERE migration_id = ?").run(
      reason,
      m.id,
    );
    db.prepare(
      "UPDATE migrations SET phase = 'aborted', blocked_reason = NULL, updated_at = ? WHERE id = ?",
    ).run(now, m.id);
  }
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}
