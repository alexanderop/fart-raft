import type { JoinFailure } from "../net/client.ts";
import { RECONNECT_GRACE_MS } from "../net/protocol.ts";

/**
 * After a drop, how long to keep rejoining on our own: stops short of the server's grace, so a
 * last attempt (up to its timeout) still finds the seat held.
 */
export const RETRY_FOR_MS = RECONNECT_GRACE_MS - 5000;
/** Waits between rejoin attempts: doubling from the first, capped. */
export const RETRY_FIRST_MS = 250;
export const RETRY_MAX_MS = 4000;

/** A run of rejoin attempts: try again until `until` (epoch ms), next after `wait` ms. */
export type Retry = { until: number; wait: number };

/** The automatic run that starts when the connection drops at `now`. */
export const retryFrom = (now: number): Retry => ({
  until: now + RETRY_FOR_MS,
  wait: RETRY_FIRST_MS,
});

/** The Reconnect button: one attempt, no automatic ones after it. */
export const ONE_TRY: Retry = { until: 0, wait: 0 };

/**
 * What to do after a failed rejoin: wait and try again, or stop and say why. `reconnect` offers
 * the Reconnect button, only when trying again later could work.
 */
export type NextStep =
  | { kind: "retry"; wait: number; next: Retry }
  | { kind: "stop"; text: string; reconnect: boolean };

/** The room will not take us back whatever we do: stop at once. */
const FINAL: Partial<Record<JoinFailure, string>> = {
  gone: "Room closed · Esc for menu",
  full: "Room is full · Esc for menu",
};

/** The retry policy: a gone or full room stops at once, network trouble retries until `until`. */
export function afterFailure(failure: JoinFailure, retry: Retry, now: number): NextStep {
  const final = FINAL[failure];
  if (final !== undefined) return { kind: "stop", text: final, reconnect: false };
  if (now + retry.wait < retry.until)
    return {
      kind: "retry",
      wait: retry.wait,
      next: { until: retry.until, wait: Math.min(retry.wait * 2, RETRY_MAX_MS) },
    };
  return { kind: "stop", text: "Connection lost · Esc for menu", reconnect: true };
}
