import {
  Clock,
  Duration,
  Effect,
  Option,
  PubSub,
  Ref,
  Stream,
  SubscriptionRef,
  type Scope,
} from "effect";
import {
  FRAME_TICKS,
  MAX_NAME,
  RoomFull,
  ServerMsg,
  type CourseName,
  type Roster,
} from "../src/net/protocol.ts";
import { defaultLook, type Look } from "../src/look.ts";
import { crewZones, MAX_CREW, TICK_RATE } from "../src/sim/constants.ts";
import { createSim, snapshot, step } from "../src/sim/sim.ts";
import {
  IDLE_INPUT,
  type Difficulty,
  type LevelData,
  type SeatInput,
  type SimEvent,
  type Snapshot,
} from "../src/sim/types.ts";

type Human = {
  kind: "human";
  name: string;
  look: Look;
  token: string;
  joined: number;
  input: SeatInput;
};
type Seat = { kind: "empty" } | Human;
/**
 * Who drives one rider for a whole race. Matched to a seat by token, so a leaver's rider idles
 * in the look it started the race with.
 */
type Rider = { token: string; name: string; look: Look };

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

export interface Room {
  readonly code: string;
  /** The stream's lifetime is the seat lease: when it ends or is interrupted the seat opens up. */
  readonly join: (name: string, look?: Look) => Stream.Stream<ServerMsg, RoomFull>;
  readonly sendInput: (token: string, input: SeatInput) => Effect.Effect<void>;
  /** Only the host's token starts the race; anything else is ignored. */
  readonly start: (token: string) => Effect.Effect<void>;
  /** Any seated human: a new race with everyone seated now, spectators included. */
  readonly restart: (token: string) => Effect.Effect<void>;
  /** A seated human's new look: on their seat, and on their rider if they are racing. */
  readonly setLook: (token: string, look: Look) => Effect.Effect<void>;
  readonly humans: Effect.Effect<number>;
}

/** One race: the sim, the riders it was started with, and the events not yet broadcast. Effect-free. */
function newRace(level: LevelData, difficulty: Difficulty, crew: readonly Rider[]) {
  const sim = createSim(level, crewZones(crew.length), { difficulty });
  let pending: SimEvent[] = [];

  return {
    crew,
    /** One fixed tick. Returns the frame to broadcast on every FRAME_TICKS-th tick. */
    tick(table: readonly Seat[]): ServerMsg | undefined {
      // A rider whose human left keeps the race going, idle, until the next restart.
      const inputs = crew.map((r) => {
        const seat = table.find((s) => s.kind === "human" && s.token === r.token);
        return seat?.kind === "human" ? seat.input : IDLE_INPUT;
      });
      pending.push(...step(sim, inputs));
      const latest: Snapshot = snapshot(sim);
      if (latest.tick % FRAME_TICKS !== 0) return undefined;
      const events = pending;
      pending = [];
      return ServerMsg.cases.Frame.make({ snapshot: latest, events });
    },
    free: () => sim.world.free(),
  };
}
type Race = ReturnType<typeof newRace>;

/** Trimmed, single-spaced, at most MAX_NAME characters; blank becomes "Player N". */
export function cleanName(raw: string, seat: number): string {
  const name = raw.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return name === "" ? `Player ${seat + 1}` : name;
}

const seatOf = (table: readonly Seat[], token: string) =>
  table.findIndex((s) => s.kind === "human" && s.token === token);

const hostOf = (seats: readonly Seat[]): number | null => {
  let host: number | null = null;
  let since = Infinity;
  for (const [i, s] of seats.entries()) {
    if (s.kind === "human" && s.joined < since) [host, since] = [i, s.joined];
  }
  return host;
};

/**
 * A room starts in the lobby: players join and see each other, nothing is simulated. The host's
 * Start creates the race with everyone seated as its crew; a mid-race joiner watches until a
 * restart rebuilds the crew; from then on it ticks at 60 Hz while at least one human is seated.
 * Physics must be initialised (`initPhysics`) before the race starts. Lives as long as its scope.
 */
export const makeRoom = (
  code: string,
  course: CourseName,
  level: LevelData,
  difficulty: Difficulty,
): Effect.Effect<Room, never, Scope.Scope> =>
  Effect.gen(function* () {
    // No bots online: a race's crew is exactly the humans seated when it starts.
    const empty: Seat = { kind: "empty" };
    const seats = yield* Ref.make<readonly Seat[]>(Array.from({ length: MAX_CREW }, () => empty));
    const race = yield* Ref.make<Race | undefined>(undefined);
    let joins = 0;

    const rosterOf = (table: readonly Seat[], current: Race | undefined): Roster => ({
      code,
      course,
      difficulty,
      seats: table.map((s) => (s.kind === "human" ? { name: s.name, look: s.look } : null)),
      host: hostOf(table),
      started: current !== undefined,
      crew: (current?.crew ?? []).map((r) => {
        const seat = seatOf(table, r.token);
        const human = table[seat];
        const look = human?.kind === "human" ? human.look : r.look;
        return { name: r.name, seat: seat < 0 ? null : seat, look };
      }),
    });
    const roster = yield* SubscriptionRef.make(rosterOf(yield* Ref.get(seats), undefined));
    const publishRoster = Effect.gen(function* () {
      yield* SubscriptionRef.set(roster, rosterOf(yield* Ref.get(seats), yield* Ref.get(race)));
    });

    // Sliding: a slow client loses old frames instead of stalling the room.
    const frames = yield* Effect.acquireRelease(PubSub.sliding<ServerMsg>(4), PubSub.shutdown);
    yield* Effect.addFinalizer(() => Ref.get(race).pipe(Effect.map((r) => r?.free())));

    const tick = Effect.gen(function* () {
      const current = yield* Ref.get(race);
      const table = yield* Ref.get(seats);
      // Nobody watching: hold the race where it is until someone comes back.
      if (!current || !table.some((s) => s.kind === "human")) return;
      const frame = current.tick(table);
      if (frame) yield* PubSub.publish(frames, frame);
    });
    yield* Effect.forkScoped(everyStep(tick));

    /** Everyone seated right now, in seat order. */
    const crewOf = (table: readonly Seat[]): Rider[] =>
      table.flatMap((s) =>
        s.kind === "human" ? [{ token: s.token, name: s.name, look: s.look }] : [],
      );

    const claimSeat = (name: string, look: Look | undefined, token: string) =>
      Ref.modify(seats, (table) => {
        const free = table.findIndex((s) => s.kind === "empty");
        if (free < 0) return [Option.none<number>(), table] as const;
        const human: Human = {
          kind: "human",
          name: cleanName(name, free),
          look: look ?? defaultLook(free),
          token,
          joined: joins++,
          input: IDLE_INPUT,
        };
        return [Option.some(free), table.with(free, human)] as const;
      }).pipe(
        Effect.flatMap(
          Option.match({ onNone: () => Effect.fail(new RoomFull()), onSome: Effect.succeed }),
        ),
        Effect.tap(() => publishRoster),
      );

    const releaseSeat = (seat: number) =>
      Ref.update(seats, (table) => table.with(seat, empty)).pipe(Effect.andThen(publishRoster));

    const join = (name: string, look?: Look) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const token = crypto.randomUUID();
          const seat = yield* Effect.acquireRelease(claimSeat(name, look, token), releaseSeat);
          const subscription = yield* PubSub.subscribe(frames);
          const rosters = SubscriptionRef.changes(roster).pipe(
            Stream.map((r) => ServerMsg.cases.Roster.make({ roster: r })),
          );
          return Stream.make(ServerMsg.cases.Welcome.make({ seat, token })).pipe(
            Stream.concat(Stream.merge(rosters, Stream.fromSubscription(subscription))),
          );
        }),
      );

    const sendInput = Effect.fn("Room.sendInput")(function* (token: string, input: SeatInput) {
      // Only a seated human's own token counts: a stray message must not steer anyone else.
      // A spectator's input is stored too, but no rider reads it until they're in a race.
      yield* Ref.update(seats, (table) => {
        const seat = seatOf(table, token);
        const human = table[seat];
        return human?.kind === "human" ? table.with(seat, { ...human, input }) : table;
      });
    });

    const start = Effect.fn("Room.start")(function* (token: string) {
      const table = yield* Ref.get(seats);
      const host = hostOf(table);
      if (host === null || seatOf(table, token) !== host) return;
      // One modify: a second Start can never swap in a race between the check and the set.
      const started = yield* Ref.modify(race, (current) =>
        current === undefined
          ? ([true, newRace(level, difficulty, crewOf(table))] as const)
          : ([false, current] as const),
      );
      if (started) yield* publishRoster;
    });

    const restart = Effect.fn("Room.restart")(function* (token: string) {
      const table = yield* Ref.get(seats);
      if (seatOf(table, token) < 0) return;
      // One modify: two Restarts each get their own old race, so none is freed twice.
      const old = yield* Ref.modify(race, (current) =>
        current === undefined
          ? ([undefined, current] as const)
          : ([current, newRace(level, difficulty, crewOf(table))] as const),
      );
      if (!old) return;
      old.free();
      yield* publishRoster;
    });

    const setLook = Effect.fn("Room.setLook")(function* (token: string, look: Look) {
      const changed = yield* Ref.modify(seats, (table) => {
        const seat = seatOf(table, token);
        const human = table[seat];
        if (human?.kind !== "human") return [false, table] as const;
        return [true, table.with(seat, { ...human, look })] as const;
      });
      if (changed) yield* publishRoster;
    });

    const humans = Ref.get(seats).pipe(
      Effect.map((table) => table.filter((s) => s.kind === "human").length),
    );

    return { code, join, sendInput, start, restart, setLook, humans };
  });
