import RAPIER from "@dimforge/rapier2d-compat";
import { SWEEP_AMPLITUDE } from "../constants.ts";
import type { HazardDef } from "../types.ts";
import type { Hazard } from "./index.ts";

/** A bar hinged at one end on the bank that swings back and forth across the channel. */
export function createSweeper(world: RAPIER.World, def: HazardDef): Hazard {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(def.x, def.y).setRotation(def.rot),
  );
  const collider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(def.hx, def.hy).setTranslation(def.hx, 0).setRestitution(0.8),
    body,
  );
  let t = 0;

  return {
    id: def.id,
    body,
    colliderHandles: [collider.handle],
    knock: 1,
    update(dt) {
      t += dt;
      body.setNextKinematicRotation(def.rot + SWEEP_AMPLITUDE * Math.sin(t * def.speed));
    },
  };
}
