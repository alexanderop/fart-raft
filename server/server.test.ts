import { NodeHttpServer } from "@effect/platform-node";
import { Context, Effect, Layer, Queue, Stream, type Scope } from "effect";
import { HttpServer } from "effect/http";
import { createServer } from "node:http";
import { describe, expect, it } from "vite-plus/test";
import pond from "../courses/pond.json";
import { clientLayer, connect, RaftClient } from "../src/net/client.ts";
import { RoomFull, ServerMsg, type Frame } from "../src/net/protocol.ts";
import { parseLevel } from "../src/sim/level.ts";
import { appLayer } from "./app.ts";

const serverLayer = appLayer(parseLevel(pond)).pipe(
  Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0 })),
);

/** Boots the real server on a free port and hands the test its WebSocket URL. */
const withServer = <A, E>(test: (url: string) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = Context.get(yield* Layer.build(serverLayer), HttpServer.HttpServer);
        if (!("port" in server.address)) throw new Error("expected a TCP address");
        return yield* test(`ws://127.0.0.1:${server.address.port}/rpc`);
      }),
    ),
  );

const clientFor = (url: string) =>
  Layer.build(clientLayer(url)).pipe(Effect.map((context) => Context.get(context, RaftClient)));

describe("given the server listening on a free port", () => {
  describe("when a client joins over a WebSocket", () => {
    it("should receive Welcome for seat 0, then frames with a rising tick", () =>
      withServer((url) =>
        Effect.gen(function* () {
          const client = yield* clientFor(url);
          const messages = Array.from(yield* Stream.runCollect(client.Join().pipe(Stream.take(4))));

          expect(messages[0]).toEqual({ _tag: "Welcome", seat: 0, crew: 4 });
          const frames = messages.filter(ServerMsg.guards.Frame);
          expect(frames).toHaveLength(3);
          const [first, second, third] = frames.map((f) => f.snapshot.tick);
          expect(first! % 3).toBe(0);
          expect([second! - first!, third! - second!]).toEqual([3, 3]);
          expect(frames[0]!.seats).toEqual(["human", "bot", "bot", "bot"]);
        }),
      ));
  });

  describe("when a fifth human joins a full room", () => {
    it("should fail with RoomFull across the wire", () =>
      withServer((url) =>
        Effect.gen(function* () {
          const client = yield* clientFor(url);
          const joined = yield* Queue.unbounded<unknown>();
          for (let i = 0; i < 4; i++) {
            yield* client.Join().pipe(
              Stream.runForEach((msg) => Queue.offer(joined, msg)),
              Effect.forkScoped,
            );
            yield* Queue.take(joined);
          }

          const error = yield* Effect.flip(Stream.runDrain(client.Join()));
          expect(error).toBeInstanceOf(RoomFull);
        }),
      ));
  });

  describe("when the browser client connects", () => {
    it("should seat it and deliver frames after a fart input", () =>
      withServer((url) =>
        Effect.promise(async () => {
          const connection = await connect(url);
          expect(connection.seat).toBe(0);
          expect(connection.crew).toBe(4);

          const frame = await new Promise<Frame>((resolve) => connection.onFrame(resolve));
          expect(frame.snapshot.phase.kind).toBe("countdown");

          connection.send({ move: { x: 0, y: 0 }, fart: true });
          connection.restart();
          const afterRestart = await new Promise<Frame>((resolve) =>
            connection.onFrame((f) => f.snapshot.tick === 3 && resolve(f)),
          );
          expect(afterRestart.snapshot.tick).toBe(3);
          connection.close();
        }),
      ));
  });
});
