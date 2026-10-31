import { Effect, Layer, Stream } from "effect";
import { HttpRouter } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { RaftRpcs, type CourseName } from "../src/net/protocol.ts";
import type { LevelData } from "../src/sim/types.ts";
import { Lobby, lobbyLayer, type LobbyOptions } from "./lobby.ts";
import type { Room } from "./room.ts";

const handlers = RaftRpcs.toLayer(
  Effect.gen(function* () {
    const lobby = yield* Lobby;
    // Messages for a room that is gone are dropped, like input for a seat that is gone.
    const inRoom = (code: string, f: (room: Room) => Effect.Effect<void>) =>
      lobby.find(code).pipe(Effect.flatMap(f), Effect.ignore);
    return RaftRpcs.of({
      CreateRoom: ({ course, difficulty, mode }) => lobby.create(course, difficulty, mode),
      Join: ({ code, name, look }) =>
        Stream.unwrap(lobby.find(code).pipe(Effect.map((room) => room.join(name, look)))),
      SendInput: ({ code, token, input }) => inRoom(code, (r) => r.sendInput(token, input)),
      Start: ({ code, token }) => inRoom(code, (r) => r.start(token)),
      Restart: ({ code, token }) => inRoom(code, (r) => r.restart(token)),
      SetLook: ({ code, token, look }) => inRoom(code, (r) => r.setLook(token, look)),
      SetTeam: ({ code, token, team }) => inRoom(code, (r) => r.setTeam(token, team)),
      SetMode: ({ code, token, mode }) => inRoom(code, (r) => r.setMode(token, mode)),
    });
  }),
);

/** The lobby's RPC routes: JSON over WebSocket at /rpc. */
export const rpcLayer = (
  courses: Record<CourseName, LevelData>,
  options: Partial<LobbyOptions> = {},
) =>
  RpcServer.layerHttp({ group: RaftRpcs, path: "/rpc", protocol: "websocket" }).pipe(
    Layer.provide(handlers),
    Layer.provide(lobbyLayer(courses, options)),
    Layer.provide(RpcSerialization.layerJson),
  );

/** The lobby served on its own. Needs an `HttpServer` underneath. */
export const appLayer = (
  courses: Record<CourseName, LevelData>,
  options: Partial<LobbyOptions> = {},
) => HttpRouter.serve(rpcLayer(courses, options));
