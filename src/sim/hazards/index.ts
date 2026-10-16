import type RAPIER from "@dimforge/rapier2d-compat";
import type { HazardDef } from "../types";
import { createSpinner } from "./spinner";
import { createSweeper } from "./sweeper";

/** Update Method: every hazard advances itself once per tick. */
export type Hazard = {
  id: string;
  body: RAPIER.RigidBody;
  update(dt: number): void;
};

/**
 * Type Object (light): the Blender export picks a `kind` and tunes it with data
 * (speed, size). The behavior for each kind stays in code.
 */
const KINDS: Record<HazardDef["kind"], (world: RAPIER.World, def: HazardDef) => Hazard> = {
  spinner: createSpinner,
  sweeper: createSweeper,
};

export function createHazard(world: RAPIER.World, def: HazardDef): Hazard {
  return KINDS[def.kind](world, def);
}
