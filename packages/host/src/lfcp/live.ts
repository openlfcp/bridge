// lfcp_live (D-010 §5.3, R2-13): a Resource is live when it is LIVE **now**
// in the **current** generation of the connection, as the SDK's events say —
// never from catchUp (CLOSED after LIVE also reports "current-at-checkpoint").
//
// - A Resource becomes live on its `resource-state` LIVE event, and stops on
//   any other state of it (OPENING, CONTROL_SYNC, … CLOSED). A LIVE counts
//   only on a connection that is READY in the current generation and after
//   the Resource was opened on it (an opening state seen in this
//   generation): the SDK handles a lost connection's messages and its close
//   in its serial queue, so a data round of the old connection can still end
//   in LIVE after the loss was reported, or after the new READY (review PR 3a).
// - Leaving READY (the connection is lost) starts a new generation: nothing
//   is live until each Resource is LIVE again in it.
// - wake (from the helper, or a jump of the clock) starts a new generation
//   too: the connection that looked alive before the sleep no longer counts,
//   a new READY and a new open are needed (PR 3b drops and makes it again).
// - a rebuild of a section's replica (`nodesChanged` with origin
//   "rebuild", or a checkpoint that could not be restored) makes that
//   Resource not live until its next LIVE.

import type { SyncEvent } from "@openlfcp/client";
import { type ResourceId, toHex } from "@openlfcp/core";

export type LiveReset = "disconnect" | "wake" | "rebuild";

/** The states of a Resource being opened on a connection (before LIVE). */
const OPENING_STATES: ReadonlySet<string> = new Set([
  "OPENING",
  "CONTROL_SYNC",
  "KEY_SYNC",
  "DATA_SYNC",
]);

export interface LiveChange {
  readonly resource: ResourceId | null;
  readonly live: boolean;
  readonly generation: number;
  /** Why it stopped, when it did. */
  readonly reason?: LiveReset;
}

export class LiveTracker {
  readonly #live = new Map<string, ResourceId>();
  readonly #listeners = new Set<(c: LiveChange) => void>();
  #generation = 0;
  /** The connection is READY in the current generation. */
  #ready = false;
  /** The generation each Resource was last seen opening in (on a READY connection). */
  readonly #opened = new Map<string, number>();

  /** The current generation of the connection (it grows on disconnect and wake). */
  get generation(): number {
    return this.#generation;
  }

  /** lfcp_live of `resource`. */
  isLive(resource: ResourceId): boolean {
    return this.#live.has(toHex(resource));
  }

  /** The live Resources (hex). */
  liveResources(): readonly string[] {
    return [...this.#live.keys()].sort();
  }

  onChange(listener: (c: LiveChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Feeds one SyncEvent of the section session. */
  event(e: SyncEvent): void {
    if (e.type === "connection") {
      // Leaving READY ends the generation (once: the states of reconnecting follow).
      if (e.state === "READY") this.#ready = true;
      else if (this.#ready) {
        this.#ready = false;
        this.#newGeneration("disconnect");
      }
      return;
    }
    if (e.type !== "resource-state") return;
    const key = toHex(e.resourceId);
    if (OPENING_STATES.has(e.state)) {
      if (this.#ready) this.#opened.set(key, this.#generation);
    }
    if (e.state === "LIVE") {
      // Only on a READY connection of this generation, after an open on it.
      if (!this.#ready || this.#opened.get(key) !== this.#generation) return;
      if (this.#live.has(key)) return;
      this.#live.set(key, e.resourceId);
      this.#emit({ resource: e.resourceId, live: true, generation: this.#generation });
    } else if (this.#live.delete(key))
      this.#emit({ resource: e.resourceId, live: false, generation: this.#generation });
  }

  /** The system woke up: nothing is live until LIVE again. */
  wake(): void {
    // The connection that was up before the sleep no longer counts: a new READY is needed,
    // and its loss starts no other generation.
    this.#ready = false;
    this.#newGeneration("wake");
  }

  /** `resource`'s replica was rebuilt: not live until its next LIVE. */
  rebuilt(resource: ResourceId): void {
    if (this.#live.delete(toHex(resource)))
      this.#emit({ resource, live: false, generation: this.#generation, reason: "rebuild" });
  }

  #newGeneration(reason: LiveReset): void {
    this.#generation++;
    this.#opened.clear();
    const was = [...this.#live.values()];
    this.#live.clear();
    for (const r of was)
      this.#emit({ resource: r, live: false, generation: this.#generation, reason });
    this.#emit({ resource: null, live: false, generation: this.#generation, reason });
  }

  #emit(c: LiveChange): void {
    for (const l of this.#listeners) l(c);
  }
}
