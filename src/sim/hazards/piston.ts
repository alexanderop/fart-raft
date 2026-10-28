import RAPIER from "@dimforge/rapier2d-compat";
import { PISTON_KNOCK } from "../constants.ts";
import type { HazardDef } from "../types.ts";
import type { Hazard } from "./index.ts";
import { pistonCenter } from "./shape.ts";

/** A spiked block that punches out of the bank across the channel, holds, and slides back. */
export function createPiston(world: RAPIER.World, def: HazardDef): Hazard {
  const start = pistonCenter(def, 0);
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(start.x, start.y)
      .setRotation(def.rot),
  );
  const collider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(def.hx, def.hy).setRestitution(0.5),
    body,
  );
  let t = 0;

  return {
    id: def.id,
    body,
    colliderHandles: [collider.handle],
    knock: PISTON_KNOCK,
    update(dt) {
      t += dt;
      body.setNextKinematicTranslation(pistonCenter(def, t));
    },
  };
}
