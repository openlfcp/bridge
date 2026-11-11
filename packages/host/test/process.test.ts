// The run process (D-010 PR 9b): start, the write gate (B16, §7.6), triggers with debounce, one
// pass at a time per binding, "bases" decisions recorded, holds and resume, stop. On a real
// section replica (offline SectionHost) and the fake account; the live server variant is
// run.live.test.ts.

import { receiptOf } from "@openlfcp/client";
import { toHex } from "@openlfcp/core";
import { deleteTask, principalRef, setDue, setTitle, unassign } from "@openlfcp/shared-objects";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeProcess, bumpControl, Holds } from "../src/index.js";
import { markerUrl } from "../src/ownership.js";
import { type Bridge, bridge } from "./support/bridge.js";

const INSTANCE = "1b2d3f4a-0000-4000-8000-000000000001";
let b: Bridge;
let p: BridgeProcess | undefined;
afterEach(async () => {
  await p?.stop().catch(() => {});
  p = undefined;
  await b?.close();
});

/** A process on the harness's binding; the list carries this bridge's ownership marker. */
/** The writes-verified flag of the processes made below (§7.6). */
const verified = { now: false };

function processOf(
  o: {
    verification?: boolean;
    state?: string;
    /** Overrides of the host port (a key → its value; undefined: the real host's). */
    host?: (key: PropertyKey, target: typeof b.host) => unknown;
    stopped?: () => boolean;
    onHoldsLifted?: (reasons: ReadonlySet<string>) => void;
    controlEveryMs?: number;
  } = {},
) {
  b.db
    .prepare("UPDATE bindings SET verification = ?, state = ?")
    .run(o.verification === false ? 0 : 1, o.state ?? "active");
  b.person.create(b.list.id, "LFCP bridge · не удалять", {
    url: markerUrl(INSTANCE, toHex(b.R)),
    completed: true,
  });
  p = new BridgeProcess({
    db: b.db,
    transport: b.t,
    installations: [
      {
        id: "i",
        // lfcp_live (§5.3): the offline host never is; LFCP counts as caught up here.
        host: new Proxy(b.host, {
          get(target, key) {
            if (key === "isLive") return () => true;
            const over = o.host?.(key, target);
            if (over !== undefined) return over;
            const v = Reflect.get(target, key, target);
            return typeof v === "function" ? v.bind(target) : v;
          },
        }),
        receipt: (r, op) => receiptOf(b.storage, r, op),
        access: { accessCheckedNow: () => true, offlineCommitAllowed: () => true },
        me: principalRef(b.root),
        createdBy: b.root,
      },
    ],
    instanceId: INSTANCE,
    writesVerified: () => verified.now,
    stopped: o.stopped ?? (() => false),
    timeZone: "UTC",
    debounceMs: 5,
    maxDelayMs: 20,
    controlEveryMs: o.controlEveryMs ?? 60_000,
    ...(o.onHoldsLifted === undefined ? {} : { onHoldsLifted: o.onHoldsLifted }),
  });
  return p;
}
const reminders = () => b.reminders(b.list.id).filter((r) => !r.completed);
const runsOf = (kind: string) =>
  (b.db.prepare("SELECT count(*) AS n FROM runs WHERE kind = ?").get(kind) as { n: number }).n;

describe("start and the write gate (B16, §7.6)", () => {
  it("an approved verification binding applies: the start's full pass projects the Task", async () => {
    b = await bridge();
    await b.task("Buy milk");
    await processOf().start();
    expect(reminders().map((r) => r.title)).toEqual(["Buy milk"]);
    expect(runsOf("apply")).toBe(1);
    expect(
      b.db.prepare("SELECT kind, ended_at FROM runs WHERE kind = 'process'").get(),
    ).toMatchObject({
      kind: "process",
      ended_at: null,
    });
  });

  it("a normal binding without writesVerified only dry-runs; with it, it applies", async () => {
    b = await bridge();
    await b.task("Buy milk");
    verified.now = false;
    const proc = processOf({ verification: false });
    await proc.start();
    expect(reminders()).toEqual([]);
    expect(runsOf("dry")).toBe(1);
    expect(runsOf("apply")).toBe(0);
    expect(await proc.pass("b")).toMatchObject({ kind: "dry", why: "gate" });
    verified.now = true;
    expect(await proc.pass("b")).toMatchObject({ kind: "applied" });
    expect(reminders().map((r) => r.title)).toEqual(["Buy milk"]);
    verified.now = false;
  });

  it("pending_dry_run is never applied, even a verification binding", async () => {
    b = await bridge();
    await b.task("Buy milk");
    const proc = processOf({ state: "pending_dry_run" });
    await proc.start();
    expect(await proc.pass("b")).toMatchObject({ kind: "dry", why: "pending_dry_run" });
    expect(reminders()).toEqual([]);
  });

  it("the start seeds the bridge instance id of links from config.json (one b for markers and links)", async () => {
    b = await bridge();
    await b.task("Buy milk");
    await processOf().start();
    expect(reminders()[0]?.linkUrl).toContain(`&b=${INSTANCE.slice(0, 8)}`);
  });
});

describe("triggers, one pass at a time, decisions", () => {
  it("an edit in Apple → the change hint → a debounced pass → LFCP", async () => {
    b = await bridge();
    const task = await b.task("Buy milk");
    const proc = processOf();
    await proc.start();
    const r = reminders()[0];
    if (r === undefined) throw new Error("no reminder");
    b.person.edit(r.ref, { title: "Buy oat milk" });
    b.person.edit(r.ref, { title: "Buy oat milk, 2" });
    await new Promise((x) => setTimeout(x, 40));
    await proc.idle();
    expect(b.now(task.id).title).toBe("Buy oat milk, 2");
  });

  it("an edit in LFCP → a pass (remote nodes are scheduled; here asked directly) → the reminder", async () => {
    b = await bridge();
    const task = await b.task("Buy milk");
    const proc = processOf();
    await proc.start();
    await b.edit(setTitle(b.now(task.id), "Buy bread"));
    proc.schedule("b");
    await new Promise((x) => setTimeout(x, 20));
    await proc.idle();
    expect(reminders()[0]?.title).toBe("Buy bread");
  });

  it("one pass at a time per binding; one asked during it runs once more after", async () => {
    b = await bridge();
    await b.task("Buy milk");
    const proc = processOf();
    await proc.start();
    let inFlight = 0;
    let most = 0;
    const snapshot = b.t.snapshot.bind(b.t);
    b.t.snapshot = async (l) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((x) => setTimeout(x, 10));
      inFlight--;
      return snapshot(l);
    };
    const before = runsOf("apply");
    await Promise.all([proc.pass("b"), proc.pass("b"), proc.pass("b")]);
    await proc.idle();
    expect(most).toBe(1);
    expect(runsOf("apply") - before).toBe(2);
  });

  it("the 'bases' decisions of an applied pass are recorded (a first link that agrees)", async () => {
    b = await bridge();
    const task = await b.task("Same");
    const proc = processOf();
    await proc.start();
    // Linked; drop the bases (a first link again), the sides are equal.
    b.db.prepare("DELETE FROM bases").run();
    const r = await proc.pass("b");
    expect(r).toMatchObject({ kind: "applied", recorded: 4 });
    const rows = b.db
      .prepare("SELECT field, intent_id FROM bases WHERE task_id = ? ORDER BY field")
      .all(task.id);
    expect(rows).toEqual([
      { field: "due", intent_id: null },
      { field: "priority", intent_id: null },
      { field: "status", intent_id: null },
      { field: "title", intent_id: null },
    ]);
    expect(await proc.pass("b")).toMatchObject({ kind: "applied", recorded: 0, outcomes: [] });
  });
});

describe("holds, resume, stop", () => {
  it("a mass unlink holds the pass until the hold is lifted; then it applies", async () => {
    b = await bridge({ filter: "mine" });
    const tasks = [];
    for (let k = 0; k < 4; k++) tasks.push(await b.task(`T${k}`));
    const proc = processOf();
    await proc.start();
    for (const t of tasks) await b.edit(unassign(b.now(t.id), b.root));
    expect(await proc.pass("b")).toMatchObject({ kind: "held", holds: ["guard_mass_unlink"] });
    expect(b.link((tasks[0] as { id: string }).id)?.state).toBe("linked");
    // resume --accept: the hold lifted and this anomaly accepted.
    new Holds(b.db).accept("b", "guard_mass_unlink");
    expect(await proc.pass("b")).toMatchObject({ kind: "applied" });
    expect(b.link((tasks[0] as { id: string }).id)?.state).toBe("out_of_filter");
    expect(reminders()).toHaveLength(4);
  });

  it("an accepted anomaly is the new baseline: the passes after it are not held again by it", async () => {
    b = await bridge({ filter: "mine" });
    const tasks = [];
    for (let k = 0; k < 4; k++) tasks.push(await b.task(`T${k}`));
    const proc = processOf();
    await proc.start();
    for (const t of tasks) await b.edit(unassign(b.now(t.id), b.root));
    const held = await proc.pass("b");
    expect(held).toMatchObject({ kind: "held" });
    const holds = new Holds(b.db);
    for (const h of holds.of("b")) holds.accept("b", h.reason);
    expect(await proc.pass("b")).toMatchObject({ kind: "applied" });
    // The accepted pass's four unlinks (journaled as accepted) and its count drop are the baseline.
    expect(await proc.pass("b")).toMatchObject({ kind: "applied" });
    expect(holds.of("b")).toEqual([]);
    expect(await proc.pass("b")).toMatchObject({ kind: "applied" });
  });

  it("stop: no pass after it, the process run is closed", async () => {
    b = await bridge();
    const proc = processOf();
    await proc.start();
    await proc.stop("signal");
    p = undefined;
    expect(await proc.pass("b")).toEqual({ kind: "skipped", reason: "stopping" });
    expect(b.db.prepare("SELECT outcome FROM runs WHERE kind = 'process'").get()).toEqual({
      outcome: "signal",
    });
  });
});

// ------------------------------------------------------------------ review PR 9b

const linkOf = (task: string) =>
  b.db.prepare("SELECT state FROM links WHERE task_id = ?").get(task) as
    | { state: string }
    | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const marker = () =>
  b.reminders(b.list.id).find((r) => r.completed && r.linkUrl?.startsWith("lfcp://bridge/"));

describe("review PR 9b", () => {
  it("#23 ownership on every pass: own marker gone → ownership_lost, nothing written", async () => {
    b = await bridge();
    const task = await b.task("A");
    const proc = processOf();
    await proc.start();
    b.person.delete((marker() as { ref: { id: string } }).ref);
    await b.edit(setTitle(b.now(task.id), "B"));
    expect(await proc.pass("b")).toMatchObject({ kind: "held", holds: ["ownership_lost"] });
    expect(reminders()[0]?.title).toBe("A");
  });

  it("#23 a foreign marker of the section in another list → foreign_bridge; once it is gone, writes go on", async () => {
    b = await bridge();
    const task = await b.task("A");
    const proc = processOf();
    await proc.start();
    const other = b.person.createList("Other");
    const foreign = b.person.create(other.id, "LFCP bridge · не удалять", {
      url: markerUrl("ffffffff-0000-4000-8000-000000000000", toHex(b.R)),
      completed: true,
    });
    await b.edit(setTitle(b.now(task.id), "B"));
    expect(await proc.pass("b")).toMatchObject({ kind: "held", holds: ["foreign_bridge"] });
    expect(reminders()[0]?.title).toBe("A");
    b.person.delete(foreign.ref);
    expect(await proc.pass("b")).toMatchObject({ kind: "applied" });
    expect(reminders()[0]?.title).toBe("B");
  });

  it("#23 an incomplete marker search leaves ownership unchecked: the executor writes nothing", async () => {
    b = await bridge();
    const task = await b.task("A");
    const proc = processOf();
    await proc.start();
    const find = b.t.find.bind(b.t);
    b.t.find = async (q, sc) => ({
      ...(await find(q, sc)),
      complete: "urlPrefix" in q ? false : true,
    });
    await b.edit(setTitle(b.now(task.id), "B"));
    await proc.pass("b");
    expect(reminders()[0]?.title).toBe("A");
    b.t.find = find;
    await proc.pass("b");
    expect(reminders()[0]?.title).toBe("B");
  });

  it("#25 a batch status during the start and one during the stop reach delivery", async () => {
    b = await bridge();
    const at = new Date().toISOString();
    for (const id of ["I1", "I2"])
      b.db
        .prepare(
          `INSERT INTO intents (id, binding_id, task_id, installation_id, direction, kind, fields_json, basis_json,
             payload_json, operation_id, state, created_at) VALUES (?, 'b', 'T', 'i', 'to_lfcp', 'update_task', '[]', '{}', '{}', ?, 'finalized', ?)`,
        )
        .run(id, `brg1:${id}`, at);
    const listeners: ((r: unknown, s: unknown) => void)[] = [];
    const status = (id: string) => ({
      operationId: `brg1:${id}`,
      status: "accepted",
      unitIds: [new Uint8Array(32).fill(1)],
      acceptedUnitIds: [new Uint8Array(32).fill(1)],
      affectedNodeIds: [],
    });
    const proc = processOf({
      host: (key, target) => {
        if (key === "onBatch")
          return (l: (r: unknown, s: unknown) => void) => {
            listeners.push(l);
            return () => listeners.splice(listeners.indexOf(l), 1);
          };
        if (key === "start")
          return () => {
            target.start();
            for (const l of [...listeners]) l(b.R, status("I1"));
          };
        if (key === "stop")
          return async () => {
            for (const l of [...listeners]) l(b.R, status("I2"));
            await target.stop();
          };
        return undefined;
      },
    });
    await proc.start();
    const batch = (id: string) =>
      (
        b.db.prepare("SELECT batch_status FROM intents WHERE id = ?").get(id) as {
          batch_status: string | null;
        }
      ).batch_status;
    expect(batch("I1")).toBe("accepted");
    await proc.stop();
    p = undefined;
    expect(batch("I2")).toBe("accepted");
  });

  it("#26 a section that fails to stop (checkpoint) makes stop reject and the run failed", async () => {
    b = await bridge();
    const proc = processOf({
      host: (key, target) =>
        key === "stop"
          ? async () => {
              await target.stop();
              throw new Error("checkpoint failed");
            }
          : undefined,
    });
    await proc.start();
    await expect(proc.stop("signal")).rejects.toThrow(/did not stop cleanly/);
    p = undefined;
    expect(b.db.prepare("SELECT outcome FROM runs WHERE kind = 'process'").get()).toEqual({
      outcome: "failed: checkpoint failed",
    });
  });

  it("#27 an answer lost while running is recovered by the next pass, not only at the next start", async () => {
    b = await bridge();
    const task = await b.task("A");
    const proc = processOf();
    await proc.start();
    b.t.faults.loseNextResponse = 1;
    await b.edit(setTitle(b.now(task.id), "B"));
    expect(await proc.pass("b")).toMatchObject({ outcomes: [{ kind: "lost" }] });
    const state = () =>
      (
        b.db
          .prepare("SELECT state FROM intents WHERE kind = 'update' ORDER BY id DESC LIMIT 1")
          .get() as { state: string }
      ).state;
    expect(state()).toBe("effecting");
    await proc.pass("b");
    // The fake's stage is "sent": unknown → quarantine (B19), no second send.
    expect(state()).toBe("quarantined");
  });

  it("#28 STOP lifted from another process, no data change: the process wakes and the effect runs", async () => {
    b = await bridge();
    const task = await b.task("A");
    const stop = { on: false };
    // No change hint from the account: only the control state may wake the process here.
    b.t.onChange = () => () => {};
    const proc = processOf({ stopped: () => stop.on, controlEveryMs: 10 });
    await proc.start();
    stop.on = true;
    await b.edit(setTitle(b.now(task.id), "B"));
    await proc.pass("b");
    expect(reminders()[0]?.title).toBe("A");
    // `lfcp-bridge resume` in another process: STOP gone and the command counted.
    stop.on = false;
    bumpControl(b.db);
    await sleep(60);
    await proc.idle();
    expect(reminders()[0]?.title).toBe("B");
  });

  it("#28 resume --accept wakes the pass; a lifted helper_unavailable reaches the supervisor hook", async () => {
    b = await bridge({ filter: "mine" });
    const tasks = [];
    for (let k = 0; k < 4; k++) tasks.push(await b.task(`T${k}`));
    const lifted: string[] = [];
    const proc = processOf({ controlEveryMs: 10, onHoldsLifted: (r) => lifted.push(...r) });
    await proc.start();
    for (const t of tasks) await b.edit(unassign(b.now(t.id), b.root));
    expect(await proc.pass("b")).toMatchObject({ kind: "held" });
    await sleep(40);
    const holds = new Holds(b.db);
    for (const h of holds.of("b")) holds.accept("b", h.reason);
    await sleep(60);
    await proc.idle();
    expect(linkOf((tasks[0] as { id: string }).id)?.state).toBe("out_of_filter");
    holds.set("b", "helper_unavailable");
    await sleep(40);
    holds.lift("b", "helper_unavailable");
    await sleep(60);
    await proc.idle();
    expect(lifted).toContain("helper_unavailable");
  });
});

describe("review PR 9b r2", () => {
  /** The next apply dies before anything is sent: the intent stays effecting, the transport says not_started. */
  const loseBeforeSend = () => {
    const apply = b.t.apply.bind(b.t);
    b.t.apply = async () => {
      b.t.apply = apply;
      throw new Error("helper gone before sending");
    };
  };
  const latestUpdate = () =>
    b.db
      .prepare(
        "SELECT state, state_reason FROM intents WHERE kind = 'update' ORDER BY id DESC LIMIT 1",
      )
      .get() as { state: string; state_reason: string | null };

  it("#31 not_started after the Task left the filter: not resent before the link is up to date — superseded", async () => {
    b = await bridge({ filter: "mine" });
    const task = await b.task("A");
    const proc = processOf();
    await proc.start();
    await b.edit(setTitle(b.now(task.id), "B"));
    loseBeforeSend();
    expect(await proc.pass("b")).toMatchObject({ outcomes: [{ kind: "lost" }] });
    expect(latestUpdate().state).toBe("effecting");
    await b.edit(unassign(b.now(task.id), b.root));
    await proc.pass("b");
    expect(linkOf(task.id)?.state).toBe("out_of_filter");
    expect(latestUpdate()).toEqual({ state: "superseded", state_reason: "link_out_of_filter" });
    expect(reminders()[0]?.title).toBe("A");
  });

  it("#31 …the Task deleted: superseded (task_gone), the reminder as it was", async () => {
    b = await bridge();
    const task = await b.task("A");
    const proc = processOf();
    await proc.start();
    await b.edit(setTitle(b.now(task.id), "B"));
    loseBeforeSend();
    await proc.pass("b");
    await b.edit(deleteTask(b.now(task.id)));
    await proc.pass("b");
    expect(latestUpdate()).toEqual({ state: "superseded", state_reason: "link_task_gone" });
    expect(reminders()[0]?.title).toBe("A");
  });

  it("#31 …a recurrence put on the reminder: the due update is superseded (status_locked)", async () => {
    b = await bridge();
    const task = await b.task("A", { due: "2026-11-12" });
    const proc = processOf();
    await proc.start();
    await b.edit(setDue(b.now(task.id), "2026-11-20"));
    loseBeforeSend();
    await proc.pass("b");
    b.person.edit(reminders()[0]?.ref as { id: string }, { recurrence: true });
    await proc.pass("b");
    expect(latestUpdate()).toEqual({ state: "superseded", state_reason: "status_locked" });
    expect(reminders()[0]?.due?.date).toBe("2026-11-12");
  });

  it("#31 a pass settles only its own binding's open intents", async () => {
    b = await bridge();
    await b.task("A");
    const proc = processOf();
    await proc.start();
    const at = new Date().toISOString();
    const other = b.person.createList("LFCP · Other");
    b.db
      .prepare(
        `INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, target_ref, state, created_at)
         VALUES ('c', 'i', ?, 'apple-reminders', 'fake', ?, 'removed', ?)`,
      )
      .run("dd".repeat(32), other.id, at);
    b.db
      .prepare(
        `INSERT INTO intents (id, binding_id, task_id, installation_id, direction, kind, fields_json, basis_json,
           payload_json, operation_id, state, attempts, created_at) VALUES ('X', 'c', 'T', 'i', 'to_apple', 'update', '["title"]', '{}', '{}', 'brg1:X', 'effecting', 1, ?)`,
      )
      .run(at);
    await proc.pass("b");
    expect(b.db.prepare("SELECT state FROM intents WHERE id = 'X'").get()).toEqual({
      state: "effecting",
    });
  });

  it("#32 an old count-drop acceptance does not make a later dry run the baseline: the guard stays", async () => {
    b = await bridge();
    await b.task("A");
    await b.sync();
    await b.sync();
    const long = new Date(Date.now() - 3 * 3600_000).toISOString();
    const later = new Date().toISOString();
    b.db
      .prepare("INSERT INTO meta (key, value) VALUES ('hold_accepted_at:b:guard_count_drop', ?)")
      .run(long);
    b.db
      .prepare(
        "INSERT INTO runs (id, kind, binding_id, started_at, ended_at, outcome, stats_json) VALUES ('base', 'apply', 'b', ?, ?, 'planned', ?)",
      )
      .run(later, later, JSON.stringify({ linkedApple: 10, linkedLfcp: 10, guards: [] }));
    await sleep(5);
    const first = await b.pass.dryRun("b");
    const second = await b.pass.dryRun("b");
    if (first.kind !== "planned" || second.kind !== "planned") throw new Error("not planned");
    expect(first.guards).toContain("guard_count_drop");
    expect(second.guards).toContain("guard_count_drop");
  });
});

describe("review PR 9b r3 #31: a pass sends only its own binding's queue", () => {
  /** A second active binding 'c' on another section, read from another harness's replica. */
  async function twoBindings(stopped: { on: boolean }) {
    b = await bridge({ filter: "mine" });
    const other = await bridge();
    b.t.onChange = () => () => {};
    const list = b.person.createList("LFCP · Other");
    b.db
      .prepare(
        "INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, target_ref, state, created_at) VALUES ('c', 'i', ?, 'apple-reminders', 'fake', ?, 'active', ?)",
      )
      .run(toHex(other.R), list.id, new Date().toISOString());
    b.person.create(list.id, "marker", {
      url: markerUrl(INSTANCE, toHex(other.R)),
      completed: true,
    });
    const task = await b.task("A");
    const proc = processOf({
      stopped: () => stopped.on,
      host: (key, target) => {
        if (key === "isOpen") return () => true;
        if (key === "replica")
          return (r: typeof b.R) =>
            toHex(r) === toHex(other.R) ? other.host.replica(r) : target.replica(r);
        return undefined;
      },
    });
    return { other, task, proc };
  }

  it("the reviewer's case: b's prepared update (held by STOP) is not sent by c's pass after b's Task left the filter", async () => {
    const stopped = { on: false };
    const { other, task, proc } = await twoBindings(stopped);
    try {
      await proc.start();
      stopped.on = true;
      await b.edit(setTitle(b.now(task.id), "B"));
      await proc.pass("b");
      expect(b.db.prepare("SELECT state FROM intents WHERE kind = 'update'").get()).toEqual({
        state: "prepared",
      });
      await b.edit(unassign(b.now(task.id), b.root));
      stopped.on = false;
      await proc.pass("c");
      expect(reminders()[0]?.title).toBe("A");
      // b's own pass brings its link up to date first: the update is superseded, nothing written.
      await proc.pass("b");
      expect(linkOf(task.id)?.state).toBe("out_of_filter");
      expect(
        b.db.prepare("SELECT state, state_reason FROM intents WHERE kind = 'update'").get(),
      ).toEqual({
        state: "superseded",
        state_reason: "link_out_of_filter",
      });
      expect(reminders()[0]?.title).toBe("A");
    } finally {
      await other.close();
    }
  });

  it("…and a not_started retry of b (after a lost answer) is not sent by c's pass either", async () => {
    const stopped = { on: false };
    const { other, task, proc } = await twoBindings(stopped);
    try {
      await proc.start();
      await b.edit(setTitle(b.now(task.id), "B"));
      const apply = b.t.apply.bind(b.t);
      b.t.apply = async () => {
        b.t.apply = apply;
        throw new Error("helper gone before sending");
      };
      await proc.pass("b");
      await b.edit(unassign(b.now(task.id), b.root));
      // b's settle (from its next start or pass) would make it prepared again; here: put it back as settle does.
      b.db
        .prepare(
          "UPDATE intents SET state = 'prepared' WHERE kind = 'update' AND state = 'effecting'",
        )
        .run();
      await proc.pass("c");
      expect(reminders()[0]?.title).toBe("A");
    } finally {
      await other.close();
    }
  });
});
