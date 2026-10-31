import { Schema } from "effect";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import pond from "../../courses/pond.json";
import { crewZones, MAX_CREW } from "../sim/constants.ts";
import { parseLevel } from "../sim/level.ts";
import { createSim, initPhysics, snapshot, step } from "../sim/sim.ts";
import type { SeatInput, SimEvent, Snapshot } from "../sim/types.ts";
import {
  followedRaft,
  placeOf,
  ServerMsg,
  SimEvent as SimEventSchema,
  Snapshot as SnapshotSchema,
  startBlocker,
  type Roster,
} from "./protocol.ts";
import { defaultLook } from "../look.ts";

const overTheWire = <S extends Schema.Codec<unknown, unknown>>(schema: S, value: S["Type"]) =>
  Schema.decodeUnknownSync(schema)(JSON.parse(JSON.stringify(Schema.encodeSync(schema)(value))));

describe("given a sim that has raced for four seconds", () => {
  const events: SimEvent[] = [];
  let snap: Snapshot;
  beforeAll(async () => {
    await initPhysics();
    const sim = createSim(parseLevel(pond), [crewZones(MAX_CREW)]);
    const farting: SeatInput = { move: { x: 0.25, y: -0.5 }, fart: true };
    for (let t = 0; t < 240; t++) {
      events.push(...step(sim, [farting, farting, farting, farting]));
    }
    snap = snapshot(sim);
    sim.world.free();
  });

  describe("when its snapshot goes through JSON", () => {
    it("should decode to an equal snapshot", () => {
      expect(snap.tick).toBe(240);
      expect(snap.crews[0]!.phase.kind).toBe("racing");
      expect(overTheWire(SnapshotSchema, snap)).toEqual(snap);
    });
  });

  describe("when its events go through JSON", () => {
    it("should keep the fart events intact", () => {
      expect(events.filter((e) => e.type === "fart").length).toBeGreaterThan(0);
      expect(events.map((e) => overTheWire(SimEventSchema, e))).toEqual(events);
    });
  });

  describe("when a frame goes through JSON", () => {
    it("should decode to the same frame", () => {
      const frame = {
        _tag: "Frame" as const,
        snapshot: snap,
        events,
      };
      expect(overTheWire(ServerMsg, frame)).toEqual(frame);
    });
  });
});

describe("given a snapshot with a bad field", () => {
  describe("when it is decoded", () => {
    it("should fail instead of passing it through", () => {
      expect(() => Schema.decodeUnknownSync(SnapshotSchema)({ tick: "1" })).toThrow();
    });
  });
});

const look = defaultLook(0);
const member = (seat: number | null, raft: number) => ({ name: "x", seat, look, raft });
const roomWith = (mode: Roster["mode"], teams: (0 | 1)[], crew: Roster["crew"] = []): Roster => ({
  code: "ABCD",
  course: "pond",
  difficulty: "chill",
  mode,
  seats: teams.map((team, i) => ({ name: `P${i}`, look, team })),
  host: 0,
  started: crew.length > 0,
  crew,
});

describe("given a roster", () => {
  describe("when the mode is a team mode and a team has nobody on it", () => {
    it("should name why the race cannot start", () => {
      expect(startBlocker(roomWith("ghost", [0, 0]))).toBe("Both teams need a rider");
      expect(startBlocker(roomWith("bump", [1]))).toBe("Both teams need a rider");
      expect(startBlocker(roomWith("bump", []))).toBe("Both teams need a rider");
    });
  });

  describe("when both teams have a rider, or the room is co-op", () => {
    it("should not block the start", () => {
      expect(startBlocker(roomWith("ghost", [0, 1]))).toBeNull();
      expect(startBlocker(roomWith("coop", [0, 0, 0]))).toBeNull();
    });
  });

  describe("when a race has Red riders then Blue riders", () => {
    const crew = [member(4, 0), member(1, 0), member(0, 1), member(null, 1), member(2, 1)];
    const roster = roomWith("ghost", [1, 0, 1, 0, 0], crew);

    it("should place a seat by its raft and its rider index within that raft", () => {
      expect(placeOf(roster, 4)).toEqual({ raft: 0, rider: 0 });
      expect(placeOf(roster, 1)).toEqual({ raft: 0, rider: 1 });
      expect(placeOf(roster, 0)).toEqual({ raft: 1, rider: 0 });
      expect(placeOf(roster, 2)).toEqual({ raft: 1, rider: 2 });
    });

    it("should place a spectator nowhere", () => {
      expect(placeOf(roster, 3)).toBeNull();
      expect(placeOf(roomWith("ghost", [0, 1]), 0)).toBeNull();
    });
  });

  describe("when the camera picks a raft in a frame of the race", () => {
    const crew = [member(4, 0), member(1, 0), member(0, 1), member(null, 1), member(2, 1)];
    const roster = roomWith("ghost", [1, 0, 1, 0, 0], crew);

    it("should follow the raft a rider rides, and a spectator's team raft", () => {
      expect(followedRaft(roster, 4, 2)).toBe(0);
      expect(followedRaft(roster, 0, 2)).toBe(1);
      expect(followedRaft(roster, 3, 2)).toBe(0);
    });

    it("should stay inside a stale frame that has fewer rafts than the roster", () => {
      expect(followedRaft(roster, 0, 1)).toBe(0);
      expect(followedRaft(roster, 2, 1)).toBe(0);
      expect(followedRaft(roomWith("ghost", [1, 1]), 1, 1)).toBe(0);
    });
  });
});
