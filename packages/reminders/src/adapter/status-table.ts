// The status group (status + completion_date) between the two sides
// (D-010 r4 §4.4, r3 P2-2): rows with explicit, non-overlapping predicates
// over dL / dA. Each input selects exactly one row (test: every input of the
// space, one row).
//
// Inputs: the LFCP and Apple projections (closed, date) now and in the bases,
// and the exact LFCP status now and in the base (its shadow) — open / done /
// cancelled. dL, dA: the projection differs from its base (exact: "—" is a
// value here). cL, cA: `closed` differs from the base's. "—" (null) counts as
// equivalent only for deciding whether to write (§4.4), never as a base value.
// Cancelled projects as (true, —) (r4 §4.4); after a write the bases follow
// the finalize formulas (§5.6), so a cancelled Task may have the bases
// LFCP (true, —) / Apple (true, d).
//
// | row | predicate                                         | action                                        |
// |-----|---------------------------------------------------|-----------------------------------------------|
// | X   | no bases, or bases disagree on closed             | as a first link (F rows)                      |
// | 1   | ¬dL ∧ ¬dA                                         | — (only the shadow follows)                   |
// | 2   | dL ∧ ¬dA ∧ cL ∧ closed now ∧ done                 | Apple completed {true, date: cd | —}          |
// | 3   | dL ∧ ¬dA ∧ cL ∧ closed now ∧ cancelled            | Apple completed {true} (Apple's own date)     |
// | 4   | dL ∧ ¬dA ∧ cL ∧ open now                          | Apple completed {false}                       |
// | 5   | dL ∧ ¬dA ∧ ¬cL ∧ same status ∧ both dates, ≠       | Apple date := cd                              |
// | 5=  | dL ∧ ¬dA ∧ ¬cL ∧ same status ∧ ¬(both dates, ≠)    | — (equivalent: a date unknown or the same)    |
// | 6   | dL ∧ ¬dA ∧ ¬cL ∧ done ↔ cancelled                 | — (cancelled ≠ done is not carried to Apple)  |
// | 7   | ¬dL ∧ dA ∧ cA ∧ Apple closed                      | LFCP complete(d)                              |
// | 8   | ¬dL ∧ dA ∧ cA ∧ Apple open                        | LFCP reopen                                   |
// | 9   | ¬dL ∧ dA ∧ ¬cA ∧ done ∧ both dates, ≠              | LFCP complete(d) (the date)                   |
// | 9=  | ¬dL ∧ dA ∧ ¬cA ∧ done ∧ ¬(both dates, ≠)           | — (equivalent)                                |
// | 10  | ¬dL ∧ dA ∧ ¬cA ∧ cancelled                        | — (B14: cancelled stays)                      |
// | 11  | dL ∧ dA ∧ cL ∧ cA ∧ closed now ∧ both dates, ≠    | LFCP wins: Apple date := cd                   |
// | 11= | dL ∧ dA ∧ cL ∧ cA ∧ closed now ∧ ¬(both, ≠)       | — (equivalent)                                |
// | 12  | dL ∧ dA ∧ cL ∧ cA ∧ open now                      | — (equivalent)                                |
// | 13  | dL ∧ dA ∧ ¬cL ∧ cA (LFCP closed, Apple reopened)  | "done" wins (B14): Apple completed {true, cd} |
// | 14  | dL ∧ dA ∧ cL ∧ ¬cA (LFCP reopened, Apple closed)  | "done" wins: LFCP complete(d)                 |
// | 15  | dL ∧ dA ∧ ¬cL ∧ ¬cA ∧ both dates, ≠                | LFCP wins: Apple date := cd, Apple's in journal |
// | 15= | dL ∧ dA ∧ ¬cL ∧ ¬cA ∧ ¬(both dates, ≠)             | — (equivalent)                                |
//
// First link (row X): equivalent → bases only (F=); else "done" wins (B14):
// LFCP closed, Apple open → Apple completed (F1); Apple closed, LFCP open →
// LFCP complete(d) (F2); both closed with known different dates → LFCP wins
// (F3). Equivalent projections never write (tested over the whole input
// space, review PR 10 #12). The bases after any row: both sides the group's resulting projection
// (§4.4), written by finalize (§5.6) or, with no write, as they are now.

import type { LocalDate } from "../values.js";
import type { StatusProjection } from "./projection.js";

export type StatusKind = "open" | "done" | "cancelled";

export const statusKind = (status: string): StatusKind =>
  status === "done" ? "done" : status === "cancelled" ? "cancelled" : "open";

export interface StatusInput {
  /** LFCP projection now and its exact status now. */
  readonly pL: StatusProjection;
  readonly sL: StatusKind;
  /** Apple projection now. */
  readonly pA: StatusProjection;
  /** The bases; undefined on a first link. */
  readonly base?: {
    readonly lfcp: StatusProjection;
    /** The LFCP status of the base (its shadow); open when unknown. */
    readonly sL: StatusKind;
    readonly apple: StatusProjection;
  };
}

export type StatusAction =
  | { readonly kind: "none" }
  | {
      readonly kind: "apple";
      readonly completed: { readonly value: boolean; readonly date?: LocalDate };
    }
  | { readonly kind: "lfcp_complete"; readonly date?: LocalDate }
  | { readonly kind: "lfcp_reopen" };

export type StatusRowId =
  | "X:F="
  | "X:F1"
  | "X:F2"
  | "X:F3"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "5="
  | "6"
  | "7"
  | "8"
  | "9"
  | "9="
  | "10"
  | "11"
  | "11="
  | "12"
  | "13"
  | "14"
  | "15"
  | "15=";

export interface StatusRow {
  readonly id: StatusRowId;
  readonly when: (i: StatusInput) => boolean;
  readonly action: (i: StatusInput) => StatusAction;
  /** B14: Apple's value is overruled and goes to the journal. */
  readonly appleOverruled?: boolean;
}

const same = (a: StatusProjection, b: StatusProjection) =>
  a.closed === b.closed && a.date === b.date;
const NONE: StatusAction = { kind: "none" };
const appleClose = (d: LocalDate | null): StatusAction => ({
  kind: "apple",
  completed: { value: true, ...(d === null ? {} : { date: d }) },
});
const lfcpComplete = (d: LocalDate | null): StatusAction => ({
  kind: "lfcp_complete",
  ...(d === null ? {} : { date: d }),
});

// Derived predicates. "Usable bases": present and agreeing on closed (the
// invariant finalize keeps); otherwise row X.
const usable = (i: StatusInput) =>
  i.base !== undefined && i.base.lfcp.closed === i.base.apple.closed;
const b = (i: StatusInput) => i.base as NonNullable<StatusInput["base"]>;
const dL = (i: StatusInput) => usable(i) && !same(i.pL, b(i).lfcp);
const dA = (i: StatusInput) => usable(i) && !same(i.pA, b(i).apple);
const cL = (i: StatusInput) => i.pL.closed !== b(i).lfcp.closed;
const cA = (i: StatusInput) => i.pA.closed !== b(i).apple.closed;
/** Both dates known and different. */
const datesDiffer = (x: LocalDate | null, y: LocalDate | null) =>
  x !== null && y !== null && x !== y;
const equivalent = (a: StatusProjection, c: StatusProjection) =>
  a.closed === c.closed && !datesDiffer(a.date, c.date);

const onlyL = (i: StatusInput) => dL(i) && !dA(i);
const onlyA = (i: StatusInput) => !dL(i) && dA(i);
const both = (i: StatusInput) => dL(i) && dA(i);

const ROWS: StatusRow[] = [
  {
    id: "X:F=",
    when: (i) => !usable(i) && equivalent(i.pL, i.pA),
    action: () => NONE,
  },
  {
    id: "X:F1",
    when: (i) => !usable(i) && i.pL.closed && !i.pA.closed,
    action: (i) => appleClose(i.pL.date),
  },
  {
    id: "X:F2",
    when: (i) => !usable(i) && !i.pL.closed && i.pA.closed,
    action: (i) => lfcpComplete(i.pA.date),
  },
  {
    id: "X:F3",
    when: (i) => !usable(i) && i.pL.closed && i.pA.closed && datesDiffer(i.pL.date, i.pA.date),
    action: (i) => appleClose(i.pL.date),
    appleOverruled: true,
  },
  { id: "1", when: (i) => usable(i) && !dL(i) && !dA(i), action: () => NONE },
  {
    id: "2",
    when: (i) => onlyL(i) && cL(i) && i.pL.closed && i.sL === "done",
    action: (i) => appleClose(i.pL.date),
  },
  {
    id: "3",
    when: (i) => onlyL(i) && cL(i) && i.pL.closed && i.sL === "cancelled",
    action: () => appleClose(null),
  },
  {
    id: "4",
    when: (i) => onlyL(i) && cL(i) && !i.pL.closed,
    action: () => ({ kind: "apple", completed: { value: false } }),
  },
  {
    id: "5",
    when: (i) => onlyL(i) && !cL(i) && i.sL === b(i).sL && datesDiffer(i.pL.date, i.pA.date),
    action: (i) => appleClose(i.pL.date),
  },
  {
    id: "5=",
    when: (i) => onlyL(i) && !cL(i) && i.sL === b(i).sL && !datesDiffer(i.pL.date, i.pA.date),
    action: () => NONE,
  },
  { id: "6", when: (i) => onlyL(i) && !cL(i) && i.sL !== b(i).sL, action: () => NONE },
  {
    id: "7",
    when: (i) => onlyA(i) && cA(i) && i.pA.closed,
    action: (i) => lfcpComplete(i.pA.date),
  },
  {
    id: "8",
    when: (i) => onlyA(i) && cA(i) && !i.pA.closed,
    action: () => ({ kind: "lfcp_reopen" }),
  },
  {
    id: "9",
    when: (i) => onlyA(i) && !cA(i) && i.sL !== "cancelled" && datesDiffer(i.pA.date, i.pL.date),
    action: (i) => lfcpComplete(i.pA.date),
  },
  {
    id: "9=",
    when: (i) => onlyA(i) && !cA(i) && i.sL !== "cancelled" && !datesDiffer(i.pA.date, i.pL.date),
    action: () => NONE,
  },
  { id: "10", when: (i) => onlyA(i) && !cA(i) && i.sL === "cancelled", action: () => NONE },
  {
    id: "11",
    when: (i) => both(i) && cL(i) && cA(i) && i.pL.closed && datesDiffer(i.pL.date, i.pA.date),
    action: (i) => appleClose(i.pL.date),
    appleOverruled: true,
  },
  {
    id: "11=",
    when: (i) => both(i) && cL(i) && cA(i) && i.pL.closed && !datesDiffer(i.pL.date, i.pA.date),
    action: () => NONE,
  },
  { id: "12", when: (i) => both(i) && cL(i) && cA(i) && !i.pL.closed, action: () => NONE },
  {
    id: "13",
    when: (i) => both(i) && !cL(i) && cA(i),
    action: (i) => appleClose(i.pL.date),
    appleOverruled: true,
  },
  {
    id: "14",
    when: (i) => both(i) && cL(i) && !cA(i),
    action: (i) => lfcpComplete(i.pA.date),
  },
  {
    id: "15",
    when: (i) => both(i) && !cL(i) && !cA(i) && datesDiffer(i.pL.date, i.pA.date),
    action: (i) => appleClose(i.pL.date),
    appleOverruled: true,
  },
  {
    id: "15=",
    when: (i) => both(i) && !cL(i) && !cA(i) && !datesDiffer(i.pL.date, i.pA.date),
    action: () => NONE,
  },
];

export const STATUS_TABLE: readonly StatusRow[] = Object.freeze(ROWS);

/** The rows an input selects (exactly one for every input; the test checks it). */
export const statusRows = (i: StatusInput): readonly StatusRow[] =>
  STATUS_TABLE.filter((r) => r.when(i));

/** The one row of an input. */
export function statusRow(i: StatusInput): StatusRow {
  const rows = statusRows(i);
  if (rows.length !== 1)
    throw new Error(
      `status table: ${rows.length} rows for ${JSON.stringify(i)} (${rows.map((r) => r.id).join(", ")})`,
    );
  return rows[0] as StatusRow;
}
