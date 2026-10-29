import RAPIER from "@dimforge/rapier2d-compat";
import type { HazardDef } from "../types.ts";
import type { Hazard, HazardKind } from "./index.ts";

/**
 * A rotating bar that swats the raft, `speed` radians per second. A cross is two bars square to
 * each other on one hub.
 */
function createSpinner(world: RAPIER.World, def: HazardDef): Hazard {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(def.x, def.y).setRotation(def.rot),
  );
  const bar = (rot: number) =>
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(def.hx, def.hy).setRotation(rot).setRestitution(0.6),
      body,
    );
  const colliders = def.kind === "cross" ? [bar(0), bar(Math.PI / 2)] : [bar(0)];
  let angle = def.rot;

  return {
    id: def.id,
    body,
    colliderHandles: colliders.map((c) => c.handle),
    knock: 1,
    update(dt) {
      angle += def.speed * dt;
      body.setNextKinematicRotation(angle);
    },
  };
}

export const spinner: HazardKind = {
  create: createSpinner,
  boxes: (def, t) => [{ ...def, rot: def.rot + def.speed * t }],
  reach: (def) => def.hx,
};

export const cross: HazardKind = {
  create: createSpinner,
  boxes(def, t) {
    const rot = def.rot + def.speed * t;
    return [
      { ...def, rot },
      { ...def, rot: rot + Math.PI / 2 },
    ];
  },
  reach: (def) => def.hx,
};
