import * as THREE from "three";
import { STEP } from "../../sim/constants.ts";
import type { Pose, SimEvent, Snapshot } from "../../sim/types.ts";
import { clamp, damp, spring, stepSpring, wrapAngle } from "./spring.ts";

/**
 * Visual-only raft motion: bobbing, banking, bump squash, nose lift. Written on top of the
 * pose that applyPose set, never fed back into the sim.
 */
export type RaftMotion = {
  onEvent(e: SimEvent, now: number): void;
  update(dt: number, now: number, prev: Snapshot, curr: Snapshot, pose: Pose): void;
  /** 0..1 summed seat thrust, smoothed. Used for the camera FOV kick. */
  readonly thrust: number;
  /** Smoothed world velocity (sim frame). */
  readonly vel: { x: number; y: number };
};

export function createRaftMotion(raft: THREE.Object3D): RaftMotion {
  raft.rotation.order = "YXZ";
  const roll = spring();
  const pitch = spring();
  const squash = spring();
  const heaveBump = spring();
  const vel = { x: 0, y: 0 };
  const lastFart = [-10, -10, -10, -10];
  let lateral = 0;
  let forward = 0;
  let accelLat = 0;
  let accelFwd = 0;
  let yawRate = 0;
  let thrust = 0;
  let lastTick = 0;

  return {
    get thrust() {
      return thrust;
    },
    vel,
    onEvent(e, now) {
      if (e.type === "fart") lastFart[e.seat] = now;
      if (e.type === "bump") {
        const p = clamp(e.speed / 6, 0.3, 1.5);
        squash.v += 7 * p;
        roll.v += (Math.random() - 0.5) * 6 * p;
        pitch.v += (Math.random() - 0.5) * 5 * p;
        heaveBump.v += 1.5 * p;
      }
    },
    update(dt, now, prev, curr, pose) {
      if (curr.tick < lastTick) {
        vel.x = vel.y = lateral = forward = accelFwd = accelLat = yawRate = 0;
      }
      lastTick = curr.tick;

      // Velocity and yaw rate from the last two sim ticks.
      const vx = (curr.raft.x - prev.raft.x) / STEP;
      const vy = (curr.raft.y - prev.raft.y) / STEP;
      const k = damp(10, dt);
      vel.x += (vx - vel.x) * k;
      vel.y += (vy - vel.y) * k;
      yawRate += (wrapAngle(curr.raft.rot - prev.raft.rot) / STEP - yawRate) * k;

      // Local velocity (sim frame): forward along heading, lateral to the left.
      const c = Math.cos(pose.rot);
      const s = Math.sin(pose.rot);
      const fwd = vel.x * c + vel.y * s;
      const lat = -vel.x * s + vel.y * c;
      if (dt > 0) {
        accelFwd += ((fwd - forward) / dt - accelFwd) * damp(8, dt);
        accelLat += ((lat - lateral) / dt - accelLat) * damp(8, dt);
      }
      forward = fwd;
      lateral = lat;

      let t = 0;
      for (const f of lastFart) if (now - f < 0.1) t += 0.25;
      thrust += (t - thrust) * damp(6, dt);

      // Bank into turns: rotation.x is the roll about the raft's forward axis (+x).
      // Sim +y is three −z, so a leftward lateral accel leans the raft right/left via sign below.
      const rollTarget = clamp(accelLat * 0.012 + yawRate * fwd * -0.01, -0.22, 0.22);
      const pitchTarget = clamp(thrust * 0.12 + accelFwd * 0.006, -0.12, 0.2);
      stepSpring(roll, rollTarget, 40, 7, dt);
      stepSpring(pitch, pitchTarget, 40, 7, dt);
      stepSpring(squash, 0, 220, 9, dt);
      stepSpring(heaveBump, 0, 160, 8, dt);

      const t0 = now;
      const heave =
        Math.sin(t0 * 1.7) * 0.05 + Math.sin(t0 * 2.9 + 1.3) * 0.025 + heaveBump.x * 0.06;
      const bobRoll = Math.sin(t0 * 1.3 + 0.5) * 0.03 + Math.sin(t0 * 2.3) * 0.012;
      const bobPitch = Math.sin(t0 * 1.1 + 2) * 0.025 + Math.sin(t0 * 2.1 + 0.7) * 0.01;

      raft.position.y += heave + 0.04;
      raft.rotation.x = roll.x + bobRoll;
      raft.rotation.z = pitch.x + bobPitch;
      const sq = squash.x * 0.035;
      raft.scale.set(1 + sq * 0.5, 1 - sq, 1 + sq * 0.5);
    },
  };
}
