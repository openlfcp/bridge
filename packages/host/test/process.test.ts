// The run process (D-010 PR 9b): start, the write gate (B16, §7.6), triggers with debounce, one
// pass at a time per binding, "bases" decisions recorded, holds and resume, stop. On a real
// section replica (offline SectionHost) and the fake account; the live server variant is
// run.live.test.ts.

import { receiptOf } from "@openlfcp/client";
import { toHex } from "@openlfcp/core";
import { principalRef, setTitle, unassign } from "@openlfcp/shared-objects";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeProcess, Holds } from "../src/index.js";
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

function processOf(o: { verification?: boolean; state?: string } = {}) {
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
    stopped: () => false,
    timeZone: "UTC",
    debounceMs: 5,
    maxDelayMs: 20,
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
