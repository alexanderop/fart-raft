import { Effect, Fiber, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vite-plus/test";
import { RoomFull, RoomNotFound, ServerMsg } from "../src/net/protocol.ts";
import { defaultLook } from "../src/look.ts";
import { MAX_CREW } from "../src/sim/constants.ts";
import { Lobby } from "./lobby.ts";
import { cleanName } from "./room.ts";
import {
  drain,
  FART,
  fartsIn,
  framesIn,
  latestRoster,
  lease,
  play,
  roomOf,
  run,
} from "./testing.ts";

const newRoom = roomOf("coop");

/**
 * A roster's seats: these players first, in their seat's default look, the rest open. Joiners
 * alternate Red, Blue, Red, ... (each takes the team with fewer players).
 */
const seated = (...names: string[]) => [
  ...names.map((name, i) => ({
    name,
    look: defaultLook(i),
    team: i % 2 === 0 ? (0 as const) : (1 as const),
  })),
  ...Array(MAX_CREW - names.length).fill(null),
];
/** A crew member who joined without picking a look. */
const rider = (name: string, seat: number | null, lookSeat = seat ?? 0) => ({
  name,
  seat,
  look: defaultLook(lookSeat),
  raft: 0,
});

describe("given the lobby", () => {
  describe("when a room is created", () => {
    it("should hand back a four-letter code that finds the room", () =>
      run(
        Effect.gen(function* () {
          const lobby = yield* Lobby;
          const code = yield* lobby.create("graveyard", "chill", "coop");
          expect(code).toMatch(/^[A-Z]{4}$/);
          const room = yield* lobby.find(code.toLowerCase());
          expect(room.code).toBe(code);
        }),
      ));
  });

  describe("when a wild room is created and its host starts the race", () => {
    it("should name the difficulty in the roster and race the sim at it", () =>
      run(
        Effect.gen(function* () {
          const lobby = yield* Lobby;
          const room = yield* lobby.find(yield* lobby.create("pond", "wild", "coop"));
          const { inbox, welcome } = yield* lease(room);
          expect(yield* latestRoster(inbox)).toMatchObject({ difficulty: "wild" });
          yield* room.start(welcome.token);
          yield* play(1);
          const frames = yield* framesIn(inbox);
          expect(frames.at(-1)!.snapshot.difficulty).toBe("wild");
        }),
      ));
  });

  describe("when a code nobody created is looked up", () => {
    it("should fail with RoomNotFound", () =>
      run(
        Effect.gen(function* () {
          const error = yield* Effect.flip((yield* Lobby).find("ZZZZ"));
          expect(error).toBeInstanceOf(RoomNotFound);
        }),
      ));
  });

  describe("when a room stays empty for two sweeps", () => {
    it("should be closed", () =>
      run(
        Effect.gen(function* () {
          const lobby = yield* Lobby;
          const code = yield* lobby.create("pond", "chill", "coop");
          yield* TestClock.adjust("30 seconds");
          expect((yield* lobby.find(code)).code).toBe(code);
          yield* TestClock.adjust("30 seconds");
          expect(yield* Effect.flip(lobby.find(code))).toBeInstanceOf(RoomNotFound);
        }),
      ));
  });
});

describe("given an empty room", () => {
  describe("when a client joins", () => {
    it("should seat it first, make it host, and leave the rest open", () =>
      run(
        Effect.gen(function* () {
          const room = yield* newRoom;
          const { welcome, inbox } = yield* lease(room, "  Captain   Toot ");
          expect(welcome).toMatchObject({ seat: 0 });
          const roster = yield* latestRoster(inbox);
          expect(roster).toMatchObject({
            seats: seated("Captain Toot"),
            host: 0,
            started: false,
            crew: [],
          });
        }),
      ));
  });

  describe("when a second client joins", () => {
    it("should take seat 1 and show both names", () =>
      run(
        Effect.gen(function* () {
          const room = yield* newRoom;
          const first = yield* lease(room, "Ann");
          const second = yield* lease(room, "Bo");
          expect(second.welcome.seat).toBe(1);
          expect((yield* latestRoster(first.inbox)).seats).toEqual(seated("Ann", "Bo"));
        }),
      ));
  });

  describe("when the host leaves", () => {
    it("should give seat 0 back and pass host to whoever is left", () =>
      run(
        Effect.gen(function* () {
          const room = yield* newRoom;
          const first = yield* lease(room, "Ann");
          const second = yield* lease(room, "Bo");
          yield* Fiber.interrupt(first.fiber);
          expect((yield* latestRoster(second.inbox)).host).toBe(1);
          const newcomer = yield* lease(room, "Cy");
          expect(newcomer.welcome.seat).toBe(0);
          expect((yield* latestRoster(newcomer.inbox)).host).toBe(1);
        }),
      ));
  });

  describe("when a ninth human tries to join a full room", () => {
    it("should be refused with RoomFull", () =>
      run(
        Effect.gen(function* () {
          const room = yield* newRoom;
          for (let i = 0; i < MAX_CREW; i++) yield* lease(room);
          const error = yield* Effect.flip(Stream.runDrain(room.join("Eve")));
          expect(error).toBeInstanceOf(RoomFull);
        }),
      ));
  });
});

describe("given two players in the lobby", () => {
  describe("when time passes before anyone starts", () => {
    it("should send no frames", () =>
      run(
        Effect.gen(function* () {
          const room = yield* newRoom;
          const { inbox } = yield* lease(room);
          yield* play(1);
          expect(yield* framesIn(inbox)).toHaveLength(0);
        }),
      ));
  });

  describe("when the guest presses start", () => {
    it("should be ignored", () =>
      run(
        Effect.gen(function* () {
          const room = yield* newRoom;
          const host = yield* lease(room, "Ann");
          const guest = yield* lease(room, "Bo");
          yield* room.start(guest.welcome.token);
          expect((yield* latestRoster(host.inbox)).started).toBe(false);
          yield* play(1);
          expect(yield* framesIn(host.inbox)).toHaveLength(0);
        }),
      ));
  });

  describe("when the host presses start", () => {
    it("should mark the room started and stream frames to everyone", () =>
      run(
        Effect.gen(function* () {
          const room = yield* newRoom;
          const host = yield* lease(room, "Ann");
          const guest = yield* lease(room, "Bo");
          yield* room.start(host.welcome.token);
          yield* play(1);
          const frames = yield* framesIn(guest.inbox);
          expect(frames.at(-1)!.snapshot.tick).toBe(60);
          expect((yield* latestRoster(host.inbox)).started).toBe(true);
        }),
      ));

    it("should race exactly the two of them, in seat order", () =>
      run(
        Effect.gen(function* () {
          const room = yield* newRoom;
          const host = yield* lease(room, "Ann");
          yield* lease(room, "Bo");
          yield* room.start(host.welcome.token);
          yield* play(1);
          const { frames, roster } = yield* drain(host.inbox);
          expect(frames.at(-1)!.snapshot.crews[0]!.riders).toHaveLength(2);
          expect(roster?.crew).toEqual([rider("Ann", 0), rider("Bo", 1)]);
        }),
      ));
  });

  describe("when a player picks a look", () => {
    const nurse = {
      animal: "croc",
      color: 9,
      hat: "nurse",
      outfit: "nurse",
      gadget: "stethoscope",
    } as const;

    it("should seat a joiner in the look they joined with", () =>
      run(
        Effect.gen(function* () {
          const room = yield* newRoom;
          const inbox = yield* Queue.unbounded<ServerMsg>();
          yield* room.join("Ann", nurse).pipe(
            Stream.runForEach((msg) => Queue.offer(inbox, msg)),
            Effect.forkScoped,
          );
          expect((yield* latestRoster(inbox)).seats[0]).toEqual({
            name: "Ann",
            look: nurse,
            team: 0,
          });
        }),
      ));

    it("should show a changed look on the seat and on the rider mid-race", () =>
      run(
        Effect.gen(function* () {
          const room = yield* newRoom;
          const host = yield* lease(room, "Ann");
          yield* room.start(host.welcome.token);
          yield* room.setLook(host.welcome.token, nurse);
          const roster = yield* latestRoster(host.inbox);
          expect(roster.seats[0]).toEqual({ name: "Ann", look: nurse, team: 0 });
          expect(roster.crew).toEqual([{ name: "Ann", seat: 0, look: nurse, raft: 0 }]);
        }),
      ));

    it("should ignore a look sent with a stranger's token", () =>
      run(
        Effect.gen(function* () {
          const room = yield* newRoom;
          const host = yield* lease(room, "Ann");
          yield* room.setLook("not-a-token", nurse);
          yield* room.setLook(host.welcome.token, nurse);
          expect((yield* latestRoster(host.inbox)).seats[0]?.look).toEqual(nurse);
          yield* room.setLook("not-a-token", { ...nurse, hat: "crown" });
          yield* TestClock.adjust("1 millis");
          expect((yield* Queue.clear(host.inbox)).filter(ServerMsg.guards.Roster)).toEqual([]);
        }),
      ));
  });
});

describe("given eight players in the lobby", () => {
  describe("when the host presses start", () => {
    it("should race a crew of eight, one rider per player in seat order", () =>
      run(
        Effect.gen(function* () {
          const room = yield* newRoom;
          const names = Array.from({ length: MAX_CREW }, (_, i) => `P${i + 1}`);
          const host = yield* lease(room, names[0]);
          for (const name of names.slice(1)) yield* lease(room, name);
          yield* room.start(host.welcome.token);
          yield* play(1);
          const { frames, roster } = yield* drain(host.inbox);
          expect(frames.at(-1)!.snapshot.crews[0]!.riders).toHaveLength(MAX_CREW);
          expect(roster?.crew).toEqual(names.map((name, seat) => rider(name, seat)));
        }),
      ));
  });
});

describe("given one player racing alone", () => {
  describe("when they sit idle through the countdown and beyond", () => {
    it("should race a crew of one and nobody farts for them", () =>
      run(
        Effect.gen(function* () {
          const room = yield* newRoom;
          const { inbox, welcome } = yield* lease(room);
          yield* room.start(welcome.token);
          yield* play(6);
          const frames = yield* framesIn(inbox);
          expect(frames.at(-1)!.snapshot.crews[0]!.riders).toHaveLength(1);
          expect(frames.at(-1)!.snapshot.crews[0]!.phase.kind).toBe("racing");
          expect(fartsIn(frames)).toHaveLength(0);
        }),
      ));
  });
});

describe("given a race in progress", () => {
  describe("when seat 0 farts after the countdown", () => {
    it("should broadcast a fart event for seat 0", () =>
      run(
        Effect.gen(function* () {
          const room = yield* newRoom;
          const { inbox, welcome } = yield* lease(room);
          yield* room.start(welcome.token);
          yield* room.sendInput(welcome.token, FART);
          yield* play(4);

          const frames = yield* framesIn(inbox);
          expect(frames.length).toBeGreaterThan(60);
          expect(frames.at(-1)!.snapshot.crews[0]!.phase.kind).toBe("racing");
          const farts = frames
            .flatMap((f) => f.events)
            .filter((e) => e.type === "fart" && e.seat === 0);
          expect(farts.length).toBeGreaterThan(0);
        }),
      ));
  });

  describe("when input arrives with a token that holds no seat", () => {
    it("should steer nobody", () =>
      run(
        Effect.gen(function* () {
          const room = yield* newRoom;
          const { inbox, welcome } = yield* lease(room);
          yield* room.start(welcome.token);
          yield* room.sendInput("forged", FART);
          yield* play(4);
          const farts = (yield* framesIn(inbox))
            .flatMap((f) => f.events)
            .filter((e) => e.type === "fart" && e.seat === 0);
          expect(farts).toHaveLength(0);
        }),
      ));
  });

  describe("when the race is restarted", () => {
    it("should start the tick count over", () =>
      run(
        Effect.gen(function* () {
          const room = yield* newRoom;
          const { inbox, welcome } = yield* lease(room);
          yield* room.start(welcome.token);
          yield* play(1);
          expect((yield* framesIn(inbox)).at(-1)!.snapshot.tick).toBe(60);

          yield* room.restart(welcome.token);
          yield* play(1);
          expect((yield* framesIn(inbox))[0]!.snapshot.tick).toBe(3);
        }),
      ));
  });

  describe("when the host sends the room back to the lobby", () => {
    it("should stop the frames, then race fresh with everyone seated from the next Start", () =>
      run(
        Effect.gen(function* () {
          const room = yield* newRoom;
          const host = yield* lease(room);
          const guest = yield* lease(room, "Bo");
          yield* room.start(host.welcome.token);
          yield* room.sendInput(guest.welcome.token, FART);
          yield* play(1);
          yield* drain(guest.inbox);

          yield* room.toLobby(host.welcome.token);
          const { roster } = yield* drain(guest.inbox);
          expect(roster?.started).toBe(false);
          expect(roster?.crew).toEqual([]);
          yield* play(1);
          expect(yield* framesIn(guest.inbox)).toEqual([]);

          yield* lease(room, "Cy");
          yield* room.start(host.welcome.token);
          yield* play(1);
          const next = yield* drain(guest.inbox);
          expect(next.frames[0]!.snapshot.tick).toBe(3);
          expect(next.roster?.crew.map((c) => c.name)).toEqual(["Ann", "Bo", "Cy"]);
          expect(fartsIn(next.frames)).toHaveLength(0);
        }),
      ));

    it("should ignore a guest, and a room that is already in its lobby", () =>
      run(
        Effect.gen(function* () {
          const room = yield* newRoom;
          const host = yield* lease(room);
          const guest = yield* lease(room, "Bo");
          yield* room.toLobby(host.welcome.token);
          yield* room.start(host.welcome.token);
          yield* play(1);
          yield* drain(guest.inbox);
          yield* room.toLobby(guest.welcome.token);
          yield* play(1);
          expect((yield* drain(guest.inbox)).frames.length).toBeGreaterThan(10);
        }),
      ));
  });

  describe("when someone joins mid-race", () => {
    it("should get frames right away but only watch", () =>
      run(
        Effect.gen(function* () {
          const room = yield* newRoom;
          const host = yield* lease(room);
          yield* room.start(host.welcome.token);
          yield* play(1);
          const late = yield* lease(room, "Late");
          yield* room.sendInput(late.welcome.token, FART);
          yield* play(4);
          const { frames, roster } = yield* drain(late.inbox);
          expect(frames.length).toBeGreaterThan(10);
          expect(frames.at(-1)!.snapshot.crews[0]!.riders).toHaveLength(1);
          expect(fartsIn(frames)).toHaveLength(0);
          expect(roster?.crew).toEqual([rider("Ann", 0)]);
        }),
      ));

    it("should put them on the raft when the race is restarted", () =>
      run(
        Effect.gen(function* () {
          const room = yield* newRoom;
          const host = yield* lease(room);
          yield* room.start(host.welcome.token);
          yield* play(1);
          const late = yield* lease(room, "Late");
          yield* room.restart(late.welcome.token);
          yield* room.sendInput(late.welcome.token, FART);
          yield* play(4);
          const { frames, roster } = yield* drain(late.inbox);
          expect(frames.at(-1)!.snapshot.crews[0]!.riders).toHaveLength(2);
          expect(roster?.crew).toEqual([rider("Ann", 0), rider("Late", 1)]);
          const farts = fartsIn(frames);
          expect(farts.length).toBeGreaterThan(0);
          expect(farts.every((e) => e.type === "fart" && e.seat === 1)).toBe(true);
        }),
      ));
  });

  describe("when a crew member leaves mid-race", () => {
    it("should keep their rider on the raft, idle, until a restart drops it", () =>
      run(
        Effect.gen(function* () {
          const room = yield* newRoom;
          const host = yield* lease(room, "Ann");
          const guest = yield* lease(room, "Bo");
          yield* room.start(host.welcome.token);
          yield* room.sendInput(guest.welcome.token, FART);
          yield* play(1);
          yield* Fiber.interrupt(guest.fiber);
          yield* play(4);

          const { frames, roster } = yield* drain(host.inbox);
          expect(frames.at(-1)!.snapshot.crews[0]!.riders).toHaveLength(2);
          expect(fartsIn(frames)).toHaveLength(0);
          expect(roster?.crew).toEqual([rider("Ann", 0), rider("Bo", null, 1)]);

          yield* room.restart(host.welcome.token);
          yield* play(1);
          expect((yield* framesIn(host.inbox)).at(-1)!.snapshot.crews[0]!.riders).toHaveLength(1);
        }),
      ));
  });
});

describe("given a raw player name", () => {
  describe("when it is cleaned", () => {
    it("should collapse whitespace, cap the length, and name blanks by seat", () => {
      expect(cleanName("  a   b  ", 0)).toBe("a b");
      expect(cleanName("x".repeat(40), 0)).toHaveLength(16);
      expect(cleanName("   ", 2)).toBe("Player 3");
    });
  });
});
