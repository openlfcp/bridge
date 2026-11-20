// The write gate's cache of the signed manifests (A§9.1–9.2; bridge.sqlite version 9). What is
// downloaded (b: next to the DMG, in the appcast, the GitHub Release) is offered here; the gate
// reads only what verifies against the trusted keys, every time — a row is never trusted because
// it is in the database.
//
// The public certification manifest is taken only with a greater `seq` than the one kept (A§9.2):
// an older one (a replay, a stale mirror) is refused, and so is another text with the same `seq`
// (two different signed documents with one number). A kept row that no longer verifies (another
// key, damaged) counts as nothing: a valid manifest replaces it.

import type { BridgeDatabase } from "../db/database.js";
import { type CertificationManifest, parseCertification } from "./certification.js";
import { type ArtifactManifest, ArtifactManifestError, parseSignedManifest } from "./manifest.js";

export interface CachedArtifactManifest {
  readonly manifest: ArtifactManifest;
  readonly manifestSha256: string;
}

export type CertificationOffer =
  | { readonly kind: "stored"; readonly seq: number }
  | { readonly kind: "same"; readonly seq: number }
  | { readonly kind: "stale"; readonly seq: number; readonly kept: number }
  | { readonly kind: "conflict"; readonly seq: number }
  | { readonly kind: "invalid"; readonly code: string; readonly detail: string };

const problem = (e: unknown) =>
  e instanceof ArtifactManifestError
    ? { code: e.code, detail: e.message }
    : { code: "malformed", detail: String(e) };

export class ManifestCache {
  readonly #db: BridgeDatabase;
  readonly #keys: readonly string[];

  constructor(db: BridgeDatabase, trustedKeys: readonly string[]) {
    this.#db = db;
    this.#keys = trustedKeys;
  }

  /** Keeps a downloaded artifact-manifest.json; throws ArtifactManifestError if it is not valid. */
  storeArtifact(text: string, now: Date = new Date()): string {
    const { manifestSha256 } = parseSignedManifest(text, this.#keys);
    this.#db
      .prepare(
        `INSERT INTO artifact_manifest (manifest_sha256, text, stored_at) VALUES (?, ?, ?)
           ON CONFLICT (manifest_sha256) DO NOTHING`,
      )
      .run(manifestSha256, text, now.toISOString());
    return manifestSha256;
  }

  /** The kept artifact manifests that verify, oldest first. */
  artifacts(): CachedArtifactManifest[] {
    const rows = this.#db
      .prepare("SELECT text FROM artifact_manifest ORDER BY stored_at, manifest_sha256")
      .all() as { text: string }[];
    const out: CachedArtifactManifest[] = [];
    for (const r of rows) {
      try {
        out.push(parseSignedManifest(r.text, this.#keys));
      } catch {
        // Not a manifest of this bridge's keys: as if it were not kept.
      }
    }
    return out;
  }

  /** The kept certification manifest, if it verifies. */
  certification(): CertificationManifest | undefined {
    const row = this.#db.prepare("SELECT text FROM certification_manifest WHERE id = 1").get() as
      | { text: string }
      | undefined;
    if (row === undefined) return undefined;
    try {
      return parseCertification(row.text, this.#keys);
    } catch {
      return undefined;
    }
  }

  /** Offers a downloaded certification manifest: kept only if valid and its `seq` is greater. */
  offerCertification(text: string, now: Date = new Date()): CertificationOffer {
    let incoming: CertificationManifest;
    try {
      incoming = parseCertification(text, this.#keys);
    } catch (e) {
      return { kind: "invalid", ...problem(e) };
    }
    return this.#db.transaction((): CertificationOffer => {
      const kept = this.#db.prepare("SELECT text FROM certification_manifest WHERE id = 1").get() as
        | { text: string }
        | undefined;
      const current = kept === undefined ? undefined : this.certification();
      if (current !== undefined && kept !== undefined) {
        if (incoming.seq < current.seq)
          return { kind: "stale", seq: incoming.seq, kept: current.seq };
        if (incoming.seq === current.seq)
          return kept.text === text
            ? { kind: "same", seq: incoming.seq }
            : { kind: "conflict", seq: incoming.seq };
      }
      this.#db
        .prepare(
          `INSERT INTO certification_manifest (id, seq, text, stored_at) VALUES (1, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, text = excluded.text,
               stored_at = excluded.stored_at`,
        )
        .run(incoming.seq, text, now.toISOString());
      return { kind: "stored", seq: incoming.seq };
    })();
  }
}
