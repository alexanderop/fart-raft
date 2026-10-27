import RAPIER from "@dimforge/rapier2d-compat";
import {
  ANGULAR_DAMPING,
  FART_COOLDOWN,
  FART_COST,
  FART_FORCE,
  FART_TICKS,
  GAS_MAX,
  GAS_REGEN,
  KNOCK_SPEED,
  KNOCK_SPIN,
  LINEAR_DAMPING,
  RAFT_HULL,
  RAFT_MASS,
  RIDER_BODY,
  RIDER_RING,
  SOLO_BOOST,
  STEP,
  WALK_SPEED,
  type Zone,
} from "./constants.ts";
import type { Pose, RiderPose, SeatInput, SimEvent, Vec2 } from "./types.ts";

export type Raft = {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  zones: readonly Zone[];
  /** Where each rider hangs on the ring: angle in the raft's frame. */
  at: number[];
  gas: number[];
  /** Ticks left in each rider's current burst. */
  burst: number[];
  /** Ticks until each rider may start the next burst. */
  cooldown: number[];
};

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Keep a ring angle inside its zone's arc, a body's width from either end. */
export function clampToZone(zone: Zone, angle: number): number {
  if (zone.half >= Math.PI) return wrap(angle);
  const lim = Math.max(0, zone.half - RIDER_BODY / RIDER_RING);
  return zone.center + clamp(wrap(angle - zone.center), -lim, lim);
}

/** A rider at ring angle `at`, in the raft's frame, facing the center. */
export const riderPose = (at: number): RiderPose => ({
  x: Math.cos(at) * RIDER_RING,
  y: Math.sin(at) * RIDER_RING,
  face: wrap(at + Math.PI),
});

export function createRaft(world: RAPIER.World, spawn: Pose, zones: readonly Zone[]): Raft {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y)
      .setRotation(spawn.rot)
      .setAngularDamping(ANGULAR_DAMPING)
      .setCcdEnabled(true),
  );
  const collider = world.createCollider(
    RAPIER.ColliderDesc.ball(RAFT_HULL)
      .setDensity(RAFT_MASS / (Math.PI * RAFT_HULL ** 2))
      .setRestitution(0.4)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
    body,
  );
  return {
    body,
    collider,
    zones,
    // Everyone starts mid-arc. A solo rider starts at the back, like a motor.
    at: zones.map((z) => z.center),
    gas: zones.map(() => GAS_MAX),
    burst: zones.map(() => 0),
    cooldown: zones.map(() => 0),
  };
}

/**
 * Water drag relative to the moving water: with no farts the raft settles to the current's
 * velocity, like a raft on a river. Still water (`flow` = 0) is plain damping.
 */
export function applyWaterDrag(raft: Raft, flow: Vec2): void {
  const v = raft.body.linvel();
  const k = LINEAR_DAMPING * raft.body.mass() * STEP;
  raft.body.applyImpulse({ x: (flow.x - v.x) * k, y: (flow.y - v.y) * k }, true);
}

/**
 * One tick of seat commands: riders slide around the ring inside their arcs, and a fart burst
 * pushes the raft from the rider toward its center. Walking works during the countdown;
 * farting only if `canFart`.
 */
export function applyInputs(
  raft: Raft,
  inputs: readonly SeatInput[],
  canFart: boolean,
  events: SimEvent[],
): void {
  const rot = raft.body.rotation();
  const pos = raft.body.translation();
  const solo = raft.zones.length === 1;

  raft.at.forEach((at, i) => {
    const input = inputs[i];
    if (input) {
      // Only the part of the stick along the ring moves the rider: push the way you want to go.
      const tangent = rot + at + Math.PI / 2;
      const along = input.move.x * Math.cos(tangent) + input.move.y * Math.sin(tangent);
      const speed = clamp(along, -1, 1) * WALK_SPEED;
      raft.at[i] = clampToZone(raft.zones[i]!, at + (speed * STEP) / RIDER_RING);
    }

    raft.cooldown[i] = Math.max(0, raft.cooldown[i]! - 1);
    if (canFart && input?.fart && raft.cooldown[i] === 0 && raft.gas[i]! >= FART_COST) {
      raft.gas[i]! -= FART_COST;
      raft.burst[i] = FART_TICKS;
      raft.cooldown[i] = FART_COOLDOWN;
    }
    if (raft.burst[i] === 0) {
      raft.gas[i] = Math.min(GAS_MAX, raft.gas[i]! + GAS_REGEN * STEP);
      return;
    }
    raft.burst[i]!--;

    // Butt out, so the push points from the rider to the center: it moves the raft, never spins it.
    const out = rot + raft.at[i]!;
    const dirX = -Math.cos(out);
    const dirY = -Math.sin(out);
    const impulse = FART_FORCE * STEP * (solo ? SOLO_BOOST : 1);
    raft.body.applyImpulse({ x: dirX * impulse, y: dirY * impulse }, true);
    const x = pos.x - dirX * RIDER_RING;
    const y = pos.y - dirY * RIDER_RING;
    // The gas leaves opposite to the push.
    events.push({ type: "fart", seat: i, x, y, dirX: -dirX, dirY: -dirY });
  });
}

/**
 * A hit throws the raft off balance: an impulse along `away` (unit vector, hazard → raft) plus
 * a spin. The spin goes the way the raft was sliding past the hazard, like friction at the
 * contact would turn it. `strength` scales both, 1 being a plain bar.
 */
export function knockBack(raft: Raft, away: Vec2, strength: number): void {
  const { body } = raft;
  const v = body.linvel();
  const turn = Math.sign(away.x * v.y - away.y * v.x) || 1;
  const push = KNOCK_SPEED * strength * body.mass();
  body.applyImpulse({ x: away.x * push, y: away.y * push }, true);
  body.applyTorqueImpulse(turn * KNOCK_SPIN * strength * body.effectiveAngularInertia(), true);
}
