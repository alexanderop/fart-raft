import RAPIER from "@dimforge/rapier2d-compat";
import {
  crewPower,
  crewZones,
  DEFAULT_DIFFICULTY,
  DIFFICULTY,
  FART_FORCE,
  hazardRate,
  MAX_CREW,
  RAFT_HULL,
  RIVAL_BLAST,
  RIVAL_REACH,
  STEP,
  TEAM_SPACING,
  type Tuning,
  walkSpeed,
  type Zone,
} from "./constants.ts";
import { boostRaft, padAt } from "./boost.ts";
import { flowSpeed, nearestS, pointAt, sampleChannel, type Sample } from "./channel.ts";
import {
  freshHealth,
  initialPhase,
  reachCheckpoint,
  takeHit,
  tickHealth,
  tickPhase,
  type Health,
} from "./flow.ts";
import { createHazard, type Hazard } from "./hazards/index.ts";
import { buildLevel } from "./level.ts";
import {
  applyInputs,
  applyWaterDrag,
  createRaft,
  knockBack,
  placeRaft,
  riderPose,
  type Raft,
} from "./raft.ts";
import type {
  Box,
  Channel,
  Contact,
  Crew,
  Difficulty,
  LevelData,
  Phase,
  Pose,
  SeatInput,
  SimEvent,
  Snapshot,
  Vec2,
} from "./types.ts";

/** One raft in the race: its body and crew, and its own run of the course. */
export type Racer = {
  raft: Raft;
  health: Health;
  phase: Phase;
  /** The boost pad the raft is on now (-1: none). */
  onPad: number;
  /** Whether it collides with (and blasts) rival rafts: only in Bump, never during its respawn grace. */
  solid: boolean;
};

export type Sim = {
  world: RAPIER.World;
  eventQueue: RAPIER.EventQueue;
  /** Every raft in the race, in `Snapshot.crews` order: one in co-op. */
  racers: Racer[];
  /** Raft collider handle → its index in `racers`. */
  racerByCollider: Map<number, number>;
  contact: Contact;
  /** The course's channel and its centerline samples, for the current. Null on still-water courses. */
  channel: Channel | null;
  stream: Sample[] | null;
  hazards: Hazard[];
  /** Boost pads (LevelData `boosts`). */
  boosts: Box[];
  /** Hazard seconds per tick for each hazard, in `hazards` order (`hazardRate` of its kind). */
  hazardSteps: number[];
  checkpointByHandle: Map<number, number>;
  /** Collider handles that wipe the crew out on contact (hazards, spiked banks) → how hard they throw the raft. */
  harmful: Map<number, number>;
  checkpointCount: number;
  /** Where a raft reappears after a wipeout, before its lane offset: the start, then each gate it passes. */
  respawnAt: Pose[];
  tick: number;
  difficulty: Difficulty;
  tuning: Tuning;
};

export type SimOptions = { difficulty?: Difficulty; contact?: Contact };

/** Rapier ships as WASM. Call once before createSim, in the browser and in Node. */
export const initPhysics = (): Promise<void> => RAPIER.init();

// Rapier collision groups: membership in the high 16 bits, filter in the low 16. Rafts are in
// RAFT_GROUP; a ghost raft filters that group out, so it meets everything except other rafts.
const RAFT_GROUP = 0x0001;
const SOLID_GROUPS = (RAFT_GROUP << 16) | 0xffff;
const GHOST_GROUPS = (RAFT_GROUP << 16) | (0xffff & ~RAFT_GROUP);

/**
 * `crews` is one zone layout per raft (`crewZones(n)` for a crew of n, humans and bots); co-op is
 * one raft. The difficulty (default chill) picks the hazard clock and the wipeout timings from
 * `DIFFICULTY`; `contact` (default ghost) whether rafts collide.
 */
export function createSim(
  level: LevelData,
  crews: readonly (readonly Zone[])[] = [crewZones(MAX_CREW)],
  { difficulty = DEFAULT_DIFFICULTY, contact = "ghost" }: SimOptions = {},
): Sim {
  const tuning = DIFFICULTY[difficulty];
  const world = new RAPIER.World({ x: 0, y: 0 }); // top-down: no gravity, water drag comes from damping
  world.timestep = STEP;
  const { checkpointByHandle, spikeHandles } = buildLevel(world, level);
  const hazards = level.hazards.map((def) => createHazard(world, def));
  const racers = crews.map((zones, i): Racer => {
    const at = lane(level.spawn, i, crews.length);
    const raft = createRaft(world, at, zones, walkSpeed(difficulty, zones.length));
    const racer = { raft, health: freshHealth(), phase: initialPhase(), onPad: -1, solid: false };
    setSolid(racer, contact === "bump");
    return racer;
  });
  return {
    world,
    eventQueue: new RAPIER.EventQueue(true),
    racers,
    racerByCollider: new Map(racers.map((r, i) => [r.raft.collider.handle, i])),
    contact,
    channel: level.channel,
    stream: level.channel ? sampleChannel(level.channel) : null,
    hazards,
    boosts: level.boosts ?? [],
    // Hazard time runs at the difficulty's rate for each kind: the clock `hazardTime` gives bots and renderer.
    hazardSteps: level.hazards.map((def) => STEP * hazardRate(difficulty, def.kind)),
    checkpointByHandle,
    harmful: new Map([
      ...[...spikeHandles].map((h) => [h, 1] as const),
      ...hazards.flatMap((h) => h.colliderHandles.map((c) => [c, h.knock] as const)),
    ]),
    checkpointCount: level.checkpoints.length,
    respawnAt: respawnPoses(level, tuning.respawnBack),
    tick: 0,
    difficulty,
    tuning,
  };
}

/**
 * The only entry point the client and the server call. One fixed tick. `inputs` is flat: raft 0's
 * riders in seat order, then raft 1's, and so on.
 */
export function step(sim: Sim, inputs: readonly SeatInput[]): SimEvent[] {
  const events: SimEvent[] = [];
  const counting = sim.racers[0]?.phase.kind === "countdown";
  for (const racer of sim.racers) racer.phase = tickPhase(racer.phase, sim.tick);
  if (counting && sim.racers[0]!.phase.kind === "racing") events.push({ type: "go" });

  // Every raft acts on the same start-of-tick state, so the outcome never depends on raft order:
  // inputs first (rival blasts are only collected), then every respawn spot, then drag and boost,
  // and the blasts land last.
  const blasts: Blast[] = [];
  let seat = 0;
  sim.racers.forEach((racer, i) => {
    const { raft, health } = racer;
    const own = inputs.slice(seat, seat + raft.zones.length);
    seat += raft.zones.length;
    // A wiped-out crew tumbles helplessly until it respawns: no walking, no farting.
    if (health.respawnIn === 0) {
      const from = events.length;
      applyInputs(raft, i, own, racer.phase.kind === "racing", events);
      collectBlasts(sim, i, events.slice(from), blasts);
    }
  });
  const spots = sim.racers.map((racer, i) =>
    tickHealth(racer.health, sim.tuning) ? respawnSpot(sim, i) : null,
  );
  spots.forEach((at, i) => {
    if (!at) return;
    placeRaft(sim.racers[i]!.raft, at);
    events.push({ type: "respawn", raft: i, x: at.x, y: at.y });
  });
  sim.racers.forEach((racer, i) => {
    const racing = racer.phase.kind === "racing";
    applyWaterDrag(racer.raft, racing ? flowAt(sim, racer.raft.body.translation()) : STILL);
    if (racing && racer.health.respawnIn === 0) boost(sim, i, events);
  });
  // A raft that has just reappeared is dead still: a blast aimed at where it was does not move it.
  for (const { to, impulse } of blasts)
    if (!spots[to]) sim.racers[to]!.raft.body.applyImpulse(impulse, true);
  sim.hazards.forEach((hazard, i) => hazard.update(sim.hazardSteps[i]!));
  if (sim.contact === "bump") sim.racers.forEach((_, i) => updateSolid(sim, i));

  sim.world.step(sim.eventQueue);
  // A fast hazard (a piston's punch) can strike and bounce the raft clear within one step, so a
  // contact that started this tick counts as well as one that is still touching.
  const struck: (number | null)[] = sim.racers.map(() => null);
  sim.eventQueue.drainCollisionEvents((h1, h2, started) => {
    if (!started) return;
    const a = sim.racerByCollider.get(h1);
    const b = sim.racerByCollider.get(h2);
    if (a !== undefined && b !== undefined) {
      events.push(bump(sim, a, true), bump(sim, b, true));
      return;
    }
    const i = a ?? b;
    if (i === undefined) return;
    const other = a === undefined ? h1 : h2;
    const racer = sim.racers[i]!;
    const checkpoint = sim.checkpointByHandle.get(other);
    if (checkpoint !== undefined) {
      racer.phase = reachCheckpoint(
        racer.phase,
        checkpoint,
        sim.checkpointCount,
        sim.tick,
        i,
        events,
      );
      return;
    }
    if (sim.harmful.has(other)) struck[i] = other;
    events.push(bump(sim, i, false));
  });

  // Touching a hazard or a spiked bank wipes the crew out; the knock sends it tumbling. A rival
  // raft is never harmful, so in Bump only hazards and spikes wipe a crew out.
  sim.racers.forEach((racer, i) => {
    const { raft, health, phase } = racer;
    if (phase.kind !== "racing" || health.respawnIn > 0 || health.invulnerable > 0) return;
    const hit = touchingHarm(sim, raft) ?? strike(sim, raft, struck[i]!);
    const at = raft.body.translation();
    if (hit && takeHit(phase, health, sim.tuning, at, hit.away, i, events))
      knockBack(raft, hit.away, hit.knock);
  });

  sim.tick++;
  return events;
}

function bump(sim: Sim, i: number, rival: boolean): SimEvent {
  const { body } = sim.racers[i]!.raft;
  const { x, y } = body.translation();
  const v = body.linvel();
  return { type: "bump", raft: i, x, y, speed: Math.hypot(v.x, v.y), rival };
}

/** Where raft `i` of `n` sits across `at`: side by side, TEAM_SPACING apart, centered on it, raft 0 on the left. */
function lane(at: Pose, i: number, n: number): Pose {
  const left = ((n - 1) / 2 - i) * TEAM_SPACING;
  return { x: at.x - Math.sin(at.rot) * left, y: at.y + Math.cos(at.rot) * left, rot: at.rot };
}

function setSolid(racer: Racer, solid: boolean): void {
  racer.solid = solid;
  racer.raft.collider.setCollisionGroups(solid ? SOLID_GROUPS : GHOST_GROUPS);
}

/** Is raft `i` (or a spot `p` for it) at least a hull's width clear of every rival? */
function clearOfRivals(sim: Sim, i: number, p: Vec2 = sim.racers[i]!.raft.body.translation()) {
  return sim.racers.every((rival, j) => {
    if (j === i) return true;
    const r = rival.raft.body.translation();
    return Math.hypot(r.x - p.x, r.y - p.y) >= 2 * RAFT_HULL;
  });
}

/**
 * Bump race: a raft in its respawn grace passes through rivals, and turns solid again only once
 * it is clear of them, so the grace never ends with two hulls inside each other. A raft that has
 * finished is done racing: it parks on the line as a ghost, so the rafts still racing pass through
 * it and its farts shove nobody.
 */
function updateSolid(sim: Sim, i: number): void {
  const racer = sim.racers[i]!;
  const solid =
    racer.phase.kind !== "finished" &&
    racer.health.invulnerable === 0 &&
    (racer.solid || clearOfRivals(sim, i));
  if (solid !== racer.solid) setSolid(racer, solid);
}

/** A rival blast on its way: raft `to` takes `impulse` once every raft's drag is done. */
type Blast = { to: number; impulse: Vec2 };

/**
 * Bump race: each tick of a fart burst also shoves solid rivals within RIVAL_REACH of the rider
 * away from it, at RIVAL_BLAST of the push on its own raft, fading with distance. A rider on the
 * far side of its raft is always out of reach, so only gas that blows at the rival counts.
 */
function collectBlasts(sim: Sim, i: number, farts: readonly SimEvent[], out: Blast[]): void {
  const racer = sim.racers[i]!;
  if (!racer.solid) return;
  const power = RIVAL_BLAST * FART_FORCE * STEP * crewPower(racer.raft.zones.length);
  for (const fart of farts) {
    if (fart.type !== "fart") continue;
    sim.racers.forEach((rival, j) => {
      if (j === i || !rival.solid) return;
      const c = rival.raft.body.translation();
      const dx = c.x - fart.x;
      const dy = c.y - fart.y;
      const d = Math.hypot(dx, dy);
      const gap = Math.max(0, d - RAFT_HULL);
      if (gap >= RIVAL_REACH) return;
      const k = (power * (1 - gap / RIVAL_REACH)) / d;
      out.push({ to: j, impulse: { x: dx * k, y: dy * k } });
    });
  }
}

/**
 * Raft `i`'s lane at the gate it respawns at. In Bump, a spot on top of a rival moves upstream
 * until it is clear, so a respawn never lands on the rival. Rivals count where they are now, not
 * where a raft respawning on the same tick is about to be, so neither raft is favoured.
 */
function respawnSpot(sim: Sim, i: number): Pose {
  const { phase } = sim.racers[i]!;
  const gate = sim.respawnAt[phase.kind === "racing" ? phase.nextCheckpoint : 0]!;
  const spot = (back: number) => lane(upstream(sim, gate, back), i, sim.racers.length);
  if (sim.contact === "ghost") return spot(0);
  for (let back = 0; back <= 2 * TEAM_SPACING; back += RESPAWN_NUDGE) {
    const at = spot(back);
    if (clearOfRivals(sim, i, at)) return at;
  }
  return spot(0);
}

/** How far (m) a blocked respawn spot moves upstream per try. */
const RESPAWN_NUDGE = 0.5;

/** `back` m upstream of `at`: along the channel when there is one, else straight back. */
function upstream(sim: Sim, at: Pose, back: number): Pose {
  if (back === 0) return at;
  if (sim.stream) {
    const p = pointAt(sim.stream, Math.max(0, nearestS(sim.stream, at) - back));
    return { x: p.x, y: p.y, rot: Math.atan2(p.ty, p.tx) };
  }
  return { x: at.x - Math.cos(at.rot) * back, y: at.y - Math.sin(at.rot) * back, rot: at.rot };
}

/** A raft on a boost pad speeds up along it; running onto one is a `boost` event. */
function boost(sim: Sim, raft: number, events: SimEvent[]): void {
  const racer = sim.racers[raft]!;
  const at = racer.raft.body.translation();
  const i = padAt(sim.boosts, at);
  if (i >= 0) {
    const pad = sim.boosts[i]!;
    boostRaft(racer.raft, pad);
    if (i !== racer.onPad)
      events.push({
        type: "boost",
        raft,
        x: at.x,
        y: at.y,
        dirX: Math.cos(pad.rot),
        dirY: Math.sin(pad.rot),
      });
  }
  racer.onPad = i;
}

/** Contact gaps up to this (m) count as touching: Rapier reports contacts a hair before impact. */
const TOUCH = 0.02;

/**
 * Is the raft touching a hazard or a spiked bank right now? Plain banks and rails do not count.
 * Returns the unit vector from the harmful thing to the raft and how hard it throws the raft.
 */
function touchingHarm(sim: Sim, raft: Raft): { away: Vec2; knock: number } | null {
  const { world, harmful } = sim;
  const at = raft.body.translation();
  let hit: { away: Vec2; knock: number } | null = null;
  world.contactPairsWith(raft.collider, (other) => {
    const knock = harmful.get(other.handle);
    if (hit || knock === undefined) return;
    world.narrowPhase.contactPair(raft.collider.handle, other.handle, world.bodies, (m) => {
      for (let i = 0; i < m.numContacts(); i++)
        if (m.contactDist(i) <= TOUCH) hit = { away: awayFrom(other, at), knock };
    });
  });
  return hit;
}

/** The hit from a harmful collider whose contact started this tick, if there was one. */
function strike(sim: Sim, raft: Raft, handle: number | null): { away: Vec2; knock: number } | null {
  if (handle === null) return null;
  const thing = sim.world.getCollider(handle);
  return { away: awayFrom(thing, raft.body.translation()), knock: sim.harmful.get(handle)! };
}

/** Unit vector from the closest point of `thing` to `p`; straight along +x if they coincide. */
function awayFrom(thing: RAPIER.Collider, p: Vec2): Vec2 {
  const near = thing.projectPoint(p, false)?.point ?? thing.translation();
  const dx = p.x - near.x;
  const dy = p.y - near.y;
  const len = Math.hypot(dx, dy);
  return len > 1e-6 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 };
}

const STILL = { x: 0, y: 0 };

/**
 * Respawn pose per "next checkpoint": index 0 is the start, index i a run-up `back` m
 * upstream of gate i − 1, facing downstream (on a course without a channel: back along the line
 * from the previous gate, facing the way the start does).
 */
function respawnPoses(level: LevelData, back: number): Pose[] {
  const stream = level.channel ? sampleChannel(level.channel) : null;
  const gates = level.checkpoints.slice(0, -1).map((gate, i): Pose => {
    if (stream) {
      const at = pointAt(stream, Math.max(0, nearestS(stream, gate) - back));
      return { x: at.x, y: at.y, rot: Math.atan2(at.ty, at.tx) };
    }
    const from = i === 0 ? level.spawn : level.checkpoints[i - 1]!;
    const dx = gate.x - from.x;
    const dy = gate.y - from.y;
    const k = Math.min(back, Math.hypot(dx, dy)) / (Math.hypot(dx, dy) || 1);
    return { x: gate.x - dx * k, y: gate.y - dy * k, rot: level.spawn.rot };
  });
  return [level.spawn, ...gates];
}

/** The current: downstream along the channel's centerline tangent, fast in rapids. It starts with the race. */
function flowAt(sim: Sim, p: Vec2): Vec2 {
  if (!sim.stream || !sim.channel) return STILL;
  const s = nearestS(sim.stream, p);
  const at = pointAt(sim.stream, s);
  const speed = flowSpeed(sim.channel, s);
  return { x: at.tx * speed, y: at.ty * speed };
}

function pose(body: RAPIER.RigidBody): Pose {
  const t = body.translation();
  return { x: t.x, y: t.y, rot: body.rotation() };
}

/** Plain, serializable view of the world. Render reads this (through `viewOf`); the server sends it. */
export function snapshot(sim: Sim): Snapshot {
  return {
    tick: sim.tick,
    difficulty: sim.difficulty,
    contact: sim.contact,
    hazards: sim.hazards.map((h) => ({ id: h.id, ...pose(h.body) })),
    crews: sim.racers.map(({ raft, health, phase }): Crew => ({
      raft: pose(raft.body),
      riders: raft.at.map(riderPose),
      gas: [...raft.gas],
      deaths: health.deaths,
      respawnIn: health.respawnIn,
      invulnerable: health.invulnerable,
      phase,
    })),
  };
}
