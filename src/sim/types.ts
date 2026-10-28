// Plain data shared by every layer. Nothing here may reference Rapier, Three or the DOM,
// because these shapes go over the network later.

/** Command pattern: one seat's intent for one tick. Keyboard, bot and network all produce this. */
export type SeatInput = {
  /**
   * Stick in world space (sim frame), length 0–1. The rider slides around the ring by the
   * part of it that runs along the ring.
   */
  move: Vec2;
  /** Start a fart burst when ready. Held, it puffs again after each cooldown. */
  fart: boolean;
};

export const IDLE_INPUT: SeatInput = { move: { x: 0, y: 0 }, fart: false };

/** Event Queue: what happened during one tick. The client turns these into sound, particles and UI. */
export type SimEvent =
  | { type: "fart"; seat: number; x: number; y: number; dirX: number; dirY: number }
  | { type: "bump"; x: number; y: number; speed: number }
  | { type: "go" }
  | { type: "checkpoint"; index: number }
  | { type: "finished"; timeMs: number }
  /**
   * A hazard or a spike hit wiped the crew out: `deaths` counts every wipeout so far. (dirX, dirY)
   * is the unit direction the hit throws the raft. It respawns at the last gate shortly after.
   */
  | { type: "hit"; deaths: number; x: number; y: number; dirX: number; dirY: number }
  /** The raft is back at the last gate passed (or the start): (x, y) is where it reappeared. */
  | { type: "respawn"; x: number; y: number };

export type Phase =
  | { kind: "countdown"; ticksLeft: number }
  | { kind: "racing"; startTick: number; nextCheckpoint: number }
  | { kind: "finished"; timeMs: number };

export type Pose = { x: number; y: number; rot: number };

/** A rider on the deck, in the raft's frame. `face` is where it looks; it farts the other way. */
export type RiderPose = { x: number; y: number; face: number };

export type Snapshot = {
  tick: number;
  raft: Pose;
  riders: RiderPose[];
  gas: number[];
  /** Wipeouts so far: every hit sends the crew back to the last gate, the clock keeps running. */
  deaths: number;
  /** Ticks until a wiped-out raft respawns, 0 while it is afloat. The crew is helpless meanwhile. */
  respawnIn: number;
  /** Ticks of grace left after a respawn: the raft cannot be hurt while this is above 0. */
  invulnerable: number;
  hazards: (Pose & { id: string })[];
  phase: Phase;
};

// ── Level data: exported from Blender as JSON (see CLAUDE.md "Blender pipeline") ──

export type Box = { x: number; y: number; rot: number; hx: number; hy: number };

export type Vec2 = { x: number; y: number };

/**
 * Spinner: a bar rotating about its center at `speed` rad/s.
 * Cross: a spinner with two bars, square to each other.
 * Sweeper: a bar pivoting at (x, y), arm of length 2·hx along `rot`, swinging ±SWEEP_AMPLITUDE
 * with angular frequency `speed`.
 * Log: a spiked log of half-length `hx` and radius `hy`, its axis along `rot`, rolling back and
 * forth across that axis: its center runs `range` m either side of (x, y), `speed` rad/s, `phase` rad.
 * Bumper: a round spiked pumpkin of radius `hx` at (x, y) that swells and shrinks at `speed` rad/s.
 * Hammer: a spiked mallet hinged on the bank HAMMER_ARM m back along `rot`; once per cycle
 * (`speed` rad/s, `phase` rad) it slams down on the box (x, y, rot, hx, hy) and only hurts there.
 * Piston: a spiked block of half-extents (hx along `rot`, hy) resting in a bank at (x, y); once
 * per cycle it punches `range` m out along `rot`, holds, and slides back.
 */
export type HazardDef = {
  id: string;
  kind: "spinner" | "cross" | "sweeper" | "log" | "bumper" | "hammer" | "piston";
  speed: number;
  /** Log: how far its center travels either side of (x, y). Piston: how far it punches out. m. */
  range?: number;
  /** Log, bumper, hammer and piston: where in its cycle the hazard starts, radians. */
  phase?: number;
} & Box;

/** A stretch of spiked bank, by arc length (m) along the channel's centerline. */
export type Span = { side: "left" | "right"; from: number; to: number };

/** A stretch of channel by arc length (m) along its centerline. */
export type Stretch = { from: number; to: number };

/**
 * Most of a course is one winding channel: control points of its centerline and a constant
 * half-width. The banks (colliders and visuals) are derived from it, see sim/channel.ts.
 * `rapids` are stretches where the water runs at RAPIDS_SPEED.
 */
export type Channel = { halfWidth: number; points: Vec2[]; spikes: Span[]; rapids?: Stretch[] };

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
