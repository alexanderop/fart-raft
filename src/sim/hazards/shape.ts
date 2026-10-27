import { BUMPER_PULSE, SWEEP_AMPLITUDE } from "../constants.ts";
import type { Box, HazardDef, Vec2 } from "../types.ts";

// Every hazard moves on a fixed schedule that starts with tick 0, so where it is at time `t`
// is a pure function of its definition. The sim bodies, the bots' planner and the renderer all
// ask these functions instead of keeping their own copy of the motion.

/** A bumper's radius `t` seconds in: it swells from `hx` to `hx · (1 + BUMPER_PULSE)` and back. */
export function bumperRadius(def: HazardDef, t: number): number {
  const swell = 0.5 + 0.5 * Math.sin(t * def.speed + (def.phase ?? 0));
  return def.hx * (1 + BUMPER_PULSE * swell);
}

/** Where a log's center is `t` seconds in: it runs back and forth across its own axis. */
export function logCenter(def: HazardDef, t: number): Vec2 {
  const run = (def.range ?? 0) * Math.sin(t * def.speed + (def.phase ?? 0));
  return { x: def.x - Math.sin(def.rot) * run, y: def.y + Math.cos(def.rot) * run };
}

/**
 * The box a hazard fills `t` seconds in. Round things get a box that bounds them (a bumper at
 * its fullest), so a planner that keeps clear of the box keeps clear of the hazard.
 */
export function hazardBox(def: HazardDef, t: number): Box {
  switch (def.kind) {
    case "spinner":
      return { ...def, rot: def.rot + def.speed * t };
    case "sweeper": {
      const rot = def.rot + SWEEP_AMPLITUDE * Math.sin(t * def.speed);
      return {
        x: def.x + Math.cos(rot) * def.hx,
        y: def.y + Math.sin(rot) * def.hx,
        rot,
        hx: def.hx,
        hy: def.hy,
      };
    }
    case "log":
      return { ...logCenter(def, t), rot: def.rot, hx: def.hx, hy: def.hy };
    case "bumper": {
      const r = def.hx * (1 + BUMPER_PULSE);
      return { x: def.x, y: def.y, rot: def.rot, hx: r, hy: r };
    }
  }
}

/** How far the hazard's swept area reaches from (x, y) along the course, m. */
export function hazardReach(def: HazardDef): number {
  switch (def.kind) {
    case "log":
      return Math.max(def.hx, def.hy);
    case "bumper":
      return def.hx * (1 + BUMPER_PULSE);
    case "sweeper":
      return 2 * def.hx; // the whole arm, hinge to tip
    case "spinner":
      return def.hx;
  }
}
