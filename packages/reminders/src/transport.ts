/**
 * The Reminders transport contract (D-010 r3 §4.2). One adapter, replaceable transports:
 * EventKit (Swift helper) now, CloudKit Web later (B9), a fake for tests.
 *
 * Rules every transport keeps (checked by test-support/contract.ts):
 * - Completeness: `snapshot` and `find` are either complete or say `complete: false`.
 * - Every write carries `opKey` (the bridge's intent id); auxiliary record ids derive from it.
 *   `recover(opKey)` answers "done" only when the whole operation is confirmed.
 * - `written` holds the stored values of exactly the written fields; the bridge's bases come from it.
 * - Personal data (notes, time of day, zone, alarms, recurrence, a URL the person set) is never written.
 *   The bridge never deletes reminders (B11); only its own markers can be retired.
 */
import type { CapabilityDeclaration } from "./capabilities.js";
import type { LocalDate, TimeOfDay } from "./values.js";

export type ListRef = string & { readonly __listRef: unique symbol };

/** A reminder reference: `id` is a cache in EventKit; `externalId` is the second key. */
export interface ItemRef {
  readonly id?: string;
  readonly externalId?: string;
}

export interface ListInfo {
  readonly id: ListRef;
  readonly title: string;
  readonly source: { readonly title: string; readonly type: string };
  readonly allowsContentModifications: boolean;
  readonly isDefault: boolean;
}

export type Alarm =
  | { readonly kind: "absolute"; readonly at: string }
  | { readonly kind: "relative"; readonly relativeSec: number }
  | {
      readonly kind: "location";
      readonly title?: string;
      readonly proximity: "enter" | "leave" | "none";
    };

export interface Due {
  readonly date: LocalDate;
  /** Personal (B2): never part of the synchronized projection. */
  readonly time?: TimeOfDay;
  readonly tz?: string;
}

export interface AppleItem {
  readonly ref: { readonly id: string; readonly externalId?: string };
  readonly list: ListRef;
  /** url (EventKit) or the URL attachment (CloudKit). */
  readonly linkUrl?: string;
  readonly title: string;
  readonly completed: boolean;
  /** ISO 8601 instant. */
  readonly completionDate?: string;
  /** 0..9 as stored. */
  readonly priority: number;
  readonly due?: Due;
  readonly alarms: readonly Alarm[];
  readonly hasNotes: boolean;
  readonly hasRecurrence: boolean;
  /** Opaque revision: compared for equality only. */
  readonly rev: string;
}

/** Fields the bridge may write (B13: priority buckets 0, 1, 9). */
export interface WritableSet {
  readonly title?: string;
  readonly completed?: { readonly value: boolean; readonly date?: LocalDate };
  /** A date change keeps time, zone and alarms (B2, B15). null with a time or any alarm → personal_conflict (B12). */
  readonly dueDate?: LocalDate | null;
  readonly priority?: 0 | 1 | 9;
}

/** The stored values of exactly the fields an operation wrote. */
export interface WrittenFields {
  readonly title?: string;
  readonly completed?: { readonly value: boolean; readonly completionDate?: string };
  readonly dueDate?: LocalDate | null;
  readonly priority?: number;
  readonly linkUrl?: string;
}

export type AppleOp =
  | {
      readonly opKey: string;
      readonly kind: "create";
      readonly list: ListRef;
      readonly linkUrl: string;
      readonly set: WritableSet;
    }
  | {
      readonly opKey: string;
      readonly kind: "update";
      readonly ref: ItemRef;
      readonly set: WritableSet;
      readonly expect: { readonly rev: string };
    }
  | {
      readonly opKey: string;
      readonly kind: "restore_url";
      readonly ref: ItemRef;
      readonly linkUrl: string;
      readonly expect: { readonly rev: string };
    }
  | {
      readonly opKey: string;
      readonly kind: "marker_create";
      readonly list: ListRef;
      readonly markerUrl: string;
    }
  | {
      readonly opKey: string;
      readonly kind: "marker_retire";
      readonly ref: ItemRef;
      readonly markerUrl: string;
      readonly expect: { readonly rev: string };
    };

export type ApplyErrorCode =
  | "personal_conflict"
  | "not_found"
  | "list_not_found"
  | "forbidden_list"
  | "store_conflict"
  | "transport_error"
  | "invalid"
  | "partial"
  | "ambiguous";

export type AppleOpResult =
  | {
      readonly ok: true;
      readonly opKey: string;
      readonly ref: { readonly id: string; readonly externalId?: string };
      readonly rev: string;
      readonly written: WrittenFields;
      /** create / marker_create found the record already there (idempotent repeat). */
      readonly existing?: boolean;
      /** Non-fatal notes for the journal, e.g. "alarm_on_old_date". */
      readonly warnings?: readonly string[];
    }
  | {
      readonly ok: false;
      readonly opKey: string;
      readonly code: "conflict_changed";
      readonly retryable: true;
      readonly fresh: AppleItem;
    }
  | {
      readonly ok: false;
      readonly opKey: string;
      readonly code: ApplyErrorCode;
      readonly retryable: boolean;
      readonly message: string;
      /** Multi-step operations: the last stage reached. */
      readonly stage?: string;
      readonly native?: unknown;
    };

/** A successful createList, as recover(opKey) reports it. */
export interface ListCreated {
  readonly ok: true;
  readonly opKey: string;
  readonly list: ListInfo;
}

export type AppleOpSuccess = Extract<AppleOpResult, { readonly ok: true }>;

export type RecoverResult =
  /** The whole operation is confirmed by the transport (never inferred from item fields). */
  | { readonly state: "done"; readonly result: AppleOpSuccess | ListCreated }
  | { readonly state: "not_started" }
  /** The effect may or may not have happened; the host decides (D-010 r4 §5.7, §6.5). */
  | { readonly state: "unknown"; readonly stage?: string };

export type FindQuery =
  | { readonly url: string }
  | { readonly urlPrefix: string }
  | { readonly externalId: string }
  | { readonly id: string };

/** Durable key-value store the host gives a transport (rows of `transport_state`). */
export interface DurableKV {
  get(key: string): unknown;
  put(key: string, value: unknown): void;
  delete(key: string): void;
  keys(prefix?: string): readonly string[];
}

/** Lists the transport may write to (second line of defence; the host decides first). */
export interface WriteScope {
  readonly listTitlePrefixes: readonly string[];
  readonly listIds: readonly ListRef[];
}

export type TransportStatus =
  | { readonly state: "ok" }
  | {
      readonly state: "needs_human";
      readonly reason:
        | "tcc_not_determined"
        | "tcc_denied"
        | "tcc_restricted"
        | "tcc_write_only"
        | "apple_login";
    }
  | {
      readonly state: "unavailable";
      readonly reason:
        | "helper_missing"
        | "helper_crashed"
        | "transport_disabled"
        | "unknown_response";
      readonly detail?: string;
    };

export type ChangeHint =
  | { readonly coarse: true }
  | { readonly coarse: false; readonly itemIds: readonly string[] };

/** Failure of a read (snapshot, find, lists): the read gives no answer at all. */
export class TransportReadError extends Error {
  constructor(
    readonly code:
      | "not_ready"
      | "list_not_found"
      | "transport_error"
      | "tcc_denied"
      | "tcc_not_determined",
    message: string,
  ) {
    super(message);
    this.name = "TransportReadError";
  }
}

/** createList refused: a list with this title exists (bootstrap never adopts by title, D-010 r3 §6.5). */
export class ListExistsError extends Error {
  constructor(readonly title: string) {
    super(`a reminder list titled "${title}" already exists`);
    this.name = "ListExistsError";
  }
}

/** createList refused: the title does not match the write scope. */
export class ForbiddenListError extends Error {
  constructor(readonly title: string) {
    super(`list "${title}" is outside the bridge's write scope`);
    this.name = "ForbiddenListError";
  }
}

export interface RemindersTransport {
  readonly id: string;
  readonly capabilities: CapabilityDeclaration;
  open(ctx: {
    readonly installationKey: string;
    readonly state: DurableKV;
    readonly scope: WriteScope;
  }): Promise<TransportStatus>;
  status(): TransportStatus;
  setWriteScope(scope: WriteScope): void;
  onChange(cb: (hint: ChangeHint) => void): () => void;
  onSystem(cb: (event: "wake" | "sleep" | "access_changed") => void): () => void;
  lists(): Promise<{ readonly lists: readonly ListInfo[]; readonly complete: boolean }>;
  /**
   * Throws ListExistsError when the title is taken, ForbiddenListError outside the write scope.
   * A repeat with the same opKey returns the list it created; after a lost answer use recover(opKey).
   */
  createList(op: { readonly opKey: string; readonly title: string }): Promise<ListInfo>;
  snapshot(list: ListRef): Promise<{
    readonly items: readonly AppleItem[];
    readonly complete: boolean;
    readonly asOf: string;
  }>;
  find(
    query: FindQuery,
    scope: readonly ListRef[] | "all",
  ): Promise<{ readonly items: readonly AppleItem[]; readonly complete: boolean }>;
  apply(op: AppleOp): Promise<AppleOpResult>;
  recover(opKey: string): Promise<RecoverResult>;
  close(): Promise<void>;
}

/** An in-memory DurableKV, for tests and the fake transport. */
export class MemoryKV implements DurableKV {
  readonly #map = new Map<string, unknown>();
  get(key: string): unknown {
    const v = this.#map.get(key);
    return v === undefined ? undefined : structuredClone(v);
  }
  put(key: string, value: unknown): void {
    this.#map.set(key, structuredClone(value));
  }
  delete(key: string): void {
    this.#map.delete(key);
  }
  keys(prefix = ""): readonly string[] {
    return [...this.#map.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}
