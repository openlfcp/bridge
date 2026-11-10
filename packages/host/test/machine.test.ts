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
