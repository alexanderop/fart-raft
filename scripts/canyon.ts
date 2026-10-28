// Generates courses/canyon.json. Rerun after editing the spec: `pnpm course`.
// Five legs: sweepers, spinners, a drop gate and a bumper down the winding canyon, rapids, the hammer
// gauntlet, piston alley, and a minefield before the rapids run to the finish.
// Checkpoints and hazards are placed by arc length along the channel, so moving a control
// point keeps every gate square to the stream.
import { HAMMER_ARM, SWEEP_AMPLITUDE } from "../src/sim/constants.ts";
import type { Channel, HazardDef, LevelData } from "../src/sim/types.ts";
import { channelKit, round, writeCourse } from "./course.ts";

const channel: Channel = {
  halfWidth: 7,
  points: [
    { x: -6, y: 0 },
    { x: 40, y: 0 },
    { x: 62, y: 18 },
    { x: 62, y: 48 },
    { x: 84, y: 68 },
    { x: 124, y: 68 },
    { x: 146, y: 48 },
    { x: 146, y: 14 },
    { x: 170, y: -6 },
    { x: 214, y: -6 },
    { x: 238, y: 16 },
    { x: 238, y: 50 },
    { x: 260, y: 70 },
    { x: 304, y: 70 },
    { x: 384, y: 70 },
    { x: 406, y: 48 },
    { x: 406, y: -6 },
    { x: 428, y: -28 },
    { x: 496, y: -28 },
    { x: 518, y: -6 },
    { x: 518, y: 44 },
    { x: 540, y: 66 },
    { x: 610, y: 66 },
  ],
  spikes: [],
  // Whitewater on two long straights, ending well before the next bend's spikes: the raft
  // shoots through at RAPIDS_SPEED, then the last one carries it over the finish line.
  rapids: [
    { from: 440, to: 490 },
    { from: 796, to: 862 },
  ],
};

const { samples, length, at, across, gate, outerBends, dropgate, mine } = channelKit(channel);

/**
 * Hinged on one bank, resting diagonally downstream: it swings between straight across and
 * flat against the bank, and its arm never reaches the far bank, so there is always a gap.
 */
function sweeper(id: string, s: number, side: 1 | -1, speed: number): HazardDef {
  const p = at(s);
  const hw = channel.halfWidth;
  return {
    id,
    kind: "sweeper",
    x: p.x + p.nx * hw * side,
    y: p.y + p.ny * hw * side,
    rot: Math.atan2(-p.ny * side, -p.nx * side) + side * SWEEP_AMPLITUDE,
    hx: hw * 0.5,
    hy: 0.4,
    speed,
  };
}

/**
 * A hammer on the `side` bank (1 = left), its arm reaching across the channel: it slams down on
 * the near half and leaves a lane along the far bank.
 */
function hammer(id: string, s: number, side: 1 | -1, speed: number, phase: number): HazardDef {
  const p = at(s);
  const lat = side * (channel.halfWidth + 0.8 - HAMMER_ARM);
  return {
    id,
    kind: "hammer",
    x: p.x + p.nx * lat,
    y: p.y + p.ny * lat,
    rot: Math.atan2(-p.ny * side, -p.nx * side),
    hx: 1.2,
    hy: 1.5,
    speed,
    phase,
  };
}

/** A piston resting in the `side` bank (1 = left) that punches `range` m across the channel. */
function piston(id: string, s: number, side: 1 | -1, speed: number, phase: number): HazardDef {
  const p = at(s);
  const hx = 1.2;
  const lat = side * (channel.halfWidth + hx);
  return {
    id,
    kind: "piston",
    x: p.x + p.nx * lat,
    y: p.y + p.ny * lat,
    rot: Math.atan2(-p.ny * side, -p.nx * side),
    hx,
    hy: 1.6,
    range: 6,
    speed,
    phase,
  };
}

const SPINNER_OFFSET = 1;

/**
 * A spinner whose 5.2 m bar turns about a hub SPINNER_OFFSET m off the centerline, toward the bank
 * its bar sweeps upstream. On the other side, where the bar swings downstream with the raft, the
 * lane along the bank is open for over half of every half-turn: a straight run gets through.
 * (A centered bar shuts that lane for 70% of the turn however short it is: what blocks the
 * 5.6 m hull is the hub end of the bar, not its tip.)
 */
function spinner(id: string, s: number, speed: number): HazardDef {
  const side = speed > 0 ? 1 : -1; // counter-clockwise sweeps upstream on the left bank
  return { ...across(s, 2.6, 0.4, side * SPINNER_OFFSET), id, kind: "spinner", speed };
}
// Spikes line the outer bank of every bend, where a raft carried by its momentum hits.
channel.spikes = outerBends(0.03);

const start = at(4);
const level: LevelData = {
  name: "canyon",
  spawn: { x: start.x, y: start.y, rot: Math.atan2(start.ty, start.tx) },
  channel,
  walls: [],
  // A gate just past spinner-1, on the gentle run before the spiked bend, so a wipeout at the bend
  // or the log respawns past the spinner instead of in front of it.
  checkpoints: [gate(100), gate(165), gate(240), gate(433), gate(605), gate(705), gate(length - 6)],
  hazards: [
    sweeper("sweeper-1", 26, 1, 1.3),
    spinner("spinner-1", 147, 1.1),
    // A log rolls from bank to bank on the straight before the second half: the raft slips past
    // behind it or ahead of it.
    { ...across(205, 2.4, 1), id: "log-1", kind: "log", speed: 0.7, range: 3 },
    sweeper("sweeper-2", 276, -1, 1.6),
    // A lone drop gate on the calm run before the bumper teaches its timing: wait for it to slam,
    // then dash under it while it rises.
    dropgate("dropgate-1", 310, { phase: 2 }),
    // A pumpkin bumper on the left of the last long run: the raft takes the right lane.
    { ...across(345, 1.5, 1.5, 2.5), id: "bumper-1", kind: "bumper", speed: 2.2 },
    spinner("spinner-2", 415, -1.2),
    // The hammer gauntlet: three mallets from alternating banks, slamming one after another.
    hammer("hammer-1", 552, 1, 1.4, 0),
    hammer("hammer-2", 568, -1, 1.4, 2.1),
    hammer("hammer-3", 584, 1, 1.4, 4.2),
    // Piston alley: blocks punch out of both banks in turn, the raft weaves between them.
    piston("piston-1", 634, 1, 1.5, 0),
    piston("piston-2", 650, -1, 1.5, 2),
    piston("piston-3", 666, 1, 1.5, 4),
    piston("piston-4", 682, -1, 1.5, 6),
    // The minefield, clear of the bend before it: mines line the right half of the channel, one
    // of them drifting up and down the stream, and the left lane stays open all the way.
    mine("mine-1", 732, -3.6, 0.8),
    mine("mine-2", 746, -3.8, 0.8, { range: 3, speed: 0.7, along: true }),
    mine("mine-3", 760, -3.4, 0.8),
  ],
};

writeCourse("canyon", level);
console.log(
  `canyon: ${length.toFixed(1)} m, ${samples.length} samples, spikes ${JSON.stringify(channel.spikes, round)}`,
);
