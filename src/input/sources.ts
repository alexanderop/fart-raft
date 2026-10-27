import { IDLE_INPUT, type SeatInput, type Vec2 } from "../sim/types.ts";

/** Anything that can fill a seat: keyboard, gamepad, bot, or (later) a remote player. */
export type InputSource = { read(): SeatInput };

/** Null object for empty seats, so callers never check for "no source". */
export const idleSource: InputSource = { read: () => IDLE_INPUT };

export function createSeats(count: number): InputSource[] {
  return Array.from({ length: count }, () => idleSource);
}

export function readSeats(seats: readonly InputSource[]): SeatInput[] {
  return seats.map((s) => s.read());
}

/**
 * Screen-relative intent to a world vector: `fwd` walks away from the camera, `left` to its
 * left. `heading` is the camera's forward direction on the water (sim radians). Shared by every
 * device so keyboard and stick agree.
 */
export function cameraRelative(fwd: number, left: number, heading: number): Vec2 {
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  // Forward is (c, s), left is (-s, c).
  return { x: fwd * c - left * s, y: fwd * s + left * c };
}

/** Two devices on one seat (online play: keyboard and pad): the stronger stick wins, any fart counts. */
export function mergeSources(a: InputSource, b: InputSource): InputSource {
  return {
    read() {
      const x = a.read();
      const y = b.read();
      const move =
        Math.hypot(x.move.x, x.move.y) >= Math.hypot(y.move.x, y.move.y) ? x.move : y.move;
      return { move, fart: x.fart || y.fart };
    },
  };
}

/** A seat is a human's (keyboard or pad) or a bot's. */
export type SeatKind = "human" | "bot";

/**
 * Who drives which seat, for the local couch game. Sticky: a pad keeps its seat until it
 * disconnects, so unplugging one pad never shuffles the others.
 */
export type SeatPlan = {
  /** Pad index to the seat it drives. */
  pads: ReadonlyMap<number, number>;
  /** Human seat without a pad to the keyboard cluster (index into PLAYER_KEYS) it plays on. */
  keys: ReadonlyMap<number, number>;
};

export const EMPTY_PLAN: SeatPlan = { pads: new Map(), keys: new Map() };

const KEY_CLUSTERS = 4;

/**
 * The seat rule:
 *
 * 1. Pads take human seats in connection order (`connected` is oldest first).
 * 2. Human seats left over play on keyboard clusters, first free cluster each.
 * 3. A pad that is in `wantsIn` (it pressed fart while idle) and finds no free human seat takes
 *    over a bot seat. A bot seat is never taken by a pad that merely connected.
 * 4. A pad that finds nothing stays unassigned. A pad that disconnects frees its seat: a human
 *    seat falls back to a keyboard, a bot seat to its bot.
 */
export function planSeats(
  seats: readonly SeatKind[],
  connected: readonly number[],
  wantsIn: ReadonlySet<number>,
  prev: SeatPlan = EMPTY_PLAN,
): SeatPlan {
  const pads = new Map<number, number>();
  const taken = new Set<number>();
  const claim = (pad: number, seat: number) => {
    pads.set(pad, seat);
    taken.add(seat);
  };

  for (const pad of connected) {
    const seat = prev.pads.get(pad);
    if (seat !== undefined && seat < seats.length && !taken.has(seat)) claim(pad, seat);
  }
  for (const pad of connected) {
    if (pads.has(pad)) continue;
    let seat = seats.findIndex((kind, i) => kind === "human" && !taken.has(i));
    if (seat < 0 && wantsIn.has(pad)) {
      seat = seats.findIndex((kind, i) => kind === "bot" && !taken.has(i));
    }
    if (seat >= 0) claim(pad, seat);
  }

  const keys = new Map<number, number>();
  const usedClusters = new Set<number>();
  const onKeys = seats.flatMap((kind, i) => (kind === "human" && !taken.has(i) ? [i] : []));
  for (const seat of onKeys) {
    const cluster = prev.keys.get(seat);
    if (cluster !== undefined && !usedClusters.has(cluster)) {
      keys.set(seat, cluster);
      usedClusters.add(cluster);
    }
  }
  for (const seat of onKeys) {
    if (keys.has(seat)) continue;
    for (let cluster = 0; cluster < KEY_CLUSTERS; cluster++) {
      if (usedClusters.has(cluster)) continue;
      keys.set(seat, cluster);
      usedClusters.add(cluster);
      break;
    }
  }
  return { pads, keys };
}
