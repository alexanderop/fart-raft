import RAPIER from "@dimforge/rapier2d-compat";
import { channelWalls } from "./channel.ts";
import { isIsland, islandOutline } from "./island.ts";
import type { Box, Channel, HazardDef, LevelData, Pose, Span, Vec2 } from "./types.ts";

const BANK_RESTITUTION = 0.3;
const SPIKE_RESTITUTION = 0.9;

function boxCollider(b: Box): RAPIER.ColliderDesc {
  return RAPIER.ColliderDesc.cuboid(b.hx, b.hy).setTranslation(b.x, b.y).setRotation(b.rot);
}

/** An island is an octagon, the same one the renderer draws. */
function wallCollider(b: Box): RAPIER.ColliderDesc {
  if (!isIsland(b)) return boxCollider(b);
  const corners = new Float32Array(islandOutline(b).flatMap((p) => [p.x, p.y]));
  return RAPIER.ColliderDesc.convexHull(corners) ?? boxCollider(b);
}

export type BuiltLevel = {
  /** Collider handle → checkpoint index. */
  checkpointByHandle: Map<number, number>;
  /** Handles of the spiked bank colliders: touching one costs the crew a life. */
  spikeHandles: Set<number>;
};

/** Build static geometry from LevelData. */
export function buildLevel(world: RAPIER.World, level: LevelData): BuiltLevel {
  for (const wall of level.walls)
    world.createCollider(wallCollider(wall).setRestitution(BANK_RESTITUTION));
  const spikeHandles = new Set<number>();
  for (const wall of level.channel ? channelWalls(level.channel) : []) {
    const collider = world.createCollider(
      boxCollider(wall).setRestitution(wall.spiky ? SPIKE_RESTITUTION : BANK_RESTITUTION),
    );
    if (wall.spiky) spikeHandles.add(collider.handle);
  }

  const checkpointByHandle = new Map<number, number>();
  level.checkpoints.forEach((cp, i) => {
    const collider = world.createCollider(boxCollider(cp).setSensor(true));
    checkpointByHandle.set(collider.handle, i);
  });
  return { checkpointByHandle, spikeHandles };
}

const HAZARD_KINDS: readonly string[] = [
  "spinner",
  "sweeper",
  "log",
  "bumper",
] satisfies HazardDef["kind"][];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const hasNums = (v: Record<string, unknown>, keys: readonly string[]) =>
  keys.every((k) => typeof v[k] === "number" && Number.isFinite(v[k]));

const POSE_KEYS = ["x", "y", "rot"];
const BOX_KEYS = [...POSE_KEYS, "hx", "hy"];

const isPose = (v: unknown): v is Pose => isObject(v) && hasNums(v, POSE_KEYS);
const isBox = (v: unknown): v is Box => isObject(v) && hasNums(v, BOX_KEYS);
const isOptionalNum = (v: unknown) =>
  v === undefined || (typeof v === "number" && Number.isFinite(v));
const isHazard = (v: unknown): v is HazardDef =>
  isObject(v) &&
  hasNums(v, [...BOX_KEYS, "speed"]) &&
  isOptionalNum(v.range) &&
  isOptionalNum(v.phase) &&
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
