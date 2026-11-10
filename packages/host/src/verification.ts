// The write gate of the EventKit transport and the verification mode (D-010 r4 §7.6, B16).
//
// writesVerified is false until the owner's verification run passed on this helper build and this
// macOS; a change of either resets it. Until then normal bindings only dry-run. A verification
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

/** A green report sets writesVerified; any failure leaves the config unchanged. */
export function recordVerification(
  config: BridgeConfig,
  report: VerificationReport,
  now: Date = new Date(),
): BridgeConfig {
  if (report.checks.length === 0 || report.checks.some((c) => !c.ok)) return config;
  const record: WritesVerified = { ...report.helper, at: now.toISOString() };
  return { ...config, writesVerified: record };
}
