// The write gate of the EventKit transport and the verification mode (D-010 r4 §7.6, B16).
//
// writesVerified is false until the owner's verification run passed on this helper build and this
// macOS; a change of either resets it. Until then normal bindings only dry-run. The owner records
// a green run with `lfcp-bridge verify --record <report.json>` (decideRecord below; the report is
// docs/devel/testing/verification-report.template.json, filled in). A verification
// binding (its own "LFCP Verify · …" list and test section, started by the owner) may write — once
// PR 8 enables apply; this PR has the frame and the gate.
//
// The helper's write mode per phase (the effect permissions, review r3 P2-4, rows bootstrap and
// verification; the executor's rows are PR 7's):
//   bootstrap of any binding        → "bootstrap"     (a new list and this bridge's marker only)
//   verification binding            → "verification"  (only "LFCP Verify · …" lists)
//   normal binding, writesVerified  → "verified"
//   normal binding otherwise        → "off"           (dry run only)

import type { BridgeConfig, WritesVerified } from "./config.js";

export type HelperWriteMode = "off" | "bootstrap" | "verification" | "verified";

export interface HelperIdentity {
  readonly helperVersion: string;
  readonly macOS: string;
}

/** The record holds for this helper build and macOS. */
export function writesVerified(config: BridgeConfig, helper: HelperIdentity): boolean {
  const v = config.writesVerified;
  return v !== undefined && v.helperVersion === helper.helperVersion && v.macOS === helper.macOS;
}

export function writeModeFor(
  phase: "bootstrap" | "sync",
  binding: { readonly verification: boolean },
  config: BridgeConfig,
  helper: HelperIdentity,
): HelperWriteMode {
  if (phase === "bootstrap") return binding.verification ? "verification" : "bootstrap";
  if (binding.verification) return "verification";
  return writesVerified(config, helper) ? "verified" : "off";
}

export interface VerificationReport {
  readonly helper: HelperIdentity;
  readonly checks: readonly { readonly name: string; readonly ok: boolean }[];
}

/**
 * The owner's report of a verification run (docs/devel/testing/verification-report.template.json):
 * the helper and macOS it was run on, as the person read them, and every step's outcome.
 */
export interface VerificationReportFile {
  readonly helperVersion: string;
  readonly macOS: string;
  readonly checks: readonly {
    readonly name: string;
    readonly ok: boolean;
    readonly note: string;
  }[];
}

/** Parses a report file; a string is what is wrong with it. */
export function parseVerificationReport(text: string): VerificationReportFile | string {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return `not JSON: ${(e as Error).message}`;
  }
  const o = v as Record<string, unknown>;
  if (typeof o !== "object" || o === null) return "not a JSON object";
  // Empty until the person fills them in: the refusal then says what this machine runs.
  if (typeof o.helperVersion !== "string")
    return "helperVersion: the helper version the run was done with";
  if (typeof o.macOS !== "string") return "macOS: the macOS version of the run";
  if (!Array.isArray(o.checks)) return "checks: an array of {name, ok, note}";
  const checks: VerificationReportFile["checks"][number][] = [];
  for (const [i, c] of (o.checks as unknown[]).entries()) {
    const x = c as Record<string, unknown>;
    if (typeof x !== "object" || x === null || typeof x.name !== "string" || x.name === "")
      return `checks[${i}]: no name`;
    if (typeof x.ok !== "boolean") return `checks[${i}] (${x.name}): ok must be true or false`;
    checks.push({ name: x.name, ok: x.ok, note: typeof x.note === "string" ? x.note : "" });
  }
  return { helperVersion: o.helperVersion, macOS: o.macOS, checks };
}

export type RecordDecision =
  | { readonly kind: "record"; readonly config: BridgeConfig; readonly record: WritesVerified }
  | {
      readonly kind: "refused";
      readonly reason: "no_binding" | "no_helper" | "helper_mismatch" | "incomplete" | "not_green";
      readonly detail: string;
    };

/**
 * The steps of the owner's checklist (docs/devel/testing/verification-run.md §4), by the names the
 * report template gives them (verification-report.template.json): every one must be in a report
 * and ok. A changed checklist changes both, together (a test compares them).
 */
export const VERIFICATION_STEPS: readonly string[] = Object.freeze([
  "1 Obsidian: new task with a date → a reminder on iPhone, date without time",
  "2 Obsidian: rename → the reminder is renamed",
  "3 iPhone: rename → the task is renamed",
  "4 iPhone: time, alarm, note → the task's date unchanged; they stay on iPhone",
  "5 iPhone: date moved → the task's date moved",
  "6 Obsidian: rename again → time, alarm and note of step 4 kept",
  "7 iPhone: priority high → the task's priority high",
  "8 iPhone: completed → the task done with today's date",
  "9 Obsidian: reopened → the reminder not completed",
  "10 iPhone: a new reminder → a task at the end of the section, linked",
  "11 the bridge's link survives a person's edits of the reminder",
  "12 Obsidian: cancelled → the reminder completed, the task stays cancelled",
  "13 iPhone: reminder deleted → the task stays, unlinked, not recreated",
  "14 iPhone: reminder moved to another list → guard_mass_unlink hold",
  "15 resume --accept guard_mass_unlink → unlinked moved_out",
  "16 Obsidian: task deleted → hold, accept → the reminder stays",
  "17 stop → no sync",
  "18 resume → the rename goes",
  "19 Obsidian: 4 tasks deleted at once → holds, accept → the reminders stay",
  "20 Ctrl-C and run again → works",
  "21 due removed on one side, changed on the other → the outcome of the checklist",
  "22 lost answer: helper killed during a write → restarted, no duplicate, no loss",
  "23 a repeating reminder in the list → the bridge keeps working",
]);

/**
 * Whether a report sets writesVerified (§7.6): the verification binding exists, the running helper
 * is known and is the one the report names, every step of VERIFICATION_STEPS is in it, and every
 * check is ok (an added one too). The record's identity is the running helper's, never the file's.
 */
export function decideRecord(
  config: BridgeConfig,
  report: VerificationReportFile,
  o: {
    readonly running: HelperIdentity | undefined;
    readonly verificationBinding: boolean;
    readonly now?: Date;
  },
): RecordDecision {
  if (!o.verificationBinding)
    return {
      kind: "refused",
      reason: "no_binding",
      detail: "no verification binding: the run is made on one (lfcp-bridge verify --section …)",
    };
  const running = o.running;
  if (running === undefined || running.helperVersion === "" || running.macOS === "")
    return {
      kind: "refused",
      reason: "no_helper",
      detail: "the running helper's version or macOS is unknown (is the helper app installed?)",
    };
  if (report.helperVersion !== running.helperVersion || report.macOS !== running.macOS)
    return {
      kind: "refused",
      reason: "helper_mismatch",
      detail:
        report.helperVersion === "" || report.macOS === ""
          ? `the report does not say which helper and macOS the run was on; this machine runs helper ${running.helperVersion} on macOS ${running.macOS}: if that is what you tested, write them into the report`
          : `the report is for helper ${report.helperVersion} on macOS ${report.macOS}; this machine runs helper ${running.helperVersion} on macOS ${running.macOS}`,
    };
  const named = new Set(report.checks.map((c) => c.name));
  const missing = VERIFICATION_STEPS.filter((s) => !named.has(s));
  if (missing.length > 0)
    return {
      kind: "refused",
      reason: "incomplete",
      detail: `steps missing from the report (names as in the template): ${missing.join("; ")}`,
    };
  const failed = report.checks.filter((c) => !c.ok);
  if (failed.length > 0)
    return {
      kind: "refused",
      reason: "not_green",
      detail: `not ok: ${failed.map((c) => c.name).join("; ")}`,
    };
  const config2 = recordVerification(
    config,
    { helper: running, checks: report.checks },
    o.now ?? new Date(),
  );
  return { kind: "record", config: config2, record: config2.writesVerified as WritesVerified };
}

/** A green report sets writesVerified; any failure leaves the config unchanged. */
export function recordVerification(
  config: BridgeConfig,
  report: VerificationReport,
  now: Date = new Date(),
): BridgeConfig {
  if (report.checks.length === 0 || report.checks.some((c) => !c.ok)) return config;
  const record: WritesVerified = {
    helperVersion: report.helper.helperVersion,
    macOS: report.helper.macOS,
    at: now.toISOString(),
  };
  return { ...config, writesVerified: record };
}
