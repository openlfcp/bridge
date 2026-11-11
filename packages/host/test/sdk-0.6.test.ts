// What the bridge takes from sdk-ts 0.6.0 instead of its own fallbacks, and does not turn off:
// the installation of a state directory as the SDK opens it (its identity sessions kept alive
// and its 429 probe: no options passed), the Resource rows of an older pairing
// (storePairedResources), and the HTTP 429 of a refused WebSocket upgrade in the sync connection.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SyncEvent } from "@openlfcp/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openBridgeDatabase, SectionHost } from "../src/index.js";
import { installationPorts } from "../src/run/machine.js";
import { installation, memory } from "./support/lfcp.js";

const calls = vi.hoisted(() => ({ open: [] as unknown[][], stored: 0 }));
vi.mock("@openlfcp/storage-node", async (original) => {
  const m = await original<typeof import("@openlfcp/storage-node")>();
  return {
    ...m,
    openNodeInstallation: (...args: Parameters<typeof m.openNodeInstallation>) => {
      calls.open.push(args);
      return m.openNodeInstallation(...args);
    },
  };
});
vi.mock("@openlfcp/client", async (original) => {
  const m = await original<typeof import("@openlfcp/client")>();
  return {
    ...m,
    storePairedResources: async (o: Parameters<typeof m.storePairedResources>[0]) => {
      calls.stored++;
      return m.storePairedResources(o);
    },
  };
});

let dir: string;
let server: Server | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lfcp-bridge-sdk06-"));
  calls.open.length = 0;
  calls.stored = 0;
});
afterEach(async () => {
  await new Promise((r) => (server === undefined ? r(undefined) : server.close(r)));
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("the run process's installations", () => {
  it("are opened by the SDK with its defaults (keep-alive, 429 probe) and their rows stored", async () => {
    const db = openBridgeDatabase(join(dir, "bridge.sqlite"));
    const state = join(dir, "i1");
    db.prepare(
      "INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES ('i1', ?, '', '', 'Mac', ?)",
    ).run(state, new Date().toISOString());
    const opened = await installationPorts(db);
    // Not paired: no sections, no ports; the state directory is the SDK's layout.
    expect(opened.ports).toEqual([]);
    expect(existsSync(join(state, "lfcp.sqlite"))).toBe(true);
    expect(calls.open).toEqual([[state]]);
    expect(calls.stored).toBe(1);
    opened.close();
    db.close();
  });
});

describe("the sync connection", () => {
  it("learns an upgrade refused with HTTP 429 and its Retry-After (the SDK's probe, on by default)", {
    timeout: 15_000,
  }, async () => {
    const refuse =
      "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 7\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    server = createServer((_req, res) => {
      res.writeHead(429, { "Retry-After": "7", Connection: "close" }).end();
    });
    server.on("upgrade", (_req, socket) => socket.end(refuse));
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const m = memory();
    const host = new SectionHost({
      url: `ws://127.0.0.1:${port}/v1/ws`,
      installation: installation(),
      ...m,
      reconnect: () => 60_000,
    });
    const events: SyncEvent[] = [];
    host.onSyncEvent((e) => events.push(e));
    host.start();
    try {
      await vi.waitFor(
        () => {
          const e = events.find((x) => x.type === "connection" && x.rateLimited !== undefined);
          expect(e).toMatchObject({ rateLimited: { status: 429, retryAfterMs: 7000 } });
        },
        { timeout: 10_000, interval: 50 },
      );
    } finally {
      await host.stop();
    }
  });
});
