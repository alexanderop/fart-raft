// Generates courses/canyon.json. Rerun after editing the spec: `pnpm course`.
// Five legs: sweepers, a double gate, spinners, a drop gate and a bumper down the winding canyon,
// rapids under a swinging mace, the hammer gauntlet, piston alley, and a minefield before the
// rapids run to the finish under a second mace. Two calm ponds are breathers: one right after
// the start, one between the first leg and spinner-2.
// Checkpoints and hazards are placed by arc length along the channel, so moving a control
// point keeps every gate square to the stream.
import { halfWidthAt } from "../src/sim/channel.ts";
import { HAMMER_ARM, SWEEP_AMPLITUDE } from "../src/sim/constants.ts";
import type { Channel, HazardDef, LevelData } from "../src/sim/types.ts";
import { channelKit, round, writeCourse } from "./course.ts";

const channel: Channel = {
  halfWidth: 7,
  points: [
    { x: -6, y: 0 },
    { x: 42, y: 0 },
    { x: 88, y: 0 },
    { x: 110, y: 18 },
    { x: 110, y: 48 },
    { x: 132, y: 68 },
    { x: 172, y: 68 },
    { x: 194, y: 48 },
    { x: 194, y: 14 },
    { x: 218, y: -6 },
    { x: 262, y: -6 },
    { x: 286, y: 16 },
    { x: 286, y: 50 },
    { x: 308, y: 70 },
    { x: 352, y: 70 },
    { x: 404, y: 70 },
    { x: 484, y: 70 },
    { x: 506, y: 48 },
    { x: 506, y: -6 },
    { x: 528, y: -28 },
    { x: 596, y: -28 },
    { x: 618, y: -6 },
    { x: 618, y: 44 },
    { x: 640, y: 66 },
    { x: 710, y: 66 },
  ],
  spikes: [],
  // Whitewater on two long straights, ending well before the next bend's spikes: the raft
  // shoots through at RAPIDS_SPEED, then the last one carries it over the finish line.
  rapids: [
    { from: 540, to: 590 },
    { from: 896, to: 962 },
  ],
  // Two calm ponds, round pools 2.6× the channel's width with slow water: one right after the
  // start, one on the long run between the canyon's first leg and the rapids.
  ponds: [
    { from: 10, to: 58, halfWidth: 18 },
    { from: 449, to: 497, halfWidth: 18 },
  ],
};

const { samples, length, at, across, gate, outerBends, dropgate, doublegate, mine, mace, boost } =
  channelKit(channel);

/**
 * Hinged on one bank, resting diagonally downstream: it swings between straight across and
 * flat against the bank, and its arm never reaches the far bank, so there is always a gap.
 */
function sweeper(id: string, s: number, side: 1 | -1, speed: number): HazardDef {
  const p = at(s);
  const hw = halfWidthAt(channel, s);
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
  const lat = side * (halfWidthAt(channel, s) + 0.8 - HAMMER_ARM);
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
  const lat = side * (halfWidthAt(channel, s) + hx);
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
/** A rock in a pond: a small island (`isIsland`) of radius `r`, `lat` m left of center at `s`. */
const rock = (s: number, lat: number, r = 1.2) => across(s, r, r, lat);

// Spikes line the outer bank of every bend, where a raft carried by its momentum hits.
channel.spikes = outerBends(0.03);

const start = at(4);
const level: LevelData = {
  name: "canyon",
  spawn: { x: start.x, y: start.y, rot: Math.atan2(start.ty, start.tx) },
  channel,
  // Grey rocks in the ponds: small islands near the shore, well off the racing line.
  walls: [rock(30, 12.5), rock(40, -13), rock(466, -12.5), rock(480, 13)],
  // A gate just past spinner-1, on the gentle run before the spiked bend, so a wipeout at the bend
  // or the log respawns past the spinner instead of in front of it.
  checkpoints: [gate(148), gate(213), gate(288), gate(533), gate(705), gate(805), gate(length - 6)],
  hazards: [
    sweeper("sweeper-1", 74, 1, 1.3),
    // A spiked double gate where the first two bends meet, just before the first checkpoint: its
    // doors swing shut across the channel and open again; slip through while they stand open.
    doublegate("doublegate-1", 136, { phase: 1 }),
    spinner("spinner-1", 195, 1.1),
    // A log rolls from bank to bank on the straight before the second half: the raft slips past
    // behind it or ahead of it.
    { ...across(253, 2.4, 1), id: "log-1", kind: "log", speed: 0.7, range: 3 },
    sweeper("sweeper-2", 324, -1, 1.6),
    // A lone drop gate on the calm run before the bumper teaches its timing: wait for it to slam,
    // then dash under it while it rises.
    dropgate("dropgate-1", 358, { phase: 2 }),
    // A pumpkin bumper on the left of the last long run: the raft takes the right lane.
    { ...across(393, 1.5, 1.5, 2.5), id: "bumper-1", kind: "bumper", speed: 2.2 },
    spinner("spinner-2", 515, -1.2),
    // A spiked mace swings bank to bank over the first rapids: it sweeps the water through the
    // middle of each swing and hangs high at either end, so the raft shoots under it on the beat.
    mace("mace-1", 568, { speed: 1.3 }),
    // The hammer gauntlet: three mallets from alternating banks, slamming one after another.
    hammer("hammer-1", 652, 1, 1.4, 0),
    hammer("hammer-2", 668, -1, 1.4, 2.1),
    hammer("hammer-3", 684, 1, 1.4, 4.2),
    // Piston alley: blocks punch out of both banks in turn, the raft weaves between them.
    piston("piston-1", 734, 1, 1.5, 0),
    piston("piston-2", 750, -1, 1.5, 2),
    piston("piston-3", 766, 1, 1.5, 4),
    piston("piston-4", 782, -1, 1.5, 6),
    // The minefield, clear of the bend before it: mines line the right half of the channel, one
    // of them drifting up and down the stream, and the left lane stays open all the way.
    mine("mine-1", 832, -3.6, 0.8),
    mine("mine-2", 846, -3.8, 0.8, { range: 3, speed: 0.7, along: true }),
    mine("mine-3", 860, -3.4, 0.8),
    // A second mace over the rapids run to the finish.
    mace("mace-2", 924, { speed: 1 }),
  ],
  // Boost pads on calm runs, each a good 30 m short of the next hazard so the crew can settle
  // before it, and on the lane that sets up what comes next.
  boosts: [
    // Past the log, on the inside of the bend into the third checkpoint.
    boost(266, 2),
    // Off the end of the first rapids, mid-channel, toward the hammers.
    boost(592, 0),
    // Out of the minefield, inside the last spiked bend, into the rapids to the finish.
    boost(872, -2),
    // Under the last mace, a final kick down the rapids to the finish line.
    boost(940, 0),
  ],
};

writeCourse("canyon", level);
console.log(
  `canyon: ${length.toFixed(1)} m, ${samples.length} samples, spikes ${JSON.stringify(channel.spikes, round)}`,
);
