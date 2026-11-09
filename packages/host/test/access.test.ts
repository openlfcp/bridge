// Access readiness (D-010 §5.3, R2-13, r3 P2-4): access_checked_now per
// generation, offline_commit_allowed kept, refusal → revocationStatus,
// a proven revocation for good, the access_refused hold.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SyncEvent, WriteAccess } from "@openlfcp/client";
import { generateResourceId, type ResourceId, toHex } from "@openlfcp/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AccessSource,
  AccessTracker,
  applyAccessHolds,
  type BridgeDatabase,
  Holds,
  type LiveChange,
  metaAccessStore,
  openBridgeDatabase,
  type RevocationVerdict,
} from "../src/index.js";

let dir: string;
let db: BridgeDatabase;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lfcp-bridge-access-"));
  db = openBridgeDatabase(join(dir, "bridge.sqlite"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const R = generateResourceId();
const allowed: WriteAccess = { allowed: true, reason: null, controlHead: null, verifiedAt: 1 };
const denied = (reason: WriteAccess["reason"]): WriteAccess => ({
  allowed: false,
  reason,
  controlHead: null,
  verifiedAt: 1,
});

/** A SectionHost stand-in: its generation, live changes and events, and canWrite. */
function source() {
  const live = new Set<(c: LiveChange) => void>();
  const events = new Set<(e: SyncEvent) => void>();
  const s = {
    generation: 0,
    access: allowed,
    pendingCanWrite: undefined as undefined | Promise<void>,
    canWrite: async (_r: ResourceId) => {
      await s.pendingCanWrite;
      return s.access;
    },
    onLiveChange: (l: (c: LiveChange) => void) => {
      live.add(l);
      return () => live.delete(l);
    },
    onSyncEvent: (l: (e: SyncEvent) => void) => {
      events.add(l);
      return () => events.delete(l);
    },
    goLive: (r: ResourceId) => {
      for (const l of live) l({ resource: r, live: true, generation: s.generation });
    },
    newGeneration: () => {
      s.generation++;
      for (const l of live)
        l({ resource: null, live: false, generation: s.generation, reason: "disconnect" });
    },
    refuse: (r: ResourceId, code: string) => {
      for (const l of events)
        l({
          type: "resource-refused",
          resourceId: r,
          refusal: { code, url: "ws://x", request: "open" },
        } as never);
    },
  };
  return s satisfies AccessSource & Record<string, unknown>;
}

function tracker(src: ReturnType<typeof source>, verdict: RevocationVerdict = "access-refused") {
  const asked: string[] = [];
  const t = new AccessTracker({
    source: src,
    store: metaAccessStore(db, "i1"),
    checkRevocation: async (r) => {
      asked.push(toHex(r));
      return verdict;
    },
  });
  return { t, asked };
}

describe("AccessTracker", () => {
  it("checked now after LIVE in this generation; a new generation unchecks, the kept answer stays", async () => {
    const src = source();
    const { t } = tracker(src);
    expect([t.accessCheckedNow(R), t.offlineCommitAllowed(R)]).toEqual([false, false]);
    src.goLive(R);
    await t.settled();
    expect([t.accessCheckedNow(R), t.offlineCommitAllowed(R)]).toEqual([true, true]);
    src.newGeneration();
    expect([t.accessCheckedNow(R), t.offlineCommitAllowed(R)]).toEqual([false, true]);
    // The kept answer survives a restart (bridge.sqlite).
    const again = tracker(source()).t;
    expect(again.offlineCommitAllowed(R)).toBe(true);
    expect(again.accessCheckedNow(R)).toBe(false);
  });

  it("read-only is checked (it may read) but does not allow queueing commits", async () => {
    const src = source();
    src.access = denied("read-only");
    const { t } = tracker(src);
    src.goLive(R);
    await t.settled();
    expect([t.accessCheckedNow(R), t.offlineCommitAllowed(R), t.answerNow(R)]).toEqual([
      true,
      false,
      "read-only",
    ]);
  });

  it("an answer of a generation that ended meanwhile is not an answer now", async () => {
    const src = source();
    let release: () => void = () => undefined;
    src.pendingCanWrite = new Promise<void>((r) => {
      release = r;
    });
    const { t } = tracker(src);
    src.goLive(R);
    src.newGeneration();
    release();
    await t.settled();
    expect(t.accessCheckedNow(R)).toBe(false);
    expect(t.answerNow(R)).toBeUndefined();
  });

  it("a refusal asks revocationStatus; refused unchecks and stops offline commits", async () => {
    const src = source();
    const { t, asked } = tracker(src, "access-refused");
    src.goLive(R);
    await t.settled();
    src.refuse(R, "AUTHORIZATION_FAILED");
    await t.settled();
    expect(asked).toEqual([toHex(R)]);
    expect([t.accessCheckedNow(R), t.offlineCommitAllowed(R), t.answerNow(R)]).toEqual([
      false,
      false,
      "refused",
    ]);
    // The server lets it in again (not a revocation): checked again.
    src.goLive(R);
    await t.settled();
    expect(t.accessCheckedNow(R)).toBe(true);
  });

  it("a proven revocation is for good: kept even when proven after the generation ended, never lifted", async () => {
    const src = source();
    let prove: (v: RevocationVerdict) => void = () => undefined;
    const t = new AccessTracker({
      source: src,
      store: metaAccessStore(db, "i1"),
      checkRevocation: () =>
        new Promise<RevocationVerdict>((r) => {
          prove = r;
        }),
    });
    src.refuse(R, "AUTHORIZATION_FAILED");
    src.newGeneration();
    prove("revocation-proven");
    await t.settled();
    expect(metaAccessStore(db, "i1").get(R)?.answer).toBe("revoked");
    // A later LIVE with a write access from the local chain does not lift it.
    src.goLive(R);
    await t.settled();
    expect([t.accessCheckedNow(R), t.offlineCommitAllowed(R), t.answerNow(R)]).toEqual([
      false,
      false,
      "revoked",
    ]);
  });
});

describe("the access_refused hold", () => {
  it("is set on the live bindings of the Resource by a refusal and lifted by an allowed answer", () => {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES ('i', 'd', 'p', 'r', 'l', ?)",
    ).run(now);
    const binding = (id: string, state: string) =>
      db
        .prepare(
          "INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, target_ref, state, created_at) VALUES (?, 'i', ?, 'apple-reminders', 'fake', ?, ?, ?)",
        )
        .run(id, toHex(R), `list-${id}`, state, now);
    binding("b1", "active");
    binding("b0", "removed");
    const holds = new Holds(db);
    applyAccessHolds(db, "i", R, "refused");
    expect([holds.has("b1", "access_refused"), holds.has("b0", "access_refused")]).toEqual([
      true,
      false,
    ]);
    applyAccessHolds(db, "i", R, "read-only");
    expect(holds.has("b1", "access_refused")).toBe(false);
    applyAccessHolds(db, "i", R, "revoked");
    expect(holds.of("b1")[0]?.detail).toEqual({ answer: "revoked" });
  });
});

// Review PR 3b (r2).
describe("AccessTracker, review PR 3b", () => {
  it("#1 a canWrite started before a refusal does not undo it (same generation)", async () => {
    const src = source();
    let release: () => void = () => undefined;
    src.pendingCanWrite = new Promise<void>((r) => {
      release = r;
    });
    const { t } = tracker(src, "access-refused");
    src.goLive(R);
    src.refuse(R, "AUTHORIZATION_FAILED");
    release();
    await t.settled();
    expect([t.accessCheckedNow(R), t.offlineCommitAllowed(R), t.answerNow(R)]).toEqual([
      false,
      false,
      "refused",
    ]);
    // A check started after the refusal may allow again.
    src.pendingCanWrite = undefined;
    src.goLive(R);
    await t.settled();
    expect(t.accessCheckedNow(R)).toBe(true);
  });

  it("#2 a revocation proven late (request of an older generation) ends the readiness now", async () => {
    const src = source();
    let prove: (v: RevocationVerdict) => void = () => undefined;
    const changes: string[] = [];
    const t = new AccessTracker({
      source: src,
      store: metaAccessStore(db, "i1"),
      checkRevocation: () =>
        new Promise<RevocationVerdict>((r) => {
          prove = r;
        }),
    });
    t.onChange((c) => changes.push(c.answer));
    src.refuse(R, "AUTHORIZATION_FAILED");
    src.newGeneration();
    src.goLive(R);
    await new Promise((r) => setTimeout(r, 0));
    expect(t.accessCheckedNow(R)).toBe(true);
    prove("revocation-proven");
    await t.settled();
    expect([t.accessCheckedNow(R), t.offlineCommitAllowed(R), t.answerNow(R)]).toEqual([
      false,
      false,
      "revoked",
    ]);
    expect(changes.at(-1)).toBe("revoked");
  });

  it("#3 access and holds belong to an installation: an old one's revocation does not block the new one", async () => {
    const now = new Date().toISOString();
    for (const i of ["old", "new"])
      db.prepare(
        "INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES (?, 'd', ?, 'r', 'l', ?)",
      ).run(i, `p-${i}`, now);
    db.prepare(
      "INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, target_ref, state, created_at) VALUES ('b-old', 'old', ?, 'apple-reminders', 'fake', 'L1', 'removed', ?)",
    ).run(toHex(R), now);
    db.prepare(
      "INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, target_ref, state, created_at) VALUES ('b-new', 'new', ?, 'apple-reminders', 'fake', 'L1', 'active', ?)",
    ).run(toHex(R), now);
    const oldSrc = source();
    const old = new AccessTracker({
      source: oldSrc,
      store: metaAccessStore(db, "old"),
      checkRevocation: async () => "revocation-proven",
    });
    oldSrc.refuse(R, "AUTHORIZATION_FAILED");
    await old.settled();
    const newSrc = source();
    const fresh = new AccessTracker({
      source: newSrc,
      store: metaAccessStore(db, "new"),
      checkRevocation: async () => "active",
    });
    expect(fresh.offlineCommitAllowed(R)).toBe(false);
    newSrc.goLive(R);
    await fresh.settled();
    expect([fresh.accessCheckedNow(R), fresh.offlineCommitAllowed(R)]).toEqual([true, true]);
    expect(old.offlineCommitAllowed(R)).toBe(false);
    // A late refusal of the old installation sets no hold on the new one's binding.
    applyAccessHolds(db, "old", R, "revoked");
    expect(new Holds(db).has("b-new", "access_refused")).toBe(false);
    applyAccessHolds(db, "new", R, "refused");
    expect(new Holds(db).has("b-new", "access_refused")).toBe(true);
  });

  it("#4 a revoked capability is not a proven device revocation: a later grant restores access", async () => {
    const src = source();
    src.access = denied("revoked");
    const { t } = tracker(src);
    src.goLive(R);
    await t.settled();
    expect(t.answerNow(R)).toBe("refused");
    expect(metaAccessStore(db, "i1").get(R)?.detail).toBe("revoked");
    src.access = allowed;
    src.newGeneration();
    src.goLive(R);
    await t.settled();
    expect([t.accessCheckedNow(R), t.answerNow(R)]).toEqual([true, "allowed"]);
  });
});
