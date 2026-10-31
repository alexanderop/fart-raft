import RAPIER from "@dimforge/rapier2d-compat";
import {
  DOUBLEGATE_CLOSE,
  DOUBLEGATE_KNOCK,
  DOUBLEGATE_OPEN,
  DOUBLEGATE_PERIOD,
  DOUBLEGATE_SHUT,
  DOUBLEGATE_SWING,
} from "../constants.ts";
import type { Box, HazardDef, Vec2 } from "../types.ts";
import type { Hazard, HazardKind } from "./index.ts";
import { smoothstep, span } from "./shape.ts";

/**
 * How shut a double gate is `t` seconds in: 0 wide open, 1 shut. Each cycle starts open; near
 * its end the doors swing shut, stay shut `down` s, and swing open over `rise` s.
 */
export function doublegateShut(def: HazardDef, t: number): number {
  const period = def.period ?? DOUBLEGATE_PERIOD;
  const shut = def.down ?? DOUBLEGATE_SHUT;
  const open = def.rise ?? DOUBLEGATE_OPEN;
  const u = t / period + (def.phase ?? 0) / (2 * Math.PI);
  const at = (u - Math.floor(u)) * period;
  const closing = period - open - shut - DOUBLEGATE_CLOSE; // when the doors start to swing shut
  const closed = closing + DOUBLEGATE_CLOSE;
  if (at < closing) return 0;
  if (at < closed) return smoothstep(span(at, closing, closed));
  if (at < closed + shut) return 1;
  return 1 - smoothstep(span(at, closed + shut, period));
}

/** The two doors' hinges: `hx` m either side of (x, y) along `rot`, on the banks (left first). */
export function doublegateHinges(def: HazardDef): [Vec2, Vec2] {
  const ux = Math.cos(def.rot) * def.hx;
  const uy = Math.sin(def.rot) * def.hx;
  return [
    { x: def.x + ux, y: def.y + uy },
    { x: def.x - ux, y: def.y - uy },
  ];
}

/**
 * Which way each door points from its hinge `t` seconds in, rad (left door first). Shut, they
 * point at each other across the channel; open, they swing upstream toward the oncoming raft, to
 * lie along their banks. `rot` runs across the channel, so upstream is `rot + π/2`.
 */
export function doublegateAngles(def: HazardDef, t: number): [number, number] {
  const swing = (1 - doublegateShut(def, t)) * DOUBLEGATE_SWING;
  return [def.rot + Math.PI - swing, def.rot + swing];
}

/** Each door's box `t` seconds in: a plate of half-length hx / 2 from its hinge, hy thick. */
function doors(def: HazardDef, t: number): Box[] {
  const angles = doublegateAngles(def, t);
  const half = def.hx / 2;
  return doublegateHinges(def).map((hinge, i) => {
    const rot = angles[i]!;
    return {
      x: hinge.x + Math.cos(rot) * half,
      y: hinge.y + Math.sin(rot) * half,
      rot,
      hx: half,
      hy: def.hy,
    };
  });
}

/**
 * Two spiked doors hinged on the banks that swing shut across the channel, meet in the middle,
 * stay shut a moment and swing open again. Open or shut, touching a door wipes the crew out.
 */
function createDoublegate(world: RAPIER.World, def: HazardDef): Hazard {
  const bodies = doors(def, 0).map((box) => {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(box.x, box.y)
        .setRotation(box.rot),
    );
    const collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(box.hx, box.hy).setRestitution(0.3),
      body,
    );
    return { body, collider };
  });
  let t = 0;

  return {
    id: def.id,
    body: bodies[0]!.body,
    colliderHandles: bodies.map((b) => b.collider.handle),
    knock: DOUBLEGATE_KNOCK,
    update(dt) {
      t += dt;
      doors(def, t).forEach((box, i) => {
        const { body } = bodies[i]!;
        body.setNextKinematicTranslation({ x: box.x, y: box.y });
        body.setNextKinematicRotation(box.rot);
      });
    },
  };
}

export const doublegate: HazardKind = {
  create: createDoublegate,
  boxes: doors,
  // Open, each door reaches its full length upstream of the hinges.
  reach: (def) => def.hx + def.hy,
};
