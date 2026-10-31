import { describe, expect, it } from "vite-plus/test";
import { afterFailure, ONE_TRY, RETRY_FOR_MS, RETRY_MAX_MS, retryFrom } from "./reconnect.ts";

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
