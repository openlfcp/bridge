// The public certification manifest (A§9.2–9.3, E14a/b): which artifact slice, by the
// manifestSha256 of its artifact manifest (A§9.1), passed the required scenarios on which macOS.
// It is separate from the artifact manifest and changes after the release: the certify workflow
// (E-055) adds a record with `seq + 1`, a withdrawal flips a record to `withdrawn`.
//
// The file is canonical JSON (RFC 8785), signed like artifact-manifest.json:
//   {certification: {format, seq, entries: [{manifestSha256, artifactSliceId, arch, macos,
//                    osBuilds, status: certified|withdrawn, scenariosVersion, report}]},
//    signature: {alg: "Ed25519", publicKey, value}}
// The signature is over the canonical bytes of `certification`. `macos` is major.minor; `osBuilds`
// the builds the runs were on (evidence; the key is major.minor, A§9.3); one record per
// (manifestSha256, artifactSliceId, arch, macos).
//
// Which macOS writes (A§9.3): a certified record for this slice and this major.minor; without one,
// a certified x.y covers x.(<y) of the same major, not below the floor 15.0 (E14b, E15). A record
// for the exact minor wins over inheritance, so a withdrawal can single out one minor. Anything
// else is preview.

import type { KeyObject } from "node:crypto";
import {
  ARCHS,
  type Arch,
  ArtifactManifestError,
  canonicalJson,
  type ManifestSignature,
  record,
  signBody,
  str,
  verifySigned,
} from "./manifest.js";

export const CERTIFICATION_MANIFEST_FORMAT = "openlfcp-bridge-certification-manifest/1";
/** The lowest macOS the bridge supports (E15); inheritance never reaches below it. */
export const MACOS_FLOOR = { major: 15, minor: 0 } as const;

export type CertificationStatus = "certified" | "withdrawn";
export interface CertificationEntry {
  manifestSha256: string;
  artifactSliceId: string;
  arch: Arch;
  macos: string;
  osBuilds: string[];
  status: CertificationStatus;
  scenariosVersion: string;
  report: string;
}
export interface CertificationManifest {
  format: typeof CERTIFICATION_MANIFEST_FORMAT;
  seq: number;
  entries: CertificationEntry[];
}

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAJOR_MINOR = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export interface MacOSVersion {
  readonly major: number;
  readonly minor: number;
}

/** "15.4.1" / "15.4" / "15" → {15, 4}; undefined if it is not a version. */
export function parseMacOS(version: string): MacOSVersion | undefined {
  const m = /^(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*))?(?:\.(0|[1-9][0-9]*))?$/.exec(version.trim());
  if (m === null) return undefined;
  return { major: Number(m[1]), minor: Number(m[2] ?? 0) };
}

const cmp = (a: MacOSVersion, b: MacOSVersion) => a.major - b.major || a.minor - b.minor;

/** Checks the shape of a certification manifest (not its signature) and returns it typed. */
export function validateCertification(v: unknown): CertificationManifest {
  const m = record(v, "certification", ["format", "seq", "entries"]);
  if (m.format !== CERTIFICATION_MANIFEST_FORMAT)
    throw new ArtifactManifestError("format", String(m.format));
  if (typeof m.seq !== "number" || !Number.isSafeInteger(m.seq) || m.seq < 0)
    throw new ArtifactManifestError("malformed", "seq");
  if (!Array.isArray(m.entries)) throw new ArtifactManifestError("malformed", "entries");
  const keys = new Set<string>();
  m.entries.forEach((x, i) => {
    const at = `entries[${i}]`;
    const e = record(x, at, [
      "manifestSha256",
      "artifactSliceId",
      "arch",
      "macos",
      "osBuilds",
      "status",
      "scenariosVersion",
      "report",
    ]);
    str(e.manifestSha256, `${at}.manifestSha256`, HEX64);
    str(e.artifactSliceId, `${at}.artifactSliceId`, HEX40);
    if (!ARCHS.includes(e.arch as Arch)) throw new ArtifactManifestError("malformed", `${at}.arch`);
    str(e.macos, `${at}.macos`, MAJOR_MINOR);
    if (!Array.isArray(e.osBuilds)) throw new ArtifactManifestError("malformed", `${at}.osBuilds`);
    e.osBuilds.forEach((b, j) => {
      str(b, `${at}.osBuilds[${j}]`);
    });
    if (e.status !== "certified" && e.status !== "withdrawn")
      throw new ArtifactManifestError("malformed", `${at}.status`);
    str(e.scenariosVersion, `${at}.scenariosVersion`);
    str(e.report, `${at}.report`);
    const key = `${e.manifestSha256} ${e.artifactSliceId} ${e.arch} ${e.macos}`;
    if (keys.has(key)) throw new ArtifactManifestError("malformed", `${at}: a second record`);
    keys.add(key);
  });
  return m as unknown as CertificationManifest;
}

/** The file of the public certification manifest, signed. */
export function signCertification(manifest: CertificationManifest, key: KeyObject): string {
  validateCertification(manifest);
  const signature: ManifestSignature = signBody(manifest, key);
  return canonicalJson({ certification: manifest, signature });
}

/**
 * Reads a public certification manifest: canonical, well formed, signed by one of `trustedKeys`.
 * Throws ArtifactManifestError otherwise. The `seq` rule is the cache's (cache.ts).
 */
export function parseCertification(
  text: string,
  trustedKeys: readonly string[],
): CertificationManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ArtifactManifestError("malformed", "not JSON");
  }
  const doc = record(parsed, "document", ["certification", "signature"]);
  const manifest = validateCertification(doc.certification);
  verifySigned(parsed, doc.signature, manifest, text, trustedKeys);
  return manifest;
}

/** The slice a record must name: its artifact manifest and the shell's cdhash in that slice. */
export interface SliceKey {
  readonly manifestSha256: string;
  readonly artifactSliceId: string;
  readonly arch: Arch;
}

export type Coverage =
  | {
      readonly kind: "certified";
      readonly entry: CertificationEntry;
      /** The higher minor it is inherited from (E14b); absent for the exact minor. */
      readonly inheritedFrom?: string;
    }
  | { readonly kind: "withdrawn"; readonly entry: CertificationEntry }
  | {
      readonly kind: "uncertified";
      /**
       * newer: this macOS is newer than every certified one of this slice ("newer than checked");
       * untested: nothing certified covers it (another major, below the floor, no record at all).
       */
      readonly relation: "newer" | "untested";
      /** The newest certified macOS of this slice, if any. */
      readonly newestCertified?: string;
    };

/** Whether this slice writes on `macOS` by the manifest (A§9.3, E14a/b). */
export function coverage(
  manifest: CertificationManifest,
  slice: SliceKey,
  macOS: string,
): Coverage {
  const os = parseMacOS(macOS);
  const mine = manifest.entries
    .filter(
      (e) =>
        e.manifestSha256 === slice.manifestSha256 &&
        e.artifactSliceId === slice.artifactSliceId &&
        e.arch === slice.arch,
    )
    .map((e) => ({ e, v: parseMacOS(e.macos) as MacOSVersion }));
  const certified = mine.filter((x) => x.e.status === "certified").sort((a, b) => cmp(a.v, b.v));
  const newest = certified.at(-1);
  const uncertified = (relation: "newer" | "untested"): Coverage => ({
    kind: "uncertified",
    relation,
    ...(newest === undefined ? {} : { newestCertified: newest.e.macos }),
  });
  if (os === undefined || cmp(os, MACOS_FLOOR) < 0) return uncertified("untested");
  const exact = mine.find((x) => cmp(x.v, os) === 0);
  if (exact !== undefined)
    return exact.e.status === "certified"
      ? { kind: "certified", entry: exact.e }
      : { kind: "withdrawn", entry: exact.e };
  // E14b: the lowest certified higher minor of the same major covers this one.
  const sameMajorHigher = mine
    .filter((x) => x.v.major === os.major && x.v.minor > os.minor)
    .sort((a, b) => cmp(a.v, b.v));
  const cover = sameMajorHigher.find((x) => x.e.status === "certified");
  if (cover !== undefined)
    return { kind: "certified", entry: cover.e, inheritedFrom: cover.e.macos };
  const withdrawn = sameMajorHigher[0];
  if (withdrawn !== undefined) return { kind: "withdrawn", entry: withdrawn.e };
  return uncertified(newest !== undefined && cmp(newest.v, os) < 0 ? "newer" : "untested");
}
