import {
  BUMPER_PULSE,
  DROPGATE_DOWN,
  DROPGATE_HIT_LIFT,
  DROPGATE_PERIOD,
  DROPGATE_RISE,
  DROPGATE_SHAKE,
  DROPGATE_SLAM,
  HAMMER_ARM,
  HAMMER_HIT_LIFT,
  hazardRate,
  PISTON_HOLD,
  PISTON_REST,
  STEP,
  SWEEP_AMPLITUDE,
} from "../constants.ts";
import type { Box, Difficulty, HazardDef, Vec2 } from "../types.ts";

// Every hazard moves on a fixed schedule that starts with tick 0, so where it is at hazard time
// `t` (`hazardTime` below) is a pure function of its definition. The sim bodies, the bots'
// planner and the renderer all ask these functions instead of keeping their own copy of the motion.

/**
 * Hazard time, s, of a hazard of `kind` at sim tick `tick` (fractional ticks interpolate). Every
 * `t` below is hazard time: it runs at `hazardRate(difficulty, kind)` against the race clock, so
 * the sim, the bots and the renderer all slow down together. Seconds ahead of `tick` convert with
 * the same rate.
 */
export const hazardTime = (difficulty: Difficulty, tick: number, kind: HazardDef["kind"]): number =>
  tick * STEP * hazardRate(difficulty, kind);

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

/**
 * A drop gate's timing: seconds into its cycle `t` seconds in, and how long the cycle and each
 * part of it last. The cycle starts with the bar up; it ends with the shake, slam, rest and rise.
 */
function dropgateClock(def: HazardDef, t: number) {
  const period = def.period ?? DROPGATE_PERIOD;
  const down = def.down ?? DROPGATE_DOWN;
  const rise = def.rise ?? DROPGATE_RISE;
  const u = t / period + (def.phase ?? 0) / (2 * Math.PI);
  const at = (u - Math.floor(u)) * period;
  const slam = period - rise - down - DROPGATE_SLAM; // when the slam starts
  return { at, slam, down, rise, period };
}

/**
 * How high a drop gate's bar hangs `t` seconds in: 1 up high (the raft passes under), 0 on the
 * water. It hangs, slams down fast, rests on the water, then rises slowly.
 */
export function dropgateLift(def: HazardDef, t: number): number {
  const { at, slam, down } = dropgateClock(def, t);
  if (at < slam) return 1;
  const landed = slam + DROPGATE_SLAM;
  if (at < landed) return 1 - span(at, slam, landed) ** 2; // falling, faster and faster
  if (at < landed + down) return 0; // down: the bar is deadly
  return smoothstep(span(at, landed + down, def.period ?? DROPGATE_PERIOD));
}

/** How hard a drop gate shakes `t` seconds in, 0..1: only in the DROPGATE_SHAKE s before it slams. */
export function dropgateShake(def: HazardDef, t: number): number {
  const { at, slam } = dropgateClock(def, t);
  return at < slam && at > slam - DROPGATE_SHAKE ? span(at, slam - DROPGATE_SHAKE, slam) : 0;
}

/** Is the drop gate's bar low enough to hit the riders? Only then does it hurt. */
export const dropgateDown = (def: HazardDef, t: number): boolean =>
  dropgateLift(def, t) < DROPGATE_HIT_LIFT;

/** Where a mine floats `t` seconds in: it drifts `range` m either side of (x, y) along `rot`. */
export function mineCenter(def: HazardDef, t: number): Vec2 {
  const run = (def.range ?? 0) * Math.sin(t * def.speed + (def.phase ?? 0));
  return { x: def.x + Math.cos(def.rot) * run, y: def.y + Math.sin(def.rot) * run };
}

/** A box no raft ever comes near: what a raised hammer or drop gate fills. */
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
    case "dropgate":
      return [
        dropgateDown(def, t)
          ? { x: def.x, y: def.y, rot: def.rot, hx: def.hx, hy: def.hy }
          : NOWHERE,
      ];
    case "mine":
      return [{ ...mineCenter(def, t), rot: def.rot, hx: def.hx, hy: def.hx }];
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
    case "dropgate":
      // It lies across the course, so only its thickness reaches along it; the extra 4 m start
      // the bots' wait earlier, so even a lone rider can stop before the bar instead of under it.
      return def.hy + 4;
    case "mine":
      return def.hx + (def.range ?? 0);
  }
}
