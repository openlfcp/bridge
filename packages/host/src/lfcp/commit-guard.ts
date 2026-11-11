// The atomic basis check of a commit to LFCP (D-010 §5.8, R2-3; r3 P2-5).
//
// SyncClient.commit runs in its serial queue: it answers an existing receipt
// first, then calls the Resource's CommitBinding.stage(intents) with the very
// array it was given — synchronously, before anything is written — and a
// throwing stage writes nothing (sdk-ts 0.6.0 sync-client.ts #commit;
// client.CommitBinding: "Throws to refuse it"). Received units are merged in
// the same queue, so between the check in stage and the stage itself no
// remote change can land.
//
// The wrapper below looks the batch up by its array object in a registry
// each guarded commit fills for its own call:
// - no registered guard → UnguardedCommitError: nothing commits on a section
//   of the bridge except through guarded() (no bypass through the client);
// - each call registers a fresh array (a copy of the caller's intents), so
//   concurrent calls never share or overwrite one another's guard, even when
//   given the same array;
// - the check fails → BasisChangedError: no units, no outbound items.

import type { CommitBinding, StagedOperation } from "@openlfcp/client";

/** The replica's state no longer matches the intent's basis: nothing was committed (§5.8). */
export class BasisChangedError extends Error {
  readonly code = "BASIS_CHANGED";

  constructor(readonly detail?: string) {
    super(`the basis of the commit changed${detail === undefined ? "" : `: ${detail}`}`);
    this.name = "BasisChangedError";
  }
}

/** stage() was reached by a commit that did not go through commitGuarded: refused, nothing written. */
export class UnguardedCommitError extends Error {
  readonly code = "UNGUARDED_COMMIT";

  constructor() {
    super("a commit on a bridge section must go through commitGuarded (D-010 §5.8)");
    this.name = "UnguardedCommitError";
  }
}

/**
 * The check of one guarded commit, run inside stage: true when the replica
 * still matches the basis; false, or a string saying what differs, refuses.
 */
export type BasisCheck = () => true | false | string;

interface Guard {
  readonly check: BasisCheck;
  /** Set when stage ran for this call (a known receipt skips it). */
  staged: boolean;
}

export interface GuardedBinding<T> {
  /** The binding to give SyncClient.open: its stage refuses unguarded batches. */
  readonly binding: CommitBinding<T>;
  /**
   * Runs `commit` with a fresh copy of `intents` registered under `check`;
   * the copy is what `commit` must hand to SyncClient.commit.
   */
  guarded<R>(
    intents: readonly unknown[],
    check: BasisCheck,
    commit: (batch: readonly unknown[]) => Promise<R>,
  ): Promise<{ readonly result: R; readonly staged: boolean }>;
}

/** Wraps a CommitBinding (a section profile's commitBinding) with the guard registry. */
export function guardCommitBinding<T>(inner: CommitBinding<T>): GuardedBinding<T> {
  const guards = new WeakMap<readonly unknown[], Guard>();
  const binding: CommitBinding<T> = {
    codec: inner.codec,
    ...(inner.section === undefined ? {} : { section: () => inner.section?.() }),
    stage(intents: readonly unknown[]): StagedOperation<T> | null {
      const guard = guards.get(intents);
      if (guard === undefined) throw new UnguardedCommitError();
      guard.staged = true;
      const verdict = guard.check();
      if (verdict !== true) throw new BasisChangedError(verdict === false ? undefined : verdict);
      return inner.stage(intents);
    },
  };
  return {
    binding,
    async guarded(intents, check, commit) {
      // A new array per call: the registry key of this call only (r3 P2-5).
      const batch = Object.freeze([...intents]);
      const guard: Guard = { check, staged: false };
      guards.set(batch, guard);
      try {
        const result = await commit(batch);
        return { result, staged: guard.staged };
      } finally {
        guards.delete(batch);
      }
    },
  };
}
