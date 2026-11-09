// Access readiness of the bridge's sections (D-010 §5.3, R2-13, r3 P2-4).
//
// - access_checked_now(R): in the **current** generation of the connection
//   the server answered about R and the answer lets the device read: R was
//   opened (it reached LIVE) and the SDK's write access from the validated
//   Control state is "allowed" or "read-only". Reset by every new generation
//   (disconnect, wake). Normal to_apple writes and every conclusion require it.
// - offline_commit_allowed(R): the **last** answer, kept in bridge.sqlite
//   across restarts, was "allowed": only for queueing a commit to LFCP while
//   there is no connection. A refusal or a proven revocation clears it.
//
// A refusal of R by the server (`resource-refused`, e.g. AUTHORIZATION_FAILED;
// a batch `blocked`, §5.9) is answered with revocationStatus
// (IDENTITY-PROFILE-01 §8.6, the SDK's write barrier): "revocation-proven" →
// revoked, for good (N5); otherwise refused. Both set the hold
// `access_refused` on R's bindings; an "allowed" or "read-only" answer
// lifts it. Everything is per installation (its Principal): the kept
// answer, the holds (bindings of that installation only) and the tracker
// (one per SectionHost, whose generations it follows). A revoked capability
// (`canWrite` reason "revoked": a grant no longer active) is a refusal, not
// a revocation of the device: only revocationStatus proves that (N5).
// (The identity barrier of the plugin, LFCP-04-406, is for SDKs
// before identity; the SDK 0.5.2 the bridge uses is identity-aware, so the
// barrier here is the write barrier of §8.6.)

import type { SyncEvent, WriteAccess } from "@openlfcp/client";
import { type ResourceId, toHex } from "@openlfcp/core";
import type { BridgeDatabase } from "../db/database.js";
import { Holds } from "../db/holds.js";
import type { LiveChange } from "./live.js";

export type AccessAnswer = "allowed" | "read-only" | "refused" | "revoked";

/** What revocationStatus said, reduced (unreachable: no decision, the refusal stands). */
export type RevocationVerdict = "revocation-proven" | "access-refused" | "active" | "unreachable";

export interface AccessRecord {
  readonly answer: AccessAnswer;
  /** RFC 3339 UTC of the answer. */
  readonly at: string;
  /** The SDK's reason, a refusal's code. */
  readonly detail?: string;
}

/** Where the last answer per Resource is kept (offline_commit_allowed). */
export interface AccessStore {
  get(resource: ResourceId): AccessRecord | undefined;
  put(resource: ResourceId, record: AccessRecord): void;
}

/**
 * The access store of one installation in bridge.sqlite's meta table, key
 * `access:<installation id>:<ResourceId hex>`: access is a Principal's.
 */
export function metaAccessStore(db: BridgeDatabase, installationId: string): AccessStore {
  const key = (resource: ResourceId) => `access:${installationId}:${toHex(resource)}`;
  return {
    get(resource) {
      const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key(resource)) as
        | { value: string }
        | undefined;
      return row === undefined ? undefined : (JSON.parse(row.value) as AccessRecord);
    },
    put(resource, record) {
      db.prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      ).run(key(resource), JSON.stringify(record));
    },
  };
}

/**
 * The `access_refused` hold of the live bindings of `resource` that belong to
 * `installationId`, set or lifted by that installation's `answer`.
 */
export function applyAccessHolds(
  db: BridgeDatabase,
  installationId: string,
  resource: ResourceId,
  answer: AccessAnswer,
): void {
  const holds = new Holds(db);
  const bindings = db
    .prepare(
      "SELECT id FROM bindings WHERE installation_id = ? AND resource_id = ? AND state <> 'removed'",
    )
    .all(installationId, toHex(resource)) as { id: string }[];
  for (const { id } of bindings)
    if (answer === "refused" || answer === "revoked") holds.set(id, "access_refused", { answer });
    else holds.lift(id, "access_refused");
}

/** What the tracker needs of the SectionHost. */
export interface AccessSource {
  readonly generation: number;
  canWrite(resource: ResourceId): Promise<WriteAccess>;
  onSyncEvent(listener: (e: SyncEvent) => void): () => void;
  onLiveChange(listener: (c: LiveChange) => void): () => void;
}

export interface AccessChange {
  readonly resource: ResourceId;
  readonly answer: AccessAnswer;
  readonly generation: number;
}

export interface AccessTrackerOptions {
  readonly source: AccessSource;
  readonly store: AccessStore;
  /** revocationStatus of this installation for `resource` (§8.6). */
  readonly checkRevocation: (resource: ResourceId) => Promise<RevocationVerdict>;
  readonly now?: () => number;
}

/**
 * The answer of a write access. "revoked" there is a capability no longer
 * active (CAPABILITY_REVOKE, a delegating grant revoked): a refusal that a
 * new grant may end, not a proven revocation of the device.
 */
const fromWriteAccess = (a: WriteAccess): AccessAnswer =>
  a.allowed ? "allowed" : a.reason === "read-only" ? "read-only" : "refused";

export class AccessTracker {
  readonly #o: AccessTrackerOptions;
  /** The answers of the current generation, by Resource (hex). */
  readonly #now = new Map<string, { readonly generation: number; readonly answer: AccessAnswer }>();
  /**
   * Per Resource, a counter of what happened to its access: a check started
   * keeps the value it saw, and its result counts only while nothing (a
   * refusal, a newer check) came after it (review PR 3b #1).
   */
  readonly #version = new Map<string, number>();
  readonly #listeners = new Set<(c: AccessChange) => void>();
  readonly #unsubscribe: (() => void)[];
  /** The work in flight (canWrite, revocationStatus): settled() waits for it. */
  readonly #pending = new Set<Promise<void>>();

  constructor(options: AccessTrackerOptions) {
    this.#o = options;
    this.#unsubscribe = [
      options.source.onLiveChange((c) => this.#live(c)),
      options.source.onSyncEvent((e) => {
        if (e.type === "resource-refused") void this.refused(e.resourceId, e.refusal.code);
      }),
    ];
  }

  /** access_checked_now (§5.3): never with a proven revocation. */
  accessCheckedNow(resource: ResourceId): boolean {
    if (this.#revoked(resource)) return false;
    const a = this.answerNow(resource);
    return a === "allowed" || a === "read-only";
  }

  /** offline_commit_allowed (§5.3): the last answer kept, "allowed". */
  offlineCommitAllowed(resource: ResourceId): boolean {
    return this.#o.store.get(resource)?.answer === "allowed";
  }

  /** The answer of the current generation, if any ("revoked" once proven, whatever the generation). */
  answerNow(resource: ResourceId): AccessAnswer | undefined {
    if (this.#revoked(resource)) return "revoked";
    const a = this.#now.get(toHex(resource));
    return a !== undefined && a.generation === this.#o.source.generation ? a.answer : undefined;
  }

  onChange(listener: (c: AccessChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * The server refused `resource` (a resource-refused event, a batch blocked):
   * refused now, then revocationStatus decides whether it is a revocation.
   * A check of the access started before stays without effect.
   */
  refused(resource: ResourceId, code: string): Promise<void> {
    this.#bump(resource);
    this.#answer(resource, "refused", code);
    return this.#track(async () => {
      const verdict = await this.#o.checkRevocation(resource).catch(() => "unreachable" as const);
      // A proven revocation is a fact of the device, whenever it is learned (N5).
      if (verdict === "revocation-proven") this.#answer(resource, "revoked", verdict);
    });
  }

  /** Waits for the answers in flight (tests, an orderly stop). */
  async settled(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }

  close(): void {
    for (const u of this.#unsubscribe) u();
  }

  #revoked(resource: ResourceId): boolean {
    return this.#o.store.get(resource)?.answer === "revoked";
  }

  #bump(resource: ResourceId): number {
    const key = toHex(resource);
    const v = (this.#version.get(key) ?? 0) + 1;
    this.#version.set(key, v);
    return v;
  }

  #live(c: LiveChange): void {
    if (c.resource === null) {
      // A new generation: nothing is checked in it yet; the kept answers stay.
      this.#now.clear();
      return;
    }
    if (!c.live) return;
    const resource = c.resource;
    const generation = c.generation;
    const version = this.#bump(resource);
    void this.#track(async () => {
      const access = await this.#o.source.canWrite(resource);
      // Counts only if nothing happened to the access since it started, in this generation.
      if (this.#version.get(toHex(resource)) !== version) return;
      if (generation !== this.#o.source.generation) return;
      this.#answer(resource, fromWriteAccess(access), access.reason ?? undefined);
    });
  }

  /** Records an answer of the current generation (a proven revocation in any). */
  #answer(resource: ResourceId, answer: AccessAnswer, detail?: string): void {
    // A proven revocation is permanent (N5): nothing replaces it.
    if (this.#revoked(resource) && answer !== "revoked") return;
    this.#o.store.put(resource, {
      answer,
      at: new Date((this.#o.now ?? Date.now)()).toISOString(),
      ...(detail === undefined ? {} : { detail }),
    });
    const generation = this.#o.source.generation;
    this.#now.set(toHex(resource), { generation, answer });
    for (const l of this.#listeners) l({ resource, answer, generation });
  }

  #track(work: () => Promise<void>): Promise<void> {
    const p = work().finally(() => this.#pending.delete(p));
    this.#pending.add(p);
    return p;
  }
}
