import {
  BUMPER_PULSE,
  HAMMER_ARM,
  HAMMER_HIT_LIFT,
  PISTON_HOLD,
  PISTON_REST,
  SWEEP_AMPLITUDE,
} from "../constants.ts";
import type { Box, HazardDef, Vec2 } from "../types.ts";

// Every hazard moves on a fixed schedule that starts with tick 0, so where it is at time `t`
// is a pure function of its definition. The sim bodies, the bots' planner and the renderer all
// ask these functions instead of keeping their own copy of the motion.

/** Where in its cycle a hazard is `t` seconds in: 0..1, one cycle per 2π / speed seconds. */
function cycle(def: HazardDef, t: number): number {
  const u = (t * def.speed + (def.phase ?? 0)) / (2 * Math.PI);
  return u - Math.floor(u);
}

const smoothstep = (x: number) => x * x * (3 - 2 * x);
const span = (u: number, from: number, to: number) =>
  Math.min(1, Math.max(0, (u - from) / (to - from)));

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
 * How high a hammer's arm is raised `t` seconds in, radians above the water (π/2 = straight up).
 * Each cycle it hangs up high, rears back a little more (the tell), slams down, rests on the
 * water, then slowly lifts again.
 */
export function hammerLift(def: HazardDef, t: number): number {
  const u = cycle(def, t);
  const up = Math.PI / 2;
  if (u < 0.4) return up;
  if (u < 0.55) return up + 0.35 * smoothstep(span(u, 0.4, 0.55)); // rear back
  if (u < 0.62) return (up + 0.35) * (1 - span(u, 0.55, 0.62) ** 2); // slam
  if (u < 0.8) return 0; // down: the smash zone is deadly
  return up * smoothstep(span(u, 0.8, 1));
}

/** Is the hammer down on its smash zone? Only then does it hurt. */
export const hammerDown = (def: HazardDef, t: number): boolean =>
  hammerLift(def, t) < HAMMER_HIT_LIFT;

/** Where the hammer's pivot sits on the bank: HAMMER_ARM m back from the smash zone, along `rot`. */
export function hammerPivot(def: HazardDef): Vec2 {
  return { x: def.x - Math.cos(def.rot) * HAMMER_ARM, y: def.y - Math.sin(def.rot) * HAMMER_ARM };
}

/**
 * How far a piston has punched out `t` seconds in, 0 (in the bank) to 1 (`range` m out). Each
 * cycle it rests, shoots out, holds for PISTON_HOLD of the cycle, then slides back.
 */
export function pistonOut(def: HazardDef, t: number): number {
  const u = cycle(def, t);
  const shot = PISTON_REST + 0.06;
  if (u < PISTON_REST) return 0;
  if (u < shot) return 1 - (1 - span(u, PISTON_REST, shot)) ** 3;
  if (u < shot + PISTON_HOLD) return 1;
  return 1 - smoothstep(span(u, shot + PISTON_HOLD, 1));
}

/** Where a piston's head is `t` seconds in: `range` m along `rot` from its rest at (x, y), times pistonOut. */
export function pistonCenter(def: HazardDef, t: number): Vec2 {
  const out = (def.range ?? 0) * pistonOut(def, t);
  return { x: def.x + Math.cos(def.rot) * out, y: def.y + Math.sin(def.rot) * out };
}

/** A box no raft ever comes near: what a raised hammer fills. */
const NOWHERE: Box = { x: 1e6, y: 1e6, rot: 0, hx: 0, hy: 0 };

/**
 * The boxes a hazard fills `t` seconds in. Round things get a box that bounds them (a bumper at
 * its fullest), so a planner that keeps clear of the boxes keeps clear of the hazard.
 */
export function hazardBoxes(def: HazardDef, t: number): Box[] {
  switch (def.kind) {
    case "spinner":
      return [{ ...def, rot: def.rot + def.speed * t }];
    case "cross": {
      const rot = def.rot + def.speed * t;
      return [
        { ...def, rot },
        { ...def, rot: rot + Math.PI / 2 },
      ];
    }
    case "sweeper": {
      const rot = def.rot + SWEEP_AMPLITUDE * Math.sin(t * def.speed);
      return [
        {
          x: def.x + Math.cos(rot) * def.hx,
          y: def.y + Math.sin(rot) * def.hx,
          rot,
          hx: def.hx,
          hy: def.hy,
        },
      ];
    }
    case "log":
      return [{ ...logCenter(def, t), rot: def.rot, hx: def.hx, hy: def.hy }];
    case "bumper": {
      const r = def.hx * (1 + BUMPER_PULSE);
      return [{ x: def.x, y: def.y, rot: def.rot, hx: r, hy: r }];
    }
    case "hammer":
      return [
        hammerDown(def, t) ? { x: def.x, y: def.y, rot: def.rot, hx: def.hx, hy: def.hy } : NOWHERE,
      ];
    case "piston":
      return [{ ...pistonCenter(def, t), rot: def.rot, hx: def.hx, hy: def.hy }];
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
    case "cross":
      return def.hx;
    case "hammer":
      return Math.hypot(def.hx, def.hy);
    case "piston":
      return Math.max(def.hx, def.hy); // it punches across the course, like a log rolls
  }
}
