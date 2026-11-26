// The synthetic year's cold client reports why it failed (c-year.ts, coldFailure): the nightly
// year died with only "Command failed: <argv>" when execFile killed the client at its timeout.

import { describe, expect, it } from "vitest";
import { coldFailure } from "./support/c-year.js";

describe("coldFailure", () => {
  it("names a kill at the timeout", () => {
    const e = { killed: true, signal: "SIGTERM", code: null, stderr: "" };
    expect(coldFailure(e, 600_400, 600_000)).toBe(
      "the cold client killed with SIGTERM at the 600 s timeout after 600 s",
    );
  });

  it("names a kill from outside, before the timeout", () => {
    const e = { killed: false, signal: "SIGKILL", code: null, stderr: "" };
    expect(coldFailure(e, 42_000, 600_000)).toMatch(/killed with SIGKILL \(out of memory/);
  });

  it("keeps the client's own error", () => {
    const e = { killed: false, signal: null, code: 1, stderr: "Error: no chain of C\n" };
    expect(coldFailure(e, 3_000, 600_000)).toBe(
      "the cold client exited with 1 after 3 s:\nError: no chain of C",
    );
  });
});
