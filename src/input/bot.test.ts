import { beforeAll, describe, expect, it } from "vite-plus/test";
import canyon from "../../courses/canyon.json";
import graveyard from "../../courses/graveyard.json";
import pond from "../../courses/pond.json";
import { crewZones, TICK_RATE } from "../sim/constants.ts";
import { parseLevel } from "../sim/level.ts";
import { createSim, initPhysics, snapshot, step } from "../sim/sim.ts";
import { viewOf } from "../sim/view.ts";
import type { Difficulty, LevelData, SimEvent } from "../sim/types.ts";
import { botSource } from "./bot.ts";
import { createSeats, readSeats } from "./sources.ts";

/** Race a crew of bots headless, exactly as the client loop does: read seats → step → snapshot. */
function race(level: LevelData, crewSize: number, seconds: number, difficulty: Difficulty) {
  const seats = crewZones(crewSize);
  const sim = createSim(level, [seats], { difficulty });
  let snap = viewOf(snapshot(sim), 0);
  const sources = createSeats(seats.length).map((_, i) => botSource(i, seats, level, () => snap));
  const events: SimEvent[] = [];
  const over = () => snap.phase.kind === "finished";
  for (let t = 0; t < seconds * TICK_RATE && !over(); t++) {
    events.push(...step(sim, readSeats(sources)));
    snap = viewOf(snapshot(sim), 0);
  }
  sim.world.free();
  return { snap, events };
}

/**
 * Bots plan every crossing, so they should rarely wipe out: a few per race at most. Wild is the
 * bound the courses are tuned against; chill only slows the hazards, so it must hold there too.
 */
const MAX_WIPEOUTS = 3;

/** A race is up to a few minutes of game time, planned tick by tick: give it real time. */
const RACE_TIMEOUT = 120_000;

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
      const { snap, events } = race(level, size, seconds, difficulty);
      const passed = events.filter((e) => e.type === "checkpoint").length;
      expect(passed).toBe(level.checkpoints.length - 1);
      expect(snap.phase.kind, `stuck at ${JSON.stringify(snap.raft)}`).toBe("finished");
      expect(snap.deaths, "wipeouts").toBeLessThanOrEqual(MAX_WIPEOUTS);
    });
  });
});
