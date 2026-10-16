import { COUNTDOWN_TICKS, STEP } from "./constants";
import type { Phase, SimEvent } from "./types";

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
