// bridge.sqlite (D-010 §3): opening, durability settings and schema
// migrations over `PRAGMA user_version`.
//
// - WAL with synchronous=FULL: a committed transaction is on disk (as the
//   storage-node database of each installation is).
// - foreign_keys on, a busy timeout for the CLI next to `run`.
// - open() migrates up to SCHEMA_VERSION; a database from a newer bridge is
//   refused (SchemaTooNewError), never touched. migrateTo() goes either
//   way, one migration per transaction with its user_version, so a failure
//   leaves the last complete version.

import Database from "better-sqlite3";
import { MIGRATIONS, type Migration, SCHEMA_VERSION } from "./schema.js";

export type BridgeDatabase = Database.Database;

/** The database was written by a newer bridge: this build does not know its schema. */
export class SchemaTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `bridge.sqlite has schema version ${found}; this build knows up to ${supported}. ` +
        "Run the newer lfcp-bridge, or migrate down with it first.",
    );
    this.name = "SchemaTooNewError";
  }
}

export interface OpenOptions {
  /** Default MIGRATIONS (tests pass their own). */
  readonly migrations?: readonly Migration[];
  /** Open without migrating (the runbook's inspection, tests). */
  readonly migrate?: boolean;
  readonly busyTimeoutMs?: number;
}

/** The schema version of an open database. */
export function schemaVersion(db: BridgeDatabase): number {
  return db.pragma("user_version", { simple: true }) as number;
}

/**
 * Moves the schema to `target`, up or down, one migration per transaction.
 * Returns the versions it went through (after each step).
 */
export function migrateTo(
  db: BridgeDatabase,
  target: number,
  migrations: readonly Migration[] = MIGRATIONS,
): number[] {
  const latest = migrations.length;
  if (!Number.isInteger(target) || target < 0 || target > latest)
    throw new RangeError(`no schema version ${target} (0..${latest})`);
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migration ${m.name} is out of order`);
  });
  const current = schemaVersion(db);
  if (current > latest) throw new SchemaTooNewError(current, latest);
  const steps: number[] = [];
  const run = (statements: readonly string[], version: number) =>
    db.transaction(() => {
      for (const sql of statements) db.exec(sql);
      db.pragma(`user_version = ${version}`);
    })();
  for (let v = current; v < target; v++) {
    run((migrations[v] as Migration).up, v + 1);
    steps.push(v + 1);
  }
  for (let v = current; v > target; v--) {
    run((migrations[v - 1] as Migration).down, v - 1);
    steps.push(v - 1);
  }
  return steps;
}

/** Opens (creating if needed) bridge.sqlite at `path`, migrated to the latest schema. */
export function openBridgeDatabase(path: string, options: OpenOptions = {}): BridgeDatabase {
  const migrations = options.migrations ?? MIGRATIONS;
  const db = new Database(path);
  try {
    // Read-only pragmas first: a database of a newer bridge is refused before
    // anything (journal_mode = WAL rewrites the header) touches the file.
    db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
    const found = schemaVersion(db);
    if (found > migrations.length) throw new SchemaTooNewError(found, migrations.length);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    if (options.migrate !== false) migrateTo(db, migrations.length, migrations);
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

export { MIGRATIONS, SCHEMA_VERSION };
