// The schema of bridge.sqlite (D-010 §3) as ordered migrations over
// `PRAGMA user_version`, each with its way back (§3: "migrations by
// user_version forward and back"; the rollback of a bridge upgrade, runbook
// PR 14). Version N is the result of migrations 1..N; a migration runs in
// one transaction with its user_version.
//
// Version 1: the process and its guards: installations, bindings and their
// holds, the journal, runs (Safe Mode), meta.
// Version 2: the synchronisation state: links, bases, personal Apple data,
// conflicts, intents, bootstrap steps, transport state, N8 migrations.
// Version 3: runs and journal of r2. Version 4: N8 migration details.
// Version 5: a person's decisions on refused and quarantined intents.
//
// Beyond §3: STRICT tables, NOT NULL where a row has no meaning without the
// value, and foreign keys to installations and bindings (PRAGMA
// foreign_keys is on). Rows of one binding's synchronisation state (links,
// bases, personal data) are not tied to each other: their order of writing
// is the executor's (PR 7).

export interface Migration {
  /** The user_version after it. */
  readonly version: number;
  readonly name: string;
  readonly up: readonly string[];
  /** Back to version - 1: drops exactly what `up` created. */
  readonly down: readonly string[];
}

const V1_RUNS = `CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT
    ) STRICT`;

const V1_JOURNAL = `CREATE TABLE journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      level TEXT NOT NULL CHECK (level IN ('debug','info','warn','error')),
      kind TEXT NOT NULL,
      binding_id TEXT,
      run_id TEXT,
      message TEXT NOT NULL,
      data_json TEXT
    ) STRICT`;

const V1: Migration = {
  version: 1,
  name: "process, bindings, holds, journal",
  up: [
    `CREATE TABLE installations (
      id TEXT PRIMARY KEY,
      dir TEXT NOT NULL,
      principal TEXT NOT NULL,
      root TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','frozen','retired','revoked')),
      status_detail TEXT,
      retired_at TEXT,
      revoked_at TEXT
    ) STRICT`,
    `CREATE TABLE bindings (
      id TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL REFERENCES installations(id),
      resource_id TEXT NOT NULL,
      adapter TEXT NOT NULL,
      transport TEXT NOT NULL,
      target_ref TEXT,
      target_title TEXT,
      filter_mode TEXT NOT NULL DEFAULT 'default' CHECK (filter_mode IN ('default','mine','all')),
      verification INTEGER NOT NULL DEFAULT 0 CHECK (verification IN (0,1)),
      state TEXT NOT NULL CHECK (state IN ('bootstrapping','pending_dry_run','active','removed')),
      bootstrap_step TEXT CHECK (bootstrap_step IN ('scan','list','marker','done')),
      marker_ref TEXT,
      approved_at TEXT,
      approved_plan_run_id TEXT,
      strict_until TEXT,
      created_at TEXT NOT NULL
    ) STRICT`,
    `CREATE UNIQUE INDEX one_binding_per_section ON bindings(resource_id, adapter) WHERE state <> 'removed'`,
    `CREATE UNIQUE INDEX one_binding_per_list ON bindings(transport, target_ref) WHERE state <> 'removed'`,
    `CREATE TABLE binding_holds (
      binding_id TEXT NOT NULL REFERENCES bindings(id),
      reason TEXT NOT NULL,
      since TEXT NOT NULL,
      detail_json TEXT,
      PRIMARY KEY (binding_id, reason)
    ) STRICT, WITHOUT ROWID`,
    V1_RUNS,
    V1_JOURNAL,
    `CREATE INDEX journal_by_binding ON journal(binding_id, id)`,
    `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID`,
  ],
  down: [
    "DROP TABLE meta",
    "DROP INDEX journal_by_binding",
    "DROP TABLE journal",
    "DROP TABLE runs",
    "DROP TABLE binding_holds",
    "DROP INDEX one_binding_per_list",
    "DROP INDEX one_binding_per_section",
    "DROP TABLE bindings",
    "DROP TABLE installations",
  ],
};

const V2: Migration = {
  version: 2,
  name: "synchronisation state",
  up: [
    `CREATE TABLE links (
      binding_id TEXT NOT NULL REFERENCES bindings(id),
      task_id TEXT NOT NULL,
      rem_url TEXT,
      rem_external_id TEXT,
      rem_id_cache TEXT,
      rem_title_snapshot TEXT,
      origin TEXT NOT NULL CHECK (origin IN ('lfcp','apple')),
      state TEXT NOT NULL CHECK (state IN ('pending_apple_create','pending_lfcp_create','linked',
        'out_of_filter','task_gone','unlinked','quarantine')),
      state_reason TEXT,
      url_state TEXT NOT NULL DEFAULT 'ours' CHECK (url_state IN ('ours','missing','user_replaced')),
      status_locked INTEGER NOT NULL DEFAULT 0 CHECK (status_locked IN (0,1)),
      ignored_external_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (binding_id, task_id)
    ) STRICT, WITHOUT ROWID`,
    `CREATE TABLE bases (
      binding_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      field TEXT NOT NULL,
      lfcp_proj_json TEXT,
      lfcp_shadow_json TEXT,
      apple_proj_json TEXT,
      apple_native_json TEXT,
      intent_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (binding_id, task_id, field)
    ) STRICT, WITHOUT ROWID`,
    `CREATE TABLE apple_personal (
      binding_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      due_time TEXT,
      due_tz TEXT,
      alarms_json TEXT,
      has_notes INTEGER NOT NULL DEFAULT 0 CHECK (has_notes IN (0,1)),
      has_recurrence INTEGER NOT NULL DEFAULT 0 CHECK (has_recurrence IN (0,1)),
      rev TEXT,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (binding_id, task_id)
    ) STRICT, WITHOUT ROWID`,
    `CREATE TABLE conflicts (
      id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL REFERENCES bindings(id),
      task_id TEXT NOT NULL,
      field TEXT NOT NULL,
      kind TEXT NOT NULL,
      lfcp_json TEXT,
      apple_json TEXT,
      intent_id TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolution TEXT
    ) STRICT`,
    `CREATE TABLE intents (
      id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL REFERENCES bindings(id),
      task_id TEXT NOT NULL,
      installation_id TEXT NOT NULL REFERENCES installations(id),
      direction TEXT NOT NULL CHECK (direction IN ('to_apple','to_lfcp')),
      kind TEXT NOT NULL,
      fields_json TEXT NOT NULL,
      basis_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('prepared','effecting','applied','finalized',
        'superseded','refused','quarantined')),
      state_reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_at TEXT,
      last_error_json TEXT,
      result_json TEXT,
      batch_status TEXT,
      accepted_unit_ids_json TEXT,
      created_at TEXT NOT NULL,
      effected_at TEXT,
      finalized_at TEXT
    ) STRICT`,
    `CREATE UNIQUE INDEX one_open_intent ON intents(binding_id, task_id, direction)
      WHERE state IN ('prepared','effecting','applied')`,
    `CREATE TABLE bootstrap_ops (
      binding_id TEXT NOT NULL REFERENCES bindings(id),
      step TEXT NOT NULL,
      client_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('prepared','effecting','done','unknown_outcome')),
      result_json TEXT,
      PRIMARY KEY (binding_id, step)
    ) STRICT, WITHOUT ROWID`,
    `CREATE TABLE transport_state (
      transport TEXT NOT NULL,
      installation_key TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      PRIMARY KEY (transport, installation_key, key)
    ) STRICT, WITHOUT ROWID`,
    `CREATE TABLE migrations (
      id TEXT PRIMARY KEY,
      from_installation TEXT NOT NULL REFERENCES installations(id),
      to_installation TEXT REFERENCES installations(id),
      phase TEXT NOT NULL CHECK (phase IN ('pairing','freezing','catching_up','switching',
        'switched','closing','awaiting_revocation','done','aborted')),
      blocked_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT`,
  ],
  down: [
    "DROP TABLE migrations",
    "DROP TABLE transport_state",
    "DROP TABLE bootstrap_ops",
    "DROP INDEX one_open_intent",
    "DROP TABLE intents",
    "DROP TABLE conflicts",
    "DROP TABLE apple_personal",
    "DROP TABLE bases",
    "DROP TABLE links",
  ],
};

// Version 3: runs and journal as D-010 r2 §3 defines them (r4 keeps "as in
// r2"). runs are the process's starts (kind 'process', Safe Mode §2.3) and
// the passes (kind 'dry' / 'apply', with their plan: `approve` refers to a
// dry run by id). The journal is for people: its text comes from the
// message key, with parameters (r2 §2.4). The data of version 2 is kept:
// a process run's pid goes to stats_json; a journal entry's text, data and
// run go to params_json.
const V3: Migration = {
  version: 3,
  name: "runs and journal of r2",
  up: [
    "ALTER TABLE runs RENAME TO runs_v2",
    `CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('process','dry','apply')),
      binding_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      outcome TEXT,
      stats_json TEXT,
      plan_json TEXT
    ) STRICT`,
    `INSERT INTO runs (id, kind, binding_id, started_at, ended_at, outcome, stats_json)
       SELECT id, 'process', NULL, started_at, ended_at, end_reason, json_object('pid', pid) FROM runs_v2`,
    "DROP TABLE runs_v2",
    "CREATE INDEX runs_by_binding ON runs(binding_id, started_at)",
    "DROP INDEX journal_by_binding",
    "ALTER TABLE journal RENAME TO journal_v2",
    `CREATE TABLE journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      level TEXT NOT NULL CHECK (level IN ('debug','info','warn','error')),
      binding_id TEXT,
      task_id TEXT,
      key TEXT NOT NULL,
      params_json TEXT
    ) STRICT`,
    `INSERT INTO journal (id, ts, level, binding_id, task_id, key, params_json)
       SELECT id, at, level, binding_id, NULL, kind,
         json_object('text', message, 'data', CASE WHEN data_json IS NULL THEN NULL ELSE json(data_json) END, 'run', run_id)
       FROM journal_v2`,
    "DROP TABLE journal_v2",
    "CREATE INDEX journal_by_binding ON journal(binding_id, id)",
  ],
  down: [
    "DROP INDEX runs_by_binding",
    "ALTER TABLE runs RENAME TO runs_v3",
    V1_RUNS,
    `INSERT INTO runs (id, pid, started_at, ended_at, end_reason)
       SELECT id, coalesce(json_extract(stats_json, '$.pid'), 0), started_at, ended_at, outcome
       FROM runs_v3 WHERE kind = 'process'`,
    "DROP TABLE runs_v3",
    "DROP INDEX journal_by_binding",
    "ALTER TABLE journal RENAME TO journal_v3",
    V1_JOURNAL,
    `INSERT INTO journal (id, at, level, kind, binding_id, run_id, message, data_json)
       SELECT id, ts, level, key, binding_id, json_extract(params_json, '$.run'),
         coalesce(json_extract(params_json, '$.text'), key), json_extract(params_json, '$.data')
       FROM journal_v3`,
    "DROP TABLE journal_v3",
    "CREATE INDEX journal_by_binding ON journal(binding_id, id)",
  ],
};

// Version 4: what N8 (§9 r4, PR 13) keeps besides the phase of a migration:
// the sections asked for, when the old installation was frozen (the catch-up
// must be LIVE on a connection opened after it) and why it ended, if it was
// aborted. The phase stays in migrations.phase, a blocked state in
// migrations.blocked_reason: three separate things.
const V4: Migration = {
  version: 4,
  name: "N8 migration details",
  up: [
    `CREATE TABLE migration_details (
      migration_id TEXT PRIMARY KEY REFERENCES migrations(id),
      sections_json TEXT NOT NULL,
      frozen_at TEXT,
      aborted_reason TEXT
    ) STRICT, WITHOUT ROWID`,
  ],
  down: ["DROP TABLE migration_details"],
};

// Version 5: a person's decision on a refused or quarantined intent, durable.
// Until it exists the intent waits for a person: N8 counts it against
// quiescence (§9 r4 "no refused, no quarantine"; review PR 13 P2-2) — no
// conflict, or a resolved one, does not prove it was looked at.
const V5: Migration = {
  version: 5,
  name: "intent resolutions",
  up: [
    `CREATE TABLE intent_resolutions (
      intent_id TEXT PRIMARY KEY REFERENCES intents(id),
      resolution TEXT NOT NULL,
      resolved_at TEXT NOT NULL
    ) STRICT, WITHOUT ROWID`,
  ],
  down: ["DROP TABLE intent_resolutions"],
};

/** Every migration, in order. */
export const MIGRATIONS: readonly Migration[] = Object.freeze([V1, V2, V3, V4, V5]);

/** The schema version this build writes. */
export const SCHEMA_VERSION = MIGRATIONS.length;
