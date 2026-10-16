import RAPIER from "@dimforge/rapier2d-compat";
import type { Box, HazardDef, LevelData, Pose } from "./types";

function boxCollider(b: Box): RAPIER.ColliderDesc {
  return RAPIER.ColliderDesc.cuboid(b.hx, b.hy).setTranslation(b.x, b.y).setRotation(b.rot);
}

/** Build static geometry from LevelData. Returns collider handle → checkpoint index. */
export function buildLevel(world: RAPIER.World, level: LevelData): Map<number, number> {
  for (const wall of level.walls) world.createCollider(boxCollider(wall).setRestitution(0.3));

  const checkpointByHandle = new Map<number, number>();
  level.checkpoints.forEach((cp, i) => {
    const collider = world.createCollider(boxCollider(cp).setSensor(true));
    checkpointByHandle.set(collider.handle, i);
  });
  return checkpointByHandle;
}

const HAZARD_KINDS: readonly string[] = ["spinner"] satisfies HazardDef["kind"][];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const hasNums = (v: Record<string, unknown>, keys: readonly string[]) =>
  keys.every((k) => typeof v[k] === "number" && Number.isFinite(v[k]));

const POSE_KEYS = ["x", "y", "rot"];
const BOX_KEYS = [...POSE_KEYS, "hx", "hy"];

const isPose = (v: unknown): v is Pose => isObject(v) && hasNums(v, POSE_KEYS);
const isBox = (v: unknown): v is Box => isObject(v) && hasNums(v, BOX_KEYS);
const isHazard = (v: unknown): v is HazardDef =>
  isObject(v) &&
  hasNums(v, [...BOX_KEYS, "speed"]) &&
  typeof v.id === "string" &&
  typeof v.kind === "string" &&
  HAZARD_KINDS.includes(v.kind);
const isList = <T>(v: unknown, item: (x: unknown) => x is T): v is T[] =>
  Array.isArray(v) && v.every(item);

/** Validate a course JSON (hand-written or exported from Blender). Throws with the first bad field. */
export function parseLevel(data: unknown): LevelData {
  if (!isObject(data)) throw new Error("level: not an object");
  const { name, spawn, walls, checkpoints, hazards } = data;
  if (typeof name !== "string") throw new Error("level: name must be a string");
  if (!isPose(spawn)) throw new Error(`level ${name}: bad spawn`);
  if (!isList(walls, isBox)) throw new Error(`level ${name}: bad walls`);
  if (!isList(checkpoints, isBox) || checkpoints.length === 0)
    throw new Error(`level ${name}: needs at least one checkpoint`);
  if (!isList(hazards, isHazard)) throw new Error(`level ${name}: bad hazards`);
  return { name, spawn, walls, checkpoints, hazards };
}
