import { beforeAll, describe, expect, it } from "vite-plus/test";
import canyon from "../../courses/canyon.json";
import graveyard from "../../courses/graveyard.json";
import pond from "../../courses/pond.json";
import { parseLevel } from "../sim/level.ts";
import { initPhysics } from "../sim/sim.ts";
import { MAX_WIPEOUTS, RACE_TIMEOUT, raceBots } from "./botRace.ts";

/**
 * Team races: a raft of 4 bots against a raft of 4 bots, the rival an offline player meets.
 * Ghost rafts never touch, so each must hold the co-op bound. In Bump the rival can shove a raft
 * into a hazard, so each may take a few more (BR-5).
 */
const BOUND = { ghost: MAX_WIPEOUTS, bump: MAX_WIPEOUTS + 3 } as const;

beforeAll(() => initPhysics());

describe.each([
  ["pond", pond, 90],
  ["canyon", canyon, 330],
  ["graveyard", graveyard, 330],
] as const)("given the %s course", (_, json, seconds) => {
  const level = parseLevel(json);
  describe.each(
    (["ghost", "bump"] as const).flatMap((c) =>
      (["wild", "chill"] as const).map((d) => [c, d] as const),
    ),
  )("when two rafts of 4 bots race a %s race in %s", (contact, difficulty) => {
    it(
      "should get both rafts through every checkpoint to the finish",
      { timeout: RACE_TIMEOUT },
      () => {
        const { views, events } = raceBots(level, [4, 4], seconds, { difficulty, contact });
        views.forEach((view, raft) => {
          const passed = events.filter((e) => e.type === "checkpoint" && e.raft === raft).length;
          expect(passed, `raft ${raft} checkpoints`).toBe(level.checkpoints.length - 1);
          expect(view.phase.kind, `raft ${raft} stuck at ${JSON.stringify(view.raft)}`).toBe(
            "finished",
          );
          expect(view.deaths, `raft ${raft} wipeouts`).toBeLessThanOrEqual(BOUND[contact]);
        });
      },
    );
  });
});
