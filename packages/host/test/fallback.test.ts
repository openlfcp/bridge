// The SDK gap fallbacks (until the sdk-ts release with 504): G3, the
// installation of a state directory; G1, the sections of the pairing journal.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationJournal } from "@openlfcp/client";
import { generateResourceId, toHex } from "@openlfcp/core";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNodeInstallation, pairedSections } from "../src/index.js";
import { installation, memory, ownedSection } from "./support/lfcp.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lfcp-bridge-fallback-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("fallback G3: openNodeInstallation", () => {
  it("opens the layout of lfcp-node pair, creating it once; the same Principal on reopen", async () => {
    const a = await openNodeInstallation(join(dir, "i1"));
    const id = toHex(a.installation.signer.descriptor.principalId);
    expect(existsSync(join(dir, "i1", "lfcp.sqlite"))).toBe(true);
    expect(existsSync(join(dir, "i1", "installation.json"))).toBe(true);
    expect(a.flow.storage).toBe(a.storage);
    a.close();
    const b = await openNodeInstallation(join(dir, "i1"));
    expect(toHex(b.installation.signer.descriptor.principalId)).toBe(id);
    b.close();
  });
});

describe("fallback G1: pairedSections", () => {
  it("lists the candidates of the finished pairing request, and whether a chain of each is stored", async () => {
    const m = memory();
    expect(await pairedSections(m.storage)).toEqual([]);
    const held = await ownedSection(installation(), m.storage, m.secrets, "ws://127.0.0.1:9/v1/ws");
    const other = generateResourceId();
    const journal = new OperationJournal(m.storage);
    await journal.begin({
      id: "pairing-request.1",
      kind: "pairing-request",
      createdAt: 1,
      intent: {
        candidates: [
          {
            resource: toHex(held.R),
            url: "ws://127.0.0.1:9/v1/ws",
            profile: SECTIONS_PROFILE_ID,
            name: "Inbox",
          },
          {
            resource: toHex(other),
            url: "ws://127.0.0.1:9/v1/ws",
            profile: SECTIONS_PROFILE_ID,
            name: "Work",
          },
          { resource: 7 },
        ],
      },
    });
    // Not finished yet: nothing.
    expect(await pairedSections(m.storage)).toEqual([]);
    await journal.setStatus("pairing-request.1", "done");
    expect(
      (await pairedSections(m.storage)).map((p) => [p.name, toHex(p.resource), p.chainStored]),
    ).toEqual([
      ["Inbox", toHex(held.R), true],
      ["Work", toHex(other), false],
    ]);
  });
});
