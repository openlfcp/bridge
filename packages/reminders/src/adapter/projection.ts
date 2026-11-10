// Field projections (D-010 §4.4) and due dates (§4.5). Reconciliation
// compares projections, never raw values: values a person would call the
// same never make a write. Exact values stay as the shadow (the LFCP status,
// priority) and the native (Apple), for writing back and for finalize.
//
// | field    | LFCP                                    | Apple                                    | → Apple           |
// |----------|-----------------------------------------|------------------------------------------|-------------------|
// | title    | the title, line breaks → space          | the title, line breaks → space           | title             |
// | due      | LocalDate or null                       | the due's date or null (time, zone and    | dueDate (§4.5)    |
// |          |                                         | alarms are personal, outside)            |                   |
// | priority | highest/high → high, normal → none,     | 0 and 5 → none, 1–4 → high, 6–9 → low    | none 0, high 1,   |
// |          | low/lowest → low (B13)                  |                                          | low 9             |
// | status   | (closed, date): todo/in_progress →      | completed → (true, local date of         | completed         |
// |          | (false, —); done → (true, cd | —);      | completionDate); else (false, —)         |                   |
// |          | cancelled → (true, —)                   |                                          |                   |
//
// A status group is equivalent when `closed` is equal and the dates are
// equal or one of them is "—" (null). A status or priority the profile
// extends (`x/…`) projects as open / none: the bridge never guesses its meaning.

import type { AppleItem, WritableSet, WrittenFields } from "../transport.js";
import { isLocalDate, type LocalDate } from "../values.js";
import type { LfcpValues } from "./lfcp-write.js";

export type Field = "title" | "due" | "priority" | "status";
export const FIELDS: readonly Field[] = Object.freeze(["title", "due", "priority", "status"]);

export type PriorityBucket = "none" | "high" | "low";

export interface StatusProjection {
  readonly closed: boolean;
  /** null: "—", no date known. */
  readonly date: LocalDate | null;
}

export interface Projections {
  readonly title: string;
  readonly due: LocalDate | null;
  readonly priority: PriorityBucket;
  readonly status: StatusProjection;
}

export type Projection = Projections[Field];

/** What the adapter reads of an LFCP Task (structurally, the profile's Task). */
export interface LfcpTask {
  readonly id: string;
  readonly lifecycle: "active" | "deleted";
  readonly title: string;
  readonly status: string;
  readonly due?: string | null;
  readonly completion_date?: string | null;
  readonly priority: string;
  readonly assignees: { readonly [ref: string]: true };
}

/** The exact LFCP values a projection drops (the shadow, §3 `lfcp_shadow_json`). */
export interface LfcpShadow {
  readonly status: string;
  readonly priority: string;
}

const oneLine = (s: string) => s.replace(/\r\n|\r|\n/g, " ");

const dateOrNull = (v: string | null | undefined): LocalDate | null => (isLocalDate(v) ? v : null);

export function projectLfcp(
  t: Pick<LfcpTask, "title" | "due" | "priority" | "status" | "completion_date">,
): Projections {
  return {
    title: oneLine(t.title),
    due: dateOrNull(t.due),
    priority:
      t.priority === "highest" || t.priority === "high"
        ? "high"
        : t.priority === "low" || t.priority === "lowest"
          ? "low"
          : "none",
    status:
      t.status === "done"
        ? { closed: true, date: dateOrNull(t.completion_date) }
        : t.status === "cancelled"
          ? { closed: true, date: null }
          : { closed: false, date: null },
  };
}

export const shadowOf = (t: LfcpTask): LfcpShadow => ({ status: t.status, priority: t.priority });

/** The exact values the bridge reads and writes of a Task (a to_lfcp basis). */
export const lfcpValuesOf = (t: LfcpTask): LfcpValues => ({
  title: t.title,
  due: t.due ?? null,
  priority: t.priority,
  status: t.status,
  completion_date: t.completion_date ?? null,
});

/** Apple's stored values of the synchronized fields (the native of an Apple base). */
export interface AppleNative {
  readonly title: string;
  readonly dueDate: LocalDate | null;
  readonly priority: number;
  readonly completed: { readonly value: boolean; readonly completionDate?: string };
}

export const appleNative = (item: AppleItem): AppleNative => ({
  title: item.title,
  dueDate: item.due?.date ?? null,
  priority: item.priority,
  completed: {
    value: item.completed,
    ...(item.completionDate === undefined ? {} : { completionDate: item.completionDate }),
  },
});

/**
 * Apple's projections of the fields an operation wrote (`written`, §4.2), the
 * Apple base of a to_apple finalize (§5.6). A field not written is absent.
 */
export function projectWritten(written: WrittenFields, timeZone: string): Partial<Projections> {
  return {
    ...(written.title === undefined ? {} : { title: oneLine(written.title) }),
    ...(written.dueDate === undefined ? {} : { due: written.dueDate }),
    ...(written.priority === undefined ? {} : { priority: priorityBucket(written.priority) }),
    ...(written.completed === undefined
      ? {}
      : {
          status: written.completed.value
            ? {
                closed: true,
                date:
                  written.completed.completionDate === undefined
                    ? null
                    : localDateIn(written.completed.completionDate, timeZone),
              }
            : { closed: false, date: null },
        }),
  };
}

/** The local calendar date of an instant in a zone (the Mac's, for completionDate). */
export function localDateIn(instant: string, timeZone: string): LocalDate | null {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return isLocalDate(date) ? date : null;
}

export function priorityBucket(stored: number): PriorityBucket {
  if (stored >= 1 && stored <= 4) return "high";
  if (stored >= 6 && stored <= 9) return "low";
  return "none";
}

/** Apple's projections; `timeZone` is the zone completion dates are read in. */
export function projectApple(item: AppleItem, timeZone: string): Projections {
  return {
    title: oneLine(item.title),
    due: item.due?.date ?? null,
    priority: priorityBucket(item.priority),
    status: item.completed
      ? {
          closed: true,
          date:
            item.completionDate === undefined ? null : localDateIn(item.completionDate, timeZone),
        }
      : { closed: false, date: null },
  };
}

/** The same projection (exact): what dL / dA compare against a base. */
export function sameProjection(field: Field, a: unknown, b: unknown): boolean {
  if (field === "status") {
    const x = a as StatusProjection | undefined;
    const y = b as StatusProjection | undefined;
    return x?.closed === y?.closed && (x?.date ?? null) === (y?.date ?? null);
  }
  return (a ?? null) === (b ?? null);
}

/** Equivalent projections of the two sides: no write between them (§4.4). */
export function equivalent(field: Field, a: Projection, b: Projection): boolean {
  if (field !== "status") return sameProjection(field, a, b);
  const x = a as StatusProjection;
  const y = b as StatusProjection;
  return x.closed === y.closed && (x.date === null || y.date === null || x.date === y.date);
}

export const BUCKET_TO_APPLE: Readonly<Record<PriorityBucket, 0 | 1 | 9>> = Object.freeze({
  none: 0,
  high: 1,
  low: 9,
});

/** A write LFCP → Apple of one field, or why there is none (§4.5). */
export type AppleWrite =
  | { readonly kind: "set"; readonly set: WritableSet; readonly warnings: readonly string[] }
  /** The person's data stands in the way: a conflict, no write (B12). */
  | { readonly kind: "conflict"; readonly conflict: "due_cleared_in_lfcp" };

/**
 * The Apple write that makes `item`'s projection of `field` equal to `pL`.
 * Due (§4.5, B2, B12, B15): a date is set alone (time, zone and alarms stay;
 * an absolute alarm left on the old day is a warning); clearing it with a
 * time or any alarm on the reminder is not written but a conflict.
 * `item` undefined: a new reminder.
 */
export function appleWrite(
  field: Field,
  pL: Projections,
  item: AppleItem | undefined,
  timeZone: string,
): AppleWrite {
  switch (field) {
    case "title":
      return { kind: "set", set: { title: pL.title }, warnings: [] };
    case "priority":
      return { kind: "set", set: { priority: BUCKET_TO_APPLE[pL.priority] }, warnings: [] };
    case "status":
      return {
        kind: "set",
        set: {
          completed: pL.status.closed
            ? { value: true, ...(pL.status.date === null ? {} : { date: pL.status.date }) }
            : { value: false },
        },
        warnings: [],
      };
    case "due": {
      if (pL.due === null) {
        if (item?.due?.time !== undefined || (item?.alarms.length ?? 0) > 0)
          return { kind: "conflict", conflict: "due_cleared_in_lfcp" };
        return { kind: "set", set: { dueDate: null }, warnings: [] };
      }
      const old = item?.due?.date;
      const onOldDay =
        old !== undefined &&
        old !== pL.due &&
        (item?.alarms ?? []).some(
          (a) => a.kind === "absolute" && localDateIn(a.at, item?.due?.tz ?? timeZone) === old,
        );
      return {
        kind: "set",
        set: { dueDate: pL.due },
        warnings: onOldDay ? ["alarm_on_old_date"] : [],
      };
    }
  }
}
