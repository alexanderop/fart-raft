import { CURRENT_SPEED, RAFT_HULL, STEP, TICK_RATE, type Zone } from "../sim/constants.ts";
import { hazardBoxes as boxesOf } from "../sim/hazards/index.ts";
import { hazardTime } from "../sim/hazards/shape.ts";
import { clampToZone } from "../sim/raft.ts";
import { levelWalls, pointAt, sampleChannel } from "../sim/channel.ts";
import {
  IDLE_INPUT,
  type Box,
  type LevelData,
  type SeatInput,
  type Snapshot,
  type Vec2,
} from "../sim/types.ts";
import {
  holdRuns,
  LANE_CLEAR_AHEAD,
  makeFrame,
  planCrossing,
  type Crossing,
  type Frame,
} from "./crossing.ts";
import { awayFromBox, clamp, distToBox } from "./geometry.ts";
import type { InputSource } from "./sources.ts";

// A bot is just another InputSource: it reads the same Snapshot every client (and later the
// server) has, and answers with a SeatInput. No DOM, no Rapier, so it runs headless on a server.

export type BotTuning = {
  cruise: number; // target speed, m/s
  avoidRange: number; // start steering away from walls this close (m)
  avoidLookahead: number; // also probe where we'll be in this many seconds
  hazardRange: number; // start steering away from a hazard bar this close (m): a hit costs a life
};

/** Picked by sweeping crews of 1–4 on the pond: every crew finishes, the slowest in ≈ 45 s. */
export const DEFAULT_TUNING: BotTuning = {
  cruise: 9,
  avoidRange: 3,
  avoidLookahead: 0.7,
  hazardRange: 6,
};
/** Fart when the push points within ~45° of where the crew wants to go. */
const MIN_ALIGN = 0.7;
/** Closer than this (radians) to the chosen spot counts as there. */
const ARRIVED = 0.05;

type Vec = Vec2;

/** The latest crossing plan per level: the bots of one crew share it, see below. */
const sharedPlans = new WeakMap<LevelData, { snap: Snapshot; crossing: Crossing | null }>();

/**
 * A crew that gains less than STALL_PROGRESS m in STALL_TICKS has waited too long: for the next
 * FORCED_GO_TICKS it goes full speed whatever the plan says.
 */
const STALL_PROGRESS = 1;
const STALL_TICKS = 25 * TICK_RATE;
const FORCED_GO_TICKS = 4 * TICK_RATE;

/** The crossing plan is worked out again this often: the bars move on a schedule, so it changes slowly. */
const REPLAN_TICKS = 5;
/**
 * Speeds (m/s) over the ground the crossing planner assumes. Measured on the pond and the
 * canyon, every crew size sustains ≈ 4 m/s: gas, not the number of riders, is what limits it.
 * A raft coasts to a halt in still water but a current keeps it moving, so a crawl there is
 * faster than the current. Backing off is slower than going ahead.
 */
const PACE_FAST = 7;
const PACE_CRAWL = 1.5;
const PACE_BACK = -1.5;

/** Crossing a hazard, the bot slides into its lane at this speed per metre to go, up to LANE_SPEED m/s. */
const LANE_GAIN = 1.2;
const LANE_SPEED = 2.5;

/** On a channel course, steer at the centerline this far ahead instead of straight at the gate. */
const ROUTE_LOOKAHEAD = 9;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Where each hazard is right now, as a box. The crossing planner steers the one it is working
 * on (`except`), so that one is left out: avoiding it as well would fight the dash.
 */
function hazardBoxes(level: LevelData, snap: Snapshot, except: readonly string[] = []): Box[] {
  return level.hazards
    .filter((h) => !except.includes(h.id))
    .flatMap((h) => boxesOf(h, hazardTime(snap.difficulty, snap.tick, h.kind)));
}

/** Is the lane `lat` free of rocks and banks for `until` metres ahead of arc length `s`? */
function clearLane(frame: Frame, s: number, lat: number, until: number): boolean {
  for (let ahead = 0; ahead <= until; ahead += 2) {
    const p = frame.at(s + ahead, lat);
    if (frame.walls.some((w) => distToBox(w, p) < RAFT_HULL - 0.3)) return false;
  }
  return true;
}

/** Desired push direction in world space: toward the next gate, away from walls, minus drift. */
function desiredForce(
  walls: readonly Box[],
  hazards: readonly Box[],
  snap: Snapshot,
  vel: Vec,
  target: Vec,
  t: BotTuning,
  /** The velocity to hold: set while crossing a hazard (see the crossing plan), else toward `target` at cruise speed. */
  hold: Vec | null,
): Vec {
  const { raft } = snap;
  const tx = target.x - raft.x;
  const ty = target.y - raft.y;
  const tLen = Math.hypot(tx, ty) || 1;
  let wantX = hold ? hold.x : (tx / tLen) * t.cruise;
  let wantY = hold ? hold.y : (ty / tLen) * t.cruise;

  // Avoidance only deflects sideways. If it could also push back against the goal, the two
  // would cancel in front of a rock and the bot would sit there forever (potential-field trap).
  const gx = tx / tLen;
  const gy = ty / tLen;
  const probes = [
    raft,
    { x: raft.x + vel.x * t.avoidLookahead, y: raft.y + vel.y * t.avoidLookahead },
  ];
  const obstacles = [
    ...walls.map((box) => ({ box, range: t.avoidRange })),
    ...hazards.map((box) => ({ box, range: t.hazardRange })),
  ];
  for (const { box, range } of obstacles) {
    for (const p of probes) {
      const away = awayFromBox(box, p);
      if (away.dist >= range || away.dist === 0) continue;
      const push = ((range - away.dist) / range) * t.cruise * 1.5;
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
 * Bot for one seat. Each tick it works out the push the crew needs (toward the next gate, away
 * from walls, minus drift), slides around the ring to the spot in its arc opposite that push,
 * and farts when the push it would give lines up. Bots don't talk to each other: they converge
 * because they all read the same snapshot.
 */
export function botSource(
  seatIndex: number,
  zones: readonly Zone[],
  level: LevelData,
  observe: () => Snapshot,
  tuning: BotTuning = DEFAULT_TUNING,
): InputSource {
  const zone = zones[seatIndex]!;
  const walls = levelWalls(level);
  const route = level.channel ? sampleChannel(level.channel) : null;
  const frame = makeFrame(level, route);
  const current = route ? CURRENT_SPEED : 0;
  const paces = {
    fast: PACE_FAST,
    slow: Math.max(PACE_CRAWL, current + 0.5),
    back: PACE_BACK,
    still: current === 0,
  };
  let last: Snapshot | undefined;
  let crossing: Crossing | null = null;
  let plannedAt = -Infinity;
  let bestS = -Infinity;
  let progressAt = 0;
  let goUntil = 0;
  let slowFor = 0;
  let escapeLeft = 0;

  return {
    read(): SeatInput {
      const snap = observe();
      // The tick before a respawn is the far side of a teleport: no use for a velocity.
      const prev = last?.tick === snap.tick - 1 && last.respawnIn === 0 ? last : undefined;
      last = snap;
      if (snap.phase.kind !== "racing") return IDLE_INPUT;
      // Wiped out: nothing to do until the raft is back at its gate, then start over from there.
      if (snap.respawnIn > 0) {
        crossing = null;
        plannedAt = -Infinity;
        bestS = -Infinity;
        progressAt = snap.tick;
        goUntil = slowFor = escapeLeft = 0;
        return IDLE_INPUT;
      }
      const gate = level.checkpoints[snap.phase.nextCheckpoint];
      const rider = snap.riders[seatIndex];
      if (!gate || !rider) return IDLE_INPUT;

      const { raft } = snap;
      const vel = prev
        ? { x: (raft.x - prev.raft.x) / STEP, y: (raft.y - prev.raft.y) / STEP }
        : { x: 0, y: 0 };
      const here = frame.locate(raft);
      // A hazard ahead: aim for the lane and pace the crossing planner picked.
      if (snap.tick - plannedAt >= REPLAN_TICKS || snap.tick < plannedAt) {
        const elapsed = (snap.tick - plannedAt) * STEP;
        plannedAt = snap.tick;
        const base = frame.at(here.s, here.lat);
        const ahead = frame.at(here.s + 1, here.lat);
        const along = vel.x * (ahead.x - base.x) + vel.y * (ahead.y - base.y);
        // The crew's bots all read the same snapshot, so one of them plans for all.
        const shared = sharedPlans.get(level);
        if (shared?.snap === snap) crossing = shared.crossing;
        else {
          const keep = crossing
            ? {
                lat: crossing.lat,
                pace: crossing.pace,
                // The hold only runs down once the crew is at its launch point.
                holdFor: Math.max(0, crossing.holdFor - (holdRuns(crossing.gap) ? elapsed : 0)),
              }
            : null;
          crossing = planCrossing(level, frame, snap, paces, along, keep);
          sharedPlans.set(level, { snap, crossing });
        }
      }
      // A crew that waits for the right moment and never finds it gives up waiting and goes.
      if (here.s > bestS + STALL_PROGRESS) {
        bestS = here.s;
        progressAt = snap.tick;
      } else if (snap.tick - progressAt > STALL_TICKS) {
        progressAt = snap.tick;
        goUntil = snap.tick + FORCED_GO_TICKS;
      }
      if (crossing && snap.tick < goUntil) crossing = { ...crossing, pace: paces.fast, holdFor: 0 };
      const plan = crossing;
      const target = plan
        ? frame.at(here.s + ROUTE_LOOKAHEAD, plan.lat)
        : route
          ? pointAt(route, here.s + ROUTE_LOOKAHEAD)
          : gate;

      // Stuck against a rock or bank: steering toward the gate keeps pinning us there. A crew
      // holding still on purpose, waiting for a hazard to come round, is not stuck.
      const waiting = plan !== null && plan.holdFor > 0 && Math.abs(plan.pace) < STUCK_SPEED;
      if (escapeLeft > 0) escapeLeft -= STEP;
      else if (prev && !waiting && Math.hypot(vel.x, vel.y) < STUCK_SPEED) {
        slowFor += STEP;
        if (slowFor > STUCK_AFTER) {
          escapeLeft = ESCAPE_FOR;
          slowFor = 0;
        }
      } else slowFor = 0;

      // Crossing a hazard: the planned pace along the lane, and whatever sideways speed gets into it.
      let hold: Vec | null = null;
      if (plan) {
        const lane = frame.at(here.s, plan.lat);
        const ahead = frame.at(here.s + 1, plan.lat);
        const left = frame.at(here.s, plan.lat + 1);
        // It slides into its lane as soon as the way there is clear of rocks; if its own lane
        // leads into one it falls back to the middle of the course.
        const until = Math.min(LANE_CLEAR_AHEAD, Math.max(2, plan.clearEnd));
        const goal = clearLane(frame, here.s, plan.lat, until)
          ? plan.lat
          : clearLane(frame, here.s, here.lat, until)
            ? here.lat
            : 0;
        const side = clamp((goal - here.lat) * LANE_GAIN, -LANE_SPEED, LANE_SPEED);
        hold = {
          x: (ahead.x - lane.x) * plan.pace + (left.x - lane.x) * side,
          y: (ahead.y - lane.y) * plan.pace + (left.y - lane.y) * side,
        };
      }
      const force =
        escapeLeft > 0
          ? escapeForce(walls, snap, target, tuning)
          : desiredForce(
              walls,
              hazardBoxes(level, snap, plan?.ids),
              snap,
              vel,
              target,
              tuning,
              hold,
            );

      // A rider at ring angle `at` pushes toward the center, so the best spot is opposite the
      // wanted force. Slide there along the ring, the short way round.
      const at = Math.atan2(rider.y, rider.x);
      const spot = clampToZone(zone, Math.atan2(-force.y, -force.x) - raft.rot);
      const gap = wrap(spot - at);
      const tangent = raft.rot + at + Math.PI / 2;
      const dir = Math.abs(gap) > ARRIVED ? Math.sign(gap) : 0;
      const move = { x: Math.cos(tangent) * dir, y: Math.sin(tangent) * dir };

      const fLen = Math.hypot(force.x, force.y) || 1;
      const push = raft.rot + at + Math.PI;
      const align = (Math.cos(push) * force.x + Math.sin(push) * force.y) / fLen;
      return { move, fart: align > MIN_ALIGN };
    },
  };
}
