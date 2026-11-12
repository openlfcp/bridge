// The commands of PR 9 through `main` with a test runtime (fake transport, temp home, no launchctl).

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakePerson, FakeStore, FakeTransport } from "@openlfcp/bridge-reminders/fake";
import { MemoryKV } from "@openlfcp/bridge-reminders/transport";
import { describe, expect, it } from "vitest";
import { LIST_PREFIX, VERIFY_PREFIX } from "../src/bootstrap.js";
import { bridgePaths, loadConfig } from "../src/config.js";
import { EXIT, Holds, Journal, main, openBridgeDatabase } from "../src/index.js";
import type { MigrationPorts } from "../src/migration.js";
import type { Runtime } from "../src/runtime.js";
import { VERIFICATION_STEPS } from "../src/verification.js";

/**
 * The helper's write gate (Server.swift requireWrites): every command opens a new transport whose
 * helper starts with writes "off"; list and marker writes need "bootstrap" (or wider).
 */
function gated(t: FakeTransport): FakeTransport & {
  setWriteMode(mode: "off" | "bootstrap" | "verification" | "verified"): Promise<void>;
} {
  let mode = "off";
  const apply = t.apply.bind(t);
  const createList = t.createList.bind(t);
  const g = t as FakeTransport & {
    setWriteMode(m: "off" | "bootstrap" | "verification" | "verified"): Promise<void>;
  };
  g.setWriteMode = async (m) => {
    mode = m;
  };
  g.apply = async (op) =>
    mode === "off"
      ? {
          ok: false,
          opKey: op.opKey,
          code: "writes_disabled",
          retryable: false,
          message: "writes are disabled until the host enables them",
        }
      : apply(op);
  g.createList = async (req) => {
    if (mode === "off") throw new Error("writes_disabled");
    return createList(req);
  };
  return g;
}

async function machine(ports?: MigrationPorts, extra: Partial<Runtime> = {}) {
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
  let transport: FakeTransport | undefined;
  const rt = (): Runtime => ({
    paths,
    db,
    // Read by every command, as on the machine (verify --record writes it).
    config: loadConfig(paths.config),
    journal: new Journal(db),
    holds: new Holds(db),
    async openTransport() {
      transport = gated(new FakeTransport(store));
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
    ...(ports === undefined ? {} : { migrationPorts: async () => ports }),
    ...extra,
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

  it("verify binds an 'LFCP Verify · …' list and says what comes next (dry-run, approve, run)", async () => {
    const m = await machine();
    const r = await m.call("verify", "--section", "Test");
    expect(r.out).toContain('"LFCP Verify · Test"');
    expect(r.out).toContain("lfcp-bridge approve");
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

  it("still answers 'not available' for commands of later PRs; run needs the machine's process", async () => {
    const m = await machine();
    expect(await m.call("conflicts")).toMatchObject({
      code: EXIT.USAGE,
      err: "conflicts: not available in this build (D-010 PR 10)",
    });
    expect(await m.call("run")).toMatchObject({
      code: EXIT.USAGE,
      err: "run: not available on this machine",
    });
  });

  it("sections add and migrate: refused without quiescence; the whole N8 through the ports; status", async () => {
    let fresh = false;
    let proven = false;
    const ports: MigrationPorts = {
      pair: async (req) => {
        expect(req.sections).toEqual(["Home"]);
        return { id: "i2", dir: "/new", principal: "p2", root: "r", label: "Mac" };
      },
      catchUp: async (_i, rs) =>
        rs.map((r) => ({
          resourceId: r,
          live: fresh,
          connectedAt: new Date(Date.now() + 60_000).toISOString(),
        })),
      closeOld: async () => {},
      revocationStatus: async () => (proven ? "revocation-proven" : "active"),
    };
    const m = await machine(ports);
    await m.call("bind", "Work");
    const id = (m.db.prepare("SELECT id FROM bindings").get() as { id: string }).id;
    m.db
      .prepare(
        `INSERT INTO intents (id, binding_id, task_id, installation_id, direction, kind, fields_json, basis_json,
           payload_json, operation_id, state, created_at)
         VALUES ('x', ?, 'T', 'i1', 'to_apple', 'update', '[]', '{}', '{}', 'op', 'prepared', 'now')`,
      )
      .run(id);
    const refused = await m.call("sections", "add", "Home");
    expect(refused.code).toBe(EXIT.NEEDS_PERSON);
    expect(refused.err).toContain("sections add refused: open_intents 1");
    m.db.prepare("UPDATE intents SET state = 'finalized'").run();
    const started = await m.call("sections", "add", "Home");
    expect(started.code).toBe(EXIT.OK);
    expect(started.out).toMatch(/m_\w+ {2}catching_up {2}i1 -> i2/);
    fresh = true;
    const switched = await m.call("migrate", "resume");
    expect(switched.out).toContain("awaiting_revocation");
    expect(switched.out).toContain("revoke the old device (installation i1)");
    expect((await m.call("migrate", "abort")).err).toContain("after switching only forward");
    proven = true;
    await m.call("migrate", "resume");
    expect((await m.call("migrate", "status")).out).toMatch(/done {2}i1 -> i2/);
  });

  it("sections add needs the run process in this build; migrate status works without it", async () => {
    const m = await machine();
    expect(await m.call("sections", "add", "Home")).toMatchObject({ code: EXIT.USAGE });
    expect((await m.call("migrate", "status")).out).toBe("no migrations");
    expect((await m.call("migrate", "abort")).code).toBe(EXIT.NOT_FOUND);
  });
});

describe("verify --record (§7.6): the owner's report sets writesVerified", () => {
  const HELPER = { helperVersion: "0.3.1", macOS: "26.5.2" };
  /** Every step of the checklist, ok (one of them `bad`, if given). */
  const steps = (bad?: string) =>
    VERIFICATION_STEPS.map((name) => ({ name, ok: name !== bad, note: "" }));
  const green = (over: Record<string, unknown> = {}) => ({ ...HELPER, checks: steps(), ...over });
  async function verified(o: { running?: typeof HELPER; bind?: boolean } = {}) {
    const m = await machine(undefined, { helperIdentity: async () => o.running });
    if (o.bind !== false) expect((await m.call("verify", "--section", "Test")).code).toBe(EXIT.OK);
    const record = async (report: unknown) => {
      const file = join(m.paths.home, "report.json");
      writeFileSync(file, typeof report === "string" ? report : JSON.stringify(report));
      return m.call("verify", "--record", file);
    };
    const config = () => readFileSync(m.paths.config, "utf8");
    return { m, record, config };
  }

  it("a green report records the running helper and macOS; status shows it", async () => {
    const { m, record } = await verified({ running: HELPER });
    const r = await record(green());
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain("writesVerified: helper 0.3.1 on macOS 26.5.2, recorded ");
    expect(loadConfig(m.paths.config).writesVerified).toMatchObject(HELPER);
    expect((await m.call("status")).out).toMatch(
      /writesVerified: helper 0\.3\.1 on macOS 26\.5\.2 \(recorded \d{4}-/,
    );
  });

  it("a red check, a missing step or no checks: refused, exit 3, config unchanged", async () => {
    const { record, config } = await verified({ running: HELPER });
    const before = config();
    const step22 = VERIFICATION_STEPS[21] as string;
    const red = await record(green({ checks: steps(step22) }));
    expect([red.code, red.err]).toEqual([
      EXIT.NEEDS_PERSON,
      expect.stringContaining(`not ok: ${step22}`),
    ]);
    // Every template step by name: one left out (or renamed) is refused even if the rest is ok.
    const without = await record(green({ checks: steps().filter((c) => c.name !== step22) }));
    expect([without.code, without.err]).toEqual([
      EXIT.NEEDS_PERSON,
      expect.stringContaining(`incomplete): steps missing from the report`),
    ]);
    expect(without.err).toContain(step22);
    const renamed = await record(
      green({ checks: steps().map((c) => (c.name === step22 ? { ...c, name: "22" } : c)) }),
    );
    expect(renamed.err).toContain("incomplete");
    const empty = await record(green({ checks: [] }));
    expect([empty.code, empty.err]).toEqual([
      EXIT.NEEDS_PERSON,
      expect.stringContaining("incomplete"),
    ]);
    // An added check of the person's counts too.
    const extra = await record(
      green({ checks: [...steps(), { name: "my own check", ok: false, note: "" }] }),
    );
    expect(extra.err).toContain("not ok: my own check");
    expect(config()).toBe(before);
  });

  it("a report of another helper build or macOS than the running one is refused", async () => {
    const { record, config } = await verified({
      running: { helperVersion: "0.3.2", macOS: "26.5.2" },
    });
    const before = config();
    const r = await record(green());
    expect([r.code, r.err]).toEqual([
      EXIT.NEEDS_PERSON,
      expect.stringContaining("helper_mismatch"),
    ]);
    expect(r.err).toContain("this machine runs helper 0.3.2 on macOS 26.5.2");
    // Not filled in (the template's ""): refused, and the person learns what to write.
    const blank = await record(green({ helperVersion: "", macOS: "" }));
    expect([blank.code, blank.err]).toEqual([
      EXIT.NEEDS_PERSON,
      expect.stringContaining("does not say which helper and macOS"),
    ]);
    expect(blank.err).toContain("this machine runs helper 0.3.2 on macOS 26.5.2");
    expect(config()).toBe(before);
  });

  it("refused without a verification binding, or without a running helper", async () => {
    const unbound = await verified({ running: HELPER, bind: false });
    expect((await unbound.record(green())).err).toContain("no_binding");
    const noHelper = await verified({});
    expect((await noHelper.record(green())).err).toContain("no_helper");
    expect(loadConfig(noHelper.m.paths.config).writesVerified).toBeUndefined();
  });

  it("a malformed report is a usage error; --record needs a file", async () => {
    const { m, record } = await verified({ running: HELPER });
    expect((await record("{")).code).toBe(EXIT.USAGE);
    expect((await record(green({ checks: [{ name: "1", ok: "yes" }] }))).err).toContain(
      "ok must be true or false",
    );
    expect((await m.call("verify", "--record")).code).toBe(EXIT.USAGE);
  });

  it("the template lists steps 1–23, none ok yet: recorded as is, it is refused", async () => {
    const { record } = await verified({ running: HELPER });
    const template = JSON.parse(
      readFileSync(
        join(__dirname, "../../../docs/devel/testing/verification-report.template.json"),
        "utf8",
      ),
    ) as { checks: { name: string; ok: boolean }[] };
    // The template and the code name the same 23 steps, in order.
    expect(template.checks.map((c) => c.name)).toEqual(VERIFICATION_STEPS);
    expect(template.checks.map((c) => Number.parseInt(c.name, 10))).toEqual(
      Array.from({ length: 23 }, (_, i) => i + 1),
    );
    expect(template.checks.every((c) => c.ok === false)).toBe(true);
    const r = await record({ ...template, ...HELPER });
    expect(r.code).toBe(EXIT.NEEDS_PERSON);
    expect(r.err).toContain("not_green");
  });
});
