import { beforeAll, describe, expect, it } from "vite-plus/test";
import canyon from "../../courses/canyon.json";
import graveyard from "../../courses/graveyard.json";
import pond from "../../courses/pond.json";
import { parseLevel } from "../sim/level.ts";
import { initPhysics } from "../sim/sim.ts";
import { MAX_WIPEOUTS, RACE_TIMEOUT, raceBots } from "./botRace.ts";

beforeAll(() => initPhysics());

describe.each([
  ["pond", pond, 90],
  ["canyon", canyon, 330],
  ["graveyard", graveyard, 330],
] as const)("given the %s course", (_, json, seconds) => {
  const level = parseLevel(json);
  // 6 and 8 stand in for the big online crews: one raft, so the same courses must stay passable.
  describe.each(
    (["wild", "chill"] as const).flatMap((d) => [1, 2, 3, 4, 6, 8].map((n) => [n, d] as const)),
  )("when a crew of %i bots races %s", (size, difficulty) => {
    it("should pass every checkpoint and finish", { timeout: RACE_TIMEOUT }, () => {
      const { views, events } = raceBots(level, [size], seconds, { difficulty });
      const view = views[0]!;
      const passed = events.filter((e) => e.type === "checkpoint").length;
      expect(passed).toBe(level.checkpoints.length - 1);
      expect(view.phase.kind, `stuck at ${JSON.stringify(view.raft)}`).toBe("finished");
      expect(view.deaths, "wipeouts").toBeLessThanOrEqual(MAX_WIPEOUTS);
    });
  });
});
