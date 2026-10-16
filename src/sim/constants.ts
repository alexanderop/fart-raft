export const TICK_RATE = 60;
export const STEP = 1 / TICK_RATE;

export type Seat = { readonly x: number; readonly y: number };

/** Full crew: seat positions in the raft's frame (+x = forward, +y = left). Off-center pushes turn the raft. */
export const SEATS: readonly Seat[] = [
  { x: -1, y: 0.8 }, // rear left
  { x: -1, y: -0.8 }, // rear right
  { x: 1, y: 0.8 }, // front left
  { x: 1, y: -0.8 }, // front right
];

export const MAX_CREW = SEATS.length;

/**
 * Seat layout for a crew of 1–4 riders (humans + bots). Every layout is balanced, so all
 * riders pushing straight back drives the raft straight; steering comes from aiming.
 */
const CREW_LAYOUTS: Record<number, readonly Seat[]> = {
  1: [{ x: -1, y: 0 }],
  2: [SEATS[0]!, SEATS[1]!],
  3: [SEATS[0]!, SEATS[1]!, { x: 1, y: 0 }],
  4: SEATS,
};

export function crewSeats(size: number): readonly Seat[] {
  const layout = CREW_LAYOUTS[size];
  if (!layout) throw new Error(`crew size must be 1–${MAX_CREW}, got ${size}`);
  return layout;
}

export const RAFT_HALF = { x: 1.5, y: 1.2 };

/** Nozzle range and swing speed. Every input source (keyboard, bot, network) plays by these. */
export const AIM_LIMIT = Math.PI / 3; // ±60° from straight back
export const AIM_SPEED = 3; // radians per second

// Feel knobs. Tune these on an empty pond before building courses.
export const FART_FORCE = 25;
export const SOLO_BOOST = 2; // a lone rider pushes like two, so single player isn't a slog
export const LINEAR_DAMPING = 1.0;
export const ANGULAR_DAMPING = 2.0;
export const GAS_MAX = 100;
export const GAS_DRAIN = 50; // per second while farting
export const GAS_REGEN = 30; // per second while not farting

export const COUNTDOWN_TICKS = 3 * TICK_RATE;
