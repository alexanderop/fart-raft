import RAPIER from "@dimforge/rapier2d-compat";
import { HAMMER_KNOCK } from "../constants.ts";
import type { HazardDef } from "../types.ts";
import type { Hazard } from "./index.ts";
import { hammerDown } from "./shape.ts";

/**
 * A spiked mallet hinged on the bank. It hangs high, rears back, then slams down on its smash
 * zone and rests there a moment: the zone hurts only while the hammer is down.
 */
export function createHammer(world: RAPIER.World, def: HazardDef): Hazard {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(def.x, def.y).setRotation(def.rot),
  );
  const collider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(def.hx, def.hy).setRestitution(0.3),
    body,
  );
  let t = 0;
  collider.setEnabled(hammerDown(def, t));

  return {
    id: def.id,
    body,
    colliderHandles: [collider.handle],
    knock: HAMMER_KNOCK,
    update(dt) {
      t += dt;
      collider.setEnabled(hammerDown(def, t));
    },
  };
}
