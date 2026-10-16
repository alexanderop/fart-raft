import RAPIER from "@dimforge/rapier2d-compat";
import { channelWalls } from "./channel";
import type { Box, Channel, HazardDef, LevelData, Pose, Span, Vec2 } from "./types";

const BANK_RESTITUTION = 0.3;
const SPIKE_RESTITUTION = 0.9;

function boxCollider(b: Box): RAPIER.ColliderDesc {
  return RAPIER.ColliderDesc.cuboid(b.hx, b.hy).setTranslation(b.x, b.y).setRotation(b.rot);
}

/** Build static geometry from LevelData. Returns collider handle → checkpoint index. */
export function buildLevel(world: RAPIER.World, level: LevelData): Map<number, number> {
  for (const wall of level.walls)
    world.createCollider(boxCollider(wall).setRestitution(BANK_RESTITUTION));
  for (const wall of level.channel ? channelWalls(level.channel) : [])
    world.createCollider(
      boxCollider(wall).setRestitution(wall.spiky ? SPIKE_RESTITUTION : BANK_RESTITUTION),
    );

  const checkpointByHandle = new Map<number, number>();
  level.checkpoints.forEach((cp, i) => {
    const collider = world.createCollider(boxCollider(cp).setSensor(true));
    checkpointByHandle.set(collider.handle, i);
  });
  return checkpointByHandle;
}

const HAZARD_KINDS: readonly string[] = ["spinner", "sweeper"] satisfies HazardDef["kind"][];

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
const isVec2 = (v: unknown): v is Vec2 => isObject(v) && hasNums(v, ["x", "y"]);
const isSpan = (v: unknown): v is Span =>
  isObject(v) && hasNums(v, ["from", "to"]) && (v.side === "left" || v.side === "right");
const isChannel = (v: unknown): v is Channel =>
  isObject(v) &&
  hasNums(v, ["halfWidth"]) &&
  isList(v.points, isVec2) &&
  v.points.length >= 2 &&
  isList(v.spikes, isSpan);

/** Validate a course JSON (hand-written or exported from Blender). Throws with the first bad field. */
export function parseLevel(data: unknown): LevelData {
  if (!isObject(data)) throw new Error("level: not an object");
  const { name, spawn, channel = null, walls, checkpoints, hazards } = data;
  if (typeof name !== "string") throw new Error("level: name must be a string");
  if (!isPose(spawn)) throw new Error(`level ${name}: bad spawn`);
  if (channel !== null && !isChannel(channel)) throw new Error(`level ${name}: bad channel`);
  if (!isList(walls, isBox)) throw new Error(`level ${name}: bad walls`);
  if (!isList(checkpoints, isBox) || checkpoints.length === 0)
    throw new Error(`level ${name}: needs at least one checkpoint`);
  if (!isList(hazards, isHazard)) throw new Error(`level ${name}: bad hazards`);
  return { name, spawn, channel, walls, checkpoints, hazards };
}
