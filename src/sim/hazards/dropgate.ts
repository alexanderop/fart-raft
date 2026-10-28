import RAPIER from "@dimforge/rapier2d-compat";
import { DROPGATE_KNOCK } from "../constants.ts";
import type { HazardDef } from "../types.ts";
import type { Hazard } from "./index.ts";
import { dropgateDown } from "./shape.ts";

/**
 * A spiked bar hung across the channel between two posts. It hangs high, shakes, slams onto the
 * water and rests there a moment before it rises: it hurts only while it is down.
 */
export function createDropgate(world: RAPIER.World, def: HazardDef): Hazard {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(def.x, def.y).setRotation(def.rot),
  );
  const collider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(def.hx, def.hy).setRestitution(0.3),
    body,
  );
  let t = 0;
  collider.setEnabled(dropgateDown(def, t));

  return {
    id: def.id,
    body,
    colliderHandles: [collider.handle],
    knock: DROPGATE_KNOCK,
    update(dt) {
      t += dt;
      collider.setEnabled(dropgateDown(def, t));
    },
  };
}
