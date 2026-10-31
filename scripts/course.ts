// Helpers the channel course generators share (canyon.ts, graveyard.ts): things placed by arc
// length along the centerline, so moving a control point keeps every gate square to the stream.
import { writeFileSync } from "node:fs";
import { halfWidthAt, pointAt, sampleChannel, type Sample } from "../src/sim/channel.ts";
import { MACE_BANK_GAP } from "../src/sim/constants.ts";
import type { Box, Channel, HazardDef, LevelData, Span } from "../src/sim/types.ts";

/** A drop gate's timing (see HazardDef): seconds per cycle, down and rising, and its phase (rad). */
export type DropgateTiming = { period?: number; down?: number; rise?: number; phase?: number };

/** A double gate's timing (see HazardDef): seconds per cycle, shut and swinging open, and its phase (rad). */
export type DoublegateTiming = DropgateTiming;

/** A mace's swing: `speed` rad/s, `phase` rad, and the bob's radius `r` (m). */
export type MaceSwing = { speed: number; phase?: number; r?: number };

/**
 * A drifting mine: `range` m either side of its spot at `speed` rad/s, across the channel, or
 * up and down it when `along` is set.
 */
export type MineDrift = { range: number; speed: number; phase?: number; along?: boolean };

/** A boost pad is 5 m along the stream and 3 m across: two chevrons. */
const BOOST_HALF_LENGTH = 2.5;
const BOOST_HALF_WIDTH = 1.5;

export type ChannelKit = {
  samples: Sample[];
  length: number;
  /** The centerline at arc length `s`. */
  at: (s: number) => Sample;
  /** A box square to the stream at arc length `s`, `offset` m to the left of center. */
  across: (s: number, hx: number, hy: number, offset?: number) => Box;
  /** A checkpoint gate spanning the channel at arc length `s`. */
  gate: (s: number) => Box;
  /** Spiked spans along the outer bank of every bend sharper than `minTurn`, at least `minLength` m long. */
  outerBends: (minTurn: number, minLength?: number) => Span[];
  /** A drop gate's bar spanning the channel, bank to bank, at arc length `s`. */
  dropgate: (id: string, s: number, timing?: DropgateTiming) => HazardDef;
  /** A double gate at arc length `s`: two doors hinged on the banks that meet in the middle. */
  doublegate: (id: string, s: number, timing?: DoublegateTiming) => HazardDef;
  /** A mine of radius `r` at arc length `s`, `lat` m left of center, still or drifting across. */
  mine: (id: string, s: number, lat: number, r?: number, drift?: MineDrift) => HazardDef;
  /** A mace on a gantry over the centerline at arc length `s`, swinging from bank to bank. */
  mace: (id: string, s: number, swing: MaceSwing) => HazardDef;
  /** A boost pad at arc length `s`, `lat` m left of center, pointing downstream. */
  boost: (s: number, lat: number) => Box;
};

export function channelKit(channel: Channel): ChannelKit {
  const samples = sampleChannel(channel);
  const length = samples[samples.length - 1]!.s;
  const at = (s: number) => pointAt(samples, s);

  function across(s: number, hx: number, hy: number, offset = 0): Box {
    const p = at(s);
    return { x: p.x + p.nx * offset, y: p.y + p.ny * offset, rot: Math.atan2(p.ty, p.tx), hx, hy };
  }

  function outerBends(minTurn: number, minLength = 4): Span[] {
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
    return spans.filter((sp) => sp.to - sp.from > minLength);
  }

  function dropgate(id: string, s: number, timing: DropgateTiming = {}): HazardDef {
    const box = across(s, halfWidthAt(channel, s), 0.6);
    return { ...box, rot: box.rot + Math.PI / 2, id, kind: "dropgate", speed: 0, ...timing };
  }

  function doublegate(id: string, s: number, timing: DoublegateTiming = {}): HazardDef {
    // Hinged a hair inside the banks: a door swung open lies flat along its bank, half in the rail.
    const box = across(s, halfWidthAt(channel, s) - 0.25, 0.45);
    return { ...box, rot: box.rot + Math.PI / 2, id, kind: "doublegate", speed: 0, ...timing };
  }

  function mine(id: string, s: number, lat: number, r = 0.9, drift?: MineDrift): HazardDef {
    const box = across(s, r, r, lat);
    return {
      ...box,
      rot: drift?.along ? box.rot : box.rot + Math.PI / 2,
      id,
      kind: "mine",
      speed: drift?.speed ?? 0,
      ...(drift && { range: drift.range, phase: drift.phase ?? 0 }),
    };
  }

  function mace(id: string, s: number, swing: MaceSwing): HazardDef {
    const r = swing.r ?? 1.5;
    const box = across(s, r, r);
    return {
      ...box,
      rot: box.rot + Math.PI / 2,
      id,
      kind: "mace",
      speed: swing.speed,
      range: halfWidthAt(channel, s) - MACE_BANK_GAP,
      phase: swing.phase ?? 0,
    };
  }

  return {
    samples,
    length,
    at,
    across,
    gate: (s) => across(s, 0.5, halfWidthAt(channel, s) - 0.3),
    outerBends,
    dropgate,
    doublegate,
    mine,
    mace,
    boost: (s, lat) => across(s, BOOST_HALF_LENGTH, BOOST_HALF_WIDTH, lat),
  };
}

/** Three decimals are plenty for metres and radians, and keep the JSON diffs small. */
export const round = (_: string, v: unknown) =>
  typeof v === "number" ? Math.round(v * 1000) / 1000 : v;

/** Write `courses/<name>.json`. */
export function writeCourse(name: string, level: LevelData): void {
  writeFileSync(
    new URL(`../courses/${name}.json`, import.meta.url),
    `${JSON.stringify(level, round, 2)}\n`,
  );
}
