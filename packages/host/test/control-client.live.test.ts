// L2 of E-030c against the Rust reference server: the root's `C`, the bridge registered in it as
// a service device with the base approval; the bridge's ControlClient publishes service, status
// (heartbeat) and a binding's status at most once a minute, reads requests, answers and cancels
// through control_exec, carries a cancel to the effect by A§3.3, and cleans what is final for
// 7 days while control_exec keeps the evidence. Skipped without LFCP_SERVER_BIN.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectionNetwork,
  fetchDeks,
  leafPayload,
  loadControlChain,
  queueControlRecord,
  queueKeyPackage,
  signChain,
  syncChain,
} from "@openlfcp/client";
import { dataEpoch, toBase64url } from "@openlfcp/core";
import { principalRef } from "@openlfcp/shared-objects";
import {
  SERVICE_CONTROL_PROFILE_ID,
  type ServiceControlIntent,
} from "@openlfcp/shared-objects/service-control";
import { DEVICE_KIND, sealKeyPackage, signControlRecord } from "@openlfcp/wire";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BINDING_WRITE_MS,
  ControlClient,
  type ControlPort,
  HEARTBEAT_MS,
  openBridgeDatabase,
  SectionHost,
} from "../src/index.js";
import { installation, memory, ownedSection } from "./support/lfcp.js";
import { type LiveServer, serverSkip, startServer, waitFor } from "./support/server.js";

const skip = serverSkip();
let server: LiveServer | undefined;
beforeAll(async () => {
  if (skip === undefined) server = await startServer();
}, 60_000);
afterAll(async () => {
  await server?.dispose();
});

const network = connectionNetwork({ now: () => Date.now() });
const R1 = "22".repeat(32);
const REF1 = toBase64url(Buffer.from(R1, "hex"));
const T0 = Date.parse("2026-11-19T10:00:00Z");
const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;
let n = 0;
const uuid7 = () => `0196f2a0-0000-7000-8000-${String(++n).padStart(12, "0")}`;

describe.skipIf(skip !== undefined)("ControlClient, live", { timeout: 180_000 }, () => {
  it("publishes C's service fields, reads its requests, answers and cancels, cleans it", async () => {
    const url = (server as LiveServer).url;
    const dir = mkdtempSync(join(tmpdir(), "lfcp-bridge-c-"));
    const db = openBridgeDatabase(join(dir, "bridge.sqlite"));
    // A: the root, owner of C.
    const A = installation();
    const a = memory();
    const { R: C, dek } = await ownedSection(
      A,
      a.storage,
      a.secrets,
      url,
      SERVICE_CONTROL_PROFILE_ID,
    );
    const genesis = (await a.storage.control.records(C))[0]?.bytes as Uint8Array;
    const ch = await network.connect(A.signer, url);
    expect((await ch.host(genesis)).kind).toBe("ack");
    ch.close();
    // B: the bridge, a kind-1 device of A bound in C, with its key.
    const B = installation();
    const chain = await loadControlChain(a.storage, C);
    if (chain?.kind !== "linear") throw new Error("no chain");
    const root = A.signer.descriptor.principalId;
    const cert = signChain(
      chain.state,
      A.signer,
      leafPayload(root, B.signer.descriptor, DEVICE_KIND.SERVICE, [1n, 2n], [C]),
    );
    const grant = signControlRecord(
      { resourceId: C, controlSeq: chain.state.seq + 1n, prevControlId: chain.state.head },
      { type: "DEVICE_GRANT", root, chain: cert },
      A.signer,
    );
    await queueControlRecord(a.storage, grant.bytes);
    const kp = await sealKeyPackage({
      resourceId: C,
      epoch: dataEpoch(0n),
      controlHead: grant.recordId,
      recipient: B.signer.descriptor,
      dek,
      signer: A.signer,
    });
    await queueKeyPackage(a.storage, kp.bytes);
    const hostA = new SectionHost({ url, installation: A, ...a, tickMs: 100 });
    const rootC = await hostA.openControl(C, "root");
    hostA.start();
    const commitA = async (intents: ServiceControlIntent[]) =>
      expect(await rootC.commit(intents, `t:${uuid7()}`)).not.toMatchObject({ kind: "rejected" });
    await commitA([{ intent: "initialize", attemptId: "attempt-1", createdAt: iso(T0 - 60_000) }]);
    await commitA([
      {
        intent: "approval.create",
        approval: {
          role: "base",
          resource: toBase64url(C),
          principal: principalRef(B.signer.descriptor.principalId),
          certDigest: toBase64url(cert.leaf.payloadDigest),
          certId: toBase64url(cert.leaf.id),
          generation: 1,
          origin: "pairing",
          at: iso(T0 - 60_000),
        },
      },
    ]);
    await waitFor("A sent", async () => (await a.storage.outbound.list(C)).length === 0);

    const b = memory();
    const chB = await network.connect(B.signer, url);
    const bChain = await syncChain(b.storage, chB, C);
    await fetchDeks(b.storage, b.secrets, chB, bChain, {
      signer: B.signer,
      agreement: B.agreement,
    });
    chB.close();
    const hostB = new SectionHost({ url, installation: B, ...b, tickMs: 100 });
    const bridgeC = await hostB.openControl(C);
    hostB.start();
    await waitFor("B sees the approval", () => bridgeC.state()?.approvals !== undefined);
    await waitFor(
      "B sees the approval",
      () => Object.keys(bridgeC.state()?.approvals ?? {}).length === 1,
    );

    db.prepare(
      "INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES ('i1', 'i', 'p', 'r', 'l', 'x')",
    ).run();
    db.prepare(
      "INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, state, created_at) VALUES ('b1', 'i1', ?, 'apple-reminders', 'eventkit', 'active', 'x')",
    ).run(R1);
    let now = T0;
    const effects: string[] = [];
    const gates = new Map<string, () => void>();
    const client = new ControlClient({
      db,
      installation: "i1",
      port: bridgeC,
      ops: {
        check: {
          run: async ({ row, effect }) => {
            // `late` makes its first effect before the cancel; the others wait before it.
            if (row.id === rids.late && effect()) effects.push(`${row.id}:1`);
            await new Promise<void>((r) => gates.set(row.id, r));
            if (!effect()) return { state: "failed", code: "cancelled_late" };
            effects.push(`${row.id}:2`);
            return { state: "applied" };
          },
        },
      },
      service: () => ({
        instance: "bridge-1",
        kind: "reminders",
        label: "mac",
        platform: "macos",
        app: "0.6.0",
        artifactSliceId: "",
        macos: "15.0",
        cert: { state: "uncertified", manifestSeq: 0, certTestMode: false },
        capacity: { sections: 1, max: 8, devicesFree: 7 },
      }),
      status: () => ({ state: "running" }),
      now: () => now,
    });
    const rids = { early: uuid7(), late: uuid7(), withCancel: uuid7(), other: uuid7() };
    const seen = (p: (s: NonNullable<ReturnType<ControlPort["state"]>>) => boolean) => () => {
      const s = rootC.state();
      return s !== undefined && p(s);
    };
    const tickUntil = async (what: string, p: () => boolean) =>
      waitFor(what, async () => {
        await client.tick();
        return p();
      });

    try {
      // service, status, binding.
      await tickUntil(
        "root sees service, status and the binding",
        seen((s) => s.service !== undefined && s.status !== undefined && REF1 in s.bindings),
      );
      const s0 = rootC.state();
      expect(s0?.service).toMatchObject({ kind: "reminders", protocol: { ops: ["check"] } });
      expect(s0?.status).toMatchObject({ state: "running", heartbeatAt: iso(T0) });
      expect(s0?.bindings[REF1]).toMatchObject({ state: "active", generation: 0 });

      // ≤1 write a minute per binding (its lifecycle fields); the heartbeat rides on it, and
      // comes alone 30 minutes after the last unit.
      const rename = (t: string) =>
        db.prepare("UPDATE bindings SET target_title = ? WHERE id = 'b1'").run(t);
      rename("One");
      now = T0 + BINDING_WRITE_MS - 1000;
      await client.tick();
      // Changed, but written less than a minute ago: not written (its own view shows it at once).
      expect(bridgeC.state()?.bindings[REF1]?.list).not.toBe("One");
      now = T0 + BINDING_WRITE_MS;
      await tickUntil(
        "the binding written after a minute",
        seen((s) => s.bindings[REF1]?.list === "One"),
      );
      expect(rootC.state()?.status?.heartbeatAt).toBe(iso(T0 + BINDING_WRITE_MS));
      now = T0 + BINDING_WRITE_MS + HEARTBEAT_MS;
      await tickUntil(
        "a heartbeat",
        seen((s) => s.status?.heartbeatAt === iso(T0 + BINDING_WRITE_MS + HEARTBEAT_MS)),
      );

      // Requests and cancels (A§3.3).
      const request = (generation = 0) => ({
        op: "check",
        binding: REF1,
        generation,
        args: {},
        client: { app: "test", protocol: 1 },
        at: iso(now),
      });
      await commitA([{ intent: "request.create", rid: rids.early, request: request() }]);
      await commitA([{ intent: "request.create", rid: rids.late, request: request() }]);
      await commitA([{ intent: "request.create", rid: rids.other, request: request(5) }]);
      await tickUntil("both running", () => gates.size === 2);
      // The client ticks only when told: `withCancel` and its cancel are read together.
      const cancel = { reason: "user" as const, at: iso(now) };
      await commitA([{ intent: "cancel.create", rid: rids.early, cancel }]);
      await commitA([{ intent: "cancel.create", rid: rids.late, cancel }]);
      await commitA([{ intent: "request.create", rid: rids.withCancel, request: request() }]);
      await commitA([{ intent: "cancel.create", rid: rids.withCancel, cancel }]);
      await waitFor("cancels here", () => bridgeC.state()?.cancels[rids.withCancel] !== undefined);
      await client.tick();
      for (const g of gates.values()) g();
      await tickUntil(
        "events final",
        seen((s) =>
          Object.values(rids).every((r) =>
            ["cancelled", "applied", "stale"].includes(s.events[r]?.state ?? ""),
          ),
        ),
      );
      const ev = rootC.state()?.events ?? {};
      expect(ev[rids.early]).toMatchObject({ state: "cancelled" });
      expect(ev[rids.late]).toMatchObject({ state: "applied", detail: "lateCancel" });
      expect(ev[rids.withCancel]).toMatchObject({ state: "cancelled" });
      expect(ev[rids.other]).toMatchObject({ state: "stale", code: "stale_generation" });
      expect(effects).toEqual([`${rids.late}:1`, `${rids.late}:2`]);

      // An answer: its question is the service's; one with another snapshotHash is refused.
      const qid = uuid7();
      const aid = uuid7();
      expect(
        (
          await bridgeC.commit(
            [
              {
                intent: "question.create",
                qid,
                question: {
                  binding: REF1,
                  generation: 0,
                  kind: "conflict",
                  anomalyId: "x",
                  snapshotHash: "h1",
                  items: [],
                  counts: {},
                  options: ["keep"],
                  at: iso(now),
                },
              },
            ],
            `t:${uuid7()}`,
          )
        ).kind,
      ).not.toBe("rejected");
      await waitFor(
        "A sees the question",
        seen((s) => qid in s.questions),
      );
      await commitA([
        {
          intent: "answer.create",
          aid,
          answer: { qid, snapshotHash: "h2", choice: "keep", at: iso(now) },
        },
      ]);
      await tickUntil(
        "the answer refused",
        seen((s) => s.events[aid]?.state === "rejected"),
      );
      expect(rootC.state()?.events[aid]).toMatchObject({ code: "snapshot_changed" });

      // 7 days later: the maps are cleaned, control_exec keeps every id.
      now += 8 * 24 * 3600_000;
      await tickUntil(
        "requests cleaned",
        seen((s) => Object.values(rids).every((r) => !(r in s.requests) && !(r in s.events))),
      );
      const kept = db
        .prepare("SELECT id FROM control_exec ORDER BY id")
        .all()
        .map((r) => (r as { id: string }).id);
      expect(kept).toEqual([...Object.values(rids), aid].sort());
    } finally {
      for (const g of gates.values()) g();
      await client.stop();
      await hostB.stop();
      await hostA.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
