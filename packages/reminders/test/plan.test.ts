// Matching (D-010 §5.4, R2-9) and the pass's plan (§5.5, §6.1–6.3).

import { describe, expect, it } from "vitest";
import {
  type Field,
  type FieldBase,
  type LfcpTask,
  type LinkRow,
  type MatchContext,
  match,
  type PassView,
  plan,
  projectApple,
  projectLfcp,
  taskLink,
} from "../src/adapter/index.js";
import type { AppleItem, ListRef } from "../src/index.js";
import { localDate } from "../src/index.js";

const S = "aa".repeat(32);
const BRIDGE = "b1b2b3b4c5c6c7c8d9";
const ME = "lfcp:principal:me";
const LIST = "L" as ListRef;
let n = 0;

const task = (id: string, over: Partial<LfcpTask> = {}): LfcpTask => ({
  id,
  lifecycle: "active",
  title: `Task ${id}`,
  status: "todo",
  priority: "normal",
  assignees: { [ME]: true },
  ...over,
});
const item = (over: Partial<AppleItem> = {}): AppleItem => {
  n++;
  return {
    ref: { id: `r${n}`, externalId: `e${n}` },
    list: LIST,
    title: `Reminder ${n}`,
    completed: false,
    priority: 0,
    alarms: [],
    hasNotes: false,
    hasRecurrence: false,
    rev: "1",
    ...over,
  };
};
/** A reminder projecting `t`, with our link. */
const projection = (t: LfcpTask, over: Partial<AppleItem> = {}) =>
  item({ title: t.title, linkUrl: taskLink(t.id, S, BRIDGE), ...over });
const link = (taskId: string, over: Partial<LinkRow> = {}): LinkRow => ({
  taskId,
  state: "linked",
  origin: "lfcp",
  urlState: "ours",
  statusLocked: false,
  ignoredExternalIds: [],
  ...over,
});
/** Bases equal to both sides' projections now (a pair in sync). */
function synced(t: LfcpTask, i: AppleItem): Map<Field, FieldBase> {
  const pL = projectLfcp(t);
  const pA = projectApple(i, "UTC");
  return new Map(
    (["title", "due", "priority", "status"] as const).map((f) => [
      f,
      {
        lfcpProj: pL[f],
        appleProj: pA[f],
        ...(f === "status" || f === "priority" ? { lfcpShadow: t[f] } : {}),
      },
    ]),
  );
}

function view(over: Partial<PassView> = {}): PassView {
  return {
    binding: {
      id: "b",
      installationId: "i",
      section: S,
      list: LIST,
      filter: "default",
      bridgeInstanceId: BRIDGE,
    },
    me: ME,
    tasks: [],
    lfcpLive: true,
    snapshot: { items: [], complete: true },
    links: [],
    bases: new Map(),
    openIntent: () => false,
    heldFields: () => [],
    capabilities: { recurringCompletion: "unknown" },
    timeZone: "UTC",
    ...over,
  };
}

const ctx = (over: Partial<MatchContext> = {}): MatchContext => ({
  section: S,
  bridge8: BRIDGE.slice(0, 8),
  recurringCompletion: "unknown",
  task: () => ({ inSection: true, inFilter: true }),
  ...over,
});

describe("matching §5.4", () => {
  it("markers are left out; a link finds its reminder by URL, externalId or cached id", () => {
    const marker = item({ linkUrl: `lfcp://bridge/${BRIDGE}?r=${S}`, completed: true });
    const byUrl = projection(task("T1"));
    const byExt = item({ ref: { id: "new-id", externalId: "x2" } });
    const byId = item({ ref: { id: "cached" } });
    const m = match(
      [link("T1"), link("T2", { remExternalId: "x2" }), link("T3", { remIdCache: "cached" })],
      [marker, byUrl, byExt, byId],
      ctx(),
    );
    expect(m.links.get("T1")).toMatchObject({ kind: "matched", item: byUrl, restoreUrl: false });
    expect(m.links.get("T2")).toMatchObject({ kind: "matched", item: byExt, restoreUrl: true });
    expect(m.links.get("T3")).toMatchObject({ kind: "matched", item: byId });
    expect(m.items).toEqual([]);
  });

  it("R2-9 (1): an unlinked link is a tombstone — its reminder is taken, not imported", () => {
    const r = item({ ref: { id: "r-gone", externalId: "x-gone" } });
    const m = match([link("T1", { state: "unlinked", remExternalId: "x-gone" })], [r], ctx());
    expect(m.links.get("T1")).toEqual({ kind: "tombstone", item: r });
    expect(m.items).toEqual([]);
  });

  it("R2-9 (2): a new reminder with a person's https URL is imported as user_replaced; a linked one with it too", () => {
    const fresh = item({ linkUrl: "https://example.com/x" });
    const linked = item({ ref: { id: "r9", externalId: "x9" }, linkUrl: "https://example.com/y" });
    const m = match([link("T9", { remExternalId: "x9" })], [fresh, linked], ctx());
    expect(m.items).toEqual([{ kind: "import", item: fresh, userReplaced: true }]);
    expect(m.links.get("T9")).toMatchObject({
      kind: "matched",
      userReplaced: true,
      restoreUrl: false,
    });
  });

  it("R2-9 (4): a pending_lfcp_create whose keys found nothing → hold import_ambiguous, no import", () => {
    const fresh = item();
    const m = match(
      [link("T5", { state: "pending_lfcp_create", remExternalId: "gone", remIdCache: "gone" })],
      [fresh],
      ctx(),
    );
    expect(m.holds).toEqual(["import_ambiguous"]);
    expect(m.items).toEqual([{ kind: "import_blocked", item: fresh }]);
  });

  it("more than one candidate: quarantine; with recurringCompletion = copy, the open one holds the link", () => {
    const t = task("T1");
    const open = projection(t);
    const copy = projection(t, { completed: true });
    expect(match([link("T1")], [open, copy], ctx()).links.get("T1")).toMatchObject({
      kind: "ambiguous",
      reason: "ambiguous_match",
    });
    expect(
      match([link("T1")], [open, copy], ctx({ recurringCompletion: "copy" })).links.get("T1"),
    ).toMatchObject({ kind: "matched", item: open, ignore: [copy.ref.externalId] });
    // Once ignored, the copy is out of matching.
    const ignored = match(
      [link("T1", { ignoredExternalIds: [copy.ref.externalId as string] })],
      [open, copy],
      ctx(),
    );
    expect(ignored.links.get("T1")).toMatchObject({ kind: "matched", item: open });
  });

  it("one reminder claimed by two links: both quarantined", () => {
    const r = item({ ref: { id: "shared", externalId: "xs" } });
    const m = match(
      [link("T1", { remExternalId: "xs" }), link("T2", { remIdCache: "shared" })],
      [r],
      ctx(),
    );
    expect(m.links.get("T1")).toMatchObject({ kind: "ambiguous", reason: "shared_item" });
    expect(m.links.get("T2")).toMatchObject({ kind: "ambiguous", reason: "shared_item" });
  });

  it("pass 2: an orphan of ours is linked if its Task is in the section and filter; another bridge's → foreign_bridge", () => {
    const ours = projection(task("T7"));
    const outside = projection(task("T8"));
    const foreign = item({ linkUrl: taskLink("T9", S, "ffffffff00") });
    const done = item({ completed: true });
    const m = match(
      [],
      [ours, outside, foreign, done],
      ctx({
        task: (id) => ({ inSection: id !== "T8", inFilter: true }),
      }),
    );
    expect(m.items).toEqual([
      { kind: "orphan_link", item: ours, taskId: "T7", ignore: [] },
      { kind: "orphan_quarantine", item: outside, taskId: "T8", reason: "not_in_section" },
      { kind: "foreign_bridge", item: foreign },
      { kind: "ignore", item: done, reason: "completed" },
    ]);
    expect(m.holds).toEqual(["foreign_bridge"]);
  });
});

describe("the plan of a pass §5.5", () => {
  it("a projectable Task without a link: a create in the binding's list with our link; done ones and others' are not", () => {
    const p = plan(
      view({
        tasks: [
          task("T1", { due: "2026-11-12", priority: "high" }),
          task("T2", { status: "done" }),
          task("T3", { assignees: { other: true } }),
        ],
      }),
    );
    expect(p.intents).toHaveLength(1);
    expect(p.intents[0]).toMatchObject({
      taskId: "T1",
      direction: "to_apple",
      kind: "create",
      fields: ["title", "priority", "due"],
      payload: {
        kind: "create",
        list: LIST,
        linkUrl: taskLink("T1", S, BRIDGE),
        set: { title: "Task T1", priority: 1, dueDate: "2026-11-12" },
      },
    });
    expect(p.counts).toMatchObject({ tasks: 3, inFilter: 2, creates: 1 });
  });

  it("no new projection while one is pending, or when an orphan reminder of it exists (it is linked instead)", () => {
    const t = task("T1");
    expect(plan(view({ tasks: [t], openIntent: () => true })).intents).toEqual([]);
    const orphan = projection(t);
    const p = plan(view({ tasks: [t], snapshot: { items: [orphan], complete: true } }));
    expect(p.intents).toEqual([]);
    expect(p.transitions).toEqual([{ taskId: "T1", kind: "link_orphan", item: orphan.ref }]);
  });

  it("dL only → to_apple update with the base revision; dA only → to_lfcp (B13 priority with the shadow); both → LFCP wins, Apple's value lost", () => {
    const before = task("T1", { title: "Old", priority: "normal" });
    const r = projection(before, { rev: "7" });
    const bases = new Map([["T1", synced(before, r)]]);
    const p = plan(
      view({
        tasks: [{ ...before, title: "New" }],
        snapshot: { items: [{ ...r, priority: 1 }], complete: true },
        links: [link("T1")],
        bases,
      }),
    );
    expect(p.intents).toEqual([
      expect.objectContaining({
        direction: "to_apple",
        kind: "update",
        fields: ["title"],
        payload: { kind: "update", ref: r.ref, set: { title: "New" }, expect: { rev: "7" } },
        basis: expect.objectContaining({ rev: "7", pL: { title: "New" }, pA: { title: "Old" } }),
      }),
      expect.objectContaining({
        direction: "to_lfcp",
        kind: "update_task",
        fields: ["priority"],
        payload: {
          resource: S,
          intents: [{ intent: "task.set_priority", id: "T1", priority: "high" }],
        },
        basis: expect.objectContaining({ pL: { priority: "none" }, pA: { priority: "high" } }),
      }),
    ]);
    expect(p.decisions.map((d) => [d.field, d.decision])).toEqual([
      ["title", "write_apple"],
      ["priority", "write_lfcp"],
    ]);
    const both = plan(
      view({
        tasks: [{ ...before, title: "LFCP title" }],
        snapshot: { items: [{ ...r, title: "Apple title" }], complete: true },
        links: [link("T1")],
        bases,
      }),
    );
    expect(both.decisions).toEqual([
      expect.objectContaining({ field: "title", decision: "write_apple", appleValueLost: true }),
    ]);
    expect(both.intents[0]?.payload).toMatchObject({ set: { title: "LFCP title" } });
  });

  it("status: LFCP closed with Apple unchanged → completed; both closed with different dates → LFCP's date (row 11)", () => {
    const before = task("T1");
    const r = projection(before);
    const bases = new Map([["T1", synced(before, r)]]);
    const done = { ...before, status: "done", completion_date: "2026-11-09" };
    const p = plan(
      view({ tasks: [done], snapshot: { items: [r], complete: true }, links: [link("T1")], bases }),
    );
    expect(p.intents[0]?.payload).toMatchObject({
      set: { completed: { value: true, date: "2026-11-09" } },
    });
    const both = plan(
      view({
        tasks: [{ ...before, status: "cancelled" }],
        snapshot: {
          items: [
            { ...r, completed: true, completionDate: "2026-11-08T10:00:00Z", title: r.title },
          ],
          complete: true,
        },
        links: [link("T1")],
        bases,
      }),
    );
    // closed on both sides, one date "—": equivalent → bases only, no write.
    expect(both.decisions).toEqual([
      expect.objectContaining({ field: "status", decision: "bases" }),
    ]);
    const reopened = plan(
      view({
        tasks: [{ ...before, title: "x", status: "done", completion_date: "2026-11-09" }],
        snapshot: {
          items: [{ ...r, completed: true, completionDate: "2026-11-08T10:00:00Z" }],
          complete: true,
        },
        links: [link("T1")],
        bases,
      }),
    );
    expect(reopened.decisions.find((d) => d.field === "status")).toMatchObject({
      decision: "write_apple",
      row: "11",
      appleValueLost: true,
    });
  });

  it("a status shadow change (done → cancelled) is recorded, nothing written", () => {
    const before = task("T1", { status: "done" });
    const r = projection(before, { completed: true });
    const p = plan(
      view({
        tasks: [{ ...before, status: "cancelled" }],
        snapshot: { items: [r], complete: true },
        links: [link("T1")],
        bases: new Map([["T1", synced(before, r)]]),
      }),
    );
    expect(p.intents).toEqual([]);
    expect(p.decisions).toEqual([expect.objectContaining({ field: "status", decision: "shadow" })]);
  });

  it("a first link (no bases): equivalent fields record bases, the rest LFCP wins, status by the table (done wins)", () => {
    const t = task("T1", { title: "Same", priority: "high", status: "done" });
    const r = projection(t, { priority: 9, completed: false });
    const p = plan(
      view({ tasks: [t], snapshot: { items: [r], complete: true }, links: [link("T1")] }),
    );
    expect(p.decisions.map((d) => [d.field, d.decision])).toEqual([
      ["title", "bases"],
      ["due", "bases"],
      ["priority", "write_apple"],
      ["status", "write_apple"],
    ]);
    expect(p.intents[0]?.payload).toMatchObject({
      set: { priority: 1, completed: { value: true } },
    });
  });

  it("held fields (an open conflict, unknown_outcome too), status_locked, a pending intent and due_cleared_in_lfcp write nothing", () => {
    const before = task("T1", { due: "2026-11-12" });
    const r = projection(before, {
      due: { date: localDate("2026-11-12"), time: "09:00" as never },
    });
    const after = { ...before, title: "New", due: null, status: "done" };
    const bases = new Map([["T1", synced(before, r)]]);
    const base = { tasks: [after], snapshot: { items: [r], complete: true }, bases };
    const held = plan(view({ ...base, links: [link("T1")], heldFields: () => ["title"] }));
    expect(held.decisions.map((d) => [d.field, d.decision])).toEqual([
      ["title", "held"],
      ["due", "conflict"],
      ["status", "write_apple"],
    ]);
    expect(held.conflicts).toEqual([{ taskId: "T1", field: "due", kind: "due_cleared_in_lfcp" }]);
    const locked = plan(view({ ...base, links: [link("T1", { statusLocked: true })] }));
    expect(locked.decisions.map((d) => [d.field, d.decision])).toEqual([
      ["title", "write_apple"],
      ["due", "status_locked"],
      ["status", "status_locked"],
    ]);
    const pending = plan(view({ ...base, links: [link("T1")], openIntent: () => true }));
    expect(pending.intents).toEqual([]);
    expect(pending.decisions.filter((d) => d.decision === "pending_intent")).toHaveLength(2);
  });

  it("LFCP absence only when live: deleted → task_gone, out of the filter → out_of_filter; origin apple is sticky", () => {
    const t = task("T1");
    const r = projection(t);
    const gone = { ...t, lifecycle: "deleted" as const };
    const reassigned = { ...t, assignees: { other: true as const } };
    const snap = { items: [r], complete: true };
    expect(plan(view({ tasks: [gone], snapshot: snap, links: [link("T1")] })).transitions).toEqual([
      { taskId: "T1", kind: "task_gone" },
    ]);
    const offline = plan(
      view({ tasks: [gone], snapshot: snap, links: [link("T1")], lfcpLive: false }),
    );
    expect(offline.transitions).toEqual([]);
    expect(offline.waiting).toEqual([{ taskId: "T1", waiting: "lfcp_not_live" }]);
    expect(
      plan(view({ tasks: [reassigned], snapshot: snap, links: [link("T1")] })).transitions,
    ).toEqual([{ taskId: "T1", kind: "out_of_filter" }]);
    expect(
      plan(view({ tasks: [reassigned], snapshot: snap, links: [link("T1", { origin: "apple" })] }))
        .transitions,
    ).toEqual([]);
    expect(plan(view({ tasks: [gone], snapshot: snap, links: [link("T1")] })).counts.unlinks).toBe(
      1,
    );
  });

  it("a Task the replica cannot read is not taken for deleted", () => {
    const r = projection(task("T1"));
    const p = plan(
      view({ unreadable: ["T1"], snapshot: { items: [r], complete: true }, links: [link("T1")] }),
    );
    expect(p.transitions).toEqual([]);
    expect(p.waiting).toEqual([{ taskId: "T1", waiting: "task_unreadable" }]);
  });

  it("Apple absence only on a complete snapshot; a return to the filter relinks its tombstone or searches globally", () => {
    const t = task("T1");
    expect(
      plan(view({ tasks: [t], links: [link("T1")], snapshot: { items: [], complete: true } }))
        .transitions,
    ).toEqual([{ taskId: "T1", kind: "apple_missing" }]);
    expect(
      plan(view({ tasks: [t], links: [link("T1")], snapshot: { items: [], complete: false } }))
        .waiting,
    ).toEqual([{ taskId: "T1", waiting: "apple_incomplete" }]);
    const r = projection(t);
    expect(
      plan(
        view({
          tasks: [t],
          links: [link("T1", { state: "out_of_filter" })],
          snapshot: { items: [r], complete: true },
        }),
      ).transitions,
    ).toEqual([{ taskId: "T1", kind: "relink", item: r.ref }]);
    expect(
      plan(
        view({
          tasks: [t],
          links: [link("T1", { state: "task_gone" })],
          snapshot: { items: [], complete: true },
        }),
      ).transitions,
    ).toEqual([{ taskId: "T1", kind: "return_find" }]);
    // Still out of the filter: nothing, and no new projection either.
    const away = plan(
      view({
        tasks: [{ ...t, assignees: { other: true } }],
        links: [link("T1", { state: "out_of_filter" })],
      }),
    );
    expect(away.transitions).toEqual([]);
    expect(away.intents).toEqual([]);
  });

  it("new reminders, restore_url and foreign ones are shown, not planned (PR 11); holds come from matching", () => {
    const t = task("T1");
    const { linkUrl: _, ...rest } = projection(t);
    const noUrl: AppleItem = { ...rest, ref: { id: "rz", externalId: "xz" } };
    const fresh = item({ title: "From Apple" });
    const p = plan(
      view({
        tasks: [t],
        links: [link("T1", { remExternalId: "xz" })],
        bases: new Map([["T1", synced(t, noUrl)]]),
        snapshot: { items: [noUrl, fresh], complete: true },
      }),
    );
    expect(p.intents).toEqual([]);
    expect(p.items.map((i) => i.kind)).toEqual(["restore_url", "import"]);
    expect(p.counts.imports).toBe(1);
  });
});

describe("review PR 8", () => {
  it("#8 an incomplete snapshot cannot prove a new projection is absent: no create, waiting", () => {
    const p = plan(view({ tasks: [task("T1")], snapshot: { items: [], complete: false } }));
    expect(p.intents).toHaveLength(0);
    expect(p.waiting).toContainEqual({ taskId: "T1", waiting: "apple_incomplete" });
    // Complete: the create is planned.
    expect(
      plan(view({ tasks: [task("T1")], snapshot: { items: [], complete: true } })).intents,
    ).toHaveLength(1);
  });

  it("#9 two orphan reminders of one Task (no link yet): neither is linked, both quarantined, no create", () => {
    const t = task("T1");
    const a = projection(t);
    const b2 = projection(t);
    const p = plan(view({ tasks: [t], snapshot: { items: [a, b2], complete: true } }));
    expect(p.transitions.filter((x) => x.kind === "link_orphan")).toHaveLength(0);
    expect(p.intents).toEqual([]);
    expect(
      p.items.filter((i) => i.kind === "orphan_quarantine").map((i) => [i.item.id, i.reason]),
    ).toEqual([
      [a.ref.id, "ambiguous_orphans"],
      [b2.ref.id, "ambiguous_orphans"],
    ]);
    // A recurring copy (recurringCompletion = copy): the open one is linked, the completed ignored.
    const done = projection(t, { completed: true });
    const copy = plan(
      view({
        tasks: [t],
        snapshot: { items: [a, done], complete: true },
        capabilities: { recurringCompletion: "copy" },
      }),
    );
    expect(copy.transitions).toEqual([
      { taskId: "T1", kind: "link_orphan", item: a.ref, ignore: [done.ref.externalId] },
    ]);
  });
});

describe("Apple → LFCP (PR 10)", () => {
  const pair = (over: Partial<LfcpTask> = {}, apple: Partial<AppleItem> = {}) => {
    const t = task("T1", over);
    const r = projection(t, apple);
    return { t, r, bases: new Map([["T1", synced(t, r)]]) };
  };
  const lfcpIntents = (p: ReturnType<typeof plan>) =>
    p.intents.filter((i) => i.direction === "to_lfcp").map((i) => i.payload);

  it("B12: a time-only change sends nothing; a date change sends the date only", () => {
    const { t, r, bases } = pair({ due: "2026-11-12" }, { due: { date: localDate("2026-11-12") } });
    const timeOnly = {
      ...r,
      due: { date: localDate("2026-11-12"), time: "18:30" as never, tz: "Europe/Moscow" },
    };
    expect(
      plan(
        view({
          tasks: [t],
          links: [link("T1")],
          bases,
          snapshot: { items: [timeOnly], complete: true },
        }),
      ).intents,
    ).toEqual([]);
    const moved = { ...timeOnly, due: { date: localDate("2026-11-14"), time: "18:30" as never } };
    expect(
      lfcpIntents(
        plan(
          view({
            tasks: [t],
            links: [link("T1")],
            bases,
            snapshot: { items: [moved], complete: true },
          }),
        ),
      ),
    ).toEqual([
      { resource: S, intents: [{ intent: "task.set_due", id: "T1", date: "2026-11-14" }] },
    ]);
    const { due: _, ...noDue } = r;
    expect(
      lfcpIntents(
        plan(
          view({
            tasks: [t],
            links: [link("T1")],
            bases,
            snapshot: { items: [noDue as AppleItem], complete: true },
          }),
        ),
      ),
    ).toEqual([{ resource: S, intents: [{ intent: "task.clear_due", id: "T1" }] }]);
  });

  it("B13: a priority in the same bucket is no write; a bucket change keeps highest / lowest from the shadow", () => {
    const { t, r, bases } = pair({ priority: "highest" }, { priority: 1 });
    expect(
      plan(
        view({
          tasks: [t],
          links: [link("T1")],
          bases,
          snapshot: { items: [{ ...r, priority: 3 }], complete: true },
        }),
      ).intents,
    ).toEqual([]);
    const none = pair({ priority: "normal" }, { priority: 0 });
    expect(
      plan(
        view({
          tasks: [none.t],
          links: [link("T1")],
          bases: none.bases,
          snapshot: { items: [{ ...none.r, priority: 5 }], complete: true },
        }),
      ).intents,
    ).toEqual([]);
    const lowest = pair({ priority: "lowest" }, { priority: 9 });
    const up = plan(
      view({
        tasks: [lowest.t],
        links: [link("T1")],
        bases: lowest.bases,
        snapshot: { items: [{ ...lowest.r, priority: 1 }], complete: true },
      }),
    );
    expect(lfcpIntents(up)).toEqual([
      { resource: S, intents: [{ intent: "task.set_priority", id: "T1", priority: "high" }] },
    ]);
    const back = plan(
      view({
        tasks: [lowest.t],
        links: [link("T1")],
        bases: lowest.bases,
        snapshot: { items: [{ ...lowest.r, priority: 7 }], complete: true },
      }),
    );
    expect(back.intents).toEqual([]);
  });

  it("status rows 7 and 8, title: all of a Task's Apple changes in one to_lfcp intent", () => {
    const { t, r, bases } = pair();
    const done = {
      ...r,
      title: "Renamed\nin Apple",
      completed: true,
      completionDate: "2026-11-09T12:00:00Z",
    };
    const p = plan(
      view({ tasks: [t], links: [link("T1")], bases, snapshot: { items: [done], complete: true } }),
    );
    expect(p.intents).toHaveLength(1);
    expect(p.intents[0]).toMatchObject({
      direction: "to_lfcp",
      kind: "update_task",
      fields: ["title", "status"],
      basis: {
        lfcp: {
          title: "Task T1",
          status: "todo",
          due: null,
          priority: "normal",
          completion_date: null,
        },
      },
      payload: {
        resource: S,
        intents: [
          { intent: "task.set_title", id: "T1", title: "Renamed in Apple" },
          { intent: "task.complete", id: "T1", completionDate: "2026-11-09" },
        ],
      },
    });
    expect(p.decisions.find((d) => d.field === "status")?.row).toBe("7");
    const closed = pair(
      { status: "done", completion_date: "2026-11-09" },
      { completed: true, completionDate: "2026-11-09T12:00:00Z" },
    );
    const reopened = plan(
      view({
        tasks: [closed.t],
        links: [link("T1")],
        bases: closed.bases,
        snapshot: { items: [{ ...closed.r, completed: false }], complete: true },
      }),
    );
    expect(lfcpIntents(reopened)).toEqual([
      { resource: S, intents: [{ intent: "task.reopen", id: "T1" }] },
    ]);
  });

  it("an open to_lfcp intent holds the next one back; to_apple still goes", () => {
    const { t, r, bases } = pair();
    const p = plan(
      view({
        tasks: [{ ...t, due: "2026-11-20" }],
        links: [link("T1")],
        bases,
        snapshot: { items: [{ ...r, title: "Apple" }], complete: true },
        openIntent: (_, d) => d === "to_lfcp",
      }),
    );
    expect(p.intents.map((i) => i.direction)).toEqual(["to_apple"]);
    expect(p.decisions.map((d) => [d.field, d.decision])).toEqual([
      ["title", "pending_intent"],
      ["due", "write_apple"],
    ]);
  });
});
