import {
  OperationInFlightError as ContractInFlight,
  OutcomeUnknownError as ContractUnknown,
  MemoryKV,
} from "@openlfcp/bridge-reminders/transport";
import { describe, expect, it } from "vitest";
import { type HelperLink, HelperLostError } from "../src/link.js";
import { EventKitTransport, statusOf } from "../src/transport.js";
import {
  mapItem,
  mapWritten,
  type WireEvent,
  type WireReady,
  type WireResponse,
} from "../src/wire.js";

type Handler = (op: string, body: Record<string, unknown>) => WireResponse | Promise<WireResponse>;

/** A scripted helper connection: no process, no EventKit. */
class FakeLink implements HelperLink {
  readonly calls: { op: string; body: Record<string, unknown> }[] = [];
  readonly #events = new Set<(e: WireEvent) => void>();
  constructor(
    public handler: Handler,
    readonly ready: WireReady = {
      event: "ready",
      protocol: 2,
      helperVersion: "0.3.0",
      backend: "eventkit",
      cas: "best-effort",
      authorization: "fullAccess",
    },
  ) {}
  async request(op: string, body: Record<string, unknown> = {}): Promise<WireResponse> {
    this.calls.push({ op, body });
    return this.handler(op, body);
  }
  onEvent(cb: (e: WireEvent) => void): () => void {
    this.#events.add(cb);
    return () => this.#events.delete(cb);
  }
  onExit(): () => void {
    return () => {};
  }
  emit(e: WireEvent): void {
    for (const cb of this.#events) cb(e);
  }
  async close(): Promise<void> {}
}

const okBody = (id: number, extra: Record<string, unknown>): WireResponse =>
  ({ id, ok: true, ...extra }) as WireResponse;
const ITEM = {
  ref: { id: "R1", externalId: null },
  list: "L1",
  linkUrl: null,
  title: "a",
  completed: false,
  completionDate: null,
  priority: 0,
  due: { date: "2026-12-01", time: null, tz: null },
  alarms: [{ kind: "location", title: null, proximity: "enter" }],
  hasNotes: false,
  hasRecurrence: false,
  rev: "r1",
};

async function open(handler: Handler, ready?: Partial<WireReady>) {
  const link = new FakeLink(
    handler,
    ready ? ({ ...new FakeLink(handler).ready, ...ready } as WireReady) : undefined,
  );
  const kv = new MemoryKV();
  const t = new EventKitTransport({
    appPath: "/nonexistent",
    link: async () => link,
    writes: "verified",
  });
  const status = await t.open({
    installationKey: "i",
    state: kv,
    scope: { listTitlePrefixes: ["LFCP · "], listIds: [] },
  });
  return { link, kv, t, status };
}

const helloOk: Handler = (op) =>
  op === "hello" ? okBody(1, { writes: "verified" }) : okBody(1, {});

describe("wire mapping", () => {
  it("helper nulls become absent keys", () => {
    const it = mapItem(ITEM);
    expect(it).toEqual({
      ref: { id: "R1" },
      list: "L1",
      title: "a",
      completed: false,
      priority: 0,
      due: { date: "2026-12-01" },
      alarms: [{ kind: "location", proximity: "enter" }],
      hasNotes: false,
      hasRecurrence: false,
      rev: "r1",
    });
    expect("linkUrl" in it).toBe(false);
    expect("completionDate" in it).toBe(false);
  });

  it("written keeps dueDate: null (a cleared due), drops other nulls", () => {
    expect(mapWritten({ dueDate: null })).toEqual({ dueDate: null });
    expect(mapWritten({ completed: { value: false } })).toEqual({ completed: { value: false } });
    expect(
      mapWritten({ completed: { value: true, completionDate: "2026-11-02T11:00:00.000Z" } }),
    ).toEqual({
      completed: { value: true, completionDate: "2026-11-02T11:00:00.000Z" },
    });
  });
});

describe("open and status", () => {
  it("hello carries the write scope and the write mode", async () => {
    const { link, status } = await open(helloOk);
    expect(status).toEqual({ state: "ok" });
    expect(link.calls[0]).toEqual({
      op: "hello",
      body: { allowListIds: [], allowListTitlePrefixes: ["LFCP · "], writes: "verified" },
    });
  });

  it("authorization maps to needs_human; access_changed updates status and notifies", async () => {
    const { link, t, status } = await open(helloOk, { authorization: "notDetermined" });
    expect(status).toEqual({ state: "needs_human", reason: "tcc_not_determined" });
    const events: string[] = [];
    t.onSystem((e) => events.push(e));
    link.emit({ event: "access_changed", authorization: "fullAccess" });
    expect(t.status()).toEqual({ state: "ok" });
    expect(events).toEqual(["access_changed"]);
    expect(statusOf("denied")).toEqual({ state: "needs_human", reason: "tcc_denied" });
    expect(statusOf("writeOnly")).toEqual({ state: "needs_human", reason: "tcc_write_only" });
  });

  it("changed events are coarse hints", async () => {
    const { link, t } = await open(helloOk);
    const hints: unknown[] = [];
    t.onChange((h) => hints.push(h));
    link.emit({ event: "changed", seq: 1 });
    expect(hints).toEqual([{ coarse: true }]);
  });

  it("a missing helper is unavailable, not a crash", async () => {
    const t = new EventKitTransport({
      appPath: "/nonexistent",
      link: async () => {
        throw new HelperLostError("no app");
      },
    });
    const s = await t.open({
      installationKey: "i",
      state: new MemoryKV(),
      scope: { listTitlePrefixes: [], listIds: [] },
    });
    expect(s).toMatchObject({ state: "unavailable", reason: "helper_missing" });
  });
});

describe("stages and recover", () => {
  const writeOk: Handler = (op) =>
    op === "hello"
      ? okBody(1, {})
      : okBody(2, {
          opKey: "k",
          ref: { id: "R1", externalId: "X1" },
          rev: "r2",
          written: { title: "b" },
        });

  it("done after an ok answer; the same opKey is answered from the stage, not resent", async () => {
    const { link, t, kv } = await open(writeOk);
    const op = {
      opKey: "k",
      kind: "update" as const,
      ref: { id: "R1" },
      set: { title: "b" },
      expect: { rev: "r1" },
    };
    const r = await t.apply(op);
    expect(r).toMatchObject({
      ok: true,
      rev: "r2",
      written: { title: "b" },
      ref: { id: "R1", externalId: "X1" },
    });
    expect(kv.get("op:k")).toMatchObject({ stage: "done" });
    const rec = await t.recover("k");
    expect(rec).toMatchObject({ state: "done", result: { opKey: "k", rev: "r2" } });
    const sent = link.calls.length;
    expect(await t.apply(op)).toMatchObject({ ok: true, existing: true, rev: "r2" });
    expect(link.calls.length).toBe(sent);
  });

  it("an error answer is failed → not_started (EventKit wrote nothing)", async () => {
    const { t } = await open((op) =>
      op === "hello"
        ? okBody(1, {})
        : { id: 2, ok: false, error: { code: "personal_conflict", message: "time set" } },
    );
    const r = await t.apply({
      opKey: "k",
      kind: "update",
      ref: { id: "R1" },
      set: { dueDate: null },
      expect: { rev: "r1" },
    });
    expect(r).toMatchObject({ ok: false, code: "personal_conflict" });
    expect(await t.recover("k")).toEqual({ state: "not_started" });
  });

  it("a lost answer stays unknown with its opKind — for create too, never inferred from fields (r3 P2-1)", async () => {
    const lose = true;
    const { t } = await open((op) => {
      if (op === "hello") return okBody(1, {});
      if (lose) throw new HelperLostError("helper exited with a request in flight");
      return okBody(3, { ref: { id: "R9" }, rev: "r9", written: { title: "x" } });
    });
    await expect(
      t.apply({
        opKey: "c",
        kind: "create",
        list: "L1" as never,
        linkUrl: "lfcp://task/T",
        set: { title: "x" },
      }),
    ).rejects.toBeInstanceOf(HelperLostError);
    expect(await t.recover("c")).toEqual({ state: "unknown", stage: "sent", opKind: "create" });
    await expect(
      t.apply({
        opKey: "u",
        kind: "update",
        ref: { id: "R1" },
        set: { title: "b" },
        expect: { rev: "r1" },
      }),
    ).rejects.toThrow();
    expect(await t.recover("u")).toEqual({ state: "unknown", stage: "sent", opKind: "update" });
  });

  it("an unknown outcome is frozen: a retry with the same opKey is refused, not resent (review PR 6, P1-1)", async () => {
    // The helper applies every write; the first answer of each is lost. It keeps no opKey journal,
    // so a resend would answer list_exists / conflict_changed and erase the evidence.
    let lists = 0;
    let lose = true;
    const { link, t } = await open((op) => {
      if (op === "hello") return okBody(1, {});
      if (op === "lists.create") lists += 1;
      const answer =
        op === "lists.create"
          ? lists > 1
            ? ({
                id: 2,
                ok: false,
                error: { code: "list_exists", message: "taken" },
              } as WireResponse)
            : okBody(2, {
                list: {
                  id: "L1",
                  title: "LFCP · A",
                  source: {},
                  allowsContentModifications: true,
                  isDefault: false,
                },
              })
          : ({
              id: 2,
              ok: false,
              error: { code: "conflict_changed", message: "x", fresh: ITEM },
            } as WireResponse);
      if (lose) {
        lose = false;
        throw new HelperLostError("answer lost after the effect");
      }
      return answer;
    });
    await expect(t.createList({ opKey: "same", title: "LFCP · A" })).rejects.toBeInstanceOf(
      HelperLostError,
    );
    const sent = link.calls.length;
    await expect(t.createList({ opKey: "same", title: "LFCP · A" })).rejects.toMatchObject({
      name: "OutcomeUnknownError",
    });
    expect(link.calls.length).toBe(sent);
    expect(lists).toBe(1);
    expect(await t.recover("same")).toEqual({
      state: "unknown",
      stage: "sent",
      opKind: "create_list",
    });

    lose = true;
    const op = {
      opKey: "u",
      kind: "update" as const,
      ref: { id: "R1" },
      set: { title: "b" },
      expect: { rev: "r1" },
    };
    await expect(t.apply(op)).rejects.toBeInstanceOf(HelperLostError);
    await expect(t.apply(op)).rejects.toMatchObject({ name: "OutcomeUnknownError" });
    expect(await t.recover("u")).toEqual({ state: "unknown", stage: "sent", opKind: "update" });
  });

  it("refusals are the contract's classes (B19), so the executor recognises them by instanceof", async () => {
    let release: (r: WireResponse) => void = () => {};
    let lose = true;
    const { t } = await open((op) => {
      if (op === "hello") return okBody(1, {});
      if (lose) {
        lose = false;
        throw new HelperLostError("lost");
      }
      return new Promise<WireResponse>((r) => {
        release = r;
      });
    });
    const op = {
      opKey: "u",
      kind: "update" as const,
      ref: { id: "R1" },
      set: { title: "b" },
      expect: { rev: "r1" },
    };
    await expect(t.apply(op)).rejects.toBeInstanceOf(HelperLostError);
    await expect(t.apply(op)).rejects.toBeInstanceOf(ContractUnknown);
    const op2 = { ...op, opKey: "v" };
    const first = t.apply(op2);
    await expect(t.apply(op2)).rejects.toBeInstanceOf(ContractInFlight);
    release(okBody(2, { ref: { id: "R1" }, rev: "r2", written: { title: "b" } }));
    await first;
  });

  it("concurrent calls with one opKey: the second is refused, only one request leaves", async () => {
    let release: (r: WireResponse) => void = () => {};
    const { link, t } = await open((op) =>
      op === "hello"
        ? okBody(1, {})
        : new Promise<WireResponse>((r) => {
            release = r;
          }),
    );
    const op = {
      opKey: "k",
      kind: "update" as const,
      ref: { id: "R1" },
      set: { title: "b" },
      expect: { rev: "r1" },
    };
    const first = t.apply(op);
    await expect(t.apply(op)).rejects.toMatchObject({ name: "OperationInFlightError" });
    release(okBody(2, { ref: { id: "R1" }, rev: "r2", written: { title: "b" } }));
    expect(await first).toMatchObject({ ok: true, rev: "r2" });
    expect(link.calls.filter((c) => c.op === "items.update")).toHaveLength(1);
  });

  it("recover of an unknown key is not_started", async () => {
    const { t } = await open(helloOk);
    expect(await t.recover("never")).toEqual({ state: "not_started" });
  });

  it("createList: lost answer → unknown create_list; list_exists → ListExistsError", async () => {
    let mode: "lose" | "exists" = "lose";
    const { t } = await open((op) => {
      if (op === "hello") return okBody(1, {});
      if (mode === "lose") throw new HelperLostError("gone");
      return { id: 2, ok: false, error: { code: "list_exists", message: "taken" } };
    });
    await expect(t.createList({ opKey: "l1", title: "LFCP · A" })).rejects.toBeInstanceOf(
      HelperLostError,
    );
    expect(await t.recover("l1")).toEqual({
      state: "unknown",
      stage: "sent",
      opKind: "create_list",
    });
    mode = "exists";
    await expect(t.createList({ opKey: "l2", title: "LFCP · A" })).rejects.toMatchObject({
      name: "ListExistsError",
    });
    expect(await t.recover("l2")).toEqual({ state: "not_started" });
  });
});

describe("error mapping", () => {
  it("contract codes pass through, others become transport_error with the native detail", async () => {
    const codes: Record<string, string> = {};
    for (const code of [
      "writes_disabled",
      "store_conflict",
      "eventkit_error",
      "tcc_denied",
      "internal",
    ]) {
      const { t } = await open((op) =>
        op === "hello" ? okBody(1, {}) : { id: 2, ok: false, error: { code, message: code } },
      );
      const r = await t.apply({
        opKey: code,
        kind: "update",
        ref: { id: "R" },
        set: { title: "x" },
        expect: { rev: "r" },
      });
      codes[code] = r.ok ? "ok" : r.code;
    }
    expect(codes).toEqual({
      writes_disabled: "writes_disabled",
      store_conflict: "store_conflict",
      eventkit_error: "transport_error",
      tcc_denied: "transport_error",
      internal: "transport_error",
    });
  });

  it("conflict_changed carries the fresh item, mapped", async () => {
    const { t } = await open((op) =>
      op === "hello"
        ? okBody(1, {})
        : { id: 2, ok: false, error: { code: "conflict_changed", message: "x", fresh: ITEM } },
    );
    const r = await t.apply({
      opKey: "k",
      kind: "update",
      ref: { id: "R1" },
      set: { title: "b" },
      expect: { rev: "old" },
    });
    expect(r).toMatchObject({
      ok: false,
      code: "conflict_changed",
      fresh: { rev: "r1", due: { date: "2026-12-01" } },
    });
  });

  it("reads: tcc and list errors become TransportReadError", async () => {
    const { t } = await open((op) =>
      op === "hello"
        ? okBody(1, {})
        : {
            id: 2,
            ok: false,
            error: {
              code: op === "items.snapshot" ? "list_not_found" : "tcc_not_determined",
              message: "x",
            },
          },
    );
    await expect(t.snapshot("L" as never)).rejects.toMatchObject({
      name: "TransportReadError",
      code: "list_not_found",
    });
    await expect(t.lists()).rejects.toMatchObject({
      name: "TransportReadError",
      code: "tcc_not_determined",
    });
  });
});
