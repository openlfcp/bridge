// The hang analysis G4, the race closed: a helper announces a write (`started`) and dies before
// the host read that line. The host must not call the write not_started from what it had read so
// far: once the helper is known to be gone, its stdout is read to the end (a marker after its last
// bytes in the FIFO), and a `started` still in the pipe counts — the write stays unknown (B19).
// The host's reading is paused by a test hook so the line is surely still in the pipe.

import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { MemoryKV } from "@openlfcp/bridge-reminders/transport";
import { afterEach, describe, expect, it } from "vitest";
import { fifoTestHooks, HelperProcess } from "../src/link.js";
import { EventKitTransport } from "../src/transport.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_OPEN = [process.execPath, path.join(here, "fixtures", "fake-open.mjs")];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  delete fifoTestHooks.onOutput;
  delete process.env.FAKE_HELPER_MODE;
});

/** A transport on a fake helper in `mode`; `pause()` stops the host reading its stdout. */
async function rig(mode: string) {
  process.env.FAKE_HELPER_MODE = mode;
  let out: Readable | undefined;
  fifoTestHooks.onOutput = (o) => {
    out = o;
  };
  const link = await HelperProcess.start({
    appPath: here,
    launcher: FAKE_OPEN,
    helperName: "node",
    shutdownTimeoutMs: 100,
    closeGraceMs: 100,
    killGraceMs: 100,
  });
  const t = new EventKitTransport({ appPath: here, link: async () => link });
  await t.open({
    installationKey: "x",
    state: new MemoryKV(),
    scope: { listTitlePrefixes: [], listIds: [] },
  });
  return { t, link, pause: () => out?.pause() };
}

const update = {
  kind: "update",
  opKey: "W",
  ref: { id: "r1" },
  set: { title: "x" },
  expect: { rev: "1" },
} as const;

/** recover, once the transport settled the dead helper's writes (in flight until then). */
async function settled(t: EventKitTransport, opKey: string) {
  for (let i = 0; i < 100; i++) {
    try {
      return await t.recover(opKey);
    } catch {
      await sleep(20);
    }
  }
  throw new Error("never settled");
}

describe("a write announced just before the helper died (the drain after a death)", () => {
  it("its `started` still unread in the pipe is read before deciding: unknown, not not_started", async () => {
    const { t, link, pause } = await rig("die-on:items.update");
    pause(); // the host reads nothing more until the drain
    await expect(t.apply(update as never)).rejects.toMatchObject({ name: "HelperLostError" });
    expect(await settled(t, "W")).toMatchObject({ state: "unknown" });
    expect(await link.gone()).toBe(true);
    await t.close();
  });

  it("a helper that died before announcing it: not_started, sent again under the same opKey", async () => {
    const { t, link, pause } = await rig("die-before:items.update");
    pause();
    await expect(t.apply(update as never)).rejects.toMatchObject({ name: "HelperLostError" });
    expect(await settled(t, "W")).toEqual({ state: "not_started" });
    expect(await link.gone()).toBe(true);
    await t.close();
  });
});
