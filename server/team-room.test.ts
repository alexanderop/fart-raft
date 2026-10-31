import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vite-plus/test";
import { placeOf, type RoomMode, type Roster } from "../src/net/protocol.ts";
import { winnerOf } from "../src/sim/view.ts";
import {
  drain,
  FART,
  fartsIn,
  framesIn,
  latestRoster,
  lease,
  level,
  play,
  roomOf,
  run,
} from "./testing.ts";

/** The pond cut down to a 12 m dash with no hazard: one rider farting finishes it in seconds. */
const dash = { ...level, hazards: [], checkpoints: [{ x: 12, y: 0, rot: 0, hx: 0.5, hy: 8.5 }] };
const runDash = <A, E>(test: Parameters<typeof run<A, E>>[0]) =>
  run(test, { canyon: dash, graveyard: dash, pond: dash });

const teamsOf = (roster: Roster) => roster.seats.map((p) => p?.team ?? null);

for (const mode of ["ghost", "bump"] as const satisfies RoomMode[]) {
  describe(`given a ${mode} team room`, () => {
    describe("when players join", () => {
      it("should name the mode and put each newcomer on the team with fewer players, Red on a tie", () =>
        run(
          Effect.gen(function* () {
            const room = yield* roomOf(mode);
            const ann = yield* lease(room, "Ann");
            expect((yield* latestRoster(ann.inbox)).mode).toBe(mode);
            for (const name of ["Bo", "Cy", "Di"]) yield* lease(room, name);
            expect(teamsOf(yield* latestRoster(ann.inbox)).slice(0, 4)).toEqual([0, 1, 0, 1]);
          }),
        ));

      it("should refill the team a leaver left rather than stacking the other", () =>
        run(
          Effect.gen(function* () {
            const room = yield* roomOf(mode);
            const ann = yield* lease(room, "Ann");
            const bo = yield* lease(room, "Bo");
            yield* lease(room, "Cy");
            yield* room.leave(bo.welcome.token);
            yield* lease(room, "Di");
            expect(teamsOf(yield* latestRoster(ann.inbox)).slice(0, 4)).toEqual([0, 1, 0, null]);
          }),
        ));
    });

    describe("when a player picks the other team", () => {
      it("should move them for everyone, and ignore a pick of the team they are on", () =>
        run(
          Effect.gen(function* () {
            const room = yield* roomOf(mode);
            const ann = yield* lease(room, "Ann");
            const bo = yield* lease(room, "Bo");
            yield* room.setTeam(bo.welcome.token, 0);
            expect(teamsOf(yield* latestRoster(ann.inbox)).slice(0, 2)).toEqual([0, 0]);
            yield* room.setTeam(bo.welcome.token, 0);
            yield* TestClock.adjust("1 millis");
            expect(yield* framesIn(ann.inbox)).toEqual([]);
          }),
        ));

      it("should refuse a team that already has four players", () =>
        run(
          Effect.gen(function* () {
            const room = yield* roomOf(mode);
            const ann = yield* lease(room, "Ann");
            const blues: string[] = [];
            for (const name of ["Bo", "Cy", "Di", "Ed"]) {
              blues.push((yield* lease(room, name)).welcome.token);
            }
            // Ann, Cy, Ed are Red; Bo, Di are Blue. Bo joins Red to make four.
            yield* room.setTeam(blues[0]!, 0);
            expect(teamsOf(yield* latestRoster(ann.inbox)).slice(0, 5)).toEqual([0, 0, 0, 1, 0]);
            yield* room.setTeam(blues[2]!, 0);
            yield* TestClock.adjust("1 millis");
            expect((yield* drain(ann.inbox)).roster).toBeUndefined();
          }),
        ));
    });

    describe("when the host starts with a team that has nobody on it", () => {
      it("should ignore Start until both teams have a rider", () =>
        run(
          Effect.gen(function* () {
            const room = yield* roomOf(mode);
            const ann = yield* lease(room, "Ann");
            const bo = yield* lease(room, "Bo");
            yield* room.setTeam(bo.welcome.token, 0);
            yield* room.start(ann.welcome.token);
            yield* play(1);
            const idle = yield* drain(ann.inbox);
            expect(idle.frames).toEqual([]);
            expect(idle.roster?.started).toBe(false);

            yield* room.setTeam(bo.welcome.token, 1);
            yield* room.start(ann.welcome.token);
            yield* play(1);
            expect((yield* drain(ann.inbox)).frames.length).toBeGreaterThan(10);
          }),
        ));
    });

    describe("when the host starts a race with two riders on each team", () => {
      it("should race two crews with the room's contact, Red's riders first", () =>
        run(
          Effect.gen(function* () {
            const room = yield* roomOf(mode);
            const leases = [];
            for (const name of ["Ann", "Bo", "Cy", "Di"]) leases.push(yield* lease(room, name));
            // Seats 0 and 2 are Red, 1 and 3 Blue; Bo and Cy swap, so Red is Ann + Bo, Blue Cy + Di.
            yield* room.setTeam(leases[1]!.welcome.token, 0);
            yield* room.setTeam(leases[2]!.welcome.token, 1);
            yield* room.start(leases[0]!.welcome.token);
            yield* play(1);
            const { frames, roster } = yield* drain(leases[3]!.inbox);
            const snapshot = frames.at(-1)!.snapshot;
            expect(snapshot.contact).toBe(mode);
            expect(snapshot.crews.map((c) => c.riders.length)).toEqual([2, 2]);
            expect(roster?.crew.map((c) => [c.name, c.raft])).toEqual([
              ["Ann", 0],
              ["Bo", 0],
              ["Cy", 1],
              ["Di", 1],
            ]);
            expect(placeOf(roster!, 3)).toEqual({ raft: 1, rider: 1 });
            expect(placeOf(roster!, 1)).toEqual({ raft: 0, rider: 1 });
          }),
        ));

      it("should drive each rider from its own seat only", () =>
        run(
          Effect.gen(function* () {
            const room = yield* roomOf(mode);
            const ann = yield* lease(room, "Ann");
            const bo = yield* lease(room, "Bo");
            yield* room.start(ann.welcome.token);
            yield* room.sendInput(bo.welcome.token, FART);
            yield* play(4);
            const farts = fartsIn((yield* drain(ann.inbox)).frames);
            expect(farts.length).toBeGreaterThan(0);
            expect(farts.every((e) => e.raft === 1 && e.seat === 0)).toBe(true);
          }),
        ));
    });

    describe("when one raft crosses the finish first", () => {
      it("should have that raft finished with the other still racing, and crown it", () =>
        runDash(
          Effect.gen(function* () {
            const room = yield* roomOf(mode);
            const ann = yield* lease(room, "Ann");
            yield* lease(room, "Bo");
            yield* room.start(ann.welcome.token);
            yield* room.sendInput(ann.welcome.token, FART);
            yield* play(12);
            const { snapshot } = (yield* framesIn(ann.inbox)).at(-1)!;
            expect(snapshot.crews.map((c) => c.phase.kind)).toEqual(["finished", "racing"]);
            expect(winnerOf(snapshot.crews)).toBe(0);
          }),
        ));
    });

    describe("when a race is restarted", () => {
      it("should keep the mode and the teams as they are now, and start the clock over", () =>
        run(
          Effect.gen(function* () {
            const room = yield* roomOf(mode);
            const ann = yield* lease(room, "Ann");
            const bo = yield* lease(room, "Bo");
            const cy = yield* lease(room, "Cy");
            yield* room.start(ann.welcome.token);
            yield* play(1);
            expect((yield* framesIn(ann.inbox)).at(-1)!.snapshot.tick).toBe(60);

            // Cy moves to Blue mid-race: the race under way keeps its crews until the restart.
            yield* room.setTeam(cy.welcome.token, 1);
            const during = yield* latestRoster(ann.inbox);
            expect(during.crew.map((c) => c.raft)).toEqual([0, 0, 1]);

            yield* room.restart(bo.welcome.token);
            yield* play(1);
            const { frames, roster } = yield* drain(ann.inbox);
            expect(frames[0]!.snapshot.tick).toBe(3);
            expect(frames.at(-1)!.snapshot.contact).toBe(mode);
            expect(frames.at(-1)!.snapshot.crews.map((c) => c.riders.length)).toEqual([1, 2]);
            expect(roster?.mode).toBe(mode);
            expect(roster?.crew.map((c) => [c.name, c.raft])).toEqual([
              ["Ann", 0],
              ["Bo", 1],
              ["Cy", 1],
            ]);
          }),
        ));

      it("should be ignored while a team has nobody on it", () =>
        run(
          Effect.gen(function* () {
            const room = yield* roomOf(mode);
            const ann = yield* lease(room, "Ann");
            const bo = yield* lease(room, "Bo");
            yield* room.start(ann.welcome.token);
            yield* play(1);
            yield* room.setTeam(bo.welcome.token, 0);
            yield* room.restart(ann.welcome.token);
            yield* play(1);
            expect((yield* framesIn(ann.inbox)).at(-1)!.snapshot.tick).toBe(120);
          }),
        ));
    });

    describe("when someone joins mid-race", () => {
      it("should take the smaller team, watch this race and ride from the restart", () =>
        run(
          Effect.gen(function* () {
            const room = yield* roomOf(mode);
            const ann = yield* lease(room, "Ann");
            yield* lease(room, "Bo");
            yield* lease(room, "Cy");
            yield* room.start(ann.welcome.token);
            yield* play(1);
            const late = yield* lease(room, "Late");
            yield* room.sendInput(late.welcome.token, FART);
            yield* play(2);
            const watching = yield* drain(late.inbox);
            expect(watching.roster?.seats[3]).toMatchObject({ name: "Late", team: 1 });
            expect(placeOf(watching.roster!, 3)).toBeNull();
            expect(fartsIn(watching.frames)).toEqual([]);
            expect(watching.frames.at(-1)!.snapshot.crews.map((c) => c.riders.length)).toEqual([
              2, 1,
            ]);

            yield* room.restart(late.welcome.token);
            yield* play(5);
            const riding = yield* drain(late.inbox);
            expect(placeOf(riding.roster!, 3)).toEqual({ raft: 1, rider: 1 });
            expect(riding.frames.at(-1)!.snapshot.crews.map((c) => c.riders.length)).toEqual([
              2, 2,
            ]);
            expect(fartsIn(riding.frames).every((e) => e.raft === 1 && e.seat === 1)).toBe(true);
            expect(fartsIn(riding.frames).length).toBeGreaterThan(0);
          }),
        ));
    });

    describe("when a rider leaves mid-race", () => {
      it("should keep their rider on the raft, idle, and the race going when a team empties", () =>
        run(
          Effect.gen(function* () {
            const room = yield* roomOf(mode);
            const ann = yield* lease(room, "Ann");
            const bo = yield* lease(room, "Bo");
            yield* room.start(ann.welcome.token);
            yield* room.sendInput(bo.welcome.token, FART);
            yield* play(1);
            yield* room.leave(bo.welcome.token);
            yield* play(2);
            const { frames, roster } = yield* drain(ann.inbox);
            const last = frames.at(-1)!.snapshot;
            expect(last.tick).toBe(180);
            expect(last.crews.map((c) => c.riders.length)).toEqual([1, 1]);
            expect(fartsIn(frames.slice(-20))).toEqual([]);
            expect(roster?.crew.map((c) => [c.name, c.seat, c.raft])).toEqual([
              ["Ann", 0, 0],
              ["Bo", null, 1],
            ]);
          }),
        ));
    });
  });
}

describe("given a room whose host changes the mode", () => {
  describe("when a guest tries to", () => {
    it("should keep the mode", () =>
      run(
        Effect.gen(function* () {
          const room = yield* roomOf("ghost");
          const ann = yield* lease(room, "Ann");
          const bo = yield* lease(room, "Bo");
          yield* room.setMode(bo.welcome.token, "bump");
          expect((yield* latestRoster(ann.inbox)).mode).toBe("ghost");
        }),
      ));
  });

  describe("when the host switches ghost to bump before the start", () => {
    it("should tell everyone and race the next race with colliding rafts, teams kept", () =>
      run(
        Effect.gen(function* () {
          const room = yield* roomOf("ghost");
          const ann = yield* lease(room, "Ann");
          const bo = yield* lease(room, "Bo");
          yield* room.setMode(ann.welcome.token, "bump");
          const roster = yield* latestRoster(bo.inbox);
          expect(roster.mode).toBe("bump");
          expect(teamsOf(roster).slice(0, 2)).toEqual([0, 1]);
          yield* room.start(ann.welcome.token);
          yield* play(1);
          expect((yield* framesIn(bo.inbox)).at(-1)!.snapshot.contact).toBe("bump");
        }),
      ));
  });

  describe("when the host sends the room back to the lobby", () => {
    it("should end the race, keep everyone and their teams, and race fresh from the next Start", () =>
      run(
        Effect.gen(function* () {
          const room = yield* roomOf("ghost");
          const ann = yield* lease(room, "Ann");
          const bo = yield* lease(room, "Bo");
          const cy = yield* lease(room, "Cy");
          yield* room.start(ann.welcome.token);
          yield* play(1);
          yield* drain(ann.inbox);

          yield* room.toLobby(ann.welcome.token);
          const lobby = yield* latestRoster(ann.inbox);
          expect(lobby.started).toBe(false);
          expect(lobby.crew).toEqual([]);
          expect(teamsOf(lobby).slice(0, 3)).toEqual([0, 1, 0]);
          yield* play(1);
          expect(yield* framesIn(ann.inbox)).toEqual([]);

          yield* room.setTeam(cy.welcome.token, 1);
          yield* room.setMode(ann.welcome.token, "bump");
          yield* room.start(ann.welcome.token);
          yield* play(1);
          const { frames, roster } = yield* drain(bo.inbox);
          expect(frames[0]!.snapshot.tick).toBe(3);
          expect(frames.at(-1)!.snapshot.contact).toBe("bump");
          expect(frames.at(-1)!.snapshot.crews.map((c) => c.riders.length)).toEqual([1, 2]);
          expect(roster?.crew.map((c) => [c.name, c.raft])).toEqual([
            ["Ann", 0],
            ["Bo", 1],
            ["Cy", 1],
          ]);
        }),
      ));

    it("should be ignored from anyone but the host", () =>
      run(
        Effect.gen(function* () {
          const room = yield* roomOf("ghost");
          const ann = yield* lease(room, "Ann");
          const bo = yield* lease(room, "Bo");
          yield* room.start(ann.welcome.token);
          yield* play(1);
          yield* drain(ann.inbox);
          yield* room.toLobby(bo.welcome.token);
          yield* play(1);
          const { frames, roster } = yield* drain(ann.inbox);
          expect(frames.length).toBeGreaterThan(10);
          expect(roster).toBeUndefined();
        }),
      ));
  });

  describe("when the host switches mid-race", () => {
    it("should leave the race alone and apply the mode from the restart", () =>
      run(
        Effect.gen(function* () {
          const room = yield* roomOf("ghost");
          const ann = yield* lease(room, "Ann");
          yield* lease(room, "Bo");
          yield* room.start(ann.welcome.token);
          yield* room.setMode(ann.welcome.token, "bump");
          yield* play(1);
          const during = yield* drain(ann.inbox);
          expect(during.roster?.mode).toBe("bump");
          expect(during.frames.at(-1)!.snapshot.contact).toBe("ghost");

          yield* room.restart(ann.welcome.token);
          yield* play(1);
          expect((yield* framesIn(ann.inbox)).at(-1)!.snapshot.contact).toBe("bump");
        }),
      ));
  });

  describe("when the host switches a team room to co-op", () => {
    it("should put everyone on one raft whatever their team", () =>
      run(
        Effect.gen(function* () {
          const room = yield* roomOf("bump");
          const ann = yield* lease(room, "Ann");
          yield* lease(room, "Bo");
          yield* room.setMode(ann.welcome.token, "coop");
          yield* room.start(ann.welcome.token);
          yield* play(1);
          const { frames, roster } = yield* drain(ann.inbox);
          expect(frames.at(-1)!.snapshot.crews.map((c) => c.riders.length)).toEqual([2]);
          expect(roster?.crew.map((c) => c.raft)).toEqual([0, 0]);
        }),
      ));
  });

  describe("when the host switches a co-op room to a team mode", () => {
    it("should find the room already split into teams", () =>
      run(
        Effect.gen(function* () {
          const room = yield* roomOf("coop");
          const ann = yield* lease(room, "Ann");
          yield* lease(room, "Bo");
          yield* room.setMode(ann.welcome.token, "ghost");
          yield* room.start(ann.welcome.token);
          yield* play(1);
          expect((yield* framesIn(ann.inbox)).at(-1)!.snapshot.crews).toHaveLength(2);
        }),
      ));
  });
});
