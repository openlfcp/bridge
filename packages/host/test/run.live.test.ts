// The run process against the Rust reference server (D-010 PR 9b; r2 §10.3 E1–E6 in short):
// another device A edits the section, the bridge B — a BridgeProcess with a live SectionHost, a
// real AccessTracker and the fake account — follows: LFCP → reminder, reminder → LFCP (delivered,
// accepted), a new reminder → a Task, a deleted reminder → unlinked, a mass change → hold, accept →
// it goes. Then A revokes B's capability: once B learns the refusal from the server, hold
// access_refused and nothing more goes to LFCP (§5.9). Skipped without LFCP_SERVER_BIN.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ListRef, localDate } from "@openlfcp/bridge-reminders";
import { FakePerson, FakeStore, FakeTransport } from "@openlfcp/bridge-reminders/fake";
import {
  connectionNetwork,
  fetchDeks,
  loadControlChain,
  queueControlRecord,
  queueKeyPackage,
  receiptOf,
  syncChain,
} from "@openlfcp/client";
import { dataEpoch, type ResourceId, toHex } from "@openlfcp/core";
import { createTask, deleteTask, setTitle, type Task } from "@openlfcp/shared-objects";
import { sealKeyPackage, signControlRecord } from "@openlfcp/wire";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AccessTracker,
  type BridgeDatabase,
  BridgeProcess,
  Holds,
  metaAccessStore,
  openBridgeDatabase,
  SectionHost,
  transportStateKV,
} from "../src/index.js";
import { markerUrl } from "../src/ownership.js";
import { installation, memory, ownedSection, sectionId } from "./support/lfcp.js";
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
const INSTANCE = "5e1f0000-0000-4000-8000-00000000b0b0";

describe.skipIf(skip !== undefined)("the run process, live", { timeout: 180_000 }, () => {
  it("LFCP ↔ Reminders through the process; import, unlink, hold and accept; a server refusal", async () => {
    const url = (server as LiveServer).url;
    // A: the person's device, the section's owner.
    const A = installation();
    const a = memory();
    const { R, dek } = await ownedSection(A, a.storage, a.secrets, url);
    const genesis = (await a.storage.control.records(R))[0]?.bytes as Uint8Array;
    const ch0 = await network.connect(A.signer, url);
    expect((await ch0.host(genesis)).kind).toBe("ack");
    ch0.close();
    // B: the bridge, granted read and write.
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
    await queueKeyPackage(
      a.storage,
      (
        await sealKeyPackage({
          resourceId: R,
          epoch: dataEpoch(0n),
          controlHead: grant.recordId,
          recipient: B.signer.descriptor,
          dek,
          signer: A.signer,
        })
      ).bytes,
    );
    const hostA = new SectionHost({
      url,
      installation: A,
      ...a,
      tickMs: 100,
      reconnect: () => 500,
    });
    await hostA.open(R);
    const S = sectionId();
    await hostA.commitGuarded({
      resource: R,
      intents: [
        {
          intent: "section.create",
          sectionId: S,
          title: "Verify",
          createdBy: A.signer.descriptor.principalId,
        },
      ],
      operationId: "a-setup",
      check: () => true,
    });
    hostA.start();
    await waitFor("A sent", async () => (await a.storage.outbound.list(R)).length === 0);
    let last: string | null = null;
    const aTask = async (title: string): Promise<Task> => {
      const task = createTask({ title, createdBy: A.signer.descriptor.principalId }).task;
      await hostA.commitGuarded({
        resource: R,
        intents: [{ intent: "task.create_in_section", task, parent: S, after: last }],
        operationId: `a-${task.id}`,
        check: () => true,
      });
      last = task.id;
      return task;
    };
    const aEdit = async (op: string, change: { intent: unknown }) =>
      hostA.commitGuarded({
        resource: R,
        intents: [change.intent],
        operationId: op,
        check: () => true,
      });
    const aNow = (id: string) => hostA.replica(R)?.task(id)?.task;

    // The bridge's side: its storage synced, bridge.sqlite, the fake account, the process.
    const b = memory();
    const ch = await network.connect(B.signer, url);
    const bChain = await syncChain(b.storage, ch, R);
    await fetchDeks(b.storage, b.secrets, ch, bChain, { signer: B.signer, agreement: B.agreement });
    ch.close();
    const dir = mkdtempSync(join(tmpdir(), "lfcp-bridge-run-live-"));
    const db: BridgeDatabase = openBridgeDatabase(join(dir, "bridge.sqlite"));
    const store = new FakeStore();
    store.today = () => localDate("2026-11-10");
    const person = new FakePerson(store);
    const list = person.createList("LFCP Verify · Verify");
    person.create(list.id, "LFCP bridge · не удалять", {
      url: markerUrl(INSTANCE, toHex(R)),
      completed: true,
    });
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES ('i', ?, 'p', 'r', 'bridge', ?)",
    ).run(dir, now);
    db.prepare(
      `INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, target_ref, filter_mode, state, verification, created_at)
       VALUES ('b', 'i', ?, 'apple-reminders', 'fake', ?, 'all', 'active', 1, ?)`,
    ).run(toHex(R), list.id, now);
    const t = new FakeTransport(store);
    await t.open({
      installationKey: "i",
      state: transportStateKV(db, "fake", "i"),
      scope: { listTitlePrefixes: ["LFCP Verify · "], listIds: [list.id as ListRef] },
    });
    const hostB = new SectionHost({
      url,
      installation: B,
      ...b,
      tickMs: 100,
      reconnect: () => 500,
    });
    const access = new AccessTracker({
      source: hostB,
      store: metaAccessStore(db, "i"),
      checkRevocation: async () => "active",
    });
    const p = new BridgeProcess({
      db,
      transport: t,
      installations: [
        {
          id: "i",
          host: hostB,
          receipt: (r: ResourceId, op: string) => receiptOf(b.storage, r, op),
          access,
          createdBy: B.signer.descriptor.principalId,
          onBlocked: (hex) => void access.refused(R, `blocked ${hex.slice(0, 8)}`),
        },
      ],
      instanceId: INSTANCE,
      writesVerified: () => false,
      stopped: () => false,
      timeZone: "UTC",
      debounceMs: 50,
      maxDelayMs: 300,
    });
    const reminders = () =>
      [...store.items.values()]
        .map((x) => store.view(x))
        .filter((x) => x.list === list.id && !x.completed);
    const reminderOf = (title: string) => reminders().find((x) => x.title === title);
    try {
      await p.start();
      await waitFor("B live", () => hostB.isLive(R) && access.accessCheckedNow(R));

      // 1. LFCP → reminder: A's new Task reaches B as remote nodes, the pass projects it.
      const milk = await aTask("Buy milk");
      await waitFor("the reminder", () => reminderOf("Buy milk") !== undefined);
      // 2. A's edit → the reminder follows.
      await aEdit("a-edit-1", setTitle(aNow(milk.id) as Task, "Buy oat milk"));
      await waitFor("the reminder's title", () => reminderOf("Buy oat milk") !== undefined);
      // 3. The person's edit in Reminders → LFCP, delivered (A sees it; the batch accepted).
      person.edit((reminderOf("Buy oat milk") as { ref: { id: string } }).ref, {
        title: "Buy rye bread",
      });
      await waitFor("A sees the bridge's change", () => aNow(milk.id)?.title === "Buy rye bread");
      await waitFor(
        "the batch accepted",
        () =>
          (
            db
              .prepare(
                "SELECT count(*) AS n FROM intents WHERE direction = 'to_lfcp' AND batch_status = 'accepted'",
              )
              .get() as { n: number }
          ).n > 0,
      );
      // 4. A new reminder → a Task at the end of the section (A sees it).
      person.create(list.id, "Call mom");
      await waitFor("A sees the imported Task", () =>
        Object.values(hostA.replica(R)?.snapshot().nodes ?? {}).some(
          (n) => n.taskId !== undefined && aNow(n.taskId)?.title === "Call mom",
        ),
      );
      // 5. The person deletes a reminder → unlinked; the Task stays at A.
      person.delete((reminderOf("Buy rye bread") as { ref: { id: string } }).ref);
      await waitFor(
        "unlinked",
        () =>
          (
            db.prepare("SELECT state FROM links WHERE task_id = ?").get(milk.id) as {
              state: string;
            }
          ).state === "unlinked",
      );
      expect(aNow(milk.id)?.lifecycle).toBe("active");
      // 6. Four Tasks deleted at A at once → hold guard_mass_unlink; accepted → it goes through.
      const four: Task[] = [];
      for (const k of [1, 2, 3, 4]) four.push(await aTask(`Task ${k}`));
      await waitFor("four reminders", () => four.every((x) => reminderOf(x.title) !== undefined));
      for (const x of four) await aEdit(`a-del-${x.id}`, deleteTask(aNow(x.id) as Task));
      await waitFor("hold", () => new Holds(db).has("b", "guard_mass_unlink"));
      expect(
        four.every(
          (x) =>
            (db.prepare("SELECT state FROM links WHERE task_id = ?").get(x.id) as { state: string })
              .state === "linked",
        ),
      ).toBe(true);
      // Every guard the mass change set (here also guard_count_drop) is accepted on its own.
      const holds = new Holds(db);
      const set = holds.of("b").map((h) => h.reason);
      expect(set).toContain("guard_mass_unlink");
      for (const reason of set) holds.accept("b", reason);
      await p.pass("b");
      expect(
        four.every(
          (x) =>
            (db.prepare("SELECT state FROM links WHERE task_id = ?").get(x.id) as { state: string })
              .state === "task_gone",
        ),
      ).toBe(true);
      expect(reminders().filter((x) => x.title.startsWith("Task "))).toHaveLength(4);

      // 7. A revokes B's capability; B's next commit (the person's edit) is refused by the server.
      const head = await loadControlChain(a.storage, R);
      if (head?.kind !== "linear") throw new Error("no chain");
      const revoke = signControlRecord(
        { resourceId: R, controlSeq: head.state.seq + 1n, prevControlId: head.state.head },
        { type: "CAPABILITY_REVOKE", grantId: grant.recordId },
        A.signer,
      );
      await queueControlRecord(a.storage, revoke.bytes);
      await waitFor(
        "A sent the revoke",
        async () => (await a.storage.outbound.list(R)).length === 0,
      );
      // B learns it (the server refuses B's write access; ~30 s here): hold access_refused, and
      // the person's next edit is not sent to LFCP.
      await waitFor("B refused", () => !access.accessCheckedNow(R), 90_000);
      await waitFor("hold access_refused", () => new Holds(db).has("b", "access_refused"));
      const call = reminderOf("Call mom");
      if (call === undefined) throw new Error("no imported reminder");
      person.edit(call.ref, { title: "Call mom tonight" });
      await new Promise((r) => setTimeout(r, 1500));
      await p.idle();
      const sent = db
        .prepare(
          "SELECT count(*) AS n FROM intents WHERE direction = 'to_lfcp' AND state IN ('effecting','applied','finalized') AND payload_json LIKE '%Call mom tonight%'",
        )
        .get() as { n: number };
      expect(sent.n).toBe(0);
      const imported = Object.values(hostA.replica(R)?.snapshot().nodes ?? {})
        .map((n) => (n.taskId === undefined ? undefined : aNow(n.taskId)))
        .find((x) => x?.title?.startsWith("Call mom"));
      expect(imported?.title).toBe("Call mom");
    } finally {
      await p.stop();
      access.close();
      await hostA.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
