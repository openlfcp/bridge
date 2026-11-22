// The detached artifact manifest of LFCP Bridge.app (A§9.1): what one signed, notarized and
// stapled build is, file by file and slice by slice. The release chain (E-052,
// scripts/release/artifact-manifest.mjs) builds and signs it after the staple; the write gate
// (E-051) reads it with parseSignedManifest and compares the bundle on disk with it.
//
// The file artifact-manifest.json is the canonical JSON (RFC 8785 for the values used here:
// strings, safe integers, arrays, objects) of
//   {manifest: {format, app, version, build, slices: {arm64: {shell, nested: [{path, cdhash}]},
//               x86_64: {…}}, resourceSealHash, files: [{path, sha256} | {path, symlink}]},
//    signature: {alg: "Ed25519", publicKey, value}}
// The signature (base64) is over the canonical bytes of `manifest`, and manifestSha256 is the
// SHA-256 of those same bytes. A cdhash is the code directory hash codesign reports (CDHash,
// kSecCodeInfoUnique), lowercase hex. Paths are relative to the bundle, NFC, sorted by their
// UTF-8 bytes; files[] is every file of the bundle except Contents/_CodeSignature/* and
// Contents/CodeResources (the staple ticket); resourceSealHash is the SHA-256 of
// Contents/_CodeSignature/CodeResources, the shell's resource seal.

import { createHash, createPublicKey, type KeyObject, sign, verify } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export const ARTIFACT_MANIFEST_FORMAT = "openlfcp-bridge-artifact-manifest/1";
export const ARCHS = ["arm64", "x86_64"] as const;
export type Arch = (typeof ARCHS)[number];
export const SHELL_PATH = "Contents/MacOS/LFCP Bridge";
const SEAL_PATH = "Contents/_CodeSignature/CodeResources";

export interface NestedCode {
  path: string;
  cdhash: string;
}
export interface Slice {
  shell: string;
  nested: NestedCode[];
}
export type BundleFile = { path: string; sha256: string } | { path: string; symlink: string };
export interface ArtifactManifest {
  format: typeof ARTIFACT_MANIFEST_FORMAT;
  app: string;
  version: string;
  build: string;
  slices: Record<Arch, Slice>;
  resourceSealHash: string;
  files: BundleFile[];
}
export interface ManifestSignature {
  alg: "Ed25519";
  publicKey: string;
  value: string;
}
export interface SignedArtifactManifest {
  manifest: ArtifactManifest;
  signature: ManifestSignature;
}

export type ManifestProblem =
  | "malformed"
  | "format"
  | "untrusted-key"
  | "bad-signature"
  | "not-canonical";
export class ArtifactManifestError extends Error {
  constructor(
    readonly code: ManifestProblem,
    detail: string,
  ) {
    super(`artifact manifest: ${code}: ${detail}`);
    this.name = "ArtifactManifestError";
  }
}

/** A lone UTF-16 surrogate: RFC 8785 §3.2.2.2 (I-JSON) has no canonical form for it. */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

function jsonString(s: string): string {
  if (LONE_SURROGATE.test(s)) throw new TypeError("a lone UTF-16 surrogate");
  return JSON.stringify(s);
}

/**
 * RFC 8785 canonical JSON of strings, safe integers, booleans, null, arrays and objects. A string
 * or key with a lone UTF-16 surrogate is not I-JSON and throws, as a non-integer number does.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return jsonString(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`not a safe integer: ${value}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    // UTF-16 code unit order (RFC 8785 §3.2.3): the default sort of JavaScript strings.
    const keys = Object.keys(value).sort();
    const obj = value as Record<string, unknown>;
    return `{${keys
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${jsonString(k)}:${canonicalJson(obj[k])}`)
      .join(",")}}`;
  }
  throw new TypeError(`not JSON: ${typeof value}`);
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export function manifestBytes(manifest: ArtifactManifest): Buffer {
  return Buffer.from(canonicalJson(manifest), "utf8");
}

export function manifestSha256(manifest: ArtifactManifest): string {
  return sha256(manifestBytes(manifest));
}

/** The raw 32-byte Ed25519 public key, base64. */
export function rawPublicKey(key: KeyObject): string {
  const jwk = createPublicKey(key).export({ format: "jwk" });
  if (jwk.crv !== "Ed25519" || typeof jwk.x !== "string") throw new TypeError("not an Ed25519 key");
  return Buffer.from(jwk.x, "base64url").toString("base64");
}

function publicKeyFromRaw(raw: string): KeyObject {
  const x = Buffer.from(raw, "base64");
  if (x.length !== 32 || x.toString("base64") !== raw)
    throw new ArtifactManifestError("malformed", "signature.publicKey");
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: x.toString("base64url") },
    format: "jwk",
  });
}

/** The file artifact-manifest.json: the canonical JSON of the manifest and its signature. */
export function signManifest(manifest: ArtifactManifest, privateKey: KeyObject): string {
  validateManifest(manifest);
  const signature = signBody(manifest, privateKey);
  return canonicalJson({ manifest, signature } satisfies SignedArtifactManifest);
}

/**
 * Reads artifact-manifest.json: canonical, well formed, signed by one of `trustedKeys` (raw
 * base64 Ed25519 public keys). Throws ArtifactManifestError otherwise.
 */
export function parseSignedManifest(
  text: string,
  trustedKeys: readonly string[],
): { manifest: ArtifactManifest; manifestSha256: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ArtifactManifestError("malformed", "not JSON");
  }
  const doc = record(parsed, "document", ["manifest", "signature"]);
  const manifest = validateManifest(doc.manifest);
  const bytes = verifySigned(parsed, doc.signature, manifest, text, trustedKeys);
  return { manifest, manifestSha256: sha256(bytes) };
}

/**
 * The signature part of a signed document `{<body>, signature}` (this manifest, and the public
 * certification manifest of E-051): the whole text is canonical, the key is trusted and the
 * Ed25519 signature is over the canonical bytes of `body`, which it returns.
 */
export function verifySigned(
  parsed: unknown,
  signature: unknown,
  body: unknown,
  text: string,
  trustedKeys: readonly string[],
): Buffer {
  const sig = record(signature, "signature", ["alg", "publicKey", "value"]);
  if (sig.alg !== "Ed25519") throw new ArtifactManifestError("malformed", "signature.alg");
  const publicKey = str(sig.publicKey, "signature.publicKey");
  const value = str(sig.value, "signature.value");
  let canonical: string;
  try {
    canonical = canonicalJson(parsed);
  } catch (e) {
    throw new ArtifactManifestError("malformed", (e as Error).message);
  }
  if (canonical !== text) throw new ArtifactManifestError("not-canonical", "bytes");
  if (!trustedKeys.includes(publicKey)) throw new ArtifactManifestError("untrusted-key", publicKey);
  const bytes = Buffer.from(canonicalJson(body), "utf8");
  if (!verify(null, bytes, publicKeyFromRaw(publicKey), Buffer.from(value, "base64")))
    throw new ArtifactManifestError("bad-signature", "Ed25519");
  return bytes;
}

/** Signs `body` (canonical bytes) with an Ed25519 key: the `signature` of a signed document. */
export function signBody(body: unknown, privateKey: KeyObject): ManifestSignature {
  return {
    alg: "Ed25519",
    publicKey: rawPublicKey(privateKey),
    value: sign(null, Buffer.from(canonicalJson(body), "utf8"), privateKey).toString("base64"),
  };
}

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** An object with exactly `keys`; anything else is ArtifactManifestError("malformed"). */
export function record(v: unknown, at: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new ArtifactManifestError("malformed", `${at}: not an object`);
  const extra = Object.keys(v).filter((k) => !keys.includes(k));
  const missing = keys.filter((k) => !(k in v));
  if (extra.length || missing.length)
    throw new ArtifactManifestError("malformed", `${at}: fields ${[...extra, ...missing]}`);
  return v as Record<string, unknown>;
}

/** A non-empty string without a lone surrogate (PB-41), matching `re` if given. */
export function str(v: unknown, at: string, re?: RegExp): string {
  if (typeof v !== "string" || v === "" || LONE_SURROGATE.test(v) || (re && !re.test(v)))
    throw new ArtifactManifestError("malformed", at);
  return v;
}

const utf8Compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Bundle-relative, NFC, no empty, "." or ".." segment; strictly increasing by UTF-8 bytes. */
function paths(list: readonly string[], at: string): void {
  list.forEach((p, i) => {
    if (p.normalize("NFC") !== p || p.split("/").some((s) => s === "" || s === "." || s === ".."))
      throw new ArtifactManifestError("malformed", `${at}: path ${JSON.stringify(p)}`);
    const prev = list[i - 1];
    if (prev !== undefined && utf8Compare(prev, p) >= 0)
      throw new ArtifactManifestError("malformed", `${at}: not sorted by bytes at ${p}`);
  });
}

/** Checks the shape of a manifest (not its signature) and returns it typed. */
export function validateManifest(v: unknown): ArtifactManifest {
  const keys = ["format", "app", "version", "build", "slices", "resourceSealHash", "files"];
  const m = record(v, "manifest", keys);
  if (m.format !== ARTIFACT_MANIFEST_FORMAT)
    throw new ArtifactManifestError("format", String(m.format));
  for (const k of ["app", "version", "build"]) str(m[k], k);
  str(m.resourceSealHash, "resourceSealHash", HEX64);
  const slices = record(m.slices, "slices", ARCHS);
  for (const arch of ARCHS) {
    const s = record(slices[arch], `slices.${arch}`, ["shell", "nested"]);
    str(s.shell, `slices.${arch}.shell`, HEX40);
    if (!Array.isArray(s.nested)) throw new ArtifactManifestError("malformed", `${arch}.nested`);
    const nested = s.nested.map((n, i) => {
      const e = record(n, `slices.${arch}.nested[${i}]`, ["path", "cdhash"]);
      str(e.cdhash, `slices.${arch}.nested[${i}].cdhash`, HEX40);
      return str(e.path, `slices.${arch}.nested[${i}].path`);
    });
    paths(nested, `slices.${arch}.nested`);
  }
  if (!Array.isArray(m.files)) throw new ArtifactManifestError("malformed", "files");
  const files = m.files.map((f, i) => {
    const link = typeof f === "object" && f !== null && "symlink" in f;
    const e = record(f, `files[${i}]`, ["path", link ? "symlink" : "sha256"]);
    if (link) str(e.symlink, `files[${i}].symlink`);
    else str(e.sha256, `files[${i}].sha256`, HEX64);
    return str(e.path, `files[${i}].path`);
  });
  paths(files, "files");
  return m as unknown as ArtifactManifest;
}

interface Entry {
  file: BundleFile;
  /** The path as the file system spells it (NFD on HFS+, as created on APFS). */
  disk: string;
}

function walkBundle(appPath: string): Entry[] {
  const out: Entry[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(appPath, rel))) {
      const disk = rel ? `${rel}/${name}` : name;
      const path = disk.normalize("NFC");
      const st = lstatSync(join(appPath, disk));
      if (st.isDirectory()) walk(disk);
      else if (path.startsWith("Contents/_CodeSignature/") || path === "Contents/CodeResources")
        continue;
      else if (st.isSymbolicLink())
        out.push({ disk, file: { path, symlink: readlinkSync(join(appPath, disk)) } });
      else if (st.isFile())
        out.push({ disk, file: { path, sha256: sha256(readFileSync(join(appPath, disk))) } });
      else throw new Error(`bundle: not a file, directory or symlink: ${disk}`);
    }
  };
  walk("");
  return out.sort((a, b) => utf8Compare(a.file.path, b.file.path));
}

/** Every file of the bundle the manifest lists, sorted by the UTF-8 bytes of its path. */
export function bundleFiles(appPath: string): BundleFile[] {
  return walkBundle(appPath).map((e) => e.file);
}

const CPU: Record<number, Arch> = { 16777228: "arm64", 16777223: "x86_64" };

/** The architectures of a Mach-O file (thin or universal); [] for anything else. */
export function machOArchs(bytes: Uint8Array): Arch[] {
  if (bytes.length < 8) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const be = view.getUint32(0, false);
  if (be === 0xcffaedfe || be === 0xcefaedfe) {
    const arch = CPU[view.getUint32(4, true)];
    return arch ? [arch] : [];
  }
  if (be === 0xfeedfacf || be === 0xfeedface) {
    const arch = CPU[view.getUint32(4, false)];
    return arch ? [arch] : [];
  }
  if (be === 0xcafebabe || be === 0xcafebabf) {
    const n = view.getUint32(4, false);
    const size = be === 0xcafebabe ? 20 : 32;
    // A Java class file starts with 0xcafebabe too, followed by its version (≥ 45).
    if (n === 0 || n > 16 || bytes.length < 8 + n * size) return [];
    const archs: Arch[] = [];
    for (let i = 0; i < n; i++) {
      const arch = CPU[view.getUint32(8 + i * size, false)];
      if (arch) archs.push(arch);
    }
    return archs;
  }
  return [];
}

/**
 * The cdhash of a code object for one slice: `path` is bundle-relative as on disk; "" is the bundle
 * itself (its main executable, the shell). On macOS: codesign -d -vvv --arch <arch> (CDHash=).
 */
export type CdhashOf = (path: string, arch: Arch) => string;

/** The manifest of a signed, stapled bundle; nothing in the bundle is written. */
export function buildManifest(input: {
  appPath: string;
  app: string;
  version: string;
  build: string;
  cdhash: CdhashOf;
}): ArtifactManifest {
  const entries = walkBundle(input.appPath);
  const machO = entries
    .filter((e) => "sha256" in e.file && e.file.path !== SHELL_PATH)
    .map((e) => ({ ...e, archs: machOArchs(readFileSync(join(input.appPath, e.disk))) }))
    .filter((e) => e.archs.length > 0);
  const slice = (arch: Arch): Slice => ({
    shell: input.cdhash("", arch),
    nested: machO
      .filter((e) => e.archs.includes(arch))
      .map((e) => ({ path: e.file.path, cdhash: input.cdhash(e.disk, arch) })),
  });
  return validateManifest({
    format: ARTIFACT_MANIFEST_FORMAT,
    app: input.app,
    version: input.version,
    build: input.build,
    slices: { arm64: slice("arm64"), x86_64: slice("x86_64") },
    resourceSealHash: sha256(readFileSync(join(input.appPath, SEAL_PATH))),
    files: entries.map((e) => e.file),
  });
}

/** How a bundle on disk differs from a manifest: [] when it is the manifest's build. */
export function compareBundle(manifest: ArtifactManifest, actual: ArtifactManifest): string[] {
  const out: string[] = [];
  for (const k of ["app", "version", "build", "resourceSealHash"] as const)
    if (manifest[k] !== actual[k]) out.push(`${k}: ${actual[k]}, manifest ${manifest[k]}`);
  for (const arch of ARCHS) {
    const want = manifest.slices[arch];
    const got = actual.slices[arch];
    if (want.shell !== got.shell) out.push(`${arch} shell: ${got.shell}, manifest ${want.shell}`);
    const wanted = new Map(want.nested.map((n) => [n.path, n.cdhash]));
    for (const n of got.nested) {
      const w = wanted.get(n.path);
      if (w !== n.cdhash) out.push(`${arch} ${n.path}: ${n.cdhash}, manifest ${w ?? "absent"}`);
      wanted.delete(n.path);
    }
    for (const path of wanted.keys()) out.push(`${arch} ${path}: missing`);
  }
  const files = new Map(manifest.files.map((f) => [f.path, canonicalJson(f)]));
  for (const f of actual.files) {
    if (files.get(f.path) !== canonicalJson(f))
      out.push(`${f.path}: ${files.has(f.path) ? "changed" : "not in the manifest"}`);
    files.delete(f.path);
  }
  for (const path of files.keys()) out.push(`${path}: missing`);
  return out;
}
