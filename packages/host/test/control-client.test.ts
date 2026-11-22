// L0 of E-030c: the ControlClient over a fake `C` — admission through control_exec before any
// effect, events forward only, the cancel table reaching the effect, service/status/bindings with
// the heartbeat and the per-binding write limit, the 7-day cleanup keeping control_exec.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrincipalId } from "@openlfcp/core";
import type {
  ServiceControlIntent,
  ServiceControlValidation,
} from "@openlfcp/shared-objects/service-control";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BINDING_WRITE_MS,
  type BridgeDatabase,
  ControlClient,
  type ControlPort,
  HEARTBEAT_MS,
  type OpHandler,
  openBridgeDatabase,
} from "../src/index.js";

const R1 = "11".repeat(32);
const REF1 = Buffer.from(R1, "hex").toString("base64url");
const R2 = "22".repeat(32);
const REF2 = Buffer.from(R2, "hex").toString("base64url");
const T0 = Date.parse("2026-11-19T10:00:00Z");
const root = new Uint8Array(32).fill(7) as unknown as PrincipalId;

type Rec = Record<string, Record<string, unknown>>;
interface FakeState {
  requests: Rec;
  answers: Rec;
  cancels: Rec;
  events: Rec;
  questions: Rec;
  bindings: Rec;
  approvals: Rec;
  pairing: Rec;
  service?: Record<string, unknown>;
  status?: Record<string, unknown>;
}
const merge = (a: object | undefined, b: object) =>
  Object.fromEntries(Object.entries({ ...a, ...b }).filter(([, v]) => v !== null));
/** A `C` that applies the intents the client writes, as the profile would. */
function fakeC() {
  const s: FakeState = {
    requests: {},
    answers: {},
    cancels: {},
    events: {},
    questions: {},
    bindings: {},
    approvals: {},
    pairing: {},
  };
  const commits: ServiceControlIntent[][] = [];
  const port: ControlPort = {
    state: () => s as unknown as ServiceControlValidation,
    authorOf: (c, k) => (s[c][k] === undefined ? undefined : root),
    commit: async (intents) => {
      commits.push([...intents]);
      for (const i of intents)
        if (i.intent === "service.put") s.service = merge(s.service, i.fields);
        else if (i.intent === "status.put") s.status = merge(s.status, i.fields);
        else if (i.intent === "binding.put") s.bindings[i.binding] = { ...i.fields };
        else if (i.intent === "event.put") {
          const { intent: _, id, ...e } = i;
          s.events[id] = e;
        } else if (i.intent === "question.resolve")
          (s.questions[i.qid] as Record<string, unknown>).resolved = i.resolved;
        else if (i.intent === "delete")
          delete (s as unknown as Record<string, Rec>)[i.container]?.[i.key];
      return { kind: "acknowledged" };
    },
  };
  return { s, port, commits };
}

let dir: string;
let db: BridgeDatabase;
let now: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lfcp-bridge-cc-"));
  db = openBridgeDatabase(join(dir, "bridge.sqlite"));
  now = T0;
  db.prepare(
    "INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES ('i1', 'i', 'p', 'r', 'l', 'x')",
  ).run();
  db.prepare(
    "INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, state, created_at) VALUES ('b1', 'i1', ?, 'apple-reminders', 'eventkit', 'active', 'x')",
  ).run(R1);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const client = (port: ControlPort, ops: Record<string, OpHandler> = {}, installation = "i1") =>
  new ControlClient({
    db,
    installation,
    port,
    ops,
    service: () => ({ instance: "x", kind: "reminders" }),
    status: () => ({ state: "running" }),
    now: () => now,
  });
const request = (op: string, extra: object = {}) => ({
  op,
  binding: REF1,
  generation: 0,
  args: {},
  client: "c",
  at: "2026-11-19T09:59:00Z",
  ...extra,
});

describe("ControlClient", () => {
  it("admits a request once and runs it; the event goes received → executing → applied", async () => {
    const c = fakeC();
    let runs = 0;
    c.s.requests.r1 = request("check");
    const cc = client(c.port, {
      check: {
        run: async ({ effect }) => {
          runs++;
          expect(effect()).toBe(true);
          return { state: "applied" };
        },
      },
    });
    await cc.tick();
    await cc.stop();
    await client(c.port, { check: { run: async () => ({ state: "applied" }) } }).tick();
    expect(runs).toBe(1);
    expect(c.s.events.r1).toMatchObject({ state: "applied" });
    expect(c.s.service).toMatchObject({ protocol: { v: 1, ops: ["check"] } });
  });

  it("refuses an op without a handler, a request for another generation, an unauthored one", async () => {
    const c = fakeC();
    c.s.requests.a = request("pause");
    c.s.requests.b = request("check", { generation: 3 });
    const cc = client(c.port, { check: { run: async () => ({ state: "applied" }) } });
    const authorOf = c.port.authorOf;
    c.port.authorOf = (k, id) => (id === "u" ? undefined : authorOf(k, id));
    c.s.requests.u = request("check");
    await cc.tick();
    expect(c.s.events.a).toMatchObject({ state: "rejected", code: "unsupported_op" });
    expect(c.s.events.b).toMatchObject({ state: "stale", code: "stale_generation" });
    expect(c.s.events.u).toBeUndefined();
  });

  it("a cancel seen with its request: cancelled, nothing runs", async () => {
    const c = fakeC();
    let runs = 0;
    c.s.requests.r = request("check");
    c.s.cancels.r = { at: "x" };
    await client(c.port, {
      check: {
        run: async () => {
          runs++;
          return { state: "applied" };
        },
      },
    }).tick();
    expect(runs).toBe(0);
    expect(c.s.events.r).toMatchObject({ state: "cancelled" });
  });

  it("a cancel before the first effect stops it; after it, the request ends with lateCancel", async () => {
    for (const late of [false, true]) {
      const c = fakeC();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const id = late ? "late" : "early";
      c.s.requests[id] = request("check");
      const cc = client(c.port, {
        check: {
          run: async ({ effect }) => {
            if (late) expect(effect()).toBe(true);
            await gate;
            return effect() ? { state: "applied" } : { state: "failed", code: "x" };
          },
        },
      });
      await cc.tick();
      c.s.cancels[id] = { at: "x" };
      await cc.tick();
      release();
      await cc.stop();
      await client(c.port).tick();
      expect(c.s.events[id]).toMatchObject(
        late ? { state: "applied", detail: "lateCancel" } : { state: "cancelled" },
      );
    }
  });

  it("an answer to a question asked otherwise is rejected{snapshot_changed}", async () => {
    const c = fakeC();
    c.s.questions.q = { binding: REF1, generation: 0, snapshotHash: "h1" };
    c.s.answers.a = { qid: "q", snapshotHash: "h2", choice: "x", at: "x" };
    await client(c.port).tick();
    expect(c.s.events.a).toMatchObject({ state: "rejected", code: "snapshot_changed" });
  });

  it("status: heartbeat every 30 minutes; a binding at most once a minute", async () => {
    const c = fakeC();
    const cc = client(c.port);
    await cc.tick();
    expect(c.s.status).toMatchObject({ state: "running", heartbeatAt: "2026-11-19T10:00:00Z" });
    expect(c.s.bindings[REF1]).toMatchObject({ state: "active", generation: 0, filter: "default" });
    const n = c.commits.length;
    now += HEARTBEAT_MS - 1000;
    await cc.tick();
    expect(c.commits.length).toBe(n);
    db.prepare(
      "UPDATE bindings SET last_complete_check_at = '2026-11-19T11:00:00.123Z' WHERE id = 'b1'",
    ).run();
    now += 1000;
    await cc.tick();
    expect(c.s.status).toMatchObject({ heartbeatAt: "2026-11-19T10:30:00Z" });
    expect(c.s.bindings[REF1]).toMatchObject({ lastCompleteCheckAt: "2026-11-19T11:00:00Z" });
    db.prepare(
      "UPDATE bindings SET last_complete_check_at = '2026-11-19T12:00:00.000Z' WHERE id = 'b1'",
    ).run();
    now += BINDING_WRITE_MS - 1000;
    await cc.tick();
    expect(c.s.bindings[REF1]).toMatchObject({ lastCompleteCheckAt: "2026-11-19T11:00:00Z" });
    now += 1000;
    await cc.tick();
    expect(c.s.bindings[REF1]).toMatchObject({ lastCompleteCheckAt: "2026-11-19T12:00:00Z" });
  });

  it("cleans what is final for 7 days; control_exec stays, so the id is not run again", async () => {
    const c = fakeC();
    let runs = 0;
    const ops = {
      check: {
        run: async () => {
          runs++;
          return { state: "applied" as const };
        },
      },
    };
    const req = request("check");
    c.s.requests.r = req;
    const cc = client(c.port, ops);
    await cc.tick();
    await cc.stop();
    now += 8 * 24 * 3600_000;
    await client(c.port, ops).tick();
    expect(c.s.requests.r).toBeUndefined();
    expect(c.s.events.r).toBeUndefined();
    c.s.requests.r = req;
    await client(c.port, ops).tick();
    expect(runs).toBe(1);
    expect(db.prepare("SELECT state FROM control_exec WHERE id = 'r'").get()).toEqual({
      state: "applied",
    });
  });

  it("publishes and resolves only the bindings of its own installation", async () => {
    db.prepare(
      "INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES ('i2', 'j', 'p', 'r', 'l', 'x')",
    ).run();
    db.prepare(
      "INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, target_ref, target_title, state, created_at) VALUES ('b2', 'i2', ?, 'apple-reminders', 'eventkit', 't2', 'Private', 'active', 'x')",
    ).run(R2);
    const c = fakeC();
    const seen: (string | null)[] = [];
    c.s.requests.r = request("check", { binding: REF2 });
    await client(c.port, {
      check: {
        run: async ({ row }) => {
          seen.push(row.binding);
          return { state: "applied" };
        },
      },
    }).tick();
    expect(Object.keys(c.s.bindings)).toEqual([REF1]);
    expect(seen).not.toContain("b2");
    const d = fakeC();
    await client(d.port, {}, "i2").tick();
    expect(Object.keys(d.s.bindings)).toEqual([REF2]);
    expect(d.s.bindings[REF2]).toMatchObject({ list: "Private" });
  });

  it("a repeatable outcome keeps the row executing and runs it again only after a backoff", async () => {
    const c = fakeC();
    let runs = 0;
    c.s.requests.r = request("check");
    const cc = client(c.port, {
      check: {
        run: async ({ effect }) => {
          runs++;
          effect();
          return runs < 3 ? { repeat: "helper_unavailable" } : { state: "applied" };
        },
      },
    });
    const settle = async () => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    };
    await cc.tick();
    await settle();
    expect(runs).toBe(1);
    expect(c.s.events.r).toMatchObject({ state: "executing", code: "helper_unavailable" });
    now += 4999;
    await cc.tick();
    expect(runs).toBe(1);
    now += 1;
    await cc.tick();
    await settle();
    expect(runs).toBe(2);
    now += 9999;
    await cc.tick();
    expect(runs).toBe(2);
    now += 1;
    await cc.tick();
    await cc.stop();
    await client(c.port).tick();
    expect(runs).toBe(3);
    expect(c.s.events.r).toMatchObject({ state: "applied" });
  });

  it("a repeatable outcome before the first effect shows executing{code}; a cancel still stops it", async () => {
    const c = fakeC();
    let runs = 0;
    c.s.requests.r = request("check");
    const cc = client(c.port, {
      check: {
        run: async () => {
          runs++;
          return { repeat: "helper_unavailable" };
        },
      },
    });
    const settle = async () => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    };
    await cc.tick();
    await settle();
    expect(runs).toBe(1);
    expect(c.s.events.r).toMatchObject({ state: "executing", code: "helper_unavailable" });
    c.s.cancels.r = { at: "x" };
    now += 5000;
    await cc.tick();
    await settle();
    await cc.stop();
    expect(runs).toBe(1);
    expect(c.s.events.r).toMatchObject({ state: "cancelled" });
  });

  it("keeps the unknown fields of service's nested maps while it updates the known ones", async () => {
    const c = fakeC();
    c.s.service = {
      instance: "old",
      kind: "reminders",
      cert: { level: "a", futureCert: "keep" },
      protocol: { v: 1, ops: [], questionKinds: [], futureOption: "keep" },
    };
    const cc = new ControlClient({
      db,
      installation: "i1",
      port: c.port,
      ops: { check: { run: async () => ({ state: "applied" }) } },
      service: () => ({ instance: "x", kind: "reminders", cert: { level: "b" } }),
      status: () => ({ state: "running" }),
      now: () => now,
    });
    await cc.tick();
    expect(c.s.service).toEqual({
      instance: "x",
      kind: "reminders",
      cert: { level: "b", futureCert: "keep" },
      protocol: { v: 1, ops: ["check"], questionKinds: [], futureOption: "keep" },
    });
    const writes = c.commits.flat().filter((i) => i.intent === "service.put").length;
    await cc.tick();
    expect(c.commits.flat().filter((i) => i.intent === "service.put").length).toBe(writes);
  });

  it("cleans a superseded question and its answers 7 days after it was seen; control_exec stays", async () => {
    const c = fakeC();
    c.s.questions.q = { binding: REF1, generation: 0, snapshotHash: "h", superseded: { by: "q2" } };
    c.s.answers.a = { qid: "q", snapshotHash: "h", choice: "x", at: "2026-11-19T10:00:00Z" };
    await client(c.port).tick();
    expect(c.s.events.a).toMatchObject({ state: "rejected", code: "snapshot_changed" });
    now += 6 * 24 * 3600_000;
    await client(c.port).tick();
    expect(c.s.questions.q).toBeDefined();
    now += 2 * 24 * 3600_000;
    await client(c.port).tick();
    expect(c.s.questions.q).toBeUndefined();
    expect(c.s.answers.a).toBeUndefined();
    expect(c.s.events.a).toBeUndefined();
    expect(db.prepare("SELECT state FROM control_exec WHERE id = 'a'").get()).toEqual({
      state: "rejected",
    });
    await client(c.port).tick();
    expect(
      db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'control_superseded:%'").get(),
    ).toEqual({ n: 0 });
  });
});
