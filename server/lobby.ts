import { Context, Duration, Effect, Exit, Layer, Random, Ref, Scope } from "effect";
import {
  CODE_LENGTH,
  CODE_LETTERS,
  RoomNotFound,
  ServerBusy,
  type CourseName,
} from "../src/net/protocol.ts";
import type { Difficulty } from "../src/sim/types.ts";
import { initPhysics } from "../src/sim/sim.ts";
import type { LevelData } from "../src/sim/types.ts";
import { makeRoom, type Room } from "./room.ts";

export interface Interface {
  /** Opens an empty room in the lobby phase and returns its code. */
  readonly create: (
    course: CourseName,
    difficulty: Difficulty,
  ) => Effect.Effect<string, ServerBusy>;
  readonly find: (code: string) => Effect.Effect<Room, RoomNotFound>;
}

export class Lobby extends Context.Service<Lobby, Interface>()("fart-raft/Lobby") {}

export type LobbyOptions = {
  /** Open rooms at most; CreateRoom fails with ServerBusy beyond this. */
  maxRooms: number;
  /** How often empty rooms are looked for. A room empty on two sweeps in a row is closed. */
  sweepEvery: Duration.Input;
};

const DEFAULTS: LobbyOptions = { maxRooms: 200, sweepEvery: "30 seconds" };

type Open = { room: Room; scope: Scope.Closeable; emptySweeps: number };

const randomCode = Effect.gen(function* () {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_LETTERS[yield* Random.nextIntBetween(0, CODE_LETTERS.length, { halfOpen: true })];
  }
  return code;
});

const make = (courses: Record<CourseName, LevelData>, options: LobbyOptions) =>
  Effect.gen(function* () {
    yield* Effect.promise(initPhysics);
    const rooms = yield* Ref.make(new Map<string, Open>());

    const close = (code: string, open: Open) =>
      Ref.update(rooms, (m) => {
        const next = new Map(m);
        next.delete(code);
        return next;
      }).pipe(Effect.andThen(Scope.close(open.scope, Exit.void)));
    yield* Effect.addFinalizer(() =>
      Ref.get(rooms).pipe(
        Effect.flatMap((m) => Effect.forEach(m, ([code, open]) => close(code, open))),
      ),
    );

    // A host who refreshes gets one sweep of grace before their empty room is gone.
    const sweep = Effect.gen(function* () {
      for (const [code, open] of yield* Ref.get(rooms)) {
        if ((yield* open.room.humans) > 0) open.emptySweeps = 0;
        else if (++open.emptySweeps >= 2) yield* close(code, open);
      }
    });
    yield* Effect.forkScoped(
      Effect.forever(Effect.sleep(options.sweepEvery).pipe(Effect.andThen(sweep))),
    );

    const create = Effect.fn("Lobby.create")(function* (
      course: CourseName,
      difficulty: Difficulty,
    ) {
      const taken = yield* Ref.get(rooms);
      if (taken.size >= options.maxRooms) return yield* new ServerBusy();
      let code = yield* randomCode;
      while (taken.has(code)) code = yield* randomCode;
      const scope = yield* Scope.make();
      const room = yield* makeRoom(code, course, courses[course], difficulty).pipe(
        Scope.provide(scope),
      );
      yield* Ref.update(rooms, (m) => new Map(m).set(code, { room, scope, emptySweeps: 0 }));
      return code;
    });

    const find = (code: string) =>
      Ref.get(rooms).pipe(
        Effect.flatMap((m) => {
          const open = m.get(code.toUpperCase());
          return open ? Effect.succeed(open.room) : Effect.fail(new RoomNotFound());
        }),
      );

    return Lobby.of({ create, find });
  });

export const lobbyLayer = (
  courses: Record<CourseName, LevelData>,
  options: Partial<LobbyOptions> = {},
) => Layer.effect(Lobby, make(courses, { ...DEFAULTS, ...options }));
