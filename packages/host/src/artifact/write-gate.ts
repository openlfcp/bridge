// The write gate at run time (A§9.1–9.2, E-051b): when it is checked, where its inputs come from,
// where its decision goes.
//
// - When: before writes are turned on (the start of the run process — also the first start after a
//   Sparkle update, which relaunches the app) and before every start of the helper by the host
//   (HelperSupervisor's start, restarts included). The decision of the last check is the one the
//   run process writes by; until the first one it is preview.
// - Inputs: the kept manifests (cache.ts), refreshed online first — the artifact manifest of this
//   version (next to the DMG, on the GitHub Release; the appcast's copy is E-056's) when no kept
//   copy is of this version, and the public certification manifest (GitHub Release) at most every
//   CERTIFICATION_REFRESH_MS. Offline, the kept copies decide; none kept → preview (unavailable).
//   (3)–(5) are the shell's (ShellCode over IPC, Security.framework); outside LFCP Bridge.app there
//   is no shell → preview.
// - Output: GateDecision; kept in meta `cert_gate` (status, Check, the diagnostics read it there),
//   a change of state journaled as cert.state with its reason.

import { closeSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import type { ShellCode } from "../app/serve.js";
import type { BridgeDatabase } from "../db/database.js";
import type { Journal } from "../db/journal.js";
import type { ManifestCache } from "./cache.js";
import { type CertState, checkGate, type GateDecision, type GateReason } from "./gate.js";
import { type Arch, machOArchs, SHELL_PATH } from "./manifest.js";

const RELEASES = "https://github.com/openlfcp/bridge/releases";
export const artifactManifestUrl = (version: string) =>
  `${RELEASES}/download/v${version}/artifact-manifest.json`;
export const CERTIFICATION_MANIFEST_URL = `${RELEASES}/latest/download/certification-manifest.json`;
export const CERTIFICATION_REFRESH_MS = 6 * 3_600_000;
const FETCH_TIMEOUT_MS = 15_000;
/** The artifact manifests kept: this build's and the one before it (around an update). */
export const ARTIFACT_MANIFESTS_KEPT = 2;

/** GET a URL as text; throws on anything but 200. */
export type FetchText = (url: string) => Promise<string>;

const fetchText: FetchText = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return r.text();
};

/** The slice this host runs as (node is universal; it runs as the shell does). */
export const hostArch = (): Arch => (process.arch === "x64" ? "x86_64" : "arm64");

/**
 * The Mach-O files of a bundle with a slice for `arch`, but the shell (A§9.1 (5)): the files the
 * manifest's nested[] lists (buildManifest), NFC paths relative to the bundle.
 */
export function nestedMachO(appPath: string, arch: Arch): string[] {
  const out: string[] = [];
  const head = Buffer.alloc(1024);
  const walk = (rel: string) => {
    for (const name of readdirSync(join(appPath, rel))) {
      const disk = rel ? `${rel}/${name}` : name;
      const path = disk.normalize("NFC");
      const st = lstatSync(join(appPath, disk));
      if (st.isDirectory()) walk(disk);
      else if (!st.isFile() || path === SHELL_PATH) continue;
      else if (path.startsWith("Contents/_CodeSignature/") || path === "Contents/CodeResources")
        continue;
      else {
        const fd = openSync(join(appPath, disk), "r");
        let n: number;
        try {
          n = readSync(fd, head, 0, head.length, 0);
        } finally {
          closeSync(fd);
        }
        if (machOArchs(head.subarray(0, n)).includes(arch)) out.push(path);
      }
    }
  };
  walk("");
  return out.sort();
}

export interface KeptGate {
  readonly state: CertState;
  readonly reason: GateReason;
  readonly detail: string;
  readonly at: string;
  readonly macOS: string;
  readonly artifactSliceId?: string;
  readonly manifestSha256?: string;
}

const META_KEY = "cert_gate";

/** The last decision of the gate (status, Check, diagnostics); undefined before the first check. */
export function keptGate(db: BridgeDatabase): KeptGate | undefined {
  const r = db.prepare("SELECT value FROM meta WHERE key = ?").get(META_KEY) as
    | { value: string }
    | undefined;
  if (r === undefined) return undefined;
  try {
    return JSON.parse(r.value) as KeptGate;
  } catch {
    return undefined;
  }
}

export interface WriteGateOptions {
  readonly db: BridgeDatabase;
  readonly cache: ManifestCache;
  readonly journal: Journal;
  /** The shell of LFCP Bridge.app and its bundle; without them the code is unknown (preview). */
  readonly shell?: ShellCode;
  readonly appBundle?: string;
  /** This build's version (the release whose artifact manifest is fetched). */
  readonly version: string;
  readonly macOS: string;
  readonly fetch?: FetchText;
  readonly arch?: Arch;
  readonly now?: () => number;
}

export class WriteGate {
  readonly #o: WriteGateOptions;
  #decision: GateDecision = {
    state: "unavailable",
    writes: false,
    reason: "no-identity",
    detail: "the write gate has not been checked yet",
  };
  #certifiedAt: number | undefined;

  constructor(o: WriteGateOptions) {
    this.#o = o;
  }

  /** The decision of the last check: what the run process writes by. */
  get decision(): GateDecision {
    return this.#decision;
  }

  /** Refreshes the kept manifests (best effort), asks the shell, decides (A§9.1). */
  async check(when: "start" | "helper"): Promise<GateDecision> {
    const o = this.#o;
    await this.#refresh();
    const shell = o.shell;
    const bundle = o.appBundle;
    const arch = o.arch ?? hostArch();
    const d = await checkGate({
      cache: o.cache,
      macOS: o.macOS,
      code: {
        identity: async () => {
          if (shell === undefined || bundle === undefined)
            throw new Error("not running in LFCP Bridge.app");
          return shell.identity(nestedMachO(bundle, arch));
        },
      },
    });
    const before = keptGate(o.db);
    const kept: KeptGate = {
      state: d.state,
      reason: d.reason,
      detail: d.detail,
      at: new Date((o.now ?? Date.now)()).toISOString(),
      macOS: o.macOS,
      ...(d.artifactSliceId === undefined ? {} : { artifactSliceId: d.artifactSliceId }),
      ...(d.manifestSha256 === undefined ? {} : { manifestSha256: d.manifestSha256 }),
    };
    o.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(META_KEY, JSON.stringify(kept));
    if (before?.state !== d.state || before.reason !== d.reason)
      o.journal.append(d.writes ? "info" : "warn", "cert.state", {
        params: { state: d.state, reason: d.reason, when, text: d.detail },
      });
    this.#decision = d;
    return d;
  }

  async #refresh(): Promise<void> {
    const o = this.#o;
    const get = o.fetch ?? fetchText;
    const now = (o.now ?? Date.now)();
    if (!o.cache.artifacts().some((a) => a.manifest.version === o.version)) {
      try {
        o.cache.storeArtifact(await get(artifactManifestUrl(o.version)));
        o.cache.prune(ARTIFACT_MANIFESTS_KEPT);
      } catch {
        // Offline, not published, or not valid: the kept copies decide (none → preview).
      }
    }
    if (this.#certifiedAt === undefined || now - this.#certifiedAt >= CERTIFICATION_REFRESH_MS) {
      try {
        o.cache.offerCertification(await get(CERTIFICATION_MANIFEST_URL));
        this.#certifiedAt = now;
      } catch {
        // Offline: the kept one decides; tried again at the next check.
      }
    }
  }
}
