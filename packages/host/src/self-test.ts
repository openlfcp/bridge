// `bridge.mjs --self-test` (spike S-2, A§2.1): proves that a packaged host runs where it lies —
// the pinned Node, better-sqlite3 resolved from the bundle's own node_modules, Automerge's
// WebAssembly built into the bundle, and the helper next to it answering `ping` (memory backend,
// no EventKit, no TCC). One JSON line per check, then a summary line; 0 only when all pass.
//
//   bridge.mjs --self-test                 the helper is found from this file's place in the .app
//   bridge.mjs --self-test --app <path>    the .app (or any directory with Contents/MacOS/…)
//   bridge.mjs --self-test --no-helper     skip the helper (a dev run outside a bundle)

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as A from "@automerge/automerge";
import { HelperProcess } from "@openlfcp/bridge-transport-eventkit";
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

function runtime(): Check {
  const require = createRequire(import.meta.url);
  return {
    check: "runtime",
    ok: true,
    node: process.version,
    execPath: process.execPath,
    arch: process.arch,
    platform: process.platform,
    modules: process.versions.modules,
    napi: process.versions.napi,
    script: fileURLToPath(import.meta.url),
    betterSqlite3: require.resolve("better-sqlite3"),
    pathHasNode: (process.env.PATH ?? "")
      .split(path.delimiter)
      .some((d) => d !== "" && existsSync(path.join(d, "node"))),
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
      return {
        check: "sqlite",
        ok: row.c === 3 && row.s === 6 && version === SCHEMA_VERSION,
        rows: row.c,
        schemaVersion: version,
        sqliteVersion,
        journalMode: db.pragma("journal_mode", { simple: true }),
      };
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function automerge(): Check {
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
    return {
      check: "helper",
      ok: pong.ok && (pong as Record<string, unknown>).pong === true,
      app,
      helperVersion: h.ready.helperVersion,
      protocol: h.ready.protocol,
      parentPath: h.ready.parentPath,
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
  const noHelper = args.includes("--no-helper");
  const appAt = args.indexOf("--app");
  const app = appAt >= 0 ? args[appAt + 1] : appFromHere();
  if (app === undefined) {
    out(JSON.stringify({ check: "args", ok: false, error: "--app needs a path" }));
    return 2;
  }
  const checks: Array<[string, () => Check | Promise<Check>]> = [
    ["runtime", runtime],
    ["sqlite", sqlite],
    ["automerge", automerge],
  ];
  if (!noHelper) checks.push(["helper", () => helper(app)]);
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
