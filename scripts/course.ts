// Helpers the channel course generators share (canyon.ts, graveyard.ts): things placed by arc
// length along the centerline, so moving a control point keeps every gate square to the stream.
import { writeFileSync } from "node:fs";
import { pointAt, sampleChannel, type Sample } from "../src/sim/channel.ts";
import type { Box, Channel, LevelData, Span } from "../src/sim/types.ts";

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

  return {
    samples,
    length,
    at,
    across,
    gate: (s) => across(s, 0.5, channel.halfWidth - 0.3),
    outerBends,
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
