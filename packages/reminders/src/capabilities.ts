/**
 * Capability declaration of a Reminders transport (D-010 r3 §4.3, P6): what the transport
 * can do natively, what the bridge keeps as shadow, what it must never write.
 */

/** Fields the bridge synchronizes; everything else on a reminder is personal or unsupported. */
export type SyncField = "title" | "completed" | "dueDate" | "priority";

/** How a field is handled by a transport. */
export type FieldSupport = "native" | "unsupported" | "native-unused";

/** Personal data: the bridge never writes it (B2, B12, B15). */
export const PERSONAL_DATA = [
  "notes",
  "dueTime",
  "dueTimeZone",
  "alarms",
  "locationAlarms",
  "earlyAlerts",
  "recurrence",
  "flag",
  "subtasks",
  "foreignUrl",
] as const;
export type PersonalData = (typeof PERSONAL_DATA)[number];

export interface CapabilityDeclaration {
  readonly transport: string;
  readonly fields: { readonly [F in SyncField]: FieldSupport } & {
    readonly scheduled: FieldSupport;
    readonly tags: FieldSupport;
    readonly assignees: FieldSupport | "unknown";
  };
  /** Stable reminder ids (CloudKit record names) or a cache only (EventKit calendarItemIdentifier). */
  readonly ids: { readonly stable: boolean; readonly clientChosen: boolean };
  /** "strong": the expect check and the write are one atomic step; "best-effort": they are not. */
  readonly cas: "strong" | "best-effort";
  /** "coarse": a change hint without ids (EventKit, fired for own writes too); "delta": ids known. */
  readonly changes: "coarse" | "delta";
  /** What completing a reminder with a person's recurrence does; "unknown" until verified live. */
  readonly recurringCompletion: "advance-same" | "copy" | "unknown";
  /**
   * How recover(opKey) knows an outcome: "exact" (the store records the operation),
   * "stages" (only the transport's own durable stages; a lost answer is "unknown").
   */
  readonly recover: "exact" | "stages";
  /** False until the live verification run passed for this transport build (D-010 r3 §7.6). */
  readonly writesVerified: boolean;
}

/** EventKit through the Swift helper (D-010 r3 §4.3). */
export const EVENTKIT_CAPABILITIES: CapabilityDeclaration = Object.freeze({
  transport: "eventkit",
  fields: Object.freeze({
    title: "native",
    completed: "native",
    dueDate: "native",
    priority: "native",
    scheduled: "unsupported",
    tags: "unsupported",
    assignees: "unsupported",
  }),
  ids: Object.freeze({ stable: false, clientChosen: false }),
  cas: "best-effort",
  changes: "coarse",
  recurringCompletion: "unknown",
  recover: "stages",
  writesVerified: false,
}) as CapabilityDeclaration;
