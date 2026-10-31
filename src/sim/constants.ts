import type { Difficulty, HazardDef } from "./types.ts";

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
 * What a difficulty changes. `hazardRate` is how fast hazard time runs against real time: every
 * hazard's motion is a pure function of hazard time (sim/hazards/shape.ts `hazardTime`), so a
 * slower clock slows every spinner, hammer, piston and drop gate at once, windows included.
 * `kindRates` overrides it for single hazard kinds; always read the rate through `hazardRate()`.
 */
export type Tuning = {
  hazardRate: number;
  kindRates?: Partial<Record<HazardDef["kind"], number>>;
  respawnTicks: number;
  respawnBack: number;
  invulnerableTicks: number;
  /** Riders walk around the ring this many times WALK_SPEED; a lone rider (whole ring) `soloWalk` times. */
  walk: number;
  soloWalk: number;
};

/**
 * Chill (the default) is for a lone human on a phone: hazards at 70% speed (spinners and crosses
 * at 50%: their only window is a launch timed against the bar), a quicker respawn
 * with a longer run-up (respawning closer put the raft too near the next hazard to time it), twice
 * the grace after it, and riders who walk the ring faster, so a sharp turn (walk to the far side,
 * then push) comes sooner. Wild is today's tuning, unchanged.
 */
export const DIFFICULTY: Record<Difficulty, Tuning> = {
  chill: {
    hazardRate: 0.7,
    kindRates: { spinner: 0.5, cross: 0.5 },
    respawnTicks: Math.round(0.5 * TICK_RATE),
    respawnBack: 8,
    invulnerableTicks: Math.round(3 * TICK_RATE),
    walk: 1.5,
    soloWalk: 2.25,
  },
  wild: {
    hazardRate: 1,
    respawnTicks: RESPAWN_TICKS,
    respawnBack: RESPAWN_BACK,
    invulnerableTicks: INVULNERABLE_TICKS,
    walk: 1,
    soloWalk: 1,
  },
};
/**
 * How fast hazard time runs for a hazard of `kind` at `difficulty`. The sim, the bots and the
 * renderer all ask this (through `hazardTime`), so a per-kind override keeps them in sync.
 */
export function hazardRate(difficulty: Difficulty, kind: HazardDef["kind"]): number {
  const t = DIFFICULTY[difficulty];
  return t.kindRates?.[kind] ?? t.hazardRate;
}

export const DIFFICULTIES = ["chill", "wild"] as const satisfies readonly Difficulty[];
export const DEFAULT_DIFFICULTY: Difficulty = "chill";

/**
 * How fast (m/s) a rider walks around the ring in a crew of `crew` at `difficulty`. The sim
 * moves riders at this speed; anything that predicts a rider's walk must ask this, not WALK_SPEED.
 */
export function walkSpeed(difficulty: Difficulty, crew: number): number {
  const t = DIFFICULTY[difficulty];
  return WALK_SPEED * (crew === 1 ? t.soloWalk : t.walk);
}

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
 * A drop gate's cycle, by default: DROPGATE_PERIOD s from slam to slam, of which the bar rests on
 * the water DROPGATE_DOWN s and rises again over DROPGATE_RISE s. Each gate may set its own.
 * Before it slams it shakes for DROPGATE_SHAKE s (the tell), and the slam itself takes DROPGATE_SLAM s.
 */
export const DROPGATE_PERIOD = 6;
export const DROPGATE_DOWN = 0.7;
export const DROPGATE_RISE = 1.4;
export const DROPGATE_SHAKE = 0.5;
export const DROPGATE_SLAM = 0.15;
/** A drop gate lower than this fraction of its full lift reaches the riders' heads and hurts. */
export const DROPGATE_HIT_LIFT = 0.3;
export const DROPGATE_KNOCK = 1.3;
/**
 * A double gate's cycle, by default: DOUBLEGATE_PERIOD s, starting wide open. Its two doors swing
 * shut over DOUBLEGATE_CLOSE s, stay shut DOUBLEGATE_SHUT s and swing open again over
 * DOUBLEGATE_OPEN s. Each gate may set its own period, shut (`down`) and open (`rise`) times.
 * Wide open, each door stands DOUBLEGATE_SWING rad from closed, flat along its bank.
 */
export const DOUBLEGATE_PERIOD = 6;
export const DOUBLEGATE_CLOSE = 0.8;
export const DOUBLEGATE_SHUT = 1;
export const DOUBLEGATE_OPEN = 1.2;
export const DOUBLEGATE_SWING = Math.PI / 2;
export const DOUBLEGATE_KNOCK = 1.3;
/** A mine bursts: it throws the raft a bit harder than a bar does. */
export const MINE_KNOCK = 1.2;
/**
 * A mace swings MACE_SWING rad either side of straight down. Its bob rises on the arc, and it
 * only reaches the riders while lower than MACE_HIT_LIFT m above the bottom of its swing.
 */
export const MACE_SWING = 1;
export const MACE_HIT_LIFT = 1;
export const MACE_KNOCK = 1.5;
/** Course mace swing out to this far (m) short of the banks; the client's gantry stands beyond. */
export const MACE_BANK_GAP = 1.5;

/**
 * Rapids: stretches of a channel where the water runs at RAPIDS_SPEED m/s instead of
 * CURRENT_SPEED. The speed ramps up and down over RAPIDS_RAMP m at either end.
 */
export const RAPIDS_SPEED = 11;
export const RAPIDS_RAMP = 8;

/**
 * Ponds (`Channel.ponds`) widen the channel over POND_RAMP m at either end. The water slows in
 * them, to CURRENT_SPEED × channel half-width / pond half-width: the same flow through more room.
 */
export const POND_RAMP = 16;

/**
 * Boost pads: while the raft's center is within BOOST_REACH m of a pad, it speeds up along the
 * pad at BOOST_ACCEL m/s², until it runs BOOST_SPEED m/s that way. Water drag bleeds it off after.
 */
export const BOOST_ACCEL = 30;
export const BOOST_SPEED = 13;
export const BOOST_REACH = 1;

export const COUNTDOWN_TICKS = 3 * TICK_RATE;
