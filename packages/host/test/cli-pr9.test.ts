// The commands of PR 9 through `main` with a test runtime (fake transport, temp home, no launchctl).

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakePerson, FakeStore, FakeTransport } from "@openlfcp/bridge-reminders/fake";
import { MemoryKV } from "@openlfcp/bridge-reminders/transport";
import { describe, expect, it } from "vitest";
import { LIST_PREFIX, VERIFY_PREFIX } from "../src/bootstrap.js";
import { bridgePaths, loadConfig } from "../src/config.js";
import { EXIT, Holds, Journal, main, openBridgeDatabase } from "../src/index.js";
import type { Runtime } from "../src/runtime.js";

async function machine() {
  const home = mkdtempSync(join(tmpdir(), "lfcp-cli-"));
  const paths = {
    ...bridgePaths({ LFCP_BRIDGE_HOME: home, LFCP_BRIDGE_LOGS: join(home, "logs") }, home),
  };
  const db = openBridgeDatabase(paths.database);
  db.prepare(
    "INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES ('i1', ?, 'p', 'r', 'Mac', '2026-11-10T00:00:00Z')",
  ).run(home);
  const store = new FakeStore();
  const kv = new MemoryKV();
  const ctl: string[][] = [];
  const config = loadConfig(paths.config);
  let transport: FakeTransport | undefined;
  const rt = (): Runtime => ({
    paths,
    db,
    config,
    journal: new Journal(db),
    holds: new Holds(db),
    async openTransport() {
      transport = new FakeTransport(store);
      await transport.open({
        installationKey: "i",
        state: kv,
        scope: { listTitlePrefixes: [LIST_PREFIX, VERIFY_PREFIX], listIds: [] },
      });
      return transport;
    },
    resolveSection: async (name) =>
      name === "Work" || name === "Test"
        ? { installationId: "i1", resourceId: `R-${name}`, title: name }
        : undefined,
    launchctl: (a) => ctl.push([...a]),
    node: "/usr/local/bin/node",
    cli: "/opt/bridge/cli.js",
    async close() {},
  });
  const call = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      runtime: async () => rt(),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  return { call, db, store, person: new FakePerson(store), paths, ctl };
}

describe("lfcp-bridge (PR 9 commands)", () => {
  it("bind → status → unbind", async () => {
    const m = await machine();
    const b = await m.call("bind", "Work");
    expect(b.code).toBe(EXIT.OK);
    expect(b.out).toMatch(/bound: binding (b_\w+), list "LFCP · Work"/);
    const id = /binding (b_\w+)/.exec(b.out)?.[1] as string;
    expect((await m.call("status")).out).toContain(`${id}  pending_dry_run  "LFCP · Work"`);
    expect((await m.call("bind", "Work")).code).toBe(EXIT.NEEDS_PERSON); // already bound
    expect((await m.call("unbind", id)).out).toContain("marker retired");
  });

  it("bind of an unknown section → not found; a taken title → refused, exit 3", async () => {
    const m = await machine();
    expect((await m.call("bind", "Nope")).code).toBe(EXIT.NOT_FOUND);
    m.person.createList("LFCP · Work");
    const r = await m.call("bind", "Work");
    expect([r.code, r.err]).toEqual([EXIT.NEEDS_PERSON, expect.stringContaining("list_exists")]);
  });

  it("verify binds an 'LFCP Verify · …' list and says that apply comes with PR 8", async () => {
    const m = await machine();
    const r = await m.call("verify", "--section", "Test");
    expect(r.out).toContain('"LFCP Verify · Test"');
    expect(r.out).toContain("PR 8");
  });

  it("stop blocks bind (exit 5); resume lifts it", async () => {
    const m = await machine();
    expect((await m.call("stop")).code).toBe(EXIT.OK);
    expect((await m.call("status")).out).toContain("STOP: yes");
    expect((await m.call("bind", "Work")).code).toBe(EXIT.STOPPED);
    expect((await m.call("resume")).out).toBe("STOP removed");
    expect((await m.call("bind", "Work")).code).toBe(EXIT.OK);
  });

  it("resume --accept lifts one hold of one binding", async () => {
    const m = await machine();
    const id = /binding (b_\w+)/.exec((await m.call("bind", "Work")).out)?.[1] as string;
    new Holds(m.db).set(id, "ownership_lost");
    new Holds(m.db).set(id, "helper_unavailable");
    expect((await m.call("resume", "--accept", "ownership_lost", "--binding", id)).out).toContain(
      "lifted",
    );
    expect(new Holds(m.db).of(id).map((h) => h.reason)).toEqual(["helper_unavailable"]);
    expect((await m.call("resume", "--accept", "nonsense", "--binding", id)).code).toBe(EXIT.USAGE);
  });

  it("service install writes the agent and bootstraps it; uninstall boots it out", async () => {
    const m = await machine();
    expect((await m.call("service", "install")).code).toBe(EXIT.OK);
    expect(readFileSync(m.paths.launchAgent, "utf8")).toContain(
      "<string>/opt/bridge/cli.js</string>",
    );
    expect((await m.call("service", "uninstall")).out).toBe("LaunchAgent removed");
    expect(m.ctl.map((c) => c[0])).toEqual(["bootstrap", "bootout"]);
  });

  it("doctor reports and exits 3 on a failure (no helper app here); log shows the journal", async () => {
    const m = await machine();
    await m.call("bind", "Work");
    const d = await m.call("doctor");
    expect(d.code).toBe(EXIT.NEEDS_PERSON);
    expect(d.out).toContain("fail  helper");
    expect((await m.call("log")).out).toContain("bootstrap.done");
  });

  it("doctor changes nothing: a lost marker is reported, no hold and no journal entry is written", async () => {
    const m = await machine();
    await m.call("bind", "Work");
    const marker = [...m.store.items.values()].find((i) => i.linkUrl?.startsWith("lfcp://bridge/"));
    m.person.delete({ id: marker?.id as string });
    const state = () =>
      JSON.stringify([
        m.db.prepare("SELECT * FROM binding_holds ORDER BY binding_id, reason").all(),
        m.db.prepare("SELECT * FROM journal ORDER BY id").all(),
        m.db.prepare("SELECT * FROM bindings ORDER BY id").all(),
      ]);
    const before = state();
    const d = await m.call("doctor");
    expect(d.out).toContain("this bridge's marker is gone");
    expect(state()).toBe(before);
  });

  it("still answers 'not available' for commands after PR 9's part 1", async () => {
    const m = await machine();
    expect(await m.call("run")).toMatchObject({
      code: EXIT.USAGE,
      err: "run: not available in this build (D-010 PR 9 (after 8))",
    });
  });
});
