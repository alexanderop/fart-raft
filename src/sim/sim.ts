import RAPIER from "@dimforge/rapier2d-compat";
import { crewZones, MAX_CREW, RESPAWN_BACK, STEP, type Zone } from "./constants.ts";
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
  Channel,
  LevelData,
  Phase,
  Pose,
  SeatInput,
  SimEvent,
  Snapshot,
  Vec2,
} from "./types.ts";

export type Sim = {
  world: RAPIER.World;
  eventQueue: RAPIER.EventQueue;
  raft: Raft;
  /** The course's channel and its centerline samples, for the current. Null on still-water courses. */
  channel: Channel | null;
  stream: Sample[] | null;
  hazards: Hazard[];
  checkpointByHandle: Map<number, number>;
  /** Collider handles that wipe the crew out on contact (hazards, spiked banks) → how hard they throw the raft. */
  harmful: Map<number, number>;
  health: Health;
  checkpointCount: number;
  /** Where the raft reappears after a wipeout: the start, then each gate it passes. */
  respawnAt: Pose[];
  phase: Phase;
  tick: number;
};

/** Rapier ships as WASM. Call once before createSim, in the browser and in Node. */
export const initPhysics = (): Promise<void> => RAPIER.init();

/** `zones` is the crew layout from `crewZones(n)`, one zone per rider (human or bot). */
export function createSim(level: LevelData, zones: readonly Zone[] = crewZones(MAX_CREW)): Sim {
  const world = new RAPIER.World({ x: 0, y: 0 }); // top-down: no gravity, water drag comes from damping
  world.timestep = STEP;
  const { checkpointByHandle, spikeHandles } = buildLevel(world, level);
  const hazards = level.hazards.map((def) => createHazard(world, def));
  return {
    world,
    eventQueue: new RAPIER.EventQueue(true),
    raft: createRaft(world, level.spawn, zones),
    channel: level.channel,
    stream: level.channel ? sampleChannel(level.channel) : null,
    hazards,
    checkpointByHandle,
    harmful: new Map([
      ...[...spikeHandles].map((h) => [h, 1] as const),
      ...hazards.flatMap((h) => h.colliderHandles.map((c) => [c, h.knock] as const)),
    ]),
    health: freshHealth(),
    checkpointCount: level.checkpoints.length,
    respawnAt: respawnPoses(level),
    phase: initialPhase(),
    tick: 0,
  };
}

/** The only entry point the client (and later the server) calls. One fixed tick. */
export function step(sim: Sim, inputs: readonly SeatInput[]): SimEvent[] {
  const events: SimEvent[] = [];
  sim.phase = tickPhase(sim.phase, sim.tick, events);
  const racing = sim.phase.kind === "racing";
  // A wiped-out crew tumbles helplessly until it respawns: no walking, no farting.
  if (sim.health.respawnIn === 0) applyInputs(sim.raft, inputs, racing, events);
  if (tickHealth(sim.health)) {
    const next = sim.phase.kind === "racing" ? sim.phase.nextCheckpoint : 0;
    const at = sim.respawnAt[next]!;
    placeRaft(sim.raft, at);
    events.push({ type: "respawn", x: at.x, y: at.y });
  }
  applyWaterDrag(sim.raft, racing ? flowAt(sim, sim.raft.body.translation()) : STILL);
  for (const hazard of sim.hazards) hazard.update(STEP);

  sim.world.step(sim.eventQueue);
  // A fast hazard (a piston's punch) can strike and bounce the raft clear within one step, so a
  // contact that started this tick counts as well as one that is still touching.
  let struck: number | null = null;
  sim.eventQueue.drainCollisionEvents((h1, h2, started) => {
    if (!started) return;
    const other =
      h1 === sim.raft.collider.handle ? h2 : h2 === sim.raft.collider.handle ? h1 : null;
    if (other === null) return;
    const checkpoint = sim.checkpointByHandle.get(other);
    if (checkpoint !== undefined) {
      sim.phase = reachCheckpoint(sim.phase, checkpoint, sim.checkpointCount, sim.tick, events);
      return;
    }
    if (sim.harmful.has(other)) struck = other;
    const { x, y } = sim.raft.body.translation();
    const v = sim.raft.body.linvel();
    events.push({ type: "bump", x, y, speed: Math.hypot(v.x, v.y) });
  });

  // Touching a hazard or a spiked bank wipes the crew out; the knock sends it tumbling.
  if (sim.phase.kind === "racing" && sim.health.respawnIn === 0 && sim.health.invulnerable === 0) {
    const hit = touchingHarm(sim) ?? strike(sim, struck);
    if (hit && takeHit(sim.phase, sim.health, sim.raft.body.translation(), hit.away, events))
      knockBack(sim.raft, hit.away, hit.knock);
  }

  sim.tick++;
  return events;
}

/** Contact gaps up to this (m) count as touching: Rapier reports contacts a hair before impact. */
const TOUCH = 0.02;

/**
 * Is the raft touching a hazard or a spiked bank right now? Plain banks and rails do not count.
 * Returns the unit vector from the harmful thing to the raft and how hard it throws the raft.
 */
function touchingHarm(sim: Sim): { away: Vec2; knock: number } | null {
  const { world, raft, harmful } = sim;
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
function strike(sim: Sim, handle: number | null): { away: Vec2; knock: number } | null {
  if (handle === null) return null;
  const thing = sim.world.getCollider(handle);
  return { away: awayFrom(thing, sim.raft.body.translation()), knock: sim.harmful.get(handle)! };
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
 * Respawn pose per "next checkpoint": index 0 is the start, index i a run-up RESPAWN_BACK m
 * upstream of gate i − 1, facing downstream (on a course without a channel: back along the line
 * from the previous gate, facing the way the start does).
 */
function respawnPoses(level: LevelData): Pose[] {
  const stream = level.channel ? sampleChannel(level.channel) : null;
  const gates = level.checkpoints.slice(0, -1).map((gate, i): Pose => {
    if (stream) {
      const at = pointAt(stream, Math.max(0, nearestS(stream, gate) - RESPAWN_BACK));
      return { x: at.x, y: at.y, rot: Math.atan2(at.ty, at.tx) };
    }
    const from = i === 0 ? level.spawn : level.checkpoints[i - 1]!;
    const dx = gate.x - from.x;
    const dy = gate.y - from.y;
    const back = Math.min(RESPAWN_BACK, Math.hypot(dx, dy)) / (Math.hypot(dx, dy) || 1);
    return { x: gate.x - dx * back, y: gate.y - dy * back, rot: level.spawn.rot };
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

/** Plain, serializable view of the world. Render reads this; the server will send it. */
export function snapshot(sim: Sim): Snapshot {
  return {
    tick: sim.tick,
    raft: pose(sim.raft.body),
    riders: sim.raft.at.map(riderPose),
    gas: [...sim.raft.gas],
    deaths: sim.health.deaths,
    respawnIn: sim.health.respawnIn,
    invulnerable: sim.health.invulnerable,
    hazards: sim.hazards.map((h) => ({ id: h.id, ...pose(h.body) })),
    phase: sim.phase,
  };
}
