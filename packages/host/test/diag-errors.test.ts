import { describe, expect, it } from "vitest";
import { errorCode } from "../src/diag/errors.js";

describe("errorCode (A§11): a code, never a message", () => {
  it("takes a machine code, else the class name, else 'error'", () => {
    const errno = Object.assign(new Error("open /Users/someone/secret: denied"), {
      code: "EACCES",
    });
    expect(errorCode(errno)).toBe("EACCES");
    class OutcomeUnknownError extends Error {
      override name = "OutcomeUnknownError";
    }
    expect(errorCode(new OutcomeUnknownError("title CANARY"))).toBe("OutcomeUnknownError");
    expect(errorCode(new Error("CANARY"))).toBe("error");
    expect(errorCode(Object.assign(new Error("x"), { code: "has space CANARY" }))).toBe("error");
    expect(errorCode("CANARY")).toBe("error");
    expect(errorCode(undefined)).toBe("error");
  });
});
