// L3 (T§2): the bridge of ./bridge.ts on the real EventKit store — the helper app launched the way
// the bridge launches it (open + FIFOs, its own responsible process), backend eventkit, its write
// gate in verification mode: it writes only to "LFCP Verify · " lists. The binding's list is a new
// one of these; the person (scripts/l3/person) completes, reopens and deletes reminders in it as
// someone in Reminders would. Both apps need Reminders access: scripts/l3/tcc-grant.sh on a CI
// runner, a person's "Allow" on a Mac.
//
// Set by the L3 job (.github/workflows/l3.yml): L3_HELPER_APP and L3_PERSON_APP (the two apps),
// REQUIRE_L3=1 (a missing setup fails instead of skipping: an L3 id is never skipped, T§4).

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AppleItem } from "@openlfcp/bridge-reminders";
import { MemoryKV } from "@openlfcp/bridge-reminders/transport";
import { EventKitTransport } from "@openlfcp/bridge-transport-eventkit";
import type { BridgeRig } from "./bridge.js";

const run = promisify(execFile);
const PREFIX = "LFCP Verify · ";
const HELPER = process.env.L3_HELPER_APP;
const PERSON = process.env.L3_PERSON_APP;

/** Why the L3 tests do not run here (undefined: they do). With REQUIRE_L3=1 a reason is an error. */
export function l3Skip(): string | undefined {
  const why =
    process.platform !== "darwin"
      ? "not macOS"
      : HELPER === undefined || PERSON === undefined
        ? "L3_HELPER_APP and L3_PERSON_APP are not set"
        : undefined;
  if (why !== undefined && process.env.REQUIRE_L3 === "1") throw new Error(`L3 required: ${why}`);
  return why;
}

/** One command of the person app, through LaunchServices; its JSON answer. */
async function person(...args: string[]): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "lfcp-l3-person-"));
  try {
    const out = join(dir, "out.json");
    const err = join(dir, "err.txt");
    await run(
      "open",
      [
        "-n",
        "-W",
        "-g",
        "-a",
        PERSON as string,
        "--stdout",
        out,
        "--stderr",
        err,
        "--args",
        ...args,
      ],
      { timeout: 60_000 },
    );
    const line = readFileSync(out, "utf8").trim().split("\n").pop() ?? "";
    const r = (line === "" ? {} : JSON.parse(line)) as Record<string, unknown>;
    if (r.ok !== true)
      throw new Error(`person ${args.join(" ")}: ${line || readFileSync(err, "utf8")}`);
    return r;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface EventKitRig extends BridgeRig {
  /** Someone in Reminders, on a reminder of the list (by its id). */
  readonly person: {
    complete(id: string): Promise<void>;
    reopen(id: string): Promise<void>;
    delete(id: string): Promise<void>;
  };
  /** The list's reminders, as the helper reads them now. */
  items(): Promise<readonly AppleItem[]>;
  /** Waits until the helper reads what `ok` expects (another process's save reaches it a little later). */
  until(ok: (items: readonly AppleItem[]) => boolean, what: string): Promise<readonly AppleItem[]>;
}

/** A new "LFCP Verify · <title> <time>" list and the transport to it, open. */
export async function eventKitRig(title: string): Promise<EventKitRig> {
  const transport = new EventKitTransport({
    appPath: HELPER as string,
    launch: "open",
    backend: "eventkit",
    writes: "verification",
  });
  const status = await transport.open({
    installationKey: "l3",
    state: new MemoryKV(),
    scope: { listTitlePrefixes: [PREFIX], listIds: [] },
  });
  if (status.state !== "ok") {
    await transport.close();
    throw new Error(`EventKit transport: ${JSON.stringify(status)}`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const list = await transport.createList({
    opKey: randomUUID(),
    title: `${PREFIX}${title} ${stamp}`,
  });
  transport.setWriteScope({ listTitlePrefixes: [PREFIX], listIds: [list.id] });
  const items = async () => (await transport.snapshot(list.id)).items;
  return {
    id: transport.id,
    transport,
    list,
    person: {
      complete: async (id) => void (await person("complete", id)),
      reopen: async (id) => void (await person("reopen", id)),
      delete: async (id) => void (await person("delete", id)),
    },
    items,
    async until(ok, what) {
      const end = Date.now() + 30_000;
      for (;;) {
        const now = await items();
        if (ok(now)) return now;
        if (Date.now() > end) throw new Error(`EventKit did not show ${what} in 30 s`);
        await new Promise((r) => setTimeout(r, 500));
      }
    },
    async close() {
      try {
        await person("delete-list", list.id);
      } finally {
        await transport.close();
      }
    },
  };
}
