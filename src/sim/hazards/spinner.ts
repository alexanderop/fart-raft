import RAPIER from "@dimforge/rapier2d-compat";
import type { HazardDef } from "../types.ts";
import type { Hazard } from "./index.ts";

/** A rotating log that swats the raft. `speed` is radians per second. */
export function createSpinner(world: RAPIER.World, def: HazardDef): Hazard {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(def.x, def.y).setRotation(def.rot),
  );
  const collider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(def.hx, def.hy).setRestitution(0.6),
    body,
  );
  let angle = def.rot;

  return {
    id: def.id,
    body,
    colliderHandle: collider.handle,
    knock: 1,
    update(dt) {
      angle += def.speed * dt;
      body.setNextKinematicRotation(angle);
    },
  };
}
