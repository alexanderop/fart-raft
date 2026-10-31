import { NodeHttpServer } from "@effect/platform-node";
import { Context, Effect, Layer, Queue, Stream, type Scope } from "effect";
import { HttpServer } from "effect/http";
import { createServer } from "node:http";
import { describe, expect, it } from "vite-plus/test";
import pond from "../courses/pond.json";
import { clientLayer, connect, createRoom, RaftClient } from "../src/net/client.ts";
import {
  RoomFull,
  RoomNotFound,
  startBlocker,
  type Frame,
  type Roster,
} from "../src/net/protocol.ts";
import { defaultLook } from "../src/look.ts";
import { MAX_CREW } from "../src/sim/constants.ts";
import { parseLevel } from "../src/sim/level.ts";
import { appLayer } from "./app.ts";

const level = parseLevel(pond);
const look = defaultLook(0);
/** A seated player in the look every test joins with. */
const player = (name: string, team: 0 | 1 = 0) => ({ name, look, team });
/** `n` open seats in a roster. */
const open = (n: number): null[] => Array(n).fill(null);
const serverLayer = appLayer({ canyon: level, graveyard: level, pond: level }).pipe(
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
  describe("when a client creates a room and joins it over a WebSocket", () => {
    it("should receive Welcome for seat 0, then the roster", () =>
      withServer((url) =>
        Effect.gen(function* () {
          const client = yield* clientFor(url);
          const code = yield* client.CreateRoom({
            course: "pond",
            difficulty: "chill",
            mode: "coop",
          });
          const messages = Array.from(
            yield* Stream.runCollect(client.Join({ code, name: "Ann", look }).pipe(Stream.take(2))),
          );
          expect(messages[0]).toMatchObject({ _tag: "Welcome", seat: 0 });
          expect(messages[1]).toMatchObject({
            _tag: "Roster",
            roster: {
              code,
              course: "pond",
              difficulty: "chill",
              seats: [player("Ann"), ...open(MAX_CREW - 1)],
              host: 0,
              crew: [],
            },
          });
        }),
      ));
  });

  describe("when a client joins a code nobody created", () => {
    it("should fail with RoomNotFound across the wire", () =>
      withServer((url) =>
        Effect.gen(function* () {
          const client = yield* clientFor(url);
          const error = yield* Effect.flip(
            Stream.runDrain(client.Join({ code: "ZZZZ", name: "", look })),
          );
          expect(error).toBeInstanceOf(RoomNotFound);
        }),
      ));
  });

  describe("when a ninth human joins a full room", () => {
    it("should fail with RoomFull across the wire", () =>
      withServer((url) =>
        Effect.gen(function* () {
          const client = yield* clientFor(url);
          const code = yield* client.CreateRoom({
            course: "pond",
            difficulty: "chill",
            mode: "coop",
          });
          for (let i = 0; i < MAX_CREW; i++) {
            // One inbox per seat: wait for this join's own Welcome, not an earlier seat's roster.
            const joined = yield* Queue.unbounded<unknown>();
            yield* client.Join({ code, name: `P${i}`, look }).pipe(
              Stream.runForEach((msg) => Queue.offer(joined, msg)),
              Effect.forkScoped,
            );
            yield* Queue.take(joined);
          }

          const error = yield* Effect.flip(
            Stream.runDrain(client.Join({ code, name: "Eve", look })),
          );
          expect(error).toBeInstanceOf(RoomFull);
        }),
      ));
  });

  describe("when two browser clients meet in a room and the host starts", () => {
    it("should seat both, then deliver frames to the guest", () =>
      withServer((url) =>
        Effect.promise(async () => {
          const code = await createRoom(url, "pond", "chill");
          const host = await connect(url, code, "Ann", look);
          const guest = await connect(url, code, "Bo", look);
          expect([host.seat, guest.seat]).toEqual([0, 1]);
          expect(guest.roster().seats).toEqual([
            player("Ann"),
            player("Bo", 1),
            ...open(MAX_CREW - 2),
          ]);
          expect(guest.roster().host).toBe(0);

          guest.start();
          host.start();
          const frame = await new Promise<Frame>((resolve) => guest.onFrame(resolve));
          expect(frame.snapshot.crews[0]!.phase.kind).toBe("countdown");
          expect(frame.snapshot.crews[0]!.riders).toHaveLength(2);

          host.send({ move: { x: 0, y: 0 }, fart: true });
          host.restart();
          const afterRestart = await new Promise<Frame>((resolve) =>
            host.onFrame((f) => f.snapshot.tick === 3 && resolve(f)),
          );
          expect(afterRestart.snapshot.tick).toBe(3);
          host.close();
          guest.close();
        }),
      ));
  });

  describe("when two browser clients meet in a ghost team room", () => {
    it("should carry the mode, the team pick and the host's mode change over the wire", () =>
      withServer((url) =>
        Effect.promise(async () => {
          const code = await createRoom(url, "pond", "chill", "ghost");
          const host = await connect(url, code, "Ann", look);
          const guest = await connect(url, code, "Bo", look);
          expect(guest.roster().mode).toBe("ghost");
          expect(guest.roster().seats.map((p) => p?.team ?? null)).toEqual([
            0,
            1,
            ...open(MAX_CREW - 2),
          ]);

          const moved = new Promise<Roster>((resolve) =>
            host.onRoster((r) => r.seats[1]?.team === 0 && resolve(r)),
          );
          guest.setTeam(0);
          expect(startBlocker(await moved)).toBe("Both teams need a rider");

          const switched = new Promise<Roster>((resolve) =>
            guest.onRoster((r) => r.mode === "bump" && resolve(r)),
          );
          guest.setMode("coop");
          host.setMode("bump");
          expect((await switched).mode).toBe("bump");
          host.close();
          guest.close();
        }),
      ));
  });

  describe("when the browser client joins a missing room", () => {
    it("should reject with a readable reason", () =>
      withServer((url) =>
        Effect.promise(async () => {
          await expect(connect(url, "QQQQ", "Ann", look)).rejects.toThrow("No game with code QQQQ");
        }),
      ));
  });
});
