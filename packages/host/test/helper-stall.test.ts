// The hang analysis (§3–5), without EventKit: a helper stuck in a store call — it answers N
// requests, then neither answers nor exits (it ignores shutdown, stdin EOF and SIGTERM) — through
// the real HelperProcess (fake `open` + fake helper on FIFOs), the supervisor and the EventKit
// transport with its stages in bridge.sqlite. What the host must do: the write that was running
// is unknown, the one queued behind it never started; the stuck process is SIGKILLed and a fresh
// helper answers; a stall that repeats on one list holds that binding only, with backoff between
// the restarts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppleOp } from "@openlfcp/bridge-reminders";
import { EventKitTransport, HelperProcess } from "@openlfcp/bridge-transport-eventkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BridgeDatabase, Holds, Journal, openBridgeDatabase } from "../src/index.js";
import { helperStallHandler, ListStalls } from "../src/run/machine.js";
import { DatabaseKV } from "../src/runtime.js";
import { HelperSupervisor, type SupervisedHelper } from "../src/supervisor.js";

const FIXTURES = join(__dirname, "../../transport-eventkit/test/fixtures");
const FAKE_OPEN = [process.execPath, join(FIXTURES, "fake-open.mjs")];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 3_000) {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(20);
  }
}

let dir: string;
let db: BridgeDatabase;
let stop: (() => Promise<void>) | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lfcp-stall-"));
  db = openBridgeDatabase(join(dir, "bridge.sqlite"));
  db.prepare(
    "INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES ('i', 'd', 'p', 'r', 'l', '2026-11-12T00:00:00Z')",
  ).run();
  for (const [id, list, resource] of [
    ["b1", "L1", "R1"],
    ["b2", "L2", "R2"],
  ])
    db.prepare(
      "INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, target_ref, state, created_at) VALUES (?, 'i', ?, 'apple-reminders', 'eventkit', ?, 'active', '2026-11-12T00:00:00Z')",
    ).run(id, resource, list);
});
afterEach(async () => {
  await stop?.();
  stop = undefined;
  delete process.env.FAKE_HELPER_MODE;
  delete process.env.FAKE_HELPER_STALL_EVENT_MS;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The machine's wiring (run/machine.ts) with short timings; `mode` is the next helper's. */
function machine(o: { pingEveryMs: number }) {
  const journal = new Journal(db);
  const holds = new Holds(db);
  const stalls = new ListStalls();
  const mode = { next: "", stallEventMs: "" };
  const pids: number[] = [];
  const sleeps: number[] = [];
  let current: HelperProcess | undefined;
  const transport = new EventKitTransport({
    appPath: dir,
    link: async () => current as HelperProcess,
  });
  const ctx = {
    installationKey: "x",
    state: new DatabaseKV(db, "eventkit", "x"),
    scope: { listTitlePrefixes: [], listIds: [] },
  };
  const supervisor: HelperSupervisor = new HelperSupervisor({
    pidFile: join(dir, "helper.pid"),
    pingEveryMs: o.pingEveryMs,
    isOurs: () => false,
    backoffBaseMs: 100,
    backoffMaxMs: 400,
    sleep: async (ms) => {
      sleeps.push(ms);
      await sleep(ms);
    },
    start: async () => {
      process.env.FAKE_HELPER_MODE = mode.next;
      process.env.FAKE_HELPER_STALL_EVENT_MS = mode.stallEventMs;
      const link = await HelperProcess.start({
        appPath: dir,
        launcher: FAKE_OPEN,
        helperName: "node",
        readyTimeoutMs: 5_000,
        requestTimeoutMs: 2_000,
        shutdownTimeoutMs: 100,
        closeGraceMs: 100,
        killGraceMs: 100,
      });
      current = link;
      pids.push(link.ready.pid as number);
      const supervised: SupervisedHelper = {
        pid: link.ready.pid,
        ping: async () => {
          const r = await link.request("access.status", {}, { timeoutMs: 300 });
          if (r.ok !== true) throw new Error("no answer");
        },
        close: () => link.close(),
        onExit: (cb) => link.onExit(cb),
      };
      link.onEvent(
        helperStallHandler({
          journal,
          restart: (reason, r) => supervisor.restartNow(reason, supervised, r),
          lists: {
            bindingsOf: (list) =>
              (
                db
                  .prepare(
                    "SELECT id FROM bindings WHERE target_ref = ? AND state IN ('pending_dry_run','active')",
                  )
                  .all(list) as { id: string }[]
              ).map((b) => b.id),
            holds,
            stalls,
          },
        }),
      );
      return supervised;
    },
    onRestart: () => {
      reopened = transport.open(ctx);
    },
  });
  let reopened: Promise<unknown> = Promise.resolve();
  stop = async () => {
    await supervisor.stop();
    await transport.close().catch(() => {});
  };
  const start = async () => {
    await supervisor.start();
    await transport.open(ctx);
  };
  return {
    supervisor,
    transport,
    holds,
    journal,
    mode,
    pids,
    sleeps,
    start,
    link: () => current,
    /** The transport reopened on the helper of the last restart (its hello answered). */
    reopened: () => reopened,
  };
}

const update = (opKey: string): AppleOp =>
  ({
    kind: "update",
    opKey,
    ref: { id: `r-${opKey}` },
    set: { title: opKey },
    expect: { rev: "1" },
  }) as AppleOp;

describe("a helper stuck in a store call (the hang analysis, without EventKit)", () => {
  it("the running write is unknown, the queued one not_started; the stuck helper is SIGKILLed and a fresh one answers", async () => {
    const m = machine({ pingEveryMs: 150 });
    m.mode.next = "stall-after:1"; // hello is answered, then it sticks
    await m.start();
    const stuckPid = m.pids[0] as number;
    m.mode.next = ""; // the replacement answers
    const a = m.transport.apply(update("A")).catch((e: Error) => e); // started, stuck
    const b = m.transport.apply(update("B")).catch((e: Error) => e); // queued behind it
    await sleep(50);
    // While that helper lives, B may still run: not unknown yet.
    await expect(m.transport.recover("B")).rejects.toMatchObject({
      name: "OperationInFlightError",
    });
    // The ping gets no answer → restart: SIGTERM ignored, SIGKILL; a fresh helper.
    await until("a fresh helper", () => m.pids.length === 2 && m.supervisor.state === "running");
    expect(alive(stuckPid)).toBe(false);
    expect(await a).toMatchObject({ name: "HelperLostError" });
    expect(await b).toMatchObject({ name: "HelperLostError" });
    expect(await m.transport.recover("A")).toMatchObject({ state: "unknown" });
    await until("B settled", async () => {
      try {
        return (await m.transport.recover("B")).state === "not_started";
      } catch {
        return false;
      }
    });
    const fresh = m.link() as HelperProcess;
    expect((await fresh.request("access.status", {}, { timeoutMs: 1_000 })).ok).toBe(true);
    // B can be sent again under its opKey (not_started); A never (unknown, B19).
    await expect(m.transport.apply(update("A"))).rejects.toMatchObject({
      name: "OutcomeUnknownError",
    });
  }, 10_000);

  it("a stall repeating on one list holds that binding only; the others go on; restarts back off", async () => {
    const m = machine({ pingEveryMs: 60_000 }); // only the helper's own stalled events restart
    m.mode.next = "stall-after:1"; // every helper sticks on its second request, as a bad list does
    m.mode.stallEventMs = "50";
    await m.start();
    const read = () => m.transport.snapshot("L1" as never).catch(() => undefined);
    void read();
    await until("first restart", () => m.pids.length === 2 && m.supervisor.state === "running");
    expect(m.holds.has("b1", "helper_stall")).toBe(false);
    m.mode.next = ""; // the helper after the hold answers
    m.mode.stallEventMs = "";
    await m.reopened();
    void read();
    await until("hold", () => m.holds.has("b1", "helper_stall"));
    await until("second restart", () => m.pids.length === 3 && m.supervisor.state === "running");
    expect(m.holds.has("b2", "helper_stall")).toBe(false);
    expect(m.holds.of("b2")).toEqual([]);
    // Not the shared budget: no helper_unavailable, and the fresh helper serves the rest.
    expect(m.supervisor.state).toBe("running");
    const fresh = m.link() as HelperProcess;
    expect((await fresh.request("access.status", {}, { timeoutMs: 1_000 })).ok).toBe(true);
    expect(m.sleeps).toEqual([100, 200]);
    const keys = m.journal.list().map((e) => [e.key, e.bindingId ?? ""]);
    expect(keys).toContainEqual(["helper.stall_hold", "b1"]);
    expect(keys.filter(([k]) => k === "helper.stalled")).toHaveLength(2);
  }, 10_000);
});
