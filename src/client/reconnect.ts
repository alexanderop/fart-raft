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

/**
 * Where an online state is with its seat: `waiting` for the next attempt, `trying` one (`manual`
 * from the Reconnect button), or `stopped` with the reason to show.
 */
export type Reconnect =
  | { kind: "connected" }
  | { kind: "waiting"; retry: Retry; wait: number }
  | { kind: "trying"; retry: Retry; manual: boolean }
  | { kind: "stopped"; text: string; reconnect: boolean };

export type ReconnectSignal =
  | { kind: "dropped"; now: number }
  /** The wait ran out. */
  | { kind: "due" }
  | { kind: "back" }
  | { kind: "failed"; failure: JoinFailure; now: number }
  /** The Reconnect button. */
  | { kind: "reconnect" };

export const CONNECTED: Reconnect = { kind: "connected" };

/** The next state; the same object when the signal does not apply. */
export function reconnectStep(state: Reconnect, signal: ReconnectSignal): Reconnect {
  switch (signal.kind) {
    case "dropped":
      return { kind: "waiting", retry: retryFrom(signal.now), wait: RETRY_FIRST_MS };
    case "due":
      return state.kind === "waiting"
        ? { kind: "trying", retry: state.retry, manual: false }
        : state;
    case "back":
      return state.kind === "trying" ? CONNECTED : state;
    case "reconnect":
      return state.kind === "stopped" && state.reconnect
        ? { kind: "trying", retry: ONE_TRY, manual: true }
        : state;
  }
  if (state.kind !== "trying") return state;
  const step = afterFailure(signal.failure, state.retry, signal.now);
  return step.kind === "retry"
    ? { kind: "waiting", retry: step.next, wait: step.wait }
    : { kind: "stopped", text: step.text, reconnect: step.reconnect };
}

/** What the banner says in `state`, or null for no banner. */
export function bannerOf(
  state: Reconnect,
): { text: string; tone: "info" | "error"; reconnect: boolean } | null {
  switch (state.kind) {
    case "connected":
      return null;
    case "waiting":
      return { text: "Connection lost · Reconnecting…", tone: "info", reconnect: false };
    case "trying":
      return {
        text: state.manual ? "Reconnecting…" : "Connection lost · Reconnecting…",
        tone: "info",
        reconnect: false,
      };
  }
  return { text: state.text, tone: "error", reconnect: state.reconnect };
}
