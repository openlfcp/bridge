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
import { coldConnect, historyBytes, synthesizeYear, treeBytes } from "./support/c-year.js";
import { type LiveServer, serverSkip, startServer } from "./support/server.js";

const MiB = 1024 * 1024;
/**
 * A§3.5, for a year. `historyBytes` — "history of C ≤ 20 MiB on the server" — is the stored bytes of
 * C's Data Units and Snapshots (the owner's decision), not the server's database file.
 */
const BUDGET = {
  historyBytes: 20 * MiB,
  coldMs: 10_000,
  maxRssBytes: 200 * MiB,
  admissionMs: 5_000,
} as const;
/**
 * The budgets that wait on sdk-ts (admission and the cold client's time and memory): a release
 * blocker under A§3.5 until the bridge pins the fixed sdk-ts. LFCP_C_REPORT_ONLY=sdk reports them
 * without failing the run (the nightly job); the history budget and the dedup evidence still fail it.
 */
const sdkReportOnly = process.env.LFCP_C_REPORT_ONLY === "sdk";

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
      const history = historyBytes(live.stateDir, y.C);
      const figures = {
        days,
        transitionsPerDay,
        historyBytes: history.total,
        historyUnitBytes: history.units,
        historySnapshotBytes: history.snapshots,
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
        // null: the cold client failed (coldFailed says how); never within the budget.
        coldMs: "failed" in cold ? null : cold.coldMs,
        coldAdmissionMs: "failed" in cold ? null : cold.admissionMs,
        maxRssBytes: "failed" in cold ? null : cold.maxRssBytes,
        coldFailed: "failed" in cold ? cold.failed : null,
        admissionMs: admission.ms,
        admittedUnits: admission.units,
        wallMs: y.wallMs,
        budget: BUDGET,
        sdkReportOnly,
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
      expect(history.units).toBeGreaterThan(0);
      expect(history.snapshots).toBeGreaterThan(0);
      expect(history.total).toBeLessThanOrEqual(BUDGET.historyBytes);
      if (!sdkReportOnly) {
        expect("failed" in cold ? cold.failed : undefined).toBeUndefined();
        const ok = cold as Exclude<typeof cold, { failed: string }>;
        expect(ok.coldMs).toBeLessThanOrEqual(BUDGET.coldMs);
        expect(ok.maxRssBytes).toBeLessThanOrEqual(BUDGET.maxRssBytes);
        expect(admission.ms).toBeLessThanOrEqual(BUDGET.admissionMs);
      }
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
