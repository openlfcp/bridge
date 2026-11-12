// `lfcp-bridge quarantine` (D-010 §2.1, §5.4, §5.7, B19, B21) through `main`, on the harness's
// binding (a real section replica, the fake account, the real handler): an unknown outcome made by
// a lost answer, an ambiguous match made by a second reminder with the Task's link; the list, each
// resolution and what the next pass does after it; the count in `status`.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppleItem } from "@openlfcp/bridge-reminders";
import { receiptOf } from "@openlfcp/client";
import { setTitle, type Task } from "@openlfcp/shared-objects";
import { afterEach, describe, expect, it } from "vitest";
import { bridgePaths, loadConfig } from "../src/config.js";
import { EXIT, Holds, Journal, main } from "../src/index.js";
import type { Runtime } from "../src/runtime.js";
import { type Bridge, bridge } from "./support/bridge.js";

let b: Bridge;
let home: string | undefined;
afterEach(async () => {
  await b?.close();
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

function runtime(): () => Promise<Runtime> {
  home = mkdtempSync(join(tmpdir(), "lfcp-quarantine-"));
  const paths = bridgePaths({ LFCP_BRIDGE_HOME: home, LFCP_BRIDGE_LOGS: join(home, "logs") }, home);
  const rt: Runtime = {
    paths,
    db: b.db,
    config: loadConfig(paths.config),
    journal: new Journal(b.db),
    holds: new Holds(b.db),
    openTransport: async () => b.t as never,
    resolveSection: async () => undefined,
    launchctl: { load: () => {}, unload: () => {} } as never,
    node: "node",
    cli: "lfcp-bridge",
    openInstallations: async () => ({
      ports: [
        {
          id: "i",
          host: b.host,
          receipt: (r, op) => receiptOf(b.storage, r, op),
          access: { accessCheckedNow: () => true, offlineCommitAllowed: () => true },
          createdBy: b.root,
        },
      ],
      close: () => {},
    }),
    close: async () => {},
  };
  return async () => rt;
}

async function call(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    runtime: runtime(),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const reminders = () => b.reminders(b.list.id).filter((r) => !r.completed);
const intentState = (id: string) =>
  b.db.prepare("SELECT state, state_reason FROM intents WHERE id = ?").get(id) as {
    state: string;
    state_reason: string | null;
  };
const openConflicts = () =>
  (
    b.db.prepare("SELECT count(*) AS n FROM conflicts WHERE resolved_at IS NULL").get() as {
      n: number;
    }
  ).n;

/** "Buy milk" projected and linked; then its rename's answer is lost and the intent quarantined. */
async function unknownOutcome(): Promise<{ task: Task; intent: string }> {
  b = await bridge();
  const task = await b.task("Buy milk");
  await b.sync();
  b.t.faults.loseNextResponse = 1;
  await b.edit(setTitle(b.now(task.id), "Buy bread"));
  const s = await b.sync();
  expect(s.outcomes).toEqual([{ kind: "lost" }]);
  await b.e.settle("b");
  const intent = (s.prepared[0] as { id: string }).id;
  expect(intentState(intent)).toEqual({ state: "quarantined", state_reason: "unknown_outcome" });
  return { task, intent };
}

describe("quarantine: an unknown outcome (§5.7, B19)", () => {
  it("is listed with its Task, its reminder, since when and the commands; status counts it", async () => {
    const { intent } = await unknownOutcome();
    const r = await call("quarantine");
    expect(r.code).toBe(EXIT.OK);
    const [line, accept, redo] = r.out.split("\n");
    expect(line).toMatch(
      new RegExp(
        `^${intent}  b  unknown_outcome  task "Buy bread"  reminder \\S+ "Buy bread"  since \\d{4}-\\S+  \\(update of title\\)$`,
      ),
    );
    expect(accept).toBe(`    → lfcp-bridge quarantine accept ${intent}`);
    expect(redo).toBe(`    → lfcp-bridge quarantine redo ${intent}`);
    expect((await call("quarantine", "--binding", "other")).out).toBe("nothing in quarantine");
    expect((await call("status")).out).toMatch(
      /^b {2}active .*quarantine: 1 \(lfcp-bridge quarantine\)$/m,
    );
    expect((await call("status")).out).not.toContain("not in this build: quarantine");
  });

  it("accept, the write happened: finalized, conflicts resolved; the next pass writes nothing", async () => {
    const { task, intent } = await unknownOutcome();
    const r = await call("quarantine", "accept", intent);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain("accepted: title recorded as written");
    expect(intentState(intent).state).toBe("finalized");
    expect(openConflicts()).toBe(0);
    const next = await b.sync();
    expect(next.prepared).toEqual([]);
    expect(reminders().map((x) => x.title)).toEqual(["Buy bread"]);
    expect(b.now(task.id).title).toBe("Buy bread");
    expect((await call("quarantine")).out).toBe("nothing in quarantine");
    const j = new Journal(b.db).list().find((e) => e.key === "quarantine.resolved");
    expect(j?.text).toMatch(/the write happened, Reminders as it is \(title\)/);
    // Decided once: a second decision on it is refused.
    expect((await call("quarantine", "redo", intent)).code).toBe(EXIT.NEEDS_PERSON);
  });

  it("accept when Reminders does not show the write: Reminders as it is — its value goes to LFCP", async () => {
    const { task, intent } = await unknownOutcome();
    const r0 = reminders()[0] as AppleItem;
    b.person.edit(r0.ref, { title: "Buy milk" }); // as if the write never landed
    expect((await call("quarantine", "accept", intent)).code).toBe(EXIT.OK);
    await b.sync();
    expect(b.now(task.id).title).toBe("Buy milk");
    expect(reminders().map((x) => x.title)).toEqual(["Buy milk"]);
  });

  it("redo when Reminders does not show the write: written again from LFCP under a new opKey", async () => {
    const { task, intent } = await unknownOutcome();
    const r0 = reminders()[0] as AppleItem;
    b.person.edit(r0.ref, { title: "Buy milk" }); // as if the write never landed
    const r = await call("quarantine", "redo", intent);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain("redo: the next pass plans title again from LFCP");
    expect(intentState(intent).state).toBe("quarantined"); // terminal; its decision is recorded
    expect(openConflicts()).toBe(0);
    const next = await b.sync();
    expect(next.prepared).toHaveLength(1);
    expect((next.prepared[0] as { id: string }).id).not.toBe(intent);
    expect(reminders().map((x) => x.title)).toEqual(["Buy bread"]);
    expect(b.now(task.id).title).toBe("Buy bread");
    expect((await call("quarantine")).out).toBe("nothing in quarantine");
  });

  it("redo when the write happened: one reminder, the title once, nothing duplicated", async () => {
    const { intent } = await unknownOutcome();
    expect((await call("quarantine", "redo", intent)).code).toBe(EXIT.OK);
    await b.sync();
    await b.sync();
    expect(reminders().map((x) => x.title)).toEqual(["Buy bread"]);
  });

  it("refuses an unknown id, a non-quarantined intent, and a usage error", async () => {
    await unknownOutcome();
    expect((await call("quarantine", "accept", "nope")).code).toBe(EXIT.NOT_FOUND);
    const finalized = b.db
      .prepare("SELECT id FROM intents WHERE state = 'finalized' LIMIT 1")
      .get() as {
      id: string;
    };
    expect((await call("quarantine", "accept", finalized.id)).err).toContain(
      "not an unknown outcome",
    );
    expect((await call("quarantine", "accept")).code).toBe(EXIT.USAGE);
    expect((await call("quarantine", "frobnicate")).code).toBe(EXIT.USAGE);
  });
});

/** "Buy milk" linked; then a second open reminder carries its link URL: an ambiguous match. */
async function ambiguous(): Promise<{ task: Task; original: string; copy: string }> {
  b = await bridge();
  const task = await b.task("Buy milk");
  await b.sync();
  const original = reminders()[0] as { ref: { id: string }; linkUrl?: string };
  const copy = b.person.create(b.list.id, "Buy milk (copy)", { url: original.linkUrl as string });
  await b.sync();
  expect(b.link(task.id)?.state).toBe("quarantine");
  return { task, original: original.ref.id, copy: copy.ref.id };
}

describe("quarantine: an ambiguous match (§5.4)", () => {
  it("is listed with its candidates and a link / ignore command each", async () => {
    const { task, original, copy } = await ambiguous();
    const r = await call("quarantine");
    expect(r.out).toMatch(new RegExp(`^${task.id}  b  ambiguous_match  task "Buy milk"`, "m"));
    for (const id of [original, copy]) {
      expect(r.out).toContain(`lfcp-bridge quarantine link ${id} ${task.id}`);
      expect(r.out).toContain(`lfcp-bridge quarantine ignore ${id} ${task.id}`);
    }
    expect((await call("status")).out).toContain("quarantine: 1");
  });

  it("link: that reminder is the Task's, the other is ignored; the next pass keeps it linked", async () => {
    const { task, original, copy } = await ambiguous();
    const r = await call("quarantine", "link", original, task.id);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain("1 other(s) ignored");
    await b.sync();
    expect(b.link(task.id)?.state).toBe("linked");
    await b.edit(setTitle(b.now(task.id), "Buy oat milk"));
    await b.sync();
    const titles = Object.fromEntries(reminders().map((x) => [x.ref.id, x.title]));
    expect(titles).toEqual({ [original]: "Buy oat milk", [copy]: "Buy milk (copy)" });
    expect((await call("quarantine")).out).toBe("nothing in quarantine");
  });

  it("ignore: that reminder is not the Task's; the next pass matches the other one", async () => {
    const { task, original, copy } = await ambiguous();
    expect((await call("quarantine", "ignore", copy, task.id)).code).toBe(EXIT.OK);
    await b.sync();
    expect(b.link(task.id)?.state).toBe("linked");
    expect(b.linkOf(original)?.task_id).toBe(task.id);
  });

  it("refuses a reminder that is not a candidate, and a Task not in quarantine", async () => {
    const { task } = await ambiguous();
    const r = await call("quarantine", "link", "not-a-candidate", task.id);
    expect([r.code, r.err]).toEqual([
      EXIT.NEEDS_PERSON,
      expect.stringContaining("not a candidate"),
    ]);
    expect((await call("quarantine", "ignore", "x", "no-such-task")).code).toBe(EXIT.NOT_FOUND);
  });
});

describe("quarantine: the hold import_ambiguous (§6.2)", () => {
  it("is listed with the command that accepts it", async () => {
    b = await bridge();
    new Holds(b.db).set("b", "import_ambiguous");
    const r = await call("quarantine");
    expect(r.out).toMatch(
      /^b {2}b {2}import_ambiguous {2}since \S+ {2}\(pending imports: none\)$/m,
    );
    expect(r.out).toContain("    → lfcp-bridge resume --accept import_ambiguous --binding b");
  });
});
