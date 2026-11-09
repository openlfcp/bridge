// lfcp_live (D-010 §5.3, R2-13) from the SDK's events.

import type { SyncEvent } from "@openlfcp/client";
import { generateResourceId } from "@openlfcp/core";
import { describe, expect, it } from "vitest";
import { type LiveChange, LiveTracker } from "../src/index.js";

const R1 = generateResourceId();
const R2 = generateResourceId();
const state = (resourceId: typeof R1, s: string) =>
  ({ type: "resource-state", resourceId, state: s }) as SyncEvent;
const conn = (s: string) => ({ type: "connection", state: s }) as SyncEvent;

describe("LiveTracker", () => {
  it("live is LIVE now, in the current generation; a lost connection ends the generation once", () => {
    const t = new LiveTracker();
    const changes: LiveChange[] = [];
    t.onChange((c) => changes.push(c));
    for (const s of ["CONNECTING", "NEGOTIATING", "AUTHENTICATING", "READY"]) t.event(conn(s));
    t.event(state(R1, "OPENING"));
    t.event(state(R1, "DATA_SYNC"));
    expect(t.isLive(R1)).toBe(false);
    t.event(state(R1, "LIVE"));
    t.event(state(R2, "OPENING"));
    t.event(state(R2, "LIVE"));
    expect([t.isLive(R1), t.isLive(R2), t.generation]).toEqual([true, true, 0]);
    // A Resource leaving LIVE (refused, closed) is no longer live.
    t.event(state(R2, "CLOSED"));
    expect(t.isLive(R2)).toBe(false);
    // The connection is lost: DISCONNECTED twice, then reconnecting.
    for (const s of ["DISCONNECTED", "DISCONNECTED", "CONNECTING", "DISCONNECTED"])
      t.event(conn(s));
    expect([t.isLive(R1), t.generation]).toEqual([false, 1]);
    t.event(conn("CONNECTING"));
    t.event(conn("READY"));
    t.event(state(R1, "CONTROL_SYNC"));
    expect(t.isLive(R1)).toBe(false);
    t.event(state(R1, "LIVE"));
    expect([t.isLive(R1), t.generation]).toEqual([true, 1]);
    expect(changes.filter((c) => c.reason === "disconnect").map((c) => c.resource)).toEqual([
      R1,
      null,
    ]);
  });

  it("wake and rebuild reset it until the next LIVE", () => {
    const t = new LiveTracker();
    t.event(conn("READY"));
    for (const r of [R1, R2]) {
      t.event(state(r, "OPENING"));
      t.event(state(r, "LIVE"));
    }
    t.wake();
    expect([t.isLive(R1), t.isLive(R2), t.generation]).toEqual([false, false, 1]);
    // A new connection, and both opened on it.
    t.event(conn("READY"));
    for (const r of [R1, R2]) {
      t.event(state(r, "OPENING"));
      t.event(state(r, "LIVE"));
    }
    t.rebuilt(R1);
    expect([t.isLive(R1), t.isLive(R2), t.generation]).toEqual([false, true, 1]);
    t.event(state(R1, "LIVE"));
    expect(t.isLive(R1)).toBe(true);
  });
});

// Review PR 3a (P1): a LIVE of the old connection, handled late, is not live now.
describe("LiveTracker and late events of an old connection", () => {
  it("a LIVE after the connection was lost does not count, nor one before the Resource opened again", () => {
    const t = new LiveTracker();
    t.event(conn("READY"));
    t.event(state(R1, "OPENING"));
    t.event(state(R1, "DATA_SYNC"));
    t.event(conn("DISCONNECTED"));
    // The data round of the lost connection finishes late.
    t.event(state(R1, "LIVE"));
    expect([t.isLive(R1), t.generation]).toEqual([false, 1]);
    // Reconnected: READY, but the Resource has not opened on it yet.
    t.event(conn("CONNECTING"));
    t.event(conn("READY"));
    t.event(state(R1, "LIVE"));
    expect(t.isLive(R1)).toBe(false);
    // It opens on the new connection: its LIVE counts.
    t.event(state(R1, "OPENING"));
    t.event(state(R1, "CONTROL_SYNC"));
    t.event(state(R1, "LIVE"));
    expect([t.isLive(R1), t.generation]).toEqual([true, 1]);
  });

  it("after wake, nothing of the connection that was up counts: a new READY and a new open are needed", () => {
    const t = new LiveTracker();
    t.event(conn("READY"));
    t.event(state(R1, "OPENING"));
    t.event(state(R1, "LIVE"));
    t.wake();
    // A late LIVE of the connection that was up before the sleep.
    t.event(state(R1, "LIVE"));
    t.event(state(R1, "OPENING"));
    t.event(state(R1, "LIVE"));
    expect([t.isLive(R1), t.generation]).toEqual([false, 1]);
    // The connection is made again (PR 3b drops it on wake): its loss starts no other generation.
    t.event(conn("DISCONNECTED"));
    t.event(conn("CONNECTING"));
    t.event(conn("READY"));
    t.event(state(R1, "OPENING"));
    t.event(state(R1, "LIVE"));
    expect([t.isLive(R1), t.generation]).toEqual([true, 1]);
  });
});
