import RAPIER from "@dimforge/rapier2d-compat";
import type { HazardDef, Vec2 } from "../types.ts";
import type { Hazard, HazardKind } from "./index.ts";

/** Where a log's center is `t` seconds in: it runs back and forth across its own axis. */
export function logCenter(def: HazardDef, t: number): Vec2 {
  const run = (def.range ?? 0) * Math.sin(t * def.speed + (def.phase ?? 0));
  return { x: def.x - Math.sin(def.rot) * run, y: def.y + Math.cos(def.rot) * run };
}

/**
 * A spiked log rolling back and forth across the channel. Its axis lies along `rot` and it
 * travels sideways, `range` m either side of (x, y). Touching it wipes the crew out.
 */
function createLog(world: RAPIER.World, def: HazardDef): Hazard {
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
    colliderHandles: [collider.handle],
    knock: 1,
    update(dt) {
      t += dt;
      body.setNextKinematicTranslation(logCenter(def, t));
    },
  };
}

export const log: HazardKind = {
  create: createLog,
  boxes: (def, t) => [{ ...logCenter(def, t), rot: def.rot, hx: def.hx, hy: def.hy }],
  reach: (def) => Math.max(def.hx, def.hy),
};
