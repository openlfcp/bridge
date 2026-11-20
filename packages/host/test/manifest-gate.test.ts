// L0 of the write gate by the manifests (A§9.1, E14; E-051a): the decision over the five checks,
// with a fake source of the code checks (3)–(5) that the shell makes in E-051b. The artifact
// manifest is the shared fixture of the release chain (E-052).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ManifestCache } from "../src/artifact/cache.js";
import type { CertificationManifest } from "../src/artifact/certification.js";
import { signCertification } from "../src/artifact/certification.js";
import {
  type CodeIdentity,
  type CodeIdentitySource,
  checkGate,
  decideGate,
  type GateDecision,
} from "../src/artifact/gate.js";
import type { Arch } from "../src/artifact/manifest.js";
import { openBridgeDatabase } from "../src/db/database.js";
import {
  ARTIFACT,
  ARTIFACT_TEXT,
  cert,
  entry,
  KEY,
  OTHER_SHA,
  PUB,
  SHA,
  slice,
} from "./support/certification.js";

/** What the shell of the fixture's build reports on arm64; `edit` breaks it. */
function identity(
  edit: (i: { -readonly [K in keyof CodeIdentity]: CodeIdentity[K] }) => void = () => {},
): CodeIdentity {
  const i = {
    arch: "arm64" as Arch,
    validity: { ok: true } as CodeIdentity["validity"],
    runningShell: ARTIFACT.manifest.slices.arm64.shell,
    nested: ARTIFACT.manifest.slices.arm64.nested.map((n) => ({ ...n })),
  };
  edit(i);
  return i;
}

const gate = (o: {
  certification?: CertificationManifest | undefined;
  identity?: CodeIdentity | Error;
  macOS?: string;
}): GateDecision =>
  decideGate({
    artifacts: [ARTIFACT],
    certification: o.certification,
    identity: o.identity ?? identity(),
    macOS: o.macOS ?? "15.4",
  });

describe("the gate: five checks, anything but a pass is preview (A§9.1)", () => {
  const certified = cert(1, entry("15.4"));

  it("all five hold: certified, writes", () => {
    expect(gate({ certification: certified })).toMatchObject({
      state: "certified",
      writes: true,
      reason: "certified",
      manifestSha256: SHA,
      artifactSliceId: ARTIFACT.manifest.slices.arm64.shell,
    });
  });

  it("(2) a record on another manifestSha256, another slice, another arch: preview", () => {
    for (const e of [
      entry("15.4", { manifestSha256: OTHER_SHA }),
      entry("15.4", { artifactSliceId: "2".repeat(40) }),
      entry("15.4", slice("x86_64")),
    ])
      expect(gate({ certification: cert(1, e) })).toMatchObject({
        state: "uncertified",
        writes: false,
      });
  });

  it("(2) withdrawn, inherited, not checked, newer than checked", () => {
    expect(gate({ certification: cert(2, entry("15.4", { status: "withdrawn" })) })).toMatchObject({
      state: "withdrawn",
      writes: false,
    });
    expect(gate({ certification: cert(1, entry("15.6")), macOS: "15.4" })).toMatchObject({
      state: "certified",
      writes: true,
      detail: "macOS 15.4 is covered by the certification on macOS 15.6",
    });
    expect(gate({ certification: certified, macOS: "15.5" })).toMatchObject({
      state: "uncertified",
      writes: false,
      detail: "macOS 15.5 is newer than the checked macOS 15.4",
    });
    expect(gate({ certification: certified, macOS: "26.0" })).toMatchObject({
      state: "uncertified",
    });
  });

  it("(3) the code signature does not hold (changed without signing again): mismatch", () => {
    const d = gate({
      certification: certified,
      identity: identity((i) => {
        i.validity = { ok: false, detail: "a sealed resource is modified" };
      }),
    });
    expect(d).toMatchObject({ state: "mismatch", writes: false, reason: "code-invalid" });
  });

  it("(4) another shell (rebuilt and signed again: another artifactSliceId): mismatch", () => {
    const d = gate({
      certification: certified,
      identity: identity((i) => {
        i.runningShell = "3".repeat(40);
      }),
    });
    expect(d).toMatchObject({ state: "mismatch", writes: false, reason: "shell-cdhash" });
    // The x86_64 shell of the same build run as arm64 is not the arm64 slice either.
    expect(
      gate({
        certification: certified,
        identity: identity((i) => {
          i.runningShell = ARTIFACT.manifest.slices.x86_64.shell;
        }),
      }),
    ).toMatchObject({ state: "mismatch", reason: "shell-cdhash" });
  });

  it("(5) the helper replaced by another valid build with the same DR: mismatch", () => {
    const helper = "Contents/MacOS/lfcp-reminders-helper";
    const swapped = identity((i) => {
      i.nested = i.nested.map((n) => (n.path === helper ? { ...n, cdhash: "4".repeat(40) } : n));
    });
    expect(gate({ certification: certified, identity: swapped })).toMatchObject({
      state: "mismatch",
      writes: false,
      reason: "nested-cdhash",
    });
    const missing = identity((i) => {
      i.nested = i.nested.filter((n) => n.path !== helper);
    });
    expect(gate({ certification: certified, identity: missing })).toMatchObject({
      reason: "nested-cdhash",
      detail: `nested code: ${helper}: missing`,
    });
    const extra = identity((i) => {
      i.nested = [...i.nested, { path: "Contents/Frameworks/x.dylib", cdhash: "5".repeat(40) }];
    });
    expect(gate({ certification: certified, identity: extra })).toMatchObject({
      reason: "nested-cdhash",
    });
  });

  it("mismatch wins over the certification; nothing kept is unavailable", () => {
    const d = gate({
      certification: undefined,
      identity: identity((i) => {
        i.runningShell = "3".repeat(40);
      }),
    });
    expect(d.state).toBe("mismatch");
    expect(gate({ certification: undefined })).toMatchObject({
      state: "unavailable",
      writes: false,
      reason: "no-certification-manifest",
    });
    expect(
      decideGate({ artifacts: [], certification: certified, identity: identity(), macOS: "15.4" }),
    ).toMatchObject({ state: "unavailable", writes: false, reason: "no-artifact-manifest" });
  });
});

describe("checkGate: the cache and the code source", () => {
  it("reads what is kept and asks the shell, every time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "manifest-gate-"));
    const db = openBridgeDatabase(join(dir, "bridge.sqlite"));
    try {
      const cache = new ManifestCache(db, [PUB]);
      const source = (i: CodeIdentity | Error): CodeIdentitySource => ({
        identity: async () => {
          if (i instanceof Error) throw i;
          return i;
        },
      });
      const run = (i: CodeIdentity | Error) =>
        checkGate({ cache, code: source(i), macOS: "15.4.1" });
      expect(await run(identity())).toMatchObject({
        state: "unavailable",
        reason: "no-artifact-manifest",
      });
      cache.storeArtifact(ARTIFACT_TEXT);
      expect(await run(identity())).toMatchObject({
        state: "unavailable",
        reason: "no-certification-manifest",
      });
      cache.offerCertification(signCertification(cert(1, entry("15.4")), KEY));
      expect(await run(identity())).toMatchObject({ state: "certified", writes: true });
      expect(await run(new Error("the shell did not answer"))).toMatchObject({
        state: "unavailable",
        reason: "no-identity",
        writes: false,
      });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
