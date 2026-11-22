// The write gate by the manifests (A§9.1, E14): whether this artifact, as it runs, may write to
// normal Reminders lists on this macOS. Five checks, all of them every time (before writes are
// turned on, after every update, before every start of the helper — the callers are E-051b):
//   (1) the artifact manifest's signature holds (a kept copy, verified again);
//   (2) the public certification manifest has a certified record for this manifestSha256, this
//       slice and this macOS (A§9.3, E14b inheritance);
//   (3) SecStaticCodeCheckValidity of the bundle (strict, nested code);
//   (4) the cdhash of the running shell = slices[arch].shell (artifactSliceId);
//   (5) the cdhash of every nested Mach-O on disk = slices[arch].nested[path], nothing more, nothing
//       less.
// (3)–(5) come from the shell (Security.framework, b) through CodeIdentitySource; here they are
// data. Anything but a pass is preview. cert.state:
//   certified   — all five hold: writes;
//   mismatch    — the code is not the manifest's build ((1) a bad signature, (3)–(5));
//   withdrawn   — the record for this macOS (or the one it inherits from) is withdrawn;
//   uncertified — no record covers this macOS ("newer than checked" / "not checked");
//   unavailable — nothing to decide with: no copy of a manifest (first start offline), the code
//                 identity unknown.

import type { CachedArtifactManifest } from "./cache.js";
import { type CertificationManifest, type Coverage, coverage } from "./certification.js";
import type { Arch, ArtifactManifest, NestedCode } from "./manifest.js";

/** What the shell reports of the code (A§9.1 (3)–(5)). */
export interface CodeIdentity {
  /** The slice the shell runs as. */
  readonly arch: Arch;
  /** SecStaticCodeCheckValidity(bundle, kSecCSStrictValidate | kSecCSCheckNestedCode). */
  readonly validity: { readonly ok: true } | { readonly ok: false; readonly detail: string };
  /** kSecCodeInfoUnique of SecCodeCopySelf: the running shell's cdhash. */
  readonly runningShell: string;
  /** kSecCodeInfoUnique of SecStaticCodeCreateWithPath, this arch, for every nested Mach-O. */
  readonly nested: readonly NestedCode[];
}

/** The source of (3)–(5): the shell over IPC (E-051b); a fake in tests. */
export interface CodeIdentitySource {
  identity(): Promise<CodeIdentity>;
}

export type CertState = "certified" | "mismatch" | "withdrawn" | "uncertified" | "unavailable";

export type GateReason =
  | "certified"
  | "no-identity"
  | "no-artifact-manifest"
  | "code-invalid"
  | "shell-cdhash"
  | "nested-cdhash"
  | "no-certification-manifest"
  | "withdrawn"
  | "uncertified";

export interface GateDecision {
  readonly state: CertState;
  /** Normal bindings write only when true; otherwise preview (dry run). */
  readonly writes: boolean;
  readonly reason: GateReason;
  /** What Check shows (English, for the journal and diagnostics). */
  readonly detail: string;
  readonly manifestSha256?: string;
  readonly artifactSliceId?: string;
  readonly coverage?: Coverage;
}

export interface GateInput {
  /** The kept artifact manifests whose signature holds (check (1), ManifestCache.artifacts()). */
  readonly artifacts: readonly CachedArtifactManifest[];
  /** The kept certification manifest that verifies, if any. */
  readonly certification: CertificationManifest | undefined;
  /** The code as the shell sees it, or why it could not say. */
  readonly identity: CodeIdentity | Error;
  /** sw_vers -productVersion. */
  readonly macOS: string;
}

const preview = (
  state: Exclude<CertState, "certified">,
  reason: GateReason,
  detail: string,
  more: Partial<GateDecision> = {},
): GateDecision => ({ state, writes: false, reason, detail, ...more });

/** Nested code on disk against the manifest's slice: what differs, [] if nothing. */
export function nestedDifferences(
  want: readonly NestedCode[],
  got: readonly NestedCode[],
): string[] {
  const out: string[] = [];
  const wanted = new Map(want.map((n) => [n.path, n.cdhash]));
  const seen = new Set<string>();
  for (const n of got) {
    const w = wanted.get(n.path);
    if (seen.has(n.path)) out.push(`${n.path}: reported twice`);
    else if (w === undefined) out.push(`${n.path}: not in the manifest`);
    else if (w !== n.cdhash) out.push(`${n.path}: cdhash ${n.cdhash}, manifest ${w}`);
    seen.add(n.path);
  }
  for (const path of wanted.keys()) if (!seen.has(path)) out.push(`${path}: missing`);
  return out;
}

/** The gate's decision from what is kept and what the shell reports (A§9.1). */
export function decideGate(input: GateInput): GateDecision {
  const id = input.identity;
  if (id instanceof Error)
    return preview("unavailable", "no-identity", `the code identity is unknown: ${id.message}`);
  if (input.artifacts.length === 0)
    return preview(
      "unavailable",
      "no-artifact-manifest",
      "no signed artifact manifest is kept (it is downloaded with the app)",
    );
  // (1) is the cache's: every kept copy verified. The running shell names its build: the copy whose
  // slice has the running shell's cdhash (around an update, two may be kept).
  const mine = input.artifacts.find((a) => a.manifest.slices[id.arch].shell === id.runningShell);
  if (!id.validity.ok)
    return preview("mismatch", "code-invalid", `the code signature: ${id.validity.detail}`, {
      ...(mine === undefined ? {} : { manifestSha256: mine.manifestSha256 }),
    });
  if (mine === undefined)
    return preview(
      "mismatch",
      "shell-cdhash",
      `the running shell ${id.runningShell} (${id.arch}) is in no kept artifact manifest`,
      { artifactSliceId: id.runningShell },
    );
  const manifest: ArtifactManifest = mine.manifest;
  const ids = { manifestSha256: mine.manifestSha256, artifactSliceId: id.runningShell };
  const nested = nestedDifferences(manifest.slices[id.arch].nested, id.nested);
  if (nested.length > 0)
    return preview("mismatch", "nested-cdhash", `nested code: ${nested.join("; ")}`, ids);
  if (input.certification === undefined)
    return preview(
      "unavailable",
      "no-certification-manifest",
      "no public certification manifest is kept (it is downloaded)",
      ids,
    );
  const c = coverage(input.certification, { ...ids, arch: id.arch }, input.macOS);
  const more = { ...ids, coverage: c };
  switch (c.kind) {
    case "certified":
      return {
        state: "certified",
        writes: true,
        reason: "certified",
        detail:
          c.inheritedFrom === undefined
            ? `certified on macOS ${c.entry.macos}`
            : `macOS ${input.macOS} is covered by the certification on macOS ${c.inheritedFrom}`,
        ...more,
      };
    case "withdrawn":
      return preview(
        "withdrawn",
        "withdrawn",
        `the certification on macOS ${c.entry.macos} is withdrawn`,
        more,
      );
    case "uncertified":
      return preview(
        "uncertified",
        "uncertified",
        c.relation === "newer"
          ? `macOS ${input.macOS} is newer than the checked macOS ${c.newestCertified}`
          : `macOS ${input.macOS} is not checked for this build`,
        more,
      );
  }
}

/** The gate over the cache and the shell: reads both, decides. */
export async function checkGate(o: {
  readonly cache: {
    artifacts(): CachedArtifactManifest[];
    certification(): CertificationManifest | undefined;
  };
  readonly code: CodeIdentitySource;
  readonly macOS: string;
}): Promise<GateDecision> {
  let identity: CodeIdentity | Error;
  try {
    identity = await o.code.identity();
  } catch (e) {
    identity = e instanceof Error ? e : new Error(String(e));
  }
  return decideGate({
    artifacts: o.cache.artifacts(),
    certification: o.cache.certification(),
    identity,
    macOS: o.macOS,
  });
}
