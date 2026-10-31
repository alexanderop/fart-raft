import RAPIER from "@dimforge/rapier2d-compat";
import { MACE_HIT_LIFT, MACE_KNOCK, MACE_SWING } from "../constants.ts";
import type { HazardDef, Vec2 } from "../types.ts";
import type { Hazard, HazardKind } from "./index.ts";
import { NOWHERE } from "./shape.ts";

/** The mace's rope length, m: long enough that the bob reaches `range` m out at the end of a swing. */
export const maceRope = (def: HazardDef): number => (def.range ?? 0) / Math.sin(MACE_SWING);

/** The rope's angle from straight down `t` seconds in, rad (positive toward +`rot`). */
export const maceAngle = (def: HazardDef, t: number): number =>
  MACE_SWING * Math.sin(t * def.speed + (def.phase ?? 0));

/**
 * Where the bob is `t` seconds in: its spot on the water plane, across the channel along `rot`,
 * and `lift`, how high it hangs above the bottom of its swing (m).
 */
export function maceBob(def: HazardDef, t: number): Vec2 & { lift: number } {
  const rope = maceRope(def);
  const angle = maceAngle(def, t);
  const out = rope * Math.sin(angle);
  return {
    x: def.x + Math.cos(def.rot) * out,
    y: def.y + Math.sin(def.rot) * out,
    lift: rope * (1 - Math.cos(angle)),
  };
}

/** Is the bob low enough to reach the riders? Only then does it hurt. */
export const maceLow = (def: HazardDef, t: number): boolean => maceBob(def, t).lift < MACE_HIT_LIFT;

/**
 * A spiked bob of radius `hx` hung from a gantry over (x, y), swinging like a pendulum across the
 * channel (along `rot`). Low through the middle of each swing it sweeps the water and wipes the
 * crew out; high at either end it passes over the riders' heads.
 */
function createMace(world: RAPIER.World, def: HazardDef): Hazard {
  const start = maceBob(def, 0);
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(start.x, start.y),
  );
  const collider = world.createCollider(RAPIER.ColliderDesc.ball(def.hx).setRestitution(0.4), body);
  let t = 0;
  collider.setEnabled(maceLow(def, t));

  return {
    id: def.id,
    body,
    colliderHandles: [collider.handle],
    knock: MACE_KNOCK,
    update(dt) {
      t += dt;
      const bob = maceBob(def, t);
      body.setNextKinematicTranslation({ x: bob.x, y: bob.y });
      collider.setEnabled(bob.lift < MACE_HIT_LIFT);
    },
  };
}

export const mace: HazardKind = {
  create: createMace,
  boxes: (def, t) => {
    const bob = maceBob(def, t);
    return [
      bob.lift < MACE_HIT_LIFT
        ? { x: bob.x, y: bob.y, rot: def.rot, hx: def.hx, hy: def.hx }
        : NOWHERE,
    ];
  },
  // It swings across the course, so only the bob's radius reaches along it.
  reach: (def) => def.hx,
};
