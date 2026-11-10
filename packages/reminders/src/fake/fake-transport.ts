/**
 * In-memory Reminders transport for tests (D-010 r4 §10.2).
 *
 * - FakeStore is the "Apple account": it survives transport restarts and is shared by
 *   several FakeTransport instances (two bridges, a restarted bridge).
 * - FakePerson edits reminders the way a person does in Reminders, personal fields included.
 * - Faults: lost responses after the effect, transient failures, incomplete reads, and a
 *   hook between the expect check and the save (where EventKit's best-effort CAS is weak).
 * - Capabilities are configurable: cas "strong" | "best-effort", recover "exact" | "stages".
 */
import { type CapabilityDeclaration, EVENTKIT_CAPABILITIES } from "../capabilities.js";
import {
  type Alarm,
  type AppleItem,
  type AppleOp,
  type AppleOpResult,
  type AppleOpSuccess,
  type ChangeHint,
  type DurableKV,
  type FindQuery,
  ForbiddenListError,
  type ItemRef,
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
  type WritableSet,
  type WriteScope,
  type WrittenFields,
} from "../transport.js";
import {
  isLocalDate,
  isMarkerUrl,
  isTaskLink,
  type LocalDate,
  localDate,
  type TimeOfDay,
} from "../values.js";

/** A reminder as the fake account stores it (mutable copy of AppleItem). */
interface StoredItem {
  id: string;
  externalId: string;
  list: ListRef;
  linkUrl?: string;
  title: string;
  completed: boolean;
  completionDate?: string;
  priority: number;
  due?: { date: LocalDate; time?: TimeOfDay; tz?: string };
  alarms: Alarm[];
  hasNotes: boolean;
  hasRecurrence: boolean;
  rev: string;
}

const MARKER_TITLE = "LFCP bridge · не удалять";

/** The fake Apple account: lists, reminders, and (for recover "exact") the operations it applied. */
export class FakeStore {
  readonly lists = new Map<string, ListInfo>();
  readonly items = new Map<string, StoredItem>();
  /** opKey -> result, the store's own record of applied operations (CloudKit-like recover). */
  readonly applied = new Map<string, AppleOpSuccess | ListCreated>();
  #counter = 0;
  #listeners = new Set<(itemIds: readonly string[]) => void>();
  /** "today" for completion dates; tests may pin it. */
  today: () => LocalDate = () => localDate(new Date().toISOString().slice(0, 10));

  constructor() {
    this.addList("Reminders", { isDefault: true });
  }

  nextId(prefix: string): string {
    this.#counter += 1;
    return `${prefix}${this.#counter}`;
  }

  nextRev(): string {
    return this.nextId("rev-");
  }

  addList(title: string, opts: { isDefault?: boolean; readOnly?: boolean } = {}): ListInfo {
    const l: ListInfo = {
      id: this.nextId("L") as ListRef,
      title,
      source: { title: "Fake", type: "local" },
      allowsContentModifications: !opts.readOnly,
      isDefault: opts.isDefault ?? false,
    };
    this.lists.set(l.id, l);
    return l;
  }

  subscribe(cb: (itemIds: readonly string[]) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  /** Every write notifies every transport, own writes included (like EKEventStoreChanged). */
  changed(itemIds: readonly string[]): void {
    for (const cb of [...this.#listeners]) setTimeout(() => cb(itemIds), 0);
  }

  view(it: StoredItem): AppleItem {
    return structuredClone({
      ref: { id: it.id, externalId: it.externalId },
      list: it.list,
      ...(it.linkUrl === undefined ? {} : { linkUrl: it.linkUrl }),
      title: it.title,
      completed: it.completed,
      ...(it.completionDate === undefined ? {} : { completionDate: it.completionDate }),
      priority: it.priority,
      ...(it.due === undefined ? {} : { due: it.due }),
      alarms: it.alarms,
      hasNotes: it.hasNotes,
      hasRecurrence: it.hasRecurrence,
      rev: it.rev,
    }) as AppleItem;
  }

  resolve(ref: ItemRef): StoredItem | "ambiguous" | undefined {
    if (ref.id !== undefined) {
      const it = this.items.get(ref.id);
      if (it !== undefined) return it;
    }
    if (ref.externalId !== undefined) {
      const hits = [...this.items.values()].filter((i) => i.externalId === ref.externalId);
      if (hits.length > 1) return "ambiguous";
      return hits[0];
    }
    return undefined;
  }
}

/** Edits made by the person in Reminders: anything, including personal data. */
export class FakePerson {
  constructor(readonly store: FakeStore) {}

  createList(title: string, opts: { readOnly?: boolean } = {}): ListInfo {
    const l = this.store.addList(title, opts);
    this.store.changed([]);
    return l;
  }

  renameList(list: ListRef, title: string): void {
    const l = this.store.lists.get(list);
    if (l === undefined) throw new Error(`no list ${list}`);
    this.store.lists.set(list, { ...l, title });
    this.store.changed([]);
  }

  deleteList(list: ListRef): void {
    this.store.lists.delete(list);
    for (const [id, it] of this.store.items) if (it.list === list) this.store.items.delete(id);
    this.store.changed([]);
  }

  create(
    list: ListRef,
    title: string,
    opts: { url?: string; completed?: boolean } = {},
  ): AppleItem {
    const id = this.store.nextId("R");
    const it: StoredItem = {
      id,
      externalId: this.store.nextId("X"),
      list,
      title,
      completed: opts.completed ?? false,
      priority: 0,
      alarms: [],
      hasNotes: false,
      hasRecurrence: false,
      rev: this.store.nextRev(),
      ...(opts.url === undefined ? {} : { linkUrl: opts.url }),
    };
    this.store.items.set(id, it);
    this.store.changed([id]);
    return this.store.view(it);
  }

  edit(
    ref: ItemRef,
    e: {
      title?: string;
      completed?: boolean;
      priority?: number;
      dueDate?: string | null;
      dueTime?: string | null;
      tz?: string;
      notes?: boolean;
      recurrence?: boolean;
      addAlarm?: Alarm;
      clearAlarms?: boolean;
      url?: string | null;
      moveTo?: ListRef;
      changeId?: boolean;
    },
  ): AppleItem {
    const it = this.#get(ref);
    if (e.title !== undefined) it.title = e.title;
    if (e.completed !== undefined) {
      it.completed = e.completed;
      if (e.completed) it.completionDate = new Date().toISOString();
      else delete it.completionDate;
    }
    if (e.priority !== undefined) it.priority = e.priority;
    if (e.dueDate === null) delete it.due;
    else if (e.dueDate !== undefined) it.due = { ...(it.due ?? {}), date: localDate(e.dueDate) };
    if (e.dueTime === null && it.due !== undefined) it.due = { date: it.due.date };
    else if (e.dueTime !== undefined) {
      if (it.due === undefined) throw new Error("dueTime needs a due date");
      it.due = { date: it.due.date, time: e.dueTime as TimeOfDay, tz: e.tz ?? "UTC" };
    }
    if (e.notes !== undefined) it.hasNotes = e.notes;
    if (e.recurrence !== undefined) it.hasRecurrence = e.recurrence;
    if (e.clearAlarms) it.alarms = [];
    if (e.addAlarm !== undefined) it.alarms.push(e.addAlarm);
    if (e.url === null) delete it.linkUrl;
    else if (e.url !== undefined) it.linkUrl = e.url;
    if (e.moveTo !== undefined) it.list = e.moveTo;
    if (e.changeId) {
      // calendarItemIdentifier churn (obssync): same reminder, new local id.
      this.store.items.delete(it.id);
      it.id = this.store.nextId("R");
      this.store.items.set(it.id, it);
    }
    it.rev = this.store.nextRev();
    this.store.changed([it.id]);
    return this.store.view(it);
  }

  delete(ref: ItemRef): void {
    const it = this.#get(ref);
    this.store.items.delete(it.id);
    this.store.changed([it.id]);
  }

  #get(ref: ItemRef): StoredItem {
    const it = this.store.resolve(ref);
    if (it === undefined || it === "ambiguous")
      throw new Error(`person: no single reminder for ${JSON.stringify(ref)}`);
    return it;
  }
}

/** Faults a test arms on a FakeTransport. */
export class FakeFaults {
  /** The next write is applied, then its answer is lost (the call rejects). */
  loseNextResponse = 0;
  /** The next write fails before any effect with this code. */
  failNext: { code: "store_conflict" | "transport_error"; times: number } | undefined;
  /** Reads report complete: false. */
  incompleteReads = false;
  /** Runs after the expect check and before the save (the person edits in that window). */
  beforeSave: ((ref: ItemRef) => void) | undefined;
  /** The next write waits for this before its effect: meanwhile its opKey is in flight. */
  stallNextWrite: Promise<void> | undefined;
}

export class ResponseLostError extends Error {
  constructor(readonly opKey: string) {
    super(`response for ${opKey} lost after the effect`);
    this.name = "ResponseLostError";
  }
}

export interface FakeTransportOptions {
  readonly capabilities?: Partial<Omit<CapabilityDeclaration, "transport">>;
}

export class FakeTransport implements RemindersTransport {
  readonly id = "fake";
  readonly capabilities: CapabilityDeclaration;
  readonly faults = new FakeFaults();
  #status: TransportStatus = {
    state: "unavailable",
    reason: "transport_disabled",
    detail: "not open",
  };
  #kv: DurableKV | undefined;
  readonly #inFlight = new Set<string>();
  #scope: WriteScope = { listTitlePrefixes: [], listIds: [] };
  #changeCbs = new Set<(h: ChangeHint) => void>();
  #systemCbs = new Set<(e: "wake" | "sleep" | "access_changed") => void>();
  #unsubscribe: (() => void) | undefined;

  constructor(
    readonly store: FakeStore,
    opts: FakeTransportOptions = {},
  ) {
    this.capabilities = Object.freeze({
      ...EVENTKIT_CAPABILITIES,
      transport: "fake",
      writesVerified: true,
      ...opts.capabilities,
    });
  }

  // MARK: lifecycle

  async open(ctx: {
    installationKey: string;
    state: DurableKV;
    scope: WriteScope;
  }): Promise<TransportStatus> {
    this.#kv = ctx.state;
    this.#scope = ctx.scope;
    this.#unsubscribe = this.store.subscribe((ids) => {
      const hint: ChangeHint =
        this.capabilities.changes === "coarse" ? { coarse: true } : { coarse: false, itemIds: ids };
      for (const cb of this.#changeCbs) cb(hint);
    });
    this.#status = { state: "ok" };
    return this.#status;
  }

  status(): TransportStatus {
    return this.#status;
  }

  /** Test hook: simulate TCC or helper states. */
  setStatus(s: TransportStatus): void {
    this.#status = s;
    for (const cb of this.#systemCbs) cb("access_changed");
  }

  /** Test hook: a system event (wake/sleep). */
  emitSystem(e: "wake" | "sleep"): void {
    for (const cb of this.#systemCbs) cb(e);
  }

  setWriteScope(scope: WriteScope): void {
    this.#scope = scope;
  }

  onChange(cb: (hint: ChangeHint) => void): () => void {
    this.#changeCbs.add(cb);
    return () => this.#changeCbs.delete(cb);
  }

  onSystem(cb: (e: "wake" | "sleep" | "access_changed") => void): () => void {
    this.#systemCbs.add(cb);
    return () => this.#systemCbs.delete(cb);
  }

  async close(): Promise<void> {
    this.#unsubscribe?.();
    this.#status = { state: "unavailable", reason: "transport_disabled", detail: "closed" };
  }

  // MARK: reads

  #requireOk(): void {
    if (this.#status.state !== "ok")
      throw new TransportReadError("not_ready", `transport is ${this.#status.state}`);
  }

  async lists(): Promise<{ lists: readonly ListInfo[]; complete: boolean }> {
    this.#requireOk();
    return {
      lists: [...this.store.lists.values()].map((l) => ({ ...l })),
      complete: !this.faults.incompleteReads,
    };
  }

  async snapshot(
    list: ListRef,
  ): Promise<{ items: readonly AppleItem[]; complete: boolean; asOf: string }> {
    this.#requireOk();
    if (!this.store.lists.has(list))
      throw new TransportReadError("list_not_found", `no list ${list}`);
    const items = [...this.store.items.values()]
      .filter((i) => i.list === list)
      .map((i) => this.store.view(i));
    return { items, complete: !this.faults.incompleteReads, asOf: new Date().toISOString() };
  }

  async find(
    q: FindQuery,
    scope: readonly ListRef[] | "all",
  ): Promise<{ items: readonly AppleItem[]; complete: boolean }> {
    this.#requireOk();
    const lists = scope === "all" ? undefined : new Set<string>(scope);
    const items = [...this.store.items.values()]
      .filter((i) => lists === undefined || lists.has(i.list))
      .filter((i) => {
        if ("url" in q) return i.linkUrl === q.url;
        if ("urlPrefix" in q) return i.linkUrl?.startsWith(q.urlPrefix) ?? false;
        if ("externalId" in q) return i.externalId === q.externalId;
        return i.id === q.id;
      })
      .map((i) => this.store.view(i));
    return { items, complete: !this.faults.incompleteReads };
  }

  // MARK: writes

  #allowed(list: ListInfo): boolean {
    return (
      this.#scope.listIds.includes(list.id) ||
      this.#scope.listTitlePrefixes.some((p) => list.title.startsWith(p))
    );
  }

  #stage(opKey: string, value: unknown): void {
    if (this.capabilities.recover === "stages") this.#kv?.put(`op:${opKey}`, value);
  }

  /**
   * Refuses, without sending, a call while another with its opKey is in flight, and (stages
   * recover) one whose earlier attempt is still "sent": its outcome is unknown.
   */
  #claim(opKey: string, kind: string): void {
    if (this.#inFlight.has(opKey)) throw new OperationInFlightError(opKey);
    if (this.capabilities.recover === "stages") {
      const s = this.#kv?.get(`op:${opKey}`) as { stage?: string; kind?: string } | undefined;
      if (s?.stage === "sent") throw new OutcomeUnknownError(opKey, s.kind ?? kind);
    }
    this.#inFlight.add(opKey);
  }

  async #stall(): Promise<void> {
    const stall = this.faults.stallNextWrite;
    if (stall === undefined) return;
    this.faults.stallNextWrite = undefined;
    await stall;
  }

  async createList(op: { opKey: string; title: string }): Promise<ListInfo> {
    this.#requireOk();
    this.#claim(op.opKey, "create_list");
    try {
      return await this.#createList(op);
    } finally {
      this.#inFlight.delete(op.opKey);
    }
  }

  async #createList(op: { opKey: string; title: string }): Promise<ListInfo> {
    const done = this.store.applied.get(op.opKey);
    if (done !== undefined && "list" in done) return done.list;
    if (!this.#scope.listTitlePrefixes.some((p) => op.title.startsWith(p))) {
      throw new ForbiddenListError(op.title);
    }
    if ([...this.store.lists.values()].some((l) => l.title === op.title))
      throw new ListExistsError(op.title);
    await this.#stall();
    this.#stage(op.opKey, { stage: "sent", kind: "create_list" });
    const list = this.store.addList(op.title);
    this.#scope = { ...this.#scope, listIds: [...this.#scope.listIds, list.id] };
    const result: ListCreated = { ok: true, opKey: op.opKey, list };
    this.store.applied.set(op.opKey, result);
    this.store.changed([]);
    this.#afterEffect(op.opKey, result);
    return list;
  }

  async apply(op: AppleOp): Promise<AppleOpResult> {
    this.#claim(op.opKey, op.kind);
    try {
      return await this.#apply(op);
    } finally {
      this.#inFlight.delete(op.opKey);
    }
  }

  async #apply(op: AppleOp): Promise<AppleOpResult> {
    if (this.#status.state !== "ok") {
      return this.#fail(op.opKey, "transport_error", false, `transport is ${this.#status.state}`);
    }
    if (this.faults.failNext !== undefined && this.faults.failNext.times > 0) {
      this.faults.failNext.times -= 1;
      const code = this.faults.failNext.code;
      return this.#fail(op.opKey, code, code === "store_conflict", "injected failure");
    }
    const prior = this.store.applied.get(op.opKey);
    if (prior !== undefined && !("list" in prior)) return { ...prior, existing: true };

    await this.#stall();
    this.#stage(op.opKey, { stage: "sent", kind: op.kind });
    const result = this.#effect(op);
    if (result.ok) {
      this.store.applied.set(op.opKey, result);
      this.#afterEffect(op.opKey, result);
    } else {
      this.#stage(op.opKey, { stage: "failed", code: result.code });
    }
    return result;
  }

  /** Records the "done" stage, or loses the answer (the effect stays). */
  #afterEffect(opKey: string, result: AppleOpSuccess | ListCreated): void {
    if (this.faults.loseNextResponse > 0) {
      this.faults.loseNextResponse -= 1;
      throw new ResponseLostError(opKey);
    }
    this.#stage(opKey, { stage: "done", result });
  }

  async recover(opKey: string): Promise<RecoverResult> {
    if (this.capabilities.recover === "exact") {
      const r = this.store.applied.get(opKey);
      return r === undefined ? { state: "not_started" } : { state: "done", result: r };
    }
    const s = this.#kv?.get(`op:${opKey}`) as
      | { stage: string; result?: AppleOpSuccess | ListCreated }
      | undefined;
    if (s === undefined || s.stage === "failed") return { state: "not_started" };
    if (s.stage === "done" && s.result !== undefined) return { state: "done", result: s.result };
    return { state: "unknown", stage: s.stage };
  }

  #fail(
    opKey: string,
    code: Exclude<Extract<AppleOpResult, { ok: false }>["code"], "conflict_changed">,
    retryable: boolean,
    message: string,
  ): AppleOpResult {
    return { ok: false, opKey, code, retryable, message };
  }

  #effect(op: AppleOp): AppleOpResult {
    switch (op.kind) {
      case "create":
        return this.#create(op);
      case "update":
        return this.#update(op);
      case "restore_url":
        return this.#restoreUrl(op);
      case "marker_create":
        return this.#markerCreate(op);
      case "marker_retire":
        return this.#markerRetire(op);
    }
  }

  #writableList(opKey: string, id: ListRef): ListInfo | AppleOpResult {
    const list = this.store.lists.get(id);
    if (list === undefined) return this.#fail(opKey, "list_not_found", false, `no list ${id}`);
    if (!this.#allowed(list) || !list.allowsContentModifications) {
      return this.#fail(
        opKey,
        "forbidden_list",
        false,
        `list "${list.title}" is not writable by the bridge`,
      );
    }
    return list;
  }

  #validate(opKey: string, set: WritableSet): AppleOpResult | undefined {
    if (set.title !== undefined && set.title.trim() === "")
      return this.#fail(opKey, "invalid", false, "empty title");
    if (set.priority !== undefined && ![0, 1, 9].includes(set.priority)) {
      return this.#fail(opKey, "invalid", false, "priority must be 0, 1 or 9");
    }
    if (set.dueDate != null && !isLocalDate(set.dueDate))
      return this.#fail(opKey, "invalid", false, "bad dueDate");
    if (
      set.completed?.date !== undefined &&
      (!set.completed.value || !isLocalDate(set.completed.date))
    ) {
      return this.#fail(opKey, "invalid", false, "completed.date needs value true and YYYY-MM-DD");
    }
    return undefined;
  }

  #resolve(opKey: string, ref: ItemRef): StoredItem | AppleOpResult {
    const it = this.store.resolve(ref);
    if (it === "ambiguous")
      return this.#fail(opKey, "ambiguous", false, "externalId matches several reminders");
    if (it === undefined) return this.#fail(opKey, "not_found", false, "no reminder for ref");
    return it;
  }

  #success(
    opKey: string,
    it: StoredItem,
    written: WrittenFields,
    extra: Partial<AppleOpSuccess> = {},
  ): AppleOpSuccess {
    return {
      ok: true,
      opKey,
      ref: { id: it.id, externalId: it.externalId },
      rev: it.rev,
      written,
      ...extra,
    };
  }

  /** Applies only the set fields. Returns the written values or a personal conflict. */
  #applySet(
    it: StoredItem,
    set: WritableSet,
    warnings: string[],
  ): WrittenFields | "personal_conflict" | "recurrence" {
    const written: { -readonly [K in keyof WrittenFields]: WrittenFields[K] } = {};
    if (set.dueDate === null && it.due !== undefined) {
      if (it.due.time !== undefined || it.alarms.length > 0) return "personal_conflict";
      if (it.hasRecurrence) return "recurrence";
    }
    if (set.title !== undefined) {
      it.title = set.title;
      written.title = it.title;
    }
    if (set.priority !== undefined) {
      it.priority = set.priority;
      written.priority = it.priority;
    }
    if (set.completed !== undefined) {
      if (set.completed.value) {
        const d = set.completed.date;
        const today = this.store.today();
        if (d !== undefined && d !== today) {
          it.completionDate = `${d}T12:00:00.000Z`;
        } else if (d !== undefined) {
          // An explicit "today" replaces an older completion date (done(cd1) → done(today)).
          if (it.completionDate?.slice(0, 10) !== today)
            it.completionDate = new Date().toISOString();
        } else if (!it.completed || it.completionDate === undefined) {
          it.completionDate = new Date().toISOString();
        }
        it.completed = true;
      } else {
        it.completed = false;
        delete it.completionDate;
      }
      written.completed = {
        value: it.completed,
        ...(it.completionDate === undefined ? {} : { completionDate: it.completionDate }),
      };
    }
    if (set.dueDate !== undefined) {
      if (set.dueDate === null) delete it.due;
      else if (it.due === undefined) it.due = { date: set.dueDate };
      else if (it.due.date !== set.dueDate) {
        const old = it.due.date;
        it.due = { ...it.due, date: set.dueDate }; // time, zone and alarms stay (B2, B15)
        if (it.alarms.some((a) => a.kind === "absolute" && a.at.slice(0, 10) === old))
          warnings.push("alarm_on_old_date");
      }
      written.dueDate = it.due?.date ?? null;
    }
    return written;
  }

  #create(op: Extract<AppleOp, { kind: "create" }>): AppleOpResult {
    if (!isTaskLink(op.linkUrl))
      return this.#fail(op.opKey, "invalid", false, "linkUrl must be lfcp://task/…");
    if (op.set.title === undefined)
      return this.#fail(op.opKey, "invalid", false, "create needs set.title");
    const bad = this.#validate(op.opKey, op.set);
    if (bad !== undefined) return bad;
    const list = this.#writableList(op.opKey, op.list);
    if ("ok" in list) return list;
    // Idempotency by link (EventKit's only defence when the opKey record is lost).
    const existing = [...this.store.items.values()].find(
      (i) => i.list === op.list && i.linkUrl === op.linkUrl,
    );
    if (existing !== undefined) {
      return this.#success(
        op.opKey,
        existing,
        { linkUrl: op.linkUrl, title: existing.title },
        { existing: true },
      );
    }
    const it: StoredItem = {
      id: this.store.nextId("R"),
      externalId: this.store.nextId("X"),
      list: op.list,
      linkUrl: op.linkUrl,
      title: "",
      completed: false,
      priority: 0,
      alarms: [],
      hasNotes: false,
      hasRecurrence: false,
      rev: "",
    };
    const warnings: string[] = [];
    const written = this.#applySet(it, op.set, warnings);
    if (typeof written === "string") return this.#fail(op.opKey, "invalid", false, written);
    it.rev = this.store.nextRev();
    this.store.items.set(it.id, it);
    this.store.changed([it.id]);
    return this.#success(op.opKey, it, { ...written, linkUrl: op.linkUrl });
  }

  #checkWrite(opKey: string, ref: ItemRef, rev: string): StoredItem | AppleOpResult {
    const it = this.#resolve(opKey, ref);
    if ("ok" in it) return it;
    if (it.rev !== rev) {
      return {
        ok: false,
        opKey,
        code: "conflict_changed",
        retryable: true,
        fresh: this.store.view(it),
      };
    }
    const list = this.#writableList(opKey, it.list);
    if ("ok" in list) return list;
    return it;
  }

  /**
   * Best-effort CAS: the person's edit in the window lands, then only the set fields are written
   * over it (other fields survive). Strong CAS: an edit in the window fails the write.
   */
  #window(opKey: string, ref: ItemRef, checked: StoredItem): StoredItem | AppleOpResult {
    if (this.faults.beforeSave === undefined) return checked;
    const hook = this.faults.beforeSave;
    this.faults.beforeSave = undefined;
    const revBefore = checked.rev;
    hook(ref);
    const now = this.#resolve(opKey, ref);
    if ("ok" in now) return now;
    if (this.capabilities.cas === "strong" && now.rev !== revBefore) {
      return {
        ok: false,
        opKey,
        code: "conflict_changed",
        retryable: true,
        fresh: this.store.view(now),
      };
    }
    return now;
  }

  #update(op: Extract<AppleOp, { kind: "update" }>): AppleOpResult {
    const bad = this.#validate(op.opKey, op.set);
    if (bad !== undefined) return bad;
    const checked = this.#checkWrite(op.opKey, op.ref, op.expect.rev);
    if ("ok" in checked) return checked;
    const it = this.#window(op.opKey, op.ref, checked);
    if ("ok" in it) return it;
    const before = structuredClone(it);
    const warnings: string[] = [];
    const written = this.#applySet(it, op.set, warnings);
    if (written === "personal_conflict" || written === "recurrence") {
      Object.assign(it, before);
      return written === "personal_conflict"
        ? this.#fail(op.opKey, "personal_conflict", false, "due has a time of day or alarms")
        : {
            ok: false,
            opKey: op.opKey,
            code: "transport_error",
            retryable: false,
            message: "a recurring reminder requires a due date",
            native: { domain: "EKErrorDomain", code: 14 },
          };
    }
    it.rev = this.store.nextRev();
    this.store.changed([it.id]);
    return this.#success(op.opKey, it, written, warnings.length > 0 ? { warnings } : {});
  }

  #restoreUrl(op: Extract<AppleOp, { kind: "restore_url" }>): AppleOpResult {
    if (!isTaskLink(op.linkUrl))
      return this.#fail(op.opKey, "invalid", false, "linkUrl must be lfcp://task/…");
    const it = this.#checkWrite(op.opKey, op.ref, op.expect.rev);
    if ("ok" in it) return it;
    if (it.linkUrl === op.linkUrl) return this.#success(op.opKey, it, { linkUrl: op.linkUrl });
    if (it.linkUrl !== undefined && it.linkUrl !== "") {
      return this.#fail(op.opKey, "personal_conflict", false, "the reminder has another URL");
    }
    it.linkUrl = op.linkUrl;
    it.rev = this.store.nextRev();
    this.store.changed([it.id]);
    return this.#success(op.opKey, it, { linkUrl: op.linkUrl });
  }

  #markerCreate(op: Extract<AppleOp, { kind: "marker_create" }>): AppleOpResult {
    if (!isMarkerUrl(op.markerUrl))
      return this.#fail(op.opKey, "invalid", false, "markerUrl must be lfcp://bridge/…");
    const list = this.#writableList(op.opKey, op.list);
    if ("ok" in list) return list;
    const existing = [...this.store.items.values()].find(
      (i) => i.list === op.list && i.linkUrl === op.markerUrl,
    );
    if (existing !== undefined)
      return this.#success(op.opKey, existing, { linkUrl: op.markerUrl }, { existing: true });
    const it: StoredItem = {
      id: this.store.nextId("R"),
      externalId: this.store.nextId("X"),
      list: op.list,
      linkUrl: op.markerUrl,
      title: MARKER_TITLE,
      completed: true,
      completionDate: new Date().toISOString(),
      priority: 0,
      alarms: [],
      hasNotes: false,
      hasRecurrence: false,
      rev: this.store.nextRev(),
    };
    this.store.items.set(it.id, it);
    this.store.changed([it.id]);
    return this.#success(op.opKey, it, { linkUrl: op.markerUrl, title: MARKER_TITLE });
  }

  #markerRetire(op: Extract<AppleOp, { kind: "marker_retire" }>): AppleOpResult {
    const it = this.#checkWrite(op.opKey, op.ref, op.expect.rev);
    if ("ok" in it) return it;
    if (!isMarkerUrl(it.linkUrl) || it.linkUrl !== op.markerUrl) {
      return this.#fail(op.opKey, "forbidden_list", false, "only the exact marker can be retired");
    }
    this.store.items.delete(it.id);
    this.store.changed([it.id]);
    return this.#success(op.opKey, it, {});
  }
}
