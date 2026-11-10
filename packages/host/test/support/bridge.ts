// A bridge on one binding for end-to-end tests: bridge.sqlite, a section in an
// offline SectionHost (its replica is real; lfcp_live is the test's to set),
// a FakeStore account with the list, the fake transport, the executor with
// the adapter's handler, the pass and the link applier. `sync()` is one pass
// as apply will run it once PR 9 opens it: plan → link transitions → intents.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppleItem, type ListInfo, type ListRef, localDate } from "@openlfcp/bridge-reminders";
import type { FilterMode } from "@openlfcp/bridge-reminders/adapter";
import { FakePerson, FakeStore, FakeTransport } from "@openlfcp/bridge-reminders/fake";
import { receiptOf } from "@openlfcp/client";
import { generateObjectId, type ResourceId, toHex } from "@openlfcp/core";
import { createTask, principalRef, type Task } from "@openlfcp/shared-objects";
import {
  type BridgeDatabase,
  bridgeHandler,
  type CrashPoint,
  Executor,
  LinkApplier,
  offlineTestPort,
  openBridgeDatabase,
  Pass,
  SectionHost,
  transportStateKV,
} from "../../src/index.js";
import { installation, memory, offline, ownedSection } from "./lfcp.js";

export interface BridgeOptions {
  readonly filter?: FilterMode;
  /** strict_until in the future (24 h after approve, §7.2). */
  readonly strict?: boolean;
}

export async function bridge(o: BridgeOptions = {}) {
  const me = installation();
  const root = me.signer.descriptor.principalId;
  const dir = mkdtempSync(join(tmpdir(), "lfcp-bridge-e2e-"));
  const db: BridgeDatabase = openBridgeDatabase(join(dir, "bridge.sqlite"));
  const store = new FakeStore();
  store.today = () => localDate("2026-11-10");
  const person = new FakePerson(store);
  const list: ListInfo = person.createList("LFCP · Inbox");
  const m = memory();
  const URL = "ws://127.0.0.1:9/v1/ws";
  const { R } = await ownedSection(me, m.storage, m.secrets, URL);
  const host = new SectionHost({ url: URL, installation: me, ...m, webSocket: offline });
  await host.open(R);
  const S = generateObjectId();
  await host.commitGuarded({
    resource: R,
    intents: [{ intent: "section.create", sectionId: S, title: "Inbox", createdBy: root }],
    operationId: "setup",
    check: () => true,
  });
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES ('i', 'd', 'p', 'r', 'l', ?)",
  ).run(now);
  db.prepare(
    `INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, target_ref, filter_mode, state,
       strict_until, created_at) VALUES ('b', 'i', ?, 'apple-reminders', 'fake', ?, ?, 'active', ?, ?)`,
  ).run(
    toHex(R),
    list.id,
    o.filter ?? "all",
    o.strict === true ? new Date(Date.now() + 86_400_000).toISOString() : null,
    now,
  );
  const t = new FakeTransport(store);
  await t.open({
    installationKey: "i",
    state: transportStateKV(db, "fake", "i"),
    scope: { listTitlePrefixes: ["LFCP · "], listIds: [list.id as ListRef] },
  });
  const TZ = "UTC";
  const port = offlineTestPort({
    commitGuarded: (c: Parameters<SectionHost["commitGuarded"]>[0]) => host.commitGuarded(c),
    receipt: (r: ResourceId, op: string) => receiptOf(m.storage, r, op),
  });
  /** An executor on this bridge; `crash` throws at that boundary (the crash suite's hook). */
  const executor = (crash?: CrashPoint) =>
    new Executor({
      db,
      transport: t,
      lfcp: port,
      gates: {
        stopped: () => false,
        safeMode: () => false,
        ownershipChecked: () => true,
        accessCheckedNow: () => true,
        offlineCommitAllowed: () => true,
        connected: () => false,
      },
      handler: bridgeHandler({ timeZone: TZ }),
      effects: { enabled: true },
      ...(crash === undefined
        ? {}
        : {
            crash: (p: CrashPoint) => {
              if (p === crash) throw new Error(`crash ${p}`);
            },
          }),
    });
  const e = executor();
  /** lfcp_live (§5.3): the offline host never is; the test says when LFCP is caught up. */
  const lfcp = { live: true };
  const pass = new Pass({
    db,
    transport: t,
    lfcp: { replica: (r: ResourceId) => host.replica(r), isLive: () => lfcp.live },
    me: async () => principalRef(root),
    createdBy: async () => root,
    timeZone: TZ,
  });
  const links = new LinkApplier({ db, transport: t });

  let previous: string | undefined;
  const api = {
    db,
    store,
    person,
    list,
    host,
    R,
    root,
    t,
    e,
    pass,
    links,
    lfcp,
    executor,
    storage: m.storage,
    /** A Task in the section, assigned to me unless `unassigned`. */
    async task(title: string, over: { due?: string; unassigned?: boolean } = {}): Promise<Task> {
      const task = createTask({
        title,
        createdBy: root,
        ...(over.due === undefined ? {} : { due: over.due }),
        ...(over.unassigned === true ? {} : { assignees: [root] }),
      }).task;
      await host.commitGuarded({
        resource: R,
        intents: [{ intent: "task.create_in_section", task, parent: S, after: previous ?? null }],
        operationId: `create-${task.id}`,
        check: () => true,
      });
      previous = task.id;
      return task;
    },
    /** An LFCP-side change (another device's, here a local commit). */
    async edit(change: { intent: unknown }): Promise<void> {
      await host.commitGuarded({
        resource: R,
        intents: [change.intent],
        operationId: `edit-${generateObjectId()}`,
        check: () => true,
      });
    },
    now(id: string): Task {
      return host.replica(R)?.task(id)?.task as Task;
    },
    /** The reminders of a list (all lists when omitted), as the transport reads them. */
    reminders(of?: ListInfo["id"]): AppleItem[] {
      return [...store.items.values()]
        .map((x) => store.view(x))
        .filter((x) => of === undefined || x.list === of);
    },
    /** The link of a reminder (by its id), whatever its Task. */
    linkOf(reminderId: string) {
      return db
        .prepare(
          "SELECT task_id, state, origin, url_state, rem_url FROM links WHERE rem_id_cache = ?",
        )
        .get(reminderId) as
        | {
            task_id: string;
            state: string;
            origin: string;
            url_state: string;
            rem_url: string | null;
          }
        | undefined;
    },
    /** The section's Tasks in projection order (depth 0). */
    order(): string[] {
      return (host.replica(R)?.tree().tree ?? []).filter((x) => x.depth === 0).map((x) => x.id);
    },
    link(task: string) {
      return db
        .prepare("SELECT state, state_reason, status_locked FROM links WHERE task_id = ?")
        .get(task) as
        | { state: string; state_reason: string | null; status_locked: number }
        | undefined;
    },
    /** One pass: plan, the link transitions, then every planned intent. */
    async sync() {
      const r = await pass.dryRun("b");
      if (r.kind !== "planned") throw new Error(`${r.kind}: ${"reason" in r ? r.reason : ""}`);
      const applied = await links.apply("b", r.plan, { executor: e, guards: r.guards });
      const prepared = applied.kind === "held" ? [] : applied.prepared;
      const outcomes = [];
      for (const i of prepared) outcomes.push(await e.run(i.id));
      return { plan: r.plan, applied, prepared, outcomes };
    },
    async close() {
      await host.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return api;
}
export type Bridge = Awaited<ReturnType<typeof bridge>>;
