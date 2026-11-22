// Export diagnostics (A§11, E20): a zip a person sends to support themselves, built by a
// versioned allow-list, `diag-schema v1`. The tree is built here field by field, by its path in
// the schema — versions, counters, states, codes, ids — and nothing else is read or carried: no
// pairing links, keys or DEKs, no intent payloads or evidence, no field values, no journal
// parameters but a code and an intent id, no raw crash reports (crash.ts rebuilds signatures).
// No object read from the database or a file is copied: every leaf is made by one of the makers
// in collect(), which keep a value plain only when it is in its field's vocabulary (a known code,
// codes.ts) or form (an id, a time, a version, a frame), and otherwise seal it:
// `h:` + HMAC-SHA-256(k, value)[0..8]. Titles, URLs, paths and error texts are always sealed.
// The key k is random per export and zeroed after it, never written: two exports of the same
// state share no HMAC value, and no export can be matched to another by them.

import { createHmac, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { arch, platform, release } from "node:os";
import { basename, dirname, join } from "node:path";
import { crc32 } from "node:zlib";
import { keptGate } from "../artifact/write-gate.js";
import type { BridgeConfig } from "../config.js";
import type { BridgeDatabase } from "../db/database.js";
import { JOURNAL_TEXT } from "../db/journal.js";
import { stopState } from "../db/stop.js";
import { KNOWN_CODES } from "./codes.js";
import { crashSignatures } from "./crash.js";

export const DIAG_SCHEMA = "diag-schema";
export const DIAG_SCHEMA_VERSION = 1;
export const DIAG_FILE = "diagnostics.json";
export const JOURNAL_ENTRIES = 500;
export const INTENTS = 200;
export const RUNS = 20;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T[\d:.]{8,12}Z$/;
const VERSION = /^[A-Za-z0-9._+-]{1,32}$/;

/** Seals one string. */
export type Sealer = (value: string) => string;

/** The sealer of one export's key. */
export function sealer(key: Buffer): Sealer {
  return (value) => `h:${createHmac("sha256", key).update(value).digest("hex").slice(0, 16)}`;
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
  /** A§9.4 (E-050); false until it comes. */
  readonly certTestMode?: () => boolean;
  readonly now?: () => number;
}

type Row = Record<string, unknown>;

function json(text: unknown): Row | undefined {
  try {
    const v = typeof text === "string" ? (JSON.parse(text) as unknown) : undefined;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Row) : undefined;
  } catch {
    return undefined;
  }
}

/** The allow-listed tree of diag-schema v1; `h` seals what may not stay plain. */
export function collect(s: DiagnosticsSource, h: Sealer): Row {
  const db = s.db;
  // The makers of leaves: a string is checked, a number kept, anything else is null.
  const leaf = (v: unknown, plain: (x: string) => boolean): string | number | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    // An object or anything else where a string belongs is dropped, never carried or serialized.
    if (typeof v !== "string") return null;
    return plain(v) ? v : h(v);
  };
  const code = (v: unknown) => leaf(v, (x) => KNOWN_CODES.has(x));
  const id = (v: unknown) => leaf(v, (x) => ID.test(x));
  const time = (v: unknown) => leaf(v, (x) => TIME.test(x));
  const version = (v: unknown) => leaf(v, (x) => VERSION.test(x));
  const text = (v: unknown) => leaf(v, () => false);
  const hex = (v: unknown) => leaf(v, (x) => /^[0-9a-f]{40}$/.test(x));
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const counts = (sql: string) => {
    const out: Record<string, number> = {};
    for (const r of db.prepare(sql).all() as { k: unknown; n: number }[])
      out[String(code(r.k))] = r.n;
    return out;
  };
  /** A journal entry's code: its code, reason or choice — the first there, plain if known. */
  const codeOf = (p: Row | undefined) => {
    for (const k of ["code", "reason", "choice"]) if (p?.[k] !== undefined) return code(p[k]);
    return null;
  };
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
    id: id(b.id),
    state: code(b.state),
    title: text(b.target_title),
    verification: b.verification === 1,
    holds: holds.filter((x) => x.binding_id === b.id).map((x) => code(x.reason)),
  }));
  const intents = (
    db
      .prepare(
        `SELECT id, binding_id, task_id, direction, kind, state, state_reason, attempts, last_error_json
           FROM intents ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(INTENTS) as Row[]
  ).map((i) => ({
    id: id(i.id),
    bindingId: id(i.binding_id),
    taskId: id(i.task_id),
    direction: code(i.direction),
    kind: code(i.kind),
    state: code(i.state),
    stateReason: code(i.state_reason),
    attempts: num(i.attempts),
    code: codeOf(json(i.last_error_json)),
  }));
  const runs = (
    db
      .prepare(
        "SELECT started_at, ended_at, outcome FROM runs WHERE kind = 'process' ORDER BY started_at DESC LIMIT ?",
      )
      .all(RUNS) as Row[]
  ).map((r) => ({
    startedAt: time(r.started_at),
    endedAt: time(r.ended_at),
    outcome: code(r.outcome),
  }));
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
        ts: time(e.ts),
        level: code(e.level),
        key: leaf(e.key, (x) => Object.hasOwn(JOURNAL_TEXT, x)),
        code: codeOf(p),
        ids: { bindingId: id(e.binding_id), taskId: id(e.task_id), intent: id(p?.intent) },
      };
    });
  // The write gate's last decision (A§9.1, E-051): its cert.state, slice and macOS.
  const cert = keptGate(db);
  return {
    schema: DIAG_SCHEMA,
    version: DIAG_SCHEMA_VERSION,
    createdAt: time(new Date((s.now ?? Date.now)()).toISOString()),
    versions: {
      bridge: version(s.version),
      node: version(process.versions.node),
      os: version(`${platform()}-${release()}`),
      arch: version(arch()),
      // The helper is nested code of the app: its identity is its cdhash, checked by the gate.
      helper: null,
      macOS: version(cert?.macOS),
      database: num(db.pragma("user_version", { simple: true })),
    },
    artifactSliceId: hex(cert?.artifactSliceId),
    cert:
      cert === undefined
        ? null
        : { state: code(cert.state), reason: code(cert.reason), at: time(cert.at) },
    certTestMode: s.certTestMode?.() === true,
    stop: stopState(s.home) !== undefined,
    safeMode: safeMode === undefined ? null : { since: time(safeMode.since) },
    paths: { home: text(s.home) },
    counters: {
      bindings: counts("SELECT state AS k, count(*) AS n FROM bindings GROUP BY state"),
      links: counts("SELECT state AS k, count(*) AS n FROM links GROUP BY state"),
      intents: counts("SELECT state AS k, count(*) AS n FROM intents GROUP BY state"),
      holds: counts("SELECT reason AS k, count(*) AS n FROM binding_holds GROUP BY reason"),
      journal: counts("SELECT level AS k, count(*) AS n FROM journal GROUP BY level"),
    },
    needsAttention: (s.needsAttention?.() ?? []).map((n) => ({
      bindingId: id(n.bindingId),
      code: code(n.code),
    })),
    bindings,
    intents,
    runs,
    journal,
    // Rebuilt and checked field by field in crash.ts: the process ours, the exception known.
    crashes: crashSignatures(s.home, s.reports).map((c) => ({
      process: c.process,
      exception: c.exception,
      frames: [...c.frames],
    })),
  };
}

/** The sealed diagnostics: collected with a key made for this export and zeroed after it. */
export function diagnostics(s: DiagnosticsSource): Row {
  const key = randomBytes(32);
  try {
    return collect(s, sealer(key));
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

/**
 * Writes `data` at `path` without following a link there and without writing into an existing
 * file: a new file (0600, O_EXCL | O_NOFOLLOW) in the directory `path` names (resolved once), then
 * renamed over `path`. An existing regular file is replaced as a whole (its inode, and any other
 * link to it, is left as it was); a symlink, a directory or anything else there is refused (EEXIST).
 * The directory must exist.
 */
export function writeNewFile(path: string, data: Buffer): string {
  const dir = realpathSync(dirname(path));
  const final = join(dir, basename(path));
  let there: ReturnType<typeof lstatSync> | undefined;
  try {
    there = lstatSync(final);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (there !== undefined && !there.isFile())
    throw Object.assign(new Error("export: not a regular file"), { code: "EEXIST" });
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(fd, 0o600);
    for (let at = 0; at < data.length; ) at += writeSync(fd, data, at);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    unlinkSync(tmp);
    throw e;
  }
  closeSync(fd);
  try {
    renameSync(tmp, final);
  } catch (e) {
    unlinkSync(tmp);
    throw e;
  }
  return final;
}

/** The data directory's own export folder (0700), made when missing. */
export function defaultExportDir(home: string): void {
  mkdirSync(join(home, "diagnostics"), { recursive: true, mode: 0o700 });
}

/** Writes the export to `path` (writeNewFile: 0600, never through a link); returns its size. */
export function exportDiagnostics(s: DiagnosticsSource, path: string): { readonly bytes: number } {
  const data = Buffer.from(`${JSON.stringify(diagnostics(s), null, 2)}\n`, "utf8");
  const archive = zip([{ name: DIAG_FILE, data }]);
  writeNewFile(path, archive);
  return { bytes: archive.length };
}
