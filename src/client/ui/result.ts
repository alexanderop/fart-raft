import { TICK_RATE } from "../../sim/constants.ts";
import type { Crew } from "../../sim/types.ts";
import { winnerOf } from "../../sim/view.ts";

/** A raft's race clock at `tick`, ms: 0 in the countdown, frozen once it finished. */
export function raceTime(crew: Pick<Crew, "phase">, tick: number): number {
  const { phase } = crew;
  if (phase.kind === "countdown") return 0;
  if (phase.kind === "finished") return phase.timeMs;
  return ((tick - phase.startTick) / TICK_RATE) * 1000;
}

/** One raft's line on the result: its time so far (final once `finished`) and its wipeouts. */
export type ResultRow = { raft: number; timeMs: number; finished: boolean; deaths: number };

/**
 * A team race's result once a raft has finished: who won (or "draw"), how far behind the
 * runner-up is (growing live while it still races, fixed once it finishes), and every raft's
 * line. `settled` once every raft has finished. Null before anyone finishes.
 */
export type TeamResult = {
  winner: number | "draw";
  gapMs: number;
  settled: boolean;
  rows: ResultRow[];
};

export function teamResult(crews: readonly Crew[], tick: number): TeamResult | null {
  const winner = winnerOf(crews);
  if (winner === null) return null;
  const rows = crews.map((crew, raft) => ({
    raft,
    timeMs: raceTime(crew, tick),
    finished: crew.phase.kind === "finished",
    deaths: crew.deaths,
  }));
  const best = Math.min(...rows.filter((r) => r.finished).map((r) => r.timeMs));
  const others = rows.filter((r) => !(r.finished && r.timeMs === best));
  const runnerUp = others.length === 0 ? best : Math.min(...others.map((r) => r.timeMs));
  return {
    winner,
    gapMs: Math.max(0, runnerUp - best),
    settled: rows.every((r) => r.finished),
    rows,
  };
}
