import * as THREE from "three";
import { nearestS, pointAt, sampleChannel } from "../../sim/channel.ts";
import type { LevelData, Pose, Snapshot } from "../../sim/types.ts";
import { jumped } from "./coords.ts";
import { clamp, damp } from "./spring.ts";

/**
 * Low chase camera, like Fart Together: it rides close behind and a little above the raft, so the
 * course ahead and the horizon fill the view and the banks rush past. It slowly turns to follow
 * the stream (the channel's tangent ahead of the raft), never the raft's
 * own spin. Courses without a channel follow the direction to the next gate instead.
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

const BASE_FOV = 52;
const BACK = 15;
const HEIGHT = 11.5;
/** Stream direction is read this far ahead of the raft, so bends turn the view early. */
const HEADING_AHEAD = 10;
/** Screens narrower than this widen the vertical FOV so the channel still fits across. */
const DESIGN_ASPECT = 16 / 9;
const MAX_FOV = 90;
/** The view centers this far ahead of the raft (m), so the raft sits low in the frame. */
const LOOK_AHEAD = 5;
/** At full speed the lens widens by this many degrees: speed reads as rushing banks. */
const SPEED_FOV = 8;
const FULL_SPEED = 10;

/** Vertical FOV that shows the same horizontal extent as `fov` does at DESIGN_ASPECT. */
function fitWidth(fov: number, aspect: number): number {
  if (aspect >= DESIGN_ASPECT) return fov;
  const half = Math.atan((Math.tan(THREE.MathUtils.degToRad(fov / 2)) * DESIGN_ASPECT) / aspect);
  return Math.min(MAX_FOV, THREE.MathUtils.radToDeg(half * 2));
}

export function createChaseCamera(level: LevelData): ChaseCamera {
  const route = level.channel ? sampleChannel(level.channel) : null;
  const dir = { x: Math.cos(level.spawn.rot), y: Math.sin(level.spawn.rot) };
  const focus = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const look = new THREE.Vector3();
  const target = new THREE.Vector3();
  let init = false;
  let fov = BASE_FOV;
  let lastTick = 0;
  let lastPose: Pose = level.spawn;

  /** Unit heading in sim space the camera wants to face. */
  function heading(pose: Pose, curr: Snapshot) {
    if (route) {
      const p = pointAt(route, nearestS(route, pose) + HEADING_AHEAD);
      return { x: p.tx, y: p.ty };
    }
    const nextIdx = curr.phase.kind === "racing" ? curr.phase.nextCheckpoint : 0;
    const gate = level.checkpoints[nextIdx] ?? level.checkpoints[level.checkpoints.length - 1]!;
    const gx = gate.x - pose.x;
    const gy = gate.y - pose.y;
    const gl = Math.hypot(gx, gy) || 1;
    return { x: gx / gl, y: gy / gl };
  }

  return {
    update(camera, dt, pose, curr, vel, thrust, shake) {
      // A restart or a respawn cuts straight to the raft instead of flying across the course.
      const snap = !init || curr.tick < lastTick || jumped(lastPose, pose);
      lastTick = curr.tick;
      lastPose = pose;
      const speed = Math.hypot(vel.x, vel.y);

      const h = heading(pose, curr);
      const kDir = snap ? 1 : damp(1.2, dt);
      dir.x += (h.x - dir.x) * kDir;
      dir.y += (h.y - dir.y) * kDir;
      const dl = Math.hypot(dir.x, dir.y) || 1;
      dir.x /= dl;
      dir.y /= dl;

      const fx = pose.x + dir.x * LOOK_AHEAD + vel.x * 0.25;
      const fy = pose.y + dir.y * LOOK_AHEAD + vel.y * 0.25;
      if (snap) focus.set(fx, 0, -fy);
      else {
        const k = damp(4, dt);
        focus.x += (fx - focus.x) * k;
        focus.z += (-fy - focus.z) * k;
      }

      // Three frame: sim (x, y) → (x, -y).
      target.set(focus.x - dir.x * BACK, HEIGHT, focus.z + dir.y * BACK);
      if (snap) pos.copy(target);
      else pos.lerp(target, damp(3.5, dt));

      look.copy(focus);
      camera.position.copy(pos).add(shake);
      camera.lookAt(look);

      const want = BASE_FOV + thrust * 3 + clamp(speed / FULL_SPEED, 0, 1) * SPEED_FOV;
      fov += (fitWidth(want, camera.aspect) - fov) * (snap ? 1 : damp(4, dt));
      if (Math.abs(camera.fov - fov) > 0.01) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
      init = true;
    },
  };
}
