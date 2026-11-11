// The machine's wiring that needs no Mac (D-010 PR 9b): the EventKit transport's writesVerified for
// this helper build and macOS (review PR 9b #29) — what the executor's permissions read.

import { describe, expect, it } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { permits } from "../src/index.js";
import { eventKitTransportFor } from "../src/run/machine.js";

const config = (v?: { helperVersion: string; macOS: string }): BridgeConfig => ({
  bridgeInstanceId: "x",
  ...(v === undefined ? {} : { writesVerified: { ...v, at: "2026-11-10T00:00:00Z" } }),
});
const link = async () => {
  throw new Error("no helper in this test");
};
/** A normal binding's to_apple update with everything else allowed (§7.1). */
const normalUpdate = (writesVerified: boolean) =>
  permits({
    mode: "normal",
    effect: "apple_update",
    stopped: false,
    safeMode: false,
    installationActive: true,
    bindingState: "active",
    verificationBinding: false,
    holds: [],
    transportOk: true,
    listPresent: true,
    ownershipChecked: true,
    foreignMarker: false,
    accessCheckedNow: true,
    offlineCommitAllowed: true,
    connected: true,
    writesVerified,
  });

describe("machine: the transport's writesVerified (§7.6)", () => {
  it("a record for this helper and macOS gives the capability; a normal binding may then write", () => {
    const helper = { helperVersion: "1.2.0", macOS: "15.1" };
    const t = eventKitTransportFor(config(helper), helper, { appPath: "/x.app", link });
    expect(t.capabilities.writesVerified).toBe(true);
    expect(normalUpdate(t.capabilities.writesVerified)).toEqual([]);
  });

  it("another helper build or macOS, or no record: no capability, a normal binding is refused", () => {
    const helper = { helperVersion: "1.2.0", macOS: "15.1" };
    for (const c of [
      config({ helperVersion: "1.1.0", macOS: "15.1" }),
      config({ helperVersion: "1.2.0", macOS: "15.2" }),
      config(),
    ]) {
      const t = eventKitTransportFor(c, helper, { appPath: "/x.app", link });
      expect(t.capabilities.writesVerified).toBe(false);
      expect(normalUpdate(t.capabilities.writesVerified)).toContain("writes_not_verified");
    }
  });
});

describe("review PR 9b r2 #33: the helper back after resume → the transport on it → a pass", () => {
  it("unavailable → resume → the transport is opened on the new helper, then the pass runs", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { MemoryKV } = await import("@openlfcp/bridge-reminders/transport");
    const { EventKitTransport } = await import("@openlfcp/bridge-transport-eventkit");
    const { HelperSupervisor } = await import("../src/supervisor.js");
    const { helperReconnector } = await import("../src/run/machine.js");
    let nextPid = 50000;
    type Fake = { pid: number; requests: string[]; exit: (code: number) => void };
    const links: Fake[] = [];
    let current: Fake | undefined;
    const makeLink = () => {
      const exits = new Set<(c: number | null) => void>();
      const fake: Fake = {
        pid: nextPid++,
        requests: [],
        exit: (c) => {
          for (const cb of exits) cb(c);
        },
      };
      links.push(fake);
      current = fake;
      return {
        ready: {
          event: "ready",
          protocol: 2,
          helperVersion: "1.0",
          backend: "memory",
          cas: "strong",
          authorization: "fullAccess",
          pid: fake.pid,
        },
        request: async (op: string) => {
          fake.requests.push(op);
          return { ok: true } as never;
        },
        onEvent: () => () => {},
        onExit: (cb: (c: number | null) => void) => {
          exits.add(cb);
          return () => exits.delete(cb);
        },
        close: async () => {},
      };
    };
    let link = makeLink();
    const supervisor = new HelperSupervisor({
      pidFile: join(mkdtempSync(join(tmpdir(), "lfcp-sup-")), "helper.pid"),
      maxRestarts: 0,
      isOurs: () => false,
      start: async () => {
        if (current === undefined || links.length > 1 || current.requests.length > 0)
          link = makeLink();
        return {
          pid: (current as Fake).pid,
          ping: async () => {},
          close: async () => {},
          onExit: (cb) => link.onExit(cb),
        };
      },
    });
    const transport = new EventKitTransport({ appPath: "/x.app", link: async () => link as never });
    const ctx = {
      installationKey: "k",
      state: new MemoryKV(),
      scope: { listTitlePrefixes: [], listIds: [] },
    };
    await supervisor.start();
    await transport.open(ctx);
    const first = current as Fake;
    expect(first.requests).toContain("hello");
    // The helper dies; no budget left: unavailable, the transport on a dead link.
    first.exit(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(transport.status().state).toBe("unavailable");
    const passes: number[] = [];
    const reconnector = helperReconnector({
      supervisor,
      reopen: () => transport.open(ctx),
      after: async () => {
        passes.push((current as Fake).pid);
      },
    });
    // A person lifts helper_unavailable: resume.
    await reconnector.resume();
    const second = current as Fake;
    expect(second.pid).not.toBe(first.pid);
    expect(second.requests).toContain("hello");
    expect(transport.status().state).toBe("ok");
    expect(passes).toEqual([second.pid]);
    await supervisor.stop();
  });

  it("a failed reconnect is journaled and does not block the next", async () => {
    const { helperReconnector } = await import("../src/run/machine.js");
    let fail = true;
    const errors: string[] = [];
    const r = helperReconnector({
      supervisor: { resume: async () => {} },
      reopen: async () => {
        if (fail) throw new Error("helper not ready");
      },
      journal: { append: (_l: string, key: string) => errors.push(key) } as never,
    });
    await r.resume();
    expect(errors).toEqual(["helper.reconnect_failed"]);
    fail = false;
    await r.restarted();
    expect(errors).toEqual(["helper.reconnect_failed"]);
  });
});
