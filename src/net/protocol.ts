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
  Schema.Struct({ kind: Schema.tag("dead"), timeMs: Num, nextCheckpoint: Num }),
]);

export const Snapshot = Schema.Struct({
  tick: Num,
  raft: Pose,
  riders: Schema.mutable(Schema.Array(RiderPose)),
  gas: Schema.mutable(Schema.Array(Num)),
  lives: Num,
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
    type: Schema.tag("lifeLost"),
    lives: Num,
    x: Num,
    y: Num,
    dirX: Num,
    dirY: Num,
  }),
  Schema.Struct({ type: Schema.tag("died"), timeMs: Num }),
]);

/** Who sits in a seat right now. A client knows which seat is its own from Welcome. */
export const Occupant = Schema.Literals(["human", "bot"]);
export type Occupant = typeof Occupant.Type;

export const ServerMsg = Schema.TaggedUnion({
  Welcome: { seat: SeatIndex, crew: Schema.Int },
  Frame: {
    snapshot: Snapshot,
    events: Schema.mutable(Schema.Array(SimEvent)),
    seats: Schema.mutable(Schema.Array(Occupant)),
  },
});
export type ServerMsg = typeof ServerMsg.Type;
export type Welcome = typeof ServerMsg.cases.Welcome.Type;
export type Frame = typeof ServerMsg.cases.Frame.Type;

export class RoomFull extends Schema.TaggedError<RoomFull>()("RoomFull", {}) {}

export const RaftRpcs = RpcGroup.make(
  // The stream's lifetime is the seat lease: ending it hands the seat back to a bot.
  Rpc.make("Join", { success: ServerMsg, error: RoomFull, stream: true }),
  Rpc.make("SendInput", { payload: { seat: SeatIndex, input: SeatInput } }),
  Rpc.make("Restart"),
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
