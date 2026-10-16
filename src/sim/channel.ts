import type { Box, Channel, LevelData, Vec2 } from "./types.ts";

/** One point of the smoothed centerline: position, unit tangent, left normal, arc length. */
export type Sample = Vec2 & { tx: number; ty: number; nx: number; ny: number; s: number };

export type BankWall = Box & { side: "left" | "right" | "end"; spiky: boolean };

const SMOOTHING_PASSES = 4;
const WALL_HALF_THICKNESS = 0.5;
/** Each bank box reaches this far past its segment ends, closing the wedge gaps on outer bends. */
const WALL_OVERLAP = 1;

/** Chaikin corner cutting with fixed endpoints: control points → smooth polyline. */
function smooth(points: readonly Vec2[]): Vec2[] {
  let pts = [...points];
  for (let pass = 0; pass < SMOOTHING_PASSES; pass++) {
    const next: Vec2[] = [pts[0]!];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      next.push(
        { x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 },
        { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 },
      );
    }
    next.push(pts[pts.length - 1]!);
    pts = next;
  }
  return pts;
}

/** The centerline sampled densely, with vertex tangents averaged so offsets bend smoothly. */
export function sampleChannel(ch: Channel): Sample[] {
  const pts = smooth(ch.points);
  let s = 0;
  return pts.map((p, i) => {
    if (i > 0) s += Math.hypot(p.x - pts[i - 1]!.x, p.y - pts[i - 1]!.y);
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[Math.min(pts.length - 1, i + 1)]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const tx = (b.x - a.x) / len;
    const ty = (b.y - a.y) / len;
    return { x: p.x, y: p.y, tx, ty, nx: -ty, ny: tx, s };
  });
}

/** Linear lookup by arc length, clamped to the ends. */
export function pointAt(samples: readonly Sample[], s: number): Sample {
  const last = samples[samples.length - 1]!;
  if (s <= 0) return samples[0]!;
  if (s >= last.s) return last;
  let i = 1;
  while (samples[i]!.s < s) i++;
  const a = samples[i - 1]!;
  const b = samples[i]!;
  const t = (s - a.s) / (b.s - a.s || 1);
  const tx = a.tx + (b.tx - a.tx) * t;
  const ty = a.ty + (b.ty - a.ty) * t;
  const tl = Math.hypot(tx, ty) || 1;
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    tx: tx / tl,
    ty: ty / tl,
    nx: -ty / tl,
    ny: tx / tl,
    s,
  };
}

/** Arc length of the centerline point closest to `p`. */
export function nearestS(samples: readonly Sample[], p: Vec2): number {
  let best = Infinity;
  let bestS = 0;
  for (let i = 0; i + 1 < samples.length; i++) {
    const a = samples[i]!;
    const b = samples[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const d = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    if (d < best) {
      best = d;
      bestS = a.s + (b.s - a.s) * t;
    }
  }
  return bestS;
}

/** Bank colliders: one thin box per centerline segment on each side, plus end caps. */
export function channelWalls(ch: Channel): BankWall[] {
  const samples = sampleChannel(ch);
  const off = ch.halfWidth + WALL_HALF_THICKNESS;
  const walls: BankWall[] = [];
  for (let i = 0; i + 1 < samples.length; i++) {
    const a = samples[i]!;
    const b = samples[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const mid = (a.s + b.s) / 2;
    for (const side of ["left", "right"] as const) {
      const k = side === "left" ? 1 : -1;
      walls.push({
        x: mx + nx * off * k,
        y: my + ny * off * k,
        rot: Math.atan2(dy, dx),
        hx: len / 2 + WALL_OVERLAP,
        hy: WALL_HALF_THICKNESS,
        side,
        spiky: ch.spikes.some((sp) => sp.side === side && mid >= sp.from && mid <= sp.to),
      });
    }
  }
  for (const end of [samples[0]!, samples[samples.length - 1]!]) {
    const out = end === samples[0] ? -1 : 1;
    walls.push({
      x: end.x + end.tx * WALL_HALF_THICKNESS * out,
      y: end.y + end.ty * WALL_HALF_THICKNESS * out,
      rot: Math.atan2(end.ty, end.tx),
      hx: WALL_HALF_THICKNESS,
      hy: off + WALL_HALF_THICKNESS,
      side: "end",
      spiky: false,
    });
  }
  return walls;
}

/** Every static collider box of a level: its explicit walls plus the channel's banks. */
export function levelWalls(level: LevelData): Box[] {
  return level.channel ? [...level.walls, ...channelWalls(level.channel)] : level.walls;
}
