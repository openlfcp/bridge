// The synthetic year of C (A§3.5, T§3; E-030): on every L2 run, a short, sparse year (eight days,
// past the seven-day cleanup) checks the generator, the measures and that the cleanup of C leaves
// control_exec whole. `pnpm c-year` (LFCP_C_YEAR=1) runs the year of T§3 — 365 days, 20
// transitions a day per binding — and holds it to the budget of A§3.5; LFCP_C_DAYS and
// LFCP_C_TRANSITIONS change it, LFCP_C_REPORT names a JSON file for the figures. The nightly
// c-year.yml runs it. Skipped without LFCP_SERVER_BIN.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openBridgeDatabase } from "../src/index.js";
import { coldConnect, synthesizeYear, treeBytes } from "./support/c-year.js";
import { type LiveServer, serverSkip, startServer } from "./support/server.js";

const MiB = 1024 * 1024;
/** A§3.5, for a year. */
const BUDGET = {
  serverBytes: 20 * MiB,
  coldMs: 10_000,
  maxRssBytes: 200 * MiB,
  admissionMs: 5_000,
} as const;

const year = process.env.LFCP_C_YEAR === "1";
const days = Number(process.env.LFCP_C_DAYS ?? (year ? 365 : 8));
const transitionsPerDay = Number(process.env.LFCP_C_TRANSITIONS ?? (year ? 20 : 2));

const skip = serverSkip();
let server: LiveServer | undefined;
beforeAll(async () => {
  if (skip === undefined) server = await startServer();
}, 60_000);
afterAll(async () => {
  await server?.dispose();
});

describe.skipIf(skip !== undefined)("synthetic year of C, live", () => {
  it(`writes ${days} days of C within the budget; control_exec keeps the dedup evidence`, {
    timeout: year ? 6 * 3_600_000 : 600_000,
  }, async () => {
    const live = server as LiveServer;
    const dir = mkdtempSync(join(tmpdir(), "lfcp-c-year-"));
    const db = openBridgeDatabase(join(dir, "bridge.sqlite"));
    try {
      const y = await synthesizeYear({
        url: live.url,
        db,
        days,
        transitionsPerDay,
        onWeek: (w, units) => {
          if (year) console.log(`week ${w}: ${units} units`);
        },
      });
      let cold: Awaited<ReturnType<typeof coldConnect>>;
      try {
        cold = await coldConnect(live.url, y);
      } finally {
        await y.stop();
      }
      const admission = await y.admitHistory();
      // What the server keeps, its write-ahead log checkpointed: stopped, not disposed.
      await live.stop();
      const figures = {
        days,
        transitionsPerDay,
        serverBytes: treeBytes(live.stateDir),
        serverFiles: Object.fromEntries(
          readdirSync(live.stateDir, { recursive: true, withFileTypes: true })
            .filter((e) => e.isFile())
            .map((e) => {
              const p = join(e.parentPath, e.name);
              return [p.slice(live.stateDir.length + 1), statSync(p).size];
            }),
        ),
        units: y.units,
        unitBytes: y.bytes,
        counts: y.counts,
        controlExec: y.controlExec,
        coldMs: cold.coldMs,
        coldAdmissionMs: cold.admissionMs,
        maxRssBytes: cold.maxRssBytes,
        admissionMs: admission.ms,
        admittedUnits: admission.units,
        wallMs: y.wallMs,
        budget: BUDGET,
      };
      console.log(JSON.stringify(figures));
      const report = process.env.LFCP_C_REPORT;
      if (report !== undefined && report !== "") {
        mkdirSync(dirname(report), { recursive: true });
        writeFileSync(report, `${JSON.stringify(figures, null, 2)}\n`);
      }

      expect(y.counts.questions).toBe(8 * 2 * Math.floor(days / 7));
      // The cleanup removed answers and events from C, never a control_exec row (B19).
      expect(y.controlExec.cleaned).toBeGreaterThan(0);
      expect(y.controlExec.kept).toBe(y.controlExec.cleaned);
      expect(y.controlExec.rows).toBe(y.counts.questions);
      expect(admission.units).toBe(y.units.bridge + y.units.root);
      // The budget is the year's; a shorter one is within it too.
      expect(figures.serverBytes).toBeLessThanOrEqual(BUDGET.serverBytes);
      expect(cold.coldMs).toBeLessThanOrEqual(BUDGET.coldMs);
      expect(cold.maxRssBytes).toBeLessThanOrEqual(BUDGET.maxRssBytes);
      expect(admission.ms).toBeLessThanOrEqual(BUDGET.admissionMs);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
