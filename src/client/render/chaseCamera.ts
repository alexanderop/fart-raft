import * as THREE from "three";
import { nearestS, pointAt, sampleChannel } from "../../sim/channel.ts";
import type { LevelData, Pose, View } from "../../sim/types.ts";
import { jumped } from "./coords.ts";
import { clamp, damp } from "./spring.ts";

/**
 * Chase camera, like Fart Together: high behind the raft, looking about 37° down, so the raft is a
 * fifth of the screen across, sits a little below the middle, and 40 m of channel show ahead. It
 * turns to follow the stream (the channel's tangent well ahead of the raft, so it swings into a
 * bend before the raft gets there), never the raft's own spin. Courses without a channel follow
 * the direction to the next gate instead.
 */
export type ChaseCamera = {
  update(
    camera: THREE.PerspectiveCamera,
    dt: number,
    pose: Pose,
    curr: View,
    vel: { x: number; y: number },
    thrust: number,
    shake: THREE.Vector3,
  ): void;
};

const BASE_FOV = 48;
const BACK = 16;
const HEIGHT = 12;
/** Stream direction is read this far ahead of the raft, so bends turn the view early. */
const HEADING_AHEAD = 16;
/** Screens narrower than this widen the vertical FOV so the channel still fits across. */
const DESIGN_ASPECT = 16 / 9;
const MAX_FOV = 90;
/** The view centers this far ahead of the raft (m), so the raft sits low in the frame. */
const LOOK_AHEAD = 3.5;
/** At full speed the lens widens by this many degrees: speed reads as rushing banks. */
const SPEED_FOV = 6;
const FULL_SPEED = 10;

/**
 * Portrait screens (taller than wide) show little across, so the camera climbs, backs off and
 * looks further ahead: the tall screen then shows a long stretch of the channel with the raft low
 * in the frame. These are the extra metres at a phone held upright (PORTRAIT_FULL or narrower);
 * a square screen gets none, so landscape framing is untouched.
 */
const PORTRAIT_BACK = 4;
const PORTRAIT_HEIGHT = 7;
const PORTRAIT_LOOK_AHEAD = 9;
const PORTRAIT_FULL = 0.6;
/** In portrait the vertical FOV may open this far, so about 62° stays visible across a phone. */
const PORTRAIT_MAX_FOV = 105;

/** 0 on a square or landscape screen, 1 on a phone held upright. */
export const portraitness = (aspect: number): number =>
  clamp((1 - aspect) / (1 - PORTRAIT_FULL), 0, 1);

/** Resting framing at `aspect`: metres behind the view's center, up, and ahead of the raft. */
export function framing(aspect: number) {
  const tall = portraitness(aspect);
  return {
    fov: BASE_FOV,
    back: BACK + PORTRAIT_BACK * tall,
    height: HEIGHT + PORTRAIT_HEIGHT * tall,
    lookAhead: LOOK_AHEAD + PORTRAIT_LOOK_AHEAD * tall,
  };
}

/**
 * Vertical FOV that shows the same horizontal extent as `fov` does at DESIGN_ASPECT, capped so
 * a tall screen does not bend into a fisheye. Portrait gets a higher cap: the cap is what sets
 * how much it sees across.
 */
export function fitWidth(fov: number, aspect: number): number {
  if (aspect >= DESIGN_ASPECT) return fov;
  const half = Math.atan((Math.tan(THREE.MathUtils.degToRad(fov / 2)) * DESIGN_ASPECT) / aspect);
  const cap = MAX_FOV + (PORTRAIT_MAX_FOV - MAX_FOV) * portraitness(aspect);
  return Math.min(cap, THREE.MathUtils.radToDeg(half * 2));
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
  function heading(pose: Pose, curr: View) {
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
      // Read every frame, so turning the phone reframes at once (the position eases over).
      const { back, height, lookAhead } = framing(camera.aspect);

      const h = heading(pose, curr);
      const kDir = snap ? 1 : damp(1.5, dt);
      dir.x += (h.x - dir.x) * kDir;
      dir.y += (h.y - dir.y) * kDir;
      const dl = Math.hypot(dir.x, dir.y) || 1;
      dir.x /= dl;
      dir.y /= dl;

      const fx = pose.x + dir.x * lookAhead + vel.x * 0.25;
      const fy = pose.y + dir.y * lookAhead + vel.y * 0.25;
      if (snap) focus.set(fx, 0, -fy);
      else {
        const k = damp(4, dt);
        focus.x += (fx - focus.x) * k;
        focus.z += (-fy - focus.z) * k;
      }

      // Three frame: sim (x, y) → (x, -y).
      target.set(focus.x - dir.x * back, height, focus.z + dir.y * back);
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
