import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { DIFFICULTIES, MAX_CREW } from "../sim/constants.ts";
import type * as Sim from "../sim/types.ts";
import { ANIMALS, GADGETS, HATS, LOOK_COLORS, OUTFITS, type Look as LookData } from "../look.ts";

// Wire schemas for the sim's plain-data types. Shared by the browser and the server, so no DOM
// and no Node here. `Drift` below fails the typecheck when src/sim/types.ts and these diverge.

/** The server broadcasts a Frame every this many sim ticks: 20 Hz on the wire, 60 Hz in the sim. */
export const FRAME_TICKS = 3;

const Num = Schema.Finite;

const Vec2 = Schema.Struct({ x: Num, y: Num });
const Pose = Schema.Struct({ x: Num, y: Num, rot: Num });
const RiderPose = Schema.Struct({ x: Num, y: Num, face: Num });

export const SeatIndex = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_CREW - 1 }));

export const SeatInput = Schema.Struct({ move: Vec2, fart: Schema.Boolean });

const Phase = Schema.Union([
  Schema.Struct({ kind: Schema.tag("countdown"), ticksLeft: Num }),
  Schema.Struct({ kind: Schema.tag("racing"), startTick: Num, nextCheckpoint: Num }),
  Schema.Struct({ kind: Schema.tag("finished"), timeMs: Num }),
]);

/** How hard a race plays: "chill" (slower hazards, more forgiving) or "wild" (full speed). */
export const Difficulty = Schema.Literals(DIFFICULTIES);
export const isDifficulty = Schema.is(Difficulty);

/** How the rafts in a race meet: "ghost" (pass through) or "bump" (collide). */
export const Contact = Schema.Literals(["ghost", "bump"]);

/** Which raft in `Snapshot.crews` an event happened to. */
const RaftIndex = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const Crew = Schema.Struct({
  raft: Pose,
  riders: Schema.mutable(Schema.Array(RiderPose)),
  gas: Schema.mutable(Schema.Array(Num)),
  deaths: Num,
  respawnIn: Num,
  invulnerable: Num,
  phase: Phase,
});

export const Snapshot = Schema.Struct({
  tick: Num,
  difficulty: Difficulty,
  contact: Contact,
  hazards: Schema.mutable(
    Schema.Array(Schema.Struct({ id: Schema.String, x: Num, y: Num, rot: Num })),
  ),
  crews: Schema.mutable(Schema.Array(Crew)),
});

export const SimEvent = Schema.Union([
  Schema.Struct({
    type: Schema.tag("fart"),
    raft: RaftIndex,
    seat: SeatIndex,
    x: Num,
    y: Num,
    dirX: Num,
    dirY: Num,
  }),
  Schema.Struct({
    type: Schema.tag("bump"),
    raft: RaftIndex,
    x: Num,
    y: Num,
    speed: Num,
    rival: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.tag("go") }),
  Schema.Struct({ type: Schema.tag("checkpoint"), raft: RaftIndex, index: Num }),
  Schema.Struct({ type: Schema.tag("finished"), raft: RaftIndex, timeMs: Num }),
  Schema.Struct({
    type: Schema.tag("hit"),
    raft: RaftIndex,
    deaths: Num,
    x: Num,
    y: Num,
    dirX: Num,
    dirY: Num,
  }),
  Schema.Struct({ type: Schema.tag("respawn"), raft: RaftIndex, x: Num, y: Num }),
  Schema.Struct({
    type: Schema.tag("boost"),
    raft: RaftIndex,
    x: Num,
    y: Num,
    dirX: Num,
    dirY: Num,
  }),
]);

/** Courses a room can race. The client and the server both map these names to course JSON. */
export const COURSES = ["canyon", "graveyard", "pond"] as const;
export const CourseName = Schema.Literals(COURSES);
export type CourseName = typeof CourseName.Type;
export const isCourseName = Schema.is(CourseName);

/** Four letters without look-alikes (no I, L, O), so a code read out loud is typed right. */
export const CODE_LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ";
export const CODE_LENGTH = 4;
export const RoomCode = Schema.String.check(
  Schema.isPattern(new RegExp(`^[${CODE_LETTERS}]{${CODE_LENGTH}}$`)),
);

export const MAX_NAME = 16;
export const PlayerName = Schema.String.check(Schema.isMaxLength(MAX_NAME));

/** Animal, color, hat, outfit and gadget: cosmetic only, the sim never sees it. */
export const Look = Schema.Struct({
  animal: Schema.Literals(ANIMALS),
  color: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: LOOK_COLORS.length - 1 })),
  hat: Schema.Literals(HATS),
  outfit: Schema.Literals(OUTFITS),
  gadget: Schema.Literals(GADGETS),
});

/**
 * How a room races: "coop" puts everyone on one raft, "ghost" and "bump" split the room into two
 * teams with a raft each (rafts pass through each other, or collide).
 */
export const MODES = ["coop", "ghost", "bump"] as const;
export const RoomMode = Schema.Literals(MODES);
export type RoomMode = typeof RoomMode.Type;
export const isRoomMode = Schema.is(RoomMode);

/** The two teams of a team room; a team's number is also its raft's index in `Snapshot.crews`. */
export const TEAMS = ["Red", "Blue"] as const;
export const Team = Schema.Literals([0, 1]);
export type Team = typeof Team.Type;
/** Players on one team at most, so a room (`MAX_CREW`) always splits into two full teams. */
export const MAX_TEAM = 4;

export const isTeamMode = (mode: RoomMode): boolean => mode !== "coop";

/** The sim's contact for a room mode: only "bump" makes rafts collide. */
export const contactOf = (mode: RoomMode): typeof Contact.Type =>
  mode === "bump" ? "bump" : "ghost";

/**
 * How long a seat whose connection dropped is held for its player to come back (`Join` with
 * `resume`). Long enough for a Wi-Fi blip or a phone waking up, short enough that a player who is
 * gone for good frees the seat before the lobby's room sweep (two empty 30 s sweeps) closes the room.
 */
export const RECONNECT_GRACE_MS = 20_000;

/**
 * A seated player as everyone sees them. Every player has a team, even in a co-op room (which
 * ignores it), so a host who switches the room to a team mode finds the room already split.
 * `away`: their connection dropped and the seat is held for `RECONNECT_GRACE_MS`.
 */
export const Player = Schema.Struct({
  name: Schema.String,
  look: Look,
  team: Team,
  away: Schema.Boolean,
});
export type Player = typeof Player.Type;

/**
 * One rider in the current race. `seat` is null once its player has left: the rider idles in
 * the look it had.
 */
export const CrewMember = Schema.Struct({
  name: Schema.String,
  seat: Schema.NullOr(SeatIndex),
  look: Look,
  /** The raft this rider is on: its team in a team race, always 0 in co-op. */
  raft: RaftIndex,
});

/** Who is in the room. `seats[i]` is a player, or null for an open seat. */
export const Roster = Schema.Struct({
  code: RoomCode,
  course: CourseName,
  difficulty: Difficulty,
  /** How the next race is raced: the host can change it any time, a race under way keeps its own. */
  mode: RoomMode,
  seats: Schema.mutable(Schema.Array(Schema.NullOr(Player))),
  /** The human who can start the race: whoever connected has been in the room longest. */
  host: Schema.NullOr(SeatIndex),
  started: Schema.Boolean,
  /**
   * `crew[i]` drives the i-th rider in the sim's flat order for the current race: the humans
   * seated when it started. Co-op: seat order on raft 0. Team race: Red's riders in seat order,
   * then Blue's. Empty in the lobby. A seated player missing here is spectating.
   */
  crew: Schema.mutable(Schema.Array(CrewMember)),
});
export type Roster = typeof Roster.Type;

/**
 * Where `seat` rides in the current race: its raft and its rider index within that raft (the
 * `seat` of that rider's `fart` events). Null while it is spectating (or in the lobby).
 */
export const placeOf = (roster: Roster, seat: number): { raft: number; rider: number } | null => {
  const i = roster.crew.findIndex((c) => c.seat === seat);
  if (i < 0) return null;
  const raft = roster.crew[i]!.raft;
  return { raft, rider: roster.crew.slice(0, i).filter((c) => c.raft === raft).length };
};

/**
 * The raft `seat`'s camera follows in a frame of `rafts` crews: the one it rides, else (spectating)
 * its team's raft, else raft 0. The roster and the frames arrive separately, so a frame from before
 * a restart can have fewer rafts than the roster says: the choice is clamped to the frame.
 */
export const followedRaft = (roster: Roster, seat: number, rafts: number): number =>
  Math.max(0, Math.min(placeOf(roster, seat)?.raft ?? roster.seats[seat]?.team ?? 0, rafts - 1));

/** How many players are on `team`. */
export const teamSize = (roster: Pick<Roster, "seats">, team: Team): number =>
  roster.seats.filter((p) => p?.team === team).length;

/** Why the next race cannot start yet, or null when it can. The lobby shows it next to Start. */
export const startBlocker = (roster: Pick<Roster, "mode" | "seats">): string | null =>
  isTeamMode(roster.mode) && (teamSize(roster, 0) === 0 || teamSize(roster, 1) === 0)
    ? "Both teams need a rider"
    : null;

export const ServerMsg = Schema.TaggedUnion({
  /** `token` proves the seat: every RPC but CreateRoom and Join carries it. */
  Welcome: { seat: SeatIndex, token: Schema.String },
  Roster: { roster: Roster },
  /** Only once the race has started. */
  Frame: { snapshot: Snapshot, events: Schema.mutable(Schema.Array(SimEvent)) },
});
export type ServerMsg = typeof ServerMsg.Type;
export type Welcome = typeof ServerMsg.cases.Welcome.Type;
export type Frame = typeof ServerMsg.cases.Frame.Type;

export class RoomFull extends Schema.TaggedError<RoomFull>()("RoomFull", {}) {}
export class RoomNotFound extends Schema.TaggedError<RoomNotFound>()("RoomNotFound", {}) {}
export class ServerBusy extends Schema.TaggedError<ServerBusy>()("ServerBusy", {}) {}

const Seated = { code: RoomCode, token: Schema.String };

export const RaftRpcs = RpcGroup.make(
  Rpc.make("CreateRoom", {
    payload: { course: CourseName, difficulty: Difficulty, mode: RoomMode },
    success: RoomCode,
    error: ServerBusy,
  }),
  // The stream's lifetime is the seat lease: when it ends the seat is held, away, for
  // RECONNECT_GRACE_MS. `resume` is the token of a seat held for us: we take it back as it was.
  Rpc.make("Join", {
    payload: {
      code: RoomCode,
      name: PlayerName,
      look: Look,
      resume: Schema.optional(Schema.String),
    },
    success: ServerMsg,
    error: Schema.Union([RoomFull, RoomNotFound]),
    stream: true,
  }),
  Rpc.make("SendInput", { payload: { ...Seated, input: SeatInput } }),
  /** Gives the seat up now, instead of holding it away for a reconnect. */
  Rpc.make("Leave", { payload: Seated }),
  /** Host only: leave the lobby and start the countdown. */
  Rpc.make("Start", { payload: Seated }),
  /** Any seated player: a new race whose crew is everyone seated now. */
  Rpc.make("Restart", { payload: Seated }),
  /** Host only: end the race (under way or finished) and put the room back in its lobby. */
  Rpc.make("ToLobby", { payload: Seated }),
  /** Any seated player: change their look, in the lobby or mid-race. */
  Rpc.make("SetLook", { payload: { ...Seated, look: Look } }),
  /**
   * Any seated player: ride the next race on `team`, in the lobby or mid-race. Ignored when that
   * team already has `MAX_TEAM` players.
   */
  Rpc.make("SetTeam", { payload: { ...Seated, team: Team } }),
  /** Host only: how the next race is raced, in the lobby or mid-race. */
  Rpc.make("SetMode", { payload: { ...Seated, mode: RoomMode } }),
);

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;

export type Drift = [
  Expect<Same<typeof SeatInput.Type, Sim.SeatInput>>,
  Expect<Same<typeof Snapshot.Type, Sim.Snapshot>>,
  Expect<Same<typeof Crew.Type, Sim.Crew>>,
  Expect<Same<typeof Contact.Type, Sim.Contact>>,
  Expect<Same<typeof SimEvent.Type, Sim.SimEvent>>,
  Expect<Same<typeof Phase.Type, Sim.Phase>>,
  Expect<Same<typeof Pose.Type, Sim.Pose>>,
  Expect<Same<typeof RiderPose.Type, Sim.RiderPose>>,
  Expect<Same<typeof Difficulty.Type, Sim.Difficulty>>,
  Expect<Same<typeof Look.Type, LookData>>,
];
