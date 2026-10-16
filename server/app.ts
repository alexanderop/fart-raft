import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { RaftRpcs } from "../src/net/protocol.ts";
import type { LevelData } from "../src/sim/types.ts";
import { Room, roomLayer } from "./room.ts";

const handlers = RaftRpcs.toLayer(
  Effect.gen(function* () {
    const room = yield* Room;
    return RaftRpcs.of({
      Join: () => room.join,
      SendInput: ({ seat, input }) => room.sendInput(seat, input),
      Restart: () => room.restart(),
    });
  }),
);

/** The room served as JSON RPC over WebSocket at /rpc. Needs an `HttpServer` underneath. */
export const appLayer = (level: LevelData) =>
  HttpRouter.serve(
    RpcServer.layerHttp({ group: RaftRpcs, path: "/rpc", protocol: "websocket" }).pipe(
      Layer.provide(handlers),
      Layer.provide(roomLayer(level)),
      Layer.provide(RpcSerialization.layerJson),
    ),
  );
