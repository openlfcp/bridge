// The reconnect backoff of the section session, restartable (as the plugin's
// src/core/lfcp/reconnect.ts): 1 s, doubling, at most 15 s (the SDK's own
// goes to 60 s), each wait within ±20 % so that many clients do not retry in
// step. When the network comes back or the Mac wakes, the next attempt is
// made at once and, should it fail, the attempts after it wait as from the
// start.

import type { ReconnectPolicy } from "@openlfcp/client";

export const RECONNECT_CAP_MS = 15_000;
export const RECONNECT_JITTER = 0.2;

/** 1 s, doubling, at most RECONNECT_CAP_MS, forever, within ±RECONNECT_JITTER. */
export function cappedReconnect(random: () => number = Math.random): ReconnectPolicy {
  return (attempt) => {
    const nominal = Math.min(RECONNECT_CAP_MS, 1000 * 2 ** (Math.max(1, attempt) - 1));
    return Math.round(nominal * (1 - RECONNECT_JITTER + 2 * RECONNECT_JITTER * random()));
  };
}

export interface RestartableReconnect {
  /** The policy for SyncClientOptions.reconnect. */
  readonly policy: ReconnectPolicy;
  /** The attempts so far no longer count. */
  restart(): void;
}

export function restartableReconnect(
  base: ReconnectPolicy = cappedReconnect(),
): RestartableReconnect {
  let from = 0;
  let last = 0;
  return {
    policy: (attempt) => {
      // The SDK counts again from 1 after a session was READY.
      if (attempt <= from) from = 0;
      last = attempt;
      return base(attempt - from);
    },
    restart: () => {
      from = last;
    },
  };
}
