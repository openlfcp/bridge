// Export diagnostics (A§11, E20): a zip a person sends to support themselves, built by a
// versioned allow-list, `diag-schema v1`. What is collected is named here field by field —
// versions, counters, states, codes, ids — and nothing else is read: no pairing links, keys or
// DEKs, no intent payloads or evidence, no field values, no raw crash reports (crash.ts keeps
// signatures only). Then the whole tree is sealed: every string is replaced by
// `h:` + HMAC-SHA-256(k, value)[0..8] unless its key is allow-listed as plain and the value has
// that key's form (a code, an id, a time). Titles, URLs, paths and error texts are never plain.
// The key k is random per export and zeroed after it, never written: two exports of the same
// state share no HMAC value, and no export can be matched to another by them.

import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, join } from "node:path";
import { crc32 } from "node:zlib";
import type { BridgeConfig } from "../config.js";
import type { BridgeDatabase } from "../db/database.js";
import { stopState } from "../db/stop.js";
import { crashSignatures, FRAME } from "./crash.js";
import { CODE } from "./errors.js";

export const DIAG_SCHEMA = "diag-schema";
export const DIAG_SCHEMA_VERSION = 1;
export const DIAG_FILE = "diagnostics.json";
export const JOURNAL_ENTRIES = 500;
export const INTENTS = 200;
export const RUNS = 20;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A value of an enumerated column (CHECK in the schema): `active`, `to_apple`, `warn`. */
const WORD = /^[a-z][a-z0-9_]{0,31}$/;
const WORD_OR_CODE = new RegExp(`${WORD.source}|${CODE.source}`);
const TIME = /^\d{4}-\d{2}-\d{2}T[\d:.]{8,12}Z$/;
const VERSION = /^[A-Za-z0-9._+-]{1,32}$/;

/** The keys whose strings may stay plain, each with the form its value must have. */
const PLAIN: Readonly<Record<string, RegExp>> = {
  schema: CODE,
  createdAt: TIME,
  since: TIME,
  ts: TIME,
  startedAt: TIME,
  endedAt: TIME,
  bridge: VERSION,
  node: VERSION,
  os: VERSION,
  arch: WORD,
  helper: VERSION,
  macOS: VERSION,
  level: WORD,
  key: CODE,
  code: CODE,
  state: WORD,
  stateReason: WORD_OR_CODE,
  outcome: WORD,
  direction: WORD,
  kind: WORD,
  holds: WORD,
  process: /^[\w .-]{1,32}$/,
  exception: CODE,
  frames: FRAME,
  id: ID,
  bindingId: ID,
  taskId: ID,
  intent: ID,
};

/** Every string sealed: plain only at an allow-listed key and in that key's form. */
export function seal(value: unknown, key: Buffer, at = ""): unknown {
  if (typeof value === "string") {
    const form = PLAIN[at];
    if (form?.test(value) === true) return value;
    return `h:${createHmac("sha256", key).update(value).digest("hex").slice(0, 16)}`;
  }
  if (Array.isArray(value)) return value.map((v) => seal(v, key, at));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, seal(v, key, k)]));
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return null;
}

export interface DiagnosticsSource {
  readonly db: BridgeDatabase;
  readonly home: string;
  readonly config: BridgeConfig;
  readonly version: string;
  /** macOS's crash reports (~/Library/Logs/DiagnosticReports); only our processes' are read. */
  readonly reports?: string;
  /** The bindings that need attention, with their A§7.3 codes (E-043). */
  readonly needsAttention?: () => readonly { readonly bindingId: string; readonly code: string }[];
  /** A§9.1 (E-051) and A§9.4 (E-050); null and false until those come. */
  readonly artifactSliceId?: () => string | null;
  readonly certTestMode?: () => boolean;
  readonly now?: () => number;
}

type Row = Record<string, unknown>;

function counts(db: BridgeDatabase, sql: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of db.prepare(sql).all() as { k: string; n: number }[]) out[r.k] = r.n;
  return out;
}

function json(text: unknown): Row | undefined {
  try {
    const v = typeof text === "string" ? (JSON.parse(text) as unknown) : undefined;
    return typeof v === "object" && v !== null ? (v as Row) : undefined;
  } catch {
    return undefined;
  }
}

/** A journal entry's code: the first machine token among its code, reason and choice. */
function codeOf(p: Row | undefined): string | null {
  for (const k of ["code", "reason", "choice"]) {
    const v = p?.[k];
    if (typeof v === "string" && CODE.test(v)) return v;
  }
  return null;
}

/** The allow-listed tree of diag-schema v1, not yet sealed. */
export function collect(s: DiagnosticsSource): Row {
  const db = s.db;
  const safeMode = json(
    (db.prepare("SELECT value FROM meta WHERE key = 'safe_mode'").get() as Row | undefined)?.value,
  );
  const holds = db.prepare("SELECT binding_id, reason FROM binding_holds").all() as Row[];
  const bindings = (
    db
      .prepare(
        "SELECT id, state, target_title, verification FROM bindings WHERE state <> 'removed' ORDER BY id",
      )
      .all() as Row[]
  ).map((b) => ({
    id: b.id,
    state: b.state,
    title: b.target_title,
    verification: b.verification === 1,
    holds: holds.filter((h) => h.binding_id === b.id).map((h) => h.reason),
  }));
  const intents = (
    db
      .prepare(
        `SELECT id, binding_id, task_id, direction, kind, state, state_reason, attempts, last_error_json
           FROM intents ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(INTENTS) as Row[]
  ).map((i) => ({
    id: i.id,
    bindingId: i.binding_id,
    taskId: i.task_id,
    direction: i.direction,
    kind: i.kind,
    state: i.state,
    stateReason: i.state_reason,
    attempts: i.attempts,
    code: codeOf(json(i.last_error_json)),
  }));
  const runs = (
    db
      .prepare(
        "SELECT started_at, ended_at, outcome FROM runs WHERE kind = 'process' ORDER BY started_at DESC LIMIT ?",
      )
      .all(RUNS) as Row[]
  ).map((r) => ({ startedAt: r.started_at, endedAt: r.ended_at, outcome: r.outcome }));
  const journal = (
    db
      .prepare(
        "SELECT ts, level, key, binding_id, task_id, params_json FROM journal ORDER BY id DESC LIMIT ?",
      )
      .all(JOURNAL_ENTRIES) as Row[]
  )
    .reverse()
    .map((e) => {
      const p = json(e.params_json);
      return {
        ts: e.ts,
        level: e.level,
        key: e.key,
        code: codeOf(p),
        ids: { bindingId: e.binding_id, taskId: e.task_id, intent: p?.intent ?? null },
      };
    });
  const wv = s.config.writesVerified;
  return {
    schema: DIAG_SCHEMA,
    version: DIAG_SCHEMA_VERSION,
    createdAt: new Date((s.now ?? Date.now)()).toISOString(),
    versions: {
      bridge: s.version,
      node: process.versions.node,
      os: `${platform()}-${release()}`,
      arch: arch(),
      helper: wv?.helperVersion ?? null,
      macOS: wv?.macOS ?? null,
      database: (db.pragma("user_version", { simple: true }) as number) ?? null,
    },
    artifactSliceId: s.artifactSliceId?.() ?? null,
    certTestMode: s.certTestMode?.() ?? false,
    stop: stopState(s.home) !== undefined,
    safeMode: safeMode === undefined ? null : { since: safeMode.since },
    paths: { home: s.home },
    counters: {
      bindings: counts(db, "SELECT state AS k, count(*) AS n FROM bindings GROUP BY state"),
      links: counts(db, "SELECT state AS k, count(*) AS n FROM links GROUP BY state"),
      intents: counts(db, "SELECT state AS k, count(*) AS n FROM intents GROUP BY state"),
      holds: counts(db, "SELECT reason AS k, count(*) AS n FROM binding_holds GROUP BY reason"),
      journal: counts(db, "SELECT level AS k, count(*) AS n FROM journal GROUP BY level"),
    },
    needsAttention: s.needsAttention?.() ?? [],
    bindings,
    intents,
    runs,
    journal,
    crashes: crashSignatures(s.home, s.reports),
  };
}

/** The sealed diagnostics: collected, then sealed with a key made for it and zeroed after. */
export function diagnostics(s: DiagnosticsSource): Row {
  const tree = collect(s);
  const key = randomBytes(32);
  try {
    return seal(tree, key) as Row;
  } finally {
    key.fill(0);
  }
}

/** A zip of stored (uncompressed) files: enough for one JSON file a person can open anywhere. */
export function zip(files: readonly { readonly name: string; readonly data: Buffer }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(f.data.length, 18);
    head.writeUInt32LE(f.data.length, 22);
    head.writeUInt16LE(name.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(f.data.length, 20);
    dir.writeUInt32LE(f.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    local.push(head, name, f.data);
    central.push(dir, name);
    offset += head.length + name.length + f.data.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

/** Where an export goes when nobody chose: <home>/diagnostics/lfcp-bridge-diagnostics-<UTC>.zip. */
export function defaultExportPath(home: string, now = Date.now()): string {
  const stamp = new Date(now)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return join(home, "diagnostics", `lfcp-bridge-diagnostics-${stamp}.zip`);
}

/** Writes the export to `path` (0600); returns its size. */
export function exportDiagnostics(s: DiagnosticsSource, path: string): { readonly bytes: number } {
  const data = Buffer.from(`${JSON.stringify(diagnostics(s), null, 2)}\n`, "utf8");
  const archive = zip([{ name: DIAG_FILE, data }]);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, archive, { mode: 0o600 });
  return { bytes: archive.length };
}
