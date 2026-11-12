// The CLI frame (D-010 §2.1): exit codes, and commands of later PRs answer
// "not available in this build" with exit 2.

import { describe, expect, it } from "vitest";
import { COMMANDS, EXIT, main } from "../src/index.js";

const run = async (...argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

describe("lfcp-bridge", () => {
  it("has the exit codes of §2.1", () => {
    expect(EXIT).toEqual({
      OK: 0,
      INTERNAL: 1,
      USAGE: 2,
      NEEDS_PERSON: 3,
      NOT_FOUND: 4,
      STOPPED: 5,
    });
  });

  it("prints the usage: exit 2 without a command, 0 when asked", async () => {
    expect((await run()).code).toBe(EXIT.USAGE);
    const help = await run("help");
    expect(help.code).toBe(EXIT.OK);
    for (const c of COMMANDS) expect(help.out).toContain(c.name);
  });

  it("answers every command of a later PR with 'not available in this build', exit 2", async () => {
    for (const c of COMMANDS.filter((x) => x.ready !== true)) {
      const r = await run(...c.name.split(" "));
      expect([r.code, r.err]).toEqual([
        EXIT.USAGE,
        `${c.name}: not available in this build (D-010 PR ${c.pr})`,
      ]);
    }
  });

  it("refuses an unknown command; prints its version", async () => {
    const r = await run("frobnicate");
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.err).toContain("unknown command frobnicate");
    expect(await run("--version")).toMatchObject({ code: EXIT.OK, out: "0.5.0" });
  });
});
