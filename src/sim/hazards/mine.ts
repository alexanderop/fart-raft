import RAPIER from "@dimforge/rapier2d-compat";
import { MINE_KNOCK } from "../constants.ts";
import type { HazardDef, Vec2 } from "../types.ts";
import type { Hazard, HazardKind } from "./index.ts";

/** Where a mine floats `t` seconds in: it drifts `range` m either side of (x, y) along `rot`. */
export function mineCenter(def: HazardDef, t: number): Vec2 {
  const run = (def.range ?? 0) * Math.sin(t * def.speed + (def.phase ?? 0));
  return { x: def.x + Math.cos(def.rot) * run, y: def.y + Math.sin(def.rot) * run };
}

/** A floating spiked mine, still or drifting slowly back and forth. Touching it wipes the crew out. */
function createMine(world: RAPIER.World, def: HazardDef): Hazard {
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

export const mine: HazardKind = {
  create: createMine,
  boxes: (def, t) => [{ ...mineCenter(def, t), rot: def.rot, hx: def.hx, hy: def.hx }],
  reach: (def) => def.hx + (def.range ?? 0),
};
