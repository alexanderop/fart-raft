import RAPIER from "@dimforge/rapier2d-compat";
import type { HazardDef } from "../types.ts";
import type { Hazard } from "./index.ts";
import { logCenter } from "./shape.ts";

/**
 * A spiked log rolling back and forth across the channel. Its axis lies along `rot` and it
 * travels sideways, `range` m either side of (x, y). Touching it costs a life.
 */
export function createLog(world: RAPIER.World, def: HazardDef): Hazard {
  const start = logCenter(def, 0);
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(start.x, start.y)
      .setRotation(def.rot),
  );
  const collider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(def.hx, def.hy).setRestitution(0.7),
    body,
  );
  let t = 0;

  return {
    id: def.id,
    body,
    colliderHandle: collider.handle,
    knock: 1,
    update(dt) {
      t += dt;
      body.setNextKinematicTranslation(logCenter(def, t));
    },
  };
}
