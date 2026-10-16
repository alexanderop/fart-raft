// Plain data shared by every layer. Nothing here may reference Rapier, Three or the DOM,
// because these shapes go over the network later.

/** Command pattern: one seat's intent for one tick. Keyboard, bot and network all produce this. */
export type SeatInput = {
  thrust: boolean;
  /** Push direction in the raft's frame, radians. 0 = raft forward. */
  aim: number;
};

export const IDLE_INPUT: SeatInput = { thrust: false, aim: 0 };

/** Event Queue: what happened during one tick. The client turns these into sound, particles and UI. */
export type SimEvent =
  | { type: "fart"; seat: number; x: number; y: number; dirX: number; dirY: number }
  | { type: "bump"; x: number; y: number; speed: number }
  | { type: "go" }
  | { type: "checkpoint"; index: number }
  | { type: "finished"; timeMs: number };

export type Phase =
  | { kind: "countdown"; ticksLeft: number }
  | { kind: "racing"; startTick: number; nextCheckpoint: number }
  | { kind: "finished"; timeMs: number };

export type Pose = { x: number; y: number; rot: number };

export type Snapshot = {
  tick: number;
  raft: Pose;
  gas: number[];
  hazards: (Pose & { id: string })[];
  phase: Phase;
};

// ── Level data: exported from Blender as JSON (see CLAUDE.md "Blender pipeline") ──

export type Box = { x: number; y: number; rot: number; hx: number; hy: number };

export type Vec2 = { x: number; y: number };

/**
 * Spinner: a bar rotating about its center at `speed` rad/s.
 * Sweeper: a bar pivoting at (x, y), arm of length 2·hx along `rot`, swinging ±SWEEP_AMPLITUDE
 * with angular frequency `speed`.
 */
export type HazardDef = { id: string; kind: "spinner" | "sweeper"; speed: number } & Box;

/** A stretch of spiked bank, by arc length (m) along the channel's centerline. */
export type Span = { side: "left" | "right"; from: number; to: number };

/**
 * Most of a course is one winding channel: control points of its centerline and a constant
 * half-width. The banks (colliders and visuals) are derived from it, see sim/channel.ts.
 */
export type Channel = { halfWidth: number; points: Vec2[]; spikes: Span[] };

export type LevelData = {
  name: string;
  spawn: Pose;
  channel: Channel | null;
  /** Extra static boxes: islands, or a whole course's banks when there is no channel. */
  walls: Box[];
  /** In race order. The last one is the finish line. */
  checkpoints: Box[];
  hazards: HazardDef[];
};
