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

export type HazardDef = { id: string; kind: "spinner"; speed: number } & Box;

export type LevelData = {
  name: string;
  spawn: Pose;
  walls: Box[];
  /** In race order. The last one is the finish line. */
  checkpoints: Box[];
  hazards: HazardDef[];
};
