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

/** Riders on one raft at most: an online room seats this many. */
export const MAX_CREW = 8;
/** Local couch play: one keyboard cluster per human, so at most this many humans (bots fill the rest up to it). */
export const MAX_LOCAL = 4;

/**
 * n equal arcs in the same seat order as 2–4 (which it reproduces): mirrored left/right pairs from
 * the rear forward, even seats on the left, and for an odd crew the last seat dead ahead.
 */
const ring = (n: number): Zone[] =>
  Array.from({ length: n }, (_, i) => ({
    center: (i % 2 ? -1 : 1) * (Math.PI - (Math.PI / n) * (1 + 2 * Math.floor(i / 2))),
    half: Math.PI / n,
  }));

export function crewZones(size: number): readonly Zone[] {
  const zones = CREW_ZONES[size] ?? (size > 4 && size <= MAX_CREW ? ring(size) : undefined);
  if (!zones) throw new Error(`crew size must be 1–${MAX_CREW}, got ${size}`);
  return zones;
}

/**
 * Round raft. Mass is kept at RAFT_MASS whatever the radius, so the feel knobs below hold.
 * Every crew size rides the same raft: a bigger one for 5–8 riders cannot thread the courses'
 * gaps (the pond spinner leaves 5 m to the bank), and eight bodies still fit the ring without
 * touching, each with ±10° of its arc to slide in.
 */
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
export const WALK_SPEED = 4; // m/s along the ring

// Feel knobs. Tune these on an empty pond before building courses.
/** A fart is a short burst: FART_FORCE for FART_TICKS, pushing the raft from the rider toward its center. */
export const FART_FORCE = 70;
export const FART_TICKS = 15;
/** Ticks from one burst's start to the next, so holding the key puffs in a rhythm. */
export const FART_COOLDOWN = 24;
export const FART_COST = 20; // gas per burst
/**
 * Each rider's push, as a multiple of FART_FORCE. A lone rider pushes like two, so single player
 * isn't a slog; 2–4 push at full force. A bigger crew must not race faster than four: what sets
 * its speed is the strongest push it can aim one way (riders across the ring cancel), and on
 * shorter arcs more riders can join that push, partly. (4/n)^(2/3) keeps it within a few percent
 * of a crew of four's for 6–8 riders (5: 87%); a plain 4/n would leave 8 riders at 78%.
 */
export const crewPower = (crew: number): number =>
  crew === 1 ? 2 : Math.min(1, (4 / crew) ** (2 / 3));
/** Water drag: pulls the raft's velocity toward the water's (the current) at this rate, 1/s. */
export const LINEAR_DAMPING = 1.0;
/** A channel's water flows downstream along its centerline: an idle raft drifts at this speed, m/s. */
export const CURRENT_SPEED = 3.5;
export const ANGULAR_DAMPING = 2.0;
export const GAS_MAX = 100;
export const GAS_REGEN = 45; // per second while not farting

/** How far a sweeper swings either side of its rest angle, radians. */
export const SWEEP_AMPLITUDE = Math.PI / 4;

/**
 * Any hazard or spike hit wipes the crew out: it tumbles for RESPAWN_TICKS, then reappears at the
 * last gate it passed. Failing is cheap and quick, like Fart Together: the clock and the death
 * counter keep score.
 */
export const RESPAWN_TICKS = Math.round(0.8 * TICK_RATE);
/** The raft reappears this far (m) upstream of its last gate, so it has a run-up at what comes next. */
export const RESPAWN_BACK = 6;
/** After a respawn the raft is safe for this long, so a hazard at the gate cannot chain-kill it. */
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

/** A hammer's pivot sits this far (m) back from its smash zone, on the bank. */
export const HAMMER_ARM = 6;
/** A hammer lower than this (radians above the water) is down on its smash zone and hurts. */
export const HAMMER_HIT_LIFT = 0.2;
/** A hammer slams harder than a bar. */
export const HAMMER_KNOCK = 1.3;
/** A piston rests in its bank for this fraction of its cycle, then holds out for PISTON_HOLD of it. */
export const PISTON_REST = 0.45;
export const PISTON_HOLD = 0.2;
export const PISTON_KNOCK = 1.4;

/**
 * Rapids: stretches of a channel where the water runs at RAPIDS_SPEED m/s instead of
 * CURRENT_SPEED. The speed ramps up and down over RAPIDS_RAMP m at either end.
 */
export const RAPIDS_SPEED = 11;
export const RAPIDS_RAMP = 8;

export const COUNTDOWN_TICKS = 3 * TICK_RATE;
