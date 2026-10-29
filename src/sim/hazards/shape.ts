import { hazardRate, STEP } from "../constants.ts";
import type { Box, Difficulty, HazardDef } from "../types.ts";

// Every hazard moves on a fixed schedule that starts with tick 0, so where it is at hazard time
// `t` (`hazardTime` below) is a pure function of its definition. Each kind's module holds its own
// motion (`hammerLift`, `pistonOut`, …); the sim bodies, the bots' planner and the renderer all
// ask those functions instead of keeping their own copy of the motion. This file has the helpers
// they share.

/**
 * Hazard time, s, of a hazard of `kind` at sim tick `tick` (fractional ticks interpolate). Every
 * `t` in the kind modules is hazard time: it runs at `hazardRate(difficulty, kind)` against the
 * race clock, so the sim, the bots and the renderer all slow down together. Seconds ahead of
 * `tick` convert with the same rate.
 */
export const hazardTime = (difficulty: Difficulty, tick: number, kind: HazardDef["kind"]): number =>
  tick * STEP * hazardRate(difficulty, kind);

/** Where in its cycle a hazard is `t` seconds in: 0..1, one cycle per 2π / speed seconds. */
export function cycle(def: HazardDef, t: number): number {
  const u = (t * def.speed + (def.phase ?? 0)) / (2 * Math.PI);
  return u - Math.floor(u);
}

export const smoothstep = (x: number) => x * x * (3 - 2 * x);
export const span = (u: number, from: number, to: number) =>
  Math.min(1, Math.max(0, (u - from) / (to - from)));

/** A box no raft ever comes near: what a raised hammer or drop gate fills. */
export const NOWHERE: Box = { x: 1e6, y: 1e6, rot: 0, hx: 0, hy: 0 };
