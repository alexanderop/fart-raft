import { crewZones, TICK_RATE } from "../sim/constants.ts";
import { createSim, snapshot, step } from "../sim/sim.ts";
import { viewOf } from "../sim/view.ts";
import type { Contact, Difficulty, LevelData, SimEvent, View } from "../sim/types.ts";
import { botSource } from "./bot.ts";

/**
 * Bots plan every crossing, so they should rarely wipe out: a few per race at most. Wild is the
 * bound the courses are tuned against; chill only slows the hazards, so it must hold there too.
 */
export const MAX_WIPEOUTS = 3;

/** A race is up to a few minutes of game time, planned tick by tick: give it real time. */
export const RACE_TIMEOUT = 120_000;

/**
 * Race one bot crew per raft headless, exactly as the client loop does: read seats → step →
 * snapshot. `crews[r]` is raft r's crew size. Stops once every raft finished or `seconds` ran out;
 * returns each raft's last View and every event.
 */
export function raceBots(
  level: LevelData,
  crews: readonly number[],
  seconds: number,
  options: { difficulty: Difficulty; contact?: Contact },
): { views: View[]; events: SimEvent[] } {
  const zones = crews.map((n) => crewZones(n));
  const sim = createSim(level, zones, options);
  const look = () => {
    const race = snapshot(sim);
    return zones.map((_, r) => viewOf(race, r));
  };
  let views = look();
  const sources = zones.flatMap((seats, r) =>
    seats.map((_, i) => botSource(i, seats, level, () => views[r]!)),
  );
  const events: SimEvent[] = [];
  const over = () => views.every((v) => v.phase.kind === "finished");
  for (let t = 0; t < seconds * TICK_RATE && !over(); t++) {
    events.push(
      ...step(
        sim,
        sources.map((s) => s.read()),
      ),
    );
    views = look();
  }
  sim.world.free();
  return { views, events };
}
