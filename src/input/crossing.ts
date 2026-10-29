import { levelWalls, nearestS, pointAt, type Sample } from "../sim/channel.ts";
import { hazardRate, RAFT_HULL } from "../sim/constants.ts";
import { hazardBoxes, hazardReach } from "../sim/hazards/index.ts";
import { hazardTime } from "../sim/hazards/shape.ts";
import type { Box, LevelData, Snapshot, Vec2 } from "../sim/types.ts";
import { distToBox } from "./geometry.ts";

// A hazard hit costs a life, so bots do not blunder through a spinner. Hazards move on a fixed
// schedule (the sim runs them from tick 0), so a bot can predict where a hazard will be and plan
// a crossing: which lane, and when. The crew approaches at full speed to a launch point just
// short of the hazard's zone, holds a pace there for a while (a crawl, a stop, even backing off,
// sliding into its lane meanwhile) to let the hazard come round, then goes full speed through.
// The planner follows every candidate (lane, pace, hold) as a path through time past the
// hazard's schedule and takes the one with the most room.

/** A hazard's zone reaches this far (m) past its sweep, beyond the raft's hull. */
const MARGIN = 1.3;
/** Room (m) to the hazard, on top of the raft's hull, that is good enough to stop looking for more. */
const ENOUGH = 0.5;
/** Look for a hazard this far (m) ahead. */
const LOOKAHEAD = 30;
/** Step (s) of a simulated crossing, and how far ahead it looks. */
const DT = 0.1;
const HORIZON = 15;
/** The planner samples the course every CELL metres, from BEHIND metres behind the raft. */
const CELL = 0.5;
const BEHIND = 15;
/** The hazards are checked this much (s) early and late as well, to allow for slips. */
const SLIP = 0.3;

/** The crew holds at a launch point this far (m) short of a hazard's zone. */
export const LAUNCH_GAP = 4;
/** Seconds the crew may hold at its launch point, tried in these steps. */
const MAX_HOLD = 6;
const HOLD_STEP = 0.5;
/** Within this distance (m) of a zone the crew plans to hold; further out it just approaches. */
const WAIT_RANGE = 16;
/** Only a raft this close (m) to a zone, or in it, may back off to wait for a gap, unless the water is still. */
const BACK_OFF_RANGE = 3;

/**
 * The crew slides into its lane at most SLIDE_SPEED m/s sideways, once the lane is clear of rocks
 * for LANE_CLEAR_AHEAD m (or until the hazard is behind); before that it goes its own way round
 * whatever is in the way. The bot and the planner share the rule.
 */
const SLIDE_SPEED = 2.5;
export const LANE_CLEAR_AHEAD = 20;
/** The crew keeps this far (m) off a spiked bank. */
const SPIKE_GAP = 0.8;

/** The raft settles at a pace with this time constant, s. */
const RESPONSE = 0.7;
/** Preferences, in metres of room: be quick, be straight, and keep to the plan already followed. */
const HOLD_COST = 0.2;
const SHIFT_COST = 0.03;
const KEEP = 0.4;

/** Does a hold run down yet? A crew only holds at its launch point. */
export const holdRuns = (gap: number): boolean => gap <= LAUNCH_GAP;

/** A coordinate system along the course: `s` metres downstream, `lat` metres to the left. */
export type Frame = {
  at(s: number, lat: number): Vec2;
  /** The centerline at `s` with its left normal: `at(s, lat)` is `(x, y) + lat · (nx, ny)`. */
  line(s: number): { x: number; y: number; nx: number; ny: number };
  locate(p: Vec2): { s: number; lat: number };
  /**
   * How far left and right of the centerline (m) the raft may take a lane between arc lengths
   * `from` and `to`: up to the banks, but keeping off spiked ones.
   */
  reach(from: number, to: number): { left: number; right: number };
  /** Extra obstacles to keep off (the walls of a course without a channel). */
  walls: readonly Box[];
};

export function makeFrame(level: LevelData, route: readonly Sample[] | null): Frame {
  if (route) {
    return {
      at(s, lat) {
        const c = pointAt(route, s);
        return { x: c.x + c.nx * lat, y: c.y + c.ny * lat };
      },
      line: (s) => pointAt(route, s),
      locate(p) {
        const s = nearestS(route, p);
        const c = pointAt(route, s);
        return { s, lat: (p.x - c.x) * c.nx + (p.y - c.y) * c.ny };
      },
      reach(from, to) {
        const room = Math.max(0, level.channel!.halfWidth - RAFT_HULL);
        const spiked = (side: "left" | "right") =>
          level.channel!.spikes.some((sp) => sp.side === side && sp.from < to && sp.to > from);
        return {
          left: spiked("left") ? Math.max(0, room - SPIKE_GAP) : room,
          right: spiked("right") ? Math.max(0, room - SPIKE_GAP) : room,
        };
      },
      walls: levelWalls({ ...level, channel: null }),
    };
  }
  // Open water: one straight axis from the spawn to the last gate.
  const gate = level.checkpoints[level.checkpoints.length - 1]!;
  const dx = gate.x - level.spawn.x;
  const dy = gate.y - level.spawn.y;
  const len = Math.hypot(dx, dy) || 1;
  const ax = dx / len;
  const ay = dy / len;
  return {
    at: (s, lat) => ({
      x: level.spawn.x + ax * s - ay * lat,
      y: level.spawn.y + ay * s + ax * lat,
    }),
    line: (s) => ({ x: level.spawn.x + ax * s, y: level.spawn.y + ay * s, nx: -ay, ny: ax }),
    locate: (p) => ({
      s: (p.x - level.spawn.x) * ax + (p.y - level.spawn.y) * ay,
      lat: -(p.x - level.spawn.x) * ay + (p.y - level.spawn.y) * ax,
    }),
    reach: () => ({ left: 5.5, right: 5.5 }),
    walls: levelWalls({ ...level, channel: null }),
  };
}

export type Crossing = {
  /** The hazards this plan is about: the next one and any whose zone overlaps its. */
  ids: string[];
  /** The lane to take past it, `lat` metres left of the centerline. */
  lat: number;
  /** The speed over the ground to hold right now, m/s: slow, stopped or even negative while the hazard comes round. */
  pace: number;
  /** Seconds the crew keeps to that pace before it speeds up (0 once it should be going full speed). */
  holdFor: number;
  /** Metres to the hazard's zone (≤ 0 once inside it). */
  gap: number;
  /** Metres ahead beyond which the hazards are behind the raft: the lane need only be clear until then. */
  clearEnd: number;
  /** The room (m) this plan expects to keep to the hazard; below the hull plus margin it is a gamble. */
  room: number;
};

export type CrossingPaces = {
  /** The speeds over the ground the crew holds: at best, at a crawl, and backing off, m/s. */
  fast: number;
  slow: number;
  back: number;
  /** No current: a raft that stops thrusting coasts to a halt. */
  still: boolean;
};

/**
 * What to do about the next hazard on the way, or null if none is close. `along` is the raft's
 * speed along the course now; `keep` the lane and pace the crew follows already.
 */
export function planCrossing(
  level: LevelData,
  frame: Frame,
  snap: Snapshot,
  paces: CrossingPaces,
  along = 0,
  keep: { lat: number; pace: number; holdFor: number } | null = null,
): Crossing | null {
  const me = frame.locate(snap.raft);
  const zones = level.hazards.map((def) => {
    const half = hazardReach(def) + RAFT_HULL + MARGIN;
    return { def, at: frame.locate(def).s - me.s, half };
  });
  let next: (typeof zones)[number] | undefined;
  for (const zone of zones) {
    if (zone.at + zone.half < 0 || zone.at - zone.half > LOOKAHEAD) continue;
    if (!next || zone.at < next.at) next = zone;
  }
  if (!next) return null;

  // Hazards whose zones overlap the next one's are crossed together: a row of pumpkins is one hazard.
  const group = [next];
  for (let grew = true; grew;) {
    grew = false;
    for (const zone of zones) {
      if (group.includes(zone) || zone.at + zone.half < 0) continue;
      const touches = group.some(
        (g) => zone.at - zone.half < g.at + g.half && g.at - g.half < zone.at + zone.half,
      );
      if (touches) {
        group.push(zone);
        grew = true;
      }
    }
  }
  const zoneStart = Math.min(...group.map((g) => g.at - g.half)); // metres ahead where its zone begins
  const end = Math.max(...group.map((g) => g.at + g.half)); // and where it ends
  const need = RAFT_HULL + ENOUGH;
  const clearEnd = end - RAFT_HULL - MARGIN; // metres ahead beyond which the hazards are behind the raft

  // The hazard at every step of a simulated crossing, on time, early and late.
  const steps = Math.ceil(HORIZON / DT) + 1;
  const slips = [0, -SLIP, SLIP];
  // Each hazard's time now, and how much of it passes per real second of the crossing.
  const clocks = group.map((g) => ({
    def: g.def,
    now: hazardTime(snap.difficulty, snap.tick, g.def.kind),
    rate: hazardRate(snap.difficulty, g.def.kind),
  }));
  const boxes = Array.from({ length: steps }, (_, k) =>
    clocks.flatMap(({ def, now, rate }) =>
      slips.flatMap((slip) => hazardBoxes(def, now + (k * DT + slip) * rate)),
    ),
  );

  // The centerline sampled every CELL metres from BEHIND metres back, so a candidate path is a
  // table lookup instead of a search along the channel for every step.
  const cells = Math.ceil((BEHIND + end + 10) / CELL) + 2;
  const table = Array.from({ length: cells }, (_, i) => frame.line(me.s - BEHIND + i * CELL));
  const point = (x: number, lat: number): Vec2 => {
    const f = (x + BEHIND) / CELL;
    const i = Math.max(0, Math.min(cells - 2, Math.floor(f)));
    const u = f - i;
    const a = table[i]!;
    const b = table[i + 1]!;
    return {
      x: a.x + (b.x - a.x) * u + (a.nx + (b.nx - a.nx) * u) * lat,
      y: a.y + (b.y - a.y) * u + (a.ny + (b.ny - a.ny) * u) * lat,
    };
  };

  // The crew slides into a lane once the way there is clear of rocks (the bot's `clearLane`):
  // the first metre ahead of the raft from which the lane stays clear, by lane.
  const slideAt = new Map<number, number>();
  const slideFrom = (lat: number): number => {
    const known = slideAt.get(lat);
    if (known !== undefined) return known;
    let from = Infinity;
    for (let x0 = 0; x0 <= Math.max(0, zoneStart) && from === Infinity; x0 += 1) {
      const until = Math.min(LANE_CLEAR_AHEAD, Math.max(2, clearEnd - x0));
      let clear = true;
      for (let a = 0; a <= until && clear; a += 2) {
        const p = point(x0 + a, lat);
        clear = !frame.walls.some((w) => distToBox(w, p) < RAFT_HULL - 0.3);
      }
      if (clear) from = x0;
    }
    slideAt.set(lat, from);
    return from;
  };

  // The crew approaches at full speed to its launch point, LAUNCH_GAP m short of the zone, and
  // only there holds its pace (sliding into its lane meanwhile) before it goes.
  const xLaunch = Math.max(0, zoneStart - LAUNCH_GAP);

  /** Room (m) left to the hazard and the walls along a crossing in `lat` that, at the launch point, holds `pace` for `holdFor` s, then goes full speed. */
  const room = (lat: number, pace: number, holdFor: number, floor: number): number => {
    let x = 0;
    let v = along;
    let slide = 0; // metres slid sideways so far
    let held = -1; // when the raft reached its launch point
    const from = slideFrom(lat);
    let worst = Infinity;
    for (let k = 0; k < steps; k++) {
      const t = k * DT;
      if (held < 0 && x >= xLaunch) held = t;
      if (x >= from) slide += SLIDE_SPEED * DT;
      const sideways = Math.max(-slide, Math.min(slide, lat - me.lat));
      const p = point(x, me.lat + sideways);
      // In the hazard's zone the crew must not scrape a wall or a rock (on the way in the bot
      // steers round them as it goes).
      if (
        x >= zoneStart &&
        x <= clearEnd &&
        frame.walls.some((w) => distToBox(w, p) < RAFT_HULL - 0.3)
      )
        return -Infinity;
      for (const bar of boxes[k]!) {
        worst = Math.min(worst, distToBox(bar, p));
        if (worst < floor) return -Infinity; // cannot beat the best so far
      }
      if (x > end) return worst;
      const goal = held >= 0 && t - held < holdFor ? pace : paces.fast;
      v += ((goal - v) * DT) / RESPONSE;
      x += v * DT;
    }
    return -Infinity; // never got through in time: the worst crossing of all
  };

  const reach = frame.reach(me.s - 5, me.s + end + 5);
  const lanes = [-reach.right, -reach.right / 2, 0, reach.left / 2, reach.left].concat(me.lat);
  if (keep) lanes.push(keep.lat);
  // Each plan is a pace to hold for a while, then full speed. The one the crew follows already
  // (with the time it has left) gets a bonus: otherwise it would hold for the next window,
  // then the next, and never go.
  // Far from the hazard there is nothing to wait for yet: only the near approach is timed.
  const timed = zoneStart <= WAIT_RANGE;
  // Backing off is for a raft already in the zone, or one in still water that must brake to wait:
  // against a current, waiting means coasting or crawling.
  const pacesTried = [0, paces.slow, (paces.slow + paces.fast) / 2, paces.fast];
  if (paces.still || zoneStart < BACK_OFF_RANGE) pacesTried.unshift(paces.back);
  const plans = pacesTried.flatMap((pace) =>
    Array.from(
      { length: pace === paces.fast || !timed ? 1 : Math.round(MAX_HOLD / HOLD_STEP) + 1 },
      (_, i) => ({
        pace,
        holdFor: pace === paces.fast || !timed ? 0 : i * HOLD_STEP,
      }),
    ),
  );
  if (keep) plans.push({ pace: keep.pace, holdFor: keep.holdFor });
  let best = { score: -Infinity, lat: me.lat, pace: paces.fast, holdFor: 0, room: -Infinity };
  for (const { pace, holdFor } of plans) {
    for (const lat of lanes) {
      const same =
        keep &&
        Math.abs(lat - keep.lat) < 0.01 &&
        Math.abs(pace - keep.pace) < 0.01 &&
        Math.abs(holdFor - keep.holdFor) < 0.01;
      const cost = SHIFT_COST * Math.abs(lat - me.lat) + HOLD_COST * holdFor - (same ? KEEP : 0);
      const floor = Math.min(best.score + cost, need);
      const clear = room(lat, pace, holdFor, floor);
      const score = Math.min(clear, need) - cost;
      if (score > best.score) best = { score, lat, pace, holdFor, room: clear };
    }
  }
  return {
    ids: group.map((g) => g.def.id),
    lat: best.lat,
    pace: zoneStart > LAUNCH_GAP || best.holdFor <= 0 ? paces.fast : best.pace,
    holdFor: best.holdFor,
    gap: zoneStart,
    clearEnd,
    room: best.room,
  };
}
