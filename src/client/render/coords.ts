import { Matrix4, Object3D } from "three";
import type { Pose } from "../../sim/types.ts";

// Sim is 2D (x, y) on the water plane. Three is Y-up, so sim (x, y) → three (x, 0, -y)
// and sim rotation → rotation.y. Keep every conversion in this file.

export function applyPose(obj: Object3D, pose: Pose, height = 0): void {
  obj.position.set(pose.x, height, -pose.y);
  obj.rotation.y = pose.rot;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function lerpAngle(a: number, b: number, t: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * t;
}

/** Further than this (m) between two ticks is a respawn, not motion: draw it as a cut. */
const TELEPORT = 6;

export const jumped = (a: Pose, b: Pose): boolean => Math.hypot(b.x - a.x, b.y - a.y) > TELEPORT;

export function lerpPose(a: Pose, b: Pose, t: number): Pose {
  if (jumped(a, b)) return b;
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), rot: lerpAngle(a.rot, b.rot, t) };
}

/** Column-major-free helper: sim pose + extra scale → a Matrix4 for InstancedMesh slots. */
const scratch = new Object3D();
export function poseMatrix(
  pose: Pose,
  height = 0,
  scale: readonly [number, number, number] = [1, 1, 1],
): Matrix4 {
  applyPose(scratch, pose, height);
  scratch.scale.set(scale[0], scale[1], scale[2]);
  scratch.updateMatrix();
  return scratch.matrix.clone();
}
