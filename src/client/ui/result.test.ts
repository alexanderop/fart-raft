import { describe, expect, it } from "vite-plus/test";
import { TICK_RATE } from "../../sim/constants.ts";
import type { Crew, Phase } from "../../sim/types.ts";
import { teamResult } from "./result.ts";

const crew = (phase: Phase, deaths = 0): Crew => ({
  raft: { x: 0, y: 0, rot: 0 },
  riders: [],
  gas: [],
  deaths,
  respawnIn: 0,
  invulnerable: 0,
  phase,
});
const racing = (startTick: number): Phase => ({ kind: "racing", startTick, nextCheckpoint: 3 });
const finished = (timeMs: number): Phase => ({ kind: "finished", timeMs });

describe("given a team race", () => {
  describe("when both rafts are still racing", () => {
    it("should have no result", () => {
      expect(teamResult([crew(racing(0)), crew(racing(0))], 600)).toBeNull();
    });
  });

  describe("when Blue finished and Red still races", () => {
    const crews = [crew(racing(0), 2), crew(finished(10_000), 1)];

    it("should name Blue the winner and grow the gap with Red's clock", () => {
      const at12s = teamResult(crews, 12 * TICK_RATE)!;
      expect(at12s.winner).toBe(1);
      expect(at12s.settled).toBe(false);
      expect(at12s.gapMs).toBeCloseTo(2000);
      expect(teamResult(crews, 13 * TICK_RATE)!.gapMs).toBeCloseTo(3000);
    });
  });

  describe("when both rafts finished", () => {
    it("should fix the gap and list both times and wipeouts", () => {
      const result = teamResult([crew(finished(14_500), 2), crew(finished(10_000), 1)], 99_999)!;
      expect(result).toMatchObject({ winner: 1, gapMs: 4500, settled: true });
      expect(result.rows).toEqual([
        { raft: 0, timeMs: 14_500, finished: true, deaths: 2 },
        { raft: 1, timeMs: 10_000, finished: true, deaths: 1 },
      ]);
    });
  });

  describe("when both rafts finished on the same tick", () => {
    it("should be a draw with no gap", () => {
      const result = teamResult([crew(finished(10_000)), crew(finished(10_000))], 700)!;
      expect(result).toMatchObject({ winner: "draw", gapMs: 0, settled: true });
    });
  });
});
