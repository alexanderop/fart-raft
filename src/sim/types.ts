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

/**
 * Event Queue: what happened during one tick. The client turns these into sound, particles and UI.
 * `raft` is the raft it happened to (an index into `Snapshot.crews`); `fart.seat` is the rider
 * within that raft. `go` is the whole race's.
 */
export type SimEvent =
  | { type: "fart"; raft: number; seat: number; x: number; y: number; dirX: number; dirY: number }
  /** The raft hit something solid at `speed` m/s; `rival` when that was another raft (Bump only). */
  | { type: "bump"; raft: number; x: number; y: number; speed: number; rival: boolean }
  | { type: "go" }
  | { type: "checkpoint"; raft: number; index: number }
  | { type: "finished"; raft: number; timeMs: number }
  /**
   * A hazard or a spike hit wiped the crew out: `deaths` counts every wipeout so far. (dirX, dirY)
   * is the unit direction the hit throws the raft. It respawns at the last gate shortly after.
   */
  | { type: "hit"; raft: number; deaths: number; x: number; y: number; dirX: number; dirY: number }
  /** The raft is back at the last gate passed (or the start): (x, y) is where it reappeared. */
  | { type: "respawn"; raft: number; x: number; y: number }
  /** The raft ran onto a boost pad at (x, y): it is shoved along the unit vector (dirX, dirY). */
  | { type: "boost"; raft: number; x: number; y: number; dirX: number; dirY: number };

export type Phase =
  | { kind: "countdown"; ticksLeft: number }
  | { kind: "racing"; startTick: number; nextCheckpoint: number }
  | { kind: "finished"; timeMs: number };

export type Pose = { x: number; y: number; rot: number };

/** A rider on the deck, in the raft's frame. `face` is where it looks; it farts the other way. */
export type RiderPose = { x: number; y: number; face: number };

/** How hard the course plays: "chill" slows the hazards and forgives more, "wild" is full speed. */
export type Difficulty = "chill" | "wild";

/** How rafts in one race meet: "ghost" rafts pass through each other, "bump" rafts collide. */
export type Contact = "ghost" | "bump";

/** One raft and its crew, as everyone sees it. */
export type Crew = {
  raft: Pose;
  riders: RiderPose[];
  gas: number[];
  /** Wipeouts so far: every hit sends the crew back to the last gate, the clock keeps running. */
  deaths: number;
  /** Ticks until a wiped-out raft respawns, 0 while it is afloat. The crew is helpless meanwhile. */
  respawnIn: number;
  /** Ticks of grace left after a respawn: the raft cannot be hurt while this is above 0. */
  invulnerable: number;
  phase: Phase;
};

/** The whole race, as the server sends it. `crews[0]` is co-op's only raft; in a team race 0 = Red, 1 = Blue. */
export type Snapshot = {
  tick: number;
  /** The race's difficulty: bots and the renderer derive hazard time from it (`hazardTime`). */
  difficulty: Difficulty;
  contact: Contact;
  hazards: (Pose & { id: string })[];
  crews: Crew[];
};

/** One raft's view of the race (`viewOf`): its crew, the shared course state, and every other raft. */
export type View = Crew & Omit<Snapshot, "crews"> & { rivals: Crew[] };

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
 * Bumper: a round spiked ball of radius `hx` at (x, y) that swells and shrinks at `speed` rad/s.
 * Hammer: a spiked mallet hinged on the bank HAMMER_ARM m back along `rot`; once per cycle
 * (`speed` rad/s, `phase` rad) it slams down on the box (x, y, rot, hx, hy) and only hurts there.
 * Piston: a spiked block of half-extents (hx along `rot`, hy) resting in a bank at (x, y); once
 * per cycle it punches `range` m out along `rot`, holds, and slides back.
 * Dropgate: a spiked bar of half-length `hx` along `rot` (across the channel, bank to bank) and
 * half-thickness `hy`, hung between two posts. Every `period` s it shakes, slams onto the water,
 * rests there `down` s and rises over `rise` s; it only hurts while down. `speed` is unused (0).
 * Doublegate: two spiked doors hinged on the banks `hx` m either side of (x, y) along `rot`
 * (across the channel), each `hx` long and `2·hy` thick. Every `period` s they swing shut, meet
 * in the middle, stay shut `down` s and swing open upstream over `rise` s. `speed` is unused (0).
 * Mine: a floating spiked mine of radius `hx`, drifting `range` m either side of (x, y) along
 * `rot` at `speed` rad/s (still without a `range`). Touching it wipes the crew out.
 * Mace: a spiked bob of radius `hx` hung from a gantry over (x, y), swinging like a pendulum
 * `range` m either side along `rot` (across the channel) at `speed` rad/s, `phase` rad. It hurts
 * only while low, through the middle of its swing; at either end it hangs over the riders' heads.
 */
export type HazardDef = {
  id: string;
  kind:
    | "spinner"
    | "cross"
    | "sweeper"
    | "log"
    | "bumper"
    | "hammer"
    | "piston"
    | "dropgate"
    | "doublegate"
    | "mine"
    | "mace";
  speed: number;
  /**
   * Log: how far its center travels either side of (x, y). Piston: how far it punches out.
   * Mine: how far it drifts either side of (x, y). Mace: how far its bob swings either side. m.
   */
  range?: number;
  /** Log, bumper, hammer, piston, dropgate, doublegate, mine and mace: where in its cycle the hazard starts, radians. */
  phase?: number;
  /**
   * Dropgate: seconds per cycle, how long it rests down, and how long it takes to rise again.
   * Doublegate: seconds per cycle, how long it stays shut, and how long it takes to swing open.
   */
  period?: number;
  down?: number;
  rise?: number;
} & Box;

/** A stretch of spiked bank, by arc length (m) along the channel's centerline. */
export type Span = { side: "left" | "right"; from: number; to: number };

/** A stretch of channel by arc length (m) along its centerline. */
export type Stretch = { from: number; to: number };

/**
 * A pond: the channel opens to `halfWidth` m between arc lengths `from` and `to`, easing out over
 * the first POND_RAMP m and back in over the last (see `halfWidthAt`).
 */
export type Pond = Stretch & { halfWidth: number };

/**
 * Most of a course is one winding channel: control points of its centerline and a half-width.
 * The banks (colliders and visuals) are derived from it, see sim/channel.ts. `rapids` are
 * stretches where the water runs at RAPIDS_SPEED; `ponds` widen it into calm pools.
 */
export type Channel = {
  halfWidth: number;
  points: Vec2[];
  spikes: Span[];
  rapids?: Stretch[];
  ponds?: Pond[];
};

export type LevelData = {
  name: string;
  spawn: Pose;
  channel: Channel | null;
  /** Extra static boxes: islands, or a whole course's banks when there is no channel. */
  walls: Box[];
  /** In race order. The last one is the finish line. */
  checkpoints: Box[];
  hazards: HazardDef[];
  /**
   * Boost pads: `>>` chevrons on the water. A raft whose center is on one (within BOOST_REACH m of
   * the box) is pushed along `rot`, up to BOOST_SPEED. Not hazards: nothing here wipes out.
   */
  boosts?: Box[];
};
