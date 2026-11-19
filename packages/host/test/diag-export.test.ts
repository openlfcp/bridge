// Export diagnostics (A§11, E20; T§3 canary, L0): a canary in every place a person's data or a
// secret lives — titles, URLs, paths, nested error causes, intent payloads and evidence, crash
// reports, a pairing link — is found nowhere in the zip; two exports of one state share no HMAC.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BridgeDatabase, openBridgeDatabase } from "../src/db/database.js";
import { Journal } from "../src/db/journal.js";
import { hostSignature, ipsSignature, recordHostCrash } from "../src/diag/crash.js";
import {
  collect,
  DIAG_FILE,
  type DiagnosticsSource,
  diagnostics,
  exportDiagnostics,
  seal,
  zip,
} from "../src/diag/export.js";
import { Runs } from "../src/executor/safe-mode.js";

const CANARY = "CANARY7f3a";
const T = "2026-11-20T10:00:00.000Z";

let dir: string;
let home: string;
let reports: string;
let db: BridgeDatabase;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lfcp-diag-"));
  // The canary is in the data directory's path too.
  home = join(dir, `home-${CANARY}`);
  reports = join(dir, "DiagnosticReports");
  mkdirSync(home);
  mkdirSync(reports);
  db = openBridgeDatabase(join(home, "bridge.sqlite"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(): void {
  db.prepare(
    `INSERT INTO installations (id, dir, principal, root, label, created_at)
     VALUES ('inst1', ?, ?, ?, ?, ?)`,
  ).run(`/Users/${CANARY}/inst`, `principal-${CANARY}`, `root-${CANARY}`, `Mac ${CANARY}`, T);
  db.prepare(
    `INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, target_ref,
       target_title, state, created_at)
     VALUES ('b1', 'inst1', ?, 'reminders', 'eventkit', ?, ?, 'active', ?)`,
  ).run(`res-${CANARY}`, `list-${CANARY}`, `LFCP · Groceries ${CANARY}`, T);
  db.prepare(
    "INSERT INTO binding_holds (binding_id, reason, since, detail_json) VALUES ('b1', 'guard_limit', ?, ?)",
  ).run(T, JSON.stringify({ title: CANARY }));
  db.prepare(
    `INSERT INTO links (binding_id, task_id, rem_url, rem_external_id, rem_title_snapshot, origin,
       state, created_at, updated_at)
     VALUES ('b1', 't1', ?, ?, ?, 'lfcp', 'linked', ?, ?)`,
  ).run(`https://example.org/${CANARY}`, `x-${CANARY}`, `Milk ${CANARY}`, T, T);
  db.prepare(
    `INSERT INTO intents (id, binding_id, task_id, installation_id, direction, kind, fields_json,
       basis_json, payload_json, operation_id, state, state_reason, attempts, last_error_json,
       created_at)
     VALUES ('i1', 'b1', 't1', 'inst1', 'to_apple', 'update', ?, ?, ?, 'op1', 'prepared',
       'basis_changed', 2, ?, ?)`,
  ).run(
    JSON.stringify({ title: CANARY }),
    JSON.stringify({ evidence: CANARY }),
    JSON.stringify({ title: `Milk ${CANARY}`, url: `https://x/${CANARY}` }),
    JSON.stringify({ code: "store_conflict", message: CANARY }),
    T,
  );
  // A pairing link and keys: never read, whatever table they are in.
  db.prepare("INSERT INTO meta (key, value) VALUES ('pairing', ?), ('dek', ?)").run(
    `lfcp-bridge:pair#secret-${CANARY}`,
    `dek-${CANARY}`,
  );
  const journal = new Journal(db, () => Date.parse(T));
  journal.append("warn", "effect.lost", {
    bindingId: "b1",
    taskId: "t1",
    params: { intent: "i1", code: "EPIPE", error: `Error: ${CANARY}` },
  });
  // An entry written before E-045: String(error) with a nested cause.
  journal.append("warn", "effect.lost", {
    params: {
      error: String(new Error(`outer ${CANARY}`, { cause: new Error(CANARY) })),
      cause: { message: CANARY, cause: { message: CANARY } },
    },
  });
  journal.append("info", "link.quarantine", { params: { reason: CANARY } });
  journal.append("info", "link.unlinked", { params: { reason: "moved_out", title: CANARY } });
  new Runs(db, () => Date.parse(T), 1).start();
  // The host crashed with the canary in its message; the helper's .ips report holds it too.
  recordHostCrash(home, new TypeError(`cannot read ${CANARY}`, { cause: CANARY }));
  writeFileSync(join(reports, "lfcp-reminders-helper-2026-11-20-100000.ips"), ips());
  writeFileSync(join(reports, `Other-${CANARY}-2026-11-20-100000.ips`), ips("Other"));
}

function ips(proc = "lfcp-reminders-helper"): string {
  return `${JSON.stringify({ app_name: proc, name: proc, bug_type: "309" })}\n${JSON.stringify({
    procName: proc,
    procPath: `/Applications/LFCP Bridge.app/${CANARY}`,
    exception: { type: "EXC_BAD_ACCESS", subtype: `KERN_INVALID_ADDRESS ${CANARY}` },
    faultingThread: 0,
    threads: [
      {
        frames: [
          { imageIndex: 1, imageOffset: 100, symbol: `strlen` },
          {
            imageIndex: 0,
            imageOffset: 4242,
            symbol: "Store.save",
            sourceFile: "Store.swift",
            sourceLine: 12,
          },
          { imageIndex: 0, imageOffset: 4300, symbol: `title ${CANARY}` },
        ],
      },
    ],
    usedImages: [{ name: proc }, { name: "libsystem_c.dylib" }],
    asi: { message: CANARY },
  })}`;
}

function source(over: Partial<DiagnosticsSource> = {}): DiagnosticsSource {
  return {
    db,
    home,
    reports,
    config: {
      bridgeInstanceId: "inst",
      helperPath: `/Users/${CANARY}/helper.app`,
      writesVerified: { helperVersion: "0.6.0", macOS: "15.1", at: T },
    },
    version: "0.6.0",
    now: () => Date.parse(T),
    ...over,
  };
}

/** The files of a zip of stored or deflated entries (unzip is not everywhere). */
function unzip(buf: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const method = buf.readUInt16LE(at + 8);
    const size = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26);
    const extra = buf.readUInt16LE(at + 28);
    const name = buf.subarray(at + 30, at + 30 + nameLen).toString("utf8");
    const body = buf.subarray(at + 30 + nameLen + extra, at + 30 + nameLen + extra + size);
    files.set(name, (method === 8 ? inflateRawSync(body) : body).toString("utf8"));
    at += 30 + nameLen + extra + size;
  }
  return files;
}

function hmacs(v: unknown, out = new Set<string>()): Set<string> {
  if (typeof v === "string" && v.startsWith("h:")) out.add(v);
  else if (Array.isArray(v)) for (const x of v) hmacs(x, out);
  else if (typeof v === "object" && v !== null) for (const x of Object.values(v)) hmacs(x, out);
  return out;
}

describe("Export diagnostics: T§3 canary (L0)", () => {
  it("no canary in the zip: titles, URLs, paths, causes, payload, evidence, crashes, pairing", () => {
    seed();
    const path = join(dir, "out", "diag.zip");
    const { bytes } = exportDiagnostics(source(), path);
    const raw = readFileSync(path);
    expect(raw.length).toBe(bytes);
    expect(raw.includes(Buffer.from(CANARY))).toBe(false);
    const files = unzip(raw);
    expect([...files.keys()]).toEqual([DIAG_FILE]);
    const text = files.get(DIAG_FILE) as string;
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain("secret");
    const d = JSON.parse(text);
    expect(d).toMatchObject({ schema: "diag-schema", version: 1, certTestMode: false });
    expect(d.artifactSliceId).toBeNull();
    // What support needs is plain: ids, states, codes; the title is there as an HMAC.
    expect(d.bindings).toEqual([
      {
        id: "b1",
        state: "active",
        title: expect.stringMatching(/^h:[0-9a-f]{16}$/),
        verification: false,
        holds: ["guard_limit"],
      },
    ]);
    expect(d.intents).toEqual([
      {
        id: "i1",
        bindingId: "b1",
        taskId: "t1",
        direction: "to_apple",
        kind: "update",
        state: "prepared",
        stateReason: "basis_changed",
        attempts: 2,
        code: "store_conflict",
      },
    ]);
    expect(d.paths.home).toMatch(/^h:/);
    expect(d.counters.links).toEqual({ linked: 1 });
    expect(d.journal.map((e: { key: string; code: string | null }) => [e.key, e.code])).toEqual([
      ["effect.lost", "EPIPE"],
      ["effect.lost", null],
      ["link.quarantine", null],
      ["link.unlinked", "moved_out"],
    ]);
    expect(d.journal[0]).toEqual({
      ts: T,
      level: "warn",
      key: "effect.lost",
      code: "EPIPE",
      ids: { bindingId: "b1", taskId: "t1", intent: "i1" },
    });
    // Signatures only: the host's and our helper's, never another process's report.
    expect(d.crashes).toHaveLength(2);
    expect(d.crashes).toContainEqual({
      process: "lfcp-reminders-helper",
      exception: "EXC_BAD_ACCESS",
      frames: ["Store.save (Store.swift:12)", "lfcp-reminders-helper+4300"],
    });
    expect(d.crashes).toContainEqual(
      expect.objectContaining({ process: "host", exception: "TypeError" }),
    );
  });

  it("two exports of one state share no HMAC value; within one, equal strings match", () => {
    seed();
    const a = diagnostics(source());
    const b = diagnostics(source());
    const ha = hmacs(a);
    const hb = hmacs(b);
    expect(ha.size).toBeGreaterThan(0);
    expect([...ha].filter((h) => hb.has(h))).toEqual([]);
    // Everything else is the same: only the sealed values differ.
    const plain = (d: unknown) => JSON.stringify(d).replace(/"h:[0-9a-f]{16}"/g, '"h"');
    expect(plain(a)).toBe(plain(b));
    const key = Buffer.alloc(32, 7);
    expect(seal({ x: "same", y: ["same"] }, key)).toEqual({
      x: seal("same", key),
      y: [seal("same", key)],
    });
  });

  it("seal: plain only at an allow-listed key in that key's form; anything else is an HMAC", () => {
    const key = Buffer.alloc(32, 1);
    const out = seal(
      {
        code: "EPIPE",
        state: `active ${CANARY}`,
        title: "store_conflict",
        nested: {
          deeper: [{ code: `x y ${CANARY}`, ts: T, id: "b1", n: 3, ok: true, none: null }],
        },
      },
      key,
    ) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain(CANARY);
    expect(out.code).toBe("EPIPE");
    expect(out.state).toMatch(/^h:/);
    expect(out.title).toMatch(/^h:/);
    expect(out.nested).toEqual({
      deeper: [{ code: expect.stringMatching(/^h:/), ts: T, id: "b1", n: 3, ok: true, none: null }],
    });
  });

  it("collect reads no payload, evidence, link or meta beyond the allow-list", () => {
    seed();
    const tree = JSON.stringify(collect({ ...source(), reports: join(dir, "none") }));
    // Before sealing, only the allow-listed strings with the canary are there: title, home path.
    const leaks = tree.match(new RegExp(`"[^"]*${CANARY}[^"]*"`, "g")) ?? [];
    expect(leaks.sort()).toEqual([`"${home}"`, `"LFCP · Groceries ${CANARY}"`]);
  });

  it("the zip opens with the system's unzip", () => {
    const archive = zip([{ name: DIAG_FILE, data: Buffer.from('{"a":1}\n') }]);
    const path = join(dir, "t.zip");
    writeFileSync(path, archive);
    let listed: string;
    try {
      listed = execFileSync("unzip", ["-p", path, DIAG_FILE], { encoding: "utf8" });
    } catch {
      return; // no unzip here: unzip() above reads the same bytes
    }
    expect(listed).toBe('{"a":1}\n');
  });
});

describe("crash signatures (A§11)", () => {
  it("host: the class and our own frames, no message, no path", () => {
    const e = new RangeError(CANARY);
    e.stack = [
      `RangeError: ${CANARY}`,
      "    at Executor.#effectApple (file:///x/packages/host/dist/executor/executor.js:602:7)",
      "    at async run (file:///x/node_modules/dep/index.js:1:1)",
      "    at main (/Applications/LFCP Bridge.app/Contents/Resources/host/bridge.mjs:9001:3)",
      `    at ${CANARY} (node:internal/x:1:1)`,
    ].join("\n");
    expect(hostSignature(e)).toEqual({
      process: "host",
      exception: "RangeError",
      frames: ["Executor.#effectApple (executor.js:602)", "main (bridge.mjs:9001)"],
    });
    expect(hostSignature(CANARY)).toEqual({ process: "host", exception: "unknown", frames: [] });
  });

  it(".ips: only our processes; not JSON is no signature", () => {
    expect(ipsSignature(ips("Other"))).toBeUndefined();
    expect(ipsSignature("{}\nnot json")).toBeUndefined();
    expect(ipsSignature(ips("LFCP Bridge"))?.process).toBe("LFCP Bridge");
  });
});
