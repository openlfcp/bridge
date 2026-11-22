// Export diagnostics (A§11, E20; T§3 canary, L0): a canary in every place a person's data or a
// secret lives — titles, URLs, paths, nested error causes, intent payloads and evidence, crash
// reports, a pairing link — is found nowhere in the zip; two exports of one state share no HMAC.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BridgeDatabase, openBridgeDatabase } from "../src/db/database.js";
import { Holds } from "../src/db/holds.js";
import { Journal } from "../src/db/journal.js";
import {
  crashSignatures,
  hostSignature,
  ipsSignature,
  MAX_CRASHES,
  recordHostCrash,
} from "../src/diag/crash.js";
import { errorCode } from "../src/diag/errors.js";
import {
  collect,
  DIAG_FILE,
  type DiagnosticsSource,
  diagnostics,
  exportDiagnostics,
  sealer,
  writeNewFile,
  zip,
} from "../src/diag/export.js";
import { Runs } from "../src/executor/safe-mode.js";
import { EXIT, main } from "../src/index.js";
import type { Runtime } from "../src/runtime.js";

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
    "INSERT INTO binding_holds (binding_id, reason, since, detail_json) VALUES ('b1', 'guard_mass_unlink', ?, ?)",
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
    // The write gate's last decision (E-051): its detail may name paths; only codes go out.
    const slice = "ab".repeat(20);
    db.prepare("INSERT INTO meta (key, value) VALUES ('cert_gate', ?)").run(
      JSON.stringify({
        state: "mismatch",
        reason: "nested-cdhash",
        detail: `/Users/${CANARY}/x: cdhash`,
        at: T,
        macOS: "15.1",
        artifactSliceId: slice,
      }),
    );
    mkdirSync(join(dir, "out"));
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
    expect(d.artifactSliceId).toBe(slice);
    expect(d.cert).toEqual({ state: "mismatch", reason: "nested-cdhash", at: T });
    expect(d.versions).toMatchObject({ macOS: "15.1", helper: null });
    // What support needs is plain: ids, states, codes; the title is there as an HMAC.
    expect(d.bindings).toEqual([
      {
        id: "b1",
        state: "active",
        title: expect.stringMatching(/^h:[0-9a-f]{16}$/),
        verification: false,
        holds: ["guard_mass_unlink"],
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
      ["link.quarantine", expect.stringMatching(/^h:[0-9a-f]{16}$/)],
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
    const h = sealer(Buffer.alloc(32, 7));
    expect(h("same")).toBe(h("same"));
    expect(h("same")).not.toBe(sealer(Buffer.alloc(32, 8))("same"));
  });

  it("collect reads no payload, evidence, link or meta beyond the allow-list", () => {
    seed();
    // A marking sealer: what would be sealed shows as S<…>.
    const tree = JSON.stringify(
      collect({ ...source(), reports: join(dir, "none") }, (v) => `S<${v}>`),
    );
    const plain = tree.replace(/"S<[^"]*>"/g, '"S"');
    expect(plain).not.toContain(CANARY);
    // Sealed, the canary is only where a title or a path belongs…
    const sealed = (tree.match(new RegExp(`"S<[^"]*${CANARY}[^"]*>"`, "g")) ?? []).sort();
    // …and the free-text reason of a journal entry, in place of its code.
    expect(sealed).toEqual([`"S<${home}>"`, `"S<${CANARY}>"`, `"S<LFCP · Groceries ${CANARY}>"`]);
  });

  it("review #1: nested JSON is never carried — extra fields, nested allowed names, canary keys", () => {
    seed();
    const crashes = join(home, "crashes");
    // An old or foreign host-*.json: only process, exception and frames are rebuilt, each checked.
    writeFileSync(
      join(crashes, "host-2.json"),
      JSON.stringify({
        process: "host",
        exception: "PRIVATE_NOTE",
        frames: ["main (bridge.mjs:1)", { code: "PRIVATE_NOTE" }, `x ${CANARY}`],
        payload: { code: "PRIVATE_NOTE", id: "PRIVATE_NOTE" },
        [`PRIVATE_USER_TEXT_${CANARY}`]: "value",
      }),
    );
    writeFileSync(
      join(crashes, "host-3.json"),
      JSON.stringify({ process: `PRIVATE ${CANARY}`, exception: "TypeError", frames: [] }),
    );
    const journal = new Journal(db, () => Date.parse(T));
    journal.append("info", "effect.lost", {
      params: { intent: { payload: { id: "PRIVATE_NOTE" } }, code: { code: "EPIPE" } },
    });
    journal.append("info", `custom.${CANARY}`, { params: { intent: "i1", reason: ["moved_out"] } });
    const d = diagnostics(source());
    const text = JSON.stringify(d);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain("PRIVATE");
    expect(text).not.toContain("payload");
    expect(d.crashes).toContainEqual({
      process: "host",
      exception: "unknown",
      frames: ["main (bridge.mjs:1)"],
    });
    expect(
      (d.crashes as { process: string }[]).filter(
        (c) => c.process !== "host" && c.process !== "lfcp-reminders-helper",
      ),
    ).toEqual([]);
    const tail = (d.journal as Record<string, unknown>[]).slice(-2);
    expect(tail[0]).toMatchObject({ key: "effect.lost", code: null, ids: { intent: null } });
    expect(tail[1]).toMatchObject({
      key: expect.stringMatching(/^h:/),
      code: null,
      ids: { intent: "i1" },
    });
    for (const e of d.journal as Record<string, unknown>[])
      expect(Object.keys(e).sort()).toEqual(["code", "ids", "key", "level", "ts"]);
  });

  it("review #2: user text in the shape of a code is sealed; unknown codes are not codes", () => {
    seed();
    const shaped = ["PRIVATE_NOTE", "private.example.com", "private_note", "PrivateNoteError"];
    const journal = new Journal(db, () => Date.parse(T));
    for (const v of shaped) {
      journal.append("warn", "effect.refused", { params: { code: v } });
      journal.append("info", "link.unlinked", { params: { reason: v } });
    }
    db.prepare("UPDATE intents SET state_reason = ?, last_error_json = ?, kind = ?").run(
      "private_note",
      JSON.stringify({ code: "private.example.com" }),
      "PRIVATE_NOTE",
    );
    db.prepare(
      "INSERT INTO binding_holds (binding_id, reason, since) VALUES ('b1', 'private_note', ?)",
    ).run(T);
    const d = diagnostics(source());
    const text = JSON.stringify(d);
    for (const v of shaped) expect(text).not.toContain(v);
    expect(text.toLowerCase()).not.toContain("private");
    // Known codes stay plain.
    expect(d.intents).toEqual([
      expect.objectContaining({ state: "prepared", direction: "to_apple" }),
    ]);
    expect((d.bindings as { holds: string[] }[])[0]?.holds).toContain("guard_mass_unlink");
    expect(errorCode({ code: "private.example.com" })).toBe("error");
    expect(errorCode({ code: "PRIVATE_NOTE", name: "TransportReadError" })).toBe(
      "TransportReadError",
    );
    expect(errorCode({ name: "PrivateNoteError" })).toBe("error");
    expect(errorCode({ code: "store_conflict" })).toBe("store_conflict");
    expect(errorCode(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe("ENOENT");
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

describe("review #3: the export never writes through a link or into an existing file", () => {
  it("a symlink at the path is refused; its target is untouched", () => {
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "keep me");
    const chosen = join(home, "chosen.zip");
    symlinkSync(outside, chosen);
    expect(() => exportDiagnostics(source(), chosen)).toThrow(
      expect.objectContaining({ code: "EEXIST" }),
    );
    expect(readFileSync(outside, "utf8")).toBe("keep me");
    expect(lstatSync(chosen).isSymbolicLink()).toBe(true);
    // A dangling link too: nothing is created at its target.
    const dangling = join(home, "dangling.zip");
    symlinkSync(join(dir, "made-by-export.zip"), dangling);
    expect(() => writeNewFile(dangling, Buffer.from("x"))).toThrow();
    expect(existsSync(join(dir, "made-by-export.zip"))).toBe(false);
  });

  it("an existing 0644 file is replaced by a new 0600 file; a hard link to it keeps its bytes", () => {
    const path = join(dir, "old.zip");
    writeFileSync(path, "old", { mode: 0o644 });
    chmodSync(path, 0o644);
    const other = join(dir, "other-link");
    linkSync(path, other);
    exportDiagnostics(source(), path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(other, "utf8")).toBe("old");
    expect(readFileSync(path).subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    // No temporary file is left behind.
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("a directory at the path or a missing folder is refused", () => {
    mkdirSync(join(dir, "d.zip"));
    expect(() => writeNewFile(join(dir, "d.zip"), Buffer.from("x"))).toThrow();
    expect(() => writeNewFile(join(dir, "missing", "d.zip"), Buffer.from("x"))).toThrow();
  });
});

describe("crash signatures (A§11)", () => {
  it("review #4: other processes' reports are never opened; at most MAX_CRASHES are", () => {
    const opened: string[] = [];
    const read = (f: string) => {
      opened.push(f);
      return readFileSync(f, "utf8");
    };
    writeFileSync(join(reports, `Other-${CANARY}-1.ips`), ips("Other"));
    writeFileSync(join(reports, "lfcp-reminders-helper-x.crash"), ips());
    for (let i = 0; i < MAX_CRASHES + 2; i++)
      writeFileSync(join(reports, `lfcp-reminders-helper-${i}.ips`), ips());
    symlinkSync(
      join(reports, "lfcp-reminders-helper-0.ips"),
      join(reports, "LFCP Bridge-link.ips"),
    );
    const got = crashSignatures(home, reports, read);
    expect(got).toHaveLength(MAX_CRASHES);
    expect(opened).toHaveLength(MAX_CRASHES);
    for (const f of opened) expect(f).toMatch(/lfcp-reminders-helper-\d+\.ips$/);
  });

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

describe("lfcp-bridge export", () => {
  async function call(...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const rt = {
      paths: { home },
      db,
      config: { bridgeInstanceId: "inst" },
      journal: new Journal(db),
      holds: new Holds(db),
      async close() {},
    } as unknown as Runtime;
    const code = await main(argv, {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      runtime: async () => rt,
    });
    return { code, out, err };
  }

  it("writes the zip to --out, or to <home>/diagnostics, and says where", async () => {
    seed();
    const path = join(dir, "d.zip");
    const r = await call("export", "--out", path);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out[0]).toBe(`diagnostics exported (${readFileSync(path).length} bytes): ${path}`);
    expect(readFileSync(path).includes(Buffer.from(CANARY))).toBe(false);
    const d = await call("export");
    expect(d.code).toBe(EXIT.OK);
    expect(d.out[0]).toMatch(/diagnostics[/\\]lfcp-bridge-diagnostics-\d{8}T\d{6}Z\.zip$/);
  });

  it("review #3: a symlink at --out is refused with its code; the target is untouched", async () => {
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "keep me");
    const chosen = join(home, "chosen.zip");
    symlinkSync(outside, chosen);
    const r = await call("export", "--out", chosen);
    expect(r.code).toBe(EXIT.NEEDS_PERSON);
    expect(r.err.join("\n")).toContain("(EEXIST)");
    expect(readFileSync(outside, "utf8")).toBe("keep me");
  });

  it("refuses a relative path or another extension", async () => {
    expect((await call("export", "--out", "d.zip")).code).toBe(EXIT.USAGE);
    expect((await call("export", "--out", join(dir, "d.txt"))).code).toBe(EXIT.USAGE);
    expect((await call("export", "--out")).code).toBe(EXIT.USAGE);
  });
});
