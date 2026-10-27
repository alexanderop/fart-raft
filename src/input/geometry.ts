import type { Box, Vec2 } from "../sim/types.ts";

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Vector from the closest point of a rotated box to `p`, and its length (0 inside). */
export function awayFromBox(b: Box, p: Vec2): { x: number; y: number; dist: number } {
  const c = Math.cos(b.rot);
  const s = Math.sin(b.rot);
  const dx = p.x - b.x;
  const dy = p.y - b.y;
  const lx = dx * c + dy * s;
  const ly = -dx * s + dy * c;
  const ex = lx - clamp(lx, -b.hx, b.hx);
  const ey = ly - clamp(ly, -b.hy, b.hy);
  const dist = Math.hypot(ex, ey);
  return { x: ex * c - ey * s, y: ex * s + ey * c, dist };
}

/** Distance from `p` to a rotated box (0 inside): `awayFromBox(b, p).dist` without building a vector. */
export function distToBox(b: Box, p: Vec2): number {
  const c = Math.cos(b.rot);
  const s = Math.sin(b.rot);
  const dx = p.x - b.x;
  const dy = p.y - b.y;
  const lx = dx * c + dy * s;
  const ly = -dx * s + dy * c;
  return Math.hypot(lx - clamp(lx, -b.hx, b.hx), ly - clamp(ly, -b.hy, b.hy));
}
