import { Clock, Context, Duration, Effect, Layer, Option, PubSub, Ref, Stream } from "effect";
import { botSource } from "../src/input/bot.ts";
import { readSeats, type InputSource } from "../src/input/sources.ts";
import { FRAME_TICKS, RoomFull, ServerMsg } from "../src/net/protocol.ts";
import { crewZones, MAX_CREW, TICK_RATE, type Zone } from "../src/sim/constants.ts";
import { createSim, initPhysics, snapshot, step } from "../src/sim/sim.ts";
import {
  IDLE_INPUT,
  type LevelData,
  type SeatInput,
  type SimEvent,
  type Snapshot,
} from "../src/sim/types.ts";

type Seat = { kind: "bot" } | { kind: "human"; input: SeatInput };

const NANOS = 1_000_000_000n;
const RATE = BigInt(TICK_RATE);

/**
 * Runs `tick` at the sim's fixed rate on the Effect clock. A timer that fires late is made up
 * by running the missed ticks back to back, so game time tracks the clock instead of drifting.
 */
const everyStep = (tick: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const start = yield* Clock.monotonicTimeNanos;
    let done = 0n;
    while (true) {
      const elapsed = (yield* Clock.monotonicTimeNanos) - start;
      for (const due = (elapsed * RATE) / NANOS; done < due; done++) yield* tick;
      const nextAt = ((done + 1n) * NANOS + RATE - 1n) / RATE;
      yield* Effect.sleep(Duration.nanos(nextAt - elapsed));
    }
  });

export interface Interface {
  /** The stream's lifetime is the seat lease: when it ends or is interrupted the seat goes back to a bot. */
  readonly join: Stream.Stream<ServerMsg, RoomFull>;
  readonly sendInput: (seat: number, input: SeatInput) => Effect.Effect<void>;
  readonly restart: () => Effect.Effect<void>;
}

export class Room extends Context.Service<Room, Interface>()("fart-raft/Room") {}

/** One race: the sim, its bots, and the events not yet broadcast. Effect-free. */
function newRace(level: LevelData, zones: readonly Zone[]) {
  const sim = createSim(level, zones);
  let latest: Snapshot = snapshot(sim);
  const bots = zones.map((_, i) => botSource(i, zones, level, () => latest));
  let pending: SimEvent[] = [];

  const sourceFor = (seat: Seat, i: number): InputSource =>
    seat.kind === "human" ? { read: () => seat.input } : bots[i]!;

  return {
    /** One fixed tick. Returns the frame to broadcast on every FRAME_TICKS-th tick. */
    tick(table: readonly Seat[]): ServerMsg | undefined {
      pending.push(...step(sim, readSeats(table.map(sourceFor))));
      latest = snapshot(sim);
      if (latest.tick % FRAME_TICKS !== 0) return undefined;
      const events = pending;
      pending = [];
      return ServerMsg.cases.Frame.make({
        snapshot: latest,
        events,
        seats: table.map((s) => s.kind),
      });
    },
    free: () => sim.world.free(),
  };
}

const make = (level: LevelData) =>
  Effect.gen(function* () {
    yield* Effect.promise(initPhysics);
    // The crew is always full and never changes mid-race: empty seats are bots.
    const zones = crewZones(MAX_CREW);
    const seats = yield* Ref.make<readonly Seat[]>(zones.map(() => ({ kind: "bot" })));
    const race = yield* Ref.make(newRace(level, zones));
    // Sliding: a slow client loses old frames instead of stalling the room.
    const frames = yield* Effect.acquireRelease(PubSub.sliding<ServerMsg>(4), PubSub.shutdown);
    yield* Effect.addFinalizer(() => Ref.get(race).pipe(Effect.map((r) => r.free())));

    const tick = Effect.gen(function* () {
      const frame = (yield* Ref.get(race)).tick(yield* Ref.get(seats));
      if (frame) yield* PubSub.publish(frames, frame);
    });
    yield* Effect.forkScoped(everyStep(tick));

    const claimSeat = Ref.modify(seats, (table) => {
      const free = table.findIndex((s) => s.kind === "bot");
      return free < 0
        ? ([Option.none<number>(), table] as const)
        : ([Option.some(free), table.with(free, { kind: "human", input: IDLE_INPUT })] as const);
    }).pipe(
      Effect.flatMap(
        Option.match({ onNone: () => Effect.fail(new RoomFull()), onSome: Effect.succeed }),
      ),
    );

    const releaseSeat = (seat: number) =>
      Ref.update(seats, (table) => table.with(seat, { kind: "bot" }));

    const join = Stream.unwrap(
      Effect.gen(function* () {
        const seat = yield* Effect.acquireRelease(claimSeat, releaseSeat);
        const subscription = yield* PubSub.subscribe(frames);
        return Stream.make(ServerMsg.cases.Welcome.make({ seat, crew: MAX_CREW })).pipe(
          Stream.concat(Stream.fromSubscription(subscription)),
        );
      }),
    );

    const sendInput = Effect.fn("Room.sendInput")(function* (seat: number, input: SeatInput) {
      // Only a seated human's input counts: a stray message must not steer a bot.
      yield* Ref.update(seats, (table) =>
        table[seat]?.kind === "human" ? table.with(seat, { kind: "human", input }) : table,
      );
    });

    const restart = Effect.fn("Room.restart")(function* () {
      const old = yield* Ref.getAndSet(race, newRace(level, zones));
      old.free();
    });

    return Room.of({ join, sendInput, restart });
  });

export const roomLayer = (level: LevelData) => Layer.effect(Room, make(level));
