// SectionHost (D-010 §5, PR 3a): the bridge's shared-sections Resources on
// one coordinator, through one SyncClient — what the Obsidian plugin's
// runtime.ts does in #session / #openSectionNow, without Obsidian, and with
// the bridge's rules on top:
//
// - restore a section's replica from its checkpoint, or rebuild it empty
//   (keeping the actor sequence) when the checkpoint cannot be restored;
// - DataUnitApplier with every handler of the profile (apply, applyBatch,
//   exclude, has, reset), a debounced ProfileCheckpointer, the snapshot
//   binding (loading offered Snapshots: a joiner fetches only the tail) and
//   the guarded commit binding (§5.8);
// - the sync driver and the outbound queue; no snapshotPolicy, so the bridge
//   never publishes a Snapshot (a service device has no snapshot/publish);
// - commitGuarded is the only way to commit (r3 P2-5);
// - onNodesChanged of every section, subscribed before it is opened (§5.2);
// - lfcp_live from the connection's events (§5.3, R2-13).
//
// This is the bridge's own copy of the glue sdk-ts lacks (spike B-001 G2;
// the SDK's SectionHost is 505, after PR 8).

import {
  type CommitBinding,
  DataUnitApplier,
  dekResolver,
  isEngineTrap,
  OutboundQueue,
  ProfileCheckpointer,
  type Receipt,
  type ReconnectPolicy,
  type SnapshotBinding,
  SyncClient,
  type SyncEvent,
  startSyncDriver,
  type WebSocketFactory,
} from "@openlfcp/client";
import { LfcpError, type PrincipalId, type ResourceId, toHex } from "@openlfcp/core";
import type { AgreementKeyPair } from "@openlfcp/crypto";
import {
  SECTIONS_PROFILE_ID,
  SectionReplica,
  type SectionsNodesChanged,
  SharedSectionsDataProfile,
} from "@openlfcp/shared-objects/sections";
import type { LfcpStorage, SecretStore } from "@openlfcp/storage";
import type { Signer } from "@openlfcp/wire";
import { type BasisCheck, type GuardedBinding, guardCommitBinding } from "./commit-guard.js";
import { type LiveChange, LiveTracker } from "./live.js";

/** The outbound request timeout of the plugin (runtime.ts OUTBOUND_REQUEST_TIMEOUT). */
const OUTBOUND_REQUEST_TIMEOUT = { baseMs: 4000, maxMs: 60_000 } as const;

export interface SectionHostTimers {
  readonly setInterval: (fn: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
  readonly now: () => number;
}

export interface SectionHostOptions {
  /** The coordinator of the sections. */
  readonly url: string;
  readonly installation: { readonly signer: Signer; readonly agreement: AgreementKeyPair };
  readonly storage: LfcpStorage;
  readonly secrets: SecretStore;
  readonly timers?: SectionHostTimers;
  /** The sync driver's tick (default 1 s). */
  readonly tickMs?: number;
  readonly reconnect?: ReconnectPolicy;
  readonly antiEntropyMs?: number;
  readonly webSocket?: WebSocketFactory;
  /** Checkpoints at most this often (default 2 s, as the plugin). */
  readonly checkpointIntervalMs?: number;
}

/** A section's checkpoint could not be restored: its replica was rebuilt from the units. */
export interface RebuiltEvent {
  readonly resource: ResourceId;
  readonly error: unknown;
}

/** One guarded commit (§5.6 effect of a to_lfcp intent). */
export interface GuardedCommit {
  readonly resource: ResourceId;
  /** The exact intents of the durable intent (payload); copied for this call. */
  readonly intents: readonly unknown[];
  /** `brg1:<intent id>` (§3). */
  readonly operationId: string;
  /**
   * Runs inside the SDK's stage, between no merge and the write: true when the
   * section still matches the intent's basis (`fieldsMatch(replica, basis)`).
   */
  readonly check: (replica: SectionReplica) => true | false | string;
}

export interface GuardedCommitResult {
  readonly receipt: Receipt;
  /**
   * false: the operation had a receipt already (a retry after a crash), the
   * check was not run and nothing new was written (§5.8: correct).
   */
  readonly staged: boolean;
}

interface OpenedSection {
  readonly resource: ResourceId;
  readonly profile: SharedSectionsDataProfile;
  readonly checkpointer: ProfileCheckpointer;
  readonly guard: GuardedBinding<unknown>;
  readonly unsubscribe: () => void;
}

const defaultTimers: SectionHostTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  now: () => Date.now(),
};

/** Test access to the SyncClient (the bypass test). Not exported from the package. */
export const clientOf = new WeakMap<SectionHost, SyncClient>();

/** Test access to a section's profile (feeding remote changes offline). Not exported from the package. */
export function profileOf(
  host: SectionHost,
  resource: ResourceId,
): SharedSectionsDataProfile | undefined {
  return sectionsOf.get(host)?.get(toHex(resource))?.profile;
}
const sectionsOf = new WeakMap<SectionHost, Map<string, OpenedSection>>();

export class SectionHost {
  readonly #o: SectionHostOptions;
  readonly #timers: SectionHostTimers;
  readonly #client: SyncClient;
  readonly #sections = new Map<string, OpenedSection>();
  readonly #opening = new Map<string, Promise<OpenedSection>>();
  readonly #nodes = new Set<(resource: ResourceId, e: SectionsNodesChanged) => void>();
  readonly #events = new Set<(e: SyncEvent) => void>();
  readonly #rebuilt = new Set<(e: RebuiltEvent) => void>();
  readonly #live = new LiveTracker();
  #stopDriver: (() => void) | null = null;
  #stopped = false;

  constructor(options: SectionHostOptions) {
    this.#o = options;
    this.#timers = options.timers ?? defaultTimers;
    const { storage } = options;
    this.#client = new SyncClient({
      url: options.url,
      signer: options.installation.signer,
      agreement: options.installation.agreement,
      storage,
      secrets: options.secrets,
      outbound: new OutboundQueue({ storage, requestTimeout: OUTBOUND_REQUEST_TIMEOUT }),
      now: () => this.#timers.now(),
      ...(options.reconnect === undefined ? {} : { reconnect: options.reconnect }),
      ...(options.antiEntropyMs === undefined ? {} : { antiEntropyMs: options.antiEntropyMs }),
      ...(options.webSocket === undefined ? {} : { webSocket: options.webSocket }),
      // No snapshotPolicy: the bridge never publishes a Snapshot.
    });
    this.#client.on((e) => {
      this.#live.event(e);
      for (const l of this.#events) l(e);
    });
    clientOf.set(this, this.#client);
    sectionsOf.set(this, this.#sections);
  }

  get me(): PrincipalId {
    return this.#o.installation.signer.descriptor.principalId;
  }

  get url(): string {
    return this.#o.url;
  }

  /** The SDK's session events (connection, resource-state, batches, errors…). */
  onSyncEvent(listener: (e: SyncEvent) => void): () => void {
    this.#events.add(listener);
    return () => this.#events.delete(listener);
  }

  /** nodesChanged of every section, those opened later included (§5.2: subscribe first). */
  onNodesChanged(listener: (resource: ResourceId, e: SectionsNodesChanged) => void): () => void {
    this.#nodes.add(listener);
    return () => this.#nodes.delete(listener);
  }

  /** A checkpoint could not be restored and the replica was rebuilt (journal it). */
  onRebuilt(listener: (e: RebuiltEvent) => void): () => void {
    this.#rebuilt.add(listener);
    return () => this.#rebuilt.delete(listener);
  }

  /** lfcp_live changes (§5.3). */
  onLiveChange(listener: (c: LiveChange) => void): () => void {
    return this.#live.onChange(listener);
  }

  /** lfcp_live of `resource`: LIVE now, in the current generation of the connection. */
  isLive(resource: ResourceId): boolean {
    return this.#live.isLive(resource);
  }

  /** The current generation of the connection (§5.3). */
  get generation(): number {
    return this.#live.generation;
  }

  /** The system woke up (helper `wake`, or a jump of the clock): lfcp_live is reset. */
  wake(): void {
    this.#live.wake();
  }

  /** The replica of an open section, for reading (a plan reads it; it never writes it). */
  replica(resource: ResourceId): SectionReplica | undefined {
    return this.#sections.get(toHex(resource))?.profile.replica;
  }

  /** Whether `resource` is open here. */
  isOpen(resource: ResourceId): boolean {
    return this.#sections.has(toHex(resource));
  }

  /**
   * Opens a shared-sections Resource whose chain and keys are stored (by the
   * pairing): its replica from its checkpoint, on this session. Idempotent.
   */
  open(resource: ResourceId): Promise<void> {
    if (this.#stopped) return Promise.reject(new Error("the section host is stopped"));
    const key = toHex(resource);
    if (this.#sections.has(key)) return Promise.resolve();
    let p = this.#opening.get(key);
    if (p === undefined) {
      p = this.#openNow(resource).finally(() => this.#opening.delete(key));
      this.#opening.set(key, p);
    }
    return p.then(() => undefined);
  }

  async #openNow(resource: ResourceId): Promise<OpenedSection> {
    const { storage, secrets } = this.#o;
    const head = await storage.control.head(resource);
    if (head === undefined) throw new Error("no Control Chain of this Resource is stored here");
    const options = { resource, principal: this.me };
    const checkpoint = await storage.profileState.checkpoint(resource);
    let profile: SharedSectionsDataProfile;
    if (checkpoint === undefined)
      profile = new SharedSectionsDataProfile(SectionReplica.empty(options));
    else {
      if (checkpoint.dataProfile !== SECTIONS_PROFILE_ID)
        throw new LfcpError(
          "DATA_PROFILE_MISMATCH",
          `not a shared section: ${checkpoint.dataProfile}`,
        );
      try {
        profile = SharedSectionsDataProfile.restore(checkpoint, options);
      } catch (error) {
        // An engine trap is not a bad checkpoint: the process must stop (as the plugin).
        if (
          isEngineTrap(error) ||
          (error instanceof LfcpError && error.code === "DATA_PROFILE_MISMATCH")
        )
          throw error;
        // Rebuilt from the units; the actor sequence already used is kept (SOP §9).
        profile = new SharedSectionsDataProfile(
          SectionReplica.empty({ ...options, minSeq: checkpoint.actorSeq }),
        );
        this.#live.rebuilt(resource);
        for (const l of this.#rebuilt) l({ resource, error });
      }
    }
    const unsubscribe = profile.onNodesChanged((e) => {
      if (e.origin === "rebuild") this.#live.rebuilt(resource);
      for (const l of this.#nodes) l(resource, e);
    });
    const checkpointer = new ProfileCheckpointer(
      storage,
      { checkpoint: () => profile.checkpoint() },
      { minIntervalMs: this.#o.checkpointIntervalMs ?? 2000 },
    );
    const applier = new DataUnitApplier({
      storage,
      dek: dekResolver(storage, secrets, resource),
      handlers: [
        {
          dataProfile: profile.dataProfile,
          codecFor: (u) => profile.codecFor(u),
          apply: (u, v) => profile.apply(u, v as never),
          applyBatch: (units) => profile.applyBatch(units as never),
          exclude: (ids) => profile.exclude(ids),
          has: (id) => profile.has(id),
          reset: () => profile.reset(),
        },
      ],
    });
    const guard = guardCommitBinding(profile.commitBinding(this.me) as CommitBinding<unknown>);
    this.#client.open({
      resourceId: resource,
      applier,
      checkpointer,
      commit: guard.binding,
      snapshot: profile.snapshotBinding() as SnapshotBinding<unknown>,
    });
    const opened: OpenedSection = { resource, profile, checkpointer, guard, unsubscribe };
    this.#sections.set(toHex(resource), opened);
    return opened;
  }

  /** Connects and starts the sync driver. */
  start(): void {
    if (this.#stopped) throw new Error("the section host is stopped");
    this.#client.start();
    this.#stopDriver ??= startSyncDriver(this.#client, this.#timers, this.#o.tickMs ?? 1000);
  }

  /**
   * The only way to commit on a section of the bridge (§5.8, r3 P2-5): the
   * check runs inside the SDK's stage, atomically with it. A failed check
   * throws BasisChangedError and writes nothing; a commit that already has a
   * receipt returns it without the check.
   */
  async commitGuarded(c: GuardedCommit): Promise<GuardedCommitResult> {
    const opened = this.#sections.get(toHex(c.resource));
    if (opened === undefined) throw new Error("the section is not open here");
    const check: BasisCheck = () => c.check(opened.profile.replica);
    const { result, staged } = await opened.guard.guarded(c.intents, check, (batch) =>
      this.#client.commit(c.resource, batch, { operationId: c.operationId }),
    );
    return { receipt: result, staged };
  }

  /**
   * Stops the session and the driver, then flushes the checkpoints. Outbound
   * items stay queued. The SDK client is stopped first and always (its queue
   * drained: no message is handled after the flush), every section's
   * checkpoint is tried and every subscription freed, whatever fails; the
   * first error is then thrown (review PR 3a). A second stop does nothing.
   */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#stopDriver?.();
    this.#stopDriver = null;
    const errors: unknown[] = [];
    try {
      await Promise.allSettled([...this.#opening.values()]);
      try {
        await this.#client.stop();
      } catch (e) {
        errors.push(e);
      }
      for (const s of this.#sections.values()) {
        try {
          await s.checkpointer.flush(this.#timers.now());
        } catch (e) {
          errors.push(e);
        }
      }
    } finally {
      for (const s of this.#sections.values()) s.unsubscribe();
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "the section host stopped with errors");
  }
}
