import { CURRENT_SPEED, POND_RAMP, RAPIDS_RAMP, RAPIDS_SPEED } from "./constants.ts";
import { isIsland } from "./island.ts";
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

/** Samples at most this far apart (m) inside a pond, so its curved banks stay smooth. */
const POND_STEP = 1;

/**
 * The centerline sampled densely, with vertex tangents averaged so offsets bend smoothly. Inside
 * ponds extra samples go in along the same polyline, every POND_STEP m.
 */
export function sampleChannel(ch: Channel): Sample[] {
  const samples = sampleLine(ch.points);
  const ponds = ch.ponds ?? [];
  if (!ponds.length) return samples;
  const out: Sample[] = [samples[0]!];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    if (ponds.some((p) => a.s < p.to && b.s > p.from)) {
      const n = Math.ceil((b.s - a.s) / POND_STEP);
      for (let k = 1; k < n; k++) out.push(pointAt(samples, a.s + ((b.s - a.s) * k) / n));
    }
    out.push(b);
  }
  return out;
}

function sampleLine(points: readonly Vec2[]): Sample[] {
  const pts = smooth(points);
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
  // Binary search: the first sample at or beyond `s`.
  let lo = 1;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.s < s) lo = mid + 1;
    else hi = mid;
  }
  const i = lo;
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

/**
 * How much of the rapids' speed the water has at arc length `s`: 1 inside a stretch of rapids,
 * 0 in calm water, ramping over RAPIDS_RAMP m at either end.
 */
export function rapidsAt(ch: Channel, s: number): number {
  let w = 0;
  for (const r of ch.rapids ?? []) {
    const into = Math.min(s - r.from, r.to - s) / RAPIDS_RAMP + 0.5;
    w = Math.max(w, Math.min(1, Math.max(0, into)));
  }
  return w;
}

/**
 * The channel's half-width at arc length `s`: `halfWidth`, opening to a pond's half-width inside
 * it over POND_RAMP m at either end. The ramp is a quarter sine: the bank leaves the corridor at
 * a corner and rounds off into the pool, so a pond reads round.
 */
export function halfWidthAt(ch: Channel, s: number): number {
  let w = ch.halfWidth;
  for (const p of ch.ponds ?? []) {
    const into = Math.min(s - p.from, p.to - s) / POND_RAMP;
    if (into <= 0) continue;
    w = Math.max(
      w,
      ch.halfWidth + (p.halfWidth - ch.halfWidth) * Math.sin((Math.PI / 2) * Math.min(1, into)),
    );
  }
  return w;
}

/** The widest the channel gets anywhere, m. */
export const maxHalfWidth = (ch: Channel): number =>
  Math.max(ch.halfWidth, ...(ch.ponds ?? []).map((p) => p.halfWidth));

/**
 * How fast the water runs downstream at arc length `s`, m/s: fast in rapids, and slower where
 * the channel is wider (a pond), so the same water flows through.
 */
export function flowSpeed(ch: Channel, s: number): number {
  const speed = CURRENT_SPEED + (RAPIDS_SPEED - CURRENT_SPEED) * rapidsAt(ch, s);
  return ch.ponds?.length ? (speed * ch.halfWidth) / halfWidthAt(ch, s) : speed;
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

/**
 * Bank colliders: one thin box per centerline segment on each side, plus end caps. Where the
 * width changes along a segment (a pond's ramp), its box tilts to lie along the bank.
 */
export function channelWalls(ch: Channel): BankWall[] {
  const samples = sampleChannel(ch);
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
    const wa = halfWidthAt(ch, a.s);
    const wb = halfWidthAt(ch, b.s);
    for (const side of ["left", "right"] as const) {
      const k = side === "left" ? 1 : -1;
      const spiky = ch.spikes.some((sp) => sp.side === side && mid >= sp.from && mid <= sp.to);
      if (wa === wb) {
        const off = wa + WALL_HALF_THICKNESS;
        walls.push({
          x: mx + nx * off * k,
          y: my + ny * off * k,
          rot: Math.atan2(dy, dx),
          hx: len / 2 + WALL_OVERLAP,
          hy: WALL_HALF_THICKNESS,
          side,
          spiky,
        });
        continue;
      }
      // The bank runs from `wa` to `wb` m out across the segment: tilt the box by that slope and
      // push it its half-thickness outward, square to the bank.
      const tilt = Math.atan2(wb - wa, len) * k;
      const rot = Math.atan2(dy, dx) + tilt;
      const off = (wa + wb) / 2;
      walls.push({
        x: mx + nx * off * k - Math.sin(rot) * WALL_HALF_THICKNESS * k,
        y: my + ny * off * k + Math.cos(rot) * WALL_HALF_THICKNESS * k,
        rot,
        hx: Math.hypot(len, wb - wa) / 2 + WALL_OVERLAP,
        hy: WALL_HALF_THICKNESS,
        side,
        spiky,
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
      hy: halfWidthAt(ch, end.s) + WALL_HALF_THICKNESS + WALL_HALF_THICKNESS,
      side: "end",
      spiky: false,
    });
  }
  return walls;
}

/**
 * Every static obstacle of a level as a box: its explicit walls plus the channel's banks. An
 * island becomes the square that holds its octagon, so keeping off the box keeps off the island.
 */
export function levelWalls(level: LevelData): Box[] {
  const walls = level.walls.map((w) => {
    if (!isIsland(w)) return w;
    const r = Math.max(w.hx, w.hy);
    return { ...w, hx: r, hy: r };
  });
  return level.channel ? [...walls, ...channelWalls(level.channel)] : walls;
}
