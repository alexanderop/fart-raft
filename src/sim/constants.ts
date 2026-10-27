export const TICK_RATE = 60;
export const STEP = 1 / TICK_RATE;

/**
 * A rider's stretch of the ring, in the raft's frame (+x = forward, +y = left): the arc
 * `center ± half` radians. A crew of n splits the ring into n equal arcs; a solo rider gets
 * the whole ring (half = π).
 */
export type Zone = { readonly center: number; readonly half: number };

const Q = Math.PI / 4;

/**
 * Zones for a crew of 1–4 riders (humans + bots), in seat order. Every layout is balanced, so
 * riders spread evenly around the ring.
 * 4 = rear-left, rear-right, front-left, front-right.
 */
const CREW_ZONES: Record<number, readonly Zone[]> = {
  1: [{ center: Math.PI, half: Math.PI }],
  2: [
    { center: Math.PI / 2, half: Math.PI / 2 },
    { center: -Math.PI / 2, half: Math.PI / 2 },
  ],
  3: [
    { center: (2 * Math.PI) / 3, half: Math.PI / 3 },
    { center: (-2 * Math.PI) / 3, half: Math.PI / 3 },
    { center: 0, half: Math.PI / 3 },
  ],
  4: [
    { center: 3 * Q, half: Q },
    { center: -3 * Q, half: Q },
    { center: Q, half: Q },
    { center: -Q, half: Q },
  ],
};

export const MAX_CREW = 4;

export function crewZones(size: number): readonly Zone[] {
  const zones = CREW_ZONES[size];
  if (!zones) throw new Error(`crew size must be 1–${MAX_CREW}, got ${size}`);
  return zones;
}

/** Round raft. Mass is kept at RAFT_MASS whatever the radius, so the feel knobs below hold. */
export const RAFT_RADIUS = 2.1;
export const RAFT_MASS = 7.2;

/**
 * Riders wade in the water around the raft, hands on the ring, always facing its center: their
 * butts point out, so every fart pushes the raft toward its center. RIDER_RING is the circle
 * their bodies sit on; the collider (RAFT_HULL) covers them too.
 */
export const RIDER_RING = RAFT_RADIUS + 0.45;
export const RAFT_HULL = RIDER_RING + 0.35;
/** Half a body's width along the ring: riders keep this far from their arc's ends. */
export const RIDER_BODY = 0.55;
export const WALK_SPEED = 2.6; // m/s along the ring

// Feel knobs. Tune these on an empty pond before building courses.
/** A fart is a short burst: FART_FORCE for FART_TICKS, pushing the raft from the rider toward its center. */
export const FART_FORCE = 55;
export const FART_TICKS = 15;
/** Ticks from one burst's start to the next, so holding the key puffs in a rhythm. */
export const FART_COOLDOWN = 24;
export const FART_COST = 20; // gas per burst
export const SOLO_BOOST = 2; // a lone rider pushes like two, so single player isn't a slog
/** Water drag: pulls the raft's velocity toward the water's (the current) at this rate, 1/s. */
export const LINEAR_DAMPING = 1.0;
/** A channel's water flows downstream along its centerline: an idle raft drifts at this speed, m/s. */
export const CURRENT_SPEED = 2;
export const ANGULAR_DAMPING = 2.0;
export const GAS_MAX = 100;
export const GAS_REGEN = 30; // per second while not farting

/** How far a sweeper swings either side of its rest angle, radians. */
export const SWEEP_AMPLITUDE = Math.PI / 4;

/** The crew's lives: each hazard or spike hit costs one, at 0 the raft sinks. */
export const LIVES = 3;
/** After a hit the raft is safe for this long, so one collision cannot drain every life. */
export const INVULNERABLE_TICKS = Math.round(1.5 * TICK_RATE);

/**
 * A hit throws the raft off balance: it is knocked away from the hazard at this speed (m/s) and
 * spun at this rate (rad/s), both scaled by the hazard's own `knock`.
 */
export const KNOCK_SPEED = 6;
export const KNOCK_SPIN = 4;

/** A bumper swells by up to this fraction of its radius, and hits this much harder than a bar. */
export const BUMPER_PULSE = 0.15;
export const BUMPER_KNOCK = 1.7;
/** Bumpers are bouncy: their restitution wins over the raft's whatever it is. */
export const BUMPER_RESTITUTION = 1.5;

export const COUNTDOWN_TICKS = 3 * TICK_RATE;
