// Generates courses/canyon.json. Rerun after editing the spec: `pnpm course`.
// Checkpoints and hazards are placed by arc length along the channel, so moving a control
// point keeps every gate square to the stream.
import { SWEEP_AMPLITUDE } from "../src/sim/constants.ts";
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
  ],
  spikes: [],
};

const { samples, length, at, across, gate, outerBends } = channelKit(channel);

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

// Spikes line the outer bank of every bend, where a raft carried by its momentum hits.
channel.spikes = outerBends(0.03);

const start = at(4);
const level: LevelData = {
  name: "canyon",
  spawn: { x: start.x, y: start.y, rot: Math.atan2(start.ty, start.tx) },
  channel,
  walls: [],
  checkpoints: [gate(100), gate(240), gate(length - 6)],
  hazards: [
    sweeper("sweeper-1", 26, 1, 1.3),
    { ...across(147, 3.6, 0.4), id: "spinner-1", kind: "spinner", speed: 1.1 },
    // A log rolls from bank to bank on the straight before the second half: the raft slips past
    // behind it or ahead of it.
    { ...across(205, 2.4, 1), id: "log-1", kind: "log", speed: 0.7, range: 3 },
    sweeper("sweeper-2", 276, -1, 1.6),
    // A pumpkin bumper on the left of the last long run: the raft takes the right lane.
    { ...across(345, 1.5, 1.5, 2.5), id: "bumper-1", kind: "bumper", speed: 2.2 },
    { ...across(length - 26, 3.6, 0.4), id: "spinner-2", kind: "spinner", speed: -1.4 },
  ],
};

writeCourse("canyon", level);
console.log(
  `canyon: ${length.toFixed(1)} m, ${samples.length} samples, spikes ${JSON.stringify(channel.spikes, round)}`,
);
