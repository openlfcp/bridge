/**
 * Contract tests every Reminders transport must pass (D-010 r4 §4.2, §10.2): fake (Linux CI),
 * the Swift helper with --backend memory (macOS CI), EventKit (live verification run), and
 * CloudKit later (B9). A transport package calls `transportContract(name, makeRig)`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  type Alarm,
  type AppleItem,
  type AppleOpResult,
  type AppleOpSuccess,
  type DurableKV,
  ForbiddenListError,
  type ItemRef,
  ListExistsError,
  type ListInfo,
  type ListRef,
  type RecoverResult,
  type RemindersTransport,
} from "../src/transport.js";
import { type LocalDate, localDate } from "../src/values.js";

/** Edits a person makes in Reminders (personal data included). */
export interface ContractPerson {
  createList(title: string, opts?: { readOnly?: boolean }): Promise<ListInfo>;
  create(
    list: ListRef,
    title: string,
    opts?: { url?: string; completed?: boolean },
  ): Promise<AppleItem>;
  edit(
    ref: ItemRef,
    edits: {
      title?: string;
      dueDate?: string | null;
      dueTime?: string | null;
      tz?: string;
      notes?: boolean;
      recurrence?: boolean;
      addAlarm?: Alarm;
      url?: string | null;
      moveTo?: ListRef;
    },
  ): Promise<AppleItem>;
}

export interface ContractRig {
  readonly transport: RemindersTransport;
  readonly kv: DurableKV;
  readonly person: ContractPerson;
  /** Arms: the next write is applied but its answer is lost (the call rejects). Optional. */
  loseNextResponse?(): void;
  /** Arms: `edit` runs between the expect check and the save of the next update. Optional. */
  beforeSave?(edit: () => Promise<void> | void): void;
  /** A new transport instance on the same account and DurableKV (process restart). Optional. */
  restart?(): Promise<RemindersTransport>;
}

export const SCOPE_PREFIX = "LFCP · ";

let seq = 0;
const opKey = () => `op-${Date.now().toString(36)}-${++seq}`;
const D = (s: string): LocalDate => localDate(s);
const ok = (r: AppleOpResult) => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r;
};

/** Every written field must equal what a read of the record returns (no silent drops). */
function expectWrittenMatches(written: AppleOpSuccess["written"], it: AppleItem): void {
  if (written.title !== undefined) expect(it.title).toBe(written.title);
  if (written.priority !== undefined) expect(it.priority).toBe(written.priority);
  if (written.linkUrl !== undefined) expect(it.linkUrl).toBe(written.linkUrl);
  if (written.dueDate !== undefined) expect(it.due?.date ?? null).toBe(written.dueDate);
  if (written.completed !== undefined) {
    expect(it.completed).toBe(written.completed.value);
    expect(it.completionDate).toBe(written.completed.completionDate);
  }
}

/** A recovered "done" must carry a usable result: same opKey, the record, its rev and written. */
function expectDoneItem(rec: RecoverResult, opKey: string): AppleOpSuccess {
  expect(rec.state).toBe("done");
  if (rec.state !== "done") throw new Error("not done");
  expect("ref" in rec.result).toBe(true);
  const r = rec.result as AppleOpSuccess;
  expect(r.ok).toBe(true);
  expect(r.opKey).toBe(opKey);
  expect(typeof r.ref?.id).toBe("string");
  expect(typeof r.rev).toBe("string");
  expect(r.rev.length).toBeGreaterThan(0);
  expect(r.written).toBeTypeOf("object");
  return r;
}

export function transportContract(name: string, makeRig: () => Promise<ContractRig>): void {
  describe(`Reminders transport contract: ${name}`, () => {
    let rig: ContractRig;
    let t: RemindersTransport;
    let list: ListInfo;

    async function item(id: string): Promise<AppleItem> {
      const r = await t.find({ id }, "all");
      const found = r.items[0];
      if (found === undefined) throw new Error(`no item ${id}`);
      return found;
    }

    async function create(
      title: string,
      extra: Record<string, unknown> = {},
      url = `lfcp://task/T-${++seq}`,
    ) {
      return ok(
        await t.apply({
          opKey: opKey(),
          kind: "create",
          list: list.id,
          linkUrl: url,
          set: { title, ...extra },
        }),
      );
    }

    beforeEach(async () => {
      rig = await makeRig();
      t = rig.transport;
      expect(
        (
          await t.open({
            installationKey: "i1",
            state: rig.kv,
            scope: { listTitlePrefixes: [SCOPE_PREFIX], listIds: [] },
          })
        ).state,
      ).toBe("ok");
      list = await t.createList({ opKey: opKey(), title: `${SCOPE_PREFIX}Inbox ${++seq}` });
    });

    describe("lists", () => {
      it("createList: complete listing, title taken → ListExistsError, same opKey → same list", async () => {
        const all = await t.lists();
        expect(all.complete).toBe(true);
        expect(all.lists.map((l) => l.id)).toContain(list.id);
        await expect(t.createList({ opKey: opKey(), title: list.title })).rejects.toBeInstanceOf(
          ListExistsError,
        );
        const key = opKey();
        const a = await t.createList({ opKey: key, title: `${SCOPE_PREFIX}Again ${seq}` });
        const b = await t.createList({ opKey: key, title: `${SCOPE_PREFIX}Again ${seq}` });
        expect(b.id).toBe(a.id);
      });

      it("createList outside the write scope → ForbiddenListError", async () => {
        await expect(t.createList({ opKey: opKey(), title: "Groceries" })).rejects.toBeInstanceOf(
          ForbiddenListError,
        );
      });

      it("recover(createList) after success → done with the list", async () => {
        const key = opKey();
        const l = await t.createList({ opKey: key, title: `${SCOPE_PREFIX}Rec ${seq}` });
        const r = await t.recover(key);
        expect(r.state).toBe("done");
        if (r.state !== "done") return;
        expect("list" in r.result).toBe(true);
        const created = r.result as { opKey: string; list: ListInfo };
        expect(created.opKey).toBe(key);
        expect(created.list.id).toBe(l.id);
        expect(created.list.title).toBe(l.title);
      });
    });

    describe("create", () => {
      it("writes the set fields and the link; written reflects them", async () => {
        const r = await create(
          "Buy milk",
          { priority: 9, dueDate: D("2026-12-01") },
          "lfcp://task/T-milk",
        );
        expect(r.written).toMatchObject({
          title: "Buy milk",
          priority: 9,
          dueDate: "2026-12-01",
          linkUrl: "lfcp://task/T-milk",
        });
        const it = await item(r.ref.id);
        expect(it).toMatchObject({
          title: "Buy milk",
          priority: 9,
          linkUrl: "lfcp://task/T-milk",
          completed: false,
        });
        expect(it.due).toEqual({ date: "2026-12-01" });
        expect(it.rev).toBe(r.rev);
        expectWrittenMatches(r.written, it);
      });

      it("is idempotent by opKey and by link in the list", async () => {
        const key = opKey();
        const op = {
          opKey: key,
          kind: "create" as const,
          list: list.id,
          linkUrl: "lfcp://task/T-idem",
          set: { title: "a" },
        };
        const a = ok(await t.apply(op));
        const b = ok(await t.apply(op));
        expect(b.ref.id).toBe(a.ref.id);
        expect(b.existing).toBe(true);
        const c = ok(await t.apply({ ...op, opKey: opKey() }));
        expect(c.ref.id).toBe(a.ref.id);
        expect(c.existing).toBe(true);
        expect(
          (await t.snapshot(list.id)).items.filter((i) => i.linkUrl === "lfcp://task/T-idem"),
        ).toHaveLength(1);
      });

      it("refuses lists outside the scope, read-only lists, bad links and priorities", async () => {
        const real = await rig.person.createList("Groceries");
        const ro = await rig.person.createList(`${SCOPE_PREFIX}Shared RO`, { readOnly: true });
        const base = { kind: "create" as const, linkUrl: "lfcp://task/T-x", set: { title: "x" } };
        expect(await t.apply({ ...base, opKey: opKey(), list: real.id })).toMatchObject({
          ok: false,
          code: "forbidden_list",
        });
        expect(await t.apply({ ...base, opKey: opKey(), list: ro.id })).toMatchObject({
          ok: false,
          code: "forbidden_list",
        });
        expect(
          await t.apply({ ...base, opKey: opKey(), list: list.id, linkUrl: "https://x" }),
        ).toMatchObject({ ok: false, code: "invalid" });
        expect(
          await t.apply({
            ...base,
            opKey: opKey(),
            list: list.id,
            set: { title: "x", priority: 5 as 1 },
          }),
        ).toMatchObject({ ok: false, code: "invalid" });
      });
    });

    describe("snapshot and find", () => {
      it("snapshot is complete and includes completed reminders", async () => {
        await create("open");
        await create("done", { completed: { value: true } });
        const s = await t.snapshot(list.id);
        expect(s.complete).toBe(true);
        expect(s.items.map((i) => i.title).sort()).toEqual(["done", "open"]);
      });

      it("find by url, urlPrefix, externalId, across all lists", async () => {
        const a = await create("a", {}, "lfcp://task/T-find-a");
        const other = await rig.person.createList("Elsewhere");
        await rig.person.create(other.id, "moved", { url: "lfcp://task/T-find-b" });
        expect(
          (await t.find({ url: "lfcp://task/T-find-a" }, [list.id])).items.map((i) => i.ref.id),
        ).toEqual([a.ref.id]);
        const all = await t.find({ urlPrefix: "lfcp://task/T-find-" }, "all");
        expect(all.complete).toBe(true);
        expect(all.items).toHaveLength(2);
        const ext = (await item(a.ref.id)).ref.externalId;
        if (ext !== undefined)
          expect((await t.find({ externalId: ext }, "all")).items).toHaveLength(1);
      });
    });

    describe("update", () => {
      it("stale expect.rev → conflict_changed with the fresh item; current rev writes", async () => {
        const c = await create("a");
        const edited = await rig.person.edit(c.ref, { title: "edited on iPhone" });
        const stale = await t.apply({
          opKey: opKey(),
          kind: "update",
          ref: c.ref,
          set: { title: "b" },
          expect: { rev: c.rev },
        });
        expect(stale).toMatchObject({ ok: false, code: "conflict_changed", retryable: true });
        if (!stale.ok && stale.code === "conflict_changed")
          expect(stale.fresh.title).toBe("edited on iPhone");
        const r = ok(
          await t.apply({
            opKey: opKey(),
            kind: "update",
            ref: c.ref,
            set: { title: "b" },
            expect: { rev: edited.rev },
          }),
        );
        expect(r.written).toEqual({ title: "b" });
        expect(r.rev).not.toBe(edited.rev);
      });

      it("writes only the set fields; personal data and alarms untouched", async () => {
        const c = await create("a", { dueDate: D("2026-12-01") });
        const alarm: Alarm = { kind: "absolute", at: "2026-11-30T18:00:00.000Z" };
        let p = await rig.person.edit(c.ref, {
          dueTime: "09:00",
          tz: "Europe/Paris",
          notes: true,
          addAlarm: alarm,
        });
        p = await rig.person.edit(c.ref, { addAlarm: { kind: "relative", relativeSec: -900 } });
        const r = ok(
          await t.apply({
            opKey: opKey(),
            kind: "update",
            ref: c.ref,
            set: { title: "b", priority: 1, completed: { value: true } },
            expect: { rev: p.rev },
          }),
        );
        expect(Object.keys(r.written).sort()).toEqual(["completed", "priority", "title"]);
        const after = await item(c.ref.id);
        expect(after).toMatchObject({ title: "b", priority: 1, completed: true });
        expectWrittenMatches(r.written, after);
        expect(after.rev).toBe(r.rev);
        expect(after.hasNotes).toBe(true);
        expect(after.due).toEqual(p.due);
        expect(after.alarms).toEqual(p.alarms);
        expect(after.linkUrl).toBe(p.linkUrl);
      });

      it("due date change keeps time, zone and alarms (B2, B15); warns about an alarm on the old day", async () => {
        const c = await create("a", { dueDate: D("2026-12-01") });
        const p = await rig.person.edit(c.ref, {
          dueTime: "09:00",
          tz: "Europe/Paris",
          addAlarm: { kind: "absolute", at: "2026-12-01T08:00:00.000Z" },
        });
        const r = ok(
          await t.apply({
            opKey: opKey(),
            kind: "update",
            ref: c.ref,
            set: { dueDate: D("2026-12-03") },
            expect: { rev: p.rev },
          }),
        );
        expect(r.written).toEqual({ dueDate: "2026-12-03" });
        expect(r.warnings).toContain("alarm_on_old_date");
        const after = await item(c.ref.id);
        expect(after.due).toEqual({ date: "2026-12-03", time: "09:00", tz: "Europe/Paris" });
        expect(after.alarms).toEqual(p.alarms);
      });

      it("due=null: bare date clears; time or any alarm → personal_conflict, nothing written (B12)", async () => {
        const bare = await create("bare", { dueDate: D("2026-12-01") });
        expect(
          ok(
            await t.apply({
              opKey: opKey(),
              kind: "update",
              ref: bare.ref,
              set: { dueDate: null },
              expect: { rev: bare.rev },
            }),
          ).written,
        ).toEqual({ dueDate: null });

        const timed = await create("timed", { dueDate: D("2026-12-01") });
        const pt = await rig.person.edit(timed.ref, { dueTime: "09:00" });
        expect(
          await t.apply({
            opKey: opKey(),
            kind: "update",
            ref: timed.ref,
            set: { dueDate: null },
            expect: { rev: pt.rev },
          }),
        ).toMatchObject({ ok: false, code: "personal_conflict" });
        expect((await item(timed.ref.id)).rev).toBe(pt.rev);

        const alarmed = await create("alarmed", { dueDate: D("2026-12-01") });
        const pa = await rig.person.edit(alarmed.ref, {
          addAlarm: { kind: "relative", relativeSec: -600 },
        });
        expect(
          await t.apply({
            opKey: opKey(),
            kind: "update",
            ref: alarmed.ref,
            set: { dueDate: null },
            expect: { rev: pa.rev },
          }),
        ).toMatchObject({ ok: false, code: "personal_conflict" });
      });

      it("completed with a past date stores that day; reopen clears the date", async () => {
        const c = await create("a");
        const done = ok(
          await t.apply({
            opKey: opKey(),
            kind: "update",
            ref: c.ref,
            set: { completed: { value: true, date: D("2026-11-02") } },
            expect: { rev: c.rev },
          }),
        );
        expect(done.written.completed?.value).toBe(true);
        expect(done.written.completed?.completionDate?.slice(0, 10)).toBe("2026-11-02");
        const reopened = ok(
          await t.apply({
            opKey: opKey(),
            kind: "update",
            ref: c.ref,
            set: { completed: { value: false } },
            expect: { rev: done.rev },
          }),
        );
        expect(reopened.written.completed).toEqual({ value: false });
      });

      it("done(cd1) → done(today): an explicit completion date of today replaces the old one", async () => {
        const c = await create("a");
        const old = ok(
          await t.apply({
            opKey: opKey(),
            kind: "update",
            ref: c.ref,
            set: { completed: { value: true, date: D("2020-01-01") } },
            expect: { rev: c.rev },
          }),
        );
        expect(old.written.completed?.completionDate?.slice(0, 10)).toBe("2020-01-01");
        // "today" in the transport's zone is within ±1 day of UTC today.
        const today = D(new Date().toISOString().slice(0, 10));
        const now = ok(
          await t.apply({
            opKey: opKey(),
            kind: "update",
            ref: c.ref,
            set: { completed: { value: true, date: today } },
            expect: { rev: old.rev },
          }),
        );
        const cd = now.written.completed?.completionDate;
        expect(cd).toBeDefined();
        expect(Math.abs(Date.parse(cd ?? "") - Date.now())).toBeLessThan(36 * 3600 * 1000);
        expectWrittenMatches(now.written, await item(c.ref.id));
      });

      it("a reminder moved to a list outside the scope cannot be written", async () => {
        const c = await create("a");
        const real = await rig.person.createList("Personal");
        const moved = await rig.person.edit(c.ref, { moveTo: real.id });
        expect(
          await t.apply({
            opKey: opKey(),
            kind: "update",
            ref: c.ref,
            set: { title: "b" },
            expect: { rev: moved.rev },
          }),
        ).toMatchObject({ ok: false, code: "forbidden_list" });
      });

      it("edit between check and save: best-effort keeps the person's other fields; strong refuses", async () => {
        if (rig.beforeSave === undefined) return;
        const c = await create("a");
        rig.beforeSave(async () => {
          await rig.person.edit(c.ref, { notes: true, title: "person" });
        });
        const r = await t.apply({
          opKey: opKey(),
          kind: "update",
          ref: c.ref,
          set: { title: "bridge" },
          expect: { rev: c.rev },
        });
        const after = await item(c.ref.id);
        expect(after.hasNotes).toBe(true);
        if (t.capabilities.cas === "strong") {
          expect(r).toMatchObject({ ok: false, code: "conflict_changed" });
          expect(after.title).toBe("person");
        } else {
          expect(r.ok).toBe(true);
          expect(after.title).toBe("bridge");
        }
      });
    });

    describe("restore_url", () => {
      it("fills a missing link, keeps a URL the person set", async () => {
        const c = await create("a", {}, "lfcp://task/T-url");
        const gone = await rig.person.edit(c.ref, { url: null });
        const r = ok(
          await t.apply({
            opKey: opKey(),
            kind: "restore_url",
            ref: c.ref,
            linkUrl: "lfcp://task/T-url",
            expect: { rev: gone.rev },
          }),
        );
        expect(r.written).toEqual({ linkUrl: "lfcp://task/T-url" });
        const theirs = await rig.person.edit(c.ref, { url: "https://example.com/recipe" });
        expect(
          await t.apply({
            opKey: opKey(),
            kind: "restore_url",
            ref: c.ref,
            linkUrl: "lfcp://task/T-url",
            expect: { rev: theirs.rev },
          }),
        ).toMatchObject({ ok: false, code: "personal_conflict" });
        expect((await item(c.ref.id)).linkUrl).toBe("https://example.com/recipe");
      });
    });

    describe("markers", () => {
      it("create is a completed reminder, idempotent; retire only the exact marker", async () => {
        const url = `lfcp://bridge/inst-${seq}?r=R1`;
        const m = ok(
          await t.apply({ opKey: opKey(), kind: "marker_create", list: list.id, markerUrl: url }),
        );
        const again = ok(
          await t.apply({ opKey: opKey(), kind: "marker_create", list: list.id, markerUrl: url }),
        );
        expect(again.existing).toBe(true);
        expect(again.ref.id).toBe(m.ref.id);
        const marker = await item(m.ref.id);
        expect(marker.completed).toBe(true);
        expect(marker.linkUrl).toBe(url);
        expect(
          await t.apply({
            opKey: opKey(),
            kind: "marker_create",
            list: list.id,
            markerUrl: "lfcp://task/T",
          }),
        ).toMatchObject({ ok: false, code: "invalid" });

        const task = await create("not a marker");
        expect(
          await t.apply({
            opKey: opKey(),
            kind: "marker_retire",
            ref: task.ref,
            markerUrl: url,
            expect: { rev: task.rev },
          }),
        ).toMatchObject({ ok: false, code: "forbidden_list" });
        expect(
          await t.apply({
            opKey: opKey(),
            kind: "marker_retire",
            ref: m.ref,
            markerUrl: `${url}x`,
            expect: { rev: marker.rev },
          }),
        ).toMatchObject({ ok: false, code: "forbidden_list" });
        ok(
          await t.apply({
            opKey: opKey(),
            kind: "marker_retire",
            ref: m.ref,
            markerUrl: url,
            expect: { rev: marker.rev },
          }),
        );
        expect((await t.find({ url }, "all")).items).toHaveLength(0);
      });
    });

    describe("change hints", () => {
      it("fire after own writes and after the person's edits", async () => {
        let hints = 0;
        const off = t.onChange(() => {
          hints += 1;
        });
        const c = await create("a");
        await waitFor(() => hints > 0);
        const before = hints;
        await rig.person.edit(c.ref, { title: "b" });
        await waitFor(() => hints > before);
        off();
      });
    });

    describe("recover(opKey)", () => {
      it("done after success, not_started for an unknown key", async () => {
        const key = opKey();
        const r = ok(
          await t.apply({
            opKey: key,
            kind: "create",
            list: list.id,
            linkUrl: "lfcp://task/T-rec",
            set: { title: "a" },
          }),
        );
        const done = expectDoneItem(await t.recover(key), key);
        expect(done.ref.id).toBe(r.ref.id);
        expect(done.rev).toBe(r.rev);
        expect(done.written).toEqual(r.written);
        expect((await t.recover("never-sent")).state).toBe("not_started");
      });

      it("lost answer: exact recover → done; stages-only recover → unknown (never inferred from fields)", async () => {
        if (rig.loseNextResponse === undefined) return;
        const c = await create("a");
        rig.loseNextResponse();
        const key = opKey();
        await expect(
          t.apply({
            opKey: key,
            kind: "update",
            ref: c.ref,
            set: { title: "b" },
            expect: { rev: c.rev },
          }),
        ).rejects.toThrow();
        const transport = rig.restart ? await rig.restart() : t;
        if (rig.restart)
          await transport.open({
            installationKey: "i1",
            state: rig.kv,
            scope: { listTitlePrefixes: [SCOPE_PREFIX], listIds: [list.id] },
          });
        const rec = await transport.recover(key);
        const now = (await transport.find({ id: c.ref.id }, "all")).items[0];
        expect(now?.title).toBe("b");
        if (transport.capabilities.recover === "exact") {
          const done = expectDoneItem(rec, key);
          expect(done.ref.id).toBe(c.ref.id);
          expect(done.written).toEqual({ title: "b" });
          if (now !== undefined) expect(done.rev).toBe(now.rev);
        } else {
          expect(rec.state).toBe("unknown");
        }
      });
    });
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}
