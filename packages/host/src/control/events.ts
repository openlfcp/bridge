// The machine of `events/<rid|aid>` (A§3.3): received → executing → a final state (applied,
// failed{code}, rejected{code}, stale, cancelled); pair-section passes request-ready → ready on
// the way. A state only moves forward; a final one never changes. A repeatable code (network,
// helper_unavailable, server_429) is not an outcome: the event stays executing.

import {
  EVENT_STATES,
  type EventState,
  FINAL_EVENT_STATES,
} from "@openlfcp/shared-objects/service-control";

export { EVENT_STATES, type EventState };

/** The codes that keep an event `executing` (A§3.3): tried again, never final. */
export const REPEATABLE_CODES: ReadonlySet<string> = new Set([
  "network",
  "helper_unavailable",
  "server_429",
]);

/** The codes of a final `failed`/`rejected`/`stale` (A§3.3, §3.5a; already_answered §3.4). */
export const FINAL_CODES: ReadonlySet<string> = new Set([
  "stale_generation",
  "snapshot_changed",
  "too_large",
  "capacity",
  "uncertified",
  "not_permitted",
  "unresolved_work",
  "unsupported_op",
  "already_answered",
]);

export const isFinal = (s: EventState): boolean => FINAL_EVENT_STATES.has(s);

/** Whether an event may go from `from` to `to` (`op` decides whether request-ready/ready exist). */
export function canAdvance(from: EventState, to: EventState, op?: string | null): boolean {
  if (isFinal(from)) return false;
  if ((to === "request-ready" || to === "ready") && op !== "pair-section") return false;
  return EVENT_STATES.indexOf(to) > EVENT_STATES.indexOf(from);
}

/** The code an outcome carries: a final one is checked; a repeatable one is not an outcome. */
export function checkCode(state: EventState, code: string | undefined): void {
  if (code !== undefined && REPEATABLE_CODES.has(code))
    throw new Error(`${code} is repeatable: the event stays executing`);
  if (
    (state === "failed" || state === "rejected") &&
    (code === undefined || !FINAL_CODES.has(code))
  )
    throw new Error(`${state} needs a final code, not ${code ?? "none"}`);
}
