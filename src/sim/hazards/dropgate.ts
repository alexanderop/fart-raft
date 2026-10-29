import RAPIER from "@dimforge/rapier2d-compat";
import {
  DROPGATE_DOWN,
  DROPGATE_HIT_LIFT,
  DROPGATE_KNOCK,
  DROPGATE_PERIOD,
  DROPGATE_RISE,
  DROPGATE_SHAKE,
  DROPGATE_SLAM,
} from "../constants.ts";
import type { HazardDef } from "../types.ts";
import type { Hazard, HazardKind } from "./index.ts";
import { NOWHERE, smoothstep, span } from "./shape.ts";

/**
 * A drop gate's timing: seconds into its cycle `t` seconds in, and how long the cycle and each
 * part of it last. The cycle starts with the bar up; it ends with the shake, slam, rest and rise.
 */
function dropgateClock(def: HazardDef, t: number) {
  const period = def.period ?? DROPGATE_PERIOD;
  const down = def.down ?? DROPGATE_DOWN;
  const rise = def.rise ?? DROPGATE_RISE;
  const u = t / period + (def.phase ?? 0) / (2 * Math.PI);
  const at = (u - Math.floor(u)) * period;
  const slam = period - rise - down - DROPGATE_SLAM; // when the slam starts
  return { at, slam, down, rise, period };
}

/**
 * How high a drop gate's bar hangs `t` seconds in: 1 up high (the raft passes under), 0 on the
 * water. It hangs, slams down fast, rests on the water, then rises slowly.
 */
export function dropgateLift(def: HazardDef, t: number): number {
  const { at, slam, down } = dropgateClock(def, t);
  if (at < slam) return 1;
  const landed = slam + DROPGATE_SLAM;
  if (at < landed) return 1 - span(at, slam, landed) ** 2; // falling, faster and faster
  if (at < landed + down) return 0; // down: the bar is deadly
  return smoothstep(span(at, landed + down, def.period ?? DROPGATE_PERIOD));
}

/** How hard a drop gate shakes `t` seconds in, 0..1: only in the DROPGATE_SHAKE s before it slams. */
export function dropgateShake(def: HazardDef, t: number): number {
  const { at, slam } = dropgateClock(def, t);
  return at < slam && at > slam - DROPGATE_SHAKE ? span(at, slam - DROPGATE_SHAKE, slam) : 0;
}

/** Is the drop gate's bar low enough to hit the riders? Only then does it hurt. */
export const dropgateDown = (def: HazardDef, t: number): boolean =>
  dropgateLift(def, t) < DROPGATE_HIT_LIFT;

/**
 * A spiked bar hung across the channel between two posts. It hangs high, shakes, slams onto the
 * water and rests there a moment before it rises: it hurts only while it is down.
 */
function createDropgate(world: RAPIER.World, def: HazardDef): Hazard {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(def.x, def.y).setRotation(def.rot),
  );
  const collider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(def.hx, def.hy).setRestitution(0.3),
    body,
  );
  let t = 0;
  collider.setEnabled(dropgateDown(def, t));

  return {
    id: def.id,
    body,
    colliderHandles: [collider.handle],
    knock: DROPGATE_KNOCK,
    update(dt) {
      t += dt;
      collider.setEnabled(dropgateDown(def, t));
    },
  };
}

export const dropgate: HazardKind = {
  create: createDropgate,
  boxes: (def, t) => [
    dropgateDown(def, t) ? { x: def.x, y: def.y, rot: def.rot, hx: def.hx, hy: def.hy } : NOWHERE,
  ],
  // It lies across the course, so only its thickness reaches along it; the extra 4 m start
  // the bots' wait earlier, so even a lone rider can stop before the bar instead of under it.
  reach: (def) => def.hy + 4,
};
