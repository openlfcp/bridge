/**
 * The shared transport contract (D-010 §10.2) against the real Swift helper with its memory
 * backend: the whole protocol path without EventKit or TCC. macOS only; needs a built app
 * (helper/scripts/build-app.sh), or HELPER_APP pointing at one. Elsewhere the file is skipped.
 */
import fs from "node:fs";
import path from "node:path";
import {
  type ContractPerson,
  type ContractRig,
  transportContract,
} from "@openlfcp/bridge-reminders/test-support";
import { type Alarm, type ItemRef, MemoryKV } from "@openlfcp/bridge-reminders/transport";
import { afterAll, describe, expect, it } from "vitest";
import { type HelperLink, HelperLostError, HelperProcess } from "../src/link.js";
import { EventKitTransport } from "../src/transport.js";
import { mapItem, mapList } from "../src/wire.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const APP =
  process.env.HELPER_APP ?? path.resolve(here, "../../../helper/build/LFCP Reminders Helper.app");
const available =
  process.platform === "darwin" &&
  fs.existsSync(path.join(APP, "Contents/MacOS/lfcp-reminders-helper"));

const started: HelperLink[] = [];
afterAll(async () => {
  await Promise.all(started.map((l) => l.close()));
});

/** Drops the answer of the next write after the helper applied it (a lost response). */
function lossy(link: HelperLink): { link: HelperLink; loseNext: () => void } {
  let lose = false;
  return {
    loseNext: () => {
      lose = true;
    },
    link: {
      get ready() {
        return link.ready;
      },
      async request(op, body, opts) {
        const r = await link.request(op, body, opts);
        if (lose && op !== "hello" && !op.startsWith("debug.")) {
          lose = false;
          throw new HelperLostError(`${op}: answer dropped by the test`);
        }
        return r;
      },
      onEvent: (cb) => link.onEvent(cb),
      onExit: (cb) => link.onExit(cb),
      close: () => link.close(),
    },
  };
}

function userEdit(ref: ItemRef, e: Parameters<ContractPerson["edit"]>[1]): Record<string, unknown> {
  const b: Record<string, unknown> = { ref };
  if (e.title !== undefined) b.title = e.title;
  if (e.dueDate !== undefined) b.dueDate = e.dueDate;
  if (e.dueTime !== undefined) b.dueTime = e.dueTime;
  if (e.tz !== undefined) b.tz = e.tz;
  if (e.notes !== undefined) b.notes = e.notes;
  if (e.recurrence !== undefined) b.recurrence = e.recurrence;
  if (e.url !== undefined) b.url = e.url;
  if (e.moveTo !== undefined) b.moveToList = e.moveTo;
  const a: Alarm | undefined = e.addAlarm;
  if (a?.kind === "absolute") b.addAlarmAt = a.at;
  if (a?.kind === "relative") b.addRelativeAlarmSec = a.relativeSec;
  if (a?.kind === "location") b.addLocationAlarm = true;
  return b;
}

/**
 * The contract suite is typed with the reminders sources, the transport with its built .d.ts; the
 * branded ListRef/LocalDate (unique symbols) differ between the two declarations although the
 * shapes are the same. Cross that boundary once, here.
 */
const asContract = <T>(x: unknown): T => x as T;

async function makeRig(): Promise<ContractRig> {
  const link = await HelperProcess.start({ appPath: APP, launch: "direct", backend: "memory" });
  started.push(link);
  const l = lossy(link);
  const debug = async (op: string, body: Record<string, unknown>) => {
    const r = await link.request(op, body);
    if (!r.ok) throw new Error(`${op}: ${r.error.code} ${r.error.message}`);
    return r.debug as Record<string, Record<string, unknown>>;
  };
  const person: ContractPerson = {
    createList: async (title, o) =>
      asContract(
        mapList(
          (await debug("debug.addList", { title, readOnly: o?.readOnly ?? false })).list ?? {},
        ),
      ),
    create: async (list, title, o) =>
      asContract(
        mapItem(
          (
            await debug("debug.userCreate", {
              list,
              title,
              ...(o?.url === undefined ? {} : { url: o.url }),
            })
          ).item ?? {},
        ),
      ),
    edit: async (ref, e) =>
      asContract(mapItem((await debug("debug.userEdit", userEdit(ref, e))).item ?? {})),
  };
  return {
    transport: asContract(
      new EventKitTransport({
        appPath: APP,
        backend: "memory",
        writes: "verified",
        link: async () => l.link,
      }),
    ),
    kv: new MemoryKV(),
    person,
    loseNextResponse: l.loseNext,
    // No beforeSave (no hook inside the helper between check and save) and no restart (the
    // memory store lives in the helper process): those contract tests report as skipped.
  };
}

if (available) {
  transportContract("EventKit transport → helper (memory backend, direct launch)", makeRig);

  describe("EventKit transport → helper app launched through open + FIFOs", () => {
    it("is its own responsible process and serves the protocol", async () => {
      const link = await HelperProcess.start({ appPath: APP, launch: "open", backend: "memory" });
      started.push(link);
      expect(link.ready.parentPath).toBe("/sbin/launchd");
      expect(link.ready.bundleId).toBe("org.openlfcp.bridge.reminders");
      const t = new EventKitTransport({
        appPath: APP,
        backend: "memory",
        writes: "verified",
        link: async () => link,
      });
      const kv = new MemoryKV();
      expect(
        await t.open({
          installationKey: "i",
          state: kv,
          scope: { listTitlePrefixes: ["LFCP · "], listIds: [] },
        }),
      ).toEqual({ state: "ok" });
      const list = await t.createList({ opKey: "open-l", title: "LFCP · Open" });
      const r = await t.apply({
        opKey: "open-c",
        kind: "create",
        list: list.id,
        linkUrl: "lfcp://task/OPEN",
        set: { title: "via open" },
      });
      expect(r).toMatchObject({
        ok: true,
        written: { title: "via open", linkUrl: "lfcp://task/OPEN" },
      });
      expect((await t.snapshot(list.id)).items.map((i) => i.title)).toEqual(["via open"]);
      await t.close();
    }, 30_000);
  });
} else if (process.env.REQUIRE_HELPER === "1") {
  // The helper-protocol CI job must run these tests, not skip them.
  describe("helper contract", () => {
    it("requires a built helper app (REQUIRE_HELPER=1)", () => {
      expect.fail(`no helper app at ${APP} on ${process.platform}`);
    });
  });
} else {
  describe.skip(`helper contract (needs macOS and a built app at ${APP})`, () => {
    it("skipped", () => {});
  });
}
