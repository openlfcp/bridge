// The write gate at run time (A§9.1–9.2, E-051b): the manifests fetched into the cache, the
// nested Mach-O the shell is asked about, the decision kept for status, Check and diagnostics.
// The shell is a fake here (its Security.framework checks are Swift, app/; L5 is E-051c).

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ShellCode } from "../src/app/serve.js";
import { ManifestCache } from "../src/artifact/cache.js";
import { signCertification } from "../src/artifact/certification.js";
import type { CodeIdentity } from "../src/artifact/gate.js";
import {
  ARTIFACT_MANIFESTS_KEPT,
  artifactManifestUrl,
  CERTIFICATION_MANIFEST_URL,
  CERTIFICATION_REFRESH_MS,
  DOWNLOAD_HOSTS,
  type FetchText,
  guardedFetchText,
  keptGate,
  nestedMachO,
  refreshGate,
  WriteGate,
} from "../src/artifact/write-gate.js";
import { openBridgeDatabase } from "../src/db/database.js";
import { Journal } from "../src/db/journal.js";
import { ARTIFACT, ARTIFACT_TEXT, cert, entry, KEY, PUB } from "./support/certification.js";

const NESTED = ARTIFACT.manifest.slices.arm64.nested;

/** A Mach-O header: thin arm64, thin x86_64, or universal with both. */
function machO(kind: "arm64" | "x86_64" | "fat"): Buffer {
  if (kind === "fat") {
    const b = Buffer.alloc(8 + 2 * 20);
    b.writeUInt32BE(0xcafebabe, 0);
    b.writeUInt32BE(2, 4);
    b.writeUInt32BE(16777228, 8);
    b.writeUInt32BE(16777223, 28);
    return b;
  }
  const b = Buffer.alloc(32);
  b.writeUInt32BE(0xcffaedfe, 0);
  b.writeUInt32LE(kind === "arm64" ? 16777228 : 16777223, 4);
  return b;
}

/** A bundle with the fixture's nested code, the shell, a resource and its seal. */
function bundle(): string {
  const app = join(mkdtempSync(join(tmpdir(), "lfcp-gate-")), "LFCP Bridge.app");
  const put = (path: string, bytes: Buffer | string) => {
    mkdirSync(join(app, path, ".."), { recursive: true });
    writeFileSync(join(app, path), bytes);
  };
  put("Contents/MacOS/LFCP Bridge", machO("fat"));
  for (const n of NESTED) put(n.path, machO("fat"));
  put("Contents/Resources/x86-only.dylib", machO("x86_64"));
  put("Contents/Resources/host/bridge.mjs", "export {};\n");
  put("Contents/_CodeSignature/CodeResources", machO("arm64"));
  return app;
}

/** The shell of the fixture's build: the manifest's cdhash for every path it is asked about. */
function shell(over: Partial<CodeIdentity> = {}): ShellCode & { asked: string[][] } {
  const asked: string[][] = [];
  const want = new Map(NESTED.map((n) => [n.path, n.cdhash]));
  return {
    asked,
    identity: async (paths) => {
      asked.push([...paths]);
      return {
        arch: "arm64",
        validity: { ok: true },
        runningShell: ARTIFACT.manifest.slices.arm64.shell,
        nested: paths.map((path) => ({ path, cdhash: want.get(path) ?? "9".repeat(40) })),
        ...over,
      };
    },
  };
}

const CERTIFIED = signCertification(cert(1, entry("15.4")), KEY);

function rig(
  o: {
    files?: Record<string, string>;
    shell?: ShellCode | undefined;
    app?: string | undefined;
    now?: () => number;
  } = {},
) {
  const db = openBridgeDatabase(":memory:");
  const journal = new Journal(db);
  const cache = new ManifestCache(db, [PUB]);
  const fetched: string[] = [];
  const files = o.files ?? {
    [artifactManifestUrl("0.6.0")]: ARTIFACT_TEXT,
    [CERTIFICATION_MANIFEST_URL]: CERTIFIED,
  };
  const fetch: FetchText = async (url) => {
    fetched.push(url);
    const t = files[url];
    if (t === undefined) throw new Error("offline");
    return t;
  };
  const sh = "shell" in o ? o.shell : shell();
  const app = "app" in o ? o.app : bundle();
  const gate = new WriteGate({
    db,
    cache,
    journal,
    ...(sh === undefined ? {} : { shell: sh }),
    ...(app === undefined ? {} : { appBundle: app }),
    version: "0.6.0",
    macOS: "15.4",
    fetch,
    arch: "arm64",
    ...(o.now === undefined ? {} : { now: o.now }),
  });
  return { db, journal, cache, gate, fetched };
}

describe("nestedMachO: what the shell is asked about (A§9.1 (5))", () => {
  it("every Mach-O with this slice, but the shell and the seal, sorted", () => {
    const app = bundle();
    expect(nestedMachO(app, "arm64")).toEqual(NESTED.map((n) => n.path).sort());
    expect(nestedMachO(app, "x86_64")).toEqual(
      [...NESTED.map((n) => n.path), "Contents/Resources/x86-only.dylib"].sort(),
    );
  });
});

describe("WriteGate.check (A§9.1–9.2)", () => {
  it("online, the fixture's build on a certified macOS: writes; kept for status and Check", async () => {
    const r = rig();
    const d = await r.gate.check("start");
    expect([d.state, d.writes]).toEqual(["certified", true]);
    expect(r.gate.decision).toBe(d);
    expect(keptGate(r.db)).toMatchObject({
      state: "certified",
      reason: "certified",
      macOS: "15.4",
      artifactSliceId: ARTIFACT.manifest.slices.arm64.shell,
      manifestSha256: ARTIFACT.manifestSha256,
    });
    expect(r.journal.list().map((e) => [e.key, e.params?.state])).toContainEqual([
      "cert.state",
      "certified",
    ]);
  });

  it("before the first check, and outside the app (no shell): preview", async () => {
    const r = rig({ shell: undefined });
    expect(r.gate.decision.writes).toBe(false);
    const d = await r.gate.check("start");
    expect([d.state, d.reason, d.writes]).toEqual(["unavailable", "no-identity", false]);
  });

  it("first start offline: no copy of a manifest → preview (unavailable)", async () => {
    const r = rig({ files: {} });
    const d = await r.gate.check("start");
    expect([d.state, d.reason, d.writes]).toEqual(["unavailable", "no-artifact-manifest", false]);
    // The certification manifest alone is not enough either.
    const c = rig({ files: { [CERTIFICATION_MANIFEST_URL]: CERTIFIED } });
    expect((await c.gate.check("start")).reason).toBe("no-artifact-manifest");
  });

  it("offline later: the kept copies decide", async () => {
    const r = rig();
    await r.gate.check("start");
    const again = new WriteGate({
      db: r.db,
      cache: r.cache,
      journal: r.journal,
      shell: shell(),
      appBundle: bundle(),
      version: "0.6.0",
      macOS: "15.4",
      fetch: async () => {
        throw new Error("offline");
      },
      arch: "arm64",
    });
    expect((await again.check("start")).writes).toBe(true);
  });

  it("a helper of another valid build on disk, before its start: mismatch, preview", async () => {
    const helper = NESTED[0]?.path as string;
    const s = shell();
    const other: ShellCode = {
      identity: async (paths) => {
        const i = await s.identity(paths);
        return {
          ...i,
          nested: i.nested.map((n) => (n.path === helper ? { ...n, cdhash: "e".repeat(40) } : n)),
        };
      },
    };
    const r = rig({ shell: other });
    const d = await r.gate.check("helper");
    expect([d.state, d.reason, d.writes]).toEqual(["mismatch", "nested-cdhash", false]);
    expect(keptGate(r.db)?.detail).toContain(helper);
    expect(r.journal.list().find((e) => e.key === "cert.state")?.params).toMatchObject({
      state: "mismatch",
      when: "helper",
    });
  });

  it("the shell's signature check fails, or the shell does not answer: preview", async () => {
    const bad = rig({
      shell: shell({ validity: { ok: false, detail: "a sealed resource is missing" } }),
    });
    expect((await bad.gate.check("start")).reason).toBe("code-invalid");
    const silent = rig({
      shell: {
        identity: async () => {
          throw new Error("the shell did not answer the code check");
        },
      },
    });
    expect((await silent.gate.check("start")).state).toBe("unavailable");
  });

  it("the certification manifest is fetched again only after CERTIFICATION_REFRESH_MS", async () => {
    let t = Date.parse("2026-11-20T00:00:00Z");
    const r = rig({ now: () => t });
    await r.gate.check("start");
    await r.gate.check("helper");
    expect(r.fetched.filter((u) => u === CERTIFICATION_MANIFEST_URL)).toHaveLength(1);
    // The artifact manifest of this version is kept: not fetched again.
    expect(r.fetched.filter((u) => u === artifactManifestUrl("0.6.0"))).toHaveLength(1);
    t += CERTIFICATION_REFRESH_MS;
    await r.gate.check("helper");
    expect(r.fetched.filter((u) => u === CERTIFICATION_MANIFEST_URL)).toHaveLength(2);
  });

  it("a state change is journaled once; the same state again is not", async () => {
    const r = rig();
    await r.gate.check("start");
    await r.gate.check("helper");
    expect(r.journal.list().filter((e) => e.key === "cert.state")).toHaveLength(1);
  });
});

describe("ManifestCache.prune: the artifact manifests kept are bounded", () => {
  it(`keeps the ${ARTIFACT_MANIFESTS_KEPT} most recently stored`, () => {
    const db = openBridgeDatabase(":memory:");
    const cache = new ManifestCache(db, [PUB]);
    cache.storeArtifact(ARTIFACT_TEXT, new Date("2026-11-01T00:00:00Z"));
    for (const [i, sha] of ["a", "b", "c"].entries())
      db.prepare(
        "INSERT INTO artifact_manifest (manifest_sha256, text, stored_at) VALUES (?, ?, ?)",
      ).run(sha.repeat(64), "{}", `2026-11-0${i + 2}T00:00:00.000Z`);
    cache.prune(ARTIFACT_MANIFESTS_KEPT);
    const left = db
      .prepare("SELECT manifest_sha256 FROM artifact_manifest ORDER BY stored_at")
      .all();
    expect(left).toEqual([
      { manifest_sha256: "b".repeat(64) },
      { manifest_sha256: "c".repeat(64) },
    ]);
  });
});

describe("review #45-2: a withdrawal reaches a running process without a restart of the helper", () => {
  it("certified at the start; withdrawn published; the next refresh turns writes off (A§9.2)", async () => {
    let t = Date.parse("2026-11-20T00:00:00Z");
    const files: Record<string, string> = {
      [artifactManifestUrl("0.6.0")]: ARTIFACT_TEXT,
      [CERTIFICATION_MANIFEST_URL]: CERTIFIED,
    };
    const s = shell();
    const r = rig({ files, shell: s, now: () => t });
    expect((await r.gate.check("start")).writes).toBe(true);
    let tick: (() => void) | undefined;
    const changed: boolean[] = [];
    const stop = refreshGate({
      gate: r.gate,
      changed: (d) => void changed.push(d.writes),
      timers: {
        setInterval: (fn) => {
          tick = fn;
          return 1;
        },
        clearInterval: () => {
          tick = undefined;
        },
      },
    });
    // The helper keeps running: no start, no restart. The certify workflow publishes seq 2.
    files[CERTIFICATION_MANIFEST_URL] = signCertification(
      cert(2, entry("15.4", { status: "withdrawn" })),
      KEY,
    );
    t += CERTIFICATION_REFRESH_MS;
    tick?.();
    await vi.waitFor(() => expect(changed).toEqual([false]));
    expect(r.gate.decision).toMatchObject({ state: "withdrawn", writes: false });
    expect(keptGate(r.db)?.state).toBe("withdrawn");
    // A refresh that changes nothing calls nothing; stop() ends the ticks.
    t += CERTIFICATION_REFRESH_MS;
    tick?.();
    await vi.waitFor(() => expect(s.asked.length).toBe(3));
    expect(changed).toEqual([false]);
    stop();
    expect(tick).toBeUndefined();
  });
});

describe("review #45-3: downloads follow redirects only to GitHub over HTTPS", () => {
  /** A fake network: url → [status, location?, body?]; what was requested. */
  function net(routes: Record<string, [number, (string | undefined)?, string?]>) {
    const asked: string[] = [];
    const impl = (async (u: URL | string) => {
      const url = String(u);
      asked.push(url);
      const [status, location, body] = routes[url] ?? [404];
      return new Response(status >= 300 && status < 400 ? null : (body ?? ""), {
        status,
        headers: location === undefined ? {} : { location },
      });
    }) as typeof fetch;
    return { asked, get: guardedFetchText(impl) };
  }
  const START = CERTIFICATION_MANIFEST_URL;
  const ASSET = "https://release-assets.githubusercontent.com/github-production-release-asset/1";

  it("a release asset through GitHub's own redirects is downloaded", async () => {
    expect(DOWNLOAD_HOSTS.has("github.com")).toBe(true);
    const n = net({
      [START]: [302, "/openlfcp/bridge/releases/download/v0.6.0/certification-manifest.json"],
      "https://github.com/openlfcp/bridge/releases/download/v0.6.0/certification-manifest.json": [
        302,
        ASSET,
      ],
      [ASSET]: [200, undefined, "signed"],
    });
    expect(await n.get(START)).toBe("signed");
    expect(n.asked).toHaveLength(3);
  });

  it("a redirect elsewhere, to plain HTTP, or without end is refused before it is requested", async () => {
    const elsewhere = net({ [START]: [302, "https://evil.example/m.json"] });
    await expect(elsewhere.get(START)).rejects.toThrow("download refused: https://evil.example");
    expect(elsewhere.asked).toEqual([START]);
    const http = net({ [START]: [301, "http://objects.githubusercontent.com/x"] });
    await expect(http.get(START)).rejects.toThrow("download refused: http:");
    expect(http.asked).toEqual([START]);
    const loop = net({ [START]: [302, START] });
    await expect(loop.get(START)).rejects.toThrow("too many redirects");
    await expect(net({}).get("https://evil.example/x")).rejects.toThrow("download refused");
  });
});
