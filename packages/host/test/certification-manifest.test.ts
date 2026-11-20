// L0 of the public certification manifest (A§9.2–9.3, E14a/b; E-051a): signature, seq,
// withdrawn, inheritance down the minors, and the cache that keeps only a greater seq.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManifestCache } from "../src/artifact/cache.js";
import { coverage, parseCertification, signCertification } from "../src/artifact/certification.js";
import { ArtifactManifestError, canonicalJson, rawPublicKey } from "../src/artifact/manifest.js";
import { type BridgeDatabase, openBridgeDatabase } from "../src/db/database.js";
import {
  ARTIFACT_TEXT,
  cert,
  code,
  entry,
  KEY,
  OTHER_KEY,
  OTHER_SHA,
  PUB,
  SHA,
  slice,
} from "./support/certification.js";

describe("public certification manifest (A§9.2)", () => {
  it("signed, canonical, round-trips", () => {
    const m = cert(3, entry("15.4"), entry("15.4", slice("x86_64")));
    const text = signCertification(m, KEY);
    expect(parseCertification(text, [PUB])).toEqual(m);
    expect(canonicalJson(JSON.parse(text))).toBe(text);
  });

  it("refuses another key, a forged signature, a changed seq, a lone surrogate, a second record", () => {
    const text = signCertification(cert(3, entry("15.4")), KEY);
    expect(code(() => parseCertification(text, [rawPublicKey(OTHER_KEY)]))).toBe("untrusted-key");
    // Signed by another key, claiming the trusted public key.
    const forged = JSON.parse(signCertification(cert(9, entry("15.4")), OTHER_KEY));
    forged.signature.publicKey = PUB;
    expect(code(() => parseCertification(canonicalJson(forged), [PUB]))).toBe("bad-signature");
    // A higher seq written over a signed manifest without signing it again.
    const bumped = JSON.parse(text);
    bumped.certification.seq = 4;
    expect(code(() => parseCertification(canonicalJson(bumped), [PUB]))).toBe("bad-signature");
    const lone = text.replace('"scenarios-v1-auto/1"', '"scenarios-v1-auto/1\\ud800"');
    expect(code(() => parseCertification(lone, [PUB]))).toBe("malformed");
    expect(code(() => signCertification(cert(1, entry("15.4"), entry("15.4")), KEY))).toBe(
      "malformed",
    );
    expect(code(() => signCertification(cert(1, entry("15.4.1")), KEY))).toBe("malformed");
    expect(code(() => signCertification(cert(-1), KEY))).toBe("malformed");
    expect(
      code(() =>
        signCertification(
          { ...cert(1), format: "openlfcp-bridge-certification-manifest/2" } as never,
          KEY,
        ),
      ),
    ).toBe("format");
  });
});

describe("which macOS writes (A§9.3, E14a/b)", () => {
  const arm = slice("arm64");

  it("the exact major.minor certified: any build of it", () => {
    const c = coverage(cert(1, entry("15.4")), arm, "15.4.1");
    expect(c).toMatchObject({ kind: "certified", entry: { macos: "15.4" } });
    expect(c).not.toHaveProperty("inheritedFrom");
  });

  it("another slice, another arch, another manifestSha256: not this one's record", () => {
    for (const other of [
      entry("15.4", { artifactSliceId: "1".repeat(40) }),
      entry("15.4", { arch: "x86_64" }),
      entry("15.4", { manifestSha256: OTHER_SHA }),
    ])
      expect(coverage(cert(1, other), arm, "15.4")).toEqual({
        kind: "uncertified",
        relation: "untested",
      });
  });

  it("inherits down within the major from the lowest certified higher minor (E14b)", () => {
    const m = cert(1, entry("15.6"), entry("15.5"));
    expect(coverage(m, arm, "15.2")).toMatchObject({ kind: "certified", inheritedFrom: "15.5" });
    expect(coverage(m, arm, "15.0")).toMatchObject({ kind: "certified", inheritedFrom: "15.5" });
  });

  it("never across a major, never below the floor 15.0", () => {
    expect(coverage(cert(1, entry("26.2")), arm, "15.7")).toMatchObject({
      kind: "uncertified",
      relation: "untested",
    });
    expect(coverage(cert(1, entry("14.6")), arm, "14.2")).toMatchObject({
      kind: "uncertified",
      relation: "untested",
    });
  });

  it("a newer minor or major than the certified ones: 'newer than checked'", () => {
    expect(coverage(cert(1, entry("26.2")), arm, "26.3")).toEqual({
      kind: "uncertified",
      relation: "newer",
      newestCertified: "26.2",
    });
    expect(coverage(cert(1, entry("26.2")), arm, "27.0")).toMatchObject({ relation: "newer" });
  });

  it("withdrawn: the exact minor, even with a certified higher one; inheritance from a withdrawn one", () => {
    const m = cert(2, entry("15.5"), entry("15.3", { status: "withdrawn" }));
    expect(coverage(m, arm, "15.3")).toMatchObject({ kind: "withdrawn", entry: { macos: "15.3" } });
    expect(coverage(m, arm, "15.2")).toMatchObject({ kind: "certified", inheritedFrom: "15.5" });
    const w = cert(2, entry("15.5", { status: "withdrawn" }));
    expect(coverage(w, arm, "15.5")).toMatchObject({ kind: "withdrawn" });
    expect(coverage(w, arm, "15.2")).toMatchObject({ kind: "withdrawn", entry: { macos: "15.5" } });
    // A withdrawn higher minor does not cover; a certified one above it still does.
    const both = cert(3, entry("15.4", { status: "withdrawn" }), entry("15.6"));
    expect(coverage(both, arm, "15.2")).toMatchObject({ kind: "certified", inheritedFrom: "15.6" });
  });
});

describe("the cache keeps only a greater seq (A§9.2)", () => {
  let dir: string;
  let db: BridgeDatabase;
  let cache: ManifestCache;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "manifest-gate-"));
    db = openBridgeDatabase(join(dir, "bridge.sqlite"));
    cache = new ManifestCache(db, [PUB]);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores the first, a greater seq; refuses an older one, another text with the same seq", () => {
    const v3 = signCertification(cert(3, entry("15.4")), KEY);
    expect(cache.offerCertification(v3)).toEqual({ kind: "stored", seq: 3 });
    expect(cache.offerCertification(v3)).toEqual({ kind: "same", seq: 3 });
    const old = signCertification(cert(2, entry("15.4"), entry("15.5")), KEY);
    expect(cache.offerCertification(old)).toEqual({ kind: "stale", seq: 2, kept: 3 });
    const twin = signCertification(cert(3, entry("15.4", { status: "withdrawn" })), KEY);
    expect(cache.offerCertification(twin)).toEqual({ kind: "conflict", seq: 3 });
    expect(cache.certification()?.entries[0]?.status).toBe("certified");
    const v4 = signCertification(cert(4, entry("15.4", { status: "withdrawn" })), KEY);
    expect(cache.offerCertification(v4)).toEqual({ kind: "stored", seq: 4 });
    expect(cache.certification()?.seq).toBe(4);
  });

  it("refuses an invalid one; a kept row whose text does not verify is not read", () => {
    const foreign = signCertification(cert(99, entry("15.4")), OTHER_KEY);
    expect(cache.offerCertification(foreign)).toMatchObject({
      kind: "invalid",
      code: "untrusted-key",
    });
    expect(cache.certification()).toBeUndefined();
    const v1 = signCertification(cert(1, entry("15.4")), KEY);
    cache.offerCertification(v1);
    db.prepare("UPDATE certification_manifest SET text = ?").run(v1.replace('"seq":1', '"seq":7'));
    expect(cache.certification()).toBeUndefined();
  });

  it("the kept seq is the floor, whatever the kept text (review E-051a major)", () => {
    const v1 = signCertification(cert(1, entry("15.4")), KEY);
    const v2 = signCertification(cert(2, entry("15.4", { status: "withdrawn" })), KEY);
    cache.offerCertification(v2);
    // An older signed text put in place of the newer one: its seq is not the kept one.
    db.prepare("UPDATE certification_manifest SET text = ?").run(v1);
    expect(cache.certification()).toBeUndefined();
    // A damaged text does not lower the floor: the older one is still stale, the same seq repairs.
    db.prepare("UPDATE certification_manifest SET text = '{}'").run();
    expect(cache.offerCertification(v1)).toEqual({ kind: "stale", seq: 1, kept: 2 });
    expect(cache.certification()).toBeUndefined();
    expect(cache.offerCertification(v2)).toEqual({ kind: "stored", seq: 2 });
    expect(cache.certification()?.entries[0]?.status).toBe("withdrawn");
    // A seq raised in place (no text for it) blocks until a signed manifest reaches it: preview.
    db.prepare("UPDATE certification_manifest SET seq = 50").run();
    expect(cache.certification()).toBeUndefined();
    expect(cache.offerCertification(signCertification(cert(3), KEY))).toMatchObject({
      kind: "stale",
      kept: 50,
    });
  });

  it("artifact manifests: only valid ones are stored and read back", () => {
    expect(cache.storeArtifact(ARTIFACT_TEXT)).toBe(SHA);
    expect(cache.storeArtifact(ARTIFACT_TEXT)).toBe(SHA);
    expect(() => cache.storeArtifact(ARTIFACT_TEXT.replace('"build":"', '"build":"9'))).toThrow(
      ArtifactManifestError,
    );
    db.prepare(
      "INSERT INTO artifact_manifest (manifest_sha256, text, stored_at) VALUES (?, ?, ?)",
    ).run(OTHER_SHA, ARTIFACT_TEXT.replace('"build":"', '"build":"9'), "2026-11-20T00:00:00Z");
    expect(cache.artifacts().map((a) => a.manifestSha256)).toEqual([SHA]);
  });
});
