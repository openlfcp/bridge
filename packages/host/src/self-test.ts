// `bridge.mjs --self-test` (A§2.1, T§2 L5; research/s-2-bundle.md): proves that a packaged host
// runs where it lies — the bundle's own Node, better-sqlite3 resolved from the bundle's own
// node_modules, Automerge's WebAssembly built into the bundle, and the helper next to it answering
// `ping` (memory backend: no EventKit, no TCC). One JSON line per check, then a summary line;
// exit 0 only when every check passes.
//
//   bridge.mjs --self-test                 the .app is found from this file's place in it
//   bridge.mjs --self-test --app <path>    the .app (or any directory with Contents/MacOS/…)
//   bridge.mjs --self-test --dev           outside a bundle: no placement checks, no helper

import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as A from "@automerge/automerge";
import { HelperProcess } from "@openlfcp/bridge-transport-eventkit";
import { initializeAutomerge } from "@openlfcp/shared-objects";
import { openBridgeDatabase, SCHEMA_VERSION, schemaVersion } from "./db/database.js";

interface Check {
  readonly check: string;
  readonly ok: boolean;
  readonly [k: string]: unknown;
}

/** Contents/Resources/host/bridge.mjs → the .app three levels up. */
function appFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function inside(file: string, dir: string): boolean {
  const rel = path.relative(real(dir), real(file));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Where the process runs from; inside a bundle, every piece must be the bundle's own. */
function runtime(app: string | undefined): Check {
  const require = createRequire(import.meta.url);
  const betterSqlite3 = require.resolve("better-sqlite3");
  const pathHasNode = (process.env.PATH ?? "")
    .split(path.delimiter)
    .some((d) => d !== "" && existsSync(path.join(d, "node")));
  const facts = {
    node: process.version,
    execPath: process.execPath,
    arch: process.arch,
    platform: process.platform,
    modules: process.versions.modules,
    napi: process.versions.napi,
    script: fileURLToPath(import.meta.url),
    betterSqlite3,
    pathHasNode,
  };
  if (app === undefined) return { check: "runtime", ok: true, ...facts };
  const resources = path.join(app, "Contents", "Resources");
  const placement = {
    nodeInApp: real(process.execPath) === real(path.join(resources, "node", "bin", "node")),
    scriptInApp: inside(facts.script, path.join(resources, "host")),
    sqliteInApp: inside(betterSqlite3, path.join(resources, "host", "node_modules")),
  };
  return {
    check: "runtime",
    ok: placement.nodeInApp && placement.scriptInApp && placement.sqliteInApp && !pathHasNode,
    app,
    ...placement,
    ...facts,
  };
}

function sqlite(): Check {
  const dir = mkdtempSync(path.join(tmpdir(), "lfcp-selftest-"));
  try {
    const db = openBridgeDatabase(path.join(dir, "bridge.sqlite"));
    try {
      db.exec("CREATE TABLE selftest (n INTEGER NOT NULL)");
      const insert = db.prepare("INSERT INTO selftest (n) VALUES (?)");
      db.transaction(() => {
        for (let n = 1; n <= 3; n++) insert.run(n);
      })();
      const row = db.prepare("SELECT count(*) AS c, sum(n) AS s FROM selftest").get() as {
        c: number;
        s: number;
      };
      const version = schemaVersion(db);
      const sqliteVersion = (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
      const journalMode = db.pragma("journal_mode", { simple: true });
      return {
        check: "sqlite",
        ok: row.c === 3 && row.s === 6 && version === SCHEMA_VERSION && journalMode === "wal",
        rows: row.c,
        schemaVersion: version,
        sqliteVersion,
        journalMode,
      };
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function automerge(): Promise<Check> {
  // The bundle carries Automerge's /slim entry: its wasm is ready only after this (cli.ts awaits
  // it too); a plain node_modules run has it ready on import and this is a no-op.
  await initializeAutomerge();
  let doc = A.from<{ tasks: string[] }>({ tasks: [] });
  doc = A.change(doc, (d) => {
    d.tasks.push("one", "two");
  });
  const bytes = A.save(doc);
  const loaded = A.load<{ tasks: string[] }>(bytes);
  return {
    check: "automerge",
    ok: A.isWasmInitialized() && loaded.tasks.join(",") === "one,two",
    savedBytes: bytes.length,
    heads: A.getHeads(loaded).length,
  };
}

async function helper(app: string): Promise<Check> {
  const h = await HelperProcess.start({
    appPath: app,
    launch: "direct",
    backend: "memory",
    readyTimeoutMs: 15_000,
  });
  try {
    const pong = await h.request("ping", {}, { timeoutMs: 10_000 });
    const parentPath = h.ready.parentPath;
    return {
      check: "helper",
      // The helper's parent is this process: the bundle's node, not one found on PATH.
      ok:
        pong.ok &&
        (pong as Record<string, unknown>).pong === true &&
        parentPath !== undefined &&
        real(parentPath) === real(process.execPath),
      app,
      helperVersion: h.ready.helperVersion,
      protocol: h.ready.protocol,
      backend: h.ready.backend,
      parentPath,
    };
  } finally {
    await h.close();
  }
}

/** Runs the checks, writes one JSON line each; returns the exit code. */
export async function selfTest(
  args: readonly string[],
  out: (line: string) => void,
): Promise<number> {
  const dev = args.includes("--dev");
  const appAt = args.indexOf("--app");
  const app = dev ? undefined : appAt >= 0 ? args[appAt + 1] : appFromHere();
  if (!dev && app === undefined) {
    out(JSON.stringify({ check: "args", ok: false, error: "--app needs a path" }));
    return 2;
  }
  const checks: Array<[string, () => Check | Promise<Check>]> = [
    ["runtime", () => runtime(app)],
    ["sqlite", sqlite],
    ["automerge", automerge],
  ];
  if (app !== undefined) checks.push(["helper", () => helper(app)]);
  let failed = 0;
  for (const [name, run] of checks) {
    let result: Check;
    try {
      result = await run();
    } catch (e) {
      result = { check: name, ok: false, error: (e as Error).stack ?? String(e) };
    }
    if (!result.ok) failed++;
    out(JSON.stringify(result));
  }
  out(JSON.stringify({ selfTest: failed === 0 ? "ok" : "failed", failed }));
  return failed === 0 ? 0 : 1;
}
