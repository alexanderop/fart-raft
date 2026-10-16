import { Effect, Fiber, Layer, Queue, Stream, type Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vite-plus/test";
import pond from "../courses/pond.json";
import { RoomFull, ServerMsg } from "../src/net/protocol.ts";
import { parseLevel } from "../src/sim/level.ts";
import type { SeatInput } from "../src/sim/types.ts";
import { Room, roomLayer } from "./room.ts";

const level = parseLevel(pond);
const FART: SeatInput = { move: { x: 0, y: 0 }, fart: true };

/** Runs on a TestClock, so the room's 60 Hz loop only moves when the test advances time. */
const run = <A, E>(test: Effect.Effect<A, E, Room | Scope.Scope>) =>
  Effect.runPromise(
    test.pipe(
      Effect.scoped,
      Effect.provide(roomLayer(level).pipe(Layer.provideMerge(TestClock.layer()))),
    ),
  );

/** One client holding a seat: everything the server streams to it lands in `inbox`. */
const lease = Effect.gen(function* () {
  const room = yield* Room;
  const inbox = yield* Queue.unbounded<ServerMsg>();
  const fiber = yield* room.join.pipe(
    Stream.runForEach((msg) => Queue.offer(inbox, msg)),
    Effect.forkScoped,
  );
  return { inbox, fiber, welcome: yield* Queue.take(inbox) };
});

/** Advance in frame-sized steps so the lease's consumer drains each frame before the next. */
const play = (seconds: number) =>
  Effect.forEach(Array.from({ length: seconds * 20 }), () => TestClock.adjust("50 millis"), {
    discard: true,
  });

describe("given an empty room", () => {
  describe("when a client joins", () => {
    it("should seat it first and fill the rest of the crew with bots", () =>
      run(
        Effect.gen(function* () {
          const { welcome } = yield* lease;
          expect(welcome).toEqual({ _tag: "Welcome", seat: 0, crew: 4 });
        }),
      ));
  });

  describe("when a second client joins", () => {
    it("should take seat 1", () =>
      run(
        Effect.gen(function* () {
          yield* lease;
          const second = yield* lease;
          expect(second.welcome).toEqual({ _tag: "Welcome", seat: 1, crew: 4 });
        }),
      ));
  });

  describe("when the first client leaves and another joins", () => {
    it("should give the freed seat 0 back", () =>
      run(
        Effect.gen(function* () {
          const first = yield* lease;
          yield* lease;
          yield* Fiber.interrupt(first.fiber);
          const newcomer = yield* lease;
          expect(newcomer.welcome).toEqual({ _tag: "Welcome", seat: 0, crew: 4 });
        }),
      ));
  });

  describe("when a fifth human tries to join a full room", () => {
    it("should be refused with RoomFull", () =>
      run(
        Effect.gen(function* () {
          const room = yield* Room;
          for (let i = 0; i < 4; i++) yield* lease;
          const error = yield* Effect.flip(Stream.runDrain(room.join));
          expect(error).toBeInstanceOf(RoomFull);
        }),
      ));
  });
});

describe("given one human in a room", () => {
  describe("when seat 0 farts after the countdown", () => {
    it("should broadcast a fart event for seat 0 and mark seats 1-3 as bots", () =>
      run(
        Effect.gen(function* () {
          const room = yield* Room;
          const { inbox } = yield* lease;
          yield* room.sendInput(0, FART);
          yield* play(4);

          const frames = (yield* Queue.clear(inbox)).filter(ServerMsg.guards.Frame);
          expect(frames.length).toBeGreaterThan(60);
          expect(frames[0]!.seats).toEqual(["human", "bot", "bot", "bot"]);
          expect(frames.at(-1)!.snapshot.phase.kind).toBe("racing");
          const farts = frames
            .flatMap((f) => f.events)
            .filter((e) => e.type === "fart" && e.seat === 0);
          expect(farts.length).toBeGreaterThan(0);
        }),
      ));
  });

  describe("when the race is restarted", () => {
    it("should start the tick count over", () =>
      run(
        Effect.gen(function* () {
          const room = yield* Room;
          const { inbox } = yield* lease;
          yield* play(1);
          const before = (yield* Queue.clear(inbox)).filter(ServerMsg.guards.Frame);
          expect(before.at(-1)!.snapshot.tick).toBe(60);

          yield* room.restart();
          yield* play(1);
          const after = (yield* Queue.clear(inbox)).filter(ServerMsg.guards.Frame);
          expect(after[0]!.snapshot.tick).toBe(3);
        }),
      ));
  });
});
