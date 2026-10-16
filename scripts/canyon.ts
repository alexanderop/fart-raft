// Generates courses/canyon.json. Rerun after editing the spec: `pnpm course`.
// Checkpoints and hazards are placed by arc length along the channel, so moving a control
// point keeps every gate square to the stream.
import { writeFileSync } from "node:fs";
import { pointAt, sampleChannel } from "../src/sim/channel.ts";
import { SWEEP_AMPLITUDE } from "../src/sim/constants.ts";
import type { Box, Channel, HazardDef, LevelData, Span } from "../src/sim/types.ts";

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

const samples = sampleChannel(channel);
const length = samples[samples.length - 1]!.s;
const at = (s: number) => pointAt(samples, s);

/** A box square to the stream at arc length `s`, `offset` m to the left of center. */
function across(s: number, hx: number, hy: number, offset = 0): Box {
  const p = at(s);
  return { x: p.x + p.nx * offset, y: p.y + p.ny * offset, rot: Math.atan2(p.ty, p.tx), hx, hy };
}

const gate = (s: number): Box => across(s, 0.5, channel.halfWidth - 0.3);

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
function outerBends(minTurn: number): Span[] {
  const spans: Span[] = [];
  for (let i = 1; i + 1 < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i + 1]!;
    const turn = (a.tx * b.ty - a.ty * b.tx) / (b.s - a.s || 1);
    if (Math.abs(turn) < minTurn) continue;
    const side = turn > 0 ? "right" : "left";
    const s = samples[i]!.s;
    const prev = spans[spans.length - 1];
    if (prev && prev.side === side && s - prev.to < 3) prev.to = s;
    else spans.push({ side, from: s, to: s });
  }
  return spans.filter((sp) => sp.to - sp.from > 4);
}
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
    sweeper("sweeper-2", 276, -1, 1.6),
    { ...across(length - 26, 3.6, 0.4), id: "spinner-2", kind: "spinner", speed: -1.4 },
  ],
};

const round = (_: string, v: unknown) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v);
writeFileSync(
  new URL("../courses/canyon.json", import.meta.url),
  `${JSON.stringify(level, round, 2)}\n`,
);
console.log(
  `canyon: ${length.toFixed(1)} m, ${samples.length} samples, spikes ${JSON.stringify(channel.spikes, round)}`,
);
