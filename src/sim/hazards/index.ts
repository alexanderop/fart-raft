import type RAPIER from "@dimforge/rapier2d-compat";
import type { HazardDef } from "../types.ts";
import { createBumper } from "./bumper.ts";
import { createHammer } from "./hammer.ts";
import { createLog } from "./log.ts";
import { createPiston } from "./piston.ts";
import { createSpinner } from "./spinner.ts";
import { createSweeper } from "./sweeper.ts";

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

/**
 * Type Object (light): the Blender export picks a `kind` and tunes it with data
 * (speed, size). The behavior for each kind stays in code.
 */
const KINDS: Record<HazardDef["kind"], (world: RAPIER.World, def: HazardDef) => Hazard> = {
  spinner: createSpinner,
  cross: createSpinner,
  sweeper: createSweeper,
  log: createLog,
  bumper: createBumper,
  hammer: createHammer,
  piston: createPiston,
};

export function createHazard(world: RAPIER.World, def: HazardDef): Hazard {
  return KINDS[def.kind](world, def);
}
