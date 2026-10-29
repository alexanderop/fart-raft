import RAPIER from "@dimforge/rapier2d-compat";
import { HAMMER_ARM, HAMMER_HIT_LIFT, HAMMER_KNOCK } from "../constants.ts";
import type { HazardDef, Vec2 } from "../types.ts";
import type { Hazard, HazardKind } from "./index.ts";
import { cycle, NOWHERE, smoothstep, span } from "./shape.ts";

/**
 * How high a hammer's arm is raised `t` seconds in, radians above the water (π/2 = straight up).
 * Each cycle it hangs up high, rears back a little more (the tell), slams down, rests on the
 * water, then slowly lifts again.
 */
export function hammerLift(def: HazardDef, t: number): number {
  const u = cycle(def, t);
  const up = Math.PI / 2;
  if (u < 0.4) return up;
  if (u < 0.55) return up + 0.35 * smoothstep(span(u, 0.4, 0.55)); // rear back
  if (u < 0.62) return (up + 0.35) * (1 - span(u, 0.55, 0.62) ** 2); // slam
  if (u < 0.8) return 0; // down: the smash zone is deadly
  return up * smoothstep(span(u, 0.8, 1));
}

/** Is the hammer down on its smash zone? Only then does it hurt. */
export const hammerDown = (def: HazardDef, t: number): boolean =>
  hammerLift(def, t) < HAMMER_HIT_LIFT;

/** Where the hammer's pivot sits on the bank: HAMMER_ARM m back from the smash zone, along `rot`. */
export function hammerPivot(def: HazardDef): Vec2 {
  return { x: def.x - Math.cos(def.rot) * HAMMER_ARM, y: def.y - Math.sin(def.rot) * HAMMER_ARM };
}

/**
 * A spiked mallet hinged on the bank. It hangs high, rears back, then slams down on its smash
 * zone and rests there a moment: the zone hurts only while the hammer is down.
 */
function createHammer(world: RAPIER.World, def: HazardDef): Hazard {
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

export const hammer: HazardKind = {
  create: createHammer,
  boxes: (def, t) => [
    hammerDown(def, t) ? { x: def.x, y: def.y, rot: def.rot, hx: def.hx, hy: def.hy } : NOWHERE,
  ],
  reach: (def) => Math.hypot(def.hx, def.hy),
};
