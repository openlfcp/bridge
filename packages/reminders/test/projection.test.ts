// Projections (D-010 §4.4), due dates and alarms (§4.5), the filter (§6.1).

import { describe, expect, it } from "vitest";
import {
  appleWrite,
  equivalent,
  inFilter,
  type LfcpTask,
  localDateIn,
  priorityBucket,
  projectApple,
  projectable,
  projectLfcp,
  sameProjection,
} from "../src/adapter/index.js";
import type { AppleItem, ListRef } from "../src/index.js";
import { localDate, timeOfDay } from "../src/index.js";

const task = (over: Partial<LfcpTask> = {}): LfcpTask => ({
  id: "T1",
  lifecycle: "active",
  title: "Buy milk",
  status: "todo",
  priority: "normal",
  assignees: {},
  ...over,
});
const item = (over: Partial<AppleItem> = {}): AppleItem => ({
  ref: { id: "r1", externalId: "e1" },
  list: "L" as ListRef,
  title: "Buy milk",
  completed: false,
  priority: 0,
  alarms: [],
  hasNotes: false,
  hasRecurrence: false,
  rev: "1",
  ...over,
});
const d = localDate;

describe("projections §4.4", () => {
  it("title: line breaks are one space on both sides", () => {
    expect(projectLfcp(task({ title: "a\nb" })).title).toBe("a b");
    expect(projectApple(item({ title: "a\r\nb" }), "UTC").title).toBe("a b");
  });

  it("priority buckets (B13): LFCP highest/high → high, normal → none, low/lowest → low; x/ → none", () => {
    const b = (priority: string) => projectLfcp(task({ priority })).priority;
    expect(["highest", "high", "normal", "low", "lowest", "x/urgent"].map(b)).toEqual([
      "high",
      "high",
      "none",
      "low",
      "low",
      "none",
    ]);
    expect([0, 1, 4, 5, 6, 9].map(priorityBucket)).toEqual([
      "none",
      "high",
      "high",
      "none",
      "low",
      "low",
    ]);
  });

  it("status group: todo/in_progress open; done with its date; cancelled closed without one; x/ open", () => {
    const s = (status: string, completion_date?: string) =>
      projectLfcp(task({ status, ...(completion_date ? { completion_date } : {}) })).status;
    expect(s("todo")).toEqual({ closed: false, date: null });
    expect(s("in_progress")).toEqual({ closed: false, date: null });
    expect(s("done", "2026-11-09")).toEqual({ closed: true, date: "2026-11-09" });
    expect(s("done")).toEqual({ closed: true, date: null });
    expect(s("cancelled", "2026-11-09")).toEqual({ closed: true, date: null });
    expect(s("x/blocked")).toEqual({ closed: false, date: null });
  });

  it("Apple status: the completion instant's local date in the zone given", () => {
    const done = item({ completed: true, completionDate: "2026-11-09T23:30:00Z" });
    expect(projectApple(done, "UTC").status).toEqual({ closed: true, date: "2026-11-09" });
    expect(projectApple(done, "Europe/Moscow").status).toEqual({
      closed: true,
      date: "2026-11-10",
    });
    expect(projectApple(item({ completed: true }), "UTC").status).toEqual({
      closed: true,
      date: null,
    });
    expect(localDateIn("not a date", "UTC")).toBeNull();
  });

  it("status equivalence: closed equal and dates equal or one of them —", () => {
    const st = (closed: boolean, date: string | null) => ({
      closed,
      date: date === null ? null : d(date),
    });
    expect(equivalent("status", st(true, "2026-11-09"), st(true, null))).toBe(true);
    expect(equivalent("status", st(true, "2026-11-09"), st(true, "2026-11-09"))).toBe(true);
    expect(equivalent("status", st(true, "2026-11-09"), st(true, "2026-11-08"))).toBe(false);
    expect(equivalent("status", st(true, null), st(false, null))).toBe(false);
    // Against a base it is exact: a date that appeared is a change.
    expect(sameProjection("status", st(true, "2026-11-09"), st(true, null))).toBe(false);
  });

  it("due: the date only; time, zone and alarms are outside the projection", () => {
    expect(projectLfcp(task({ due: "2026-11-12" })).due).toBe("2026-11-12");
    expect(projectLfcp(task({ due: null })).due).toBeNull();
    const withTime = item({ due: { date: d("2026-11-12"), time: timeOfDay("09:00"), tz: "UTC" } });
    expect(projectApple(withTime, "UTC").due).toBe("2026-11-12");
    expect(projectApple(item(), "UTC").due).toBeNull();
  });
});

describe("writes to Apple §4.5 (B2, B12, B15)", () => {
  const pL = (over: Partial<LfcpTask>) => projectLfcp(task(over));

  it("a date is set alone: dueDate only, the reminder's time and alarms are not in the write", () => {
    const it0 = item({
      due: { date: d("2026-11-12"), time: timeOfDay("09:00"), tz: "UTC" },
      alarms: [{ kind: "relative", relativeSec: -600 }],
    });
    expect(appleWrite("due", pL({ due: "2026-11-13" }), it0, "UTC")).toEqual({
      kind: "set",
      set: { dueDate: "2026-11-13" },
      warnings: [],
    });
  });

  it("an absolute alarm left on the old day: a warning, the alarm is not touched", () => {
    const it0 = item({
      due: { date: d("2026-11-12"), time: timeOfDay("09:00"), tz: "UTC" },
      alarms: [{ kind: "absolute", at: "2026-11-12T09:00:00Z" }],
    });
    expect(appleWrite("due", pL({ due: "2026-11-13" }), it0, "UTC")).toEqual({
      kind: "set",
      set: { dueDate: "2026-11-13" },
      warnings: ["alarm_on_old_date"],
    });
  });

  it("clearing: written without time and alarms; with a time or any alarm a conflict (B12)", () => {
    const plain = item({ due: { date: d("2026-11-12") } });
    expect(appleWrite("due", pL({ due: null }), plain, "UTC")).toMatchObject({
      kind: "set",
      set: { dueDate: null },
    });
    const timed = item({ due: { date: d("2026-11-12"), time: timeOfDay("09:00") } });
    expect(appleWrite("due", pL({ due: null }), timed, "UTC")).toEqual({
      kind: "conflict",
      conflict: "due_cleared_in_lfcp",
    });
    const alarmed = item({
      due: { date: d("2026-11-12") },
      alarms: [{ kind: "relative", relativeSec: 0 }],
    });
    expect(appleWrite("due", pL({ due: null }), alarmed, "UTC")).toMatchObject({
      kind: "conflict",
    });
  });

  it("priority goes as 0 / 1 / 9; status as completed with LFCP's date when it has one", () => {
    expect(appleWrite("priority", pL({ priority: "lowest" }), item(), "UTC")).toMatchObject({
      set: { priority: 9 },
    });
    expect(
      appleWrite("status", pL({ status: "done", completion_date: "2026-11-09" }), item(), "UTC"),
    ).toMatchObject({ set: { completed: { value: true, date: "2026-11-09" } } });
    expect(appleWrite("status", pL({ status: "cancelled" }), item(), "UTC")).toMatchObject({
      set: { completed: { value: true } },
    });
    expect(appleWrite("status", pL({ status: "todo" }), item(), "UTC")).toMatchObject({
      set: { completed: { value: false } },
    });
  });
});

describe("filter §6.1 (QB10)", () => {
  const me = "lfcp:principal:me";
  it("default: assigned to me, or unassigned with a due date; mine: assigned to me; all: always", () => {
    const assigned = task({ assignees: { [me]: true } });
    const other = task({ assignees: { "lfcp:principal:other": true }, due: "2026-11-12" });
    const dated = task({ due: "2026-11-12" });
    const bare = task();
    expect([assigned, other, dated, bare].map((t) => inFilter(t, "default", me))).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect([assigned, other, dated, bare].map((t) => inFilter(t, "mine", me))).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect([assigned, other, dated, bare].map((t) => inFilter(t, "all", undefined))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(() => inFilter(bare, "mine", undefined)).toThrow(/me/);
  });

  it("status is not in the filter, but done, cancelled and deleted Tasks get no new projection", () => {
    const done = task({ due: "2026-11-12", status: "done" });
    expect(inFilter(done, "default", me)).toBe(true);
    expect(projectable(done, "default", me)).toBe(false);
    expect(projectable(task({ due: "2026-11-12", status: "cancelled" }), "default", me)).toBe(
      false,
    );
    expect(projectable(task({ due: "2026-11-12", lifecycle: "deleted" }), "default", me)).toBe(
      false,
    );
    expect(projectable(task({ due: "2026-11-12", status: "in_progress" }), "default", me)).toBe(
      true,
    );
  });
});
