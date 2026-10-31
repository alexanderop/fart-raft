import { describe, expect, it } from "vite-plus/test";
import {
  afterFailure,
  bannerOf,
  CONNECTED,
  ONE_TRY,
  RETRY_FIRST_MS,
  RETRY_FOR_MS,
  RETRY_MAX_MS,
  reconnectStep,
  retryFrom,
  type Reconnect,
  type ReconnectSignal,
} from "./reconnect.ts";

describe("given a dropped connection's rejoin attempts", () => {
  const now = 1_000_000;

  describe("when the room is gone", () => {
    it("should stop at once with Room closed and no Reconnect button", () => {
      expect(afterFailure("gone", retryFrom(now), now)).toEqual({
        kind: "stop",
        text: "Room closed · Esc for menu",
        reconnect: false,
      });
    });
  });

  describe("when the room is full", () => {
    it("should stop at once with Room is full and no Reconnect button", () => {
      expect(afterFailure("full", retryFrom(now), now)).toEqual({
        kind: "stop",
        text: "Room is full · Esc for menu",
        reconnect: false,
      });
    });
  });

  describe("when the network fails within the retry window", () => {
    it("should retry with doubling waits capped at the maximum", () => {
      const waits: number[] = [];
      let retry = retryFrom(now);
      for (let i = 0; i < 7; i++) {
        const step = afterFailure("unreachable", retry, now);
        if (step.kind !== "retry") throw new Error("expected a retry");
        waits.push(step.wait);
        retry = step.next;
      }
      expect(waits).toEqual([250, 500, 1000, 2000, RETRY_MAX_MS, RETRY_MAX_MS, RETRY_MAX_MS]);
    });
  });

  describe("when the network still fails after the retry window", () => {
    it("should stop with Connection lost and offer Reconnect", () => {
      expect(afterFailure("lost", retryFrom(now), now + RETRY_FOR_MS)).toEqual({
        kind: "stop",
        text: "Connection lost · Esc for menu",
        reconnect: true,
      });
    });
  });

  describe("when the Reconnect button's one try fails", () => {
    it("should stop again instead of retrying", () => {
      expect(afterFailure("unreachable", ONE_TRY, now)).toMatchObject({ kind: "stop" });
    });
  });
});

const run = (...signals: ReconnectSignal[]): Reconnect => signals.reduce(reconnectStep, CONNECTED);

describe("given an online state holding its seat", () => {
  const now = 1_000_000;

  describe("when the connection drops", () => {
    it("should wait the first retry delay and say it is reconnecting", () => {
      const state = run({ kind: "dropped", now });
      expect(state).toMatchObject({ kind: "waiting", wait: RETRY_FIRST_MS });
      expect(bannerOf(state)).toEqual({
        text: "Connection lost · Reconnecting…",
        tone: "info",
        reconnect: false,
      });
    });
  });

  describe("when the first attempt gets back in", () => {
    it("should be connected with no banner", () => {
      const state = run({ kind: "dropped", now }, { kind: "due" }, { kind: "back" });
      expect(state).toEqual(CONNECTED);
      expect(bannerOf(state)).toBeNull();
    });
  });

  describe("when attempts keep failing on the network", () => {
    it("should wait again before each next attempt", () => {
      const state = run(
        { kind: "dropped", now },
        { kind: "due" },
        { kind: "failed", failure: "unreachable", now },
      );
      expect(state).toMatchObject({ kind: "waiting", wait: RETRY_FIRST_MS });
      expect(
        run(
          { kind: "dropped", now },
          { kind: "due" },
          { kind: "failed", failure: "unreachable", now },
          { kind: "due" },
          { kind: "failed", failure: "unreachable", now },
        ),
      ).toMatchObject({ kind: "waiting", wait: 2 * RETRY_FIRST_MS });
    });
  });

  describe("when the room is gone", () => {
    it("should stop with no Reconnect button, and ignore a click", () => {
      const state = run(
        { kind: "dropped", now },
        { kind: "due" },
        { kind: "failed", failure: "gone", now },
      );
      expect(bannerOf(state)).toEqual({
        text: "Room closed · Esc for menu",
        tone: "error",
        reconnect: false,
      });
      expect(reconnectStep(state, { kind: "reconnect" })).toBe(state);
    });
  });

  describe("when the retry window runs out and the player presses Reconnect", () => {
    const stopped = run(
      { kind: "dropped", now },
      { kind: "due" },
      { kind: "failed", failure: "lost", now: now + RETRY_FOR_MS },
    );

    it("should offer the button, then try once and say Reconnecting", () => {
      expect(bannerOf(stopped)).toMatchObject({ tone: "error", reconnect: true });
      const trying = reconnectStep(stopped, { kind: "reconnect" });
      expect(trying).toEqual({ kind: "trying", retry: ONE_TRY, manual: true });
      expect(bannerOf(trying)).toMatchObject({ text: "Reconnecting…", reconnect: false });
    });

    it("should stop again when that one try fails", () => {
      const again = run(
        { kind: "dropped", now },
        { kind: "due" },
        { kind: "failed", failure: "lost", now: now + RETRY_FOR_MS },
        { kind: "reconnect" },
        { kind: "failed", failure: "unreachable", now },
      );
      expect(again).toMatchObject({ kind: "stopped", reconnect: true });
    });
  });

  describe("when a stale timer or result arrives while connected", () => {
    it("should change nothing", () => {
      expect(reconnectStep(CONNECTED, { kind: "due" })).toBe(CONNECTED);
      expect(reconnectStep(CONNECTED, { kind: "failed", failure: "lost", now })).toBe(CONNECTED);
    });
  });
});
