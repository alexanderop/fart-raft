// Generates courses/graveyard.json. Rerun after editing the spec: `pnpm graveyard`.
// A spooky course on wide, slow pools: octagon islands (thick `walls`) split the water into
// lanes, and the new hazards guard them: rolling spiked logs, pumpkin bumpers and one witch's
// mill. Everything is placed by arc length along the channel (see scripts/course.ts).
import type { Box, Channel, HazardDef, LevelData } from "../src/sim/types.ts";
import { channelKit, round, writeCourse } from "./course.ts";

const channel: Channel = {
  halfWidth: 13,
  points: [
    { x: -6, y: 0 },
    { x: 46, y: 0 },
    { x: 92, y: 26 },
    { x: 140, y: 26 },
    { x: 184, y: -6 },
    { x: 232, y: -6 },
    { x: 276, y: 20 },
    { x: 276, y: 66 },
    { x: 312, y: 98 },
    { x: 360, y: 98 },
    { x: 400, y: 70 },
  ],
  spikes: [],
};

const { samples, length, at, across, gate, outerBends } = channelKit(channel);

/** An octagon island of radius `r` at arc length `s`, `lat` m left of the centerline. */
function island(s: number, lat: number, r: number, turn = 0.4): Box {
  const box = across(s, r, r, lat);
  return { ...box, rot: box.rot + turn };
}

/** A log rolling across the channel on the straight at `s`: it runs `range` m either side of the centerline. */
function log(id: string, s: number, range: number, speed: number, phase: number): HazardDef {
  return { ...across(s, 2.4, 1), id, kind: "log", speed, range, phase };
}

/** A pumpkin bumper of radius `r` at arc length `s`, `lat` m left of the centerline. */
function bumper(id: string, s: number, lat: number, speed: number, r = 1.5, phase = 0): HazardDef {
  return { ...across(s, r, r, lat), id, kind: "bumper", speed, phase };
}

// Spikes: the bone fence along the outer bank of the sharpest bends only, the pools are roomy.
channel.spikes = outerBends(0.022, 6);

const start = at(4);
const level: LevelData = {
  name: "graveyard",
  spawn: { x: start.x, y: start.y, rot: Math.atan2(start.ty, start.tx) },
  channel,
  walls: [
    // The stone garden: islands left and right of the way in, a clear lane down the middle.
    island(48, -8, 3.4),
    island(62, 8.5, 3),
    island(78, -7.5, 3.6),
    island(112, 8, 3.2),
    // The crypt: a big island splits the pool where the logs roll.
    island(168, 0, 4.2),
    island(206, -9, 3.6),
    island(236, 8, 3.4),
    // The last stretch.
    island(300, -8.5, 3.4),
    island(334, 8.5, 3.8),
    island(372, -8, 3.4),
  ],
  checkpoints: [gate(130), gate(268), gate(length - 6)],
  hazards: [
    // Two pumpkins guard the stone garden: the way through is the gap between them.
    bumper("bumper-1", 96, -7, 2),
    bumper("bumper-2", 96, 7, 2, 1.5, Math.PI),
    // Logs roll across the pool by the crypt, out of step.
    log("log-1", 150, 7, 0.55, 0),
    log("log-2", 190, 7, 0.7, 2.2),
    // The witch's mill grinds the way out of the crypt: its bar sweeps the middle, and the
    // wide lane along the bank is clear.
    { ...across(256, 5, 0.45), id: "spinner-1", kind: "spinner", speed: 0.8 },
    // Another pair in the last bend, with a gap wider than the raft.
    bumper("bumper-3", 318, -7, 2.4),
    bumper("bumper-4", 318, 7, 2.4, 1.5, Math.PI / 2),
    log("log-3", 352, 7, 0.6, 1),
  ],
};

writeCourse("graveyard", level);
console.log(
  `graveyard: ${length.toFixed(1)} m, ${samples.length} samples, ${level.walls.length} islands, spikes ${JSON.stringify(channel.spikes, round)}`,
);
