// SectionHost offline (D-010 §5.8, PR 3a): a commit is stored with its
// receipt and queued without a server, so the guard's rules are tested
// here, on the real SDK 0.5.2 commit path. Remote changes are merged into
// the section's profile as the applier does after LFCP accepted a unit.

import { receiptOf } from "@openlfcp/client";
import { dataUnitId, type ResourceId } from "@openlfcp/core";
import { checkChange, setTitle } from "@openlfcp/shared-objects";
import { SectionReplica, type SectionsNodesChanged } from "@openlfcp/shared-objects/sections";
import { afterEach, describe, expect, it } from "vitest";
import { BasisChangedError, SectionHost, UnguardedCommitError } from "../src/index.js";
import { clientOf, profileOf } from "../src/lfcp/section-host.js";
import {
  installation,
  memory,
  offline,
  ownedSection,
  type Party,
  sectionId,
  task,
} from "./support/lfcp.js";

const URL = "ws://127.0.0.1:9/v1/ws";
const hosts: SectionHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
});

async function setup() {
  const me = installation();
  const m = memory();
  const { R } = await ownedSection(me, m.storage, m.secrets, URL);
  const host = new SectionHost({ url: URL, installation: me, ...m, webSocket: offline });
  hosts.push(host);
  const changes: [ResourceId, SectionsNodesChanged][] = [];
  host.onNodesChanged((r, e) => changes.push([r, e]));
  await host.open(R);
  const S = sectionId();
  const t1 = task("Buy milk", me);
  await host.commitGuarded({
    resource: R,
    intents: [
      {
        intent: "section.create",
        sectionId: S,
        title: "Inbox",
        createdBy: me.signer.descriptor.principalId,
      },
      { intent: "task.create_in_section", task: t1, parent: S, after: null },
    ],
    operationId: "brg1:setup",
    check: () => true,
  });
  return { me, ...m, R, S, t1, host, changes };
}

/** A change of another writer `who`, merged as LFCP would deliver it. */
function remote(host: SectionHost, R: ResourceId, who: Party, intents: unknown[]) {
  const profile = profileOf(host, R);
  if (profile === undefined) throw new Error("not open");
  const theirs = SectionReplica.fromSave(profile.replica.save(), {
    resource: R,
    principal: who.signer.descriptor.principalId,
  });
  const change = theirs.commit(intents as never);
  let n = Math.floor(Math.random() * 2 ** 30);
  for (const part of change?.parts ?? []) {
    const id = new Uint8Array(32);
    new DataView(id.buffer).setUint32(0, n++);
    profile.apply({ unitId: dataUnitId(id) }, checkChange(part.change));
  }
}

const title = (host: SectionHost, R: ResourceId, id: string) =>
  host.replica(R)?.task(id)?.task?.title;
const outbound = async (
  s: { storage: { outbound: { list(r: ResourceId): Promise<unknown[]> } } },
  R: ResourceId,
) => (await s.storage.outbound.list(R)).length;

describe("SectionHost.commitGuarded (§5.8)", () => {
  it("commits through the guard: a durable receipt, queued units, a local nodesChanged", async () => {
    const s = await setup();
    const receipt = await receiptOf(s.storage, s.R, "brg1:setup");
    expect(receipt?.unitIds.length).toBeGreaterThan(0);
    expect(await outbound(s, s.R)).toBe(receipt?.unitIds.length);
    expect(title(s.host, s.R, s.t1.id)).toBe("Buy milk");
    expect(s.changes.some(([r, e]) => r === s.R && e.origin === "local")).toBe(true);
  });

  it("has no other way to commit: the SDK client's own commit is refused, nothing written", async () => {
    const s = await setup();
    const before = await outbound(s, s.R);
    const t = s.host.replica(s.R)?.task(s.t1.id)?.task;
    if (t === undefined) throw new Error("no task");
    const client = clientOf.get(s.host);
    await expect(
      client?.commit(s.R, [setTitle(t, "bypass").intent], { operationId: "bypass" }),
    ).rejects.toBeInstanceOf(UnguardedCommitError);
    expect(await receiptOf(s.storage, s.R, "bypass")).toBeUndefined();
    expect(await outbound(s, s.R)).toBe(before);
    expect(title(s.host, s.R, s.t1.id)).toBe("Buy milk");
    expect("commit" in s.host).toBe(false);
  });

  it("a remote change between the caller's precheck and stage: BasisChangedError, zero units", async () => {
    const s = await setup();
    const basis = title(s.host, s.R, s.t1.id);
    const t = s.host.replica(s.R)?.task(s.t1.id)?.task;
    if (t === undefined) throw new Error("no task");
    // The caller's precheck passes now…
    expect(basis).toBe("Buy milk");
    const before = await outbound(s, s.R);
    const commit = s.host.commitGuarded({
      resource: s.R,
      intents: [setTitle(t, "Buy oat milk").intent],
      operationId: "brg1:race",
      check: (replica) => replica.task(s.t1.id)?.task?.title === basis || "title changed",
    });
    // …and a change of another device lands before the SDK stages the batch.
    remote(s.host, s.R, installation(), [setTitle(t, "Buy almond milk").intent]);
    await expect(commit).rejects.toBeInstanceOf(BasisChangedError);
    expect(await receiptOf(s.storage, s.R, "brg1:race")).toBeUndefined();
    expect(await outbound(s, s.R)).toBe(before);
    expect(title(s.host, s.R, s.t1.id)).toBe("Buy almond milk");
    expect(s.changes.some(([, e]) => e.origin === "remote" && e.nodeIds.includes(s.t1.id))).toBe(
      true,
    );
  });

  it("a retry of a committed operation returns its receipt without the check, after the model moved", async () => {
    const s = await setup();
    const t = s.host.replica(s.R)?.task(s.t1.id)?.task;
    if (t === undefined) throw new Error("no task");
    const intents = [setTitle(t, "Buy oat milk").intent];
    const first = await s.host.commitGuarded({
      resource: s.R,
      intents,
      operationId: "brg1:retry",
      check: () => true,
    });
    expect(first.staged).toBe(true);
    remote(s.host, s.R, installation(), [setTitle(t, "something else").intent]);
    const again = await s.host.commitGuarded({
      resource: s.R,
      intents,
      operationId: "brg1:retry",
      check: () => "would refuse",
    });
    expect(again).toEqual({ receipt: first.receipt, staged: false });
  });

  it("concurrent calls are independent: one array passed twice, one check failing", async () => {
    const s = await setup();
    const t = s.host.replica(s.R)?.task(s.t1.id)?.task;
    if (t === undefined) throw new Error("no task");
    const shared = [setTitle(t, "Buy bread").intent];
    const t2 = task("Call Bob", s.me);
    const [a, b, c] = await Promise.allSettled([
      s.host.commitGuarded({
        resource: s.R,
        intents: shared,
        operationId: "brg1:a",
        check: () => true,
      }),
      s.host.commitGuarded({
        resource: s.R,
        intents: shared,
        operationId: "brg1:b",
        check: () => "no",
      }),
      s.host.commitGuarded({
        resource: s.R,
        intents: [{ intent: "task.create_in_section", task: t2, parent: s.S, after: s.t1.id }],
        operationId: "brg1:c",
        check: () => true,
      }),
    ]);
    expect([a.status, b.status, c.status]).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(b.status === "rejected" && b.reason).toBeInstanceOf(BasisChangedError);
    expect(await receiptOf(s.storage, s.R, "brg1:b")).toBeUndefined();
    expect(title(s.host, s.R, s.t1.id)).toBe("Buy bread");
    expect(title(s.host, s.R, t2.id)).toBe("Call Bob");
  });
});

describe("SectionHost restore and rebuild", () => {
  it("restores a section from its checkpoint after a restart; a broken checkpoint rebuilds it", async () => {
    const s = await setup();
    await s.host.stop();
    hosts.splice(hosts.indexOf(s.host), 1);
    const again = new SectionHost({
      url: URL,
      installation: s.me,
      storage: s.storage,
      secrets: s.secrets,
      webSocket: offline,
    });
    hosts.push(again);
    const rebuilt: unknown[] = [];
    again.onRebuilt((e) => rebuilt.push(e.error));
    await again.open(s.R);
    expect(title(again, s.R, s.t1.id)).toBe("Buy milk");
    expect(rebuilt).toEqual([]);
    await again.stop();
    hosts.splice(hosts.indexOf(again), 1);

    // A checkpoint whose state is not a section save: restored as nothing, rebuilt.
    const cp = await s.storage.profileState.checkpoint(s.R);
    if (cp === undefined) throw new Error("no checkpoint");
    await s.storage.commit([
      { op: "put-profile-checkpoint", checkpoint: { ...cp, state: new Uint8Array([1, 2, 3]) } },
    ]);
    const third = new SectionHost({
      url: URL,
      installation: s.me,
      storage: s.storage,
      secrets: s.secrets,
      webSocket: offline,
    });
    hosts.push(third);
    third.onRebuilt((e) => rebuilt.push(e.error));
    await third.open(s.R);
    expect(rebuilt).toHaveLength(1);
    expect(third.isLive(s.R)).toBe(false);
    expect(third.replica(s.R)?.task(s.t1.id)).toBeUndefined();
  });

  it("opens only a Resource whose chain is stored; open is idempotent", async () => {
    const s = await setup();
    await s.host.open(s.R);
    const other = await ownedSection(installation(), memory().storage, memory().secrets, URL);
    await expect(s.host.open(other.R)).rejects.toThrow(/no Control Chain/);
  });
});

// Review PR 3a (P2): stop always stops the SDK client and frees the subscriptions.
describe("SectionHost.stop", () => {
  /** In-memory storage whose checkpoint writes can be made to fail. */
  function failingCheckpoints(m: ReturnType<typeof memory>) {
    const state = { fail: undefined as string | undefined };
    const inner = m.storage;
    const commit = inner.commit.bind(inner);
    inner.commit = (async (
      writes: readonly { op: string; checkpoint?: { resourceId: Uint8Array } }[],
    ) => {
      if (
        state.fail !== undefined &&
        writes.some(
          (w) =>
            w.op === "put-profile-checkpoint" &&
            w.checkpoint !== undefined &&
            toHexOf(w.checkpoint.resourceId) === state.fail,
        )
      )
        throw new Error("disk full");
      return commit(writes as never);
    }) as typeof inner.commit;
    return state;
  }
  const toHexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");

  async function twoSections() {
    const me = installation();
    const m = memory();
    const fail = failingCheckpoints(m);
    const one = await ownedSection(me, m.storage, m.secrets, URL);
    const two = await ownedSection(me, m.storage, m.secrets, URL);
    const host = new SectionHost({ url: URL, installation: me, ...m, webSocket: offline });
    hosts.push(host);
    const seen: string[] = [];
    host.onNodesChanged((r) => seen.push(toHexOf(r)));
    await host.open(one.R);
    await host.open(two.R);
    for (const [R, title] of [
      [one.R, "One"],
      [two.R, "Two"],
    ] as const) {
      const S = sectionId();
      await host.commitGuarded({
        resource: R,
        intents: [
          {
            intent: "section.create",
            sectionId: S,
            title,
            createdBy: me.signer.descriptor.principalId,
          },
          {
            intent: "task.create_in_section",
            task: task(`${title} task`, me),
            parent: S,
            after: null,
          },
        ],
        operationId: `brg1:${title}`,
        check: () => true,
      });
    }
    return { me, m, fail, one, two, host, seen };
  }

  it("a failing checkpoint of the first section: the client stops, the others are flushed, the error is returned", async () => {
    const s = await twoSections();
    const client = clientOf.get(s.host);
    if (client === undefined) throw new Error("no client");
    let clientStopped = false;
    const stop = client.stop.bind(client);
    client.stop = async () => {
      clientStopped = true;
      await stop();
    };
    // The second section changes after its last checkpoint: only stop's flush saves it.
    const t = s.host
      .replica(s.two.R)
      ?.snapshot()
      .order.find((e) => e.kind === "task");
    remote(s.host, s.two.R, installation(), [
      setTitle(s.host.replica(s.two.R)?.task(t?.id as string)?.task as never, "Two, renamed")
        .intent,
    ]);
    s.fail.fail = toHexOf(s.one.R);
    await expect(s.host.stop()).rejects.toThrow(/disk full/);
    hosts.splice(hosts.indexOf(s.host), 1);
    expect(clientStopped).toBe(true);
    // The subscriptions are gone: a change after stop reaches no listener.
    const before = s.seen.length;
    remote(s.host, s.two.R, installation(), []);
    expect(s.seen.length).toBe(before);
    // The second section's checkpoint was written in spite of the first one's failure.
    s.fail.fail = undefined;
    const again = new SectionHost({ url: URL, installation: s.me, ...s.m, webSocket: offline });
    hosts.push(again);
    await again.open(s.two.R);
    expect(again.replica(s.two.R)?.task(t?.id as string)?.task?.title).toBe("Two, renamed");
    // A second stop of the failed host does not throw again and does nothing.
    await s.host.stop();
  });

  it("several sections: every checkpoint written; a commit in flight completes before the flush", async () => {
    const s = await twoSections();
    const t = task("In flight", s.me);
    const S = s.host.replica(s.one.R)?.validate().sectionId as string;
    const inFlight = s.host.commitGuarded({
      resource: s.one.R,
      intents: [{ intent: "task.create_in_section", task: t, parent: S, after: null }],
      operationId: "brg1:in-flight",
      check: () => true,
    });
    const stopping = s.host.stop();
    await inFlight;
    await stopping;
    hosts.splice(hosts.indexOf(s.host), 1);
    const again = new SectionHost({ url: URL, installation: s.me, ...s.m, webSocket: offline });
    hosts.push(again);
    await again.open(s.one.R);
    await again.open(s.two.R);
    expect(again.replica(s.one.R)?.task(t.id)?.task?.title).toBe("In flight");
    expect(again.replica(s.two.R)?.snapshot().title.value).toBe("Two");
  });
});
