/** A calendar date without time or zone, "YYYY-MM-DD" (LFCP `LocalDate`). */
export type LocalDate = string & { readonly __localDate: unique symbol };

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Validates a "YYYY-MM-DD" string that names a real calendar day. */
export function isLocalDate(value: unknown): value is LocalDate {
  if (typeof value !== "string") return false;
  const m = LOCAL_DATE.exec(value);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

export function localDate(value: string): LocalDate {
  if (!isLocalDate(value)) throw new TypeError(`not a calendar date (YYYY-MM-DD): ${value}`);
  return value;
}

/** "HH:MM", 24-hour. */
export type TimeOfDay = string & { readonly __timeOfDay: unique symbol };

export function isTimeOfDay(value: unknown): value is TimeOfDay {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function timeOfDay(value: string): TimeOfDay {
  if (!isTimeOfDay(value)) throw new TypeError(`not a time of day (HH:MM): ${value}`);
  return value;
}

/** URL prefixes the bridge owns (D-010 r3 §3). */
export const TASK_LINK_PREFIX = "lfcp://task/";
export const MARKER_PREFIX = "lfcp://bridge/";

export const isTaskLink = (url: string | undefined): boolean =>
  url?.startsWith(TASK_LINK_PREFIX) ?? false;
export const isMarkerUrl = (url: string | undefined): boolean =>
  url?.startsWith(MARKER_PREFIX) ?? false;
