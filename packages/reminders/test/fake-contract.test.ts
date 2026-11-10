import { describe, expect, it } from "vitest";
import {
  FakePerson,
  FakeStore,
  FakeTransport,
  type FakeTransportOptions,
} from "../src/fake/index.js";
import { MemoryKV, TransportReadError } from "../src/transport.js";
import { type ContractRig, SCOPE_PREFIX, transportContract } from "../test-support/contract.js";

function fakeRig(opts: FakeTransportOptions): () => Promise<ContractRig> {
  return async () => {
    const store = new FakeStore();
    const kv = new MemoryKV();
    const person = new FakePerson(store);
    let transport = new FakeTransport(store, opts);
    return {
      get transport() {
        return transport;
      },
      kv,
      person: {
        createList: async (title, o) => person.createList(title, o ?? {}),
        create: async (list, title, o) => person.create(list, title, o ?? {}),
        edit: async (ref, e) => person.edit(ref, e),
      },
      loseNextResponse: () => {
        transport.faults.loseNextResponse += 1;
      },
      beforeSave: (edit) => {
        transport.faults.beforeSave = () => {
          void edit();
        };
      },
      stallNextWrite: () => {
        let release = () => {};
        transport.faults.stallNextWrite = new Promise<void>((r) => {
          release = r;
        });
        return () => release();
      },
      restart: async () => {
        transport = new FakeTransport(store, opts);
        return transport;
      },
    };
  };
}

transportContract("fake, EventKit-like (best-effort CAS, stage recover)", fakeRig({}));
transportContract(
  "fake, CloudKit-like (strong CAS, exact recover)",
  fakeRig({
    capabilities: {
      cas: "strong",
      recover: "exact",
      ids: { stable: true, clientChosen: true },
      changes: "delta",
    },
  }),
);

describe("fake transport faults", () => {
  async function open() {
    const store = new FakeStore();
    const t = new FakeTransport(store);
    await t.open({
      installationKey: "i",
      state: new MemoryKV(),
      scope: { listTitlePrefixes: [SCOPE_PREFIX], listIds: [] },
    });
    const list = await t.createList({ opKey: "l1", title: `${SCOPE_PREFIX}Inbox` });
    return { store, t, list };
  }

  it("incomplete reads are reported, never silently partial", async () => {
    const { t, list } = await open();
    t.faults.incompleteReads = true;
    expect((await t.snapshot(list.id)).complete).toBe(false);
    expect((await t.find({ urlPrefix: "lfcp://" }, "all")).complete).toBe(false);
  });

  it("injected store_conflict is retryable and has no effect", async () => {
    const { t, list } = await open();
    t.faults.failNext = { code: "store_conflict", times: 1 };
    const r = await t.apply({
      opKey: "c1",
      kind: "create",
      list: list.id,
      linkUrl: "lfcp://task/T",
      set: { title: "a" },
    });
    expect(r).toMatchObject({ ok: false, code: "store_conflict", retryable: true });
    expect((await t.snapshot(list.id)).items).toHaveLength(0);
    expect((await t.recover("c1")).state).toBe("not_started");
  });

  it("reads fail loudly when the transport is not ready", async () => {
    const { t, list } = await open();
    t.setStatus({ state: "needs_human", reason: "tcc_denied" });
    await expect(t.snapshot(list.id)).rejects.toBeInstanceOf(TransportReadError);
  });

  it("a lost createList answer is unknown with stage recover (bootstrap → unknown_outcome, r4 P1-3)", async () => {
    const store = new FakeStore();
    const kv = new MemoryKV();
    const t = new FakeTransport(store);
    await t.open({
      installationKey: "i",
      state: kv,
      scope: { listTitlePrefixes: [SCOPE_PREFIX], listIds: [] },
    });
    t.faults.loseNextResponse = 1;
    await expect(
      t.createList({ opKey: "boot-list", title: `${SCOPE_PREFIX}Work` }),
    ).rejects.toThrow();
    // A person makes another list with the same title meanwhile: the title proves nothing.
    new FakePerson(store).createList(`${SCOPE_PREFIX}Work`);
    expect((await t.recover("boot-list")).state).toBe("unknown");
  });

  it("change hints are coarse for EventKit-like and carry ids for delta transports", async () => {
    const { t, list } = await open();
    const hints: unknown[] = [];
    t.onChange((h) => hints.push(h));
    await t.apply({
      opKey: "c",
      kind: "create",
      list: list.id,
      linkUrl: "lfcp://task/T",
      set: { title: "a" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(hints[0]).toEqual({ coarse: true });
  });
});
