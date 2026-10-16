export const TICK_RATE = 60;
export const STEP = 1 / TICK_RATE;

export type Seat = { readonly x: number; readonly y: number };

/** Co-op crew: seat positions in the raft's frame (+x = forward, +y = left). Off-center pushes turn the raft. */
export const SEATS: readonly Seat[] = [
  { x: -1, y: 0.8 }, // rear left
  { x: -1, y: -0.8 }, // rear right
  { x: 1, y: 0.8 }, // front left
  { x: 1, y: -0.8 }, // front right
];

/** Single player: one rider at the rear center, so a straight push goes straight and aiming steers. */
export const SOLO_SEATS: readonly Seat[] = [{ x: -1, y: 0 }];

export const RAFT_HALF = { x: 1.5, y: 1.2 };

// Feel knobs. Tune these on an empty pond before building courses.
export const FART_FORCE = 25;
export const LINEAR_DAMPING = 1.0;
export const ANGULAR_DAMPING = 2.0;
export const GAS_MAX = 100;
export const GAS_DRAIN = 50; // per second while farting
export const GAS_REGEN = 30; // per second while not farting

export const COUNTDOWN_TICKS = 3 * TICK_RATE;
