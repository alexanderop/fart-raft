import * as THREE from "three";
import type { LevelData, Pose, Snapshot } from "../../sim/types";
import { clamp, damp } from "./spring";

/**
 * Smoothed chase camera. Heading is a blend of velocity, the direction to the next gate and
 * (weakly) the raft's own rotation, so spinning the raft never whips the view around.
 */
export type ChaseCamera = {
  update(
    camera: THREE.PerspectiveCamera,
    dt: number,
    pose: Pose,
    curr: Snapshot,
    vel: { x: number; y: number },
    thrust: number,
    shake: THREE.Vector3,
  ): void;
};

const BASE_FOV = 55;
const BACK = 11;
const HEIGHT = 7.5;

export function createChaseCamera(level: LevelData): ChaseCamera {
  // Heading in the sim frame (unit vector). Starts along the spawn rotation.
  const dir = { x: Math.cos(level.spawn.rot), y: Math.sin(level.spawn.rot) };
  const focus = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const look = new THREE.Vector3();
  const target = new THREE.Vector3();
  let init = false;
  let fov = BASE_FOV;
  let lastTick = 0;
  let lift0 = 0;

  return {
    update(camera, dt, pose, curr, vel, thrust, shake) {
      const snap = !init || curr.tick < lastTick;
      lastTick = curr.tick;

      const speed = Math.hypot(vel.x, vel.y);
      const nextIdx = curr.phase.kind === "racing" ? curr.phase.nextCheckpoint : 0;
      const gate = level.checkpoints[nextIdx];

      let hx = Math.cos(pose.rot) * 0.25;
      let hy = Math.sin(pose.rot) * 0.25;
      if (gate) {
        const gx = gate.x - pose.x;
        const gy = gate.y - pose.y;
        const gl = Math.hypot(gx, gy) || 1;
        hx += (gx / gl) * 0.5;
        hy += (gy / gl) * 0.5;
      }
      if (speed > 0.1) {
        const w = clamp(speed / 3, 0, 1);
        hx += (vel.x / speed) * w;
        hy += (vel.y / speed) * w;
      }
      const hl = Math.hypot(hx, hy) || 1;
      hx /= hl;
      hy /= hl;

      const kDir = snap ? 1 : damp(1.6, dt);
      dir.x += (hx - dir.x) * kDir;
      dir.y += (hy - dir.y) * kDir;
      const dl = Math.hypot(dir.x, dir.y) || 1;
      dir.x /= dl;
      dir.y /= dl;

      // Focus point: raft plus a little look-ahead along velocity.
      const ahead = clamp(0.35, 0, 1);
      const fx = pose.x + vel.x * ahead;
      const fy = pose.y + vel.y * ahead;
      if (snap) focus.set(fx, 0, -fy);
      else {
        const k = damp(6, dt);
        focus.x += (fx - focus.x) * k;
        focus.z += (-fy - focus.z) * k;
      }

      // Rise over gates so the sign boards never block the view as we pass under them.
      let gateNear = 0;
      for (const cp of level.checkpoints) {
        gateNear = Math.max(
          gateNear,
          1 - clamp(Math.hypot(cp.x - pose.x, cp.y - pose.y) / 12, 0, 1),
        );
      }
      const lift = snap ? gateNear : lift0 + (gateNear - lift0) * damp(5, dt);
      lift0 = lift;

      // Three frame: sim (x, y) → (x, -y).
      target.set(focus.x - dir.x * BACK, HEIGHT + lift * 4.5, focus.z + dir.y * BACK);
      if (snap) pos.copy(target);
      else pos.lerp(target, damp(4.5, dt));

      look.set(focus.x + dir.x * 9, 0.5, focus.z - dir.y * 9);
      camera.position.copy(pos).add(shake);
      camera.lookAt(look);

      fov += (BASE_FOV + thrust * 7 + clamp(speed / 12, 0, 1) * 3 - fov) * damp(5, dt);
      if (Math.abs(camera.fov - fov) > 0.01) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
      init = true;
    },
  };
}
