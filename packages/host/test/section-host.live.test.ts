// SectionHost against the Rust reference server (D-010 §5.3, §5.8): lfcp_live
// from real events across a server restart, and a change of another device
// reaching onNodesChanged. Skipped without LFCP_SERVER_BIN.

import {
  connectionNetwork,
  fetchDeks,
  loadControlChain,
  queueControlRecord,
  queueKeyPackage,
  syncChain,
} from "@openlfcp/client";
import { dataEpoch, type ResourceId, toHex } from "@openlfcp/core";
import { setTitle } from "@openlfcp/shared-objects";
import { sealKeyPackage, signControlRecord } from "@openlfcp/wire";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SectionHost } from "../src/index.js";
import { installation, memory, ownedSection, sectionId, task } from "./support/lfcp.js";
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

describe.skipIf(skip !== undefined)("SectionHost, live", { timeout: 120_000 }, () => {
  it("lfcp_live follows LIVE per connection generation; another device's change reaches onNodesChanged", async () => {
    const url = (server as LiveServer).url;
    // A: the section's owner (the person's first device).
    const A = installation();
    const a = memory();
    const { R, dek } = await ownedSection(A, a.storage, a.secrets, url);
    const { genesis } = { genesis: (await a.storage.control.records(R))[0]?.bytes as Uint8Array };
    const channel = await network.connect(A.signer, url);
    expect((await channel.host(genesis)).kind).toBe("ack");
    channel.close();
    // B: the bridge, granted read and write, with the epoch-0 key.
    const B = installation();
    const chain = await loadControlChain(a.storage, R);
    if (chain?.kind !== "linear") throw new Error("no chain");
    const grant = signControlRecord(
      { resourceId: R, controlSeq: chain.state.seq + 1n, prevControlId: chain.state.head },
      {
        type: "CAPABILITY_GRANT",
        subject: B.signer.descriptor,
        abilities: [1n, 2n],
        delegable: [],
      },
      A.signer,
    );
    await queueControlRecord(a.storage, grant.bytes);
    const kp = sealKeyPackage({
      resourceId: R,
      epoch: dataEpoch(0n),
      controlHead: grant.recordId,
      recipient: B.signer.descriptor,
      dek,
      signer: A.signer,
    });
    await queueKeyPackage(a.storage, (await kp).bytes);

    const hostA = new SectionHost({
      url,
      installation: A,
      ...a,
      tickMs: 100,
      reconnect: () => 500,
    });
    const remoteSeen: string[] = [];
    hostA.onNodesChanged((r, e) => {
      if (toHex(r) === toHex(R) && e.origin === "remote") remoteSeen.push(...e.nodeIds);
    });
    await hostA.open(R);
    const S = sectionId();
    const t1 = task("Buy milk", A);
    await hostA.commitGuarded({
      resource: R,
      intents: [
        {
          intent: "section.create",
          sectionId: S,
          title: "Inbox",
          createdBy: A.signer.descriptor.principalId,
        },
        { intent: "task.create_in_section", task: t1, parent: S, after: null },
      ],
      operationId: "brg1:a-1",
      check: () => true,
    });
    hostA.start();
    await waitFor("A live", () => hostA.isLive(R));
    expect(hostA.generation).toBe(0);
    await waitFor("A sent", async () => (await a.storage.outbound.list(R)).length === 0);

    const b = memory();
    const ch = await network.connect(B.signer, url);
    const bChain = await syncChain(b.storage, ch, R);
    await fetchDeks(b.storage, b.secrets, ch, bChain, { signer: B.signer, agreement: B.agreement });
    ch.close();
    const hostB = new SectionHost({
      url,
      installation: B,
      ...b,
      tickMs: 100,
      reconnect: () => 500,
    });
    await hostB.open(R);
    hostB.start();
    await waitFor(
      "B live with the Task",
      () => hostB.isLive(R) && hostB.replica(R)?.task(t1.id) !== undefined,
    );

    const commitTitle = async (op: string, value: string) => {
      const t = hostB.replica(R)?.task(t1.id)?.task;
      if (t === undefined) throw new Error("no task");
      await hostB.commitGuarded({
        resource: R as ResourceId,
        intents: [setTitle(t, value).intent],
        operationId: op,
        check: (rep) => rep.task(t1.id)?.task?.title === t.title,
      });
    };
    await commitTitle("brg1:b-1", "Buy oat milk");
    await waitFor(
      "A sees B's change",
      () => hostA.replica(R)?.task(t1.id)?.task?.title === "Buy oat milk",
    );
    expect(remoteSeen).toContain(t1.id);

    // The server goes away: not live, a new generation; back: live again in it.
    await (server as LiveServer).stop();
    await waitFor("A not live", () => !hostA.isLive(R));
    expect(hostA.generation).toBe(1);
    await (server as LiveServer).restart();
    await waitFor("A live again", () => hostA.isLive(R), 60_000);
    expect(hostA.generation).toBe(1);
    await waitFor("B live again", () => hostB.isLive(R), 60_000);
    await commitTitle("brg1:b-2", "Buy almond milk");
    await waitFor(
      "A sees B's change after the restart",
      () => hostA.replica(R)?.task(t1.id)?.task?.title === "Buy almond milk",
    );
    await hostB.stop();
    await hostA.stop();
  });
});
