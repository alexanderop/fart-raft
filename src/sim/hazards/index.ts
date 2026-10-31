import type RAPIER from "@dimforge/rapier2d-compat";
import type { Box, HazardDef } from "../types.ts";
import { bumper } from "./bumper.ts";
import { doublegate } from "./doublegate.ts";
import { dropgate } from "./dropgate.ts";
import { hammer } from "./hammer.ts";
import { log } from "./log.ts";
import { mace } from "./mace.ts";
import { mine } from "./mine.ts";
import { piston } from "./piston.ts";
import { cross, spinner } from "./spinner.ts";
import { sweeper } from "./sweeper.ts";

/** Update Method: every hazard advances itself once per tick. */
export type Hazard = {
  id: string;
  body: RAPIER.RigidBody;
  /** Its colliders: touching any of them wipes the crew out. */
  colliderHandles: number[];
  /** How hard a hit from this hazard throws the raft, relative to a plain bar (1). */
  knock: number;
  update(dt: number): void;
};

/** Everything the sim knows about one kind of hazard. Each kind's module exports one. */
export type HazardKind = {
  /** Its Rapier body and colliders. */
  create(world: RAPIER.World, def: HazardDef): Hazard;
  /**
   * The boxes it fills `t` seconds in (hazard time). Round things get a box that bounds them (a
   * bumper at its fullest), so a planner that keeps clear of the boxes keeps clear of the hazard.
   */
  boxes(def: HazardDef, t: number): Box[];
  /** How far its swept area reaches from (x, y) along the course, m. */
  reach(def: HazardDef): number;
};

/**
 * Type Object (light): the Blender export picks a `kind` and tunes it with data
 * (speed, size). The behavior for each kind stays in code, one module per kind.
 */
const KINDS: Record<HazardDef["kind"], HazardKind> = {
  spinner,
  cross,
  sweeper,
  log,
  bumper,
  hammer,
  piston,
  dropgate,
  doublegate,
  mine,
  mace,
};

/** Every hazard kind a course may use: the level validator checks against this. */
export const HAZARD_KINDS: readonly string[] = Object.keys(KINDS);

export function createHazard(world: RAPIER.World, def: HazardDef): Hazard {
  return KINDS[def.kind].create(world, def);
}

/** The boxes a hazard fills `t` seconds in (hazard time, see `hazardTime`). */
export const hazardBoxes = (def: HazardDef, t: number): Box[] => KINDS[def.kind].boxes(def, t);

/** How far the hazard's swept area reaches from (x, y) along the course, m. */
export const hazardReach = (def: HazardDef): number => KINDS[def.kind].reach(def);
