// The synthetic year of C (A§3.5, T§3; E-030): on every L2 run, a short, sparse year (eight days,
// past the seven-day cleanup) checks the generator and that the cleanup of C leaves control_exec
// whole. LFCP_C_DAYS and LFCP_C_TRANSITIONS run a longer or denser one by hand (365 and 20 are the
// year of T§3). Skipped without LFCP_SERVER_BIN.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openBridgeDatabase } from "../src/index.js";
import { synthesizeYear } from "./support/c-year.js";
import { type LiveServer, serverSkip, startServer } from "./support/server.js";

const skip = serverSkip();
let server: LiveServer | undefined;
beforeAll(async () => {
  if (skip === undefined) server = await startServer();
}, 60_000);
afterAll(async () => {
  await server?.dispose();
});

describe.skipIf(skip !== undefined)("synthetic year of C, live", () => {
  it("writes eight days of C and keeps control_exec through the cleanup", {
    timeout: 600_000,
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "lfcp-c-year-"));
    const db = openBridgeDatabase(join(dir, "bridge.sqlite"));
    try {
      const days = Number(process.env.LFCP_C_DAYS ?? 8);
      const y = await synthesizeYear({
        url: (server as LiveServer).url,
        db,
        days,
        transitionsPerDay: Number(process.env.LFCP_C_TRANSITIONS ?? 2),
      });
      try {
        console.log(JSON.stringify({ ...y, stop: undefined }));
        expect(y.counts.questions).toBe(8 * 2 * Math.floor(days / 7));
        // The cleanup removed answers and events from C, never a control_exec row (B19).
        expect(y.controlExec.cleaned).toBeGreaterThan(0);
        expect(y.controlExec.rows).toBe(y.counts.questions);
      } finally {
        await y.stop();
      }
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
