import { COUNTDOWN_TICKS, STEP, type Tuning } from "./constants.ts";
import type { Phase, SimEvent } from "./types.ts";

// State pattern, smallest form: a union plus a switch. Each phase carries only the data it needs.

export const initialPhase = (): Phase => ({ kind: "countdown", ticksLeft: COUNTDOWN_TICKS });

/** Every raft counts down in lockstep, so the race's one `go` event is the step's to emit. */
export function tickPhase(phase: Phase, tick: number): Phase {
  switch (phase.kind) {
    case "countdown":
      if (phase.ticksLeft > 1) return { kind: "countdown", ticksLeft: phase.ticksLeft - 1 };
      return { kind: "racing", startTick: tick, nextCheckpoint: 0 };
    default:
      return phase;
  }
}

export function reachCheckpoint(
  phase: Phase,
  index: number,
  total: number,
  tick: number,
  raft: number,
  events: SimEvent[],
): Phase {
  if (phase.kind !== "racing" || index !== phase.nextCheckpoint) return phase;
  if (index === total - 1) {
    const timeMs = Math.round((tick - phase.startTick) * STEP * 1000);
    events.push({ type: "finished", raft, timeMs });
    return { kind: "finished", timeMs };
  }
  events.push({ type: "checkpoint", raft, index });
  return { ...phase, nextCheckpoint: index + 1 };
}

/** The crew's record: wipeouts so far, and where it is in the wipeout → respawn → grace cycle. */
export type Health = { deaths: number; respawnIn: number; invulnerable: number };

export const freshHealth = (): Health => ({ deaths: 0, respawnIn: 0, invulnerable: 0 });

/** The crew was hit: a wipeout, unless it is not racing, already wiped out, or in its grace window. */
export function takeHit(
  phase: Phase,
  health: Health,
  tuning: Tuning,
  at: { x: number; y: number },
  /** Unit vector from the hazard to the raft: the way the hit throws it. */
  away: { x: number; y: number },
  raft: number,
  events: SimEvent[],
): boolean {
  if (phase.kind !== "racing" || health.respawnIn > 0 || health.invulnerable > 0) return false;
  health.deaths++;
  health.respawnIn = tuning.respawnTicks;
  events.push({
    type: "hit",
    raft,
    deaths: health.deaths,
    x: at.x,
    y: at.y,
    dirX: away.x,
    dirY: away.y,
  });
  return true;
}

/** One tick of the wipeout cycle. True on the tick the raft should reappear at its last gate. */
export function tickHealth(health: Health, tuning: Tuning): boolean {
  health.invulnerable = Math.max(0, health.invulnerable - 1);
  if (health.respawnIn === 0) return false;
  health.respawnIn--;
  if (health.respawnIn > 0) return false;
  health.invulnerable = tuning.invulnerableTicks;
  return true;
}
