import RAPIER from "@dimforge/rapier2d-compat";
import { CURRENT_SPEED, crewZones, MAX_CREW, STEP, type Zone } from "./constants";
import { nearestS, pointAt, sampleChannel, type Sample } from "./channel";
import { initialPhase, reachCheckpoint, tickPhase } from "./flow";
import { createHazard, type Hazard } from "./hazards";
import { buildLevel } from "./level";
import { applyInputs, applyWaterDrag, createRaft, riderPose, type Raft } from "./raft";
import type { LevelData, Phase, Pose, SeatInput, SimEvent, Snapshot, Vec2 } from "./types";

export type Sim = {
  world: RAPIER.World;
  eventQueue: RAPIER.EventQueue;
  raft: Raft;
  /** Centerline samples of the course's channel, for the current. Null on still-water courses. */
  stream: Sample[] | null;
  hazards: Hazard[];
  checkpointByHandle: Map<number, number>;
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
  return {
    world,
    eventQueue: new RAPIER.EventQueue(true),
    raft: createRaft(world, level.spawn, zones),
    stream: level.channel ? sampleChannel(level.channel) : null,
    hazards: level.hazards.map((def) => createHazard(world, def)),
    checkpointByHandle: buildLevel(world, level),
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
  applyInputs(sim.raft, inputs, racing, events);
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

  sim.tick++;
  return events;
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
    hazards: sim.hazards.map((h) => ({ id: h.id, ...pose(h.body) })),
    phase: sim.phase,
  };
}
