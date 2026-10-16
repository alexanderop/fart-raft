import { beforeAll, describe, expect, it } from "vite-plus/test";
import canyon from "../../courses/canyon.json";
import pond from "../../courses/pond.json";
import { crewZones, TICK_RATE } from "../sim/constants";
import { parseLevel } from "../sim/level";
import { createSim, initPhysics, snapshot, step } from "../sim/sim";
import type { LevelData, SimEvent } from "../sim/types";
import { botSource } from "./bot";
import { createSeats, readSeats } from "./sources";

/** Race a crew of bots headless, exactly as the client loop does: read seats → step → snapshot. */
function race(level: LevelData, crewSize: number, seconds: number) {
  const seats = crewZones(crewSize);
  const sim = createSim(level, seats);
  let snap = snapshot(sim);
  const sources = createSeats(seats.length).map((_, i) => botSource(i, seats, level, () => snap));
  const events: SimEvent[] = [];
  for (let t = 0; t < seconds * TICK_RATE && snap.phase.kind !== "finished"; t++) {
    events.push(...step(sim, readSeats(sources)));
    snap = snapshot(sim);
  }
  sim.world.free();
  return { snap, events };
}

beforeAll(() => initPhysics());

describe.each([
  ["pond", pond, 90],
  ["canyon", canyon, 330],
] as const)("given the %s course", (_, json, seconds) => {
  const level = parseLevel(json);
  describe.each([1, 2, 3, 4])("when a crew of %i bots races", (size) => {
    it("should pass every checkpoint and finish", () => {
      const { snap, events } = race(level, size, seconds);
      const passed = events.filter((e) => e.type === "checkpoint").length;
      expect(passed).toBe(level.checkpoints.length - 1);
      expect(snap.phase.kind, `stuck at ${JSON.stringify(snap.raft)}`).toBe("finished");
    });
  });
});
