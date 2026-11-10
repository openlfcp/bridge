// The status table (D-010 r4 §4.4, r3 P2-2): every input selects exactly one row, and the rows do
// what §4.4 says.

import { describe, expect, it } from "vitest";
import {
  STATUS_TABLE,
  type StatusInput,
  type StatusKind,
  type StatusRowId,
  statusRow,
  statusRows,
} from "../src/adapter/index.js";
import { type LocalDate, localDate } from "../src/index.js";

const D1 = localDate("2026-11-01");
const D2 = localDate("2026-11-02");
const D3 = localDate("2026-11-03");
const DATES: readonly (LocalDate | null)[] = [null, D1, D2, D3];

/** Every LFCP state: (status, its projection). Cancelled is (true, —) (r4 §4.4). */
function lfcpStates() {
  const out: { s: StatusKind; p: { closed: boolean; date: LocalDate | null } }[] = [
    { s: "open", p: { closed: false, date: null } },
    { s: "cancelled", p: { closed: true, date: null } },
  ];
  for (const d of DATES) out.push({ s: "done", p: { closed: true, date: d } });
  return out;
}
function appleStates() {
  const out: { closed: boolean; date: LocalDate | null }[] = [{ closed: false, date: null }];
  for (const d of DATES) out.push({ closed: true, date: d });
  return out;
}

/** The whole input space: first links, bases that agree on closed, and bases that do not. */
function* inputs(): Generator<StatusInput> {
  for (const L of lfcpStates())
    for (const A of appleStates()) {
      yield { pL: L.p, sL: L.s, pA: A };
      for (const BL of lfcpStates())
        for (const BA of appleStates())
          yield { pL: L.p, sL: L.s, pA: A, base: { lfcp: BL.p, sL: BL.s, apple: BA } };
    }
}

describe("status table (P2-2)", () => {
  it("every input selects exactly one row", () => {
    let n = 0;
    const used = new Set<StatusRowId>();
    for (const i of inputs()) {
      const rows = statusRows(i);
      if (rows.length !== 1)
        throw new Error(`${rows.length} rows (${rows.map((r) => r.id)}) for ${JSON.stringify(i)}`);
      used.add((rows[0] as { id: StatusRowId }).id);
      n++;
    }
    expect(n).toBe(6 * 5 * (1 + 6 * 5));
    // And every row is reachable.
    expect([...used].sort()).toEqual(STATUS_TABLE.map((r) => r.id).sort());
  });

  const open: { closed: boolean; date: LocalDate | null } = { closed: false, date: null };
  const done = (d: LocalDate | null) => ({ closed: true, date: d });
  const row = (i: StatusInput) => {
    const r = statusRow(i);
    return [r.id, r.action(i)];
  };
  const base = (lfcp: typeof open, sL: StatusKind, apple: typeof open) => ({ lfcp, sL, apple });

  it("§4.4 rows 2–6: LFCP changed, Apple not", () => {
    expect(row({ pL: done(D1), sL: "done", pA: open, base: base(open, "open", open) })).toEqual([
      "2",
      { kind: "apple", completed: { value: true, date: D1 } },
    ]);
    expect(
      row({ pL: done(null), sL: "cancelled", pA: open, base: base(open, "open", open) }),
    ).toEqual(["3", { kind: "apple", completed: { value: true } }]);
    expect(
      row({ pL: open, sL: "open", pA: done(D1), base: base(done(D1), "done", done(D1)) }),
    ).toEqual(["4", { kind: "apple", completed: { value: false } }]);
    expect(
      row({ pL: done(D2), sL: "done", pA: done(D1), base: base(done(D1), "done", done(D1)) }),
    ).toEqual(["5", { kind: "apple", completed: { value: true, date: D2 } }]);
    // done → cancelled: nothing is carried to Apple.
    expect(
      row({
        pL: done(null),
        sL: "cancelled",
        pA: done(D1),
        base: base(done(D1), "done", done(D1)),
      })[0],
    ).toBe("6");
  });

  it("§4.4 rows 7–10: Apple changed, LFCP not; cancelled stays (B14)", () => {
    expect(row({ pL: open, sL: "open", pA: done(D1), base: base(open, "open", open) })).toEqual([
      "7",
      { kind: "lfcp_complete", date: D1 },
    ]);
    expect(
      row({ pL: done(D1), sL: "done", pA: open, base: base(done(D1), "done", done(D1)) }),
    ).toEqual(["8", { kind: "lfcp_reopen" }]);
    expect(
      row({ pL: done(D1), sL: "done", pA: done(D2), base: base(done(D1), "done", done(D1)) }),
    ).toEqual(["9", { kind: "lfcp_complete", date: D2 }]);
    // Cancelled with the bases of §5.6: LFCP (true, —), Apple (true, d).
    expect(
      row({
        pL: done(null),
        sL: "cancelled",
        pA: done(D2),
        base: base(done(null), "cancelled", done(D1)),
      }),
    ).toEqual(["10", { kind: "none" }]);
  });

  it("§4.4 rows 11–15: both changed", () => {
    expect(row({ pL: done(D1), sL: "done", pA: done(D2), base: base(open, "open", open) })).toEqual(
      ["11", { kind: "apple", completed: { value: true, date: D1 } }],
    );
    expect(
      row({ pL: done(null), sL: "cancelled", pA: done(D2), base: base(open, "open", open) })[0],
    ).toBe("11=");
    expect(row({ pL: open, sL: "open", pA: open, base: base(done(D1), "done", done(D1)) })[0]).toBe(
      "12",
    );
    // "done" wins (B14) both ways.
    expect(
      row({ pL: done(D2), sL: "done", pA: open, base: base(done(D1), "done", done(D1)) }),
    ).toEqual(["13", { kind: "apple", completed: { value: true, date: D2 } }]);
    expect(
      row({ pL: open, sL: "open", pA: done(D3), base: base(done(D1), "done", done(D1)) }),
    ).toEqual(["14", { kind: "lfcp_complete", date: D3 }]);
    expect(
      row({ pL: done(D2), sL: "done", pA: done(D3), base: base(done(D1), "done", done(D1)) }),
    ).toEqual(["15", { kind: "apple", completed: { value: true, date: D2 } }]);
    expect(
      statusRow({ pL: done(D2), sL: "done", pA: done(D3), base: base(done(D1), "done", done(D1)) })
        .appleOverruled,
    ).toBe(true);
  });

  it("first link: equivalent → bases; else done wins, LFCP's date wins", () => {
    expect(row({ pL: done(null), sL: "cancelled", pA: done(D1) })[0]).toBe("X:F=");
    expect(row({ pL: done(D1), sL: "done", pA: open })).toEqual([
      "X:F1",
      { kind: "apple", completed: { value: true, date: D1 } },
    ]);
    expect(row({ pL: open, sL: "open", pA: done(D2) })).toEqual([
      "X:F2",
      { kind: "lfcp_complete", date: D2 },
    ]);
    expect(row({ pL: done(D1), sL: "done", pA: done(D2) })[0]).toBe("X:F3");
  });
});

describe("review PR 10 #12", () => {
  it("equivalent projections never write, missing dates included (§4.4: — is equivalent)", () => {
    for (const i of inputs()) {
      if (i.pL.closed !== i.pA.closed) continue;
      if (i.pL.date !== null && i.pA.date !== null && i.pL.date !== i.pA.date) continue;
      const r = statusRow(i);
      expect(r.action(i), JSON.stringify({ row: r.id, input: i })).toEqual({ kind: "none" });
    }
  });
});
