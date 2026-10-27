import type { Box, Vec2 } from "./types.ts";

// A wall with both half-extents at least this (m) is no bank slab but an island: it is drawn and
// collides as a regular octagon, so what you see is what the raft bumps into.
export const ISLAND_MIN_HALF = 1;

/** The octagon's corners sit this far out, relative to the box's larger half-extent. */
const ISLAND_FLARE = 1.08;

export const isIsland = (box: Box): boolean => Math.min(box.hx, box.hy) >= ISLAND_MIN_HALF;

/** Distance from an island's center to its corners, m. */
export const islandRadius = (box: Box): number => Math.max(box.hx, box.hy) * ISLAND_FLARE;

/** The island's 8 corners in the sim frame: flat sides square to the wall's `rot`. */
export function islandOutline(box: Box): Vec2[] {
  const r = islandRadius(box);
  return Array.from({ length: 8 }, (_, k) => {
    const a = box.rot + Math.PI / 8 + (k * Math.PI) / 4;
    return { x: box.x + Math.cos(a) * r, y: box.y + Math.sin(a) * r };
  });
}
