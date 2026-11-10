#!/usr/bin/env node
// The schema of bridge.sqlite: what version it is, a backup, and a move to another version
// (D-010 §3: migrations by user_version, forward and back; the runbook, docs/guides/running-the-bridge.md).
//
//   node scripts/bridge-db.mjs status               # this database's version and what this build knows
//   node scripts/bridge-db.mjs backup [--to <file>] # a consistent copy (SQLite online backup)
//   node scripts/bridge-db.mjs migrate --to <N>     # up or down to version N; needs STOP; backs up first
//   node scripts/bridge-db.mjs --self-test          # on a temporary database only
//
// --db <file> names the database; otherwise bridge.sqlite in LFCP_BRIDGE_HOME or
// ~/Library/Application Support/org.openlfcp.bridge. Uses the built host package
// (pnpm build first). A down migration drops what the later versions added (their tables and
// rows): that is what the backup is for.

import {
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hostDist = join(root, "packages", "host", "dist", "index.js");
if (!existsSync(hostDist)) {
  console.error("bridge-db: packages/host is not built (run pnpm build)");
  process.exit(2);
}
const { MIGRATIONS, migrateTo, openBridgeDatabase, SCHEMA_VERSION, schemaVersion, stopState } =
  await import(hostDist);

const USAGE = "usage: bridge-db.mjs status|backup [--to <file>]|migrate --to <N> [--db <file>]";

function parse(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
    opts[a.slice(2)] = v;
    i++;
  }
  return { command, opts };
}

function homeOf(env) {
  return (
    env.LFCP_BRIDGE_HOME ?? join(homedir(), "Library", "Application Support", "org.openlfcp.bridge")
  );
}

/** Opens without migrating: the version found stays as it is. */
function open(file) {
  if (!existsSync(file)) throw new Error(`no database at ${file}`);
  return openBridgeDatabase(file, { migrate: false });
}

/**
 * Why `target` cannot be a backup of `file`, or undefined. A backup is a new, separate file: never
 * the database itself (however it is reached: a symlink or a hard link to it exists already),
 * never its -wal / -shm / -journal (SQLite would take it for its own), never an existing file
 * (an older backup is a point to go back to).
 */
function unsafeTarget(file, target) {
  const abs = resolve(target);
  try {
    lstatSync(abs);
    return `${abs} exists; a backup never replaces a file`;
  } catch (e) {
    if (e.code !== "ENOENT") return `${abs}: ${e.message}`;
  }
  let dir;
  try {
    dir = realpathSync(dirname(abs));
  } catch {
    return `no directory ${dirname(abs)}`;
  }
  const real = join(dir, basename(abs));
  const db = realpathSync(file);
  for (const own of [db, `${db}-wal`, `${db}-shm`, `${db}-journal`])
    if (real === own) return `${abs} is the database's own file`;
  return undefined;
}

/** A consistent copy of `db` at a new path; checked to open at the same version. */
async function backup(db, file, to) {
  const version = schemaVersion(db);
  const target = resolve(
    to ?? `${file}.v${version}-${new Date().toISOString().replaceAll(":", "-")}.bak`,
  );
  const why = unsafeTarget(file, target);
  if (why !== undefined) throw new Error(`refusing the backup: ${why}`);
  // Written next to it under a temporary name, then linked into place: link never overwrites, so
  // a file that appeared meanwhile stays, and a failed backup leaves no file under the name.
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await db.backup(tmp);
    const copy = openBridgeDatabase(tmp, { migrate: false });
    try {
      if (schemaVersion(copy) !== version)
        throw new Error("the copy is not at the database's version");
    } finally {
      copy.close();
    }
    linkSync(tmp, target);
  } finally {
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) rmSync(f, { force: true });
  }
  return target;
}

export async function run(argv, env = process.env, out = console.log) {
  const { command, opts } = parse(argv);
  const home = homeOf(env);
  const file = opts.db ?? join(home, "bridge.sqlite");
  switch (command) {
    case "status": {
      const db = open(file);
      try {
        const v = schemaVersion(db);
        out(`database: ${file}`);
        out(`version: ${v}; this build knows 1..${SCHEMA_VERSION}`);
        for (const m of MIGRATIONS) out(`  ${m.version <= v ? "x" : " "} ${m.version}  ${m.name}`);
        if (v > SCHEMA_VERSION) out("a newer bridge wrote it: this build refuses to open it");
      } finally {
        db.close();
      }
      return 0;
    }
    case "backup": {
      const db = open(file);
      try {
        out(`backup: ${await backup(db, file, opts.to)}`);
      } finally {
        db.close();
      }
      return 0;
    }
    case "migrate": {
      const target = Number(opts.to);
      if (!Number.isInteger(target) || target < 0 || target > SCHEMA_VERSION)
        throw new Error(`--to must be 0..${SCHEMA_VERSION}`);
      // Nothing may write while the schema moves: STOP keeps every effect off, and the LaunchAgent
      // should be unloaded (lfcp-bridge service uninstall) so no run holds the database.
      if (stopState(dirname(file)) === undefined)
        throw new Error(
          "STOP is not set: run `lfcp-bridge stop` (and `lfcp-bridge service uninstall`) first",
        );
      const db = open(file);
      try {
        const from = schemaVersion(db);
        if (from === target) {
          out(`already at version ${target}`);
          return 0;
        }
        out(`backup: ${await backup(db, file, opts.backup)}`);
        const steps = migrateTo(db, target);
        out(`version ${from} -> ${target} (steps: ${steps.join(", ")})`);
      } finally {
        db.close();
      }
      return 0;
    }
    default:
      throw new Error(USAGE);
  }
}

/** Down to 0 and back up, on a temporary database; the backup is a database of the old version. */
async function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), "bridge-db-"));
  const lines = [];
  const say = (l) => lines.push(l);
  const env = { LFCP_BRIDGE_HOME: dir };
  try {
    const file = join(dir, "bridge.sqlite");
    openBridgeDatabase(file).close();
    await run(["status"], env, say);
    let refused = false;
    try {
      await run(["migrate", "--to", "1"], env, say);
    } catch (e) {
      refused = /STOP is not set/.test(e.message);
    }
    if (!refused) throw new Error("migrate ran without STOP");
    const { stop } = await import(hostDist);
    stop(dir, "self-test");
    // A backup that is not a separate new file is refused, before anything changes (review P1-1).
    const version = () => {
      const d = open(file);
      try {
        return schemaVersion(d);
      } finally {
        d.close();
      }
    };
    const existing = join(dir, "existing.bak");
    writeFileSync(existing, "irreplaceable old backup");
    symlinkSync(file, join(dir, "link.sqlite"));
    linkSync(file, join(dir, "hard.sqlite"));
    for (const [name, target] of [
      ["the database itself", file],
      ["a symlink to it", join(dir, "link.sqlite")],
      ["a hard link to it", join(dir, "hard.sqlite")],
      ["its WAL", `${file}-wal`],
      ["an existing file", existing],
    ]) {
      for (const argv of [
        ["migrate", "--to", "1", "--backup", target],
        ["backup", "--to", target],
      ]) {
        let failed = false;
        try {
          await run(argv, env, say);
        } catch {
          failed = true;
        }
        if (!failed) throw new Error(`${argv[0]} accepted ${name} as its backup`);
        if (version() !== SCHEMA_VERSION)
          throw new Error(`${argv[0]} to ${name} changed the schema`);
      }
    }
    if (readFileSync(existing, "utf8") !== "irreplaceable old backup")
      throw new Error("an existing backup was overwritten");
    await run(["migrate", "--to", "1", "--backup", join(dir, "before.bak")], env, say);
    const back = open(join(dir, "before.bak"));
    const backVersion = schemaVersion(back);
    back.close();
    if (backVersion !== SCHEMA_VERSION) throw new Error(`backup is version ${backVersion}`);
    const down = open(file);
    const downVersion = schemaVersion(down);
    down.close();
    if (downVersion !== 1) throw new Error(`down left version ${downVersion}`);
    await run(["migrate", "--to", String(SCHEMA_VERSION)], env, say);
    const up = open(file);
    const upVersion = schemaVersion(up);
    up.close();
    if (upVersion !== SCHEMA_VERSION) throw new Error(`up left version ${upVersion}`);
    console.log(
      `bridge-db self-test: ok (1 <-> ${SCHEMA_VERSION}, backup, STOP required, unsafe backup targets refused)`,
    );
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode =
      process.argv[2] === "--self-test" ? await selfTest() : await run(process.argv.slice(2));
  } catch (e) {
    console.error(`bridge-db: ${e.message}`);
    process.exitCode = 2;
  }
}
