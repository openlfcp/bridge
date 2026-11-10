// N8 from quiescence (D-010 r4 §9, B17 P1-1): precondition, atomic freeze, fresh LIVE, switch,
// revocation, abort.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Executor, Intents, type NewIntent } from "../src/executor/index.js";
import { Holds, Journal, openBridgeDatabase } from "../src/index.js";
import type { RevocationVerdict } from "../src/lfcp/access.js";
import {
  CATCH_UP_LIMIT_MS,
  type CatchUpState,
  MigrationError,
  type MigrationPorts,
  Migrations,
  quiescence,
} from "../src/migration.js";

const T0 = Date.parse("2026-11-10T10:00:00Z");

function rig(
  opts: { afterPairing?: (db: ReturnType<typeof openBridgeDatabase>) => void; file?: string } = {},
) {
  const db = openBridgeDatabase(opts.file ?? ":memory:");
  const clock = { t: T0 };
  db.prepare(
    "INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES ('i1', '/old', 'p1', 'r', 'Mac', '2026-11-01T00:00:00Z')",
  ).run();
  for (const [id, r] of [
    ["b1", "R1"],
    ["b2", "R2"],
  ])
    db.prepare(
      `INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, target_ref, state, created_at)
       VALUES (?, 'i1', ?, 'reminders', 'eventkit', ?, 'active', '2026-11-01T00:00:00Z')`,
    ).run(id, r, `L-${id}`);
  const calls: string[] = [];
  let paired = 0;
  const live: { states: CatchUpState[] } = { states: [] };
  const revocation: { verdict: RevocationVerdict } = { verdict: "active" };
  const pairing: { refuse: boolean } = { refuse: false };
  const ports: MigrationPorts = {
    async pair(req) {
      calls.push(`pair ${req.from} ${req.sections.join(",")}`);
      if (pairing.refuse) return undefined;
      paired += 1;
      return { id: `i${paired + 1}`, dir: "/new", principal: "p2", root: "r", label: "Mac" };
    },
    async catchUp(inst, rs) {
      calls.push(`catchUp ${inst} ${[...rs].sort().join(",")}`);
      return live.states;
    },
    async closeOld(inst) {
      calls.push(`closeOld ${inst}`);
    },
    reconcile(bs) {
      calls.push(`reconcile ${[...bs].sort().join(",")}`);
    },
    async revocationStatus(inst) {
      calls.push(`revocationStatus ${inst}`);
      return revocation.verdict;
    },
  };
  const m = new Migrations({
    db,
    journal: new Journal(db),
    ports,
    now: () => clock.t,
    afterPairing: () => opts.afterPairing?.(db),
  });
  const inst = (id: string) =>
    (
      db.prepare("SELECT status FROM installations WHERE id = ?").get(id) as
        | { status: string }
        | undefined
    )?.status;
  const holds = (b: string) => new Holds(db).of(b).map((h) => h.reason);
  const owner = (b: string) =>
    (
      db.prepare("SELECT installation_id FROM bindings WHERE id = ?").get(b) as {
        installation_id: string;
      }
    ).installation_id;
  const at = (ms: number) => new Date(ms).toISOString();
  const allLive = (connectedAt: string): CatchUpState[] => [
    { resourceId: "R1", live: true, connectedAt },
    { resourceId: "R2", live: true, connectedAt },
  ];
  return { db, m, clock, calls, live, revocation, pairing, inst, holds, owner, at, allLive };
}

function intent(
  db: ReturnType<typeof openBridgeDatabase>,
  id: string,
  state: string,
  extra: { direction?: string; batch?: string | null; task?: string } = {},
) {
  db.prepare(
    `INSERT INTO intents (id, binding_id, task_id, installation_id, direction, kind, fields_json, basis_json,
       payload_json, operation_id, state, batch_status, created_at)
     VALUES (?, 'b1', ?, 'i1', ?, 'update', '[]', '{}', '{}', ?, ?, ?, '2026-11-10T00:00:00Z')`,
  ).run(
    id,
    extra.task ?? `T-${id}`,
    extra.direction ?? "to_apple",
    `op-${id}`,
    state,
    extra.batch ?? null,
  );
}

describe("N8 precondition: only from quiescence", () => {
  it("open intents, unfinished batches, open conflicts and quarantine refuse sections add; nothing starts", async () => {
    const r = rig();
    intent(r.db, "x1", "prepared");
    intent(r.db, "x2", "finalized", { direction: "to_lfcp", batch: "pending" });
    intent(r.db, "x3", "finalized", { direction: "to_lfcp", batch: "accepted" });
    r.db
      .prepare(
        "INSERT INTO conflicts (id, binding_id, task_id, field, kind, created_at) VALUES ('c1', 'b2', 'T', 'title', 'lfcp_rejected', '2026-11-10T00:00:00Z')",
      )
      .run();
    const out = await r.m.add("i1", ["Old", "Work"]);
    expect(out).toMatchObject({
      state: "refused",
      reasons: [
        { reason: "open_intents", count: 1 },
        { reason: "unfinished_batches", count: 1 },
        { reason: "open_conflicts", count: 1 },
      ],
    });
    expect(r.m.list()).toHaveLength(0);
    expect(r.calls).toEqual([]);
    expect(r.inst("i1")).toBe("active");
  });

  it("finished work does not count: finalized, accepted or no-op batches, resolved conflicts", () => {
    const r = rig();
    intent(r.db, "x1", "finalized");
    intent(r.db, "x2", "finalized", { direction: "to_lfcp", batch: "noop" });
    r.db
      .prepare(
        "INSERT INTO conflicts (id, binding_id, task_id, field, kind, created_at, resolved_at) VALUES ('c1', 'b2', 'T', 'title', 'lfcp_rejected', '2026-11-10T00:00:00Z', '2026-11-10T01:00:00Z')",
      )
      .run();
    expect(quiescence(r.db, "i1")).toEqual({ quiescent: true, reasons: [] });
  });
});

describe("N8 from quiescence to done", () => {
  it("pairing → atomic freeze → fresh LIVE → switch → closing → revocation", async () => {
    const r = rig();
    const out = await r.m.add("i1", ["Old", "Work"]);
    if (out.state !== "started") throw new Error("not started");
    const id = out.migration.id;
    // Frozen in one step: hold on every old binding, the old installation frozen.
    expect(out.migration).toMatchObject({ phase: "catching_up", to: "i2", blockedReason: null });
    expect(out.migration.frozenAt).toBe(r.at(T0));
    expect([r.inst("i1"), r.inst("i2")]).toEqual(["frozen", "active"]);
    expect([r.holds("b1"), r.holds("b2")]).toEqual([["migration"], ["migration"]]);
    // A LIVE on a connection opened before the freeze is not fresh.
    r.live.states = r.allLive(r.at(T0 - 1000));
    expect((await r.m.advance(id)).phase).toBe("catching_up");
    // One section fresh, the other not yet.
    r.clock.t += 60_000;
    r.live.states = [
      { resourceId: "R1", live: true, connectedAt: r.at(T0 + 1000) },
      { resourceId: "R2", live: false },
    ];
    expect((await r.m.advance(id)).phase).toBe("catching_up");
    r.live.states = r.allLive(r.at(T0 + 1000));
    const after = await r.m.advance(id);
    expect(after.phase).toBe("awaiting_revocation");
    expect([r.owner("b1"), r.owner("b2")]).toEqual(["i2", "i2"]);
    expect([r.inst("i1"), r.inst("i2")]).toEqual(["retired", "active"]);
    expect([r.holds("b1"), r.holds("b2")]).toEqual([[], []]);
    expect(r.calls).toContain("closeOld i1");
    expect(r.calls).toContain("reconcile b1,b2");
    // Not proven yet: it waits.
    expect((await r.m.advance(id)).phase).toBe("awaiting_revocation");
    r.revocation.verdict = "revocation-proven";
    expect((await r.m.advance(id)).phase).toBe("done");
    expect(r.inst("i1")).toBe("revoked");
    expect(r.calls[0]).toBe("pair i1 Old,Work");
  });

  it("a second sections add while one is under way is refused", async () => {
    const r = rig();
    await r.m.add("i1", ["Work"]);
    const again = await r.m.add("i1", ["Home"]);
    expect(again).toMatchObject({ state: "refused" });
  });
});

describe("N8 atomic freeze (B17 P1-1)", () => {
  it("an intent prepared between the precondition and the freeze aborts the migration: no hold, old active, new retired", async () => {
    const r = rig({
      afterPairing: (db) => {
        if (db.prepare("SELECT 1 FROM intents WHERE id = 'late'").get() === undefined)
          intent(db, "late", "prepared");
      },
    });
    const out = await r.m.add("i1", ["Work"]);
    if (out.state !== "started") throw new Error("not started");
    expect(out.migration).toMatchObject({ phase: "aborted", blockedReason: null });
    expect(out.migration.abortedReason).toMatch(/^not_quiescent: open_intents 1/);
    expect([r.inst("i1"), r.inst("i2")]).toEqual(["active", "retired"]);
    expect([r.holds("b1"), r.holds("b2")]).toEqual([[], []]);
    expect(out.migration.frozenAt).toBeNull();
    // The old installation works on; the intent is still there to run.
    expect(
      (r.db.prepare("SELECT state FROM intents WHERE id = 'late'").get() as { state: string })
        .state,
    ).toBe("prepared");
    // Later, quiescent again: a new sections add works.
    r.db.prepare("UPDATE intents SET state = 'finalized' WHERE id = 'late'").run();
    const again = await r.m.add("i1", ["Work"]);
    expect(again).toMatchObject({
      state: "started",
      migration: { phase: "catching_up", to: "i3" },
    });
  });

  it("a batch that is not final at the freeze aborts too", async () => {
    const r = rig({
      afterPairing: (db) => intent(db, "b", "finalized", { direction: "to_lfcp", batch: "saved" }),
    });
    const out = await r.m.add("i1", ["Work"]);
    expect(out).toMatchObject({ migration: { phase: "aborted" } });
    if (out.state === "started")
      expect(out.migration.abortedReason).toContain("unfinished_batches");
  });

  it("the pairing refused by the person: aborted, nothing frozen", async () => {
    const r = rig();
    r.pairing.refuse = true;
    const out = await r.m.add("i1", ["Work"]);
    expect(out).toMatchObject({
      migration: { phase: "aborted", abortedReason: "pairing_refused", to: null },
    });
    expect(r.inst("i1")).toBe("active");
  });
});

describe("N8 blocked, abort, resume", () => {
  it("catch-up over 24 h sets blocked_reason, the phase stays; abort then returns to the old installation", async () => {
    const r = rig();
    const out = await r.m.add("i1", ["Work"]);
    const id = (out as { migration: { id: string } }).migration.id;
    r.clock.t = T0 + CATCH_UP_LIMIT_MS + 1;
    const blocked = await r.m.advance(id);
    expect(blocked).toMatchObject({ phase: "catching_up" });
    expect(blocked.blockedReason).toBe("catch_up_over_24h: R1, R2");
    const aborted = r.m.abort(id);
    expect(aborted).toMatchObject({
      phase: "aborted",
      abortedReason: "person",
      blockedReason: null,
    });
    expect([r.inst("i1"), r.inst("i2")]).toEqual(["active", "retired"]);
    expect([r.holds("b1"), r.holds("b2")]).toEqual([[], []]);
    expect([r.owner("b1"), r.owner("b2")]).toEqual(["i1", "i1"]);
  });

  it("after switching only forward: abort refused; a crash in switching resumes idempotently", async () => {
    const r = rig();
    const out = await r.m.add("i1", ["Work"]);
    const id = (out as { migration: { id: string } }).migration.id;
    // A crash right after the phase became switching (before the switch transaction).
    r.db.prepare("UPDATE migrations SET phase = 'switching' WHERE id = ?").run(id);
    expect(() => r.m.abort(id)).toThrow(MigrationError);
    r.db.prepare("UPDATE migrations SET phase = 'switched' WHERE id = ?").run(id);
    expect((await r.m.advance(id)).phase).toBe("awaiting_revocation");
    expect([r.owner("b1"), r.owner("b2")]).toEqual(["i2", "i2"]);
    expect(() => r.m.abort(id)).toThrow(MigrationError);
  });

  it("a crash after the pairing answered (to_installation kept) resumes at the freeze without pairing again", async () => {
    const r = rig();
    r.db
      .prepare(
        "INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES ('i2', '/new', 'p2', 'r', 'Mac', '2026-11-10T00:00:00Z')",
      )
      .run();
    r.db
      .prepare(
        "INSERT INTO migrations (id, from_installation, to_installation, phase, created_at, updated_at) VALUES ('m1', 'i1', 'i2', 'pairing', 'x', 'x')",
      )
      .run();
    r.db
      .prepare(
        "INSERT INTO migration_details (migration_id, sections_json) VALUES ('m1', '[\"Work\"]')",
      )
      .run();
    expect((await r.m.advance("m1")).phase).toBe("catching_up");
    expect(r.calls.filter((c) => c.startsWith("pair"))).toEqual([]);
    expect(r.holds("b1")).toEqual(["migration"]);
  });
});

const update = (task: string): NewIntent => ({
  bindingId: "b1",
  taskId: task,
  installationId: "i1",
  direction: "to_apple",
  kind: "update",
  fields: ["title"],
  basis: {},
  payload: { kind: "update", ref: { id: `rem-${task}` }, expect: { rev: "1" } },
});
const openIntents = (db: ReturnType<typeof openBridgeDatabase>) =>
  (db.prepare("SELECT count(*) AS n FROM intents").get() as { n: number }).n;

describe("N8: no new intents for a frozen installation (review PR 13 P1-1)", () => {
  const executor = (db: ReturnType<typeof openBridgeDatabase>) =>
    new Executor({
      db,
      transport: {} as never,
      lfcp: {} as never,
      gates: {} as never,
      handler: {} as never,
    });

  it("after the freeze the executor prepares nothing for the old installation; after abort it does", async () => {
    const r = rig();
    const out = await r.m.add("i1", ["Work"]);
    const id = (out as { migration: { id: string; phase: string } }).migration.id;
    expect(r.m.get(id)?.phase).toBe("catching_up");
    expect(() => executor(r.db).prepare("b1", { intents: [update("T1")], unlinks: 0 })).toThrow(
      /migration/,
    );
    expect(openIntents(r.db)).toBe(0);
    r.m.abort(id);
    expect(executor(r.db).prepare("b1", { intents: [update("T1")], unlinks: 0 })).toHaveLength(1);
  });

  it("another connection to the same database cannot prepare either once the freeze committed", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "lfcp-n8-")), "bridge.sqlite");
    const r = rig({ file });
    const other = openBridgeDatabase(file);
    try {
      await r.m.add("i1", ["Work"]);
      expect(() => new Intents(other).prepare(update("T2"))).toThrow(/migration/);
      expect(openIntents(other)).toBe(0);
    } finally {
      other.close();
    }
  });

  it("an installation that is not active gets no new intents", () => {
    const r = rig();
    r.db.prepare("UPDATE installations SET status = 'retired' WHERE id = 'i1'").run();
    expect(() => new Intents(r.db).prepare(update("T3"))).toThrow(/not active/);
  });
});
