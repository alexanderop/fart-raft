import RAPIER from "@dimforge/rapier2d-compat";
import { PISTON_HOLD, PISTON_KNOCK, PISTON_REST } from "../constants.ts";
import type { HazardDef, Vec2 } from "../types.ts";
import type { Hazard, HazardKind } from "./index.ts";
import { cycle, smoothstep, span } from "./shape.ts";

/**
 * How far a piston has punched out `t` seconds in, 0 (in the bank) to 1 (`range` m out). Each
 * cycle it rests, shoots out, holds for PISTON_HOLD of the cycle, then slides back.
 */
export function pistonOut(def: HazardDef, t: number): number {
  const u = cycle(def, t);
  const shot = PISTON_REST + 0.06;
  if (u < PISTON_REST) return 0;
  if (u < shot) return 1 - (1 - span(u, PISTON_REST, shot)) ** 3;
  if (u < shot + PISTON_HOLD) return 1;
  return 1 - smoothstep(span(u, shot + PISTON_HOLD, 1));
}

/** Where a piston's head is `t` seconds in: `range` m along `rot` from its rest at (x, y), times pistonOut. */
export function pistonCenter(def: HazardDef, t: number): Vec2 {
  const out = (def.range ?? 0) * pistonOut(def, t);
  return { x: def.x + Math.cos(def.rot) * out, y: def.y + Math.sin(def.rot) * out };
}

/** A spiked block that punches out of the bank across the channel, holds, and slides back. */
function createPiston(world: RAPIER.World, def: HazardDef): Hazard {
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

export const piston: HazardKind = {
  create: createPiston,
  boxes: (def, t) => [{ ...pistonCenter(def, t), rot: def.rot, hx: def.hx, hy: def.hy }],
  reach: (def) => Math.max(def.hx, def.hy), // it punches across the course, like a log rolls
};
