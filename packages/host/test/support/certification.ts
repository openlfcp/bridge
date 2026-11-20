// Shared by the L0 tests of the certification manifest and the write gate (E-051): the artifact
// manifest of the release chain's shared fixture, its test key, and records for its slices.

import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CERTIFICATION_MANIFEST_FORMAT,
  type CertificationEntry,
  type CertificationManifest,
} from "../../src/artifact/certification.js";
import {
  type Arch,
  ArtifactManifestError,
  parseSignedManifest,
} from "../../src/artifact/manifest.js";

const FIXTURE = join(import.meta.dirname, "../fixtures/artifact-manifest");
export const KEY = createPrivateKey(readFileSync(join(FIXTURE, "test-key.pem")));
export const PUB = readFileSync(join(FIXTURE, "test-key.pub"), "utf8").trim();
export const ARTIFACT_TEXT = readFileSync(join(FIXTURE, "artifact-manifest.json"), "utf8");
export const ARTIFACT = parseSignedManifest(ARTIFACT_TEXT, [PUB]);
export const SHA = ARTIFACT.manifestSha256;
export const OTHER_SHA = "f".repeat(64);
export const OTHER_KEY = generateKeyPairSync("ed25519").privateKey;

/** The record key of the fixture's build for one slice. */
export const slice = (arch: Arch) => ({
  manifestSha256: SHA,
  artifactSliceId: ARTIFACT.manifest.slices[arch].shell,
  arch,
});

/** A certified arm64 record of the fixture's build; `more` changes it. */
export function entry(macos: string, more: Partial<CertificationEntry> = {}): CertificationEntry {
  return {
    ...slice("arm64"),
    macos,
    osBuilds: ["24E248"],
    status: "certified",
    scenariosVersion: "scenarios-v1-auto/1",
    report: "https://github.com/openlfcp/bridge/actions/runs/1",
    ...more,
  };
}

export function cert(seq: number, ...entries: CertificationEntry[]): CertificationManifest {
  return { format: CERTIFICATION_MANIFEST_FORMAT, seq, entries };
}

/** The code of the ArtifactManifestError `f` throws, "accepted" if none. */
export const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (e instanceof ArtifactManifestError) return e.code;
    throw e;
  }
  return "accepted";
};
