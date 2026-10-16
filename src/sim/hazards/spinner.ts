import RAPIER from "@dimforge/rapier2d-compat";
import type { HazardDef } from "../types";
import type { Hazard } from "./index";

/** A rotating log that swats the raft. `speed` is radians per second. */
export function createSpinner(world: RAPIER.World, def: HazardDef): Hazard {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(def.x, def.y).setRotation(def.rot),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(def.hx, def.hy).setRestitution(0.6), body);
  let angle = def.rot;

  return {
    id: def.id,
    body,
    update(dt) {
      angle += def.speed * dt;
      body.setNextKinematicRotation(angle);
    },
  };
}
