// The runtime client of `C` on the host (A§3.3–3.5; SERVICE-CONTROL-PROFILE-01 §6, §9, §10).
// Each tick reads the state readers see and:
//
// - takes `cancels` to control_exec (A§3.3) — before the requests, so a cancel seen with its
//   request makes the admission `cancelled`;
// - admits every new `requests/<rid>` and `answers/<aid>` through control_exec (A§3.4 steps 1–2:
//   author, generation, an answer's question and snapshotHash) before any effect, and runs the
//   accepted ones by their handler, which asks `effect()` before each effect (A§3.3, B19);
// - writes, in one unit per tick, `events` from control_exec (forward only), `questions.resolved`
//   for an applied answer, `service` when it differs, `status` on a change, `bindings/<X>` on a
//   change but at most once a minute per binding (A§3.5) — only the fields that changed; a
//   binding's progress fields ride on the next unit written anyway (E-030d);
// - writes the heartbeat (`status.heartbeatAt`) only when the host has written no unit to `C` for
//   30 minutes: any unit the host writes is a sign of life (E-030 cold connect, option 2);
// - deletes, once an hour, what has been final for 7 days (§9). control_exec is never touched: an
//   id seen again after the cleanup is a duplicate (A§3.4 step 5).
//
// A v1 op without a handler here is `rejected{unsupported_op}` and is not in `service.protocol.ops`
// (A§3.5a): the ops come with their tasks (E-031…E-036).

import { randomUUID } from "node:crypto";
import { fromHex, type PrincipalId, toBase64url } from "@openlfcp/core";
import { principalRef } from "@openlfcp/shared-objects";
import {
  EVENT_STATES,
  type ServiceControlAnswer,
  type ServiceControlIntent,
  type ServiceControlRequest,
  type ServiceControlValidation,
  serviceControlCleanup,
} from "@openlfcp/shared-objects/service-control";
import type { BridgeDatabase } from "../db/database.js";
import { ControlExec, type ExecRow, eventOf } from "./exec.js";
import { bindingStatus } from "./status.js";

export const HEARTBEAT_MS = 30 * 60_000;
export const BINDING_WRITE_MS = 60_000;
export const CLEANUP_EVERY_MS = 60 * 60_000;
/** The longest wait before a repeatable outcome (or a thrown handler) runs its row again. */
export const RETRY_MAX_MS = 5 * 60_000;

/** What the client needs of `C` open on the host (SectionHost.openControl). */
export interface ControlPort {
  /** The state readers see (§5); undefined while `C` is not synchronised. */
  state(): ServiceControlValidation | undefined;
  /** §2.4: the signer of the entry's current value when root or personal created it. */
  authorOf(container: "requests" | "answers", key: string): PrincipalId | undefined;
  /** One change; `rejected` when admission refuses it (nothing is sent). */
  commit(intents: readonly ServiceControlIntent[], operationId: string): Promise<{ kind: string }>;
  /** Changes of the state, to tick at once. */
  onChanged?(listener: () => void): () => void;
}

/** A handler's outcome: final, or a repeatable code (the event stays `executing`, A§3.3). */
export type OpOutcome =
  | { readonly state: "applied" | "failed" | "rejected" | "stale"; readonly code?: string }
  | { readonly repeat: "network" | "helper_unavailable" | "server_429" };

type Entry = ServiceControlRequest | ServiceControlAnswer;
type Refusal = { state: "rejected" | "stale" | "failed"; code: string } | undefined;

export interface OpHandler {
  /** Refusals in the admission transaction (A§3.4 step 1). */
  check?(entry: Entry, binding: string | undefined): Refusal;
  /** Plans the effects in the admission transaction; their ids (control_exec.effect_ids). */
  plan?(entry: Entry, binding: string | undefined): readonly string[];
  /** Carries the row out; `effect()` before each effect: false — do not start it. */
  run(x: { readonly row: ExecRow; readonly entry: Entry; effect(): boolean }): Promise<OpOutcome>;
}

export interface ControlClientOptions {
  readonly db: BridgeDatabase;
  /**
   * The installation owning this `C` (A§3: one `C` per bridge instance × root). Its bindings are
   * those of every installation of this bridge under the same root: the base (A§4.1) and each
   * section's own installation (A§4.3); another root's are not.
   */
  readonly installation: string;
  readonly port: ControlPort;
  readonly exec?: ControlExec;
  /** Handlers by op; their names are `service.protocol.ops`. */
  readonly ops?: Readonly<Record<string, OpHandler>>;
  /** The handler of answers; without it an answer is `rejected{unsupported_op}`. */
  readonly answer?: OpHandler;
  readonly questionKinds?: readonly string[];
  /** `service` (A§3.2) but `protocol`. */
  readonly service: () => Readonly<Record<string, unknown>>;
  readonly status: () => { readonly state: string; readonly message?: string };
  readonly now?: () => number;
  readonly tickMs?: number;
  readonly onError?: (e: unknown) => void;
}

const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;
/** Plain values compared as `C` holds them: uints may come back as bigints, keys in any order. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_, x) =>
    typeof x === "bigint"
      ? Number(x)
      : x !== null && typeof x === "object" && !Array.isArray(x)
        ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)))
        : x,
  );
const plain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
/**
 * `want` over what `C` holds: `service.put` replaces a field's value whole, so a nested map keeps
 * the keys it has that the host does not write (A§3.5a: unknown fields are kept).
 */
const keep = (have: unknown, want: unknown): unknown =>
  plain(have) && plain(want)
    ? {
        ...have,
        ...Object.fromEntries(Object.entries(want).map(([k, v]) => [k, keep(have[k], v)])),
      }
    : want;
/**
 * The fields of `want` that `C` does not hold as they are, `undefined` when none: `*.put` replaces
 * a field's value whole, so a nested map keeps the keys it has that the host does not write
 * (A§3.5a: unknown fields are kept), and an unchanged field is not written again.
 */
const changedFields = (
  want: Readonly<Record<string, unknown>>,
  have: unknown,
): Record<string, unknown> | undefined => {
  const h = plain(have) ? have : {};
  const out = Object.fromEntries(
    Object.entries(want)
      .map(([k, v]) => [k, keep(h[k], v)] as const)
      .filter(([k, v]) => h[k] === undefined || canon(v) !== canon(h[k])),
  );
  return Object.keys(out).length === 0 ? undefined : out;
};
/** Progress fields of a binding: written with the next unit, not on their own (A§3.5). */
const LAZY = new Set(["lastCompleteCheckAt", "pending"]);
type BindingRow = { id: string; r: string; state: string; list: string | null; filter: string };
const resourceRef = (hex: string) => {
  try {
    return /^[0-9a-f]{64}$/.test(hex) ? toBase64url(fromHex(hex)) : undefined;
  } catch {
    return undefined;
  }
};

export class ControlClient {
  readonly #o: ControlClientOptions;
  readonly #exec: ControlExec;
  readonly #now: () => number;
  readonly #running = new Map<string, Promise<void>>();
  readonly #repeat = new Map<string, string>();
  /** A row to run again not before `at`, after `tries` repeatable outcomes in a row. */
  readonly #retry = new Map<string, { tries: number; at: number }>();
  readonly #bindingWritten = new Map<string, number>();
  /**
   * When the host last wrote a unit to `C`, kept in `meta` so a restart does not forget it; before
   * its first, `status.heartbeatAt` stands in.
   */
  #wroteAt: number | undefined;
  #queue: Promise<void> = Promise.resolve();
  #recovered = false;
  #cleanedAt = Number.NEGATIVE_INFINITY;
  #stop: (() => void)[] = [];
  #stopped = false;
  #stopping = false;

  constructor(o: ControlClientOptions) {
    this.#o = o;
    this.#exec = o.exec ?? new ControlExec(o.db);
    this.#now = o.now ?? Date.now;
  }

  start(): void {
    const t = setInterval(() => void this.tick(), this.#o.tickMs ?? 5000);
    const off = this.#o.port.onChanged?.(() => void this.tick());
    this.#stop.push(
      () => clearInterval(t),
      () => off?.(),
    );
    void this.tick();
  }

  /** No tick starts after it; the ones and the runs in flight finish. */
  async stop(): Promise<void> {
    for (const s of this.#stop) s();
    this.#stop = [];
    this.#stopping = true;
    // The runs in flight end and their events are written; then nothing more.
    await this.#queue;
    await Promise.allSettled([...this.#running.values()]);
    await this.#queue;
    this.#stopped = true;
  }

  /** One tick, after the one in flight. */
  tick(): Promise<void> {
    this.#queue = this.#queue
      .then(() => (this.#stopped ? undefined : this.#tick()))
      .catch((e) => this.#o.onError?.(e));
    return this.#queue;
  }

  /** The local id of a binding by its ResourceRef in `C`; the ref itself when none. */
  #local(ref: string | undefined): string | undefined {
    if (ref === undefined) return undefined;
    const rows = this.#bindings() as { id: string; r: string }[];
    return rows.find((b) => resourceRef(b.r) === ref)?.id ?? ref;
  }

  /** The live bindings under this `C`'s root (see `installation`). */
  #bindings(): unknown[] {
    return this.#o.db
      .prepare(
        `SELECT b.id, b.resource_id AS r, b.state, b.target_title AS list, b.filter_mode AS filter
           FROM bindings b JOIN installations i ON i.id = b.installation_id
          WHERE b.state <> 'removed'
            AND (b.installation_id = ?
              OR (i.root <> '' AND i.root = (SELECT root FROM installations WHERE id = ?)))
          ORDER BY b.id`,
      )
      .all(this.#o.installation, this.#o.installation);
  }

  async #tick(): Promise<void> {
    const s = this.#o.port.state();
    if (s === undefined) return;
    const now = this.#now();
    const at = iso(now);
    const cancels = new Set(Object.keys(s.cancels));
    if (!this.#recovered) {
      this.#exec.recover(cancels, at);
      this.#recovered = true;
    }
    for (const rid of cancels) this.#exec.cancel(rid, at);
    this.#noteSuperseded(s, at);
    this.#admit(s, at, cancels);
    for (const row of this.#exec.open()) this.#run(row, s);
    const events = this.#events(s, at);
    const intents = [...events, ...this.#publish(s, now, at, events.length > 0)];
    if (intents.length > 0) await this.#commit(intents);
    if (now - this.#cleanedAt >= CLEANUP_EVERY_MS) {
      this.#cleanedAt = now;
      const supersededAt = (qid: string) => this.#supersededAt(qid);
      for (const change of serviceControlCleanup(s, now, { supersededAt }))
        await this.#commit(change);
    }
  }

  /**
   * `superseded` holds no time (§2.1): the host records when it first saw it, durably, so the
   * cleanup (§9) can count the 7 days; the record goes once the question is gone.
   */
  #noteSuperseded(s: ServiceControlValidation, at: string): void {
    const prefix = `control_superseded:${this.#o.installation}:`;
    const db = this.#o.db;
    const put = db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)");
    for (const [qid, q] of Object.entries(s.questions))
      if (q.superseded !== undefined) put.run(prefix + qid, at);
    const keys = db
      .prepare("SELECT key FROM meta WHERE substr(key, 1, ?) = ?")
      .all(prefix.length, prefix) as { key: string }[];
    const del = db.prepare("DELETE FROM meta WHERE key = ?");
    for (const { key } of keys)
      if (s.questions[key.slice(prefix.length)] === undefined) del.run(key);
  }

  #supersededAt(qid: string): string | undefined {
    const row = this.#o.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(`control_superseded:${this.#o.installation}:${qid}`) as { value: string } | undefined;
    return row?.value;
  }

  #admit(s: ServiceControlValidation, at: string, cancels: ReadonlySet<string>): void {
    const unsupported = { state: "rejected" as const, code: "unsupported_op" };
    for (const [rid, r] of Object.entries(s.requests)) {
      if (this.#exec.get(rid) !== undefined) continue;
      const author = this.#o.port.authorOf("requests", rid);
      if (author === undefined) continue;
      const h = this.#o.ops?.[r.op];
      const binding = this.#local(r.binding);
      this.#exec.admit(
        {
          kind: "request",
          id: rid,
          op: r.op,
          ...(binding === undefined ? {} : { binding }),
          ...(r.generation === undefined ? {} : { generation: Number(r.generation) }),
          author: principalRef(author),
        },
        {
          cancelled: cancels.has(rid),
          check: () => (h === undefined ? unsupported : h.check?.(r, binding)),
          plan: () => h?.plan?.(r, binding) ?? [],
          now: at,
        },
      );
    }
    for (const [aid, a] of Object.entries(s.answers)) {
      if (this.#exec.get(aid) !== undefined) continue;
      const author = this.#o.port.authorOf("answers", aid);
      if (author === undefined) continue;
      const q = s.questions[a.qid];
      const h = this.#o.answer;
      const binding = this.#local(q?.binding) ?? "";
      this.#exec.admit(
        {
          kind: "answer",
          id: aid,
          questionId: a.qid,
          binding,
          generation: Number(q?.generation ?? -1),
          choice: a.choice,
          author: principalRef(author),
        },
        {
          // §10 step 1: the question it names, as it was asked (vectors: rejected{snapshot_changed}).
          check: () =>
            q === undefined || q.superseded !== undefined || q.snapshotHash !== a.snapshotHash
              ? { state: "rejected", code: "snapshot_changed" }
              : h === undefined
                ? unsupported
                : h.check?.(a, binding),
          plan: () => h?.plan?.(a, binding) ?? [],
          now: at,
        },
      );
    }
  }

  #run(row: ExecRow, s: ServiceControlValidation): void {
    if (this.#running.has(row.id) || this.#stopping) return;
    if ((this.#retry.get(row.id)?.at ?? Number.NEGATIVE_INFINITY) > this.#now()) return;
    const entry = row.kind === "request" ? s.requests[row.id] : s.answers[row.id];
    const h = row.kind === "request" ? this.#o.ops?.[row.op ?? ""] : this.#o.answer;
    if (entry === undefined || h === undefined) return;
    const effect = () =>
      this.#exec.beforeEffect(row.id, this.#o.port.state()?.cancels[row.id] !== undefined) === "go";
    const p = h
      .run({ row, entry, effect })
      .then((out) => {
        if ("repeat" in out) {
          this.#repeat.set(row.id, out.repeat);
          this.#backoff(row.id);
        } else {
          this.#repeat.delete(row.id);
          this.#retry.delete(row.id);
          this.#exec.advance(row.id, out.state, out.code);
        }
      })
      .catch((e) => {
        this.#backoff(row.id);
        this.#o.onError?.(e);
      })
      .finally(() => {
        this.#running.delete(row.id);
        if (!this.#stopped) void this.tick();
      });
    this.#running.set(row.id, p);
  }

  /** The row stays open (`executing`) and runs again after tickMs, doubling up to RETRY_MAX_MS. */
  #backoff(id: string): void {
    // Before its first effect too (A§3.3): no effect started, so a cancel still stops it.
    if (this.#exec.get(id)?.state === "accepted") this.#exec.advance(id, "executing");
    const tries = (this.#retry.get(id)?.tries ?? 0) + 1;
    const wait = Math.min(RETRY_MAX_MS, (this.#o.tickMs ?? 5000) * 2 ** (tries - 1));
    this.#retry.set(id, { tries, at: this.#now() + wait });
  }

  /** `events` from control_exec, forward only; an applied answer resolves its question. */
  #events(s: ServiceControlValidation, at: string): ServiceControlIntent[] {
    const out: ServiceControlIntent[] = [];
    for (const id of [...Object.keys(s.requests), ...Object.keys(s.answers)]) {
      const row = this.#exec.get(id);
      if (row === undefined) continue;
      const want = eventOf(row);
      const code = want.code ?? (want.state === "executing" ? this.#repeat.get(id) : undefined);
      const have = s.events[id];
      const behind =
        have === undefined || EVENT_STATES.indexOf(have.state) < EVENT_STATES.indexOf(want.state);
      const moved =
        have?.state === want.state && (have.code !== code || have.detail !== want.detail);
      if (behind || moved)
        out.push({
          intent: "event.put",
          id,
          state: want.state,
          ...(code === undefined ? {} : { code }),
          ...(want.detail === undefined ? {} : { detail: want.detail }),
          at,
        });
      const q = row.questionId === null ? undefined : s.questions[row.questionId];
      if (row.state === "applied" && q !== undefined && !q.resolved && !q.superseded)
        out.push({
          intent: "question.resolve",
          qid: row.questionId as string,
          resolved: { answerId: id, choice: row.choice ?? "", at },
        });
    }
    return out;
  }

  /**
   * `service`, `status` and `bindings/<X>` (A§3.5), only the fields that differ from `C`. A
   * binding's lifecycle fields go at once (at most once a minute per binding); its progress fields
   * (LAZY) ride on the next unit the host writes anyway. The heartbeat is written only when the
   * host has written no unit for 30 minutes, and takes the progress fields with it: the budget of
   * `C`'s history (A§3.5, E-030d).
   */
  #publish(
    s: ServiceControlValidation,
    now: number,
    at: string,
    writing: boolean,
  ): ServiceControlIntent[] {
    const out: ServiceControlIntent[] = [];
    const fresh: Record<string, unknown> = {
      ...this.#o.service(),
      protocol: {
        v: 1,
        ops: Object.keys(this.#o.ops ?? {}).sort(),
        questionKinds: [...(this.#o.questionKinds ?? [])],
      },
    };
    const service = changedFields(fresh, s.service);
    if (service !== undefined) out.push({ intent: "service.put", fields: service });
    const lazy: ServiceControlIntent[] = [];
    for (const b of this.#bindings() as BindingRow[]) {
      const ref = resourceRef(b.r);
      const st = bindingStatus(this.#o.db, b.id);
      if (ref === undefined || st === undefined) continue;
      const checked = Date.parse(st.lastCompleteCheckAt ?? "");
      const fields = changedFields(
        {
          state: b.state,
          generation: st.generation,
          list: b.list ?? "",
          filter: b.filter,
          ...(Number.isNaN(checked) ? {} : { lastCompleteCheckAt: iso(checked) }),
          pending: st.pending,
          refused: st.refused,
          unconfirmed: st.unconfirmed,
        },
        s.bindings[ref],
      );
      if (fields === undefined) continue;
      if (now - (this.#bindingWritten.get(ref) ?? Number.NEGATIVE_INFINITY) < BINDING_WRITE_MS)
        continue;
      const put = (): ServiceControlIntent => {
        this.#bindingWritten.set(ref, now);
        return { intent: "binding.put", binding: ref, fields };
      };
      if (s.bindings[ref] === undefined || Object.keys(fields).some((k) => !LAZY.has(k)))
        out.push(put());
      else lazy.push({ intent: "binding.put", binding: ref, fields });
    }
    const st = this.#o.status();
    const cur = s.status as
      | { state?: string; since?: string; heartbeatAt?: string; message?: string }
      | undefined;
    const changed = cur?.state !== st.state || cur?.message !== st.message;
    const wroteAt = this.#lastWrite() ?? Date.parse(cur?.heartbeatAt ?? "");
    const due = cur?.heartbeatAt === undefined || !(now - wroteAt < HEARTBEAT_MS);
    if (!(writing || changed || due || out.length > 0)) return out;
    for (const l of lazy) {
      if (l.intent === "binding.put") this.#bindingWritten.set(l.binding, now);
      out.push(l);
    }
    const status = changedFields(
      {
        state: st.state,
        since: changed || cur?.since === undefined ? at : cur.since,
        ...(due ? { heartbeatAt: at } : {}),
      },
      cur,
    );
    const fields = {
      ...status,
      ...(cur?.message !== st.message ? { message: st.message ?? null } : {}),
    };
    if (Object.keys(fields).length > 0) out.push({ intent: "status.put", fields });
    return out;
  }

  async #commit(intents: readonly ServiceControlIntent[]): Promise<void> {
    const r = await this.#o.port.commit(intents, `brg-c:${randomUUID()}`);
    if (r.kind === "rejected") throw new Error(`C refused the change: ${JSON.stringify(r)}`);
    this.#wroteAt = this.#now();
    this.#o.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(this.#wroteKey(), String(this.#wroteAt));
  }

  #wroteKey(): string {
    return `control_wrote_at:${this.#o.installation}`;
  }

  /** When the host last wrote a unit to `C`, across restarts; `undefined` before its first. */
  #lastWrite(): number | undefined {
    if (this.#wroteAt === undefined) {
      const row = this.#o.db
        .prepare("SELECT value FROM meta WHERE key = ?")
        .get(this.#wroteKey()) as { value: string } | undefined;
      const t = Number(row?.value);
      if (row !== undefined && Number.isFinite(t)) this.#wroteAt = t;
    }
    return this.#wroteAt;
  }
}
