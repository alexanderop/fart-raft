import RAPIER from "@dimforge/rapier2d-compat";
import { BUMPER_KNOCK, BUMPER_RESTITUTION } from "../constants.ts";
import type { HazardDef } from "../types.ts";
import type { Hazard } from "./index.ts";
import { bumperRadius } from "./shape.ts";

/**
 * A round spiked pumpkin that swells and shrinks where it floats, and throws the raft far
 * harder than a bar does. Touching it wipes the crew out.
 */
export function createBumper(world: RAPIER.World, def: HazardDef): Hazard {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(def.x, def.y),
  );
  const collider = world.createCollider(
    RAPIER.ColliderDesc.ball(bumperRadius(def, 0))
      .setRestitution(BUMPER_RESTITUTION)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max),
    body,
  );
  let t = 0;

  return {
    id: def.id,
    body,
    colliderHandles: [collider.handle],
    knock: BUMPER_KNOCK,
    update(dt) {
      t += dt;
      collider.setRadius(bumperRadius(def, t));
    },
  };
}
