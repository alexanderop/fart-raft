import RAPIER from "@dimforge/rapier2d-compat";
import { MINE_KNOCK } from "../constants.ts";
import type { HazardDef } from "../types.ts";
import type { Hazard } from "./index.ts";
import { mineCenter } from "./shape.ts";

/** A floating spiked mine, still or drifting slowly back and forth. Touching it wipes the crew out. */
export function createMine(world: RAPIER.World, def: HazardDef): Hazard {
  const start = mineCenter(def, 0);
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(start.x, start.y),
  );
  const collider = world.createCollider(RAPIER.ColliderDesc.ball(def.hx).setRestitution(0.4), body);
  let t = 0;

  return {
    id: def.id,
    body,
    colliderHandles: [collider.handle],
    knock: MINE_KNOCK,
    update(dt) {
      t += dt;
      body.setNextKinematicTranslation(mineCenter(def, t));
    },
  };
}
