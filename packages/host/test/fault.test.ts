// LFCP_BRIDGE_FAULT=lose-next-write-answer (verification run, step 22; src/fault.ts), without
// EventKit: the real HelperProcess on the fake helper, the supervisor and the EventKit transport
// with its stages in bridge.sqlite. The next write of a verification binding is answered, the
// answer dropped and the helper killed; the supervisor brings a new one; recover(opKey) is
// unknown — the executor then quarantines it (B19, executor-crash.test.ts "a lost answer").
// A write of a normal binding never fires it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppleOp } from "@openlfcp/bridge-reminders";
import { EventKitTransport, HelperProcess } from "@openlfcp/bridge-transport-eventkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type FaultShot,
  faultFromEnv,
  LOSE_NEXT_WRITE_ANSWER,
  loseNextWriteAnswer,
  verificationWrite,
} from "../src/fault.js";
import { type BridgeDatabase, Journal, openBridgeDatabase } from "../src/index.js";
import { DatabaseKV } from "../src/runtime.js";
import { HelperSupervisor } from "../src/supervisor.js";

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
async function until(what: string, ok: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(20);
  }
}

let dir: string;
let db: BridgeDatabase;
let stop: (() => Promise<void>) | undefined;
const T0 = "2026-11-12T00:00:00Z";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lfcp-fault-"));
  db = openBridgeDatabase(join(dir, "bridge.sqlite"));
  db.prepare(
    `INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES ('i', 'd', 'p', 'r', 'l', ?)`,
  ).run(T0);
  // bv: the verification binding (list LV, reminder rv); bn: a normal one (LN, rn).
  for (const [id, list, resource, verification, reminder] of [
    ["bv", "LV", "RV", 1, "rv"],
    ["bn", "LN", "RN", 0, "rn"],
  ] as const) {
    db.prepare(
      `INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, target_ref, verification, state, created_at)
       VALUES (?, 'i', ?, 'apple-reminders', 'eventkit', ?, ?, 'active', ?)`,
    ).run(id, resource, list, verification, T0);
    db.prepare(
      `INSERT INTO links (binding_id, task_id, rem_id_cache, origin, state, created_at, updated_at)
       VALUES (?, ?, ?, 'lfcp', 'linked', ?, ?)`,
    ).run(id, `T-${id}`, reminder, T0, T0);
  }
});
afterEach(async () => {
  await stop?.();
  stop = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** run/machine.ts's wiring with the fault: the transport's link wrapped, the supervisor's not. */
async function machine() {
  const journal = new Journal(db);
  const shot: FaultShot = { armed: true };
  const pids: number[] = [];
  let current: ReturnType<typeof loseNextWriteAnswer> | undefined;
  const transport = new EventKitTransport({
    appPath: dir,
    link: async () => current as ReturnType<typeof loseNextWriteAnswer>,
  });
  const ctx = {
    installationKey: "x",
    state: new DatabaseKV(db, "eventkit", "x"),
    scope: { listTitlePrefixes: [], listIds: [] },
  };
  let reopened: Promise<unknown> = Promise.resolve();
  const supervisor = new HelperSupervisor({
    pidFile: join(dir, "helper.pid"),
    pingEveryMs: 60_000,
    isOurs: () => false,
    start: async () => {
      const link = await HelperProcess.start({
        appPath: dir,
        launcher: FAKE_OPEN,
        helperName: "node",
        closeGraceMs: 200,
      });
      pids.push(link.ready.pid as number);
      current = loseNextWriteAnswer(link, { shot, applies: verificationWrite(db), journal });
      return {
        pid: link.ready.pid,
        ping: async () => {
          await link.request("access.status", {}, { timeoutMs: 1_000 });
        },
        close: () => link.close(),
        onExit: (cb) => link.onExit(cb),
      };
    },
    onRestart: () => {
      reopened = transport.open(ctx);
    },
  });
  await supervisor.start();
  await transport.open(ctx);
  stop = async () => {
    await supervisor.stop();
    await transport.close().catch(() => {});
  };
  return { transport, supervisor, journal, shot, pids, reopened: () => reopened };
}

const update = (opKey: string, reminder: string): AppleOp =>
  ({
    kind: "update",
    opKey,
    ref: { id: reminder },
    set: { title: "Тест 22 б" },
    expect: { rev: "1" },
  }) as AppleOp;

describe("LFCP_BRIDGE_FAULT=lose-next-write-answer (verification run, step 22)", () => {
  it("only that value of the env arms it", () => {
    expect(faultFromEnv({ LFCP_BRIDGE_FAULT: LOSE_NEXT_WRITE_ANSWER })).toBe(
      LOSE_NEXT_WRITE_ANSWER,
    );
    expect(faultFromEnv({ LFCP_BRIDGE_FAULT: "something-else" })).toBeUndefined();
    expect(faultFromEnv({})).toBeUndefined();
  });

  it("a verification write: answered, the answer dropped, the helper killed and replaced; recover is unknown", async () => {
    const m = await machine();
    const killed = m.pids[0] as number;
    await expect(m.transport.apply(update("W22", "rv"))).rejects.toMatchObject({
      name: "HelperLostError",
    });
    expect(m.shot.armed).toBe(false);
    const injected = m.journal.list().find((e) => e.key === "fault.injected");
    expect(injected?.params).toMatchObject({ opKey: "W22", op: "items.update", answered: true });
    expect(injected?.text).toMatch(/opKey W22.*saved it.*killed/);
    // The helper exited: the supervisor starts a new one, the transport reopens on it.
    await until("a new helper", () => m.pids.length === 2 && m.supervisor.state === "running");
    await m.reopened();
    expect(alive(killed)).toBe(false);
    // The stage stayed "sent": unknown — never resent (OutcomeUnknownError), a person decides.
    expect(await m.transport.recover("W22")).toMatchObject({ state: "unknown", opKind: "update" });
    await expect(m.transport.apply(update("W22", "rv"))).rejects.toMatchObject({
      name: "OutcomeUnknownError",
    });
    // One shot: the next verification write goes through.
    expect(await m.transport.apply(update("W23", "rv"))).toMatchObject({ ok: true });
  }, 15_000);

  it("a normal binding's write ignores it: answered, the helper lives, still armed", async () => {
    const m = await machine();
    expect(await m.transport.apply(update("N1", "rn"))).toMatchObject({ ok: true });
    expect(m.shot.armed).toBe(true);
    expect(m.pids).toHaveLength(1);
    expect(alive(m.pids[0] as number)).toBe(true);
    expect(m.journal.list().some((e) => e.key === "fault.injected")).toBe(false);
    // Nor a write it cannot place (a reminder no binding links), nor a list or marker write.
    const applies = verificationWrite(db);
    expect(applies("items.update", { ref: { id: "nobody" } })).toBe(false);
    expect(applies("items.create", { list: "LN" })).toBe(false);
    expect(applies("items.create", { list: "LV" })).toBe(true);
  }, 15_000);
});
