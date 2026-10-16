import RAPIER from "@dimforge/rapier2d-compat";
import {
  ANGULAR_DAMPING,
  FART_FORCE,
  SOLO_BOOST,
  GAS_DRAIN,
  GAS_MAX,
  GAS_REGEN,
  LINEAR_DAMPING,
  RAFT_HALF,
  STEP,
  type Seat,
} from "./constants";
import type { Pose, SeatInput, SimEvent } from "./types";

export type Raft = {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  seats: readonly Seat[];
  gas: number[];
};

export function createRaft(world: RAPIER.World, spawn: Pose, seats: readonly Seat[]): Raft {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y)
      .setRotation(spawn.rot)
      .setLinearDamping(LINEAR_DAMPING)
      .setAngularDamping(ANGULAR_DAMPING)
      .setCcdEnabled(true),
  );
  const collider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(RAFT_HALF.x, RAFT_HALF.y)
      .setRestitution(0.4)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
    body,
  );
  return { body, collider, seats, gas: seats.map(() => GAS_MAX) };
}

/** Apply one tick of seat commands: drain/regen gas and push the raft at each farting seat. */
export function applyInputs(raft: Raft, inputs: readonly SeatInput[], events: SimEvent[]): void {
  const rot = raft.body.rotation();
  const pos = raft.body.translation();
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);

  raft.seats.forEach((seat, i) => {
    const input = inputs[i];
    const farting = input?.thrust === true && raft.gas[i]! > 0;
    raft.gas[i] = farting
      ? Math.max(0, raft.gas[i]! - GAS_DRAIN * STEP)
      : Math.min(GAS_MAX, raft.gas[i]! + GAS_REGEN * STEP);
    if (!farting) return;

    const dir = rot + input.aim;
    const dirX = Math.cos(dir);
    const dirY = Math.sin(dir);
    const x = pos.x + seat.x * cos - seat.y * sin;
    const y = pos.y + seat.x * sin + seat.y * cos;
    const impulse = FART_FORCE * STEP * (raft.seats.length === 1 ? SOLO_BOOST : 1);
    raft.body.applyImpulseAtPoint({ x: dirX * impulse, y: dirY * impulse }, { x, y }, true);
    // The gas leaves opposite to the push.
    events.push({ type: "fart", seat: i, x, y, dirX: -dirX, dirY: -dirY });
  });
}
