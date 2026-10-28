import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { MAX_CREW } from "../sim/constants.ts";
import type * as Sim from "../sim/types.ts";

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

export const Snapshot = Schema.Struct({
  tick: Num,
  raft: Pose,
  riders: Schema.mutable(Schema.Array(RiderPose)),
  gas: Schema.mutable(Schema.Array(Num)),
  deaths: Num,
  respawnIn: Num,
  invulnerable: Num,
  hazards: Schema.mutable(
    Schema.Array(Schema.Struct({ id: Schema.String, x: Num, y: Num, rot: Num })),
  ),
  phase: Phase,
});

export const SimEvent = Schema.Union([
  Schema.Struct({
    type: Schema.tag("fart"),
    seat: SeatIndex,
    x: Num,
    y: Num,
    dirX: Num,
    dirY: Num,
  }),
  Schema.Struct({ type: Schema.tag("bump"), x: Num, y: Num, speed: Num }),
  Schema.Struct({ type: Schema.tag("go") }),
  Schema.Struct({ type: Schema.tag("checkpoint"), index: Num }),
  Schema.Struct({ type: Schema.tag("finished"), timeMs: Num }),
  Schema.Struct({
    type: Schema.tag("hit"),
    deaths: Num,
    x: Num,
    y: Num,
    dirX: Num,
    dirY: Num,
  }),
  Schema.Struct({ type: Schema.tag("respawn"), x: Num, y: Num }),
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

/** One rider in the current race. `seat` is null once its player has left: the rider idles. */
export const CrewMember = Schema.Struct({ name: Schema.String, seat: Schema.NullOr(SeatIndex) });

/** Who is in the room. `seats[i]` is a player's name, or null for an open seat. */
export const Roster = Schema.Struct({
  code: RoomCode,
  course: CourseName,
  seats: Schema.mutable(Schema.Array(Schema.NullOr(Schema.String))),
  /** The human who can start the race: whoever has been in the room longest. */
  host: Schema.NullOr(SeatIndex),
  started: Schema.Boolean,
  /**
   * `crew[r]` drives rider `r` (the sim's seat index) in the current race: the humans seated when
   * it started, in seat order. Empty in the lobby. A seated player missing here is spectating.
   */
  crew: Schema.mutable(Schema.Array(CrewMember)),
});
export type Roster = typeof Roster.Type;

/** The rider `seat` drives in the current race, or -1 while it is spectating (or in the lobby). */
export const riderOf = (roster: Roster, seat: number): number =>
  roster.crew.findIndex((c) => c.seat === seat);

export const ServerMsg = Schema.TaggedUnion({
  /** `token` proves the seat: SendInput, Start and Restart carry it. */
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
    payload: { course: CourseName },
    success: RoomCode,
    error: ServerBusy,
  }),
  // The stream's lifetime is the seat lease: ending it opens the seat up again.
  Rpc.make("Join", {
    payload: { code: RoomCode, name: PlayerName },
    success: ServerMsg,
    error: Schema.Union([RoomFull, RoomNotFound]),
    stream: true,
  }),
  Rpc.make("SendInput", { payload: { ...Seated, input: SeatInput } }),
  /** Host only: leave the lobby and start the countdown. */
  Rpc.make("Start", { payload: Seated }),
  /** Any seated player: a new race whose crew is everyone seated now. */
  Rpc.make("Restart", { payload: Seated }),
);

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;

export type Drift = [
  Expect<Same<typeof SeatInput.Type, Sim.SeatInput>>,
  Expect<Same<typeof Snapshot.Type, Sim.Snapshot>>,
  Expect<Same<typeof SimEvent.Type, Sim.SimEvent>>,
  Expect<Same<typeof Phase.Type, Sim.Phase>>,
  Expect<Same<typeof Pose.Type, Sim.Pose>>,
  Expect<Same<typeof RiderPose.Type, Sim.RiderPose>>,
];
