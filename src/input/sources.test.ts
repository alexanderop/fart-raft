import { describe, expect, it } from "vite-plus/test";
import { cameraRelative, mergeSources, planSeats, type SeatKind } from "./sources.ts";

const seats = (humans: number, size = 4): SeatKind[] =>
  Array.from({ length: size }, (_, i) => (i < humans ? "human" : "bot"));
const none = new Set<number>();
const src = (x: number, fart: boolean) => ({ read: () => ({ move: { x, y: 0 }, fart }) });

describe("given the seat rule", () => {
  describe("when there are more humans than pads", () => {
    it("should give pads the first human seats and keyboards the rest, first free cluster each", () => {
      const plan = planSeats(seats(3), [4], none);
      expect([...plan.pads]).toEqual([[4, 0]]);
      expect([...plan.keys]).toEqual([
        [1, 0],
        [2, 1],
      ]);
    });
  });

  describe("when there are more pads than humans", () => {
    it("should leave extra pads unassigned until they ask in", () => {
      const plan = planSeats(seats(1), [0, 1], none);
      expect([...plan.pads]).toEqual([[0, 0]]);
      expect(plan.keys.size).toBe(0);
    });

    it("should let an extra pad that asks in take a bot seat", () => {
      const plan = planSeats(seats(1), [0, 1], new Set([1]));
      expect([...plan.pads]).toEqual([
        [0, 0],
        [1, 1],
      ]);
    });
  });

  describe("when a pad connects mid-race", () => {
    it("should take over a keyboard human seat before anything else", () => {
      const before = planSeats(seats(2), [], none);
      expect([...before.keys]).toEqual([
        [0, 0],
        [1, 1],
      ]);
      const after = planSeats(seats(2), [3], none, before);
      expect([...after.pads]).toEqual([[3, 0]]);
      expect([...after.keys]).toEqual([[1, 1]]);
    });

    it("should take over a bot seat only if it asked in", () => {
      const before = planSeats(seats(1), [0], none);
      expect(planSeats(seats(1), [0, 2], none, before).pads.has(2)).toBe(false);
      expect(planSeats(seats(1), [0, 2], new Set([2]), before).pads.get(2)).toBe(1);
    });

    it("should let a bots-only game be played from a pad that asks in", () => {
      const plan = planSeats(seats(0), [5], new Set([5]));
      expect([...plan.pads]).toEqual([[5, 0]]);
    });
  });

  describe("when a pad disconnects mid-race", () => {
    it("should not move the other pads, and hand its seat back to a keyboard", () => {
      const both = planSeats(seats(2), [0, 1], none);
      expect([...both.pads]).toEqual([
        [0, 0],
        [1, 1],
      ]);
      const left = planSeats(seats(2), [1], none, both);
      expect([...left.pads]).toEqual([[1, 1]]);
      expect([...left.keys]).toEqual([[0, 0]]);
    });

    it("should hand a taken-over bot seat back to its bot", () => {
      const taken = planSeats(seats(1), [0, 1], new Set([1]));
      const gone = planSeats(seats(1), [0], none, taken);
      expect(gone.pads.has(1)).toBe(false);
      expect(gone.keys.has(1)).toBe(false);
    });
  });

  describe("when keyboard seats were already assigned", () => {
    it("should keep each on its cluster when a pad frees or takes a seat", () => {
      const first = planSeats(seats(3), [], none);
      const withPad = planSeats(seats(3), [0], none, first);
      expect([...withPad.keys]).toEqual([
        [1, 1],
        [2, 2],
      ]);
    });
  });
});

describe("given camera-relative movement", () => {
  describe("when the camera heading is 0 and the rider goes forward-left", () => {
    it("should map to +x and +y", () => {
      expect(cameraRelative(1, 1, 0)).toEqual({ x: 1, y: 1 });
    });
  });
});

describe("given two sources on one seat", () => {
  describe("when both are read", () => {
    it("should use the stronger move and any fart", () => {
      expect(mergeSources(src(0.3, false), src(-0.8, true)).read()).toEqual({
        move: { x: -0.8, y: 0 },
        fart: true,
      });
    });
  });
});
