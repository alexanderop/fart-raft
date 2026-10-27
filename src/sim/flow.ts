import { COUNTDOWN_TICKS, INVULNERABLE_TICKS, LIVES, STEP } from "./constants.ts";
import type { Phase, SimEvent } from "./types.ts";

// State pattern, smallest form: a union plus a switch. Each phase carries only the data it needs.

export const initialPhase = (): Phase => ({ kind: "countdown", ticksLeft: COUNTDOWN_TICKS });

export function tickPhase(phase: Phase, tick: number, events: SimEvent[]): Phase {
  switch (phase.kind) {
    case "countdown":
      if (phase.ticksLeft > 1) return { kind: "countdown", ticksLeft: phase.ticksLeft - 1 };
      events.push({ type: "go" });
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
  events: SimEvent[],
): Phase {
  if (phase.kind !== "racing" || index !== phase.nextCheckpoint) return phase;
  if (index === total - 1) {
    const timeMs = Math.round((tick - phase.startTick) * STEP * 1000);
    events.push({ type: "finished", timeMs });
    return { kind: "finished", timeMs };
  }
  events.push({ type: "checkpoint", index });
  return { ...phase, nextCheckpoint: index + 1 };
}

/** What the crew has left: lives, and the ticks of grace after the last hit. */
export type Health = { lives: number; invulnerable: number };

export const freshHealth = (): Health => ({ lives: LIVES, invulnerable: 0 });

/** The crew was hit. Costs a life unless it is racing and still in the grace window. */
export function takeHit(
  phase: Phase,
  health: Health,
  tick: number,
  at: { x: number; y: number },
  /** Unit vector from the hazard to the raft: the way the hit throws it. */
  away: { x: number; y: number },
  events: SimEvent[],
): Phase {
  if (phase.kind !== "racing" || health.invulnerable > 0) return phase;
  health.lives--;
  health.invulnerable = INVULNERABLE_TICKS;
  events.push({
    type: "lifeLost",
    lives: health.lives,
    x: at.x,
    y: at.y,
    dirX: away.x,
    dirY: away.y,
  });
  if (health.lives > 0) return phase;
  const timeMs = Math.round((tick - phase.startTick) * STEP * 1000);
  events.push({ type: "died", timeMs });
  return { kind: "dead", timeMs, nextCheckpoint: phase.nextCheckpoint };
}
