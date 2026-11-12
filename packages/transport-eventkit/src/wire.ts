/**
 * The helper's JSON-lines protocol v2 (D-010 r4 §8) and its mapping to the transport contract.
 * The helper writes absent optional values as `null`; the contract leaves the key out, except
 * `written.dueDate`, where `null` means "the due date was cleared" and is kept.
 */
import type {
  Alarm,
  AppleItem,
  AppleOpResult,
  ApplyErrorCode,
  ListInfo,
  ListRef,
  LocalDate,
  TimeOfDay,
  WrittenFields,
} from "@openlfcp/bridge-reminders/transport";

export const PROTOCOL = 2;

export interface WireError {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
  readonly [k: string]: unknown;
}

export type WireResponse =
  | ({ readonly id: number; readonly ok: true } & Record<string, unknown>)
  | { readonly id: number; readonly ok: false; readonly error: WireError };

export interface WireEvent {
  readonly event: string;
  readonly [k: string]: unknown;
}

export interface WireReady extends WireEvent {
  readonly event: "ready";
  readonly protocol: number;
  readonly helperVersion: string;
  readonly backend: string;
  readonly cas: "strong" | "best-effort";
  readonly authorization: string;
  readonly bundleId?: string | null;
  readonly pid?: number;
  readonly parentPath?: string;
  /** Every request is announced with a `started` event before it runs (the hang analysis G4). */
  readonly requestStarted?: boolean;
}

type Json = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function mapList(w: Json): ListInfo {
  const src = (w.source ?? {}) as Json;
  return {
    id: String(w.id) as ListRef,
    title: String(w.title),
    source: { title: String(src.title ?? ""), type: String(src.type ?? "") },
    allowsContentModifications: w.allowsContentModifications === true,
    isDefault: w.isDefault === true,
  };
}

function mapAlarm(a: Json): Alarm {
  if (a.kind === "absolute") return { kind: "absolute", at: String(a.at) };
  if (a.kind === "relative") return { kind: "relative", relativeSec: Number(a.relativeSec) };
  const prox = a.proximity === "enter" || a.proximity === "leave" ? a.proximity : "none";
  const title = str(a.title);
  return title === undefined
    ? { kind: "location", proximity: prox }
    : { kind: "location", title, proximity: prox };
}

export function mapItem(w: Json): AppleItem {
  const ref = (w.ref ?? {}) as Json;
  const externalId = str(ref.externalId);
  const linkUrl = str(w.linkUrl);
  const completionDate = str(w.completionDate);
  const d = w.due as Json | null | undefined;
  let due: AppleItem["due"];
  if (d !== null && d !== undefined) {
    const time = str(d.time);
    const tz = str(d.tz);
    due = {
      date: String(d.date) as LocalDate,
      ...(time === undefined ? {} : { time: time as TimeOfDay }),
      ...(tz === undefined ? {} : { tz }),
    };
  }
  return {
    ref: externalId === undefined ? { id: String(ref.id) } : { id: String(ref.id), externalId },
    list: String(w.list) as ListRef,
    ...(linkUrl === undefined ? {} : { linkUrl }),
    title: String(w.title ?? ""),
    completed: w.completed === true,
    ...(completionDate === undefined ? {} : { completionDate }),
    priority: Number(w.priority ?? 0),
    ...(due === undefined ? {} : { due }),
    alarms: Array.isArray(w.alarms) ? (w.alarms as Json[]).map(mapAlarm) : [],
    hasNotes: w.hasNotes === true,
    hasRecurrence: w.hasRecurrence === true,
    rev: String(w.rev ?? ""),
  };
}

export function mapWritten(w: Json | undefined): WrittenFields {
  if (w === undefined || w === null) return {};
  const out: { -readonly [K in keyof WrittenFields]: WrittenFields[K] } = {};
  if (typeof w.title === "string") out.title = w.title;
  if (typeof w.priority === "number") out.priority = w.priority;
  if (typeof w.linkUrl === "string") out.linkUrl = w.linkUrl;
  if ("dueDate" in w) out.dueDate = w.dueDate === null ? null : (String(w.dueDate) as LocalDate);
  if (w.completed !== undefined && w.completed !== null) {
    const c = w.completed as Json;
    const cd = str(c.completionDate);
    out.completed =
      cd === undefined
        ? { value: c.value === true }
        : { value: c.value === true, completionDate: cd };
  }
  return out;
}

/** Codes the contract knows as such; everything else becomes transport_error with the native detail. */
const PASS_THROUGH: ReadonlySet<string> = new Set<ApplyErrorCode>([
  "personal_conflict",
  "not_found",
  "list_not_found",
  "forbidden_list",
  "store_conflict",
  "invalid",
  "ambiguous",
  "writes_disabled",
]);

/** A write answer as the contract's AppleOpResult. */
export function mapWriteResponse(opKey: string, r: WireResponse): AppleOpResult {
  if (!r.ok) {
    const e = r.error;
    if (e.code === "conflict_changed") {
      return {
        ok: false,
        opKey,
        code: "conflict_changed",
        retryable: true,
        fresh: mapItem((e.fresh ?? {}) as Json),
      };
    }
    const code = (PASS_THROUGH.has(e.code) ? e.code : "transport_error") as ApplyErrorCode;
    return {
      ok: false,
      opKey,
      code,
      retryable: code === "store_conflict" || e.retryable === true,
      message: e.message,
      ...(code === "transport_error" ? { native: e } : {}),
    };
  }
  const ref = (r.ref ?? {}) as Json;
  const externalId = str(ref.externalId);
  const warnings = Array.isArray(r.warnings) ? (r.warnings as unknown[]).map(String) : [];
  return {
    ok: true,
    opKey,
    ref: externalId === undefined ? { id: String(ref.id) } : { id: String(ref.id), externalId },
    rev: String(r.rev ?? ""),
    written: mapWritten(r.written as Json | undefined),
    ...(r.existing === true ? { existing: true } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
