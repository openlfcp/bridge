// launchd agent, doctor, write modes of the verification gate (D-010 r4 §2.2, §7.4, §7.6).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakePerson, FakeStore, FakeTransport } from "@openlfcp/bridge-reminders/fake";
import { MemoryKV } from "@openlfcp/bridge-reminders/transport";
import { describe, expect, it } from "vitest";
import { Bootstrap, LIST_PREFIX, VERIFY_PREFIX } from "../src/bootstrap.js";
import { bridgePaths, loadConfig } from "../src/config.js";
import { doctor, worst } from "../src/doctor.js";
import { Journal, openBridgeDatabase } from "../src/index.js";
import {
  installLaunchAgent,
  renderLaunchAgent,
  THROTTLE_INTERVAL_S,
  uninstallLaunchAgent,
} from "../src/launchd.js";
import { markerUrl } from "../src/ownership.js";
import { recordVerification, writeModeFor, writesVerified } from "../src/verification.js";

const spec = {
  node: "/opt/node/bin/node",
  cli: "/opt/bridge/cli.js",
  home: "/tmp/h & h",
  logs: "/tmp/logs",
};

describe("launchd user agent", () => {
  it("has the keys of §2.2 and a throttle of at least 30 s", () => {
    const p = renderLaunchAgent(spec);
    expect(THROTTLE_INTERVAL_S).toBeGreaterThanOrEqual(30);
    for (const k of [
      "<key>RunAtLoad</key>",
      "<key>SuccessfulExit</key>\n\t\t<false/>",
      "<integer>30</integer>",
      "<string>Aqua</string>",
      "<key>LowPriorityIO</key>",
    ])
      expect(p).toContain(k);
    expect(p).toContain(
      "<string>/opt/node/bin/node</string>\n\t\t<string>/opt/bridge/cli.js</string>\n\t\t<string>run</string>",
    );
    expect(p).toContain("<string>/tmp/h &amp; h</string>");
  });

  it.runIf(process.platform === "darwin")("is a valid property list (plutil)", () => {
    const f = join(mkdtempSync(join(tmpdir(), "lfcp-plist-")), "a.plist");
    writeFileSync(f, renderLaunchAgent(spec));
    expect(execFileSync("plutil", ["-lint", f]).toString()).toContain("OK");
  });

  it("install writes and bootstraps; uninstall boots out and removes", () => {
    const dir = mkdtempSync(join(tmpdir(), "lfcp-agent-"));
    const path = join(dir, "LaunchAgents", "org.openlfcp.bridge.plist");
    const calls: string[][] = [];
    installLaunchAgent(path, { ...spec, logs: join(dir, "logs") }, (a) => calls.push([...a]));
    expect(readFileSync(path, "utf8")).toContain("org.openlfcp.bridge");
    installLaunchAgent(path, { ...spec, logs: join(dir, "logs") }, (a) => calls.push([...a]));
    expect(calls.map((c) => c[0])).toEqual(["bootstrap", "bootout", "bootstrap"]);
    expect(uninstallLaunchAgent(path, (a) => calls.push([...a]))).toBe(true);
    expect(uninstallLaunchAgent(path, (a) => calls.push([...a]))).toBe(false);
  });
});

describe("config", () => {
  it("creates a bridgeInstanceId once and keeps it", () => {
    const dir = mkdtempSync(join(tmpdir(), "lfcp-cfg-"));
    const paths = bridgePaths({ LFCP_BRIDGE_HOME: dir }, "/Users/x");
    const a = loadConfig(paths.config);
    expect(loadConfig(paths.config).bridgeInstanceId).toBe(a.bridgeInstanceId);
    expect(paths.launchAgent).toBe("/Users/x/Library/LaunchAgents/org.openlfcp.bridge.plist");
  });
});

describe("write modes (§7.6; effect permissions, review r3 P2-4)", () => {
  const helper = { helperVersion: "0.3.0", macOS: "26.5.2" };
  const cfg = { bridgeInstanceId: "i" };
  it("bootstrap, verification, verified and off", () => {
    expect(writeModeFor("bootstrap", { verification: false }, cfg, helper)).toBe("bootstrap");
    expect(writeModeFor("bootstrap", { verification: true }, cfg, helper)).toBe("verification");
    expect(writeModeFor("sync", { verification: true }, cfg, helper)).toBe("verification");
    expect(writeModeFor("sync", { verification: false }, cfg, helper)).toBe("off");
    const green = recordVerification(cfg, { helper, checks: [{ name: "a", ok: true }] });
    expect(writeModeFor("sync", { verification: false }, green, helper)).toBe("verified");
    // A new helper build or macOS resets it.
    expect(writesVerified(green, { ...helper, helperVersion: "0.3.1" })).toBe(false);
    expect(writesVerified(green, { ...helper, macOS: "26.6" })).toBe(false);
  });
  it("a report with a failure or no checks changes nothing", () => {
    expect(
      recordVerification(cfg, {
        helper,
        checks: [
          { name: "a", ok: true },
          { name: "b", ok: false },
        ],
      }),
    ).toBe(cfg);
    expect(recordVerification(cfg, { helper, checks: [] })).toBe(cfg);
  });
});

describe("doctor", () => {
  async function rig() {
    const home = mkdtempSync(join(tmpdir(), "lfcp-doc-"));
    const app = join(home, "Helper.app");
    mkdirSync(app);
    mkdirSync(join(home, "inst"));
    const db = openBridgeDatabase(":memory:");
    db.prepare(
      `INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES ('i1', ?, 'p', 'r', 'Mac', '2026-11-10T00:00:00Z')`,
    ).run(join(home, "inst"));
    const store = new FakeStore();
    const transport = new FakeTransport(store);
    await transport.open({
      installationKey: "i1",
      state: new MemoryKV(),
      scope: { listTitlePrefixes: [LIST_PREFIX, VERIFY_PREFIX], listIds: [] },
    });
    const boot = new Bootstrap({
      db,
      journal: new Journal(db),
      transport,
      instanceId: "me",
      stopped: () => false,
    });
    return { home, app, db, store, transport, boot, person: new FakePerson(store) };
  }

  it("all green for a bound section", async () => {
    const r = await rig();
    await r.boot.bind({ installationId: "i1", resourceId: "R1", section: "Work" });
    const checks = await doctor({
      db: r.db,
      home: r.home,
      helperApp: r.app,
      instanceId: "me",
      transport: r.transport,
    });
    expect(worst(checks)).toBe("ok");
  });

  it("names a missing helper, no TCC access, a gone list, a foreign marker, STOP", async () => {
    const r = await rig();
    const done = await r.boot.bind({ installationId: "i1", resourceId: "R1", section: "Work" });
    const list = (done as { list: string }).list;
    writeFileSync(join(r.home, "STOP"), "");
    const other = r.person.createList("Elsewhere");
    r.person.create(other.id, "m", { url: markerUrl("other", "R1"), completed: true });
    let checks = await doctor({
      db: r.db,
      home: r.home,
      helperApp: join(r.home, "none.app"),
      instanceId: "me",
      transport: r.transport,
    });
    expect(checks.find((c) => c.name === "helper")?.status).toBe("fail");
    expect(checks.find((c) => c.name === "stop")?.status).toBe("warn");
    expect(checks.find((c) => c.name.startsWith("binding"))?.detail).toContain("another bridge");
    r.person.deleteList(list as never);
    checks = await doctor({
      db: r.db,
      home: r.home,
      helperApp: r.app,
      instanceId: "me",
      transport: r.transport,
    });
    expect(checks.find((c) => c.name.startsWith("binding"))?.detail).toContain("is gone");
    r.transport.setStatus({ state: "needs_human", reason: "tcc_denied" });
    checks = await doctor({
      db: r.db,
      home: r.home,
      helperApp: r.app,
      instanceId: "me",
      transport: r.transport,
    });
    expect(checks.find((c) => c.name === "reminders access")).toMatchObject({ status: "fail" });
  });

  it("points at an unresolved unknown outcome of a bootstrap", async () => {
    const r = await rig();
    r.transport.faults.loseNextResponse = 1;
    await r.boot.bind({ installationId: "i1", resourceId: "R1", section: "Work" });
    const checks = await doctor({
      db: r.db,
      home: r.home,
      helperApp: r.app,
      instanceId: "me",
      transport: r.transport,
    });
    expect(checks.find((c) => c.name.startsWith("binding"))?.detail).toContain("--resolve-list");
  });
});
