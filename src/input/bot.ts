import { AIM_LIMIT, AIM_SPEED, GAS_MAX, STEP, type Seat } from "../sim/constants";
import { levelWalls, nearestS, pointAt, sampleChannel } from "../sim/channel";
import {
  IDLE_INPUT,
  type Box,
  type LevelData,
  type SeatInput,
  type Snapshot,
  type Vec2,
} from "../sim/types";
import type { InputSource } from "./sources";

// A bot is just another InputSource: it reads the same Snapshot every client (and later the
// server) has, and answers with a SeatInput. No DOM, no Rapier, so it runs headless on a server.

export type BotTuning = {
  cruise: number; // target speed, m/s
  avoidRange: number; // start steering away from walls this close (m)
  avoidLookahead: number; // also probe where we'll be in this many seconds
  headingGain: number; // how hard to turn the nose toward the travel direction
  spinDamping: number; // fight existing spin so the raft doesn't overshoot
};

/** Picked by sweeping crews of 1–4 on the pond: every crew finishes, the slowest in ≈ 45 s. */
export const DEFAULT_TUNING: BotTuning = {
  cruise: 7,
  avoidRange: 3,
  avoidLookahead: 0.7,
  headingGain: 1.5,
  spinDamping: 0.6,
};
const AIM_SAMPLES = 9;
const GAS_RESERVE = 0.12; // stop farting below this fraction…
const GAS_RESUME = 0.5; // …until the tank is back to this
// Fart whenever the best nozzle angle helps at all. A higher bar deadlocks a solo rider, which
// often can't push forward and turn the right way at once.
const MIN_SCORE = 0.02;
// Facing far off course, turning is worth a little backward push: otherwise a solo rider
// pinned on a bend sits forever because every nozzle angle scores below zero.
const MUST_TURN = 0.9;

type Vec = Vec2;

/** On a channel course, steer at the centerline this far ahead instead of straight at the gate. */
const ROUTE_LOOKAHEAD = 9;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Vector from the closest point of a rotated box to `p`, and its length (0 inside). */
function awayFromBox(b: Box, p: Vec): { x: number; y: number; dist: number } {
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

/** Desired push direction in world space: toward the next gate, away from walls, minus drift. */
function desiredForce(
  walls: readonly Box[],
  snap: Snapshot,
  vel: Vec,
  target: Vec,
  t: BotTuning,
): Vec {
  const { raft } = snap;
  const tx = target.x - raft.x;
  const ty = target.y - raft.y;
  const tLen = Math.hypot(tx, ty) || 1;
  let wantX = (tx / tLen) * t.cruise;
  let wantY = (ty / tLen) * t.cruise;

  // Avoidance only deflects sideways. If it could also push back against the goal, the two
  // would cancel in front of a rock and the bot would sit there forever (potential-field trap).
  const gx = tx / tLen;
  const gy = ty / tLen;
  const probes = [
    raft,
    { x: raft.x + vel.x * t.avoidLookahead, y: raft.y + vel.y * t.avoidLookahead },
  ];
  for (const wall of walls) {
    for (const p of probes) {
      const away = awayFromBox(wall, p);
      if (away.dist >= t.avoidRange || away.dist === 0) continue;
      const push = ((t.avoidRange - away.dist) / t.avoidRange) * t.cruise * 1.5;
      let ax = away.x / away.dist;
      let ay = away.y / away.dist;
      const back = ax * gx + ay * gy;
      if (back < 0) {
        ax -= back * gx;
        ay -= back * gy;
        const side = Math.hypot(ax, ay);
        // Head-on: pick the side the obstacle isn't on (left if dead center).
        if (side < 0.2) {
          const left = gx * away.y - gy * away.x >= 0 ? 1 : -1;
          ax = -gy * left;
          ay = gx * left;
        } else {
          ax /= side;
          ay /= side;
        }
      }
      wantX += ax * push;
      wantY += ay * push;
    }
  }
  return { x: wantX - vel.x, y: wantY - vel.y };
}

const STUCK_SPEED = 0.6; // m/s: slower than this counts as stuck…
const STUCK_AFTER = 1; // …for this many seconds
const ESCAPE_FOR = 1.5; // then back off the nearest obstacle for this long

/** Back off the closest wall while sliding along it toward the gate. */
function escapeForce(walls: readonly Box[], snap: Snapshot, target: Vec, t: BotTuning): Vec {
  const { raft } = snap;
  const tx = target.x - raft.x;
  const ty = target.y - raft.y;
  const tLen = Math.hypot(tx, ty) || 1;
  let nearest: { x: number; y: number; dist: number } | undefined;
  for (const wall of walls) {
    const away = awayFromBox(wall, raft);
    if (away.dist > 0 && (!nearest || away.dist < nearest.dist)) nearest = away;
  }
  if (!nearest || nearest.dist > t.avoidRange)
    return { x: (tx / tLen) * t.cruise, y: (ty / tLen) * t.cruise };
  const nx = nearest.x / nearest.dist;
  const ny = nearest.y / nearest.dist;
  // Slide: the part of the gate direction that runs along the wall (or "left" if head-on).
  let sx = tx / tLen - ((nx * tx + ny * ty) / tLen) * nx;
  let sy = ty / tLen - ((nx * tx + ny * ty) / tLen) * ny;
  const sLen = Math.hypot(sx, sy);
  if (sLen < 0.2) {
    sx = -ny;
    sy = nx;
  } else {
    sx /= sLen;
    sy /= sLen;
  }
  return { x: (nx * 0.8 + sx) * t.cruise, y: (ny * 0.8 + sy) * t.cruise };
}

/**
 * Bot for one seat. Each tick it picks the nozzle angle whose push best serves the crew's
 * shared goal (move toward the gate, keep the nose pointed there) given where its seat sits.
 * Bots don't talk to each other: they converge because they all read the same snapshot.
 */
export function botSource(
  seatIndex: number,
  seats: readonly Seat[],
  level: LevelData,
  observe: () => Snapshot,
  tuning: BotTuning = DEFAULT_TUNING,
): InputSource {
  const seat = seats[seatIndex]!;
  const walls = levelWalls(level);
  const route = level.channel ? sampleChannel(level.channel) : null;
  let last: Snapshot | undefined;
  let aim = 0;
  let resting = false;
  let slowFor = 0;
  let escapeLeft = 0;

  return {
    read(): SeatInput {
      const snap = observe();
      const prev = last?.tick === snap.tick - 1 ? last : undefined;
      last = snap;
      if (snap.phase.kind !== "racing") return IDLE_INPUT;
      const gate = level.checkpoints[snap.phase.nextCheckpoint];
      if (!gate) return IDLE_INPUT;

      const { raft } = snap;
      const target = route ? pointAt(route, nearestS(route, raft) + ROUTE_LOOKAHEAD) : gate;
      const vel = prev
        ? { x: (raft.x - prev.raft.x) / STEP, y: (raft.y - prev.raft.y) / STEP }
        : { x: 0, y: 0 };
      const spin = prev ? wrap(raft.rot - prev.raft.rot) / STEP : 0;

      // Stuck against a rock or bank: steering toward the gate keeps pinning us there.
      if (escapeLeft > 0) escapeLeft -= STEP;
      else if (prev && Math.hypot(vel.x, vel.y) < STUCK_SPEED) {
        slowFor += STEP;
        if (slowFor > STUCK_AFTER) {
          escapeLeft = ESCAPE_FOR;
          slowFor = 0;
        }
      } else slowFor = 0;

      const escaping = escapeLeft > 0;
      const force = escaping
        ? escapeForce(walls, snap, target, tuning)
        : desiredForce(walls, snap, vel, target, tuning);
      const fLen = Math.hypot(force.x, force.y);
      const headingErr = wrap(Math.atan2(force.y, force.x) - raft.rot);
      // While escaping, just translate: turning against a bank only pins the raft harder,
      // since one side of it can't move.
      const torqueWant = escaping ? 0 : headingErr * tuning.headingGain - spin * tuning.spinDamping;

      // Seat offset in world space: pushes there also turn the raft (torque = r × F).
      const c = Math.cos(raft.rot);
      const s = Math.sin(raft.rot);
      const rx = seat.x * c - seat.y * s;
      const ry = seat.x * s + seat.y * c;

      let bestAim = 0;
      let bestScore = -Infinity;
      for (let k = 0; k < AIM_SAMPLES; k++) {
        const a = -AIM_LIMIT + (2 * AIM_LIMIT * k) / (AIM_SAMPLES - 1);
        const fx = Math.cos(raft.rot + a);
        const fy = Math.sin(raft.rot + a);
        const along = fLen > 0 ? (fx * force.x + fy * force.y) / fLen : 0;
        const torque = rx * fy - ry * fx;
        const score = along + torque * clamp(torqueWant, -1, 1);
        if (score > bestScore) {
          bestScore = score;
          bestAim = a;
        }
      }

      // Swing the nozzle at the same speed a human can.
      const maxSwing = AIM_SPEED * STEP;
      aim += clamp(bestAim - aim, -maxSwing, maxSwing);

      const gas = (snap.gas[seatIndex] ?? 0) / GAS_MAX;
      if (gas < GAS_RESERVE) resting = true;
      else if (gas > GAS_RESUME) resting = false;

      const helps = bestScore > MIN_SCORE || Math.abs(torqueWant) > MUST_TURN;
      return { thrust: !resting && helps, aim };
    },
  };
}
