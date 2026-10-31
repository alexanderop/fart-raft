import type { Crew, Snapshot, View } from "./types.ts";

/** Raft `raft`'s view of the race: its own crew at the top level, every other raft as a rival. */
export function viewOf(snapshot: Snapshot, raft: number): View {
  const { crews, ...race } = snapshot;
  return { ...race, ...crews[raft]!, rivals: crews.filter((_, i) => i !== raft) };
}

/** Every raft's view of the race, by raft index. Make them once per tick and share them. */
export const viewsOf = (snapshot: Snapshot): View[] =>
  snapshot.crews.map((_, raft) => viewOf(snapshot, raft));

/**
 * The race's winner: the first raft across the finish, "draw" when the first ones finished on the
 * same tick, null while nobody has finished. Every raft starts on the same tick, so equal finish
 * times mean the same tick.
 */
export function winnerOf(crews: readonly Crew[]): number | "draw" | null {
  let best = Infinity;
  let first: number[] = [];
  crews.forEach(({ phase }, i) => {
    if (phase.kind !== "finished" || phase.timeMs > best) return;
    first = phase.timeMs < best ? [i] : [...first, i];
    best = phase.timeMs;
  });
  if (first.length === 0) return null;
  return first.length === 1 ? first[0]! : "draw";
}
