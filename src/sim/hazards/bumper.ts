import RAPIER from "@dimforge/rapier2d-compat";
import { BUMPER_KNOCK, BUMPER_PULSE, BUMPER_RESTITUTION } from "../constants.ts";
import type { HazardDef } from "../types.ts";
import type { Hazard, HazardKind } from "./index.ts";

/** A bumper's radius `t` seconds in: it swells from `hx` to `hx · (1 + BUMPER_PULSE)` and back. */
export function bumperRadius(def: HazardDef, t: number): number {
  const swell = 0.5 + 0.5 * Math.sin(t * def.speed + (def.phase ?? 0));
  return def.hx * (1 + BUMPER_PULSE * swell);
}

/**
 * A round spiked ball that swells and shrinks where it floats, and throws the raft far
 * harder than a bar does. Touching it wipes the crew out.
 */
function createBumper(world: RAPIER.World, def: HazardDef): Hazard {
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

export const bumper: HazardKind = {
  create: createBumper,
  boxes(def) {
    const r = def.hx * (1 + BUMPER_PULSE);
    return [{ x: def.x, y: def.y, rot: def.rot, hx: r, hy: r }];
  },
  reach: (def) => def.hx * (1 + BUMPER_PULSE),
};
