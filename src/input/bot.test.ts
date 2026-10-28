import { beforeAll, describe, expect, it } from "vite-plus/test";
import canyon from "../../courses/canyon.json";
import graveyard from "../../courses/graveyard.json";
import pond from "../../courses/pond.json";
import { crewZones, TICK_RATE } from "../sim/constants.ts";
import { parseLevel } from "../sim/level.ts";
import { createSim, initPhysics, snapshot, step } from "../sim/sim.ts";
import type { LevelData, SimEvent } from "../sim/types.ts";
import { botSource } from "./bot.ts";
import { createSeats, readSeats } from "./sources.ts";

/** Race a crew of bots headless, exactly as the client loop does: read seats → step → snapshot. */
function race(level: LevelData, crewSize: number, seconds: number) {
  const seats = crewZones(crewSize);
  const sim = createSim(level, seats);
  let snap = snapshot(sim);
  const sources = createSeats(seats.length).map((_, i) => botSource(i, seats, level, () => snap));
  const events: SimEvent[] = [];
  const over = () => snap.phase.kind === "finished";
  for (let t = 0; t < seconds * TICK_RATE && !over(); t++) {
    events.push(...step(sim, readSeats(sources)));
    snap = snapshot(sim);
  }
  sim.world.free();
  return { snap, events };
}

/** Bots plan every crossing, so they should rarely wipe out: a few per race at most. */
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
  describe.each([1, 2, 3, 4, 6, 8])("when a crew of %i bots races", (size) => {
    it("should pass every checkpoint and finish", { timeout: RACE_TIMEOUT }, () => {
      const { snap, events } = race(level, size, seconds);
      const passed = events.filter((e) => e.type === "checkpoint").length;
      expect(passed).toBe(level.checkpoints.length - 1);
      expect(snap.phase.kind, `stuck at ${JSON.stringify(snap.raft)}`).toBe("finished");
      expect(snap.deaths, "wipeouts").toBeLessThanOrEqual(MAX_WIPEOUTS);
    });
  });
});
