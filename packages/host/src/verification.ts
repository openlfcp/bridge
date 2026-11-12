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
  if (typeof o.helperVersion !== "string" || o.helperVersion === "")
    return "helperVersion: the helper version the run was done with";
  if (typeof o.macOS !== "string" || o.macOS === "") return "macOS: the macOS version of the run";
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
      readonly reason: "no_binding" | "no_helper" | "helper_mismatch" | "not_green";
      readonly detail: string;
    };

/**
 * Whether a report sets writesVerified (§7.6): the verification binding exists, the running helper
 * is known and is the one the report names, and every check is ok (at least one). The record's
 * identity is the running helper's, never the file's.
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
      detail: `the report is for helper ${report.helperVersion} on macOS ${report.macOS}; this machine runs helper ${running.helperVersion} on macOS ${running.macOS}`,
    };
  const failed = report.checks.filter((c) => !c.ok);
  if (report.checks.length === 0 || failed.length > 0)
    return {
      kind: "refused",
      reason: "not_green",
      detail:
        report.checks.length === 0
          ? "the report has no checks"
          : `not ok: ${failed.map((c) => c.name).join("; ")}`,
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
