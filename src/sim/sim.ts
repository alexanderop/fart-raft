import RAPIER from "@dimforge/rapier2d-compat";
import { CURRENT_SPEED, crewZones, MAX_CREW, STEP, type Zone } from "./constants.ts";
import { nearestS, pointAt, sampleChannel, type Sample } from "./channel.ts";
import {
  freshHealth,
  initialPhase,
  reachCheckpoint,
  takeHit,
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
  riderPose,
  type Raft,
} from "./raft.ts";
import type { LevelData, Phase, Pose, SeatInput, SimEvent, Snapshot, Vec2 } from "./types.ts";

export type Sim = {
  world: RAPIER.World;
  eventQueue: RAPIER.EventQueue;
  raft: Raft;
  /** Centerline samples of the course's channel, for the current. Null on still-water courses. */
  stream: Sample[] | null;
  hazards: Hazard[];
  checkpointByHandle: Map<number, number>;
  /** Collider handles that cost a life on contact (hazards, spiked banks) → how hard they throw the raft. */
  harmful: Map<number, number>;
  health: Health;
  checkpointCount: number;
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
    stream: level.channel ? sampleChannel(level.channel) : null,
    hazards,
    checkpointByHandle,
    harmful: new Map([
      ...[...spikeHandles].map((h) => [h, 1] as const),
      ...hazards.map((h) => [h.colliderHandle, h.knock] as const),
    ]),
    health: freshHealth(),
    checkpointCount: level.checkpoints.length,
    phase: initialPhase(),
    tick: 0,
  };
}

/** The only entry point the client (and later the server) calls. One fixed tick. */
export function step(sim: Sim, inputs: readonly SeatInput[]): SimEvent[] {
  const events: SimEvent[] = [];
  sim.phase = tickPhase(sim.phase, sim.tick, events);
  const racing = sim.phase.kind === "racing";
  // A sunk raft ignores its crew: no walking, no farting.
  if (sim.phase.kind !== "dead") applyInputs(sim.raft, inputs, racing, events);
  sim.health.invulnerable = Math.max(0, sim.health.invulnerable - 1);
  applyWaterDrag(sim.raft, racing ? flowAt(sim, sim.raft.body.translation()) : STILL);
  for (const hazard of sim.hazards) hazard.update(STEP);

  sim.world.step(sim.eventQueue);
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
    const { x, y } = sim.raft.body.translation();
    const v = sim.raft.body.linvel();
    events.push({ type: "bump", x, y, speed: Math.hypot(v.x, v.y) });
  });

  // A raft pressed against a hazard keeps getting hurt, once per grace window.
  if (sim.phase.kind === "racing" && sim.health.invulnerable === 0) {
    const hit = touchingHarm(sim);
    if (hit) {
      sim.phase = takeHit(
        sim.phase,
        sim.health,
        sim.tick,
        sim.raft.body.translation(),
        hit.away,
        events,
      );
      knockBack(sim.raft, hit.away, hit.knock);
    }
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

/** Unit vector from the closest point of `thing` to `p`; straight along +x if they coincide. */
function awayFrom(thing: RAPIER.Collider, p: Vec2): Vec2 {
  const near = thing.projectPoint(p, false)?.point ?? thing.translation();
  const dx = p.x - near.x;
  const dy = p.y - near.y;
  const len = Math.hypot(dx, dy);
  return len > 1e-6 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 };
}

const STILL = { x: 0, y: 0 };

/** The current: downstream along the channel's centerline tangent. It starts with the race. */
function flowAt(sim: Sim, p: Vec2): Vec2 {
  if (!sim.stream) return STILL;
  const at = pointAt(sim.stream, nearestS(sim.stream, p));
  return { x: at.tx * CURRENT_SPEED, y: at.ty * CURRENT_SPEED };
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
    lives: sim.health.lives,
    invulnerable: sim.health.invulnerable,
    hazards: sim.hazards.map((h) => ({ id: h.id, ...pose(h.body) })),
    phase: sim.phase,
  };
}
