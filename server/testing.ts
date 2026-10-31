import { Effect, Layer, Queue, Stream, type Scope } from "effect";
import { TestClock } from "effect/testing";
import pond from "../courses/pond.json";
import { ServerMsg, type CourseName, type Frame, type RoomMode } from "../src/net/protocol.ts";
import { parseLevel } from "../src/sim/level.ts";
import type { LevelData, SeatInput } from "../src/sim/types.ts";
import { Lobby, lobbyLayer } from "./lobby.ts";
import type { Room } from "./room.ts";

// Shared by the room and team-room tests: a room on a TestClock and the clients that sit in it.

export const level = parseLevel(pond);
const COURSES = { canyon: level, graveyard: level, pond: level };
export const FART: SeatInput = { move: { x: 0, y: 0 }, fart: true };

/** Runs on a TestClock, so each room's 60 Hz loop only moves when the test advances time. */
export const run = <A, E>(
  test: Effect.Effect<A, E, Lobby | Scope.Scope>,
  courses: Record<CourseName, LevelData> = COURSES,
) =>
  Effect.runPromise(
    test.pipe(
      Effect.scoped,
      Effect.provide(
        lobbyLayer(courses, { sweepEvery: "30 seconds" }).pipe(
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  );

/** A fresh pond room in the lobby phase, raced in `mode`. */
export const roomOf = (mode: RoomMode) =>
  Effect.gen(function* () {
    const lobby = yield* Lobby;
    return yield* lobby.find(yield* lobby.create("pond", "chill", mode));
  });

/** One client holding a seat: everything the server streams to it lands in `inbox`. */
export const lease = (room: Room, name = "Ann") =>
  Effect.gen(function* () {
    const inbox = yield* Queue.unbounded<ServerMsg>();
    const fiber = yield* room.join(name).pipe(
      Stream.runForEach((msg) => Queue.offer(inbox, msg)),
      Effect.forkScoped,
    );
    const welcome = yield* Queue.take(inbox);
    if (!ServerMsg.guards.Welcome(welcome)) throw new Error("expected Welcome first");
    return { inbox, fiber, welcome };
  });

/** The newest roster in the inbox, after letting the room's fibers run. */
export const latestRoster = (inbox: Queue.Queue<ServerMsg>) =>
  Effect.gen(function* () {
    yield* TestClock.adjust("1 millis");
    const latest = (yield* Queue.clear(inbox)).filter(ServerMsg.guards.Roster).at(-1);
    if (!latest) throw new Error("no roster since the last look");
    return latest.roster;
  });

/** Advance in frame-sized steps so the lease's consumer drains each frame before the next. */
export const play = (seconds: number) =>
  Effect.forEach(Array.from({ length: seconds * 20 }), () => TestClock.adjust("50 millis"), {
    discard: true,
  });

export const framesIn = (inbox: Queue.Queue<ServerMsg>) =>
  Queue.clear(inbox).pipe(Effect.map((msgs) => msgs.filter(ServerMsg.guards.Frame)));

/** Everything since the last look: the frames, and the newest roster (if one came). */
export const drain = (inbox: Queue.Queue<ServerMsg>) =>
  Queue.clear(inbox).pipe(
    Effect.map((msgs) => ({
      frames: msgs.filter(ServerMsg.guards.Frame),
      roster: msgs.filter(ServerMsg.guards.Roster).at(-1)?.roster,
    })),
  );

export const fartsIn = (frames: readonly Frame[]) =>
  frames.flatMap((f) => f.events).filter((e) => e.type === "fart");
