/**
 * The EventKit transport (D-010 r4 §4.2, §8): RemindersTransport over the Swift helper.
 *
 * Durable stages per opKey in the host's DurableKV, written around every helper call:
 *   "sent"   before the request leaves — the effect may happen from here on;
 *   "done"   with the result, once the helper answered ok;
 *   "failed" with the code, once the helper answered an error (EventKit wrote nothing).
 * recover(opKey) reads only these stages: a "sent" without an answer is "unknown" with its opKind.
 * An unknown outcome is frozen (review PR 6, P1-1): the helper keeps no opKey journal, so resending
 * would answer list_exists / conflict_changed and erase the evidence. A call with that opKey is
 * refused with OutcomeUnknownError without sending; the host resolves the outcome (§5.7) and, if the
 * write is still wanted, supersedes the intent with a new opKey. Concurrent calls with one opKey are
 * refused with OperationInFlightError.
 * It never infers an outcome from the fields of a reminder (review r3, P2-1); whether a field
 * comparison is allowed (single-step update only) is the host's decision.
 */
import {
  type CapabilityDeclaration,
  EVENTKIT_CAPABILITIES,
} from "@openlfcp/bridge-reminders/capabilities";
import {
  type AppleItem,
  type AppleOp,
  type AppleOpResult,
  type AppleOpSuccess,
  type ChangeHint,
  type DurableKV,
  type FindQuery,
  ForbiddenListError,
  type ListCreated,
  ListExistsError,
  type ListInfo,
  type ListRef,
  OperationInFlightError,
  OutcomeUnknownError,
  type RecoverResult,
  type RemindersTransport,
  TransportReadError,
  type TransportStatus,
  type WriteScope,
} from "@openlfcp/bridge-reminders/transport";
import {
  type HelperLink,
  HelperLostError,
  HelperProcess,
  type HelperProcessOptions,
} from "./link.js";
import { mapItem, mapList, mapWriteResponse, type WireEvent, type WireResponse } from "./wire.js";

/** The helper's own write gate (hello `writes`): "bootstrap" allows lists and ownership markers only. */
export type WriteMode = "off" | "bootstrap" | "verification" | "verified";

export interface EventKitTransportOptions extends Omit<HelperProcessOptions, "onStderr"> {
  /** The helper's own write gate (hello `writes`): set from writesVerified / verification by the host. */
  readonly writes?: WriteMode;
  /** The capability flag the host reads (D-010 r4 §7.6). */
  readonly writesVerified?: boolean;
  /** For tests: supply the connection instead of launching the app. */
  readonly link?: () => Promise<HelperLink>;
  readonly onStderr?: (line: string) => void;
}

type Stage =
  | { readonly stage: "sent"; readonly kind: AppleOp["kind"] | "create_list"; readonly at: string }
  | { readonly stage: "done"; readonly result: AppleOpSuccess | ListCreated }
  | { readonly stage: "failed"; readonly code: string };

const stageKey = (opKey: string) => `op:${opKey}`;

/** EventKit transport failure outside the contract's typed results (e.g. createList refused by TCC). */
export class EventKitTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EventKitTransportError";
  }
}

export class EventKitTransport implements RemindersTransport {
  readonly id = "eventkit";
  readonly capabilities: CapabilityDeclaration;
  readonly #opts: EventKitTransportOptions;
  #link: HelperLink | undefined;
  #kv: DurableKV | undefined;
  #scope: WriteScope = { listTitlePrefixes: [], listIds: [] };
  #status: TransportStatus = {
    state: "unavailable",
    reason: "transport_disabled",
    detail: "not open",
  };
  readonly #changeCbs = new Set<(h: ChangeHint) => void>();
  readonly #systemCbs = new Set<(e: "wake" | "sleep" | "access_changed") => void>();
  #unsubs: (() => void)[] = [];
  #writes: WriteMode;
  readonly #inFlight = new Set<string>();

  constructor(opts: EventKitTransportOptions) {
    this.#opts = opts;
    this.#writes = opts.writes ?? "off";
    this.capabilities = Object.freeze({
      ...EVENTKIT_CAPABILITIES,
      // The memory backend (CI, contract tests) is strong; EventKit is best-effort.
      cas: opts.backend === "memory" ? "strong" : "best-effort",
      writesVerified: opts.writesVerified ?? false,
    });
  }

  // ---------- lifecycle ----------

  async open(ctx: {
    installationKey: string;
    state: DurableKV;
    scope: WriteScope;
  }): Promise<TransportStatus> {
    this.#kv = ctx.state;
    this.#scope = ctx.scope;
    try {
      this.#link =
        this.#opts.link !== undefined
          ? await this.#opts.link()
          : await HelperProcess.start({
              ...this.#opts,
              ...(this.#opts.onStderr ? { onStderr: this.#opts.onStderr } : {}),
            });
    } catch (e) {
      this.#status = {
        state: "unavailable",
        reason: "helper_missing",
        detail: (e as Error).message,
      };
      return this.#status;
    }
    const link = this.#link;
    this.#unsubs.push(
      link.onEvent((e) => this.#onEvent(e)),
      link.onExit((code) => {
        this.#status = { state: "unavailable", reason: "helper_crashed", detail: `exit ${code}` };
      }),
    );
    this.#status = statusOf(link.ready.authorization);
    await this.#hello();
    return this.#status;
  }

  status(): TransportStatus {
    return this.#status;
  }

  /**
   * Asks for full Reminders access (the system dialog of the helper app). Only on a person's
   * explicit command (doctor --request-access, bind): never in the background (§8.2).
   */
  async requestAccess(timeoutSec = 300): Promise<TransportStatus> {
    const r = await this.#link?.request(
      "access.request",
      { timeoutSec },
      { timeoutMs: (timeoutSec + 10) * 1000 },
    );
    if (r?.ok === true) this.#status = statusOf(String(r.authorization));
    return this.#status;
  }

  /** Changes the helper's write gate (bootstrap → verified, …); resolves once the helper confirmed it. */
  async setWriteMode(mode: WriteMode): Promise<void> {
    this.#writes = mode;
    if (this.#link !== undefined) await this.#hello();
  }

  get writeMode(): WriteMode {
    return this.#writes;
  }

  setWriteScope(scope: WriteScope): void {
    this.#scope = scope;
    void this.#hello().catch(() => {});
  }

  onChange(cb: (hint: ChangeHint) => void): () => void {
    this.#changeCbs.add(cb);
    return () => this.#changeCbs.delete(cb);
  }

  onSystem(cb: (event: "wake" | "sleep" | "access_changed") => void): () => void {
    this.#systemCbs.add(cb);
    return () => this.#systemCbs.delete(cb);
  }

  async close(): Promise<void> {
    for (const u of this.#unsubs) u();
    this.#unsubs = [];
    await this.#link?.close();
    this.#status = { state: "unavailable", reason: "transport_disabled", detail: "closed" };
  }

  async #hello(): Promise<void> {
    await this.#req("hello", {
      allowListIds: [...this.#scope.listIds],
      allowListTitlePrefixes: [...this.#scope.listTitlePrefixes],
      writes: this.#writes,
    });
  }

  #onEvent(e: WireEvent): void {
    switch (e.event) {
      case "changed":
        for (const cb of this.#changeCbs) cb({ coarse: true });
        break;
      case "access_changed":
        this.#status = statusOf(String(e.authorization));
        for (const cb of this.#systemCbs) cb("access_changed");
        break;
      case "wake":
      case "sleep":
        for (const cb of this.#systemCbs) cb(e.event);
        break;
    }
  }

  #req(op: string, body: Record<string, unknown> = {}): Promise<WireResponse> {
    if (this.#link === undefined)
      return Promise.reject(new HelperLostError("transport is not open"));
    return this.#link.request(op, body);
  }

  // ---------- reads ----------

  async #read(op: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let r: WireResponse;
    try {
      r = await this.#req(op, body);
    } catch (e) {
      throw new TransportReadError("transport_error", (e as Error).message);
    }
    if (!r.ok) throw readError(r.error.code, r.error.message);
    return r;
  }

  async lists(): Promise<{ lists: readonly ListInfo[]; complete: boolean }> {
    const r = await this.#read("lists.list", {});
    return {
      lists: (r.lists as Record<string, unknown>[]).map(mapList),
      complete: r.complete === true,
    };
  }

  async snapshot(
    list: ListRef,
  ): Promise<{ items: readonly AppleItem[]; complete: boolean; asOf: string }> {
    const r = await this.#read("items.snapshot", { list });
    return {
      items: (r.items as Record<string, unknown>[]).map(mapItem),
      complete: r.complete === true,
      asOf: String(r.asOf ?? new Date().toISOString()),
    };
  }

  async find(
    query: FindQuery,
    scope: readonly ListRef[] | "all",
  ): Promise<{ items: readonly AppleItem[]; complete: boolean }> {
    const q: Record<string, unknown> =
      "url" in query
        ? { url: query.url }
        : "urlPrefix" in query
          ? { urlPrefix: query.urlPrefix }
          : "externalId" in query
            ? { externalId: query.externalId }
            : { itemId: query.id };
    if (scope !== "all") q.lists = [...scope];
    const r = await this.#read("items.find", q);
    return {
      items: (r.items as Record<string, unknown>[]).map(mapItem),
      complete: r.complete === true,
    };
  }

  // ---------- writes ----------

  #stage(opKey: string): Stage | undefined {
    return this.#kv?.get(stageKey(opKey)) as Stage | undefined;
  }

  #put(opKey: string, s: Stage): void {
    this.#kv?.put(stageKey(opKey), s);
  }

  /** Refuses a second concurrent call and a call whose earlier attempt has an unknown outcome. */
  #claim(opKey: string): Stage | undefined {
    if (this.#inFlight.has(opKey)) throw new OperationInFlightError(opKey);
    const prior = this.#stage(opKey);
    if (prior?.stage === "sent") throw new OutcomeUnknownError(opKey, prior.kind);
    this.#inFlight.add(opKey);
    return prior;
  }

  async createList(op: { opKey: string; title: string }): Promise<ListInfo> {
    const prior = this.#claim(op.opKey);
    try {
      if (prior?.stage === "done" && "list" in prior.result) return prior.result.list;
      this.#put(op.opKey, { stage: "sent", kind: "create_list", at: new Date().toISOString() });
      const r = await this.#req("lists.create", { title: op.title, opKey: op.opKey }); // lost → stays "sent"
      lostIfTimedOut(r);
      if (!r.ok) {
        this.#put(op.opKey, { stage: "failed", code: r.error.code });
        if (r.error.code === "list_exists") throw new ListExistsError(op.title);
        if (r.error.code === "forbidden_list" || r.error.code === "writes_disabled")
          throw new ForbiddenListError(op.title);
        throw new EventKitTransportError(r.error.code, r.error.message);
      }
      const list = mapList(r.list as Record<string, unknown>);
      this.#put(op.opKey, { stage: "done", result: { ok: true, opKey: op.opKey, list } });
      return list;
    } finally {
      this.#inFlight.delete(op.opKey);
    }
  }

  async apply(op: AppleOp): Promise<AppleOpResult> {
    const prior = this.#claim(op.opKey);
    try {
      if (prior?.stage === "done" && "ref" in prior.result)
        return { ...prior.result, existing: true };
      const [name, body] = request(op);
      this.#put(op.opKey, { stage: "sent", kind: op.kind, at: new Date().toISOString() });
      // A lost answer (helper gone, timeout) rejects here and leaves the stage at "sent".
      const r = await this.#req(name, body);
      lostIfTimedOut(r);
      const result = mapWriteResponse(op.opKey, r);
      if (result.ok) this.#put(op.opKey, { stage: "done", result });
      else this.#put(op.opKey, { stage: "failed", code: result.code });
      return result;
    } finally {
      this.#inFlight.delete(op.opKey);
    }
  }

  async recover(opKey: string): Promise<RecoverResult> {
    const s = this.#stage(opKey);
    if (s === undefined || s.stage === "failed") return { state: "not_started" };
    if (s.stage === "done") return { state: "done", result: s.result };
    return { state: "unknown", stage: "sent", opKind: s.kind };
  }
}

/**
 * eventkit_timeout: the helper stopped waiting on a store call that may still complete (it then
 * starts over on a new store). That is a lost answer, not a refusal: the stage stays "sent", so
 * recover says unknown and the executor quarantines it, never resends it.
 */
function lostIfTimedOut(r: WireResponse): void {
  if (!r.ok && r.error.code === "eventkit_timeout")
    throw new HelperLostError(`the helper gave up on the operation: ${r.error.message}`);
}

function request(op: AppleOp): [string, Record<string, unknown>] {
  switch (op.kind) {
    case "create":
      return ["items.create", { list: op.list, linkUrl: op.linkUrl, opKey: op.opKey, set: op.set }];
    case "update":
      return ["items.update", { ref: op.ref, set: op.set, opKey: op.opKey, expect: op.expect }];
    case "restore_url":
      return [
        "items.restoreUrl",
        { ref: op.ref, linkUrl: op.linkUrl, opKey: op.opKey, expect: op.expect },
      ];
    case "marker_create":
      return ["markers.create", { list: op.list, markerUrl: op.markerUrl, opKey: op.opKey }];
    case "marker_retire":
      return [
        "markers.retire",
        { ref: op.ref, markerUrl: op.markerUrl, opKey: op.opKey, expect: op.expect },
      ];
  }
}

export function statusOf(authorization: string): TransportStatus {
  switch (authorization) {
    case "fullAccess":
      return { state: "ok" };
    case "notDetermined":
      return { state: "needs_human", reason: "tcc_not_determined" };
    case "denied":
      return { state: "needs_human", reason: "tcc_denied" };
    case "restricted":
      return { state: "needs_human", reason: "tcc_restricted" };
    case "writeOnly":
      return { state: "needs_human", reason: "tcc_write_only" };
    default:
      return {
        state: "unavailable",
        reason: "unknown_response",
        detail: `authorization ${authorization}`,
      };
  }
}

function readError(code: string, message: string): TransportReadError {
  if (code === "list_not_found") return new TransportReadError("list_not_found", message);
  if (code === "tcc_denied" || code === "tcc_restricted" || code === "tcc_write_only")
    return new TransportReadError("tcc_denied", message);
  if (code === "tcc_not_determined") return new TransportReadError("tcc_not_determined", message);
  return new TransportReadError("transport_error", `${code}: ${message}`);
}
