// `bridge.mjs --self-test` (src/self-test.ts): the packaged host's check. Here, outside a bundle:
// the dev run passes; a run that claims a bundle it is not in fails its placement checks.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { selfTest } from "../src/self-test.js";

const run = async (...args: string[]) => {
  const lines: Record<string, unknown>[] = [];
  const code = await selfTest(args, (l) => lines.push(JSON.parse(l) as Record<string, unknown>));
  return { code, lines };
};

describe("--self-test", () => {
  it("passes outside a bundle with --dev: runtime, sqlite (WAL), automerge; no helper", async () => {
    const { code, lines } = await run("--dev");
    expect(lines.map((l) => l.check ?? l.selfTest)).toEqual([
      "runtime",
      "sqlite",
      "automerge",
      "ok",
    ]);
    expect(lines.slice(0, 3).every((l) => l.ok === true)).toBe(true);
    expect(lines[1]).toMatchObject({ journalMode: "wal" });
    expect(code).toBe(0);
  });

  it("fails when the node, the script and better-sqlite3 are not the bundle's", async () => {
    const app = mkdtempSync(path.join(tmpdir(), "lfcp-selftest-app-"));
    try {
      const { code, lines } = await run("--app", app);
      expect(lines[0]).toMatchObject({
        check: "runtime",
        ok: false,
        nodeInApp: false,
        scriptInApp: false,
        sqliteInApp: false,
      });
      expect(lines.find((l) => l.check === "helper")).toMatchObject({ ok: false });
      expect(lines.at(-1)).toMatchObject({ selfTest: "failed" });
      expect(code).toBe(1);
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });

  it("refuses --app without a path", async () => {
    const { code, lines } = await run("--app");
    expect(lines).toEqual([{ check: "args", ok: false, error: "--app needs a path" }]);
    expect(code).toBe(2);
  });
});
