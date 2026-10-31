import { TEAMS } from "../net/protocol.ts";
import { COSTUMES, defaultLook, LOOK_COLORS, type Look } from "../look.ts";

/** Each team's look color (an index into LOOK_COLORS), by raft: Red, then Blue. */
const TEAM_LOOK_COLORS: readonly number[] = [7, 1];
const TEAM_NAMES: readonly string[] = TEAMS;

/** A team race's raft colors, by raft index (= team). */
export const TEAM_COLORS: readonly string[] = TEAM_LOOK_COLORS.map((i) => LOOK_COLORS[i]!);

export const teamName = (raft: number): string => TEAM_NAMES[raft] ?? `Raft ${raft + 1}`;
export const teamColor = (raft: number): string => TEAM_COLORS[raft] ?? "#ffffff";

const PIRATE = COSTUMES.find((c) => c.label.includes("Pirate"))!;

/** The offline bot crew on raft `raft`: pirates in their team's color, so they never pass for yours. */
export const botCrewLook = (raft: number, seat: number): Look => ({
  ...defaultLook(seat),
  color: TEAM_LOOK_COLORS[raft] ?? TEAM_LOOK_COLORS[1]!,
  hat: PIRATE.hat,
  outfit: PIRATE.outfit,
  gadget: PIRATE.gadget,
});
